# frozen_string_literal: true

module Webhooks
  class ResendController < ActionController::Base
    skip_forgery_protection

    def create
      Rails.logger.info('[mail] Placeholder Resend webhook received for Nutshell')
      head :accepted
    end
  end
end
