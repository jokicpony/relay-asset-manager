# Setup — building your own instance

This walks through standing up Relay on your own accounts: Supabase (database,
thumbnails, sign-in), Google Cloud (Drive access), Vercel (the app) and GitHub
Actions (the scheduled sync). Do the steps in order; later ones need IDs from
earlier ones. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit
if you want the picture first.

You'll need a Google Workspace account with a **Shared Drive** (not My Drive)
holding the photos and videos, and permission to add members to it.

**How Relay reaches Drive:** everything server-side — the app on Vercel and
the sync on GitHub Actions — acts as one Google **service account**, which is a
member of the Shared Drive. Neither stores a key: each proves its identity to
Google with a short-lived OIDC token (Workload Identity Federation, "WIF") and
gets a Drive token back. Users sign in with Google only to prove who they are.

## 1. Fork the repository

Fork this repo on GitHub (it's what Vercel and Actions will run), then
clone your fork. In the fork's **Actions** tab, enable workflows — GitHub
switches them off in new forks.

## 2. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor:** paste and run all of `supabase/schema.sql`. It creates the
   tables, row-level security, the `thumbnails` storage bucket and the
   `match_assets` search function, and is safe to re-run.
3. **Project Settings → API:** note the project URL, the `anon` key and the
   `service_role` key (keep that one secret — it bypasses row-level security).
4. **Authentication → Providers → Google:** turn it on; you'll paste the
   client ID and secret from step 3.3. Copy the **Callback URL** it shows
   (`https://<project-ref>.supabase.co/auth/v1/callback`).
5. **Authentication → URL Configuration:** add
   `http://localhost:3000/auth/callback` to the redirect URLs (you'll add the
   production one in step 4).

## 3. Google Cloud

1. **Create a project** in the [Cloud Console](https://console.cloud.google.com)
   and enable the **Google Drive API** and the **Drive Labels API**. Note the
   project *number* (Dashboard → Project info).
2. **OAuth consent screen** — this decides who can sign in. Pick one:
   - **Internal** — everyone in your Workspace can sign in. Simplest for a
     company tool.
   - **External, left in Testing** — only the accounts you add under **Test
     users** can sign in (up to 100); everyone else gets "403:
     access_denied". Good for a small team or users outside your Workspace.
   - **External, published** — *any* Google account can sign in, so also set
     `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` (step 4), or Relay is open
     to anyone with a Google account.
3. **Credentials → Create credentials → OAuth client ID** (Web application),
   with the Supabase callback URL from step 2.4 as the authorized redirect
   URI. Paste the client ID and secret into Supabase (step 2.4) and keep them
   for the environment.
4. **Service account:** IAM & Admin → Service accounts → create one (no roles
   needed). Then, in Google Drive, add its email to the Shared Drive as a
   **Content manager** — it renames, moves and creates shortcuts.
5. **Workload Identity Federation:** IAM & Admin → Workload Identity
   Federation → create **one pool** with **two OIDC providers**, and let both
   impersonate the service account (grant `Workload Identity User` on the
   service account to each provider's principals):
   - **GitHub Actions** — follow
     [google-github-actions/auth](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account);
     restrict it to your fork with an attribute condition such as
     `assertion.repository == '<owner>/<repo>'`.
   - **Vercel** — follow [Vercel's GCP guide](https://vercel.com/docs/oidc/gcp):
     issuer `https://oidc.vercel.com/<team-slug>`, allowed audience
     `https://vercel.com/<team-slug>`. The team slug is the part after
     `vercel.com/` in your Vercel dashboard URL.

   Note the pool ID and both provider IDs.

## 4. Vercel

1. **Import your fork** in Vercel. Production deploys `main`.
2. **Settings → Environment Variables** — add:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Step 2.3 |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Step 3.3 |
   | `GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL` | Steps 3.1, 3.4 |
   | `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | Step 3.5 — the **Vercel** provider |
   | `VERCEL_TEAM_SLUG` | Your team slug. **Vercel doesn't set this for you**; without it every Drive call fails |
   | `GEMINI_API_KEY` | Optional — from [Google AI Studio](https://aistudio.google.com/apikey); powers semantic search and Namer analysis |
   | `GITHUB_TOKEN`, `GITHUB_REPO` | Optional — for the Sync Now button (step 5.2) |
   | `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS` | Optional — comma-separated app-level allowlist; required if the consent screen is published |

3. Check **Settings → Security → OIDC Federation** is enabled with the *Team*
   issuer mode (the default for new projects).
4. Deploy, then in Supabase → Authentication → URL Configuration set the
   **Site URL** to the production URL and add `<production URL>/auth/callback`
   to the redirect URLs.

## 5. GitHub Actions (the scheduled sync)

1. In your fork, **Settings → Secrets and variables → Actions**:
   - **Secrets:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`, and optionally `GEMINI_API_KEY` (without it
     the sync skips embeddings and search falls back to keywords).
   - **Variables:** `GCP_PROJECT_NUMBER`, `GCP_WIF_POOL_ID`,
     `GCP_WIF_PROVIDER_ID` (the **GitHub** provider), `GCP_SERVICE_ACCOUNT_EMAIL`.
2. **Sync Now (optional):** create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens)
   for your fork with **Actions: Read and write**, and set it in Vercel as
   `GITHUB_TOKEN`, with `GITHUB_REPO` = `<owner>/<repo>`. The button dispatches
   the workflow on `main`. Tokens expire — note the date.

## 6. Configure and run the first sync

Sign in to the deployed app, then in **Settings → Advanced**:

1. **Shared Drive ID** — the ID after `/folders/` when the drive is open in
   Google Drive.
2. **Sync Folders** — the top-level folders that make up the library (see
   "Which folders are in Relay" in the README). Set this *before* syncing:
   with no list, Relay syncs the whole drive.

Then **Actions → Daily Sync → Run workflow**, with `dry_run` checked first: it
writes nothing and attaches the planned changes to the run as an artifact.
Run it again without `dry_run` to fill the library. After that it runs every 6
hours on its own (edit the `cron:` line in `.github/workflows/daily-sync.yml`
to change that). The first run on a big drive may take a couple of runs to
finish thumbnails — they're time-boxed and pick up where they left off.

Every run is recorded in **Settings → Recent Activity**.

## Optional: rights badges (Drive Labels)

Rights badges read a [Drive Label](https://support.google.com/a/answer/9292382)
created in Google Workspace admin → Labels, with four fields:

| Field | Type |
|---|---|
| Organic Rights | Selection |
| Organic Expiration | Date |
| Paid Rights | Selection |
| Paid Expiration | Date |

Name the selection choices however you like ("Perpetual", "1-Year License",
"Revoked"…); Relay maps each to `unlimited` (green), `limited` (amber, check
the expiry) or `expired` (red). Publish the label, and make sure the service
account can read and apply it.

In **Settings → Advanced → Google Drive Labels**, enter the label ID, the four
field IDs (**Field Mappings**) and each choice ID with its status (**Choice
Mappings**). The label ID is in the label's URL in the Labels manager; once
it's saved, `/api/namer/labels` (opened in the browser while signed in) lists
its field and choice IDs. Extra labels for the Namer to read and apply (e.g.
"Content Tags") go under **Additional Namer Labels**. Badges appear after the
next sync. Without a label, assets show "Not Labeled" and the rights filter is
inactive.

## Optional: the Asset Namer

In the **Asset Namer** tab, open its **Settings** (gear button) and define naming schemas (date, creator, product,
counters…), the dropdown lists they draw from, and — with a Gemini key — the
prompts for image analysis. Names are written to round-trip through the
filename parser (`src/lib/filename-utils.ts`), which also feeds search; the
built-in conventions are date-first (`YYYYMMDD_Creator_Description_001.jpg`)
and brand-first (`$Brand_Description_$Tag_001.jpg`).

## Hosting somewhere other than Vercel

The keyless service-account login in the app uses Vercel's OIDC tokens. On
another Node host, set `USE_SERVICE_ACCOUNT=true` and provide Application
Default Credentials for the service account (e.g. `GOOGLE_APPLICATION_CREDENTIALS`
pointing at a key file); sign-in will then also ask users for Drive access.
This path is not regularly tested.

## Upgrading

Pull the new code, then apply any new files in `supabase/migrations/` in date
order in the SQL Editor **before** deploying — the
[migrations README](../supabase/migrations/README.md) says which are required.
Every migration is safe to re-run.
