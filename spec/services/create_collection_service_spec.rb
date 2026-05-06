# frozen_string_literal: true

require 'rails_helper'

RSpec.describe CreateCollectionService do
  subject { described_class.new }

  let(:author) { Fabricate.create(:account) }

  describe '#call' do
    let(:base_params) do
      {
        name: 'People to follow',
        description: 'All my favourites',
        sensitive: false,
        discoverable: true,
      }
    end

    context 'when given valid parameters' do
      it 'creates a new local collection' do
        collection = nil

        expect do
          collection = subject.call(base_params, author)
        end.to change(Collection, :count).by(1)

        expect(collection).to be_a(Collection)
        expect(collection).to be_local
      end

      it 'federates an `Add` activity', feature: :collections_federation do
        subject.call(base_params, author)

        expect(ActivityPub::AccountRawDistributionWorker).to have_enqueued_sidekiq_job
      end

      context 'when the collection is not discoverable' do
        let(:remote_accounts) { Fabricate.times(2, :remote_account, feature_approval_policy: (0b10 << 16)) }
        let(:params) do
          base_params.merge(
            discoverable: false,
            account_ids: remote_accounts.map { |account| account.id.to_s }
          )
        end

        before do
          remote_accounts.each { |account| author.follow!(account) }
        end

        it 'does not federate collection or feature request activities', feature: :collections_federation do
          subject.call(params, author)

          expect(ActivityPub::AccountRawDistributionWorker).to_not have_enqueued_sidekiq_job
          expect(ActivityPub::FeatureRequestWorker).to_not have_enqueued_sidekiq_job
        end
      end

      context 'when given account ids' do
        let(:accounts) do
          Fabricate.times(2, :account)
        end
        let(:account_ids) { accounts.map { |a| a.id.to_s } }
        let(:params) do
          base_params.merge(account_ids:)
        end

        before do
          accounts.each { |account| author.follow!(account) }
        end

        it 'also creates collection items' do
          expect do
            subject.call(params, author)
          end.to change(CollectionItem, :count).by(2)
        end

        context 'when one account may not be added' do
          before do
            accounts.last.update(discoverable: false)
          end

          it 'raises an error' do
            expect do
              subject.call(params, author)
            end.to raise_error(Mastodon::NotPermittedError)
          end
        end

        context 'when one account is not followed' do
          before do
            author.unfollow!(accounts.last)
          end

          it 'raises an error' do
            expect do
              subject.call(params, author)
            end.to raise_error(Mastodon::NotPermittedError)
          end
        end

        context 'when some accounts are remote' do
          let(:accounts) { Fabricate.times(2, :remote_account, feature_approval_policy: (0b10 << 16)) }

          it 'federates `FeatureRequest` activities', feature: :collections_federation do
            subject.call(params, author)

            expect(ActivityPub::FeatureRequestWorker).to have_enqueued_sidekiq_job.exactly(2).times
          end

          context 'when a remote account only allows manual feature approval' do
            let(:automatic_account) { Fabricate(:remote_account, feature_approval_policy: InteractionPolicy::POLICY_FLAGS[:public] << 16) }
            let(:manual_account) { Fabricate(:remote_account, feature_approval_policy: InteractionPolicy::POLICY_FLAGS[:public]) }
            let(:accounts) { [automatic_account, manual_account] }

            it 'stores manual approvals as pending and excludes them from federated collection JSON', feature: :collections_federation do
              collection = subject.call(params, author)

              expect(collection.collection_items.find_by(account: automatic_account)).to be_accepted
              expect(collection.collection_items.find_by(account: manual_account)).to be_pending

              serialized_collection = serialized_record_json(collection, ActivityPub::FeaturedCollectionSerializer, adapter: ActivityPub::Adapter)
              featured_objects = serialized_collection['orderedItems'].map { |item| item['featuredObject'] }
              expect(featured_objects).to include(ActivityPub::TagManager.instance.uri_for(automatic_account))
              expect(featured_objects).to_not include(ActivityPub::TagManager.instance.uri_for(manual_account))
            end
          end
        end
      end

      context 'when given a tag' do
        let(:params) { base_params.merge(tag_name: '#people') }

        context 'when the tag exists' do
          let!(:tag) { Fabricate.create(:tag, name: 'people') }

          it 'correctly assigns the existing tag' do
            collection = subject.call(params, author)

            expect(collection.tag).to eq tag
          end
        end

        context 'when the tag does not exist' do
          it 'creates a new tag' do
            collection = nil

            expect do
              collection = subject.call(params, author)
            end.to change(Tag, :count).by(1)

            expect(collection.tag.name).to eq 'people'
          end
        end
      end
    end

    context 'when given invalid parameters' do
      it 'raises an exception' do
        expect do
          subject.call({}, author)
        end.to raise_error(ActiveRecord::RecordInvalid)
      end
    end
  end
end
