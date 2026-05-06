# frozen_string_literal: true

require 'erb'

class BlackEnvelopeLaunchesController < ApplicationController
  before_action :authenticate_user!

  def show
    if BlackEnvelope::Configuration.sso_enabled?
      render html: post_handoff_html.html_safe, layout: false # rubocop:disable Rails/OutputSafety
      return
    end

    target = BlackEnvelope::Configuration.app_url
    return redirect_to target, allow_other_host: true if target.present?

    redirect_to root_path, alert: 'BlackEnvelope is not configured yet.'
  rescue StandardError => e
    Rails.logger.error("[black-envelope] Failed to create SSO handoff: #{e.class} #{e.message}")
    target = BlackEnvelope::Configuration.app_url
    return redirect_to target, allow_other_host: true if target.present?

    redirect_to root_path, alert: 'BlackEnvelope is not configured yet.'
  end

  private

  def post_handoff_html
    raw_handoff_url = BlackEnvelope::Configuration.handoff_url.to_s
    raise ArgumentError, 'BlackEnvelope handoff URL is not configured' if raw_handoff_url.blank?

    request.content_security_policy_nonce_directives = %w(script-src)

    handoff_url = ERB::Util.html_escape(raw_handoff_url)
    token = ERB::Util.html_escape(BlackEnvelope::IntegrationTokenService.new.call(current_user))
    script_nonce = ERB::Util.html_escape(view_context.content_security_policy_nonce.to_s)

    <<~HTML
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Opening BlackEnvelope</title>
        </head>
        <body style="background:#0f141f;color:#f5f7fb;font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;margin:0;">
          <main style="max-width:28rem;padding:2rem;text-align:center;">
            <h1 style="margin:0 0 0.75rem;font-size:1.5rem;">Opening BlackEnvelope</h1>
            <p style="margin:0 0 1.25rem;color:#b6bfd2;">Your Nutshell session is being transferred now.</p>
            <form id="black-envelope-sso-handoff" action="#{handoff_url}" method="post">
              <input type="hidden" name="token" value="#{token}">
              <button type="submit" style="padding:0.6rem 1rem;border:0;border-radius:0.5rem;background:#3b82f6;color:#fff;cursor:pointer;">Continue to BlackEnvelope</button>
            </form>
            <p style="margin:0.9rem 0 0;color:#9aa4b2;font-size:0.9rem;">If you are not redirected automatically, use the button above.</p>
          </main>
          <script nonce="#{script_nonce}">
            (function() {
              var form = document.getElementById('black-envelope-sso-handoff');
              if (form) form.submit();
            })();
          </script>
        </body>
      </html>
    HTML
  end
end
