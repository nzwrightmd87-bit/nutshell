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
        expect(response.body).to match(/<script nonce="[^"]+">/)
        expect(script_src_csp).to include("'nonce-#{script_nonce}'")
        expect(style_src_csp).to_not include("'nonce-#{script_nonce}'")
        expect(response.body).to_not include('name="style-nonce"')
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

  describe 'GET /blackenvelope' do
    it 'redirects legacy path to /black_envelope' do
      get '/blackenvelope'

      expect(response).to redirect_to('/black_envelope')
    end
  end

  def script_nonce
    response.body.match(/<script nonce="([^"]+)">/)[1]
  end

  def script_src_csp
    response.headers['Content-Security-Policy'].split(';').map(&:strip).find { |directive| directive.start_with?('script-src') }.to_s
  end

  def style_src_csp
    response.headers['Content-Security-Policy'].split(';').map(&:strip).find { |directive| directive.start_with?('style-src') }.to_s
  end
end
