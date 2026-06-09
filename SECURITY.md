# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Relay Asset Manager, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **kmluby+relay-asset-manager@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce
- Any relevant logs or screenshots

You should receive a response within 48 hours. We'll work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

This policy covers the Relay Asset Manager codebase. It does not cover the third-party services it integrates with (Supabase, Google Cloud, Vercel) — report issues with those services directly to their respective security teams.

## Security Model

- **Sign-in** is gated by your Google OAuth consent screen (Internal, or External + test users / published). An optional app-level allowlist (`AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS`) can further restrict access in middleware.
- **Database writes** happen server-side with the service-role key only. Row-level security gives authenticated browser clients read-only access to `assets`, `shortcuts`, and `app_settings`; every insert/update/delete goes through a server route.
- **Drive content** is proxied via a service account. The download/stream endpoints only serve files that exist as active library assets, and the Asset Namer is bounded to the configured Shared Drive — the service account can't be steered at arbitrary files outside the managed library.
- **Secrets** (Supabase service-role key, Google client secret, Gemini key) live only in server-side environment variables and are never sent to the browser.

## Supported Versions

Only the latest release on the `main` branch is actively maintained.
