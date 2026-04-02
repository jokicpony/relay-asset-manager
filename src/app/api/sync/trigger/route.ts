import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/sync/trigger
 *
 * Triggers the daily-sync GitHub Actions workflow via workflow_dispatch.
 * Returns the approximate creation time so the client can find the run.
 *
 * Query params:
 *   ?skip_thumbnails=true    Skip thumbnail processing (faster sync)
 */
export async function POST(request: Request) {
    // Auth gate
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO; // e.g. "owner/repo"
    if (!token || !repo) {
        return NextResponse.json(
            { error: 'GITHUB_TOKEN and GITHUB_REPO must be configured' },
            { status: 500 }
        );
    }

    const { searchParams } = new URL(request.url);
    const skipThumbnails = searchParams.get('skip_thumbnails') === 'true';

    const triggeredAt = new Date().toISOString();

    // Trigger workflow_dispatch
    const res = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/daily-sync.yml/dispatches`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({
                ref: 'main',
                inputs: {
                    skip_thumbnails: String(skipThumbnails),
                },
            }),
        }
    );

    if (!res.ok) {
        const body = await res.text();

        // Surface actionable error messages for common failures
        if (res.status === 401) {
            return NextResponse.json(
                { error: 'GitHub token is invalid or expired. Generate a new fine-grained PAT at github.com/settings/tokens and update GITHUB_TOKEN.' },
                { status: 502 }
            );
        }
        if (res.status === 403) {
            return NextResponse.json(
                { error: 'GitHub token lacks permission. Ensure the token has "Actions" read+write access for this repository.' },
                { status: 502 }
            );
        }
        if (res.status === 404) {
            return NextResponse.json(
                { error: `Workflow not found. Verify GITHUB_REPO (${repo}) is correct and daily-sync.yml exists on the main branch.` },
                { status: 502 }
            );
        }

        return NextResponse.json(
            { error: `GitHub API error (${res.status}): ${body}` },
            { status: 502 }
        );
    }

    return NextResponse.json({
        triggered: true,
        triggered_at: triggeredAt,
        triggered_by: user.email,
    });
}
