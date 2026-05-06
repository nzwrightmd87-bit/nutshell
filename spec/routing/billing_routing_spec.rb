# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'Billing routes' do
  it 'routes checkout creation through POST only' do
    expect(post('/billing/checkout')).to route_to('billing#checkout')
    expect(get('/billing/checkout')).to_not be_routable
  end
end
