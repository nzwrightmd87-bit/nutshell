# frozen_string_literal: true

require 'rails_helper'

RSpec.describe BillingController do
  describe 'GET #checkout' do
    let(:monthly_checkout_url) { 'https://square.link/u/monthly-subscription' }

    it 'prefers the configured hosted subscription checkout link' do
      ClimateControl.modify(
        'SQUARE_MONTHLY_CHECKOUT_URL' => monthly_checkout_url,
        'SQUARE_ACCESS_TOKEN' => 'token',
        'SQUARE_LOCATION_ID' => 'location',
        'SQUARE_MONTHLY_PLAN_VARIATION_ID' => 'variation-monthly'
      ) do
        get :checkout, params: { plan: 'monthly' }

        expect(response).to redirect_to(monthly_checkout_url)
      end
    end

    it 'creates a subscription checkout link when falling back to the API' do
      stub_request(:post, 'https://connect.squareup.com/v2/online-checkout/payment-links')
        .with do |request|
          payload = JSON.parse(request.body)

          expect(payload.dig('checkout_options', 'subscription_plan_id')).to eq('variation-monthly')
          expect(payload.dig('checkout_options', 'redirect_url')).to eq('http://test.host/billing/success?plan=monthly')
          expect(payload.dig('quick_pay', 'price_money', 'amount')).to eq(500)

          true
        end
        .to_return(
          status: 200,
          body: {
            payment_link: {
              long_url: 'https://square.link/u/generated-monthly-subscription',
            },
          }.to_json,
          headers: { 'Content-Type' => 'application/json' }
        )

      ClimateControl.modify(
        'SQUARE_MONTHLY_CHECKOUT_URL' => nil,
        'SQUARE_ACCESS_TOKEN' => 'token',
        'SQUARE_LOCATION_ID' => 'location',
        'SQUARE_MONTHLY_PLAN_VARIATION_ID' => 'variation-monthly'
      ) do
        get :checkout, params: { plan: 'monthly' }

        expect(response).to redirect_to('https://square.link/u/generated-monthly-subscription')
      end
    end
  end
end
