# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'dev rake tasks' do
  describe 'sample data quote policies' do
    let(:task_source) { Rails.root.join('lib/tasks/dev.rake').read }

    it 'uses the current interaction policy flag constant' do
      expect(task_source).to include('quote_approval_policy: InteractionPolicy::POLICY_FLAGS[:public]')
      expect(task_source).to_not include('Status::QUOTE_APPROVAL_POLICY_FLAGS')
      expect(InteractionPolicy::POLICY_FLAGS[:public]).to eq(1 << 1)
    end
  end
end
