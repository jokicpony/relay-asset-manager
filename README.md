# Relay Asset Manager

A fast visual and semantic layer on top of Google Drive. Browse, search, name
and distribute a team's photos and videos — without moving them out of their
Shared Drive.

Drive's own interface makes it painful to browse thousands of images visually,
search by concept, or keep naming consistent. Relay indexes one Shared Drive
into a database with thumbnails and AI search embeddings, and sends every
change (rename, relay, download) back to Drive. Drive stays the source of
truth; Relay never stores the files themselves.

## Features

- **Browse** — the Shared Drive's folders as a fast thumbnail grid, with
  filters (type, orientation, rights) and sort; filter state lives in the URL,
  so views can be shared.
- **Semantic search** — find assets by meaning ("golden hour camping"), not
  just filename, using Gemini multimodal embeddings of each thumbnail plus its
  name and folder. Falls back to keyword matching.
- **Asset Namer** — batch rename, file, label and describe new uploads using
  configurable naming schemas, with optional Gemini image analysis. Results
  appear in the library within minutes.
- **Relays** — put an asset into project folders as Drive shortcuts, without
  duplicating the file.
- **Rights badges** — organic/paid usage rights and expiry dates, read from a
  Google Drive Label.
- **Pinboard, bulk download and relay** — collect assets, download them as
  individual files or a streamed zip, or relay them in one go.
- **Video preview** — play videos in the browser, streamed from Drive.
- **Trash** — assets that leave the library stay restorable for 14 days.

## How it works

```
Google Shared Drive ──▶ Daily Sync (GitHub Actions, every 6h) ──▶ Supabase
        ▲                 metadata, thumbnails, embeddings         │ (database, thumbnails,
        │                                                          │  sign-in)
        └── renames, relays, downloads ◀── Next.js app on Vercel ◀─┘
```

Next.js 16 · React 19 · Tailwind CSS 4 · Supabase · Google Drive API v3 ·
Gemini · Vercel · GitHub Actions. All Drive access goes through a Google
service account with no stored keys (Workload Identity Federation). The full
picture — the sync's steps, the Namer's ingest, relays, permissions and the
rules that keep it consistent — is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What you need

- A **Google Workspace** account with a **Shared Drive** holding the assets
  (Drive Labels, for rights badges, need a Workspace edition that supports
  them — optional).
- A **Google Cloud** project, a **Supabase** project, a **Vercel** account and
  a **GitHub** repository (your fork). Free tiers are enough to start.
- A **Gemini API key** for semantic search and Namer analysis — optional.

**[docs/SETUP.md](docs/SETUP.md) walks through building your own instance**,
start to finish.

## Which folders are in Relay

Relay looks at **one Google Shared Drive**, and inside it only at the
**top-level folders you list as Sync Folders**. Everything below those folders
— photos and videos only — is the library. Files anywhere else in the drive
(other top-level folders, the drive's root) are ignored.

| You want to… | Do this | What happens |
|---|---|---|
| Choose what the library is | **Settings → Advanced → Sync Folders**: the names of top-level folders in the Shared Drive (not case-sensitive) | The next sync adds everything under them |
| Leave out one folder inside the library (drafts, raw files…) | In Google Drive, add `[relay-ignore]` anywhere in that folder's **description** (folder ⓘ → Details → Description) | That folder *and everything under it* is excluded. Assets already in Relay go to the Trash and are **permanently removed after 14 days**; delete the tag before then to bring them back |
| Keep a folder out of the main view without removing it | Click the **eye icon** next to a top-level folder in the sidebar | Its assets no longer appear in All Folders (browsing or search) but are still there when you open that folder. Applies to everyone |
| Stop syncing a whole top-level folder | Remove it from **Sync Folders** | Its assets move to the Trash but are **kept indefinitely**, and come back if you add the folder again |

Things to know:

- **Changes take effect on the next sync** (every 6 hours, or Settings → Sync
  Now).
- **Moving a file** to another folder inside the library just updates it.
  Moving it **out** of the synced folders, or deleting it in Drive, sends it to
  the Trash for 14 days, then removes it. Trashed assets can be restored from
  Settings → Trash until then.
- **Don't rename a synced top-level folder** without updating Sync Folders to
  match: Sync Folders are matched by name, so to Relay a renamed folder looks
  as if every file in it was deleted. A safety limit stops any sync that would
  trash more than 100 assets or 10% of the library (whichever is larger) and
  explains why in Settings → Recent Activity — rename the folder back, or
  update Sync Folders.
- **Relays** (shortcuts) can only be created in folders inside the library,
  and disappear from Relay when the shortcut is deleted or its folder moves out.

## Documentation

| Doc | Read it when |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Building your own instance |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | You want to understand or change how Relay works |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Running an instance: users, upgrades, fixing a failed sync |
| [supabase/migrations/README.md](supabase/migrations/README.md) | Upgrading or changing the database |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Sending a change |
| [CLAUDE.md](CLAUDE.md) | Conventions and gotchas for AI coding agents (useful for people too) |

## Local development

Requires Node.js 22 (what CI uses) and a Supabase project with the schema
applied ([SETUP.md](docs/SETUP.md) steps 1–2).

```bash
git clone https://github.com/<you>/relay-asset-manager.git
cd relay-asset-manager
npm install
cp .env.example .env.local   # Supabase + Google OAuth values; see SETUP.md
npm run dev                  # http://localhost:3000
```

Settings (shared drive, sync folders, labels, Namer schemas) live in the
database and are edited in the app's Settings; env vars are only credentials.
If `.env.local` points at the same Supabase project as your deployment, local
writes are real.

Drive access locally:

- By default the app uses **your own Google sign-in** (it asks for Drive
  access when you log in locally), so you see what your account can see.
- To act as the service account, set `USE_SERVICE_ACCOUNT=true` and log in with
  `gcloud auth application-default login --impersonate-service-account=<sa-email>`
  (without the impersonation flag you're still using your personal account).
- `scripts/sync.ts` only picks those credentials up when
  `GOOGLE_APPLICATION_CREDENTIALS` is set, and needs the service-role key even
  for a dry run:

```bash
npm run lint && npm test && npx tsc --noEmit    # what CI runs
GOOGLE_APPLICATION_CREDENTIALS=~/.config/gcloud/application_default_credentials.json \
  npx tsx scripts/sync.ts --dry-run --dry-run-out=plan.json   # what a sync would change
npx tsx scripts/embed.ts                        # embed assets missing embeddings (--force: all)
```

## License

[MIT](LICENSE)
