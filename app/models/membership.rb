# frozen_string_literal: true

# == Schema Information
#
# Table name: memberships
#
#  id                       :bigint(8)        not null, primary key
#  user_id                  :bigint(8)
#  email                    :string           not null
#  access_code              :string           not null
#  plan                     :string           not null
#  status                   :string           default("pending"), not null
#  square_subscription_id   :string
#  square_customer_id       :string
#  square_invoice_id        :string
#  paid_at                  :datetime
#  canceled_at              :datetime
#  expires_at               :datetime
#  created_at               :datetime         not null
#  updated_at               :datetime         not null
#

class Membership < ApplicationRecord
  belongs_to :user, optional: true

  validates :email, presence: true
  validates :access_code, presence: true, uniqueness: true
  validates :plan, presence: true, inclusion: { in: %w[monthly yearly] }
  validates :status, presence: true, inclusion: { in: %w[pending active canceled past_due] }

  scope :active, -> { where(status: 'active') }
  scope :by_email, ->(email) { where('LOWER(email) = LOWER(?)', email) }
  scope :by_square_subscription, ->(id) { where(square_subscription_id: id) }

  before_validation :generate_access_code, on: :create, if: -> { access_code.blank? }

  def active?
    status == 'active'
  end

  def activate!(paid_at: Time.current)
    update!(status: 'active', paid_at: paid_at)
  end

  def cancel!
    update!(status: 'canceled', canceled_at: Time.current)
  end

  def mark_past_due!
    update!(status: 'past_due')
  end

  # Link this membership to a user after they sign up with the access code
  def claim!(user)
    update!(user: user)
  end

  private

  def generate_access_code
    loop do
      self.access_code = SecureRandom.alphanumeric(24)
      break unless Membership.exists?(access_code: access_code)
    end
  end
end
