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

import { getAdminClient } from './supabase/admin';

// Canonical definition lives with the shared label parser.
export type { RightsLabelConfig } from './sync/rights-labels';
import type { RightsLabelConfig } from './sync/rights-labels';

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

// Short-TTL cache so repeated getConfig() calls within a request/burst don't
// re-query app_settings each time. Busted on writes via updateSetting().
let _configCache: { value: AppConfig; expires: number } | null = null;
const CONFIG_TTL_MS = 30_000;

const CONFIG_KEYS = [
    'shared_drive_id',
    'sync_folders',
    'drive_label_id',
    'namer_label_ids',
    'semantic_similarity_threshold',
    'hidden_folders',
    'namer_auto_ingest_delay_ms',
    'rights_label_config',
];

/**
 * Fetch app config from DB with env var fallback.
 * Uses service role key so it works from API routes and the sync script.
 */
export async function getConfig(): Promise<AppConfig> {
    if (_configCache && Date.now() < _configCache.expires) {
        return _configCache.value;
    }

    const dbMap = new Map<string, unknown>();

    // Fail closed: a DB error must not silently degrade to env-var defaults.
    // An empty shared_drive_id disables the shared-drive scope check and an
    // empty sync_folders disables folder filtering, so a transient Supabase
    // failure would otherwise loosen security for the whole cache window.
    // Only the keys read below are fetched — app_settings also holds large
    // blobs (folder_drive_ids, pending ingests) that config doesn't need.
    const { data, error } = await getAdminClient()
        .from('app_settings')
        .select('key, value')
        .in('key', CONFIG_KEYS);

    if (error) {
        throw new Error(`Failed to load app_settings: ${error.message}`);
    }
    for (const row of data ?? []) {
        dbMap.set(row.key, row.value);
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

    const config: AppConfig = {
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

    _configCache = { value: config, expires: Date.now() + CONFIG_TTL_MS };
    return config;
}

/**
 * Update a single setting in the database.
 */
export async function updateSetting(
    key: string,
    value: unknown,
    updatedBy?: string
): Promise<{ success: boolean; error?: string }> {
    const { error } = await getAdminClient()
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

    _configCache = null; // bust cache so the next getConfig() sees the write
    return { success: true };
}
