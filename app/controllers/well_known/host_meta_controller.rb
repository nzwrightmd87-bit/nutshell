# frozen_string_literal: true

module WellKnown
  class HostMetaController < ActionController::Base # rubocop:disable Rails/ApplicationController
    include RoutingHelper

    before_action :reject_federation_if_disabled!

    def show
      @webfinger_template = "#{webfinger_url}?resource={uri}"
      expires_in 3.days, public: true

      respond_to do |format|
        format.any do
          render content_type: 'application/xrd+xml', formats: [:xml]
        end

        format.json do
          render json: {
            links: [
              {
                rel: 'lrdd',
                template: @webfinger_template,
              },
            ],
          }
        end
      end
    end

    private

    def reject_federation_if_disabled!
      head :not_found if Rails.configuration.x.mastodon.federation_disabled
    end
  end
end
