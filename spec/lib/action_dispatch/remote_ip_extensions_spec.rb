# frozen_string_literal: true

require 'rails_helper'

RSpec.describe ActionDispatch::RemoteIp::GetIpExtensions do
  let(:trusted_proxy_ip) { '127.0.0.1' }
  let(:real_client_ip) { '198.51.100.123' }
  let(:spoofed_client_ip) { '203.0.113.66' }

  it 'ignores client-supplied Forwarded headers when X-Forwarded-For is present' do
    expect(remote_ip_for(
             'REMOTE_ADDR' => trusted_proxy_ip,
             'HTTP_X_FORWARDED_FOR' => real_client_ip,
             'HTTP_FORWARDED' => "for=#{spoofed_client_ip}"
           )).to eq real_client_ip
  end

  it 'does not use Forwarded as a trusted client IP source' do
    expect(remote_ip_for(
             'REMOTE_ADDR' => trusted_proxy_ip,
             'HTTP_FORWARDED' => "for=#{spoofed_client_ip}"
           )).to eq trusted_proxy_ip
  end

  it 'rejects proxy IP headers from untrusted clients' do
    expect do
      remote_ip_for(
        'REMOTE_ADDR' => '198.51.100.10',
        'HTTP_X_FORWARDED_FOR' => real_client_ip
      )
    end.to raise_error(ActionDispatch::RemoteIp::IpSpoofAttackError)
  end

  def remote_ip_for(headers)
    app = lambda do |env|
      request = ActionDispatch::Request.new(env)
      [200, {}, [request.remote_ip.to_s]]
    end

    _status, _headers, body = ActionDispatch::RemoteIp
                              .new(app, true, [IPAddr.new(trusted_proxy_ip)])
                              .call(Rack::MockRequest.env_for('/', headers))

    body.each.to_a.join
  end
end
