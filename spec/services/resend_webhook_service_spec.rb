# frozen_string_literal: true

require 'base64'
require 'openssl'
require 'rails_helper'
require 'rack/mock'

RSpec.describe ResendWebhookService do
  let(:secret_key_material) { 'resend-test-signing-key' }
  let(:secret) { "whsec_#{Base64.urlsafe_encode64(secret_key_material, padding: false)}" }
  let(:message_id) { 'msg_test_123' }
  let(:timestamp) { Time.now.to_i.to_s }
  let(:body) { '{"type":"email.delivered","data":{"email_id":"123"}}' }
  let(:signature) do
    Base64.strict_encode64(
      OpenSSL::HMAC.digest('sha256', secret_key_material, "#{message_id}.#{timestamp}.#{body}")
    )
  end
  let(:headers) do
    {
      'svix-id' => message_id,
      'svix-timestamp' => timestamp,
      'svix-signature' => "v1,#{signature}",
    }
  end
  let(:request) { build_request(body:, headers:) }

  subject(:service) { described_class.new(request) }

  let(:redis) { instance_double(Redis) }

  around do |example|
    ClimateControl.modify RESEND_WEBHOOK_SECRET: secret do
      example.run
    end
  end

  before do
    allow(RedisConnection).to receive(:with).and_yield(redis)
    allow(redis).to receive(:set).and_return('OK')
  end

  describe '#verify_signature_and_replay!' do
    it 'verifies a valid signed webhook and reserves its svix-id' do
      expect(service.verify_signature_and_replay!).to eq(:verified)
      expect(redis).to have_received(:set).with(
        "resend:webhook:seen:#{message_id}",
        kind_of(Integer),
        ex: 24.hours.to_i,
        nx: true
      )
    end

    it 'raises a verification error when signature is invalid' do
      bad_request = build_request(body:, headers: headers.merge('svix-signature' => 'v1,not-valid'))

      expect do
        described_class.new(bad_request).verify_signature_and_replay!
      end.to raise_error(ResendWebhookService::VerificationError, /Signature mismatch/)
    end

    it 'raises a verification error when timestamp is outside tolerance' do
      old_timestamp = (Time.now - 10.minutes).to_i.to_s
      old_signature = Base64.strict_encode64(
        OpenSSL::HMAC.digest('sha256', secret_key_material, "#{message_id}.#{old_timestamp}.#{body}")
      )
      old_request = build_request(
        body:,
        headers: headers.merge(
          'svix-timestamp' => old_timestamp,
          'svix-signature' => "v1,#{old_signature}"
        )
      )

      expect do
        described_class.new(old_request).verify_signature_and_replay!
      end.to raise_error(ResendWebhookService::VerificationError, /outside allowed tolerance/)
    end

    it 'raises a replay error when svix-id is already reserved' do
      allow(redis).to receive(:set).and_return(nil)

      expect do
        service.verify_signature_and_replay!
      end.to raise_error(ResendWebhookService::ReplayError, /Duplicate svix-id/)
    end

    it 'skips verification when webhook secret is not configured' do
      ClimateControl.modify RESEND_WEBHOOK_SECRET: nil do
        expect(service.verify_signature_and_replay!).to eq(:skipped)
      end
      expect(redis).not_to have_received(:set)
    end
  end

  def build_request(body:, headers:)
    env = Rack::MockRequest.env_for(
      '/webhooks/resend',
      method: 'POST',
      input: body,
      'CONTENT_TYPE' => 'application/json'
    )

    headers.each do |header, value|
      env["HTTP_#{header.upcase.tr('-', '_')}"] = value
    end

    ActionDispatch::Request.new(env)
  end
end
