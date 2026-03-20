# frozen_string_literal: true

# Register the Resend HTTP API as a custom ActionMailer delivery method.
# Activated by setting SMTP_DELIVERY_METHOD=resend_api in .env.production.
require_relative '../../app/lib/resend_api_delivery_method'

ActionMailer::Base.add_delivery_method :resend_api, ResendApiDeliveryMethod,
                                       api_key: ENV.fetch('RESEND_API_KEY', '')
