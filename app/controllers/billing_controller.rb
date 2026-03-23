# frozen_string_literal: true

require 'net/http'
require 'json'
require 'securerandom'

class BillingController < ApplicationController
  include PaidMembershipsHelper

  layout 'auth'

  before_action :set_selected_plan

  def show; end

  def success; end

  def cancel; end

  def checkout
    plan_variation_id = square_plan_variation_id(@selected_plan)
    access_token = ENV.fetch('SQUARE_ACCESS_TOKEN', '').strip
    location_id = ENV.fetch('SQUARE_LOCATION_ID', '').strip

    # Fall back to static links if API isn't configured
    if access_token.blank? || location_id.blank? || plan_variation_id.blank?
      fallback_to_static_link
      return
    end

    checkout_url = create_square_checkout(access_token, location_id, plan_variation_id)

    if checkout_url
      redirect_to checkout_url, allow_other_host: true
    else
      fallback_to_static_link
    end
  end

  private

  def set_selected_plan
    @selected_plan = params[:plan].to_s == 'yearly' ? :yearly : :monthly
  end

  def fallback_to_static_link
    static_url = paid_membership_checkout_url(@selected_plan)
    if static_url.present?
      redirect_to static_url, allow_other_host: true
    else
      redirect_to billing_path(plan: @selected_plan), alert: I18n.t('auth.sign_up.checkout_unavailable')
    end
  end

  def square_plan_variation_id(plan)
    case plan
    when :monthly
      ENV.fetch('SQUARE_MONTHLY_PLAN_VARIATION_ID', '').strip.presence
    when :yearly
      ENV.fetch('SQUARE_YEARLY_PLAN_VARIATION_ID', '').strip.presence
    end
  end

  def create_square_checkout(access_token, location_id, plan_variation_id)
    uri = URI('https://connect.squareup.com/v2/online-checkout/payment-links')
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 5
    http.read_timeout = 10

    body = {
      idempotency_key: SecureRandom.uuid,
      quick_pay: {
        name: @selected_plan == :yearly ? 'Nutshell Yearly Membership' : 'Nutshell Monthly Membership',
        price_money: {
          amount: paid_membership_plan_amount_cents(@selected_plan),
          currency: 'USD',
        },
        location_id: location_id,
      },
      checkout_options: {
        redirect_url: billing_success_url,
      },
    }

    req = Net::HTTP::Post.new(uri)
    req['Authorization'] = "Bearer #{access_token}"
    req['Square-Version'] = '2024-12-18'
    req['Content-Type'] = 'application/json'
    req.body = body.to_json

    response = http.request(req)

    if response.is_a?(Net::HTTPSuccess)
      data = JSON.parse(response.body)
      data.dig('payment_link', 'long_url') || data.dig('payment_link', 'url')
    else
      Rails.logger.error("[billing] Square checkout API failed: #{response.code} #{response.body.to_s[0, 500]}")
      nil
    end
  rescue StandardError => e
    Rails.logger.error("[billing] Square checkout error: #{e.class} #{e.message}")
    nil
  end
end
