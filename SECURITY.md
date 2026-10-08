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

The full picture is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#who-is-allowed-to-do-what). In short:

- **Sign-in** is gated by your Google Auth Platform audience: Internal, or External in Testing mode with a test-user list. The optional `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` allowlist adds a check in the app's middleware only; row-level security lets any signed-in Supabase user read the tables, so a published External app is not protected by the allowlist alone.
- **Database writes** happen server-side with the service-role key only. Row-level security gives signed-in browser clients read-only access; every insert/update/delete goes through a server route.
- **Drive access** is a service account reached through Workload Identity Federation, so no Google key is stored anywhere. Every route re-checks the Drive IDs it's given: files must be active library assets, folders must be inside the configured Shared Drive (and the synced folders, for relays) — the service account can't be steered at arbitrary files.
- **Thumbnails** are in a public Storage bucket: anyone with a thumbnail's URL (`…/thumbnails/<driveFileId>.webp`) can load it.
- **Secrets** (Supabase service-role key, Google client secret, Gemini key, GitHub token) live only in server-side environment variables and are never sent to the browser.
- **No roles:** every signed-in user can use every feature, including Settings. Relay assumes a trusted team.

## Supported Versions

Only the latest commit on `main` is maintained.
