# BlackEnvelope — Progress Log

> Running log of changes made and deployed during AI-assisted sessions.
> Most recent entries at the top.
> Source extracted into the Nutshell workspace on 2026-03-15 for DigitalOcean preparation.
> Legacy entries below refer to the archived Hostinger deployment history and should not be used as deployment instructions for Nutshell.

---

## Session — 2026-03-15 (Archive Extraction + DigitalOcean Prep)

### Summary
- Extracted a clean working tree from `BlackEnvelope.zip` without copying production secrets, runtime databases, or desktop build artifacts into the repo.
- Replaced the old Traefik/Hostinger deployment surface with a Docker Compose + Caddy baseline for a fresh DigitalOcean droplet.
- Updated setup docs and agent instructions to keep the live legacy VPS out of scope for this workspace.

### Changes Made
- Clean source extracted into the workspace under `black_envelope/BlackEnvelope/`.
- Deployment files updated for Docker Compose on a new droplet, including a new `Caddyfile` and a sanitized `.env.example`.
- README/setup guidance rewritten around local development plus DigitalOcean deployment.
- Frontend install instructions now use the current host dynamically instead of a hardcoded old domain.

### Validation
- `docker compose --env-file .env.example config` passed for `deployment/e2ee_chat/docker-compose.yml`.
- `docker compose --env-file .env.example build black-envelope` passed.
- `node --check web/e2ee_chat/app.js` passed.
- `python3 -m py_compile execution/e2ee_chat_server.py execution/run_e2ee_chat_dev.py execution/smoke_test_e2ee_chat.py` passed.

### Deployed to VPS?
- No. This session intentionally avoided the legacy Hostinger VPS.

## Session — 2026-03-08 (Automatic Update Hardening: Web + Home Screen App)

### Summary
- Hardened update propagation so frontend deploys are picked up automatically on both browser and installed home-screen app.
- Removed app-shell HTTP caching at server level and tightened service-worker update checks.

### Changes Made
- Backend (`execution/e2ee_chat_server.py`):
  - Added middleware to set strict no-cache headers for app-shell assets (`/`, `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, and `*.html/js/css`).
  - Header policy now forces revalidation/no-store for app shell to prevent stale JS/CSS/HTML on client devices.
- Frontend service worker (`web/e2ee_chat/sw.js`):
  - Bumped runtime cache name to `blackenvelope-runtime-v14` to invalidate previous runtime cache.
  - Updated app-shell `networkFirst` fetch to use `cache: "no-store"` so network requests bypass HTTP cache.
- Frontend app bootstrap (`web/e2ee_chat/app.js`):
  - Registers service worker with `updateViaCache: "none"` so SW script checks bypass HTTP cache.
  - Increased update-check frequency from 5 minutes to 60 seconds.
  - Added SW update checks on app focus, online transition, and visibility return.

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `node --check web/e2ee_chat/sw.js` passed
- `python3 -m py_compile execution/e2ee_chat_server.py` passed

### Deployed to VPS?
- Yes — synced backend/frontend/progress files and rebuilt only `cypher-chat`.

## Session — 2026-03-08 (Admin Users: Dedicated Page + Hash Route)

### Summary
- Replaced the admin Manage Users popup with a dedicated full-screen in-app page.
- Added hash-route navigation for Admin Users (`#/admin/users`) with browser back/forward support.
- Added a Back button on the page to return to the prior app view.

### Changes Made
- Frontend (`web/e2ee_chat/index.html`):
  - Added a dedicated `#adminUsersPage` section with page header, title, back button, and body container.
- Frontend (`web/e2ee_chat/styles.css`):
  - Added layout/styling for the admin users page (desktop + mobile), including list/action spacing and page-level states.
- Frontend (`web/e2ee_chat/app.js`):
  - Added admin users hash-route helpers and route sync flow (`#/admin/users`) while preserving reset-password hash behavior.
  - Replaced modal-based Manage Users rendering with dedicated page rendering/loading/error states.
  - Kept existing admin actions unchanged: grant/revoke free access and remove user.
  - Wired Manage Users settings button to route navigation and wired page Back button to history-based return behavior with fallback.
  - Added non-admin route guard with error toast + route cleanup.
  - Ensured auth/logout/app lifecycle keeps page visibility and hash route in sync.

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `node --check web/e2ee_chat/sw.js` passed

### Deployed to VPS?
- Yes — synced `index.html`, `styles.css`, `app.js`, and `PROGRESS.md`, then rebuilt only `cypher-chat`.

## Session — 2026-03-08 (Group Join Divider in Feeds)

### Summary
- Added a gray join divider row in group feeds, including BlackEnvelope Feed.
- Divider text format: `@username joined the group` with horizontal lines across the feed.

### Changes Made
- Frontend (`web/e2ee_chat/app.js`):
  - Preserved member `joined_at` values in group context state.
  - Added synthetic `group_member_joined` render rows from group member join timestamps.
  - Merged system rows into the group `All` timeline with deterministic chronological sorting.
  - Added a renderer branch to display join rows as full-width feed dividers.
- Frontend (`web/e2ee_chat/styles.css`):
  - Added `.group-join-banner` styles for the gray divider appearance.

### Validation
- `node --check web/e2ee_chat/app.js` passed

### Deployed to VPS?
- Yes — synced updated frontend + progress log and rebuilt only `cypher-chat`.

### Issues / Notes
- Join divider rows are shown in group `All` feed view (not per-topic filtered views).
- Divider rows are derived from member `joined_at` timestamps, so they appear for existing and new members.

## Session — 2026-03-04 (Automatic Frontend Update Rollout, No Manual Cache Clearing)

### Summary
- Reduced stale-frontend issues so users do not need manual cache clears after normal app updates.
- Changed service-worker strategy to prioritize fresh app shell code (`index/html/js/css`) from network while still caching static media/icons.
- Added automatic service-worker update checks and immediate activation/reload flow.

### Changes Made
- Frontend service worker (`web/e2ee_chat/sw.js`):
  - Replaced cache-first app-shell behavior with **network-first** for navigation + `*.html` + `*.js` + `*.css`.
  - Kept cache-first behavior for static media/icon assets.
  - Added message handler for `SKIP_WAITING`.
  - Retained install/activate cache cleanup and push notification handling.
- Frontend app bootstrap (`web/e2ee_chat/app.js`):
  - Enhanced SW registration flow:
    - immediate `reg.update()` check on load
    - periodic update checks every 5 minutes
    - auto-promote waiting worker via `SKIP_WAITING`
    - reload page on `controllerchange` once to apply new code quickly

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `node --check web/e2ee_chat/sw.js` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed

### Deployed to VPS?
- Yes — synced updated frontend + progress log and rebuilt only `cypher-chat`.

## Session — 2026-03-04 (Notifications Infinite Scroll: 10-at-a-time)

### Summary
- Added notification pagination + infinite scroll in the bell dropdown.
- Notifications now load in pages of 10: first 10 on open, then next 10 when scrolling near the bottom.

### Changes Made
- Backend (`execution/e2ee_chat_server.py`):
  - Updated `GET /api/notifications` to support:
    - `limit` query param (capped safely)
    - `before_id` cursor for older pages
  - Added pagination payload:
    - `pagination.has_more`
    - `pagination.next_before_id`
  - Switched notification page ordering to `id DESC` for stable cursor paging.
  - `unread_count` now comes from a dedicated unread-count query (global unread total).
- Frontend (`web/e2ee_chat/app.js`):
  - Added notification paging state (`notificationRows`, `notificationHasMore`, `notificationNextBeforeId`, `notificationLoading`).
  - Added `NOTIFICATION_PAGE_LIMIT = 10`.
  - Added paged loader + renderer for dropdown notifications.
  - Added scroll listener on `#notificationDropdownList` to auto-load older pages near bottom.
  - Kept local friend-request/group-invite notifications merged into the same bell list.
  - Mark-as-read actions now update in-memory notification row state before re-render.

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `python3 -m py_compile execution/e2ee_chat_server.py` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed

### Deployed to VPS?
- Yes — synced updated frontend/backend/progress files and rebuilt only `cypher-chat`.

## Session — 2026-03-04 (Auto-Scroll to Latest Message on Open)

### Summary
- Fixed intermittent chat/group open position where the view could land midway instead of at the latest message.
- Kept existing scroll/pagination behavior intact (older-message loading and manual scrolling unchanged).

### Changes Made
- Frontend (`web/e2ee_chat/app.js`):
  - Added `scrollMessagesAreaToBottom(area)` helper.
  - Added `scheduleMessagesAreaBottomLock(area)` helper.
  - Updated message rendering to use bottom-lock scheduling when `stickToBottom` is requested.
  - Bottom-lock now reapplies after async media/layout events (`requestAnimationFrame`, delayed passes, and media metadata/load events), so the view reliably lands on newest messages on initial open.

### Validation
- `node --check web/e2ee_chat/app.js` passed

### Deployed to VPS?
- No (local change only)

## Session — 2026-03-03 (Duplicate Send Prevention)

### Summary
- Fixed duplicate message sends caused by rapid repeated taps/Enter while the first send was still in-flight.
- Added a client-side send lock so only one send request can run at a time from the composer.

### Changes Made
- Frontend (`web/e2ee_chat/app.js`):
  - Added `state.sendBusy` flag.
  - Added `setComposerSending(isSending)` helper to disable/restore composer controls during send.
  - Updated `sendMessage()` to be async, guarded by `sendBusy`, and wrapped in `try/finally` to reliably unlock UI.
  - Updated group composer state logic to respect `sendBusy`.

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed

### Deployed to VPS?
- Yes — synced `web/e2ee_chat/app.js` and rebuilt only `cypher-chat`.
- Live verification confirms `state.sendBusy` / `setComposerSending()` logic is served by `https://app.airoautomation.com/app.js`.

## Session — 2026-03-03 (Required Key Backup Onboarding + Undecryptable Guidance)

### Summary
- Added enforced key-backup onboarding: users without a server key backup must set a recovery passphrase and complete `Backup Key to Server` before entering the app.
- Added explicit inline guidance inside message bubbles when content is undecryptable.

### Changes Made
- Frontend (`web/e2ee_chat/app.js`):
  - Added `ensureRequiredKeyBackup()` guard.
  - Called guard during app entry immediately after key readiness.
  - If user has no backup, app requires passphrase-based backup flow or logs out.
  - Added undecryptable-message hint text in the bubble:
    - tells user to open `Settings -> Profile`
    - use `Restore Key from Server`
    - then `Backup Key to Server`
- Frontend styles (`web/e2ee_chat/styles.css`):
  - Added `.bubble-undecryptable-hint` style for readable inline recovery instructions.

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed

### Deployed to VPS?
- Yes — synced `web/e2ee_chat/app.js` and `web/e2ee_chat/styles.css`, then rebuilt only `cypher-chat`.
- Live verification:
  - `https://app.airoautomation.com/app.js` contains `ensureRequiredKeyBackup()`
  - runtime UI includes `bubble-undecryptable-hint` guidance text

## Session — 2026-03-02 (Push Notifications While Desktop Is Connected)

### Summary
- Updated push behavior so mobile/home-screen push notifications are still sent for new messages even when the same account is active on desktop/websocket.
- This removes the old suppression rule that skipped push if websocket delivery succeeded.

### Changes Made
- Backend (`execution/e2ee_chat_server.py`):
  - In `_notify_user(...)`, removed `delivered_via_ws` gating.
  - Push send now always runs for:
    - `new_message`
    - `new_group_message`

### Validation
- `python3 -m py_compile execution/e2ee_chat_server.py` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed

### Deployed to VPS?
- Yes — synced backend and rebuilt only `cypher-chat`.
- Runtime verification on VPS confirms new logic is live.

## Session — 2026-03-02 (Global Feed Send Failure With No-Key Members)

### Summary
- Fixed production send failure in `BlackEnvelope Feed` where posting could fail with:
  - `boxes usernames mismatch. missing=[...]`
- Root cause: feed includes all users, including legacy/no-key accounts, but backend required encrypted boxes for every member.
- New behavior: only members with usable public keys are required in `payload.boxes`; no-key members remain in feed and will see `[unable to decrypt]`.

### Changes Made
- Backend (`execution/e2ee_chat_server.py`):
  - Added `_public_key_is_json_object(...)` helper.
  - Updated group send validation in `/api/groups/{group_id}/messages/send`:
    - expected recipients now include sender + members with parseable JSON public keys.
    - members without usable keys no longer block message send.
- Tests (`execution/smoke_test_e2ee_chat.py`):
  - Added regression scenario for global feed with a no-key user:
    - `charlie` is auto-membered in global feed without public key.
    - group send with boxes for only key-bearing users succeeds.

### Validation
- `python3 -m py_compile execution/e2ee_chat_server.py execution/smoke_test_e2ee_chat.py` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed

### Deployed to VPS?
- Yes — synced backend and rebuilt only `cypher-chat`.
- Service status: `cypher-chat` running healthy after rebuild.

## Session — 2026-03-02 (@everyone Restored in Global Feed)

### Summary
- Fixed `@everyone` so it works again for all members inside **BlackEnvelope Feed**.
- Kept stricter `@everyone` permissions for normal groups (owner/admin/site-admin only).
- Deployed fix to production by rebuilding only `cypher-chat`.

### Root Cause
- Production frontend/backend were still using older `@everyone` permission logic that did not include global-feed member allowance.

### Changes Made
- Frontend (`web/e2ee_chat/app.js`):
  - Updated mention candidate permission check to allow `@everyone` when `group.is_global_feed` is true.
- Backend (`execution/e2ee_chat_server.py`):
  - Updated `/api/notifications/mention-everyone` permission logic:
    - allow any member in global feed
    - keep owner/admin/site-admin requirement for non-global groups

### Deployed to VPS?
- Yes.
- Synced exact files to:
  - `/opt/cypher-chat/web/e2ee_chat/app.js`
  - `/opt/cypher-chat/execution/e2ee_chat_server.py`
- Rebuilt/restarted only service:
  - `cd /opt/cypher-chat/deployment/e2ee_chat && docker compose up -d --build cypher-chat`

### Verification
- `cypher-chat` container healthy (`Up`).
- VPS source now includes:
  - `isGlobalFeed || ...` check in frontend mention candidates
  - global-feed-aware permission model in `/api/notifications/mention-everyone`
- Removed accidental root-level duplicate files created during first sync attempt:
  - `/opt/cypher-chat/app.js`
  - `/opt/cypher-chat/e2ee_chat_server.py`

## Session — 2026-03-02 (Global App-Wide Feed)

### Summary
- Added a built-in app-wide group feed named **BlackEnvelope Feed**
- All existing users are auto-added on server startup
- Every new user is auto-added at registration / Google first-time account creation
- Added server-side protections so this feed cannot be deleted, membership cannot be manually removed/invited, and extra topics cannot be created/deleted
- Updated UI to pin this feed at the top of the conversation list and show feed-specific info copy in group info modal

### Changes Made
- Backend:
  - Added global-feed bootstrap + reconciliation helpers
  - Startup now ensures feed exists and backfills membership for all users
  - Login/group listing paths also ensure user membership defensively
  - Protected feed from management actions:
    - block invites/manual member add/remove
    - block topic create/delete
    - block group delete
  - Added `is_global_feed` in group/members API responses
  - Added reserved group-name guard for `BlackEnvelope Feed`
  - Hardened account deletion so if feed owner is deleted, ownership transfers to another member/admin when possible
- Frontend:
  - Conversation list pins `#BlackEnvelope Feed` to top
  - Group info modal shows feed note and hides normal management controls for this system feed
  - Docs now mention that all users are automatically in `#BlackEnvelope Feed`

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `python3 -m py_compile execution/e2ee_chat_server.py` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed
- Additional targeted global-feed API test passed:
  - feed auto-created
  - all users auto-membered
  - protected operations return expected `403`

### Files Modified
- `execution/e2ee_chat_server.py`
- `web/e2ee_chat/app.js`

### Deployed to VPS?
- Yes — synced backend/frontend and rebuilt only `cypher-chat`
- Verification:
  - `GET /health` returned `{"status":"ok"}`
  - Live frontend serves `is_global_feed` + `BlackEnvelope Feed` UI logic
  - Runtime backend contains global-feed bootstrap/protection logic
  - Feed exists in production DB with full membership (`members == users`)

## Session — 2026-03-02 (Open Registration + Optional Promo Codes)

### Summary
- Removed mandatory registration access-code gating for new signups
- Added optional promo-code behavior for both password registration and first-time Google signup
- Kept free-access behavior: only promo codes marked `grants_free_access` skip billing
- Updated auth UI, admin wording, and in-app docs from “Access Code” to “Promo Code” language

### Changes Made
- Backend registration logic:
  - `POST /api/register` now accepts optional `promo_code` (with backward-compat fallback to `access_code`)
  - Invalid or non-existent promo code no longer blocks signup
  - Only valid promo codes with `grants_free_access=1` set `subscription_exempt=1`
- Backend Google first-time signup logic:
  - `POST /api/auth/google` (new-account path) now treats promo code the same way as normal registration
  - Supports `promo_code` with fallback to legacy `access_code`
- Frontend auth payload updates:
  - Registration now sends `promo_code`
  - Google username completion now sends `promo_code`
- Frontend copy updates:
  - Register and Google forms now show `Promo Code (optional)`
  - Admin settings button renamed to `Promo Codes`
  - Admin promo modal labels/toasts/status text updated to reflect optional promo model
  - Docs/help sections updated to explain optional promo code + normal billing fallback

### Validation
- `node --check web/e2ee_chat/app.js` passed
- `python3 -m py_compile execution/e2ee_chat_server.py` passed
- `python3 execution/smoke_test_e2ee_chat.py` passed
- Additional targeted API test passed:
  - wrong promo code -> account created with `subscription_exempt=false`
  - valid free promo code -> account created with `subscription_exempt=true`

### Files Modified
- `execution/e2ee_chat_server.py` — optional promo-code logic in register + Google new-user path
- `web/e2ee_chat/app.js` — promo payloads, admin modal wording, docs/help text
- `web/e2ee_chat/index.html` — promo placeholders/hints and admin menu label

### Deployed to VPS?
- No (local changes validated; deploy pending)

## Session — 2026-03-01 (10 MB Media + Auto-Compression + 500 MB Storage)

### Summary
- Raised message attachment UX limit to 10 MB per message
- Added frontend auto-compression pipeline for media files (image/video/audio) before encryption when possible
- Raised backend payload defaults to accept larger encrypted media envelopes
- Raised per-user auto-prune storage limit from 125 MB to 500 MB (with configurable warn threshold)

### Changes Made
- Frontend attachment handling:
  - `MAX_MEDIA_FILE_BYTES` changed to 10 MB
  - Added media optimization helpers for:
    - image compression (canvas/webp pipeline)
    - video/audio best-effort transcoding via `MediaRecorder`
  - Added raw media pre-check (`MAX_MEDIA_SOURCE_BYTES = 50 MB`) before compression
  - Updated attachment UX copy to explain local auto-compression + 10 MB cap
  - Updated voice error message to `max 10 MB`
- Backend limits:
  - `DIRECT_PAYLOAD_MAX_BYTES` default: `40,000,000`
  - `GROUP_PAYLOAD_MAX_BYTES` default: `150,000,000`
  - `STORAGE_LIMIT_BYTES` default now env-driven at `500 MB`
  - `STORAGE_WARN_BYTES` now env-driven with guardrails
- Deployment config:
  - Added new payload/storage env pass-through values in Docker Compose
  - Documented new env keys in deployment `.env.example`

### Files Modified
- `web/e2ee_chat/app.js` — 10 MB cap, media auto-compression logic, updated attachment docs text
- `execution/e2ee_chat_server.py` — raised payload defaults, 500 MB storage limit + env config
- `deployment/e2ee_chat/docker-compose.yml` — payload/storage env vars pass-through
- `deployment/e2ee_chat/.env.example` — documented payload/storage env defaults

### Deployed to VPS?
- No (code + config updated locally; rebuild/redeploy still required)

## Session — 2026-02-27 (Account Recovery + Google OAuth Restore)

### Summary
- Restored full account recovery flow in production: forgot password, reset password, and forced email capture for legacy users with blank email fields
- Fixed live paid-user login blockers by verifying billing linkage and applying targeted password reset support where needed
- Re-enabled Google OAuth sign-in path (Google ID token verification + account link/create flow)
- Synced production auth/email credentials from local source of truth and redeployed only `cypher-chat` (left `n8n` and Traefik untouched)
- Renamed local workspace folder to `BlackEnvelope` for clarity

### Changes Made
- Added/verified backend endpoints:
  - `POST /api/auth/forgot-password`
  - `POST /api/auth/reset-password`
  - `PUT /api/me/email`
  - `GET /api/config/public` (returns `google_client_id` + billing flag)
  - `POST /api/auth/google` (Google login/link/new-account flow)
- Added Google token verification against Google `tokeninfo` endpoint and audience/issuer/expiry checks
- Added `google_id` support in DB schema + migration + unique index
- Frontend auth flow updates:
  - Added Google Sign-In button and callback flow
  - Added Google new-user username/access-code panel
  - Added reset token hash-route handling (`#/reset-password?token=...`)
  - Forced email-link gate before app entry for legacy users without email
- Added deploy env mapping for `GOOGLE_CLIENT_ID` in Docker Compose
- Confirmed Resend and Google-related env vars are set in VPS `.env`

### Files Modified
- `execution/e2ee_chat_server.py` — recovery endpoints, Google OAuth/public config endpoints, schema migration, auth response helpers
- `web/e2ee_chat/index.html` — Google script/button and Google username panel
- `web/e2ee_chat/app.js` — Google auth client flow, reset route flow, legacy email-link gating
- `web/e2ee_chat/styles.css` — auth divider + Google button wrapper styles
- `deployment/e2ee_chat/docker-compose.yml` — `GOOGLE_CLIENT_ID` pass-through
- `deployment/e2ee_chat/.env.example` — documented `GOOGLE_CLIENT_ID`
- `execution/smoke_test_e2ee_chat.py` — registration payload updated for required email

### Deployed to VPS?
- Yes — rsync backend/frontend/compose + Docker rebuild/recreate of only `cypher-chat`
- Verified:
  - `GET /health` returns `{"status":"ok"}`
  - `GET /api/config/public` returns Google client ID
  - `POST /api/auth/google` returns expected validation response when token missing
  - `POST /api/auth/forgot-password` returns success envelope
  - Login page includes Google auth elements

### Issues / Notes
- During deploy, an initial rsync path mismatch copied files to `/opt/cypher-chat/` root; corrected by syncing to exact service paths and rebuilding again
- `PASSWORD_RESET_TTL_SECONDS` can be omitted because compose defaults to `3600`
- Local folder renamed:
  - from: `/Users/nickwright87/cypher copy before oauth login`
  - to: `/Users/nickwright87/BlackEnvelope`
  - temporary symlink kept for compatibility with active tooling paths

---

## Session — 2026-02-27 (iOS PWA Compatibility Fix)

### Summary
- Fixed critical iOS PWA issue: `window.prompt()` and `confirm()` are blocked/broken in iOS standalone PWA mode, causing key backup buttons and other actions to do nothing (app "snaps back" to home screen)
- Replaced all `window.prompt()` (2) and `confirm()` (10) calls with in-app modal equivalents (`askPassphraseAsync`, `confirmAsync`)
- Fixed `@captdeedubb` (id 24) stuck subscription — same webhook-linking bug as john75333
- Changed key backup button icons from confusing lock emoji (🔒) to upload/download arrows (⬆️/⬇️)
- Bumped service worker cache to v11 to force iOS PWA users to get updated code

### Changes Made
- New `confirmAsync(message, options)` — Promise-based in-app confirm modal with OK/Cancel buttons, danger styling option
- New `askPassphraseAsync({ confirmPassphrase, purpose })` — Promise-based in-app passphrase input modal with validation (12+ chars, confirm match)
- Converted `askRecoveryPassphrase` to async wrapper around `askPassphraseAsync`
- Replaced all 10 `confirm()` calls: ensureKeyReady restore prompt, delete key backup, backup new key, delete message, delete group, cancel subscription, admin exempt toggle, admin remove user, delete access code, delete all access codes
- Changed key backup icons: backup ⬆️, restore ⬇️
- CSS: confirm-overlay, confirm-card, confirm-btn, passphrase-input, passphrase-error styles

### Files Modified
- `web/e2ee_chat/app.js` — confirmAsync, askPassphraseAsync, all confirm/prompt replacements, icon changes
- `web/e2ee_chat/styles.css` — in-app confirm/passphrase modal styles
- `web/e2ee_chat/sw.js` — cache version bump v10 → v11

### Deployed to VPS?
- Yes — rsync frontend + Docker rebuild via SSH

---

## Session — 2026-02-27 (Payment Verification Fix)

### Summary
- Fixed user `john75333` who had paid via Square but couldn't log in — webhook failed to link their subscription to their DB row
- Built a permanent fix: post-payment redirect now includes a signed token, and the frontend polls a new endpoint to proactively resolve the user's subscription before they try to log in
- This prevents the race condition where the webhook hasn't arrived yet when the user tries to log in after paying

### Changes Made
- Fixed `john75333` (user 47) by manually linking their Square customer ID and ACTIVE subscription in the DB
- Added `_create_payment_pending_token()` / `_verify_payment_pending_token()` — short-lived (15 min) signed tokens encoding user_id + username
- Modified `_square_create_checkout_link_for_user()` — redirect URL now includes `?payment_pending=<signed_token>`
- New endpoint: `GET /api/billing/payment-status?token=<pp_token>` — unauthenticated, verifies token, resolves Square customer_id from orders, refreshes subscription, returns `active`/`pending`/`not_found`
- Frontend: `checkPaymentPending()` — detects `?payment_pending=` URL param on page load, shows "Verifying your payment..." overlay, polls every 3s (max 10 attempts), auto-populates login on success
- HTML: payment verification overlay in auth section
- CSS: payment-verify-overlay, spinner, done state styles

### Files Modified
- `execution/e2ee_chat_server.py` — token helpers, checkout redirect modification, payment-status endpoint
- `web/e2ee_chat/app.js` — checkPaymentPending(), init flow integration
- `web/e2ee_chat/index.html` — payment verify overlay HTML
- `web/e2ee_chat/styles.css` — payment verify overlay styles

### Deployed to VPS?
- Yes — rsync frontend + backend + Docker rebuild via SSH

---

## Session — 2026-02-27 (User Profile Pages)

### Summary
- Added full profile pages (own profile + other users)
- Own profile: avatar, username, display name, status, bio, location, link, join date, key management, key backup status dot (red/green)
- Other user profiles: viewable by clicking @username in conversations (sender labels + inline @mentions)
- Other user profile shows: avatar, bio, location, link, join date, Send Message / Add Friend button
- Moved key management from settings panel into profile modal
- Expanded Edit Profile to include status, bio, location, link fields
- Settings panel cleaned up: profile editing + key management removed, profile header is now clickable to open profile

### Changes Made
- DB migrations: added `bio`, `location`, `link`, `status` columns to users table
- `GET /api/me` now returns bio, location, link, status, created_at, has_key_backup
- `PUT /api/me/profile` accepts bio (500), location (100), link (200), status (100) fields
- New endpoint: `GET /api/users/{username}/profile` — returns full profile + is_friend + has_pending_request
- Frontend: `showProfileModal()` with own vs other user views, `_renderKeyManagement()`, `refreshKeyBackupStatus()`
- Frontend: expanded `showEditProfileModal()` with all new fields
- Frontend: click handlers on `.bubble-sender` and delegated `.mention` clicks → open profile
- Settings panel: removed key management HTML/JS, removed profile section, made header clickable
- CSS: profile modal styles, key backup dot indicators, bubble-sender hover/cursor

### Files Modified
- `execution/e2ee_chat_server.py` — migrations, API expansions, new profile endpoint
- `web/e2ee_chat/app.js` — profile modal, edit profile expansion, click handlers, settings cleanup
- `web/e2ee_chat/index.html` — settings panel cleanup
- `web/e2ee_chat/styles.css` — profile modal styles, bubble-sender hover

### Deployed to VPS?
- Yes — rsync frontend + backend + Docker rebuild via SSH

---

## Session — 2026-02-26 (Sidebar Preview Fix + Group Member Permissions)

### Summary
- Fixed sidebar conversation list not showing last-message snippets when reopening the app after it was closed
- Two bugs fixed: (1) race condition where preview fetch ran before friends/groups were loaded, iterating empty maps; (2) sequential preview fetching was extremely slow with many conversations
- Changed group permissions: any member can now invite/add new members, but only group owner and site admin can remove members

### Changes Made
- Moved `refreshConversationPreviews()` inside the `.then()` callback after `refreshFriends()`/`refreshGroups()` complete, so it no longer races against empty state
- Changed `refreshConversationPreviews()` from sequential `await` loop to parallel `Promise.allSettled()` for much faster loading
- Removed admin-only gate on invite and add-member endpoints (any group member can now invite)
- Changed remove-member endpoint to require group owner role or site admin (was any group admin)
- Added `can_remove_members` flag to members list API response
- Frontend: remove member UI only visible to group owner / site admin

### Files Modified
- `web/e2ee_chat/app.js` — sidebar preview fix, group permission UI gating
- `execution/e2ee_chat_server.py` — invite/add/remove permission changes, `can_remove_members` flag

### Deployed to VPS?
- Yes — rsync frontend + backend + Docker rebuild via SSH

---

## Session — 2026-02-25 (PWA + Push + Voice + Notifications + Performance)

### Summary
- **PWA**: App is now installable on Android (Chrome install prompt) and iOS (Add to Home Screen → standalone app)
- **Web Push Notifications**: Background push notifications via VAPID/pywebpush when app is closed and a new message arrives
- **Voice Messages (E2EE)**: Mic button in compose bar, MediaRecorder → base64 → encrypted via existing attachment pipeline, 2-min max
- **Notification Center**: Bell dropdown shows likes, @mentions, friend requests, group invites with jump-to-message navigation
- **Faster Loading**: Restructured enterApp() for instant UI shell, localStorage conversation cache, skeleton shimmer animation
- **Service Worker**: Cache-first for static assets, passthrough for API/WS, push event handler

### New Files
- `web/e2ee_chat/manifest.json` — PWA manifest (standalone, dark theme, icons)
- `web/e2ee_chat/sw.js` — Service worker (caching, push, notification click)
- `web/e2ee_chat/icon-192.png` — Android PWA icon (192x192)
- `web/e2ee_chat/icon-512.png` — Android PWA icon (512x512)

### Files Modified
- `web/e2ee_chat/index.html` — PWA meta tags, notification dropdown HTML, voice recording bar HTML, mic button
- `web/e2ee_chat/app.js` — SW registration, push subscribe/unsubscribe, voice recording, notification dropdown, scrollToMessage, mention hints, conversation cache, enterApp restructure, data-msg-id on bubbles
- `web/e2ee_chat/styles.css` — Notification dropdown, voice recording UI, mic button, skeleton shimmer, message highlight animation
- `execution/e2ee_chat_server.py` — notifications table, push_subscriptions table, VAPID config, _send_web_push(), _create_notification(), notification endpoints (list, unread-count, read, mention), push endpoints (public-key, subscribe, unsubscribe), message context endpoint, like notifications on like toggle
- `deployment/e2ee_chat/requirements-chat-api.txt` — Added pywebpush>=2.0.0
- `deployment/e2ee_chat/docker-compose.yml` — Added VAPID env vars
- `deployment/e2ee_chat/.env.example` — Added VAPID key placeholders

### Deployed to VPS?
- Yes — full rsync (frontend + backend + deployment config) + Docker rebuild
- VAPID keys generated and added to VPS `.env`
- Token secret preserved from running container
- n8n and Traefik untouched

### Issues / Notes
- iOS Web Push requires app to be added to home screen first (iOS 16.4+), guarded by `'PushManager' in window`
- Mention notifications are client-side hints (server can't read E2EE content) — server learns who mentioned whom but not message content
- Service worker cache version: `blackenvelope-v1` — bump in sw.js on future deploys to invalidate cache

---

## Session — 2026-02-25

### Summary
- Verified Square billing webhook is fully working end-to-end (webhook receives events, HMAC signature validation works, Square test event returned 200 OK)
- Hardened VPS security: disabled SSH password authentication, enabled UFW firewall, installed fail2ban
- **New Feature: Message Likes** — thumbs-up button on every message, avatar stacking showing who liked, "Liked by" overlay with Add Friend option, real-time WebSocket updates
- **New Feature: View Toggle** — 3-mode conversation view (All / Most Relevant / My Tags) with pill button bar below topics bar

### Changes Made (code)
- Added `message_likes` database table with unique constraint per user/message
- Added `POST /api/messages/{id}/like` and `POST /api/groups/{gid}/messages/{id}/like` toggle endpoints
- Augmented all message list endpoints to include `likes` and `like_count` data
- Added like cleanup on message delete (both DM and group)
- Added like button + avatar stack rendering in message bubbles
- Added `toggleMessageLike()`, `showLikesOverlay()`, `updateLikeUI()` functions
- Added `message_like_updated` WebSocket event handler for real-time like updates
- Added view toggle bar (All / Most Relevant / My Tags) with client-side filtering
- Added `.avatar.xs` (20px) size, like button styles, avatar stack styles, view toggle bar styles

### Files Modified
- `execution/e2ee_chat_server.py` — new table, helper, like endpoints, augmented message lists, delete cleanup
- `web/e2ee_chat/app.js` — like rendering, interaction functions, WebSocket handler, view toggle logic
- `web/e2ee_chat/styles.css` — avatar.xs, like button, avatar stack, view toggle bar styles
- `web/e2ee_chat/index.html` — view toggle bar HTML

### Changes Made (on VPS directly)
- Disabled SSH password authentication (`/etc/ssh/sshd_config.d/50-cloud-init.conf` — `PasswordAuthentication no`)
- Enabled UFW firewall — only ports 22 (SSH), 80 (HTTP), 443 (HTTPS) allowed; all others blocked
- Installed and enabled fail2ban — auto-bans IPs that brute-force SSH

### Files Modified
- `/etc/ssh/sshd_config.d/50-cloud-init.conf` (on VPS) — disabled password auth

### Deployed to VPS?
- Yes — all changes applied directly on VPS (no app code changes)

### Issues / Notes
- SSH private key backed up by user (required since password login is now disabled)
- Hostinger web console available as emergency access if SSH key is lost
- Pending kernel upgrade on VPS (6.8.0-88 → 6.8.0-101) — requires reboot when convenient
- Square webhook confirmed working: `POST /api/billing/square/webhook` → 200 OK from Square test event

---

## Session — 2026-02-22

### Summary
- Created this progress log (`PROGRESS.md`) to track changes across sessions.

### Current State of Production (`https://app.airoautomation.com`)

**What's live and deployed:**

| Area | Status | Notes |
|------|--------|-------|
| **Registration & Login** | Live | Access-code gated signup, JWT auth |
| **1:1 Encrypted Messaging** | Live | TweetNaCl client-side crypto, friend-only enforcement |
| **Groups & Topics** | Live | Per-topic discussion threads with "All" stream |
| **Real-time WebSocket** | Live | Instant message delivery |
| **Group Admin Controls** | Live | Remove member, delete topic/group/message |
| **Site Admin Panel** | Live | User list, access code management, CSV export |
| **Search & Autocomplete** | Live | Username lookup with recent searches |
| **Key Rotation** | Live | "Generate New Key" with backup prompt |
| **Square Billing** | Live | Subscription gate for new users, grandfathered exemption |

**Stack:**
- Frontend: Vanilla JS SPA (`web/e2ee_chat/`) — `app.js` (4,351 lines), `styles.css` (1,387 lines), `index.html` (264 lines)
- Backend: FastAPI (`execution/e2ee_chat_server.py`) — ~160 KB, SQLite, JWT auth
- Deployment: Docker + Traefik on Hostinger VPS at `/opt/cypher-chat/`

---

<!--
## Session — YYYY-MM-DD

### Changes Made
- [ what was changed ]

### Files Modified
- `path/to/file` — description of change

### Deployed to VPS?
- Yes / No
- Rebuild command used: `...`

### Issues / Notes
- anything worth remembering
-->
