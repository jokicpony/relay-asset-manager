#!/usr/bin/env npx tsx
/**
 * Runs as the Daily Sync workflow's last step when the job failed or was
 * cancelled (including hitting its timeout). If the sync itself didn't get
 * to write a sync_logs row for this run — killed mid-step, or it died before
 * its crash handler could run — record a 'failed' row here, so the run shows
 * up in Settings → Recent activity instead of the previous success looking
 * current.
 *
 * Idempotent per GitHub run: skips if a row with this run_id exists.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });

async function main() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const runId = process.env.GITHUB_RUN_ID;
    if (!url || !key || !runId) {
        console.log('Missing Supabase credentials or GITHUB_RUN_ID — nothing recorded');
        return;
    }
    const supabase = createClient(url, key);

    const { data: existing, error: findErr } = await supabase
        .from('sync_logs')
        .select('id')
        .eq('details->>run_id', runId)
        .limit(1);
    if (findErr) throw new Error(`Lookup failed: ${findErr.message}`);
    if (existing && existing.length > 0) {
        console.log('The sync already recorded this run — nothing to add');
        return;
    }

    // Where it stopped, from the live progress the sync keeps updating
    const { data: progress } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'sync_progress')
        .maybeSingle();
    const p = progress?.value as { step?: string; detail?: string; updated_at?: string } | undefined;

    const outcome = process.env.JOB_STATUS === 'cancelled' ? 'was cancelled or timed out' : 'failed';
    const where = p?.step ? ` during "${p.step}"${p.detail ? ` (${p.detail})` : ''}` : '';
    const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`;
    const now = new Date().toISOString();

    const { error } = await supabase.from('sync_logs').insert({
        started_at: p?.updated_at ?? now,
        finished_at: now,
        duration_secs: 0,
        status: 'failed',
        error_message: `The sync job ${outcome}${where} before it could record a result. See the GitHub Actions log.`,
        source: 'cron',
        details: {
            run_id: runId,
            run_url: runUrl,
            trigger: process.env.GITHUB_EVENT_NAME ?? null,
            job_status: process.env.JOB_STATUS ?? null,
            last_progress: p ?? null,
        },
    });
    if (error) throw new Error(`Insert failed: ${error.message}`);
    console.log('Recorded the failed run in sync_logs');
}

main().catch((err) => {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
});
