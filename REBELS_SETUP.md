# Rebels Local Setup

This repo now contains a branded Mastodon fork in `mastodon/` with Rebels defaults.

## 1. Start local services (Docker dev environment)

From `mastodon/`:

```bash
docker compose -f .devcontainer/compose.yaml up -d
docker compose -f .devcontainer/compose.yaml exec app bin/setup
docker compose -f .devcontainer/compose.yaml exec app bin/dev
```

Open:

- `http://rebels.localhost:3000`

`rebels.localhost` resolves locally in modern browsers, so no hosts-file edit is usually needed.

## 2. Login/admin

After setup, use the default admin account created by `bin/setup`:

- Username: `admin@rebels.localhost` (or `admin@localhost` depending on setup)
- Password: `mastodonadmin`

Change this password immediately in local and production environments.

## 3. Branding surfaces already updated

The fork now defaults to Rebels branding in:

- Logos/icons: `app/javascript/images/`
- Default instance title: `config/settings.yml`
- English UI/email copy: `config/locales/en.yml`, `config/locales/en-GB.yml`
- Mailer layout + colors: `app/views/layouts/mailer.html.haml`, `app/javascript/styles/entrypoints/mailer.scss`
- Core theme palette (orange accents): `app/javascript/styles/mastodon/theme/_base.scss`

## 4. Domain and production

For your VPS at `rebels.sbs`, set these in production environment config (`.env.production`):

- `LOCAL_DOMAIN=rebels.sbs`
- `WEB_DOMAIN=rebels.sbs` (if you split web domain)
- `LIMITED_FEDERATION_MODE=true` (disables federation unless you explicitly allow domains)
- `INSTANCE_LANDING_PAGE=https://rebels.sbs`
- `IOS_APP_URL=https://rebels.sbs`
- `ANDROID_APP_URL=https://rebels.sbs`

Then rebuild assets and restart app/sidekiq/streaming services.

## 5. Quick check for leftover branding text

```bash
rg -n "Mastodon|mastodon" app/views app/helpers config/locales/en.yml config/locales/en-GB.yml config/templates
```

Some internal identifiers/classes still use `mastodon` in code paths and element IDs; that is expected and does not affect user-facing branding.
