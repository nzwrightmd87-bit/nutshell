# frozen_string_literal: true

class AddAccountToCollectionService
  def call(collection, account)
    raise ArgumentError unless collection.local?

    @collection = collection
    @account = account

    raise Mastodon::NotPermittedError, I18n.t('accounts.errors.cannot_be_added_to_collections') unless AccountPolicy.new(@collection.account, @account).feature?

    @collection_item = create_collection_item

    if federate_collection?
      distribute_add_activity if @account.local?
      distribute_feature_request_activity if @account.remote?
    end

    @collection_item
  end

  private

  def federate_collection?
    Mastodon::Feature.collections_federation_enabled? && @collection.discoverable?
  end

  def create_collection_item
    @collection.with_lock do
      ensure_collection_has_capacity!

      @collection.collection_items.create!(
        account: @account,
        state: collection_item_state
      )
    end
  end

  def collection_item_state
    @account.feature_policy_for_account(@collection.account) == :manual ? :pending : :accepted
  end

  def distribute_add_activity
    ActivityPub::AccountRawDistributionWorker.perform_async(add_activity_json, @collection.account_id)
  end

  def ensure_collection_has_capacity!
    return unless @collection.max_items_reached?

    @collection.errors.add(:collection_items, :too_many, count: Collection::MAX_ITEMS)
    raise Mastodon::ValidationError, @collection.errors.full_messages.to_sentence
  end

  def distribute_feature_request_activity
    ActivityPub::FeatureRequestWorker.perform_async(@collection_item.id)
  end

  def add_activity_json
    ActiveModelSerializers::SerializableResource.new(@collection_item, serializer: ActivityPub::AddFeaturedItemSerializer, adapter: ActivityPub::Adapter).to_json
  end
end
