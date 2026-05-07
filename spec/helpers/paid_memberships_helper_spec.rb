# frozen_string_literal: true

require 'rails_helper'

RSpec.describe PaidMembershipsHelper do
  describe '#paid_membership_registration_allowed_for_email?' do
    it 'does not reveal whether an email has an active membership during registration' do
      Fabricate(:membership, email: 'member@example.com', status: 'active')

      ClimateControl.modify PAID_MEMBERSHIPS_ENABLED: 'true' do
        expect(helper.paid_membership_registration_allowed_for_email?(nil, 'member@example.com'))
          .to be true
        expect(helper.paid_membership_registration_allowed_for_email?(nil, 'nonmember@example.com'))
          .to be true
      end
    end
  end

  describe '#mark_paid_membership_registration_pending!' do
    it 'marks a paid-membership registration as pending until email confirmation claims a membership' do
      user = Fabricate(:user, confirmed_at: nil, approved: true)

      ClimateControl.modify PAID_MEMBERSHIPS_ENABLED: 'true' do
        expect { helper.mark_paid_membership_registration_pending!(user, nil) }
          .to change { user.reload.approved? }.from(true).to(false)
      end
    end
  end

  describe '#claim_membership_for_user!' do
    it 'does not claim a membership before the user confirms their email' do
      membership = Fabricate(:membership, email: 'member@example.com', status: 'active')
      user = Fabricate(:user, email: 'member@example.com', confirmed_at: nil)

      ClimateControl.modify PAID_MEMBERSHIPS_ENABLED: 'true' do
        expect { helper.claim_membership_for_user!(user) }
          .to(not_change { membership.reload.user_id })
      end
    end

    it 'claims a membership and approves the user after email confirmation' do
      membership = Fabricate(:membership, email: 'member@example.com', status: 'active')
      user = Fabricate(:user, email: 'member@example.com', confirmed_at: 1.hour.ago)
      user.update!(approved: false)

      ClimateControl.modify PAID_MEMBERSHIPS_ENABLED: 'true' do
        expect { helper.claim_membership_for_user!(user) }
          .to change { membership.reload.user_id }.from(nil).to(user.id)
          .and change { user.reload.approved? }.from(false).to(true)
      end
    end
  end
end
