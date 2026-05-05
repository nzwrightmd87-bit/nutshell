# Nutshell

Nutshell is a paid-membership social platform for people who want a quieter social network without ads, engagement bait, or selling user data.

This repository contains the main Nutshell social app. It is built from a heavily customized upstream social-app codebase and adds Nutshell branding, paid memberships, a closed-community posture, custom onboarding, and an integration bridge to BlackEnvelope, the platform's private encrypted messaging and groups app.

Canonical GitHub repository: `https://github.com/dissident5678/nutshell`

<p align="center">
  <img src="./app/javascript/images/logo-stacked.svg?raw=true" alt="Nutshell" width="320" />
</p>

## What Nutshell Is

Nutshell is one platform with two product surfaces:

- `nutshell.sbs`: the main social network, member accounts, profiles, posts, follows, feeds, billing entry point, moderation, and administration.
- `app.nutshell.sbs`: BlackEnvelope, the companion app for end-to-end encrypted direct messages, private groups, topics, and realtime private conversation.

The product idea is simple: members pay directly, so the platform does not need an advertising or data-broker business model. Public social activity happens in Nutshell. Private encrypted conversation happens in BlackEnvelope.

## Who It Is For

Nutshell is intended for members who want:

- A social feed without ads.
- A paid community instead of a surveillance-advertising product.
- Profiles, posts, replies, media, follows, likes, shares, bookmarks, and notifications.
- Moderated community features and account controls.
- A separate E2EE space for private direct messages and private group conversation.
- Clearer privacy boundaries than a typical social network.

It is not intended to be a stock upstream instance or a broad open fediverse server. Federation is disabled or heavily restricted by default in this project.

## Main User Features

Nutshell includes the normal social features members expect:

- Member accounts with email login, passwords, sessions, profile settings, and account preferences.
- Public profile pages with avatar, header image, bio, profile fields, and account metadata.
- Posting with replies, mentions, media attachments, content warnings, sensitive media controls, visibility options, and permalink pages.
- Home timeline from followed accounts.
- Follow/follower relationships and follow requests.
- Likes, shares, bookmarks, lists, filters, muted words, blocks, mutes, and relationship controls.
- Notifications, search, and discovery features where enabled.
- Account export and backup tools inherited from the upstream base.
- Admin and moderation tools for reports, user management, roles, site settings, webhooks, and operational review.

Nutshell also has custom product behavior:

- Logged-out visitors see a custom Nutshell landing page instead of a default upstream explore feed.
- Main feed/discovery routes are routed through the paid/member access model.
- Profile header editing includes a custom rectangular placement editor with drag positioning and zoom.
- UI copy, logos, icons, colors, mailer visuals, and error-page branding are Nutshell-specific.
- Some upstream language has been changed, such as moving key user-facing wording from "favourite" toward "like."
- Post-action icons and parts of the logged-in navigation have been customized.

## Privacy Boundaries

Nutshell has two different privacy models:

- Public/social Nutshell posts are stored by the main Rails app and are not end-to-end encrypted.
- BlackEnvelope messages are encrypted client-side before message content reaches the server.

Use BlackEnvelope for private encrypted direct messages and private group conversations. Do not treat Nutshell posts, replies, mentions, or social direct/private visibility settings as E2EE.

BlackEnvelope still stores metadata needed for routing, delivery, account state, notifications, group membership, abuse handling, and operations. E2EE protects message content, not every possible piece of metadata.

## Paid Memberships

Nutshell uses a paid-membership model instead of advertising.

Current membership behavior includes:

- Monthly and yearly plan configuration through environment variables.
- Billing pages for plan selection, success, and cancellation states.
- Square hosted checkout links when configured.
- Square API fallback for checkout-link creation.
- Verified Square webhooks for subscription lifecycle events.
- A `Membership` model that tracks payment email, status, plan, Square IDs, paid/canceled timestamps, and linked Nutshell user.
- Registration checks that require an active membership matching the signup email.
- Reactivation and disablement behavior tied to verified subscription events.

Important security rule: browser redirects are not proof of payment. Only verified backend webhook/API state should unlock membership access.

## BlackEnvelope Integration

BlackEnvelope is the private messaging and groups layer for Nutshell.

From the Nutshell side, this repository includes:

- A signed single sign-on launch flow.
- Short-lived HMAC integration tokens.
- Background account provisioning.
- Initial-state configuration so the frontend knows where BlackEnvelope lives.
- A sidebar navigation link into BlackEnvelope.
- Unread-count polling for the Nutshell sidebar badge.

BlackEnvelope itself provides the private communication surface:

- E2EE direct messages.
- Friend requests and friend-only direct messaging.
- Private groups.
- Group topics and topic-specific views.
- Group invites.
- Text, media, file, and voice-message support.
- WebSocket realtime updates.
- Push notifications.
- Local browser keypair generation.
- Public-key sync.
- Encrypted key backup and restore with a user passphrase.
- Installable PWA behavior.

The intended boundary is narrow: Nutshell owns identity, membership, and the public social app. BlackEnvelope owns encrypted conversation. The apps should communicate through signed tokens and documented APIs, not by reaching into each other's databases.

## Repository Scope

This GitHub repository contains the Nutshell social app and its BlackEnvelope integration bridge.

Key areas:

- `app/controllers/billing_controller.rb`: membership checkout and billing pages.
- `app/controllers/webhooks/square_controller.rb`: Square webhook entry point.
- `app/services/square_webhook_service.rb`: Square subscription event handling.
- `app/models/membership.rb`: paid-membership state.
- `app/controllers/black_envelope_launches_controller.rb`: BlackEnvelope launch and SSO handoff.
- `app/services/black_envelope/`: integration token, provisioning, unread-count, and configuration services.
- `app/workers/black_envelope_provision_worker.rb`: async BlackEnvelope account provisioning.
- `app/javascript/mastodon/features/navigation_panel/`: logged-in navigation, including the BlackEnvelope entry.
- `app/views/shared/_landing_page.html.haml`: public landing page.
- `app/javascript/styles/mastodon/landing.scss`: landing-page styling.
- `app/views/settings/profiles/show.html.haml`: edit-profile form and header editor.
- `app/javascript/entrypoints/public.tsx`: client-side header placement behavior.
- `config/settings.yml`: default Nutshell instance settings.
- `config/templates/privacy-policy.md`: Nutshell privacy-policy template.
- `config/templates/terms-of-service.md`: Nutshell terms template.
- `.env.production.sample`: public sample configuration names only, not real production secrets.
- `NUTSHELL_SETUP.md`: Nutshell-specific local setup notes.
- `docs/DEVELOPMENT.md`: upstream-style development environment notes updated for Nutshell.

BlackEnvelope service code is managed as a separate companion app in the full platform workspace. This repository should not expose BlackEnvelope production secrets, databases, runtime files, or deployment credentials.

## Technical Stack

Nutshell is still fundamentally a Rails-based application derived from the upstream social stack:

- Ruby on Rails for web and API requests.
- React and TypeScript for the logged-in frontend.
- Vite for frontend bundling.
- PostgreSQL for primary social data.
- Redis for cache and queue state.
- Sidekiq for background jobs.
- Node.js streaming service for realtime timeline/notification behavior.
- Action Mailer with SMTP or Resend-style delivery.
- Square for paid membership checkout and subscription lifecycle.
- S3-compatible object storage for uploaded media when enabled.
- Docker/devcontainer workflows for repeatable local development.

## Local Development

From the repository root, use the Nutshell setup guide:

```bash
docker compose -f .devcontainer/compose.yaml up -d
docker compose -f .devcontainer/compose.yaml exec app bin/setup
docker compose -f .devcontainer/compose.yaml exec app bin/dev
```

Then open:

```text
http://nutshell.localhost:3000
```

See:

- `NUTSHELL_SETUP.md`
- `docs/DEVELOPMENT.md`

Do not use real production secrets for local development. Use local `.env` values, sample placeholders, and test credentials only.

## Configuration

The sample production environment file documents the public shape of configuration without including secrets.

Important configuration areas:

- `LOCAL_DOMAIN`
- `LIMITED_FEDERATION_MODE`
- `DISABLE_FEDERATION`
- `PAID_MEMBERSHIPS_*`
- `SQUARE_*`
- `RESEND_*`
- `SMTP_*`
- `BLACK_ENVELOPE_URL`
- `BLACK_ENVELOPE_INTERNAL_URL`
- `BLACK_ENVELOPE_SSO_SECRET`
- PostgreSQL, Redis, storage, Rails, and web-push settings

Never commit a real production `.env.production`, API key, webhook secret, database password, OAuth file, private key, SSH detail, server path, or deployment credential.

## Federation Posture

Nutshell is configured as a closed or limited-membership platform, not as a normal open federated server.

The current product direction includes:

- Limited federation mode by default.
- Optional full federation shutdown through configuration.
- Authenticated access for main live feed surfaces.
- Logged-out routing toward the custom landing page.
- Public permalink-style pages where appropriate.
- Privacy copy that tells members this service is not distributing content to external servers.

Any work touching ActivityPub, WebFinger, remote follows, remote delivery, public timelines, discovery APIs, or federation settings should be reviewed against this product direction before merging.

## Security Principles

Security-sensitive rules for this project:

- Do not commit secrets.
- Do not paste production secrets into issues, chats, docs, screenshots, or AI prompts.
- Do not unlock paid access based only on frontend redirects.
- Verify Square webhook signatures before processing billing events.
- Keep BlackEnvelope SSO tokens short-lived and signed.
- Keep BlackEnvelope and Nutshell data stores separate unless there is a deliberate architecture migration.
- Do not expose PostgreSQL, Redis, app internals, streaming internals, or admin-only services publicly.
- Do not treat BlackEnvelope as formally audited cryptography.
- Review any deployment or infrastructure document before sharing it outside the core team.

If a secret is ever committed or shared, rotate it.

## Development Rules

When changing this project:

- Prefer repo-first changes so the Docker environment remains reproducible.
- Keep runtime-only changes clearly documented.
- Do not overwrite Nutshell customizations with stock upstream behavior.
- Do not pull/rebase from upstream without a deliberate migration plan.
- Run the narrowest meaningful validation for the files changed.
- Update project progress notes in the full workspace when work is performed there.

Useful validation examples:

- Rails/Ruby changes: relevant specs or Ruby syntax checks in the project container.
- Frontend changes: ESLint/TypeScript checks for affected files.
- HAML/view changes: boot/render the affected route where practical.
- Environment/docs-only changes: targeted `rg` checks and careful diff review.

## What This README Does Not Include

This README intentionally avoids:

- Production server access details.
- SSH commands, usernames, IP addresses, private server paths, or deployment hostnames beyond public domains.
- Real `.env` values.
- API keys, webhook secrets, Square identifiers, checkout URLs, S3 keys, OAuth credentials, or private tokens.
- Database dumps, backups, generated tokens, private keys, or runtime cache details.

It should be safe to show to a prospective contributor or a technical user who needs to understand what Nutshell is without giving them access to production infrastructure.

## License

This project is licensed under AGPLv3. See `LICENSE`.
