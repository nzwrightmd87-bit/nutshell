# frozen_string_literal: true

require 'rails_helper'

RSpec.describe SquareWebhookService do
  subject(:service) { described_class.new(request) }

  let(:request) { instance_double(ActionDispatch::Request, body: StringIO.new(payload.to_json), headers: {}) }
  let(:event_id) { 'square-event-1' }
  let(:created_at) { Time.current.iso8601 }
  let(:payload) do
    {
      'event_id' => event_id,
      'type' => 'invoice.payment_made',
      'created_at' => created_at,
      'data' => {
        'object' => {
          'invoice' => {
            'id' => 'invoice-1',
            'subscription_id' => membership.square_subscription_id,
          },
        },
      },
    }
  end
  let!(:user) { Fabricate(:user, disabled: true) }
  let!(:membership) do
    Membership.create!(
      user: user,
      email: user.email,
      plan: 'monthly',
      status: 'past_due',
      square_subscription_id: 'subscription-1'
    )
  end

  describe '#process!' do
    around do |example|
      travel_to Time.zone.local(2026, 5, 6, 12, 0, 0) do
        example.run
      end
    end

    it 'records the Square event before applying membership changes' do
      expect { service.process! }
        .to change(SquareWebhookEvent, :count).by(1)
        .and change { membership.reload.status }.from('past_due').to('active')
        .and change { user.reload.disabled? }.from(true).to(false)

      expect(SquareWebhookEvent.last).to have_attributes(
        event_id: event_id,
        event_type: 'invoice.payment_made',
        event_created_at: Time.zone.parse(created_at)
      )
    end

    it 'ignores a replayed Square event id without reapplying stale membership state' do
      service.process!
      membership.update!(status: 'canceled')
      user.update!(disabled: true)

      expect { described_class.new(request).process! }
        .to not_change(SquareWebhookEvent, :count)
        .and not_change { membership.reload.status }
        .and not_change { user.reload.disabled? }
    end

    context 'with a stale event timestamp' do
      let(:created_at) { 2.days.ago.iso8601 }

      it 'rejects the event before processing membership changes' do
        expect { service.process! }
          .to raise_error(described_class::InvalidEvent, 'Event creation timestamp is too old')

        expect(SquareWebhookEvent.count).to eq(0)
        expect(membership.reload.status).to eq('past_due')
      end
    end

    context 'without an event id' do
      let(:event_id) { nil }

      it 'rejects the event before processing membership changes' do
        expect { service.process! }
          .to raise_error(described_class::InvalidEvent, 'Missing event ID')

        expect(SquareWebhookEvent.count).to eq(0)
        expect(membership.reload.status).to eq('past_due')
      end
    end
  end
end
