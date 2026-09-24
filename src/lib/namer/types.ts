/**
 * TypeScript types for the Asset Namer domain.
 * Used by API routes, client service layer, and UI components.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reserved key for the "Passthrough" schema — keeps original filenames. */
export const PASSTHROUGH_SCHEMA_KEY = '__passthrough__';

// ---------------------------------------------------------------------------
// Drive / File types
// ---------------------------------------------------------------------------

export interface NamerFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    thumbnailLink?: string;
    imageMediaMetadata?: { width: number; height: number };
    videoMediaMetadata?: { width: number; height: number };
    size?: string;
    createdTime?: string;
}

export interface NamerFilePreview extends NamerFile {
    originalName: string;
    proposedName: string;
    status: 'pending' | 'excluded' | 'processing' | 'success' | 'error';
    finalName?: string;
    orientation?: 'Horizontal' | 'Vertical' | 'Square' | null;
}

export interface DriveFolder {
    id: string;
    name: string;
    mimeType: string;
}

// ---------------------------------------------------------------------------
// Drive Labels
// ---------------------------------------------------------------------------

export interface DriveLabelChoice {
    id: string;
    properties: { displayName: string };
}

export interface DriveLabelField {
    id: string;
    properties: { displayName: string };
    selectionOptions?: { choices: DriveLabelChoice[]; listOptions?: { maxEntries?: number } };
    textOptions?: Record<string, unknown>;
    integerOptions?: Record<string, unknown>;
    dateOptions?: Record<string, unknown>;
    userOptions?: Record<string, unknown>;
}

export interface DriveLabel {
    id: string;
    properties: { title: string; description?: string };
    fields?: DriveLabelField[];
}

export interface LabelFieldValue {
    value: string | string[];
    type: 'text' | 'selection' | 'integer' | 'date' | 'user';
}

export type LabelFieldValues = Record<string, Record<string, LabelFieldValue>>;
// { [labelId]: { [fieldId]: { value, type } } }

// ---------------------------------------------------------------------------
// AI / Gemini
// ---------------------------------------------------------------------------

export interface AIMetadata {
    context_environment: string;
    seasonality: string;
    lighting_mood: string;
    human_experience: string | string[];
    primary_objects: string[];
    color_palette: string[];
    label_csv: string;
}

export interface AISettings {
    enabled: boolean;
    systemPrompt: string;
    userPrompt: string;
    promptLocked: boolean;
    delayMs: number;
}

// ---------------------------------------------------------------------------
// Naming Schemas
// ---------------------------------------------------------------------------

export interface SchemaField {
    id: string;
    /**
     * `constant` is a fixed token defined once in Settings (e.g. "TikTok").
     * Its `value` is baked into every name and is not editable in the builder.
     */
    type: 'text' | 'select' | 'date' | 'counter' | 'constant';
    label: string;
    value: string;
    required: boolean;
    frozen?: boolean;
    source?: string; // dropdown category key
}

export interface NamingSchema {
    aiEnabled: boolean;
    fields: SchemaField[];
}

export type NamingSchemas = Record<string, NamingSchema>;

export type Dropdowns = Record<string, string[]>;

// Full namer settings (stored across multiple app_settings keys)
export interface NamerSettings {
    schemas: NamingSchemas;
    dropdowns: Dropdowns;
    aiSettings: AISettings;
    helpGuideContent: string;
}

// ---------------------------------------------------------------------------
// Batch processing (client-side queue in NamerView / NamerQueue)
// ---------------------------------------------------------------------------

export type BatchFileStatus = 'queued' | 'processing' | 'analyzing' | 'success' | 'error' | 'cancelled';

/**
 * Pipeline steps recorded per file so "Retry failed" redoes only what didn't
 * succeed. `move` is the rename + move; `label:<labelId>` one Drive label.
 */
export type BatchStep = 'move' | 'orientation' | 'ai' | 'description' | `label:${string}`;

export interface BatchFile {
    id: string;
    name: string;
    proposedName: string;
    /**
     * `success` means the rename/move landed (later steps may still have
     * `warnings`); `error` means it didn't; `cancelled` means it never started.
     */
    status: BatchFileStatus;
    finalName: string | null;
    /**
     * The name the rename step aimed for — reused on retry, so a retry never
     * renames a file a second time (e.g. to `_002`) when the first attempt
     * actually landed but its response was lost.
     */
    targetName?: string;
    orientation?: 'Horizontal' | 'Vertical' | 'Square';
    imageMediaMetadata?: { width: number; height: number };
    videoMediaMetadata?: { width: number; height: number };
    /** Why the rename/move failed (status `error`). */
    error?: string;
    /** Post-move steps that failed (labels, orientation, AI, description). */
    warnings?: string[];
    /** Steps that succeeded; a retry skips these. */
    doneSteps?: BatchStep[];
    /** AI result, kept so a retry of only the description can reuse it. */
    aiMetadata?: AIMetadata | null;
    /** Per-file revert outcome — a batch is only "Reverted" when all are `done`. */
    revert?: 'done' | 'failed';
    revertError?: string;
}

/**
 * Settings captured when a batch is queued, so processing uses what the user
 * saw at queue time even if they change labels/AI/schema before it runs.
 */
export interface BatchSnapshot {
    selectedLabelIds: string[];
    labelFieldValues: LabelFieldValues;
    aiEnabled: boolean;
    labels: DriveLabel[];
    settings: NamerSettings | null;
    /** Counter's token index in the names (see naming.ts dedupeName). */
    counterIndex?: number | null;
}

export interface BatchInfo {
    id: string;
    files: BatchFile[];
    progress: { completed: number; total: number; errors: number };
    /** `revert-failed`: some files couldn't be moved back — retryable. */
    status: 'queued' | 'processing' | 'completed' | 'reverting' | 'reverted' | 'revert-failed';
    timestamp: number;
    labelsSummary?: string;
    sourceFolderId: string;
    destFolderId: string;
    /** Set by Cancel; the runner stops before the next file starts. */
    cancelRequested?: boolean;
    _snapshot?: BatchSnapshot;
}
