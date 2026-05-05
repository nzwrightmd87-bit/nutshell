# BlackEnvelope

BlackEnvelope is the end-to-end encrypted messaging and groups service planned to sit alongside Nutshell's Mastodon-based social app.

This working tree was extracted from `../BlackEnvelope.zip` and cleaned for local development plus fresh DigitalOcean deployment preparation. The legacy Hostinger VPS remains live for existing members and is intentionally out of scope for this repo copy.

## Current product

### Core chat
- Account registration and login
- Optional registration access-code gate for new signups
- Per-user public key publishing
- Friend-only direct encrypted messaging
- Realtime updates via WebSocket

### Privacy and discovery
- No global user directory
- Username lookup with autocomplete
- Friend requests
- Friend-only direct chat enforcement

### Groups and topics
- Group creation
- Invite-only membership
- Topic-based discussion
- Group `All` stream across topics
- Group admin controls for members, topics, messages, and group deletion

### Admin tooling
- Admin-only user list
- Registration code management
- CSV user export
- Free-access toggles for billing exceptions

## Security model

- The browser generates and stores private keys locally.
- Encryption happens in the browser before payloads are sent.
- The server stores ciphertext and metadata only.
- Transport is expected to run over HTTPS/WSS.

### Important limitations

- Clearing browser storage on a device can remove that device's local private keys.
- Key verification UX is still minimal.
- This is not a formally security-audited product.

## Working tree

- `execution/e2ee_chat_server.py`: FastAPI backend
- `web/e2ee_chat/`: SPA frontend
- `execution/run_e2ee_chat_dev.py`: local dev runner
- `execution/smoke_test_e2ee_chat.py`: integration smoke test
- `deployment/e2ee_chat/docker-compose.yml`: DigitalOcean droplet stack
- `deployment/e2ee_chat/Caddyfile`: HTTPS reverse proxy config
- `deployment/e2ee_chat/.env.example`: deployment env template
- `SETUP.md`: local and DigitalOcean setup guide

## Local development

```bash
cd black_envelope/BlackEnvelope
python3 -m pip install -r deployment/e2ee_chat/requirements-chat-api.txt
mkdir -p .tmp
python3 execution/run_e2ee_chat_dev.py --reload
```

Open `http://127.0.0.1:8787`.

Run the smoke test:

```bash
python3 execution/smoke_test_e2ee_chat.py
```

## DigitalOcean deployment

This repo now targets a fresh DigitalOcean droplet deployment using Docker Compose and Caddy. The old Hostinger/Traefik instructions from the archive are not part of the new workflow.

High-level deployment flow:

1. Create a Ubuntu droplet and point a DNS name such as `chat.yourdomain.com` at it.
2. Copy this cleaned `black_envelope/BlackEnvelope/` tree onto the droplet.
3. Copy `deployment/e2ee_chat/.env.example` to `deployment/e2ee_chat/.env`.
4. Fill in the new domain, token secret, mail, billing, OAuth, and push values.
5. Run `docker compose --env-file .env up -d --build` from `deployment/e2ee_chat/`.
6. Verify `https://chat.yourdomain.com/health` returns `200 OK`.

See [SETUP.md](SETUP.md) for the detailed sequence.

## Legacy desktop tools

Legacy desktop encryption utilities are still present in `execution/`, but the active product for Nutshell integration is the BlackEnvelope web app.
