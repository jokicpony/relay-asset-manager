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
import { isInSharedDrive } from '@/lib/google/drive-scope';
import { getConfig } from '@/lib/config';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import type { AIMetadata } from '@/lib/namer/types';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT } from '@/lib/namer/ai-defaults';
import sharp from 'sharp';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

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

        // Bound the namer to the configured shared drive — the service account
        // may reach other drives, but the namer must not read files outside the DAM.
        const { sharedDriveId } = await getConfig();
        if (!(await isInSharedDrive(token, fileId, sharedDriveId))) {
            return NextResponse.json({ error: 'File is outside the configured shared drive' }, { status: 403 });
        }

        // 1. Fetch and prepare image
        const { base64, mimeType } = await fetchAndPrepareImage(fileId, token);

        // 2. Build Gemini request
        const systemPrompt = aiSettings?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
        const userPrompt = aiSettings?.userPrompt || DEFAULT_USER_PROMPT;

        // API key goes in a header — keys in query strings leak into logs/traces
        const geminiRes = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
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
