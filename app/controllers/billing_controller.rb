# frozen_string_literal: true

class BillingController < ApplicationController
  include PaidMembershipsHelper

  layout 'auth'

  before_action :set_selected_plan

  def show; end

  def success; end

  def cancel; end

  private

  def set_selected_plan
    @selected_plan = params[:plan].to_s == 'yearly' ? :yearly : :monthly
  end
end
