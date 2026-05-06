# frozen_string_literal: true

require 'rails_helper'

RSpec.describe 'Api::V1Alpha::Collections', feature: :collections do
  include_context 'with API authentication', oauth_scopes: 'read:collections write:collections'

  describe 'GET /api/v1_alpha/accounts/:account_id/collections' do
    subject do
      get "/api/v1_alpha/accounts/#{account.id}/collections", headers: headers, params: params
    end

    let(:params) { {} }

    let(:account) { Fabricate(:account) }

    before { Fabricate.times(3, :collection, account:) }

    it 'returns all collections for the given account and http success' do
      subject

      expect(response).to have_http_status(200)
      expect(response.parsed_body[:collections].size).to eq 3
    end

    context 'with limit param' do
      let(:params) { { limit: '1' } }

      it 'returns only a single result' do
        subject

        expect(response).to have_http_status(200)
        expect(response.parsed_body[:collections].size).to eq 1

        expect(response)
          .to include_pagination_headers(
            next: api_v1_alpha_account_collections_url(account, limit: 1, offset: 1)
          )
      end
    end

    context 'with limit and offset params' do
      let(:params) { { limit: '1', offset: '1' } }

      it 'returns the correct result and headers' do
        subject

        expect(response).to have_http_status(200)
        expect(response.parsed_body[:collections].size).to eq 1

        expect(response)
          .to include_pagination_headers(
            prev: api_v1_alpha_account_collections_url(account, limit: 1, offset: 0),
            next: api_v1_alpha_account_collections_url(account, limit: 1, offset: 2)
          )
      end
    end

    context 'when some collections are not discoverable' do
      before do
        Fabricate(:collection, account:, discoverable: false)
      end

      context 'when requesting user is a third party' do
        it 'hides the collections that are not discoverable' do
          subject

          expect(response).to have_http_status(200)
          expect(response.parsed_body[:collections].size).to eq 3
        end

        context 'with a limit matching the number of discoverable collections' do
          let(:params) { { limit: '3' } }

          it 'does not expose hidden collections through pagination headers' do
            subject

            expect(response).to have_http_status(200)
            expect(response.headers['Link']).to be_blank
          end
        end
      end

      context 'when requesting user owns the collection' do
        let(:account) { user.account }

        it 'returns all collections, including the ones that are not discoverable' do
          subject

          expect(response).to have_http_status(200)
          expect(response.parsed_body[:collections].size).to eq 4
        end
      end
    end

    context 'when the requesting user is blocked by the given account' do
      before do
        account.block!(user.account)
      end

      it 'returns an empty array' do
        subject

        expect(response).to have_http_status(200)
        expect(response.parsed_body[:collections]).to eq []
      end
    end
  end

  describe 'GET /api/v1_alpha/collections/:id' do
    subject do
      get "/api/v1_alpha/collections/#{collection.id}", headers: headers
    end

    let(:collection) { Fabricate(:collection) }
    let!(:items) { Fabricate.times(2, :collection_item, collection:) }

    shared_examples 'unfiltered, successful request' do
      it 'includes all items in the response' do
        subject

        expect(response).to have_http_status(200)
        expect(response.parsed_body[:collection][:items].size).to eq 2
      end
    end

    context 'when user is not signed in' do
      let(:headers) { {} }

      it_behaves_like 'unfiltered, successful request'

      context 'when the collection is not discoverable' do
        let(:collection) { Fabricate(:collection, discoverable: false) }

        it 'returns http forbidden' do
          subject

          expect(response).to have_http_status(403)
        end
      end
    end

    context 'when user is signed in' do
      context 'when the user has not blocked or muted anyone' do
        it_behaves_like 'unfiltered, successful request'
      end

      context 'when the user has blocked an account' do
        before do
          user.account.block!(items.first.account)
        end

        it 'only includes the non-blocked account in the response and side-loaded accounts' do
          subject

          expect(response).to have_http_status(200)
          expect(response.parsed_body[:collection][:items].size).to eq 1
          expect(response.parsed_body[:collection][:items][0]['id']).to eq items.last.id.to_s
          expect(response.parsed_body[:accounts].pluck('id'))
            .to contain_exactly(collection.account_id.to_s, items.last.account_id.to_s)
        end
      end

      context 'when the collection has a pending item with an account' do
        let!(:pending_item) { Fabricate(:collection_item, collection:, account: Fabricate(:account), state: :pending) }

        it 'does not side-load the pending item account' do
          subject

          pending_item_json = response.parsed_body[:collection][:items].find do |item|
            item['id'] == pending_item.id.to_s
          end

          expect(response).to have_http_status(200)
          expect(pending_item_json).to include('state' => 'pending')
          expect(pending_item_json).to_not have_key('account_id')
          expect(response.parsed_body[:accounts].pluck('id'))
            .to contain_exactly(collection.account_id.to_s, *items.map { |item| item.account_id.to_s })
        end
      end

      context 'when the collection is not discoverable and belongs to another account' do
        let(:collection) { Fabricate(:collection, discoverable: false) }

        it 'returns http forbidden' do
          subject

          expect(response).to have_http_status(403)
        end
      end

      context 'when the collection is not discoverable and belongs to the user' do
        let(:collection) { Fabricate(:collection, account: user.account, discoverable: false) }

        it_behaves_like 'unfiltered, successful request'
      end
    end
  end

  describe 'POST /api/v1_alpha/collections' do
    subject do
      post '/api/v1_alpha/collections', headers: headers, params: params
    end

    let(:params) { {} }

    it_behaves_like 'forbidden for wrong scope', 'read'

    context 'with valid params' do
      let(:params) do
        {
          name: 'Low-traffic bots',
          description: 'Really nice bots, please follow',
          language: 'en',
          sensitive: '0',
          discoverable: '1',
        }
      end

      it 'creates a collection and returns http success' do
        expect do
          subject
        end.to change(Collection, :count).by(1)

        expect(response).to have_http_status(200)
      end

      context 'with followed account ids' do
        let(:target_account) { Fabricate(:account) }
        let(:params) { super().merge(account_ids: [target_account.id]) }

        before do
          user.account.follow!(target_account)
        end

        it 'creates collection items' do
          expect do
            subject
          end.to change(CollectionItem, :count).by(1)

          expect(response).to have_http_status(200)
        end
      end

      context 'with account ids the user does not follow' do
        let(:target_account) { Fabricate(:account) }
        let(:params) { super().merge(account_ids: [target_account.id]) }

        it 'returns http forbidden' do
          expect do
            subject
          end.to_not change(Collection, :count)

          expect(response).to have_http_status(403)
        end
      end
    end

    context 'with invalid params' do
      it 'returns http unprocessable content and detailed errors' do
        expect do
          subject
        end.to_not change(Collection, :count)

        expect(response).to have_http_status(422)
        expect(response.parsed_body).to include({
          'error' => a_hash_including({
            'details' => a_hash_including({
              'name' => [{ 'error' => 'ERR_BLANK', 'description' => "can't be blank" }],
              'description' => [{ 'error' => 'ERR_BLANK', 'description' => "can't be blank" }],
            }),
          }),
        })
      end
    end
  end

  describe 'PATCH /api/v1_alpha/collections/:id' do
    subject do
      patch "/api/v1_alpha/collections/#{collection.id}", headers: headers, params: params
    end

    let(:collection) { Fabricate(:collection) }
    let(:params) { {} }

    context 'when user is not owner' do
      it 'returns http forbidden' do
        subject

        expect(response).to have_http_status(403)
      end
    end

    context 'when user is the owner' do
      let(:collection) do
        Fabricate(:collection,
                  account: user.account,
                  name: 'Pople to follow',
                  description: 'Cool pople',
                  sensitive: true,
                  discoverable: false)
      end

      it_behaves_like 'forbidden for wrong scope', 'read:collections'

      context 'with valid params' do
        let(:params) do
          {
            name: 'People to follow',
            description: 'Cool people',
            sensitive: '0',
            discoverable: '1',
          }
        end

        it 'updates the collection and returns http success' do
          subject
          collection.reload

          expect(response).to have_http_status(200)
          expect(collection.name).to eq 'People to follow'
          expect(collection.description).to eq 'Cool people'
          expect(collection.sensitive).to be false
          expect(collection.discoverable).to be true
        end
      end

      context 'with invalid params' do
        let(:params) { { name: '' } }

        it 'returns http unprocessable content and detailed errors' do
          subject

          expect(response).to have_http_status(422)
          expect(response.parsed_body).to include({
            'error' => a_hash_including({
              'details' => a_hash_including({
                'name' => [{ 'error' => 'ERR_BLANK', 'description' => "can't be blank" }],
              }),
            }),
          })
        end
      end
    end
  end

  describe 'DELETE /api/v1_alpha/collections/:id' do
    subject do
      delete "/api/v1_alpha/collections/#{collection.id}", headers: headers
    end

    let(:collection) { Fabricate(:collection) }

    context 'when user is not owner' do
      it 'returns http forbidden' do
        subject

        expect(response).to have_http_status(403)
      end
    end

    context 'when user is the owner' do
      let(:collection) { Fabricate(:collection, account: user.account) }

      it_behaves_like 'forbidden for wrong scope', 'read:collections'

      it 'deletes the collection and returns http success' do
        collection

        expect { subject }.to change(Collection, :count).by(-1)

        expect(response).to have_http_status(200)
      end
    end
  end
end
