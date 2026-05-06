# frozen_string_literal: true

class CollectionPolicy < ApplicationPolicy
  def index?
    true
  end

  def show?
    visible_to_current_account? && (current_account.nil? || !owner.blocking_or_domain_blocking?(current_account))
  end

  def create?
    user_signed_in?
  end

  def update?
    owner?
  end

  def destroy?
    owner?
  end

  private

  def owner?
    current_account == owner
  end

  def visible_to_current_account?
    record.discoverable? || owner?
  end

  def owner
    record.account
  end
end
