# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'Admin Collections' do
  describe 'GET /admin/accounts/:account_id/collections/:id' do
    let(:collection) { Fabricate(:collection) }

    context 'when signed in as an admin' do
      before do
        sign_in Fabricate(:admin_user)
      end

      it 'returns success' do
        get admin_account_collection_path(collection.account_id, collection)

        expect(response)
          .to have_http_status(200)
      end
    end

    context 'when signed in as a moderator' do
      before do
        sign_in Fabricate(:moderator_user)
      end

      it 'returns success' do
        get admin_account_collection_path(collection.account_id, collection)

        expect(response)
          .to have_http_status(200)
      end
    end

    context 'when not signed in' do
      it 'returns forbidden' do
        get admin_account_collection_path(collection.account_id, collection)

        expect(response)
          .to have_http_status(403)
      end
    end

    context 'when signed in as a regular user' do
      before do
        sign_in Fabricate(:user)
      end

      it 'returns forbidden' do
        get admin_account_collection_path(collection.account_id, collection)

        expect(response)
          .to have_http_status(403)
      end
    end
  end
end
