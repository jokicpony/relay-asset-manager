# Operations — running your instance

Once [SETUP.md](SETUP.md) is done, Relay mostly runs itself: a sync every 6
hours, no routine hands-on work. This page covers what does need a person —
users, credentials that expire, upgrades, and what to do when something
breaks. How the system works is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Users

Who can sign in is decided by your **Google OAuth consent screen**, plus the
optional `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` allowlist (SETUP.md
step 3.2). To add someone:

1. **Let them sign in** — nothing to do for an Internal consent screen; for
   External in Testing mode, add their Google account under **OAuth consent
   screen → Test users** (max 100); if you use the allowlist, add them there.
2. **Give them access to the Shared Drive.** Relay reads Drive as the service
   account, but "Open in Drive" links and direct downloads of files ≥ 1 GiB use
   the person's own access.

Users don't need Vercel, GitHub or Supabase accounts. Every signed-in user has
the same rights, including Settings → Advanced (see "Design decisions").

To **remove** someone: revoke their sign-in (test-user list or allowlist), and
delete them under Supabase → Authentication → Users to end their session
immediately.

## Credentials to keep alive

- **The Sync Now token** (`GITHUB_TOKEN` in Vercel) is a personal access token:
  it **expires**, and it belongs to whoever created it. When it's dead the
  button fails with a message saying so; scheduled syncs are unaffected.
- **Scheduled workflows pause in quiet public repos.** GitHub disables `cron`
  workflows in a public repository after 60 days without activity. If syncs
  stop, re-enable Daily Sync in the Actions tab (or keep the repo private).
- **Sync-failure emails** from GitHub go to whoever last edited the `cron:`
  line in `.github/workflows/daily-sync.yml`.
- **Rotating a Supabase or Gemini key** means updating it in **both** Vercel
  and GitHub Actions secrets.

## Upgrading

1. Pull the new code into your fork (GitHub's **Sync fork**, or merge
   upstream).
2. Read the new entries in
   [supabase/migrations/README.md](../supabase/migrations/README.md) and apply
   any new migrations in the Supabase SQL Editor **before** the deploy — they're
   idempotent, so re-running one is harmless.
3. Push to `main`; Vercel deploys it and the next sync runs it. Check Settings
   → Recent Activity after that sync.

---

## When something breaks

Start at **Settings → Recent Activity**. Every scheduled sync and every Namer
ingest records a row — OK, Partial or Failed — with the reason; scheduled syncs
link to their GitHub log. The header shows **⚠ Sync failed** or **⚠ Sync
overdue** (no successful sync in 13 hours).

**The scheduled sync failed.** Open the row → **GitHub log ↗**. Usually:

- *Google auth* — fails at "Authenticate to Google Cloud": check the `GCP_*`
  repository variables, the GitHub provider's attribute condition, and that
  the service account is still a member of the Shared Drive.
- *Supabase* — errors about a relation or column: usually a migration that
  wasn't applied.
- *Timed out / cancelled* — thumbnail and embedding backlogs are time-boxed
  and finish over later runs; if it keeps timing out, run manually with
  `skip_thumbnails`.

Re-run from Actions → Daily Sync → Run workflow (runs never overlap, so it's
safe while another is queued).

**Every Drive action in the app fails** (browsing works, but downloads,
relays, the Namer and video don't). That's the app's WIF login: check
`VERCEL_TEAM_SLUG` and the `GCP_*` variables in Vercel, that OIDC Federation is
on, and that the Vercel provider's issuer and audience use the same team slug.
The Vercel function logs show the exact error.

**A sync is "Partial".** Something failed without stopping the run; the details
list each problem by step. Missing thumbnails and embeddings retry on their own
next run; a persistent problem names its cause (e.g. Gemini quota).

**"Skipped trashing N assets … safety limit".** A sync would have trashed an
unusually large number of assets — almost always a synced top-level folder
that was renamed or moved. Rename it back, or update Sync Folders. Only if the
files really were deleted, re-run manually with `allow_mass_orphan`.

**Assets are missing, or in the Trash.** Check the rules in the README's
"Which folders are in Relay". Quickest causes first:

- *Hidden folder* — missing from All Folders but there when you open the
  folder: its sidebar eye icon is off. Nothing was removed.
- *Not synced yet* — new files appear after the next sync (≤ 6 hours, or
  Settings → Sync Now); Namer batches a few minutes after the batch.
- *Trashed* — the file was deleted in Drive, moved out of the synced folders,
  or put under `[relay-ignore]`. Restorable from Settings → Trash for 14 days.
- *Relay gone* — its shortcut was deleted or its folder moved out of the
  library; it disappears within 2 days.

To see what a sync *would* do, run the workflow with `dry_run`.

**A Namer batch or ingest failed.** The Namer queue shows each file's reason;
**Retry failed** re-runs only what failed and never renames or moves a file
twice; **Retry revert** finishes a partial revert. The ingest shows in Recent
Activity as a "Namer ingest" row with per-file errors and skips; anything it
missed is picked up by the next scheduled sync.

**Search results look wrong or thin.** New and changed assets are embedded by
the scheduled sync; a Gemini problem shows as a Partial run with an
"embeddings" problem. To rebuild everything: `npx tsx scripts/embed.ts --force`
(slow; uses Gemini quota).

## Will need attention eventually

- **Gemini preview models** (`gemini-embedding-2-preview` for search,
  `gemini-3-flash-preview` for Namer analysis). If Google retires one, search
  or Namer analysis breaks. Changing the **embedding** model means re-embedding
  the whole library (`scripts/embed.ts --force`) — documents and queries must
  use the same model.
- **Supabase plan limits** (storage, database size) as the library grows.
  Thumbnails are roughly 100 KB each.
- **The OAuth test-user cap of 100**, if you use Testing mode. Past it, switch
  to an Internal consent screen, or publish it together with
  `AUTH_ALLOWED_DOMAINS`.

---

## Design decisions

Deliberate choices; worth knowing before changing them.

- **Curation over retention.** Files moved out of the synced folders or under
  `[relay-ignore]` leave Relay after a 14-day trash. Relays may only point into
  the library. Only removing a whole folder in Settings keeps its data.
- **No Slack/email alerts.** GitHub's failure email plus the in-app activity
  log; new failure types extend the log.
- **Downloads go through Relay by default.** Only single files ≥ 1 GiB hand off
  to Google's download link. Sending everything ≥ 100 MB to Drive was tried
  and rolled back — the extra tab annoyed people.
- **Built for thousands of assets, not millions.** It's been run with
  several thousand assets, where a full crawl takes about a minute. Known next steps if a
  library grows several-fold: incremental sync via the Drive changes API,
  scoping by folder ID instead of top-level folder name, a virtualized grid,
  and skipping unchanged re-embeds with an input hash.
- **Every signed-in user can change Settings → Advanced** (shared drive, sync
  folders). Validation (no empty values; the drive must be one the service
  account can open) and the mass-trash safety limit stop the worst mistakes.
  There's no admin role; add one before opening Relay to a large or untrusted
  group.
