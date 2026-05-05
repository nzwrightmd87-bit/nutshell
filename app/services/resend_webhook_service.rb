# frozen_string_literal: true

require 'base64'
require 'openssl'

class ResendWebhookService
  SIGNATURE_ID_HEADER = 'svix-id'
  SIGNATURE_TIMESTAMP_HEADER = 'svix-timestamp'
  SIGNATURE_HEADER = 'svix-signature'
  SIGNATURE_VERSION = 'v1'
  TIMESTAMP_TOLERANCE_SECONDS = 5.minutes.to_i
  REPLAY_TTL_SECONDS = 24.hours.to_i
  REPLAY_KEY_PREFIX = 'resend:webhook:seen'

  class VerificationError < StandardError; end
  class ReplayError < StandardError; end

  def initialize(request)
    @request = request
    @raw_body = request.body.read
    request.body.rewind
  end

  def verify_signature_and_replay!
    return :skipped if webhook_secret.blank?

    message_id = fetch_header(SIGNATURE_ID_HEADER)
    timestamp = parse_timestamp(fetch_header(SIGNATURE_TIMESTAMP_HEADER))
    signature_header = fetch_header(SIGNATURE_HEADER)

    verify_timestamp!(timestamp)
    verify_signature!(message_id, timestamp, signature_header)
    reserve_message_id!(message_id)

    :verified
  end

  private

  def webhook_secret
    @webhook_secret ||= ENV.fetch('RESEND_WEBHOOK_SECRET', '').to_s.strip
  end

  def fetch_header(name)
    value = @request.headers[name].to_s.strip
    raise VerificationError, "Missing #{name} header" if value.blank?

    value
  end

  def parse_timestamp(value)
    Integer(value)
  rescue ArgumentError, TypeError
    raise VerificationError, 'Invalid svix timestamp'
  end

  def verify_timestamp!(timestamp)
    now = Time.now.to_i
    return if (now - timestamp).abs <= TIMESTAMP_TOLERANCE_SECONDS

    raise VerificationError, 'svix timestamp outside allowed tolerance'
  end

  def verify_signature!(message_id, timestamp, signature_header)
    signed_content = "#{message_id}.#{timestamp}.#{@raw_body}"
    expected_signature = Base64.strict_encode64(
      OpenSSL::HMAC.digest('sha256', signing_key(webhook_secret), signed_content)
    )

    signatures = signature_header.split(/\s+/).filter_map do |entry|
      version, signature = entry.split(',', 2)
      next if version != SIGNATURE_VERSION || signature.blank?

      signature
    end

    valid = signatures.any? { |signature| secure_signature_match?(expected_signature, signature) }
    raise VerificationError, 'Signature mismatch' unless valid
  end

  def secure_signature_match?(expected, provided)
    return false unless provided.bytesize == expected.bytesize

    ActiveSupport::SecurityUtils.secure_compare(expected, provided)
  end

  def signing_key(secret)
    encoded = secret.delete_prefix('whsec_')
    Base64.urlsafe_decode64(encoded)
  rescue ArgumentError
    # Fall back to raw key material if the secret is not base64 encoded.
    encoded
  end

  def reserve_message_id!(message_id)
    replay_key = "#{REPLAY_KEY_PREFIX}:#{message_id}"

    created = RedisConnection.with do |redis|
      redis.set(replay_key, Time.now.to_i, ex: REPLAY_TTL_SECONDS, nx: true)
    end

    raise ReplayError, "Duplicate svix-id #{message_id}" unless created
  end
end
