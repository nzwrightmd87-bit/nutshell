# frozen_string_literal: true

class HomeController < ApplicationController
  include WebAppControllerConcern

  before_action :redirect_unauthenticated_public_app_routes!
  before_action :set_landing_page_mode!

  def index
    expires_in(15.seconds, public: true, stale_while_revalidate: 30.seconds, stale_if_error: 1.day) unless user_signed_in?
  end

  private

  def redirect_unauthenticated_public_app_routes!
    return if user_signed_in?
    return unless truthy_param?(:public_app_route)

    redirect_to root_path
  end

  def set_landing_page_mode!
    @render_landing_page = !user_signed_in? && request.path == root_path
  end
end
