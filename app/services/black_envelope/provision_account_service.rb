# frozen_string_literal: true

require 'json'
require 'net/http'
require 'uri'

module BlackEnvelope
  class ProvisionAccountService < BaseService
    OPEN_TIMEOUT_SECONDS = 2
    READ_TIMEOUT_SECONDS = 2

    def call(user)
      return false if user.nil? || user.account.nil?
      return false unless Configuration.sso_enabled?

      uri = URI.parse(Configuration.provisioning_url)
      request = Net::HTTP::Post.new(uri)
      request['Content-Type'] = 'application/json'
      request.body = { token: IntegrationTokenService.new.call(user) }.to_json

      response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: OPEN_TIMEOUT_SECONDS, read_timeout: READ_TIMEOUT_SECONDS) do |http|
        http.request(request)
      end

      return true if response.is_a?(Net::HTTPSuccess)

      Rails.logger.warn("BlackEnvelope provisioning failed for user #{user.id}: HTTP #{response.code} #{response.body.to_s.tr("\n", ' ')[0, 300]}")
      false
    rescue StandardError => e
      Rails.logger.warn("BlackEnvelope provisioning failed for user #{user&.id || 'unknown'}: #{e.class} #{e.message}")
      false
    end
  end
end
