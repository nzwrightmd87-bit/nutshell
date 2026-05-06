# frozen_string_literal: true

class AnnualReport::PublicShare
  delegate :account, :account_id, :year, :share_key, to: :@report

  def self.model_name
    GeneratedAnnualReport.model_name
  end

  def initialize(report)
    @report = report
  end

  def read_attribute_for_serialization(attribute)
    public_send(attribute)
  end

  def schema_version
    AnnualReport::SCHEMA
  end

  def data
    @data ||= AnnualReport.new(account, year).public_share_data
  end

  def account_ids
    [account_id]
  end

  def status_ids
    data.fetch(:top_statuses, {}).values.compact
  end
end
