# Setup Guide

This walks through connecting Relay to its external services: Supabase, Google Cloud, and optionally Gemini and Drive Labels. Most steps involve creating accounts and copying IDs into your `.env.local` file.

## 1. Supabase

Supabase provides the database, auth, and thumbnail storage.

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and paste the entire contents of `supabase/schema.sql`, then click **Run**. This creates:
   - `assets` table with pgvector embeddings column
   - `shortcuts` table for Drive shortcut tracking
   - `sync_logs` table for sync history
   - `app_settings` table for UI-editable configuration
   - Row-level security policies
   - A `thumbnails` storage bucket
   - The `match_assets` function for semantic search
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret key** → `SUPABASE_SERVICE_ROLE_KEY`

### Auth Provider

4. Go to **Authentication → Providers → Google**
5. Toggle it on and add your Google OAuth client ID and secret (created in the next section)
6. Copy the **Callback URL** shown — you'll need it when creating Google OAuth credentials

## 2. Google Cloud

Google Cloud provides Drive API access and OAuth.

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a project (or use an existing one)
2. Enable the **Google Drive API** (APIs & Services → Enable APIs)
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URI: paste the Supabase callback URL from step 6 above
4. Copy the **Client ID** and **Client Secret**:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`

### OAuth Consent Screen

5. Go to **APIs & Services → OAuth consent screen** and configure it:
   - **Internal** (Google Workspace only) — any user in your organization can sign in without additional setup. Best for company-internal deployments.
   - **External** — required if users are outside your Workspace org. Starts in **Testing** mode, which means only users you explicitly add as test users can sign in (everyone else gets a 403). To allow anyone to sign in, click **Publish App**. Google may require a verification review for apps requesting sensitive scopes.

   > **Common gotcha:** If users can't sign in and see a "403: access_denied" error, check that the app isn't still in Testing mode, or add their Google account under **OAuth consent screen → Test users**.

### Shared Drive ID

5. Open your Google Shared Drive in a browser. The URL looks like:
   ```
   https://drive.google.com/drive/u/0/folders/0AOo...9PVA
   ```
   The ID after `/folders/` is your `GOOGLE_SHARED_DRIVE_ID`. You can set this in `.env.local` for local dev, or configure it later in **Settings → Advanced** (which writes it to the database).

## 3. Environment File

```bash
cp .env.example .env.local
```

Fill in the values from steps 1-2. The required variables for a basic local setup are:

| Variable | Source |
|----------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page (secret) |
| `GOOGLE_CLIENT_ID` | Google Cloud → Credentials |
| `GOOGLE_CLIENT_SECRET` | Same page |
| `GOOGLE_SHARED_DRIVE_ID` | Your Shared Drive URL |

Everything else is optional for getting started.

## 4. Run & First Sync

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with Google, then go to **Settings → Sync** and trigger a sync. Your Drive assets will appear within a few minutes.

---

## Optional: Gemini (Semantic Search)

Without Gemini, text search uses client-side keyword matching. With it, you get vector-based semantic search ("golden hour camping" finds relevant photos even if the filename doesn't match).

1. Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Set `GEMINI_API_KEY` in `.env.local`
3. Run a sync — embeddings are generated automatically

## Optional: Google Drive Labels (Rights Tracking)

Drive Labels let you attach structured metadata to files in Google Drive — things like usage rights, licensing status, and expiration dates. Relay reads these labels during sync and displays visual compliance badges on each asset.

### Recommended Label Structure

Create a Drive Label in your Google Workspace admin with these fields:

| Field Name | Type | Purpose |
|------------|------|---------|
| **Organic Rights** | Selection (dropdown) | Usage rights for organic/editorial content |
| **Organic Expiration** | Date | When organic rights expire |
| **Paid Rights** | Selection (dropdown) | Usage rights for paid/advertising content |
| **Paid Expiration** | Date | When paid rights expire |

For the **Selection** fields, create choices that map to these three statuses:

| Choice | Meaning | Badge Color |
|--------|---------|-------------|
| Unlimited | Perpetual usage rights | Green |
| Limited | Time-bound usage rights (check expiration) | Amber |
| Expired | Rights have lapsed, do not use | Red |

You can name the choices whatever makes sense for your team (e.g., "Perpetual", "1-Year License", "Revoked") — the mapping to unlimited/limited/expired happens in Relay's settings.

### Connecting the Label to Relay

1. **Enable the Drive Labels API** in your Google Cloud project
2. **Set the Rights Label ID** — In Relay, go to **Settings → Advanced → Google Drive Labels** and paste your label ID. To find it, use the `/api/namer/labels` endpoint (accessible when signed in).
3. **Map field IDs** — In the same Settings section under **Field Mappings**, enter the field IDs for Organic Rights, Organic Expiration, Paid Rights, and Paid Expiration. The `/api/namer/labels` endpoint returns these.
4. **Map choice IDs** — Under **Choice Mappings**, add each dropdown choice ID and map it to `unlimited`, `limited`, or `expired`.
5. **Run a sync** — Rights data will be pulled from Drive and displayed as badges on each asset.

> You can also add extra labels for the Namer to read (e.g., "Content Tags") under **Additional Namer Labels** in the same settings section.

## Optional: GitHub Actions (Automated Sync)

See the [GitHub Actions section](../README.md#github-actions-automated-sync) in the README for setting up scheduled syncs with Workload Identity Federation.

## Optional: Vercel Deployment

For production hosting on Vercel:

1. Push your repo to GitHub and import it in [Vercel](https://vercel.com)
2. Add all environment variables from `.env.example` to Vercel's Environment Variables settings
3. Additionally set `VERCEL_TEAM_SLUG` to your Vercel team slug (from your dashboard URL — this is **not** automatically exposed by Vercel)
4. For server-side Drive access, configure WIF environment variables (`GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`)
