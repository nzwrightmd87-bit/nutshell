# frozen_string_literal: true

require 'uri'

class BlackEnvelopeLaunchesController < ApplicationController
  before_action :authenticate_user!

  def show
    target = launch_target

    if target.present?
      redirect_to target, allow_other_host: true
    else
      redirect_to root_path, alert: 'BlackEnvelope is not configured yet.'
    end
  end

  private

  def launch_target
    return BlackEnvelope::Configuration.app_url unless BlackEnvelope::Configuration.sso_enabled?

    uri = URI.parse(BlackEnvelope::Configuration.handoff_url)
    uri.query = { token: BlackEnvelope::IntegrationTokenService.new.call(current_user) }.to_query
    uri.to_s
  rescue URI::InvalidURIError
    BlackEnvelope::Configuration.app_url
  end
end
