import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/config';
import { getAdminClient } from '@/lib/supabase/admin';
import { embedQuery } from '@/lib/sync/embedder';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';


/**
 * GET /api/search?q=campfire+flask&limit=50
 *
 * Embeds the query text via Gemini Embedding 2 (multimodal model),
 * then runs cosine similarity against the assets table using the
 * match_assets RPC function. Text queries work cross-modally —
 * they match against image-augmented document embeddings.
 * Returns asset IDs ranked by similarity.
 */
export async function GET(request: NextRequest) {
    // Auth check — require authenticated session
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const query = request.nextUrl.searchParams.get('q')?.trim();
    // Clamp to [1, 200]; NaN (e.g. ?limit=abc) serialized to null, which the
    // RPC treated as LIMIT NULL — unbounded.
    const parsedLimit = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;

    if (!query) {
        return NextResponse.json({ error: 'Missing query parameter "q"' }, { status: 400 });
    }

    if (!GEMINI_API_KEY) {
        return NextResponse.json(
            { error: 'GEMINI_API_KEY not configured' },
            { status: 500 }
        );
    }

    try {
        // Load similarity threshold from app settings (default 0.3)
        const config = await getConfig();
        const threshold = config.semanticSimilarityThreshold;

        // Step 1: Embed the query text using Gemini Embedding 2 (multimodal)
        // Text queries stay text-only — cross-modal search means a text query
        // automatically matches image-augmented document embeddings.
        // API key goes in a header — keys in query strings leak into logs/traces
        let queryEmbedding: number[];
        try {
            // Same model + dimensions as the document embeddings (shared embedder)
            queryEmbedding = await embedQuery(GEMINI_API_KEY, query);
        } catch (err) {
            logger.error('search', 'Gemini embed error', { error: err instanceof Error ? err.message : String(err) });
            return NextResponse.json(
                { error: 'Failed to embed query' },
                { status: 502 }
            );
        }

        // Step 2: Search Supabase using cosine similarity (RPC function)
        const supabase = getAdminClient();

        const { data, error } = await supabase.rpc('match_assets', {
            query_embedding: JSON.stringify(queryEmbedding),
            match_count: limit,
            similarity_threshold: threshold,
        });

        if (error) {
            logger.error('search', 'Supabase RPC error', { error: error.message });
            return NextResponse.json(
                { error: 'Search query failed' },
                { status: 500 }
            );
        }

        // Return ranked results: [{ id, similarity }]
        return NextResponse.json({
            results: data || [],
            query,
            count: data?.length || 0,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('search', 'Search error', { error: message });
        return NextResponse.json(
            { error: message || 'Internal server error' },
            { status: 500 }
        );
    }
}
