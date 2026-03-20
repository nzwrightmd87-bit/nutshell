# frozen_string_literal: true

# Custom ActionMailer delivery method that sends emails via Resend's HTTP API
# instead of SMTP. This bypasses DigitalOcean's outbound SMTP port blocking.
#
# Usage: Set SMTP_DELIVERY_METHOD=resend_api and RESEND_API_KEY in .env.production
class ResendApiDeliveryMethod
  RESEND_API_URL = 'https://api.resend.com/emails'

  attr_accessor :settings

  def initialize(settings = {})
    self.settings = settings
  end

  def deliver!(mail)
    api_key = settings[:api_key] || ENV.fetch('RESEND_API_KEY')

    payload = {
      from: mail.from&.first ? format_address(mail[:from]) : nil,
      to: Array(mail.to),
      subject: mail.subject,
    }

    payload[:cc] = Array(mail.cc) if mail.cc.present?
    payload[:bcc] = Array(mail.bcc) if mail.bcc.present?
    payload[:reply_to] = Array(mail.reply_to).first if mail.reply_to.present?

    # Prefer HTML part, fall back to text
    if mail.html_part
      payload[:html] = mail.html_part.body.decoded
    elsif mail.text_part
      payload[:text] = mail.text_part.body.decoded
    elsif mail.content_type&.include?('text/html')
      payload[:html] = mail.body.decoded
    else
      payload[:text] = mail.body.decoded
    end

    uri = URI.parse(RESEND_API_URL)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 10
    http.read_timeout = 20

    request = Net::HTTP::Post.new(uri.path)
    request['Authorization'] = "Bearer #{api_key}"
    request['Content-Type'] = 'application/json'
    request.body = payload.compact.to_json

    response = http.request(request)

    unless response.is_a?(Net::HTTPSuccess)
      raise "Resend API error (#{response.code}): #{response.body}"
    end

    response
  end

  private

  def format_address(header_field)
    # Mail gem header field — extract the formatted address
    addr = header_field.addresses&.first
    name = header_field.display_names&.first
    name.present? ? "#{name} <#{addr}>" : addr
  end
end
