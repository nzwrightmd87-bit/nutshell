# frozen_string_literal: true

module DomainControlHelper
  def domain_not_allowed?(uri_or_domain)
    return false if uri_or_domain.blank?

    domain = normalized_domain_for(uri_or_domain)
    return false if domain.blank? || ActivityPub::TagManager.instance.local_domain?(domain)

    return true if federation_disabled?

    if limited_federation_mode?
      !DomainAllow.allowed?(domain)
    else
      DomainBlock.blocked?(domain)
    end
  end

  def limited_federation_mode?
    Rails.configuration.x.mastodon.limited_federation_mode
  end

  def federation_disabled?
    Rails.configuration.x.mastodon.federation_disabled
  end

  private

  def normalized_domain_for(uri_or_domain)
    raw_domain = if uri_or_domain.include?('://')
                   Addressable::URI.parse(uri_or_domain).host
                 else
                   uri_or_domain
                 end

    return if raw_domain.blank?

    ActivityPub::TagManager.instance.normalize_domain(raw_domain)
  rescue Addressable::URI::InvalidURIError, IDN::Idna::IdnaError
    nil
  end
end
