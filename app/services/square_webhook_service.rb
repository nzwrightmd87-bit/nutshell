# frozen_string_literal: true

class SquareWebhookService
  SIGNATURE_HEADER = 'x-square-hmacsha256-signature'

  class InvalidSignature < StandardError; end

  def initialize(request)
    @request = request
    @raw_body = request.body.read
    request.body.rewind
  end

  def verify_signature!
    signature_key = ENV.fetch('SQUARE_WEBHOOK_SIGNATURE_KEY', '')
    notification_url = ENV.fetch('SQUARE_WEBHOOK_NOTIFICATION_URL', "https://#{ENV.fetch('LOCAL_DOMAIN', 'nutshell.sbs')}/webhooks/square")

    received_signature = @request.headers[SIGNATURE_HEADER].to_s
    raise InvalidSignature, 'Missing signature header' if received_signature.blank?
    raise InvalidSignature, 'Missing signature key' if signature_key.blank?

    expected_signature = Base64.strict_encode64(
      OpenSSL::HMAC.digest('sha256', signature_key, notification_url + @raw_body)
    )

    unless ActiveSupport::SecurityUtils.secure_compare(expected_signature, received_signature)
      raise InvalidSignature, 'Signature mismatch'
    end

    true
  end

  def parsed_event
    @parsed_event ||= JSON.parse(@raw_body)
  end

  def event_type
    parsed_event['type']
  end

  def process!
    case event_type
    when 'subscription.created'
      handle_subscription_created
    when 'subscription.updated'
      handle_subscription_updated
    when 'invoice.payment_made'
      handle_invoice_payment_made
    when 'invoice.scheduled_charge_failed'
      handle_invoice_charge_failed
    else
      Rails.logger.info("[paid-memberships] Ignoring Square event: #{event_type}")
    end
  end

  private

  def subscription_data
    parsed_event.dig('data', 'object', 'subscription') || parsed_event.dig('data', 'object') || {}
  end

  def invoice_data
    parsed_event.dig('data', 'object', 'invoice') || parsed_event.dig('data', 'object') || {}
  end

  def handle_subscription_created
    sub = subscription_data
    subscription_id = sub['id']
    customer_id = sub['customer_id']
    plan_variation_id = sub['plan_variation_id']
    status = sub['status'] # ACTIVE, CANCELED, PENDING, etc.

    return if subscription_id.blank?

    plan = detect_plan(plan_variation_id)
    customer_email = fetch_customer_email(customer_id)

    membership = Membership.find_or_initialize_by(square_subscription_id: subscription_id)
    membership.assign_attributes(
      email: customer_email || "square-customer-#{customer_id}@nutshell.sbs",
      plan: plan,
      square_customer_id: customer_id,
      status: square_status_to_membership_status(status)
    )

    if membership.status == 'active' && membership.paid_at.nil?
      membership.paid_at = Time.current
    end

    membership.save!

    Rails.logger.info("[paid-memberships] Subscription created: #{subscription_id} (#{plan}, #{membership.status}) — access code: #{membership.access_code}")
  end

  def handle_subscription_updated
    sub = subscription_data
    subscription_id = sub['id']
    status = sub['status']

    return if subscription_id.blank?

    membership = Membership.find_by(square_subscription_id: subscription_id)
    return if membership.nil?

    new_status = square_status_to_membership_status(status)
    old_status = membership.status

    membership.status = new_status
    membership.canceled_at = Time.current if new_status == 'canceled' && old_status != 'canceled'
    membership.paid_at = Time.current if new_status == 'active' && membership.paid_at.nil?
    membership.save!

    # Disable user if subscription canceled and user exists
    if new_status == 'canceled' && membership.user.present?
      membership.user.update!(disabled: true)
      Rails.logger.info("[paid-memberships] Disabled user #{membership.user.id} — subscription #{subscription_id} canceled")
    end

    # Re-enable user if subscription reactivated
    if new_status == 'active' && old_status != 'active' && membership.user.present?
      membership.user.update!(disabled: false)
      Rails.logger.info("[paid-memberships] Re-enabled user #{membership.user.id} — subscription #{subscription_id} reactivated")
    end

    Rails.logger.info("[paid-memberships] Subscription updated: #{subscription_id} → #{new_status}")
  end

  def handle_invoice_payment_made
    inv = invoice_data
    subscription_id = inv['subscription_id']

    return if subscription_id.blank?

    membership = Membership.find_by(square_subscription_id: subscription_id)
    return if membership.nil?

    membership.update!(
      status: 'active',
      paid_at: Time.current,
      square_invoice_id: inv['id']
    )

    # Re-enable user if they were disabled due to past_due
    if membership.user.present? && membership.user.disabled?
      membership.user.update!(disabled: false)
      Rails.logger.info("[paid-memberships] Re-enabled user #{membership.user.id} after invoice payment")
    end

    Rails.logger.info("[paid-memberships] Invoice paid for subscription #{subscription_id}")
  end

  def handle_invoice_charge_failed
    inv = invoice_data
    subscription_id = inv['subscription_id']

    return if subscription_id.blank?

    membership = Membership.find_by(square_subscription_id: subscription_id)
    return if membership.nil?

    membership.mark_past_due!
    Rails.logger.info("[paid-memberships] Invoice charge failed for subscription #{subscription_id}")
  end

  def detect_plan(plan_variation_id)
    monthly_id = ENV.fetch('SQUARE_MONTHLY_PLAN_VARIATION_ID', '')
    yearly_id = ENV.fetch('SQUARE_YEARLY_PLAN_VARIATION_ID', '')

    case plan_variation_id
    when monthly_id then 'monthly'
    when yearly_id then 'yearly'
    else
      # Default to monthly if we can't determine
      Rails.logger.warn("[paid-memberships] Unknown plan variation ID: #{plan_variation_id}, defaulting to monthly")
      'monthly'
    end
  end

  def fetch_customer_email(customer_id)
    return nil if customer_id.blank?

    access_token = ENV.fetch('SQUARE_ACCESS_TOKEN', '')
    return nil if access_token.blank?

    uri = URI("https://connect.squareup.com/v2/customers/#{customer_id}")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 5
    http.read_timeout = 5

    req = Net::HTTP::Get.new(uri)
    req['Authorization'] = "Bearer #{access_token}"
    req['Square-Version'] = '2024-12-18'
    req['Content-Type'] = 'application/json'

    response = http.request(req)
    return nil unless response.is_a?(Net::HTTPSuccess)

    data = JSON.parse(response.body)
    data.dig('customer', 'email_address')
  rescue StandardError => e
    Rails.logger.warn("[paid-memberships] Failed to fetch customer email for #{customer_id}: #{e.message}")
    nil
  end

  def square_status_to_membership_status(square_status)
    case square_status.to_s.upcase
    when 'ACTIVE' then 'active'
    when 'CANCELED' then 'canceled'
    when 'DEACTIVATED' then 'canceled'
    when 'PAUSED' then 'past_due'
    else 'pending'
    end
  end
end
