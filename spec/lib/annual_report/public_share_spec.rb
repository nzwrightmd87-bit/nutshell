# frozen_string_literal: true

require 'rails_helper'

RSpec.describe AnnualReport::PublicShare do
  describe '#data' do
    subject(:public_share) { described_class.new(generated_annual_report) }

    let(:account) { Fabricate(:account) }
    let(:year) { Time.zone.now.year }
    let(:public_tag) { Fabricate(:tag) }
    let(:private_tag) { Fabricate(:tag) }
    let(:public_status) { Fabricate(:status, account: account) }
    let(:second_public_status) { Fabricate(:status, account: account) }
    let(:unlisted_status) { Fabricate(:status, account: account, visibility: :unlisted) }
    let(:private_status) { Fabricate(:status, account: account, visibility: :private) }
    let(:direct_status) { Fabricate(:status, account: account, visibility: :direct) }
    let(:limited_status) { Fabricate(:status, account: account, visibility: :limited) }
    let(:generated_annual_report) do
      Fabricate(
        :generated_annual_report,
        account: account,
        year: year,
        data: {
          archetype: 'oracle',
          time_series: [{ month: 12, statuses: 6, followers: 0 }],
          top_hashtags: [{ name: private_tag.name, count: 3 }],
          top_statuses: {
            by_reblogs: private_status.id.to_s,
            by_favourites: nil,
            by_replies: nil,
          },
        }
      )
    end

    before do
      public_status.tags << public_tag
      second_public_status.tags << public_tag

      private_status.tags << private_tag
      direct_status.tags << private_tag
      limited_status.tags << private_tag

      public_status.status_stat.update!(reblogs_count: 10)
      private_status.status_stat.update!(reblogs_count: 100)
      direct_status.status_stat.update!(reblogs_count: 100)
      limited_status.status_stat.update!(reblogs_count: 100)

      unlisted_status
    end

    it 'recomputes share data from public and unlisted statuses only' do
      data = public_share.data.deep_symbolize_keys

      expect(data)
        .to include(
          time_series: contain_exactly(include(month: 12, statuses: 3)),
          top_hashtags: contain_exactly(name: public_tag.name, count: 2),
          top_statuses: include(by_reblogs: public_status.id.to_s)
        )
    end

    it 'uses public-safe top status ids for presenter preloading' do
      expect(public_share.status_ids)
        .to contain_exactly(public_status.id.to_s)
    end

    it 'serializes as the current annual report schema' do
      expect(public_share.schema_version)
        .to eq AnnualReport::SCHEMA
    end

    it 'serializes through the annual reports serializer' do
      payload = ActiveModelSerializers::SerializableResource.new(
        AnnualReportsPresenter.new([public_share]),
        serializer: REST::AnnualReportsSerializer,
        scope: nil,
        scope_name: :current_user
      ).as_json.deep_symbolize_keys

      expect(payload.dig(:annual_reports, 0, :data))
        .to include(
          time_series: contain_exactly(include(statuses: 3)),
          top_hashtags: contain_exactly(name: public_tag.name, count: 2)
        )
      expect(payload[:statuses].pluck(:id))
        .to contain_exactly(public_status.id.to_s)
    end
  end
end
