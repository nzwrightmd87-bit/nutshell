# frozen_string_literal: true

class CreateMemberships < ActiveRecord::Migration[7.2]
  def change
    create_table :memberships do |t|
      t.references :user, null: true, foreign_key: { on_delete: :nullify }, index: true
      t.string :email, null: false
      t.string :access_code, null: false
      t.string :plan, null: false # 'monthly' or 'yearly'
      t.string :status, null: false, default: 'pending' # pending, active, canceled, past_due
      t.string :square_subscription_id
      t.string :square_customer_id
      t.string :square_invoice_id
      t.datetime :paid_at
      t.datetime :canceled_at
      t.datetime :expires_at
      t.timestamps
    end

    add_index :memberships, :access_code, unique: true
    add_index :memberships, :email
    add_index :memberships, :square_subscription_id, unique: true, where: 'square_subscription_id IS NOT NULL'
    add_index :memberships, :status
  end
end
