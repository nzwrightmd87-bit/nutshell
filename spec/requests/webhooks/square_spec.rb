# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'Square webhooks' do
  describe 'POST /webhooks/square' do
    let(:service) { instance_double(SquareWebhookService) }

    before do
      allow(SquareWebhookService).to receive(:new).and_return(service)
      allow(service).to receive(:verify_signature!).and_return(true)
      allow(service).to receive(:process!).and_return(nil)
    end

    it 'returns ok when webhook processing succeeds' do
      post '/webhooks/square', params: '{}', headers: { 'CONTENT_TYPE' => 'application/json' }

      expect(response).to have_http_status(200)
    end

    it 'returns unauthorized for invalid signatures' do
      allow(service).to receive(:verify_signature!).and_raise(
        SquareWebhookService::InvalidSignature, 'signature mismatch'
      )

      post '/webhooks/square', params: '{}', headers: { 'CONTENT_TYPE' => 'application/json' }

      expect(response).to have_http_status(401)
    end

    it 'returns bad request for invalid or replayed events' do
      allow(service).to receive(:process!).and_raise(
        SquareWebhookService::InvalidEvent, 'Missing event ID'
      )

      post '/webhooks/square', params: '{}', headers: { 'CONTENT_TYPE' => 'application/json' }

      expect(response).to have_http_status(400)
    end
  end
end
