/**
 * Namer Settings API — CRUD for naming schemas, dropdowns, and AI config.
 * Stores everything in the existing Supabase `app_settings` table as JSONB values.
 *
 * Keys:
 *   namer_schemas    — { [schemaName]: { aiEnabled, fields[] } }
 *   namer_dropdowns  — { [category]: string[] }
 *   namer_ai_config  — { enabled, systemPrompt, userPrompt, promptLocked, delayMs }
 *   namer_help_guide — string (custom help guide content)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import type { NamerSettings, NamingSchemas, Dropdowns, AISettings } from '@/lib/namer/types';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Default settings — used for seeding and fallbacks
const DEFAULT_AI_SETTINGS: AISettings = {
    enabled: true,
    systemPrompt: `You are a Senior Creative Asset Manager optimizing images for semantic search in a Digital Asset Management system. Your keywords should help users find assets by searching for the MOOD, ACTIVITY, SETTING, PRODUCTS, or EMOTIONAL VIBE. Balance factual descriptors (objects, location) with experiential terms (feelings, activities, atmospheres).`,
    userPrompt: `Analyze this image and return a JSON object with the following fields:

context_environment: The primary setting as a brief phrase. (e.g., "freshwater river", "minimalist product studio", "alpine forest trail")

seasonality: Season or weather conditions visible. (e.g., "summer", "winter storm", "golden autumn")

lighting_mood: The light quality and emotional effect. (e.g., "warm golden hour", "dramatic storm light", "soft overcast")

human_experience: Array of 2-3 activity or lifestyle descriptors. (e.g., ["fly fishing adventure", "peaceful nature retreat"])

primary_objects: Array of 3-4 most important visible subjects. (e.g., ["insulated flask", "fly rod", "mountain stream"])

color_palette: Array of 3 dominant HEX codes representing the image mood.

label_csv: A single comma-separated string of 12-15 discovery keywords optimized for semantic search.

Constraints: Output ONLY valid JSON. Keep individual tags to 1-3 words. Be specific and descriptive.`,
    promptLocked: true,
    delayMs: 500,
};

const DEFAULT_SCHEMAS: NamingSchemas = {
    lifestyle: {
        aiEnabled: true,
        fields: [
            { id: 'date', type: 'date', label: 'Date', value: '', required: true, frozen: true },
            { id: 'creator', type: 'select', label: 'Lifestyle Photographer', source: 'lifestyle_photographers', value: '', required: true },
            { id: 'project', type: 'text', label: 'Project', value: '', required: false },
            { id: 'product', type: 'select', label: 'Product', source: 'products', value: '', required: true },
            { id: 'index', type: 'counter', label: 'Index', value: '001', required: true, frozen: true },
        ],
    },
    studio: {
        aiEnabled: false,
        fields: [
            { id: 'date', type: 'date', label: 'Date', value: '', required: true, frozen: true },
            { id: 'provider', type: 'select', label: 'Studio Photographer', source: 'studio_photographers', value: '', required: true },
            { id: 'style', type: 'select', label: 'Studio Style', source: 'studio_styles', value: '', required: true },
            { id: 'use', type: 'select', label: 'Image Use', source: 'image_use', value: '', required: false },
            { id: 'product', type: 'select', label: 'Product', source: 'products', value: '', required: true },
            { id: 'variant', type: 'select', label: 'Variant', source: 'variant', value: '', required: false },
            { id: 'index', type: 'counter', label: 'Index', value: '001', required: true, frozen: true },
        ],
    },
    video: {
        aiEnabled: true,
        fields: [
            { id: 'date', type: 'date', label: 'Date', value: '', required: true, frozen: true },
            { id: 'writer', type: 'select', label: 'Video Creator', source: 'video_creators', value: '', required: true },
            { id: 'orientation', type: 'select', label: 'Video Orientation', source: 'video_orientations', value: '', required: true },
            { id: 'status', type: 'select', label: 'Edit Status', source: 'edit_statuses', value: '', required: true },
            { id: 'product', type: 'select', label: 'Product', source: 'products', value: '', required: true },
            { id: 'index', type: 'counter', label: 'Index', value: '001', required: true, frozen: true },
        ],
    },
};

const DEFAULT_DROPDOWNS: Dropdowns = {
    lifestyle_photographers: ['John Doe', 'Jane Smith'],
    studio_photographers: ['StudioTeam'],
    studio_styles: ['E-comm', 'Editorial', 'Social'],
    products: ['Apparel', 'Footwear', 'Accessories'],
    locations: ['New York', 'Los Angeles', 'London'],
    video_creators: ['Editor A', 'Editor B'],
    video_orientations: ['16:9', '9:16', '1:1', '4:5'],
    edit_statuses: ['Raw', 'Rough Cut', 'Final', 'Color Graded'],
    image_use: ['Web', 'Social', 'Internal'],
    variant: ['Main', 'Alt', 'Detail'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSetting<T>(key: string, fallback: T): Promise<T> {
    const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', key)
        .single();

    if (error || !data) return fallback;
    return data.value as T;
}

async function setSetting(key: string, value: unknown, email?: string): Promise<void> {
    await supabase
        .from('app_settings')
        .upsert({
            key,
            value,
            updated_at: new Date().toISOString(),
            updated_by: email || null,
        });
}

// ---------------------------------------------------------------------------
// GET — Fetch all namer settings
// ---------------------------------------------------------------------------
export async function GET() {
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const [schemas, dropdowns, aiSettings, helpGuide] = await Promise.all([
            getSetting<NamingSchemas>('namer_schemas', DEFAULT_SCHEMAS),
            getSetting<Dropdowns>('namer_dropdowns', DEFAULT_DROPDOWNS),
            getSetting<AISettings>('namer_ai_config', DEFAULT_AI_SETTINGS),
            getSetting<string>('namer_help_guide', ''),
        ]);

        const settings: NamerSettings = {
            schemas,
            dropdowns,
            aiSettings,
            helpGuideContent: helpGuide,
        };

        return NextResponse.json(settings);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// ---------------------------------------------------------------------------
// PUT — Update namer settings (partial or full)
// ---------------------------------------------------------------------------
export async function PUT(request: NextRequest) {
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const body = await request.json();
        const email = user.email || undefined;

        // Update only the keys that are provided
        const updates: Promise<void>[] = [];

        if (body.schemas !== undefined) {
            updates.push(setSetting('namer_schemas', body.schemas, email));
        }
        if (body.dropdowns !== undefined) {
            updates.push(setSetting('namer_dropdowns', body.dropdowns, email));
        }
        if (body.aiSettings !== undefined) {
            updates.push(setSetting('namer_ai_config', body.aiSettings, email));
        }
        if (body.helpGuideContent !== undefined) {
            updates.push(setSetting('namer_help_guide', body.helpGuideContent, email));
        }

        await Promise.all(updates);

        return NextResponse.json({ success: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
