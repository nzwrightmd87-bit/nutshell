# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'BlackEnvelope launches' do
  let(:user) { Fabricate(:user) }

  before do
    sign_in user
  end

  describe 'GET /black_envelope' do
    context 'when SSO is enabled' do
      around do |example|
        ClimateControl.modify(
          BLACK_ENVELOPE_URL: 'https://app.nutshell.sbs',
          BLACK_ENVELOPE_SSO_SECRET: 'test-shared-secret',
          BLACK_ENVELOPE_SSO_TTL_SECONDS: '60'
        ) do
          example.run
        end
      end

      it 'renders a POST handoff form without token query params' do
        get '/black_envelope'

        expect(response).to have_http_status(200)
        expect(response.content_type).to start_with('text/html')
        expect(response.body).to include('action="https://app.nutshell.sbs/integrations/nutshell/sso"')
        expect(response.body).to include('name="token"')
        expect(response.body).not_to include('?token=')
      end
    end

    context 'when SSO is disabled' do
      around do |example|
        ClimateControl.modify(
          BLACK_ENVELOPE_URL: 'https://app.nutshell.sbs',
          BLACK_ENVELOPE_SSO_SECRET: nil
        ) do
          example.run
        end
      end

      it 'redirects to the BlackEnvelope app URL' do
        get '/black_envelope'

        expect(response).to redirect_to('https://app.nutshell.sbs')
      end
    end
  end
end
