# frozen_string_literal: true

module Webhooks
  class SquareController < ActionController::Base
    skip_forgery_protection

    def create
      service = SquareWebhookService.new(request)
      service.verify_signature!
      service.process!

      head :ok
    rescue SquareWebhookService::InvalidSignature => e
      Rails.logger.warn("[paid-memberships] Square webhook signature verification failed: #{e.message}")
      head :unauthorized
    rescue JSON::ParserError => e
      Rails.logger.warn("[paid-memberships] Square webhook JSON parse error: #{e.message}")
      head :bad_request
    rescue StandardError => e
      Rails.logger.error("[paid-memberships] Square webhook processing error: #{e.class} — #{e.message}")
      head :internal_server_error
    end
  end
end
