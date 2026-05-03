# Nutshell

Nutshell social app, built from a Mastodon fork and customized for a private, paid, community-first platform.

<p align="center">
  <img src="./app/javascript/images/logo-stacked.svg?raw=true" alt="Nutshell" width="320" />
</p>

## Project

This directory contains the Rails, React, Sidekiq, Redis, PostgreSQL, and streaming app that powers the social side of Nutshell. It includes Nutshell branding, the paid-membership signup flow, federation restrictions, custom post UI behavior, landing-page changes, and the launch bridge into BlackEnvelope.

## Local Development

Use the setup guide:

- `NUTSHELL_SETUP.md`

## Core Stack

- Ruby on Rails
- PostgreSQL
- Redis + Sidekiq
- Node.js + React
- Vite
- BlackEnvelope SSO/provisioning bridge

## License

This project is licensed under AGPLv3. See `LICENSE`.
