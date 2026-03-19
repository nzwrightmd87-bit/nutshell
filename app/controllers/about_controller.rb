# frozen_string_literal: true

class AboutController < ApplicationController
  include WebAppControllerConcern

  skip_before_action :require_functional!
  before_action :set_landing_page_mode!

  def show
    expires_in(15.seconds, public: true, stale_while_revalidate: 30.seconds, stale_if_error: 1.day) unless user_signed_in?
  end

  private

  def set_landing_page_mode!
    @render_landing_page = !user_signed_in?
  end
end
