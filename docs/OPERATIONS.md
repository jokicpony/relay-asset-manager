# Operations — running your instance

Once [SETUP.md](SETUP.md) is done, Relay mostly runs itself: a sync every 6
hours, no routine hands-on work. This page covers what does need a person —
users, credentials that expire, upgrades, and what to do when something
breaks. How the system works is in [ARCHITECTURE.md](ARCHITECTURE.md).

Where things are in the app: **Settings** opens from the avatar menu (top
right) → **Sync & Settings**; "Settings → Advanced" means its **Advanced
Configuration** section at the bottom. **Trash** is its own item in the same
menu.

## Users

Who can sign in is decided by your **Google Auth Platform** audience
(SETUP.md step 3.2), plus the optional `AUTH_ALLOWED_EMAILS` /
`AUTH_ALLOWED_DOMAINS` allowlist, which only guards the app itself. To add
someone:

1. **Let them sign in** — nothing to do for an Internal audience; for
   External in Testing mode, add their Google account under **Google Auth
   Platform → Audience → Test users** (max 100); if you use the allowlist, add
   them there too.
2. **Give them access to the Shared Drive.** Relay reads Drive as the service
   account, but "Open in Drive" links and direct downloads of files ≥ 1 GiB use
   the person's own access.

Users don't need Vercel, GitHub or Supabase accounts. Every signed-in user has
the same rights, including Settings → Advanced (see "Design decisions").

To **remove** someone: revoke their sign-in (test-user list or allowlist),
delete them under Supabase → Authentication → Users to end their session
immediately, and remove them from the Shared Drive if appropriate.

## Credentials to keep alive

- **The Sync Now token** (`GITHUB_TOKEN` in Vercel) is a personal access token:
  it **expires**, and it belongs to whoever created it. When it's dead the
  button fails with a message saying so; scheduled syncs are unaffected.
- **Sync-failure emails** from GitHub go to whoever last edited the `cron:`
  line in `.github/workflows/daily-sync.yml`.
- **Changing a credential:** update it everywhere it lives — Vercel, GitHub
  Actions secrets, Supabase (the OAuth client secret, under Authentication →
  Providers → Google) and your `.env.local` — then **redeploy in Vercel**.
  Running deployments keep the old values.

## Upgrading

Vercel deploys whatever lands on `main`, so apply database changes first:

1. `git fetch upstream`, then see what's new:
   `git diff main upstream/main -- supabase/migrations/`.
2. Apply each new migration in the Supabase SQL Editor, in date order —
   [supabase/migrations/README.md](../supabase/migrations/README.md) says what
   each does. They're idempotent, so re-running one is harmless.
3. `git merge upstream/main` and push to `main`. Vercel deploys it and the
   next sync runs it; check Settings → Recent Activity after that sync.

---

## When something breaks

Start at **Settings → Recent Activity**. Every scheduled sync and every Namer
ingest records a row — OK, Partial or Failed — with the reason; scheduled syncs
link to their GitHub log. The header shows **⚠ Sync failed** or **⚠ Sync
overdue** (no successful sync in 13 hours).

**The scheduled sync failed.** Open the row → **GitHub log ↗**. Usually:

- *Google auth* — fails at "Authenticate to Google Cloud" (missing or wrong
  `GCP_*` repository variables), or in "Run sync" with "ADC/WIF auth failed"
  (the GitHub provider's condition, the Workload Identity User binding, or a
  disabled IAM Credentials API; ignore the message's `GOOGLE_REFRESH_TOKEN`
  suggestion). 404s during the crawl instead mean the service account isn't a
  member of the Shared Drive.
- *Supabase* — errors about a relation or column: usually a migration that
  wasn't applied.
- *Timed out / cancelled* — thumbnails are time-boxed and finish over later
  runs; embeddings are saved as they go, so a killed run keeps its progress.
  If it keeps timing out, run manually with **Skip thumbnail processing**
  (assets embedded before they have a thumbnail are embedded from text only —
  see "Search results look wrong or thin").

Re-run from Actions → Daily Sync → Run workflow (runs never overlap, so it's
safe while another is queued). The form's options: **Skip thumbnail
processing**, **Allow trashing a large number of missing assets** and **Dry
run**.

**Every Drive action in the app fails** (browsing works, but downloads,
relays, the Namer and video don't; Vercel's function logs say "Failed to get
Drive access token via WIF"). Check the four `GCP_*` variables and
`VERCEL_TEAM_SLUG` in Vercel (it must be set), that OIDC Federation is on, and
that the Vercel provider's issuer and audience use your team's real slug —
renaming the Vercel team breaks them. Redeploy after any change.

**A sync is "Partial".** Something failed without stopping the run; the details
list each problem by step. Missing thumbnails and embeddings retry on their own
next run; a persistent problem names its cause (e.g. Gemini quota).

**"Skipped trashing N assets … safety limit".** A sync would have trashed an
unusually large number of assets — almost always a synced top-level folder
that was renamed or moved. Rename it back, or update Sync Folders. Only if the
files really were deleted, re-run manually with **Allow trashing a large
number of missing assets**.

**Assets are missing, or in the Trash.** Check the rules in the README's
"Which folders are in Relay". Quickest causes first:

- *Hidden folder* — missing from All Folders but there when you open the
  folder: its sidebar eye icon is off. Nothing was removed.
- *Not synced yet* — new files appear after the next sync (≤ 6 hours, or
  Settings → Sync Now); Namer batches a few minutes after the batch.
- *Trashed* — the file was deleted in Drive, moved out of the synced folders,
  or put under `[relay-ignore]`. Undo that in Drive within 14 days and the
  next sync restores it. Trash (avatar menu) lists what's pending; its Restore
  button is undone by the next sync if the cause is still there.
- *Relay gone* — its shortcut was deleted or its folder moved out of the
  library; the sync drops it about 2 days later.

To see what a sync *would* do, run the workflow with **Dry run**.

**A Namer batch or ingest failed.** The Namer queue shows each file's reason;
**Retry failed** re-runs only what failed and never renames or moves a file
twice; **Retry revert** finishes a partial revert. The ingest shows in Recent
Activity as a "Namer ingest" row with per-file errors and skips; anything it
missed is picked up by the next scheduled sync.

**Search results look wrong or thin.** New and changed assets are embedded by
the scheduled sync; a Gemini problem shows as a Partial run with an
"embeddings" problem. An asset embedded before its thumbnail existed (a run
that skipped or ran out of time for thumbnails) is embedded from its text
only, and isn't re-embedded when the thumbnail arrives. To rebuild
everything: `npx tsx scripts/embed.ts --force` (slow; uses Gemini quota).

## Will need attention eventually

- **Gemini preview models** (`gemini-embedding-2-preview` for search,
  `gemini-3-flash-preview` for Namer analysis). If Google retires one, search
  or Namer analysis breaks. Changing the **embedding** model means re-embedding
  the whole library (`scripts/embed.ts --force`) — documents and queries must
  use the same model.
- **Supabase plan limits** (storage, database size) as the library grows.
  Thumbnails are roughly 100 KB each.
- **The test-user cap of 100**, if you use Testing mode. Past it, switch to
  an Internal audience. Publishing an External app isn't safe on its own: the
  allowlist doesn't protect the database.

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
