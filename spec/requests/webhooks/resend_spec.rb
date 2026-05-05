# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'Resend webhooks' do
  describe 'POST /webhooks/resend' do
    let(:service) { instance_double(ResendWebhookService) }

    before do
      allow(ResendWebhookService).to receive(:new).and_return(service)
    end

    it 'returns accepted when webhook verification succeeds' do
      allow(service).to receive(:verify_signature_and_replay!).and_return(:verified)

      post '/webhooks/resend', params: '{}', headers: { 'CONTENT_TYPE' => 'application/json' }

      expect(response).to have_http_status(202)
    end

    it 'returns accepted when verification is skipped due to missing secret' do
      allow(service).to receive(:verify_signature_and_replay!).and_return(:skipped)

      post '/webhooks/resend', params: '{}', headers: { 'CONTENT_TYPE' => 'application/json' }

      expect(response).to have_http_status(202)
    end

    it 'returns ok for replayed svix-id payloads' do
      allow(service).to receive(:verify_signature_and_replay!).and_raise(
        ResendWebhookService::ReplayError, 'duplicate webhook id'
      )

      post '/webhooks/resend', params: '{}', headers: { 'CONTENT_TYPE' => 'application/json' }

      expect(response).to have_http_status(200)
    end

    it 'returns unauthorized for invalid signatures' do
      allow(service).to receive(:verify_signature_and_replay!).and_raise(
        ResendWebhookService::VerificationError, 'signature mismatch'
      )

      post '/webhooks/resend', params: '{}', headers: { 'CONTENT_TYPE' => 'application/json' }

      expect(response).to have_http_status(401)
    end
  end
end
