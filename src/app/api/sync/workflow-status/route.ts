import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WorkflowStep {
    name: string;
    status: string;        // queued | in_progress | completed
    conclusion: string | null; // success | failure | cancelled | skipped | null
    started_at: string | null;
    completed_at: string | null;
}

interface WorkflowJob {
    id: number;
    status: string;
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
    steps: WorkflowStep[];
}

/**
 * GET /api/sync/workflow-status
 *
 * Polls GitHub Actions for the latest workflow run status and job steps.
 *
 * Query params:
 *   ?triggered_at=ISO_DATE   Find runs created after this timestamp
 *   ?run_id=NUMBER           Poll a specific run by ID (faster, used after first discovery)
 */
export async function GET(request: Request) {
    // Auth gate
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    if (!token || !repo) {
        return NextResponse.json(
            { error: 'GITHUB_TOKEN and GITHUB_REPO must be configured' },
            { status: 500 }
        );
    }

    const { searchParams } = new URL(request.url);
    const triggeredAt = searchParams.get('triggered_at');
    const runId = searchParams.get('run_id');

    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
        let run: { id: number; status: string; conclusion: string | null; created_at: string; html_url: string } | null = null;

        // Helper: detect token issues from any GitHub API response
        const checkTokenError = (res: Response) => {
            if (res.status === 401) {
                return NextResponse.json(
                    { found: false, error: 'GitHub token is invalid or expired. Update GITHUB_TOKEN with a new fine-grained PAT.' },
                    { status: 502 }
                );
            }
            if (res.status === 403) {
                return NextResponse.json(
                    { found: false, error: 'GitHub token lacks permission. Ensure "Actions" read+write access is granted.' },
                    { status: 502 }
                );
            }
            return null;
        };

        if (runId) {
            // Direct lookup by run ID (fast path after initial discovery)
            const res = await fetch(
                `https://api.github.com/repos/${repo}/actions/runs/${runId}`,
                { headers }
            );
            const tokenErr = checkTokenError(res);
            if (tokenErr) return tokenErr;
            if (res.ok) {
                const data = await res.json();
                run = {
                    id: data.id,
                    status: data.status,
                    conclusion: data.conclusion,
                    created_at: data.created_at,
                    html_url: data.html_url,
                };
            }
        } else if (triggeredAt) {
            // Find the run we triggered (first run created after triggered_at)
            const res = await fetch(
                `https://api.github.com/repos/${repo}/actions/workflows/daily-sync.yml/runs?per_page=5&created=>${triggeredAt}`,
                { headers }
            );
            if (res.ok) {
                const data = await res.json();
                if (data.workflow_runs && data.workflow_runs.length > 0) {
                    const r = data.workflow_runs[0];
                    run = {
                        id: r.id,
                        status: r.status,
                        conclusion: r.conclusion,
                        created_at: r.created_at,
                        html_url: r.html_url,
                    };
                }
            }
        } else {
            // Fallback: get the latest run for this workflow
            const res = await fetch(
                `https://api.github.com/repos/${repo}/actions/workflows/daily-sync.yml/runs?per_page=1`,
                { headers }
            );
            if (res.ok) {
                const data = await res.json();
                if (data.workflow_runs && data.workflow_runs.length > 0) {
                    const r = data.workflow_runs[0];
                    run = {
                        id: r.id,
                        status: r.status,
                        conclusion: r.conclusion,
                        created_at: r.created_at,
                        html_url: r.html_url,
                    };
                }
            }
        }

        if (!run) {
            return NextResponse.json({ found: false });
        }

        // Fetch job steps for richer progress
        let steps: WorkflowStep[] = [];
        const jobsRes = await fetch(
            `https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`,
            { headers }
        );
        if (jobsRes.ok) {
            const jobsData = await jobsRes.json();
            if (jobsData.jobs && jobsData.jobs.length > 0) {
                const job: WorkflowJob = jobsData.jobs[0];
                steps = (job.steps || []).map((s: WorkflowStep) => ({
                    name: s.name,
                    status: s.status,
                    conclusion: s.conclusion,
                    started_at: s.started_at,
                    completed_at: s.completed_at,
                }));
            }
        }

        // Read live sync progress from Supabase (written by scripts/sync.ts)
        let syncProgress: { step: string; detail: string; pct: number | null; updated_at: string } | null = null;
        try {
            const admin = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
            );
            const { data } = await admin
                .from('app_settings')
                .select('value')
                .eq('key', 'sync_progress')
                .single();
            if (data?.value) {
                syncProgress = data.value as typeof syncProgress;
            }
        } catch { /* non-critical */ }

        return NextResponse.json({
            found: true,
            run_id: run.id,
            status: run.status,       // queued | in_progress | completed
            conclusion: run.conclusion, // success | failure | cancelled | null
            created_at: run.created_at,
            html_url: run.html_url,
            steps,
            sync_progress: syncProgress,
        });
    } catch (err) {
        return NextResponse.json(
            { error: `Failed to fetch workflow status: ${err}` },
            { status: 502 }
        );
    }
}
