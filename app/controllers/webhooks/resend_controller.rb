# frozen_string_literal: true

module Webhooks
  class ResendController < ActionController::Base
    skip_forgery_protection

    def create
      verification_state = ResendWebhookService.new(request).verify_signature_and_replay!

      if verification_state == :skipped
        Rails.logger.warn('[mail] Resend webhook verification skipped because RESEND_WEBHOOK_SECRET is not configured')
      end

      Rails.logger.info('[mail] Placeholder Resend webhook received for Nutshell')
      head :accepted
    rescue ResendWebhookService::ReplayError => e
      Rails.logger.info("[mail] Duplicate Resend webhook ignored: #{e.message}")
      head :ok
    rescue ResendWebhookService::VerificationError => e
      Rails.logger.warn("[mail] Resend webhook signature verification failed: #{e.message}")
      head :unauthorized
    end
  end
end
