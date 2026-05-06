# frozen_string_literal: true

class ActivityPub::DistributionWorker < ActivityPub::RawDistributionWorker
  # Distribute a new status or an edit of a status to all the places
  # where the status is supposed to go or where it was interacted with
  def perform(status_id)
    @status  = Status.find(status_id)
    @account = @status.account

    distribute!
  rescue ActiveRecord::RecordNotFound
    true
  end

  protected

  def inboxes
    @inboxes ||= StatusReachFinder.new(@status).inboxes
  end

  def payload
    @payload ||= Oj.dump(serialize_payload(@status, activity_serializer, serializer_options.merge(signer: @account)))
  end

  def activity_serializer
    @status.reblog? ? ActivityPub::AnnounceNoteSerializer : ActivityPub::CreateNoteSerializer
  end

  def serializer_options
    {}
  end

  def options
    { 'synchronize_followers' => @status.private_visibility? }
  end
end
