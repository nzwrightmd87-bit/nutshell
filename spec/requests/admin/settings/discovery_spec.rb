# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'Admin Settings Discovery' do
  before { sign_in Fabricate(:admin_user) }

  describe 'GET /admin/settings/discovery' do
    it 'preserves legacy disabled local topic feed access in the form' do
      Setting.local_topic_feed_access = 'disabled'

      get admin_settings_discovery_path

      select = Nokogiri::HTML5(response.body).at_css('select[name="form_admin_settings[local_topic_feed_access]"]')
      options = select.css('option').to_h { |option| [option['value'], option['selected'].present?] }

      expect(options)
        .to include('disabled' => true)
    end
  end
end
