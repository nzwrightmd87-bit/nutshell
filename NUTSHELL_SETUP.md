# Nutshell Local Setup

This repo contains the Nutshell social app in `mastodon/`, built from an upstream fork with Nutshell-specific defaults, branding, membership gating, and BlackEnvelope integration.

## 1. Start local services (Docker dev environment)

From `mastodon/`:

```bash
docker compose -f .devcontainer/compose.yaml up -d
docker compose -f .devcontainer/compose.yaml exec app bin/setup
docker compose -f .devcontainer/compose.yaml exec app bin/dev
```

Open:

- `http://nutshell.localhost:3000`

`nutshell.localhost` resolves locally in modern browsers, so no hosts-file edit is usually needed.

## 2. Login/admin

After setup, use the default admin account created by `bin/setup`:

- Username: `admin@nutshell.localhost` (or `admin@localhost` depending on setup)
- Password: `mastodonadmin`

Change this password immediately in local and production environments.

## 3. Nutshell surfaces already updated

The fork now defaults to Nutshell-specific behavior and presentation in:

- Logos/icons: `app/javascript/images/`
- Default instance title: `config/settings.yml`
- English UI/email copy: `config/locales/en.yml`, `config/locales/en-GB.yml`
- Mailer layout + colors: `app/views/layouts/mailer.html.haml`, `app/javascript/styles/entrypoints/mailer.scss`
- Core theme palette (orange accents): `app/javascript/styles/mastodon/theme/_base.scss`
- Paid membership and billing flow: `app/controllers/billing_controller.rb`, `app/views/billing/`
- BlackEnvelope launch and SSO bridge: `app/controllers/black_envelope_launches_controller.rb`, `app/services/black_envelope/`

## 4. Domain and production

For production, set these public values in the private production environment config (`.env.production`). Do not commit the real production `.env.production`, API keys, webhook secrets, database passwords, SSH details, or server paths.

- `LOCAL_DOMAIN=nutshell.sbs`
- `WEB_DOMAIN=nutshell.sbs` (if you split web domain)
- `LIMITED_FEDERATION_MODE=true` (disables federation unless you explicitly allow domains)
- `INSTANCE_LANDING_PAGE=https://nutshell.sbs`
- `IOS_APP_URL=https://nutshell.sbs`
- `ANDROID_APP_URL=https://nutshell.sbs`
- `BLACK_ENVELOPE_URL=https://app.nutshell.sbs`
- `BLACK_ENVELOPE_INTERNAL_URL=https://app.nutshell.sbs` or the private service URL used inside the production network

Then rebuild assets and restart app/sidekiq/streaming services.

## 5. Quick checks

```bash
rg -n "Nutshell|mastodon" app/views app/helpers config/locales/en.yml config/locales/en-GB.yml config/templates
rg -n -i "nutshell\.localhost|nutshell\.sbs|black.?envelope" app config docs README.md
```

Some internal identifiers/classes still use `mastodon` in code paths and element IDs; that is expected and does not affect user-facing branding.
