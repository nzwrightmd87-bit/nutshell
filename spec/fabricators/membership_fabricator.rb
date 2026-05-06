# frozen_string_literal: true

Fabricator(:membership) do
  email { sequence(:email) { |i| "member#{i}@example.com" } }
  plan 'monthly'
  status 'active'
end
