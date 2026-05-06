# frozen_string_literal: true

require 'rails_helper'

RSpec.describe ActivityPub::FeaturedCollectionSerializer do
  include RoutingHelper

  subject { serialized_record_json(collection, described_class, adapter: ActivityPub::Adapter) }

  let(:collection) do
    Fabricate(:collection,
              name: 'Incredible people',
              description: 'These are really amazing',
              tag_name: '#people',
              discoverable: false)
  end
  let!(:collection_items) { Fabricate.times(2, :collection_item, collection:) }
  let!(:pending_collection_item) { Fabricate(:collection_item, collection:, state: :pending) }
  let!(:revoked_collection_item) { Fabricate(:collection_item, collection:, state: :revoked) }

  it 'serializes to the expected structure' do
    expect(subject).to include({
      'type' => 'FeaturedCollection',
      'id' => ActivityPub::TagManager.instance.uri_for(collection),
      'name' => 'Incredible people',
      'summary' => 'These are really amazing',
      'attributedTo' => ActivityPub::TagManager.instance.uri_for(collection.account),
      'sensitive' => false,
      'discoverable' => false,
      'topic' => {
        'href' => match(%r{/tags/people$}),
        'type' => 'Hashtag',
        'name' => '#people',
      },
      'totalItems' => 2,
      'orderedItems' => [
        {
          'id' => ActivityPub::TagManager.instance.uri_for(collection_items.first),
          'type' => 'FeaturedItem',
          'featuredObject' => ActivityPub::TagManager.instance.uri_for(collection_items.first.account),
          'featuredObjectType' => 'Person',
          'featureAuthorization' => ap_account_feature_authorization_url(collection_items.first.account_id, collection_items.first),
        },
        {
          'id' => ActivityPub::TagManager.instance.uri_for(collection_items.last),
          'type' => 'FeaturedItem',
          'featuredObject' => ActivityPub::TagManager.instance.uri_for(collection_items.last.account),
          'featuredObjectType' => 'Person',
          'featureAuthorization' => ap_account_feature_authorization_url(collection_items.last.account_id, collection_items.last),
        },
      ],
      'published' => match_api_datetime_format,
      'updated' => match_api_datetime_format,
    })
  end

  it 'only includes accepted collection items' do
    expect(subject['totalItems']).to eq 2
    expect(subject['orderedItems'].pluck('id'))
      .to_not include(ActivityPub::TagManager.instance.uri_for(pending_collection_item))
      .and not_include(ActivityPub::TagManager.instance.uri_for(revoked_collection_item))
  end

  context 'when a language is set' do
    before do
      collection.language = 'en'
    end

    it 'uses "summaryMap" to include the language' do
      expect(subject).to include({
        'summaryMap' => {
          'en' => 'These are really amazing',
        },
      })

      expect(subject).to_not have_key('summary')
    end
  end
end
