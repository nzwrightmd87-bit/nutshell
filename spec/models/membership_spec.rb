# frozen_string_literal: true

require 'rails_helper'

RSpec.describe Membership do
  describe '#claim!' do
    let(:email) { 'member@example.com' }
    let(:membership) { Fabricate(:membership, email: email, status: 'active') }

    it 'does not claim the membership for an unconfirmed user' do
      user = Fabricate(:user, email: email, confirmed_at: nil)

      expect { membership.claim!(user) }
        .to not_change { membership.reload.user_id }
    end

    it 'claims the membership for a confirmed user with the membership email' do
      user = Fabricate(:user, email: email, confirmed_at: 1.hour.ago)

      expect { membership.claim!(user) }
        .to change { membership.reload.user_id }.from(nil).to(user.id)
    end

    it 'does not claim the membership for a confirmed user with a different email' do
      user = Fabricate(:user, email: 'other@example.com', confirmed_at: 1.hour.ago)

      expect { membership.claim!(user) }
        .to not_change { membership.reload.user_id }
    end

    it 'does not reassign an already claimed membership' do
      original_user = Fabricate(:user, email: email, confirmed_at: 1.hour.ago)
      other_user = Fabricate(:user, email: 'other@example.com', confirmed_at: 1.hour.ago)
      membership.update!(user: original_user)

      expect { membership.claim!(other_user) }
        .to not_change { membership.reload.user_id }
    end

    it 'is idempotent when already claimed by the same user' do
      user = Fabricate(:user, email: email, confirmed_at: 1.hour.ago)
      membership.update!(user: user)

      expect(membership.claim!(user)).to be true
    end
  end
end
