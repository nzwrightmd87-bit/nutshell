# frozen_string_literal: true

require 'rails_helper'

RSpec.describe ActivityPub::Parser::PollParser do
  describe '#valid?' do
    it 'accepts array poll options' do
      parser = described_class.new({
        'type' => 'Question',
        'oneOf' => [
          { 'type' => 'Note', 'name' => 'Foo', 'replies' => { 'type' => 'Collection', 'totalItems' => 4 } },
          { 'type' => 'Note', 'name' => 'Bar', 'replies' => { 'type' => 'Collection', 'totalItems' => 3 } },
        ],
      })

      expect(parser).to be_valid
      expect(parser.options).to eq %w(Foo Bar)
      expect(parser.cached_tallies).to eq [4, 3]
    end

    it 'rejects non-array poll option containers without raising' do
      [
        { 'type' => 'Question', 'oneOf' => 'not an array' },
        { 'type' => 'Question', 'anyOf' => 1 },
        { 'type' => 'Question', 'anyOf' => true },
        { 'type' => 'Question', 'oneOf' => { 'name' => 'Foo' } },
      ].each do |json|
        expect(described_class.new(json)).to_not be_valid
      end
    end

    it 'ignores malformed option entries without raising' do
      parser = described_class.new({
        'type' => 'Question',
        'oneOf' => [
          { 'type' => 'Note', 'name' => 'Foo', 'replies' => { 'type' => 'Collection', 'totalItems' => 4 } },
          'not an option',
          1,
        ],
      })

      expect(parser).to be_valid
      expect(parser.options).to eq ['Foo']
      expect(parser.cached_tallies).to eq [4]
    end
  end
end
