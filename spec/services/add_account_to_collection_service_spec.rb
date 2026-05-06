# frozen_string_literal: true

require 'rails_helper'

RSpec.describe AddAccountToCollectionService do
  subject { described_class.new }

  let(:collection) { Fabricate.create(:collection) }

  describe '#call' do
    context 'when given a featurable account' do
      let(:account) { Fabricate(:account) }

      before do
        collection.account.follow!(account)
      end

      it 'creates a new CollectionItem in the `accepted` state' do
        expect do
          subject.call(collection, account)
        end.to change(collection.collection_items, :count).by(1)

        new_item = collection.collection_items.last
        expect(new_item.state).to eq 'accepted'
        expect(new_item.account).to eq account
      end

      context 'when the collection already has the maximum number of items' do
        before do
          Collection::MAX_ITEMS.times do
            Fabricate(:collection_item, collection:, account: Fabricate(:account))
          end
        end

        it 'raises a validation error and does not add another item' do
          expect do
            expect do
              subject.call(collection, account)
            end.to raise_error(Mastodon::ValidationError)
          end.to_not change(collection.collection_items, :count)
        end
      end

      context 'when the account is local' do
        it 'federates an `Add` activity', feature: :collections_federation do
          subject.call(collection, account)

          expect(ActivityPub::AccountRawDistributionWorker).to have_enqueued_sidekiq_job
        end

        context 'when the collection is not discoverable' do
          let(:collection) { Fabricate.create(:collection, discoverable: false) }

          it 'does not federate an `Add` activity', feature: :collections_federation do
            subject.call(collection, account)

            expect(ActivityPub::AccountRawDistributionWorker).to_not have_enqueued_sidekiq_job
          end
        end
      end

      context 'when the account is remote', feature: :collections_federation do
        let(:account) { Fabricate(:remote_account, feature_approval_policy: (0b10 << 16)) }

        it 'federates a `FeatureRequest` activity' do
          subject.call(collection, account)

          expect(collection.collection_items.last).to be_accepted
          expect(ActivityPub::FeatureRequestWorker).to have_enqueued_sidekiq_job
        end

        context 'when the account only allows manual feature approval' do
          let(:account) { Fabricate(:remote_account, feature_approval_policy: InteractionPolicy::POLICY_FLAGS[:public]) }

          it 'creates a pending item and requests approval before exposing it' do
            subject.call(collection, account)

            expect(collection.collection_items.last).to be_pending
            expect(ActivityPub::FeatureRequestWorker).to have_enqueued_sidekiq_job
            expect(ActivityPub::AccountRawDistributionWorker).to_not have_enqueued_sidekiq_job
          end
        end

        context 'when the collection is not discoverable' do
          let(:collection) { Fabricate.create(:collection, discoverable: false) }

          it 'does not federate a `FeatureRequest` activity' do
            subject.call(collection, account)

            expect(ActivityPub::FeatureRequestWorker).to_not have_enqueued_sidekiq_job
          end
        end
      end
    end

    context 'when the collection owner does not follow the account' do
      let(:account) { Fabricate(:account) }

      it 'raises an error' do
        expect do
          subject.call(collection, account)
        end.to raise_error(Mastodon::NotPermittedError)
      end
    end

    context 'when given an account that is not featureable' do
      let(:account) { Fabricate(:account, discoverable: false) }

      before do
        collection.account.follow!(account)
      end

      it 'raises an error' do
        expect do
          subject.call(collection, account)
        end.to raise_error(Mastodon::NotPermittedError)
      end
    end
  end
end
