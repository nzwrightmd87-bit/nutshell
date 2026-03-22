# frozen_string_literal: true

require 'json'
require 'net/http'
require 'uri'

module BlackEnvelope
  class UnreadCountService < BaseService
    OPEN_TIMEOUT_SECONDS = 2
    READ_TIMEOUT_SECONDS = 2

    def call(user)
      return 0 if user.nil? || user.account.nil?
      return 0 unless Configuration.sso_enabled?

      uri = URI.parse(Configuration.unread_count_url)
      request = Net::HTTP::Post.new(uri)
      request['Content-Type'] = 'application/json'
      request.body = { token: IntegrationTokenService.new.call(user) }.to_json

      response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: OPEN_TIMEOUT_SECONDS, read_timeout: READ_TIMEOUT_SECONDS) do |http|
        http.request(request)
      end

      if response.is_a?(Net::HTTPSuccess)
        data = JSON.parse(response.body)
        Integer(data['unread_count'] || 0)
      else
        Rails.logger.warn("BlackEnvelope unread count failed for user #{user.id}: HTTP #{response.code}")
        0
      end
    rescue StandardError => e
      Rails.logger.warn("BlackEnvelope unread count failed for user #{user&.id || 'unknown'}: #{e.class} #{e.message}")
      0
    end
  end
end
