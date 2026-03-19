# frozen_string_literal: true

require 'base64'
require 'json'
require 'openssl'
require 'securerandom'

module BlackEnvelope
  class IntegrationTokenService < BaseService
    PROVIDER = 'nutshell'

    def call(user, now: Time.now.utc)
      raise ArgumentError, 'BlackEnvelope SSO is not configured' unless Configuration.sso_enabled?

      body = payload(user, now).to_json
      signature = OpenSSL::HMAC.digest('SHA256', Configuration.integration_secret, body)

      "#{encode(body)}.#{encode(signature)}"
    end

    private

    def payload(user, now)
      {
        v: 1,
        provider: PROVIDER,
        sub: user.id.to_s,
        username: user.account.username.to_s,
        email: user.email.to_s,
        display_name: user.account.display_name.to_s,
        admin: user.role&.can?(:view_devops) || false,
        iat: now.to_i,
        exp: now.to_i + Configuration.sso_ttl_seconds,
        nonce: SecureRandom.hex(8),
      }
    end

    def encode(value)
      Base64.urlsafe_encode64(value).delete('=')
    end
  end
end
