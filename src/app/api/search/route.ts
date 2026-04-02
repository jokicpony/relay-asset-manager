import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/config';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const GEMINI_EMBED_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent';

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
    const limit = Math.min(
        parseInt(request.nextUrl.searchParams.get('limit') || '50', 10),
        200
    );

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
        const embedRes = await fetch(`${GEMINI_EMBED_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'models/gemini-embedding-2-preview',
                content: { parts: [{ text: query }] },
                outputDimensionality: 768,
            }),
        });

        if (!embedRes.ok) {
            const errText = await embedRes.text();
            logger.error('search', 'Gemini embed error', { response: errText });
            return NextResponse.json(
                { error: 'Failed to embed query' },
                { status: 502 }
            );
        }

        const embedData = await embedRes.json();
        const queryEmbedding = embedData.embedding.values;

        // Step 2: Search Supabase using cosine similarity (RPC function)
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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
    } catch (err: any) {
        logger.error('search', 'Search error', { error: err.message });
        return NextResponse.json(
            { error: err.message || 'Internal server error' },
            { status: 500 }
        );
    }
}
