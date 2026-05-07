# frozen_string_literal: true

require 'rails_helper'

RSpec.describe RevokeCollectionItemService do
  subject { described_class.new }

  let(:collection_item) { Fabricate(:collection_item) }

  it 'revokes the collection item and sends a Delete activity' do
    expect { subject.call(collection_item) }
      .to change { collection_item.reload.state }.from('accepted').to('revoked')
  end

  context 'when the collection is remote', feature: :collections_federation do
    let(:collection_owner) { Fabricate(:remote_account, inbox_url: 'https://remote.example/inbox') }
    let(:collection) { Fabricate(:remote_collection, account: collection_owner) }
    let(:account) { Fabricate(:account) }
    let(:collection_item) { Fabricate(:collection_item, collection:, account:, uri: 'https://example.com') }

    it 'delivers a `Delete` activity to the collection owner as the revoking account' do
      expect { subject.call(collection_item) }
        .to enqueue_sidekiq_job(ActivityPub::DeliveryWorker).with(
          match_json_values(
            type: 'Delete',
            actor: ActivityPub::TagManager.instance.uri_for(account),
            object: include(
              type: 'FeatureAuthorization',
              interactionTarget: ActivityPub::TagManager.instance.uri_for(account),
              interactingObject: ActivityPub::TagManager.instance.uri_for(collection)
            )
          ),
          account.id,
          collection_owner.inbox_url
        )
    end

    context 'when the collection is not discoverable' do
      let(:collection) { Fabricate(:remote_collection, discoverable: false) }

      it 'does not federate a `Delete` activity' do
        subject.call(collection_item)

        expect(ActivityPub::DeliveryWorker).to_not have_enqueued_sidekiq_job
      end
    end
  end
end
