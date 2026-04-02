# Relay Asset Manager

A high-performance visual and semantic layer on top of Google Drive. Browse, search, organize, and distribute creative assets — all synced from your team's Shared Drive.

**Why this exists:** Creative teams store thousands of photos and videos in Google Shared Drives, but Drive's native interface makes it painful to browse visually, search by concept, or manage naming conventions at scale. Relay indexes your Drive into a fast, searchable database with AI-powered semantic search, thumbnail previews, batch renaming, and compliance tracking — without moving your files out of Drive.

## ✨ Features

- **Google Drive Sync** — Automatically indexes photos and videos from your Shared Drive with thumbnail generation, metadata extraction, and folder structure preservation
- **Semantic Search** — AI-powered search using Gemini embeddings. Find assets by concept ("golden hour camping") instead of exact filenames
- **Asset Namer** — Batch rename and tag files in Google Drive with configurable naming schemas, AI-assisted metadata, and Drive Label integration
- **Relay (Shortcuts)** — Create Google Drive shortcuts to organize assets into project folders without duplicating files
- **Rights & Compliance** — Visual badges showing organic/paid usage rights and expiration dates, pulled from Google Drive Labels
- **Pinboard** — Pin assets to a session-scoped collection for comparison and bulk actions
- **Bulk Actions** — Multi-select assets for batch download (individual files or zipped), relay to project folders, or trash
- **Video Streaming** — Preview videos directly in the browser with adaptive streaming
- **Shareable URLs** — Filter state (folder, sort, type, orientation) is encoded in the URL for team sharing

## 🏗 Architecture

```
Google Drive (Shared Drive)
        │
        ▼
   Sync Pipeline ──────▶ Supabase (Postgres + pgvector)
   (API routes)                    │
        │                          ▼
        ▼                    Next.js Frontend
   Supabase Storage         (React 19 + Tailwind)
   (thumbnails)
        │
        ▼
   Gemini API
   (embeddings)
```

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| Backend | Next.js API Routes (serverless) |
| Database | Supabase (Postgres + pgvector for semantic search) |
| Storage | Supabase Storage (thumbnail cache) |
| Auth | Supabase Auth with Google OAuth |
| Drive Access | Google Drive API v3 (user OAuth or WIF service account) |
| AI | Gemini API (multimodal embeddings + asset analysis) |
| Hosting | Vercel (or any Node.js host) |

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+
- **Supabase** project ([create one free](https://supabase.com))
- **Google Cloud** project with Drive API enabled
- **Google Shared Drive** containing your asset library

> **Detailed walkthrough:** See [docs/SETUP.md](docs/SETUP.md) for step-by-step instructions on configuring Supabase, Google Cloud, Drive Labels, and Vercel.

### 1. Clone & Install

```bash
git clone https://github.com/jokicpony/relay-asset-manager.git
cd relay-asset-manager
npm install
```

### 2. Set Up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the full schema:

```bash
# Copy the contents of supabase/schema.sql and paste into the SQL Editor
```

3. Enable **Google** as an auth provider:
   - Go to **Authentication → Providers → Google**
   - Add your Google OAuth client ID and secret
   - Set the redirect URL to `http://localhost:3000/auth/callback`

### 3. Set Up Google Cloud

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Enable the **Google Drive API**
3. Create **OAuth 2.0 credentials** (Web application type)
   - Authorized redirect URI: your Supabase auth callback URL (found in Supabase Dashboard → Auth → URL Configuration)
4. Note your **Client ID** and **Client Secret**

### 4. Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Supabase credentials, Google OAuth keys, and Shared Drive ID. See `.env.example` for detailed descriptions of each variable.

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with Google.

### 6. Initial Sync

After signing in, go to **Settings → Sync** and trigger a manual sync to index your Drive assets. The sync pipeline will:

1. Crawl your configured Shared Drive folders
2. Extract metadata and generate thumbnails
3. Store everything in Supabase
4. Generate Gemini embeddings for semantic search (if API key is configured)

## 📁 Project Structure

```
src/
├── app/
│   ├── api/                    # Next.js API routes
│   │   ├── assets/             # Thumbnail serving
│   │   ├── drive/              # Download, stream, shortcuts, folders
│   │   ├── namer/              # Asset naming pipeline
│   │   ├── search/             # Semantic search endpoint
│   │   ├── settings/           # App configuration
│   │   ├── sync/               # Drive ↔ Supabase sync pipeline
│   │   └── trash/              # Soft delete management
│   ├── auth/                   # OAuth callback handler
│   ├── login/                  # Login page
│   └── page.tsx                # Main app (Browse + Namer views)
├── components/
│   ├── namer/                  # Asset Namer module (11 components)
│   ├── ActionBar.tsx           # Bulk action toolbar
│   ├── AssetCard.tsx           # Grid card with thumbnail
│   ├── ExpandedAssetView.tsx   # Full-screen asset preview
│   ├── FolderSidebar.tsx       # Folder tree navigation
│   ├── SearchBar.tsx           # Search with semantic indicators
│   └── ...
├── lib/
│   ├── google/                 # Drive auth (WIF + OAuth + ADC)
│   ├── supabase/               # Client, server, middleware helpers
│   ├── sync/                   # Sync pipeline (crawler, upsert, thumbnails)
│   ├── config.ts               # DB-backed app configuration
│   └── filename-utils.ts       # Filename parsing conventions
└── types/                      # TypeScript interfaces
supabase/
└── schema.sql                  # Complete database schema (run this)
```

## ⚙️ Configuration

Most operational settings are editable from the **Settings** panel in the UI, which persists to the `app_settings` table. This includes:

| Setting | Description |
|---------|-------------|
| Shared Drive ID | The Google Shared Drive to sync from |
| Sync Folders | Which top-level folders to index |
| Drive Label ID | Google Drive Label for rights/compliance tracking |
| Hidden Folders | Folders to exclude from the "All Folders" view |
| Namer Schemas | Configurable naming templates with field types |
| Namer Dropdowns | Option lists for select fields in naming schemas |
| AI Config | Gemini prompts for asset analysis |

Environment variables serve as fallback defaults — see `.env.example` for the complete list.

## 🔌 Optional Features

Relay works out of the box as a Drive browser and asset organizer. The features below are optional and can be enabled as needed.

### Google Drive Labels (Rights & Compliance)

Relay can pull usage rights data from [Google Drive Labels](https://support.google.com/a/answer/9292382) and display visual compliance badges on each asset. This is powerful for teams managing content licensing (e.g., organic vs. paid usage rights with expiration dates).

**To set up:**

1. **Create a Drive Label** in your Google Workspace admin with fields for rights tracking
2. **Enable the Drive Labels API** in your Google Cloud project
3. **Configure in Settings → Advanced → Google Drive Labels** — set the label ID, map field IDs, and map choice values to `unlimited` / `limited` / `expired`

See [docs/SETUP.md](docs/SETUP.md#optional-google-drive-labels-rights-tracking) for the recommended label structure and a step-by-step walkthrough.

> **Without Drive Labels:** Everything works fine — assets will show "Not Labeled" badges and the compliance filter will be inactive.

### Semantic Search (Gemini)

Relay uses multimodal Gemini embeddings (768-dimension vectors) stored in pgvector for concept-based search. Users can search by meaning ("golden hour camping") instead of exact filenames.

**How it works:**

The embedding pipeline builds a rich text description for each asset by parsing its filename, folder path, and metadata. Relay recognizes three filename conventions:

- **Date-first** — `YYYYMMDD_Creator_Description_001.jpg` → extracts date, creator, and shoot description
- **Brand-first** — `$BrandName_Description_$Tag_001.jpg` → extracts brand, description, and tags
- **Generic** — falls back to the raw filename

These parsed fields are composed into a single embedding string:

```
[filename] | [shoot_description] | by [creator] | [asset_type] | [folder_path] | [description]
```

The pipeline then sends both this text and the asset's thumbnail image to `gemini-embedding-2-preview` as a multimodal embedding request. The resulting 768-dimension vector captures both visual and textual meaning — so a photo of a mountain lake gets an embedding that reflects both its filename metadata and what's actually in the image.

**Cross-modal search:** At query time, a text-only embedding is generated for the user's search query and matched against these multimodal document embeddings using pgvector cosine similarity. This means text queries like "red kayak on a lake" can find relevant photos even if the filename says `IMG_4521.jpg`.

**To set up:**

1. **Get a Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)
2. **Set `GEMINI_API_KEY`** in `.env.local`
3. **Run a sync** — embeddings are generated automatically during the sync pipeline
4. **Batch generate** — Run `npx tsx scripts/embed.ts` to generate embeddings for existing assets, or `--force` to regenerate all

> **Without Gemini:** Text search still works via client-side keyword matching on filenames, descriptions, and tags.

### Asset Namer

The Namer module provides a batch renaming workflow with configurable naming schemas, dropdown options, and optional AI-powered metadata extraction.

**To set up:**

1. **Configure naming schemas** — Go to Settings and define naming templates with fields like date, creator, product, and auto-incrementing counters
2. **Add dropdown options** — Populate the select field option lists (photographers, products, etc.)
3. **Enable AI analysis (optional)** — With a Gemini API key, the Namer can analyze images and suggest metadata (environment, lighting, objects, etc.)

Schemas and dropdowns are stored in the `app_settings` table and fully configurable from the UI.

### GitHub Actions (Automated Sync)

The included workflow (`.github/workflows/daily-sync.yml`) runs the sync pipeline on a cron schedule (every 6 hours by default). It uses Google Cloud Workload Identity Federation for keyless authentication.

**To set up:**

1. **Configure WIF** in your GCP project — create a Workload Identity Pool and Provider for GitHub Actions ([docs](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account))
2. **Add repository variables** in GitHub (Settings → Secrets and variables → Actions → Variables):
   - `GCP_PROJECT_NUMBER` — your GCP project number
   - `GCP_WIF_POOL_ID` — Workload Identity Pool ID
   - `GCP_WIF_PROVIDER_ID` — Workload Identity Provider ID
   - `GCP_SERVICE_ACCOUNT_EMAIL` — service account email with Drive access
3. **Add repository secrets** (same page, Secrets tab):
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY` (optional, for semantic search embeddings)
   > Operational config (Shared Drive ID, sync folders, label ID) is loaded from the database at runtime — configure these in Settings → Advanced.

> **Without GitHub Actions:** Run syncs manually from the Settings panel in the UI, or via `npx tsx scripts/sync.ts`.

## 🔐 Authentication

Relay supports a 3-tier Google auth strategy:

1. **Production (Vercel)** — Workload Identity Federation via `@vercel/oidc` for keyless service account access to Drive
2. **Local Testing** — Application Default Credentials via `gcloud auth` with service account impersonation
3. **Local Dev** — User's Google OAuth token from the Supabase session (zero setup)

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, commit conventions, and PR guidelines.

## 📄 License

[MIT](LICENSE)
