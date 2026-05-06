# frozen_string_literal: true

class REST::QuoteSerializer < REST::BaseQuoteSerializer
  attribute :quoted_status_id, if: :source_requested_quoted_status

  has_one :quoted_status, serializer: REST::ShallowStatusSerializer

  def quoted_status_id
    source_requested_quoted_status.id.to_s
  end

  private

  def source_requested_quoted_status
    return unless instance_options[:source_requested] &&
                  !instance_options[:source_status_id].nil? &&
                  object.status_id.to_s == instance_options[:source_status_id].to_s &&
                  !object.accepted? &&
                  quoted_status_visible?

    object.quoted_status
  end
end
