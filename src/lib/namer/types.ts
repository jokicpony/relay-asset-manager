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
    type: 'text' | 'select' | 'date' | 'counter';
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
// Batch Processing
// ---------------------------------------------------------------------------

export interface BatchConfig {
    sourceId: string;
    destId: string;
    selectedLabelIds: string[];
    labelFieldValues: LabelFieldValues;
    tagSummary: string;
    aiSettings: AISettings;
}

export interface BatchFile {
    id: string;
    name: string;
    proposedName: string;
    status: 'queued' | 'processing' | 'analyzing' | 'tagging' | 'success' | 'error';
    finalName: string | null;
    mimeType: string;
    thumbnailLink?: string;
    imageMediaMetadata?: { width: number; height: number };
    videoMediaMetadata?: { width: number; height: number };
    parents?: string[];
    orientation?: string | null;
}

export interface BatchProgress {
    completed: number;
    total: number;
    errors: number;
}

export interface Batch {
    id: string;
    files: BatchFile[];
    config: BatchConfig;
    progress: BatchProgress;
    status: 'queued' | 'processing' | 'completed';
    isRevert?: boolean;
    isReverted?: boolean;
    createdAt: string;
}
