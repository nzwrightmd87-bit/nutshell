# frozen_string_literal: true

require 'rails_helper'

RSpec.describe REST::QuoteSerializer do
  subject do
    serialized_record_json(
      quote,
      described_class,
      options: serializer_options
    )
  end

  let(:current_user) { Fabricate(:user) }
  let(:quote) { Fabricate(:quote) }
  let(:serializer_options) do
    {
      scope: current_user,
      scope_name: :current_user,
    }
  end

  context 'with a pending quote' do
    it 'returns expected values' do
      expect(subject.deep_symbolize_keys)
        .to include(
          quoted_status: nil,
          state: 'pending'
        )
    end

    context 'when source is requested for the quoted status owner' do
      let(:serializer_options) { super().merge(source_requested: true, source_status_id: quote.status_id) }

      it 'returns the top-level quoted status id without serializing the status' do
        expect(subject.deep_symbolize_keys)
          .to include(
            quoted_status: nil,
            quoted_status_id: quote.quoted_status_id.to_s,
            state: 'pending'
          )
      end
    end

    context 'when source is requested for a different status' do
      let(:serializer_options) { super().merge(source_requested: true, source_status_id: Fabricate(:status).id) }

      it 'does not return the quoted status id' do
        expect(subject.deep_symbolize_keys)
          .to include(
            quoted_status: nil,
            state: 'pending'
          )
        expect(subject.deep_symbolize_keys)
          .to_not have_key(:quoted_status_id)
      end
    end
  end

  context 'with an accepted quote' do
    let(:quote) { Fabricate(:quote, state: :accepted) }

    it 'returns expected values' do
      expect(subject.deep_symbolize_keys)
        .to include(
          quoted_status: be_a(Hash),
          state: 'accepted'
        )
    end
  end

  context 'with an accepted quote of a deleted post' do
    let(:quote) { Fabricate(:quote, state: :accepted) }

    before do
      quote.quoted_status.destroy!
      quote.reload
    end

    it 'returns expected values' do
      expect(subject.deep_symbolize_keys)
        .to include(
          quoted_status: nil,
          state: 'deleted'
        )
    end
  end

  context 'with an accepted quote of a blocked user' do
    let(:quote) { Fabricate(:quote, state: :accepted) }

    before do
      quote.quoted_account.block!(current_user.account)
    end

    it 'returns expected values' do
      expect(subject.deep_symbolize_keys)
        .to include(
          quoted_status: nil,
          state: 'unauthorized'
        )
    end
  end

  context 'with an accepted quote of a blocked user after a partial relation preload' do
    let(:quoted_account) { Fabricate(:account) }
    let(:top_level_account) { Fabricate(:account) }
    let(:quoted_status) { Fabricate(:status, account: quoted_account, visibility: :public) }
    let(:status) { Fabricate(:status, account: top_level_account, visibility: :public) }
    let(:quote) { Fabricate(:quote, status: status, quoted_status: quoted_status, state: :accepted) }

    before do
      quoted_account.block!(current_user.account)
      current_user.account.preload_relations!([top_level_account.id])
    end

    it 'returns expected values' do
      expect(subject.deep_symbolize_keys)
        .to include(
          quoted_status: nil,
          state: 'unauthorized'
        )
    end
  end

  context 'with a recursive accepted quote' do
    let(:status) { Fabricate(:status) }
    let(:quote) { Fabricate(:quote, status: status, quoted_status: status, state: :accepted) }

    it 'returns expected values' do
      expect(subject.deep_symbolize_keys)
        .to include(
          quoted_status: be_a(Hash),
          state: 'accepted'
        )
    end
  end
end
