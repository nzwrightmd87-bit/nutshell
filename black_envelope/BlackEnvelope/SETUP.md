# BlackEnvelope — Setup & Deployment

This setup guide is for the cleaned copy inside the Nutshell workspace. Do not use it to access or modify the legacy Hostinger VPS that is still serving existing members.

## Local development

### Prerequisites

- Python 3.11+
- pip

### 1. Install the web-app dependencies

```bash
cd black_envelope/BlackEnvelope
python3 -m pip install -r deployment/e2ee_chat/requirements-chat-api.txt
```

If you need the older desktop tooling later, `requirements.txt` still exists, but it is not required for the web app.

### 2. Start the development server

```bash
cd black_envelope/BlackEnvelope
mkdir -p .tmp
python3 execution/run_e2ee_chat_dev.py --reload
```

The app will be available at `http://127.0.0.1:8787`.

### 3. Verify the app loads

- Open `http://127.0.0.1:8787`
- Confirm the BlackEnvelope login page appears
- Create a test account if needed
- Confirm the app shell loads after login

### 4. Run the smoke test

```bash
cd black_envelope/BlackEnvelope
python3 execution/smoke_test_e2ee_chat.py
```

## DigitalOcean droplet deployment

The deployment stack in `deployment/e2ee_chat/` is now prepared for a fresh Docker-based DigitalOcean droplet with Caddy handling HTTPS.

### Prerequisites

- A Ubuntu droplet with Docker Engine and the Docker Compose plugin installed
- A DNS record pointing your chat host (for example `chat.yourdomain.com`) at the droplet
- Ports `80` and `443` open to the droplet
- A fresh `.env` created from the provided example, not copied from any existing VPS

### 1. Copy the cleaned project to the droplet

From your local machine, copy this cleaned project tree to the new droplet. Example:

```bash
rsync -av --exclude='.env' --exclude='.tmp' --exclude='__pycache__' black_envelope/BlackEnvelope/ root@your_droplet_ip:/opt/black-envelope/
```

You can also use `git clone` on the droplet if you later put this subtree in its own repo.

### 2. Create deployment env vars on the droplet

```bash
ssh root@your_droplet_ip
cd /opt/black-envelope/deployment/e2ee_chat
cp .env.example .env
```

Edit `.env` and set at minimum:

- `CYPHER_CHAT_HOST=chat.yourdomain.com`
- `LETSENCRYPT_EMAIL=ops@yourdomain.com`
- `CYPHER_CHAT_TOKEN_SECRET=<long random secret>`
- `APP_BASE_URL=https://chat.yourdomain.com`

Generate a token secret:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Generate VAPID keys once if you want push notifications:

```bash
python3 -c "from py_vapid import Vapid; v = Vapid(); v.generate_keys(); print('PRIVATE=' + v.private_key_str); print('PUBLIC=' + v.public_key_str)"
```

### 3. Build and start the stack

```bash
cd /opt/black-envelope/deployment/e2ee_chat
docker compose --env-file .env up -d --build
```

This brings up:

- `black-envelope`: FastAPI app container
- `black-envelope-caddy`: HTTPS reverse proxy

Persistent data lives in Docker volumes managed by the compose stack.

### 4. Verify the deployment

On the droplet:

```bash
cd /opt/black-envelope/deployment/e2ee_chat
docker compose ps
curl -I https://chat.yourdomain.com/health
```

Expected result:

- `black-envelope` and `black-envelope-caddy` are running
- `curl` returns `HTTP/2 200`

Then verify in the browser:

- The login page loads
- Registration/login works
- A websocket-backed session can connect
- Group and direct-message flows still behave normally

## Environment variables that matter most

| Variable | Purpose |
|----------|---------|
| `CYPHER_CHAT_HOST` | Public hostname used by Caddy and by the app URLs |
| `LETSENCRYPT_EMAIL` | Email for TLS issuance with Caddy |
| `CYPHER_CHAT_TOKEN_SECRET` | Session/JWT signing secret |
| `APP_BASE_URL` | Base URL used in password-reset links and app callbacks |
| `SQUARE_*` | Subscription billing integration |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `RESEND_*` | Password reset email delivery |
| `VAPID_*` | Web push notifications |

## Operational notes

- Do not copy `.env` from the old Hostinger deployment into this project.
- Changing `CYPHER_CHAT_TOKEN_SECRET` invalidates all active sessions.
- Caddy assumes it is the service binding ports `80` and `443` on the droplet.
- If you later place BlackEnvelope behind another reverse proxy, update `deployment/e2ee_chat/docker-compose.yml` and `Caddyfile` intentionally instead of layering proxies by accident.
