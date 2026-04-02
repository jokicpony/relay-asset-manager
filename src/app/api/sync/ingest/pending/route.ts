/**
 * Pending Ingest Persistence API — Server-side storage for deferred ingests.
 *
 * Stores pending ingest intents in Supabase app_settings so they survive
 * tab closure. The next user to open the app picks up stale intents.
 *
 * GET    /api/sync/ingest/pending — list pending ingests
 * POST   /api/sync/ingest/pending — create/update a pending ingest
 * DELETE /api/sync/ingest/pending?batchId=XXX — remove a pending ingest
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETTINGS_KEY = 'pending_ingests';

async function requireAuth() {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    return user;
}

function getAdminClient() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

interface PendingIngest {
    batchId: string;
    fileIds: string[];
    destFolderId: string;
    scheduledAt: number;
    firesAt: number;
    status: string;
}

async function getPendingIngests(): Promise<PendingIngest[]> {
    const supabase = getAdminClient();
    const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', SETTINGS_KEY)
        .single();

    if (!data?.value) return [];
    return (data.value as PendingIngest[]).filter(p => p.status === 'pending');
}

async function savePendingIngests(ingests: PendingIngest[]) {
    const supabase = getAdminClient();
    await supabase.from('app_settings').upsert({
        key: SETTINGS_KEY,
        value: ingests,
        updated_at: new Date().toISOString(),
    });
}

// GET — List pending ingests (for recovery on app load)
export async function GET() {
    if (!(await requireAuth())) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    try {
        const pending = await getPendingIngests();
        return NextResponse.json({ pending });
    } catch (err) {
        return NextResponse.json({ pending: [] });
    }
}

// POST — Store a pending ingest intent
export async function POST(request: NextRequest) {
    if (!(await requireAuth())) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    try {
        const ingest = await request.json() as PendingIngest;

        if (!ingest.batchId || !ingest.fileIds?.length || !ingest.destFolderId) {
            return NextResponse.json({ error: 'Invalid ingest data' }, { status: 400 });
        }

        const existing = await getPendingIngests();
        // Replace if same batchId, otherwise append
        const filtered = existing.filter(p => p.batchId !== ingest.batchId);
        filtered.push(ingest);

        await savePendingIngests(filtered);
        return NextResponse.json({ success: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// DELETE — Remove a pending ingest (cancelled or completed)
export async function DELETE(request: NextRequest) {
    if (!(await requireAuth())) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    try {
        const { searchParams } = new URL(request.url);
        const batchId = searchParams.get('batchId');

        if (!batchId) {
            return NextResponse.json({ error: 'batchId required' }, { status: 400 });
        }

        const existing = await getPendingIngests();
        const filtered = existing.filter(p => p.batchId !== batchId);
        await savePendingIngests(filtered);

        return NextResponse.json({ success: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
