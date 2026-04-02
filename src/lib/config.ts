/**
 * App Configuration Resolver
 *
 * Reads operational settings from the Supabase `app_settings` table
 * with fallback to environment variables. This ensures a single source
 * of truth editable from the UI, while maintaining backwards compatibility.
 *
 * Usage:
 *   import { getConfig } from '@/lib/config';
 *   const config = await getConfig();
 *   // config.sharedDriveId, config.syncFolders, config.driveLabelId
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export interface RightsLabelConfig {
    fieldIds: {
        organicRights: string;
        organicExpiration: string;
        paidRights: string;
        paidExpiration: string;
    };
    choiceMap: Record<string, string>;  // choice ID → 'unlimited' | 'limited' | 'expired'
}

export interface AppConfig {
    sharedDriveId: string;
    syncFolders: string[];
    driveLabelId: string;
    namerLabelIds: string[];  // all Drive Label IDs the namer should fetch (Content Tags, Rights, etc.)
    semanticSimilarityThreshold: number;
    hiddenFolders: string[];  // folders hidden from "All Folders" master view
    namerAutoIngestDelayMs: number;  // delay before auto-ingesting namer batches (default: 5 min)
    rightsLabelConfig: RightsLabelConfig;  // Drive Label field ID → DB column mappings
}

/**
 * Fetch app config from DB with env var fallback.
 * Uses service role key so it works from API routes and the sync script.
 */
export async function getConfig(): Promise<AppConfig> {
    const dbMap = new Map<string, unknown>();

    try {
        const { data } = await supabase
            .from('app_settings')
            .select('key, value');

        if (data) {
            for (const row of data) {
                dbMap.set(row.key, row.value);
            }
        }
    } catch {
        // DB not available — fall through to env vars
    }

    // Parse SYNC_FOLDERS env var (comma-separated string → array)
    const envSyncFolders = (process.env.SYNC_FOLDERS ?? '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);

    // Default rights label config — empty for new deployments.
    // Existing deployments should seed their field IDs via the Settings UI
    // or by inserting a `rights_label_config` row into app_settings.
    const defaultRightsConfig: RightsLabelConfig = {
        fieldIds: {
            organicRights: '',
            organicExpiration: '',
            paidRights: '',
            paidExpiration: '',
        },
        choiceMap: {},
    };

    return {
        sharedDriveId:
            (dbMap.get('shared_drive_id') as string) ??
            process.env.GOOGLE_SHARED_DRIVE_ID ??
            '',
        syncFolders:
            (dbMap.get('sync_folders') as string[]) ??
            (envSyncFolders.length > 0 ? envSyncFolders : []),
        driveLabelId:
            (dbMap.get('drive_label_id') as string) ??
            process.env.GOOGLE_DRIVE_LABEL_ID ??
            '',
        namerLabelIds:
            (dbMap.get('namer_label_ids') as string[]) ??
            // Fallback: use the single driveLabelId if no namer-specific list is set
            (((dbMap.get('drive_label_id') as string) ?? process.env.GOOGLE_DRIVE_LABEL_ID)
                ? [((dbMap.get('drive_label_id') as string) ?? process.env.GOOGLE_DRIVE_LABEL_ID ?? '')]
                : []),
        semanticSimilarityThreshold:
            (dbMap.get('semantic_similarity_threshold') as number) ?? 0.3,
        hiddenFolders:
            (dbMap.get('hidden_folders') as string[]) ?? [],
        namerAutoIngestDelayMs:
            (dbMap.get('namer_auto_ingest_delay_ms') as number) ?? 300000, // 5 minutes
        rightsLabelConfig:
            (dbMap.get('rights_label_config') as RightsLabelConfig) ?? defaultRightsConfig,
    };
}

/**
 * Update a single setting in the database.
 */
export async function updateSetting(
    key: string,
    value: unknown,
    updatedBy?: string
): Promise<{ success: boolean; error?: string }> {
    const { error } = await supabase
        .from('app_settings')
        .upsert({
            key,
            value,
            updated_at: new Date().toISOString(),
            updated_by: updatedBy ?? null,
        });

    if (error) {
        return { success: false, error: error.message };
    }
    return { success: true };
}
