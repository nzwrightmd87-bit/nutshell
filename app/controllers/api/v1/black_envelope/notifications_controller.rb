# frozen_string_literal: true

class Api::V1::BlackEnvelope::NotificationsController < Api::BaseController
  before_action :require_user!

  def unread_count
    count = BlackEnvelope::UnreadCountService.new.call(current_user)
    render json: { unread_count: count }
  end
end
