# frozen_string_literal: true

module PaidMembershipsHelper
  def paid_memberships_enabled?
    boolean_env('PAID_MEMBERSHIPS_ENABLED')
  end

  def paid_membership_provider
    ENV.fetch('PAID_MEMBERSHIPS_PROVIDER', 'square')
  end

  def paid_membership_plan_amount_cents(plan)
    case plan.to_sym
    when :monthly
      ENV.fetch('PAID_MEMBERSHIPS_MONTHLY_PRICE_CENTS', '500').to_i
    when :yearly
      ENV.fetch('PAID_MEMBERSHIPS_YEARLY_PRICE_CENTS', '4800').to_i
    else
      raise ArgumentError, "Unknown paid membership plan: #{plan}"
    end
  end

  def paid_membership_checkout_url(plan)
    ENV.fetch("SQUARE_#{plan.to_s.upcase}_CHECKOUT_URL", '').strip.presence
  end

  def paid_membership_checkout_configured?(plan)
    paid_membership_checkout_url(plan).present?
  end

  def paid_membership_checkout_pending?
    paid_memberships_enabled? && (!paid_membership_checkout_configured?(:monthly) || !paid_membership_checkout_configured?(:yearly))
  end

  def paid_membership_allow_invites?
    boolean_env('PAID_MEMBERSHIPS_ALLOW_INVITES', false)
  end

  def paid_membership_registration_allowed_for_email?(invite, email)
    return true unless paid_memberships_enabled?
    return true if invite.present? && paid_membership_allow_invites?

    # Check for an active membership matching this email
    find_active_membership_by_email(email).present?
  end

  # Link a membership to a user after successful registration
  def claim_membership_for_user!(user)
    return unless paid_memberships_enabled?
    return if user.email.blank?

    membership = find_active_membership_by_email(user.email)
    membership&.claim!(user)
  end

  def paid_membership_registration_error_message
    I18n.t('auth.sign_up.membership_email_error')
  end

  private

  def boolean_env(key, default = false)
    ActiveModel::Type::Boolean.new.cast(ENV.fetch(key, default.to_s))
  end

  def find_active_membership_by_email(email)
    return nil if email.blank?

    Membership.active.by_email(email.to_s.strip).first
  end
end
