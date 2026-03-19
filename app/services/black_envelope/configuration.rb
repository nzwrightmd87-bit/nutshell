# frozen_string_literal: true

require 'uri'

module BlackEnvelope
  class Configuration
    LOCAL_DEV_SSO_SECRET = 'nutshell-black-envelope-dev-sso'.freeze

    class << self
      def app_url
        ENV['BLACK_ENVELOPE_URL'].presence || default_app_url
      end

      def internal_url
        ENV['BLACK_ENVELOPE_INTERNAL_URL'].presence || default_internal_url
      end

      def handoff_url
        join_path(app_url, 'integrations/nutshell/sso')
      end

      def provisioning_url
        join_path(internal_url, 'api/integrations/nutshell/provision')
      end

      def integration_secret
        ENV['BLACK_ENVELOPE_SSO_SECRET'].presence || default_integration_secret
      end

      def sso_enabled?
        app_url.present? && integration_secret.present?
      end

      def sso_ttl_seconds
        value = Integer(ENV.fetch('BLACK_ENVELOPE_SSO_TTL_SECONDS', 60))
        value.clamp(30, 300)
      rescue ArgumentError, TypeError
        60
      end

      private

      def default_app_url
        host = (Rails.configuration.x.web_domain.presence || Rails.configuration.x.local_domain).to_s.split(':').first
        normalized_host = host.sub(/\Awww\./, '')

        return 'http://127.0.0.1:8787' if normalized_host.blank? || normalized_host == 'localhost' || normalized_host == '127.0.0.1' || normalized_host.end_with?('.localhost')
        return "https://#{normalized_host}" if normalized_host.start_with?('app.')

        "https://app.#{normalized_host}"
      end

      def default_integration_secret
        LOCAL_DEV_SSO_SECRET if local_development_host?(app_url)
      end

      def default_internal_url
        return 'http://host.docker.internal:8787' if local_development_host?(app_url)

        app_url
      end

      def local_development_host?(value)
        host = URI.parse(value).host.to_s
        host.blank? || host == 'localhost' || host == '127.0.0.1' || host.end_with?('.localhost')
      rescue URI::InvalidURIError
        false
      end

      def join_path(base_url, path)
        return if base_url.blank?

        base = base_url.end_with?('/') ? base_url : "#{base_url}/"
        URI.join(base, path).to_s
      rescue URI::InvalidURIError
        nil
      end
    end
  end
end
