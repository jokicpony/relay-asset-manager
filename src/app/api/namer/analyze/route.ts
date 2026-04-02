/**
 * Namer AI Analysis API — Analyze an image using Gemini 3 Flash.
 * Replaces client-side `geminiService.analyzeImageById()`.
 *
 * All processing happens server-side:
 * 1. Fetch image from Drive via service account
 * 2. Resize to 1024px max dimension via sharp (cost optimization)
 * 3. Send to Gemini API with structured JSON output
 * 4. Return parsed metadata
 *
 * POST body: { fileId, aiSettings?: { systemPrompt?, userPrompt? } }
 * Returns: AIMetadata
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import type { AIMetadata } from '@/lib/namer/types';
import sharp from 'sharp';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

const DEFAULT_SYSTEM_PROMPT = `You are a Senior Creative Asset Manager optimizing images for semantic search in a Digital Asset Management system. Your keywords should help users find assets by searching for the MOOD, ACTIVITY, SETTING, PRODUCTS, or EMOTIONAL VIBE. Balance factual descriptors (objects, location) with experiential terms (feelings, activities, atmospheres).`;

const DEFAULT_USER_PROMPT = `Analyze this image and return a JSON object with the following fields:

context_environment: The primary setting as a brief phrase. (e.g., "freshwater river", "minimalist product studio", "alpine forest trail")

seasonality: Season or weather conditions visible. (e.g., "summer", "winter storm", "golden autumn")

lighting_mood: The light quality and emotional effect. (e.g., "warm golden hour", "dramatic storm light", "soft overcast")

human_experience: Array of 2-3 activity or lifestyle descriptors. (e.g., ["fly fishing adventure", "peaceful nature retreat"])

primary_objects: Array of 3-4 most important visible subjects. (e.g., ["insulated flask", "fly rod", "mountain stream"])

color_palette: Array of 3 dominant HEX codes representing the image mood.

label_csv: A single comma-separated string of 12-15 discovery keywords optimized for semantic search.

Constraints: Output ONLY valid JSON. Keep individual tags to 1-3 words. Be specific and descriptive.`;

const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 80;

/**
 * Fetch image from Drive and resize with sharp for cost optimization.
 * Converts to JPEG at 1024px max dimension / 0.80 quality.
 */
async function fetchAndPrepareImage(
    fileId: string,
    token: string
): Promise<{ base64: string; mimeType: string }> {
    // Fetch image content from Drive
    const res = await fetch(
        `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
        throw new Error(`Failed to fetch file from Drive: ${res.status} ${res.statusText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const originalKB = (buffer.length / 1024).toFixed(0);

    // Resize with sharp: 1024px max, JPEG 80% quality
    const resized = await sharp(buffer)
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();

    const resizedKB = (resized.length / 1024).toFixed(0);
    logger.info('namer-analyze', `Prepared image ${fileId}: ${originalKB}KB → ${resizedKB}KB (${MAX_DIMENSION}px max)`);

    return { base64: resized.toString('base64'), mimeType: 'image/jpeg' };
}

function parseJsonResponse(text: string): AIMetadata | null {
    if (!text) return null;

    // Try to extract JSON from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

    try {
        const parsed = JSON.parse(jsonStr);
        // Validate required field
        if (!parsed.label_csv || typeof parsed.label_csv !== 'string') {
            logger.warn('namer-analyze', 'Response missing required label_csv field');
            return null;
        }
        return parsed as AIMetadata;
    } catch {
        logger.error('namer-analyze', 'Failed to parse Gemini JSON response', { raw: text.substring(0, 500) });
        return null;
    }
}

export async function POST(request: NextRequest) {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    if (!GEMINI_API_KEY) {
        return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    try {
        const { fileId, aiSettings } = await request.json();
        if (!fileId) {
            return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
        }

        const token = await getDriveAccessToken();

        // 1. Fetch and prepare image
        const { base64, mimeType } = await fetchAndPrepareImage(fileId, token);

        // 2. Build Gemini request
        const systemPrompt = aiSettings?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
        const userPrompt = aiSettings?.userPrompt || DEFAULT_USER_PROMPT;

        const geminiRes = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: userPrompt },
                        { inlineData: { mimeType, data: base64 } },
                    ],
                }],
                systemInstruction: {
                    parts: [{ text: systemPrompt }],
                },
                generationConfig: {
                    temperature: 0.3,
                    topP: 0.8,
                    maxOutputTokens: 4096,
                    responseMimeType: 'application/json',
                },
            }),
        });

        if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            logger.error('namer-analyze', `Gemini API error: ${geminiRes.status}`, { error: errText });
            return NextResponse.json(
                { error: `Gemini API error: ${geminiRes.status}` },
                { status: geminiRes.status }
            );
        }

        const geminiResult = await geminiRes.json();
        const textContent = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!textContent) {
            logger.error('namer-analyze', 'No text in Gemini response');
            return NextResponse.json({ error: 'No content in Gemini response' }, { status: 500 });
        }

        const metadata = parseJsonResponse(textContent);
        if (!metadata) {
            return NextResponse.json({ error: 'Failed to parse Gemini response as valid AI metadata' }, { status: 500 });
        }

        logger.info('namer-analyze', `Analysis complete for ${fileId}`);
        return NextResponse.json(metadata);

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('namer-analyze', 'Unexpected error', { error: message });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
