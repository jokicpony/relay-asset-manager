# Relay Asset Manager — Project Conventions

## Tech Stack

- **Framework**: Next.js 16 (App Router) with React 19
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS 4 + custom CSS variables (`--ram-*` prefix in `src/app/globals.css`)
- **Database**: Supabase (Postgres + pgvector for semantic search)
- **Storage**: Supabase Storage (thumbnail cache)
- **Auth**: Supabase Auth with Google OAuth
- **Drive Access**: Google Drive API v3 (3-tier auth: WIF, ADC, or user OAuth)
- **AI**: Gemini API (embeddings for search, Flash for asset analysis)

## Directory Structure

```
src/
  app/           — Next.js pages + API routes
  components/    — React UI components (namer/ subdirectory for Asset Namer module)
  hooks/         — Custom React hooks
  lib/           — Shared utilities and business logic
    google/      — Drive auth (WIF + OAuth + ADC)
    supabase/    — Client, server, middleware helpers
    sync/        — Sync pipeline (crawler, upsert, thumbnails)
    namer/       — Namer types and utilities
  types/         — TypeScript interfaces
supabase/
  schema.sql     — Complete database schema (run in SQL Editor)
scripts/
  sync.ts        — CLI sync pipeline (also invoked by GitHub Actions)
  embed.ts       — Batch embedding generation
```

## Key Patterns

- **DB-backed configuration**: Most operational settings live in the `app_settings` table (key-value with JSONB values), editable from the Settings UI. Environment variables serve as fallback defaults. See `src/lib/config.ts`.
- **Google auth tiers**: Production uses Workload Identity Federation via `@vercel/oidc`. Local testing uses ADC (`USE_SERVICE_ACCOUNT=true`). Local dev falls back to the user's OAuth token from the Supabase session. See `src/lib/google/auth.ts`.
- **CSS variables**: All theme colors use the `--ram-` prefix. Defined in `src/app/globals.css` `:root`. Components reference these via inline styles or Tailwind arbitrary values.
- **No external state management**: App state is managed with React hooks (useState, useCallback, useRef, useEffect) in `src/app/page.tsx`. No Redux/Zustand.

## Commands

```bash
npm run dev        # Start dev server
npm run build      # Production build
npm run lint       # ESLint check
npx tsx scripts/sync.ts              # Run sync pipeline
npx tsx scripts/sync.ts --skip-thumbnails  # Sync without thumbnail processing
npx tsx scripts/embed.ts             # Generate embeddings for assets missing them
npx tsx scripts/embed.ts --force     # Regenerate all embeddings
```

## Commit Style

Use prefixes: `feat:`, `fix:`, `ui:`, `refactor:`, `docs:`, `chore:`. Keep subject lines under 72 characters.
