# frozen_string_literal: true

class BlackEnvelopeProvisionWorker
  include Sidekiq::Worker

  sidekiq_options queue: 'default', retry: 10, dead: false

  def perform(user_id)
    user = User.find_by(id: user_id)
    return true if user.nil?

    BlackEnvelope::ProvisionAccountService.new.call(user)
  end
end
