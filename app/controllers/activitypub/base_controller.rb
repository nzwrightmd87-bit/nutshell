# frozen_string_literal: true

class ActivityPub::BaseController < Api::BaseController
  include SignatureVerification
  include AccountOwnedConcern

  before_action :reject_federation_if_disabled!

  skip_before_action :require_authenticated_user!
  skip_before_action :require_not_suspended!
  skip_around_action :set_locale

  private

  def skip_temporary_suspension_response?
    false
  end
end
