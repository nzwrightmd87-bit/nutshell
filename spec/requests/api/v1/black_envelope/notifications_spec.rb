# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'BlackEnvelope notifications' do
  include_context 'with API authentication', oauth_scopes: 'read:notifications'

  describe 'GET /api/v1/black_envelope/notifications/unread_count' do
    subject do
      get '/api/v1/black_envelope/notifications/unread_count', headers: headers
    end

    let(:unread_count_service) { instance_double(BlackEnvelope::UnreadCountService, call: 7) }

    before do
      allow(BlackEnvelope::UnreadCountService).to receive(:new).and_return(unread_count_service)
    end

    it_behaves_like 'forbidden for wrong scope', 'write write:notifications'

    it 'returns the BlackEnvelope unread count for a read notification token' do
      subject

      expect(response).to have_http_status(200)
      expect(response.content_type)
        .to start_with('application/json')
      expect(response.parsed_body[:unread_count]).to eq 7
      expect(unread_count_service).to have_received(:call).with(user)
    end
  end
end
