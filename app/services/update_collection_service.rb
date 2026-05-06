# frozen_string_literal: true

class UpdateCollectionService
  UPDATEABLE_PARAMS = %w(name description language sensitive discoverable tag_id).freeze

  def call(collection, params)
    @collection = collection
    @collection.update!(params)

    distribute_update_activity if federate_collection?
  end

  private

  def federate_collection?
    Mastodon::Feature.collections_federation_enabled? && @collection.local? && @collection.discoverable?
  end

  def distribute_update_activity
    return unless relevant_attributes_changed?

    ActivityPub::AccountRawDistributionWorker.perform_async(activity_json, @collection.account.id)
  end

  def activity_json
    ActiveModelSerializers::SerializableResource.new(@collection, serializer: ActivityPub::UpdateFeaturedCollectionSerializer, adapter: ActivityPub::Adapter).to_json
  end

  def relevant_attributes_changed?
    (@collection.saved_changes.keys & UPDATEABLE_PARAMS).any?
  end
end
