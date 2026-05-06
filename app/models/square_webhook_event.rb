# frozen_string_literal: true

class SquareWebhookEvent < ApplicationRecord
  validates :event_id, presence: true
  validates :event_type, presence: true
  validates :event_created_at, presence: true
  validates :processed_at, presence: true
end
