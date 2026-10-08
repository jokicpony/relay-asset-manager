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

## 1. Make a private copy of the repository

Use a **private** repository, not a public fork: the sync's GitHub Actions
logs and dry-run artifacts list your folder and file names, and on a public
repository anyone can read them (a fork of a public repo can't be made
private). Either use GitHub's **Import repository** with this repo's URL, or:

```bash
git clone --bare https://github.com/jokicpony/relay-asset-manager.git
cd relay-asset-manager.git
git push --mirror git@github.com:<you>/<your-private-repo>.git
```

Then clone your private repo and add this one as `upstream`, for upgrades:
`git remote add upstream https://github.com/jokicpony/relay-asset-manager.git`.

## 2. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor:** paste and run all of `supabase/schema.sql`. It creates the
   tables, row-level security, the `thumbnails` storage bucket and the
   `match_assets` search function, and is safe to re-run.
3. **Project Settings → API Keys:** note the project URL, the `anon` key and
   the `service_role` key (newer projects list these under *Legacy API keys*).
   Keep the service-role key secret — it bypasses row-level security.
4. **Authentication → Providers → Google:** turn it on; you'll paste the
   client ID and secret from step 3.3. Copy the **Callback URL** it shows
   (`https://<project-ref>.supabase.co/auth/v1/callback`).
5. **Authentication → URL Configuration:** add
   `http://localhost:3000/auth/callback` to the redirect URLs (you'll add the
   production one in step 4).

## 3. Google Cloud

1. **Create a project** in the [Cloud Console](https://console.cloud.google.com)
   and enable the **Google Drive API**, the **IAM Service Account Credentials
   API** and the **Security Token Service API** (those two are what WIF
   uses), plus the **Drive Labels API** if you'll use rights badges. Note the
   project *number* (Dashboard → Project info).
2. **Google Auth Platform** (formerly "OAuth consent screen") — this decides
   who can sign in. Pick an audience:
   - **Internal** — everyone in your Workspace can sign in. Simplest for a
     company tool.
   - **External, left in Testing** — only the accounts you add under
     **Audience → Test users** can sign in (up to 100); everyone else gets
     "403: access_denied". Good for a small team or people outside your
     Workspace.

   Don't publish an External app: any Google account could then sign in. The
   `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` allowlist only guards the
   app's pages and API — row-level security still lets any signed-in account
   read the tables directly through Supabase's API.
3. **Clients → Create client** (Web application), with the Supabase callback
   URL from step 2.4 as an authorized redirect URI. Paste the client ID and
   secret into Supabase (step 2.4), and keep them for your local `.env.local`.
4. **Service account:** IAM & Admin → Service accounts → create one (no
   project roles needed). Then, in Google Drive, add its email to the Shared
   Drive as a **Content manager** — it renames, moves and creates shortcuts.
   If Drive refuses the address, allow members from outside your organisation
   on that Shared Drive (service accounts count as external).
5. **Workload Identity Federation:** IAM & Admin → Workload Identity
   Federation → create **one pool** with **two OIDC providers**. Then give
   each provider's identities the **Workload Identity User** role on the
   service account (Service account → Permissions → Grant access). Bindings
   name the pool, narrowed by an attribute — never grant the whole pool.
   - **GitHub Actions** ([guide](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account)):
     issuer `https://token.actions.githubusercontent.com`; attribute mapping
     `google.subject=assertion.sub`, `attribute.repository=assertion.repository`;
     condition `assertion.repository == '<owner>/<repo>'`; principal
     `principalSet://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/attribute.repository/<owner>/<repo>`.
   - **Vercel** ([guide](https://vercel.com/docs/oidc/gcp)): issuer
     `https://oidc.vercel.com/<team-slug>`; allowed audience
     `https://vercel.com/<team-slug>`; attribute mapping
     `google.subject=assertion.sub`; principal for your production deployment,
     `principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/subject/owner:<team-slug>:project:<project-name>:environment:production`.
     The team slug is the part after `vercel.com/` in your dashboard URL.

   Note the pool ID and both provider IDs.

## 4. Vercel

Vercel's Hobby plan is for non-commercial use; a company tool needs Pro.

1. **Import your repository** in Vercel (production deploys `main`) and add
   the environment variables below on the import screen — or add them
   afterwards and **Redeploy**: variables only reach new deployments, and the
   `NEXT_PUBLIC_*` ones are baked in at build time.

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Step 2.3 |
   | `GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL` | Steps 3.1, 3.4 |
   | `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | Step 3.5 — the **Vercel** provider |
   | `VERCEL_TEAM_SLUG` | Your team slug. **Vercel doesn't set this for you**, and without it every Drive call fails |
   | `GEMINI_API_KEY` | Optional — from [Google AI Studio](https://aistudio.google.com/apikey); powers semantic search and Namer analysis |
   | `GITHUB_TOKEN`, `GITHUB_REPO` | Optional — for the Sync Now button (step 5.2) |
   | `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS` | Optional — comma-separated app-level allowlist (see step 3.2 for its limits) |

   Sign-in uses the OAuth client stored in Supabase; `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` are only needed locally.
2. Check **Settings → Security → OIDC Federation** is enabled with the *Team*
   issuer mode (the default for new projects).
3. In Supabase → Authentication → URL Configuration, set the **Site URL** to
   the production URL and add `<production URL>/auth/callback` to the
   redirect URLs.

## 5. GitHub Actions (the scheduled sync)

1. In your repository, **Settings → Secrets and variables → Actions**:
   - **Secrets:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
     and optionally `GEMINI_API_KEY` (without it the sync skips embeddings and
     search falls back to keywords).
   - **Variables:** `GCP_PROJECT_NUMBER`, `GCP_WIF_POOL_ID`,
     `GCP_WIF_PROVIDER_ID` (the **GitHub** provider), `GCP_SERVICE_ACCOUNT_EMAIL`.
2. **Sync Now (optional):** create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens)
   whose resource owner owns the repo, with access to that repo only and
   **Actions: Read and write**. Set it in Vercel as `GITHUB_TOKEN`, with
   `GITHUB_REPO` = `<owner>/<repo>`, and redeploy. The button dispatches the
   workflow on `main`. Tokens expire — note the date.

## 6. Configure and run the first sync

Sign in to the deployed app, open the avatar menu (top right) → **Sync &
Settings** → **Advanced Configuration**, and set:

1. **Shared Drive ID** — the ID after `/folders/` when the drive is open in
   Google Drive.
2. **Sync Folders** — the top-level folders that make up the library (see
   "Which folders are in Relay" in the README). Set this *before* syncing:
   with no list, Relay syncs the whole drive.

Then **Actions → Daily Sync → Run workflow**, with **Dry run** checked first:
it writes nothing and attaches the planned changes to the run as an artifact.
Run it again without it to fill the library. After that it runs every 6 hours
on its own (the `cron:` line in `.github/workflows/daily-sync.yml`; the
"Sync overdue" warning fires after 13 hours, so keep the interval shorter).
Until the first real sync, the header shows "Sync overdue".

Thumbnails are time-boxed, so on a big drive the first runs may not finish
them all, and assets embedded before their thumbnail exists are embedded from
text only. Once a run reports no thumbnails left, run
`npx tsx scripts/embed.ts --force` locally (see the README) so every asset is
embedded with its image.

Every real run is recorded in **Settings → Recent Activity**.

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

In **Advanced Configuration → Google Drive Labels**, enter the label ID, the
four field IDs (**Field Mappings**) and each choice ID with its status
(**Choice Mappings**). The label ID is in the label's URL in the Labels
manager; once it's saved, `/api/namer/labels` (opened in the browser while
signed in) lists its field and choice IDs. Extra labels for the Namer to read
and apply (e.g. "Content Tags") go under **Additional Namer Labels**. Badges
appear after the next sync. Without a label, assets show "Not Labeled" and the
rights filter is inactive.

## Optional: the Asset Namer

In the **Asset Namer** tab, open its **Settings** (gear button) and define
naming schemas (date, creator, product, counters…), the dropdown lists they
draw from, and — with a Gemini key — the prompts for image analysis. Names are
written to round-trip through the filename parser
(`src/lib/filename-utils.ts`), which also feeds search; the built-in
conventions are date-first (`YYYYMMDD_Creator_Description_001.jpg`) and
brand-first (`$Brand_Description_$Tag_001.jpg`).

## Hosting somewhere other than Vercel

The keyless service-account login in the app uses Vercel's OIDC tokens. On
another Node host, leave the four `GCP_*` variables **unset** (when they're
set, the app always tries Vercel's WIF), set `USE_SERVICE_ACCOUNT=true`, and
provide Application Default Credentials for the service account (e.g.
`GOOGLE_APPLICATION_CREDENTIALS` pointing at a key file). Sign-in will then
also ask users for Drive access. This path is not regularly tested.

## Upgrading

See [OPERATIONS.md → Upgrading](OPERATIONS.md#upgrading): apply new database
migrations **before** the new code reaches `main`.
