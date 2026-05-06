# frozen_string_literal: true

class CreateSquareWebhookEvents < ActiveRecord::Migration[8.1]
  def change
    create_table :square_webhook_events do |t|
      t.string :event_id, null: false
      t.string :event_type, null: false
      t.datetime :event_created_at, null: false
      t.datetime :processed_at, null: false
      t.timestamps
    end

    add_index :square_webhook_events, :event_id, unique: true
  end
end
