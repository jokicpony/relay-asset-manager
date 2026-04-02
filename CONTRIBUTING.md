# Contributing to Relay Asset Manager

Thanks for your interest in contributing! This guide covers how to get set up and submit changes.

## Prerequisites

- **Node.js** 18+
- **Supabase** project ([create one free](https://supabase.com))
- **Google Cloud** project with the Drive API enabled
- **Google Shared Drive** containing assets to index

## Local Setup

1. Fork and clone the repo
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment template and fill in your credentials:
   ```bash
   cp .env.example .env.local
   ```
   See `.env.example` for detailed descriptions of each variable.
4. Set up Supabase by running `supabase/schema.sql` in your project's SQL Editor.
5. Start the dev server:
   ```bash
   npm run dev
   ```

## Commit Conventions

Follow the existing commit style visible in `git log`:

| Prefix | Use for |
|--------|---------|
| `feat:` | New features |
| `fix:` | Bug fixes |
| `ui:` | Visual/UX changes |
| `refactor:` | Code restructuring (no behavior change) |
| `docs:` | Documentation only |
| `chore:` | Build, tooling, dependency updates |

Keep commit messages concise (under 72 chars for the subject line). Use the body for context when the "why" isn't obvious.

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes with clear, focused commits
3. Run `npm run build` to verify the build passes
4. Open a PR against `main` with:
   - A short description of what changed and why
   - Screenshots for UI changes
   - Any setup steps reviewers need to test locally

Keep PRs focused on a single concern. If you're fixing a bug and notice a nearby refactoring opportunity, submit them as separate PRs.

## Code Style

- TypeScript strict mode is enabled
- ESLint is configured — run `npm run lint` to check
- CSS variables use the `--ram-` prefix (defined in `src/app/globals.css`)
- Tailwind CSS 4 for utility classes
- No external state management library — plain React hooks

## Reporting Issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Browser/OS if relevant

## Questions?

Open a discussion or issue — happy to help you get oriented in the codebase.
