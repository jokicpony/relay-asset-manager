/**
 * Namer API Client — Thin typed wrappers around /api/namer/* routes.
 * Used by UI components to interact with the server-side namer backend.
 */

import type {
    NamerFile,
    NamerSettings,
    NamingSchemas,
    Dropdowns,
    AISettings,
    AIMetadata,
    DriveLabel,
    DriveFolder,
    LabelFieldValue,
} from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
    }
    return res.json();
}

function post<T>(url: string, body: unknown): Promise<T> {
    return fetchJson<T>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function put<T>(url: string, body: unknown): Promise<T> {
    return fetchJson<T>(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** List media files in a Drive folder (or single file metadata). */
export async function listFiles(folderId: string): Promise<NamerFile[]> {
    const data = await post<{ files: NamerFile[] }>('/api/namer/files', { folderId });
    return data.files;
}

/** List only filenames in a Drive folder (for duplicate checking). */
export async function listFileNames(folderId: string): Promise<Set<string>> {
    const files = await listFiles(folderId);
    return new Set(files.map(f => f.name));
}

/** Rename + move a file atomically. */
export async function updateFile(
    fileId: string,
    newName: string,
    destFolderId: string,
    sourceFolderId?: string
): Promise<{ id: string; name: string; parents: string[] }> {
    return post('/api/namer/files/update', { fileId, newName, destFolderId, sourceFolderId });
}

/** Set the semantic search description on a file. */
export async function setDescription(
    fileId: string,
    description: string
): Promise<{ id: string; description: string }> {
    return post('/api/namer/files/description', { fileId, description });
}

/** Set hidden appProperties (AI metadata sidecar) on a file. */
export async function setAppProperties(
    fileId: string,
    properties: Record<string, string>
): Promise<{ id: string; appProperties: Record<string, string> }> {
    return post('/api/namer/files/properties', { fileId, properties });
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Fetch all available Drive Labels. */
export async function getLabels(): Promise<DriveLabel[]> {
    const data = await fetchJson<{ labels: DriveLabel[] }>('/api/namer/labels');
    return data.labels;
}

/** Apply a label (with field values) to a file. */
export async function applyLabel(
    fileId: string,
    labelId: string,
    fieldValues: Record<string, LabelFieldValue>
): Promise<unknown> {
    return post('/api/namer/labels/apply', { fileId, labelId, fieldValues });
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** Search Drive folders by name. */
export async function searchFolders(query: string): Promise<DriveFolder[]> {
    const data = await fetchJson<{ folders: DriveFolder[] }>(
        `/api/namer/folders?q=${encodeURIComponent(query)}`
    );
    return data.folders;
}

/** Get a single folder's metadata by ID. */
export async function getFolder(folderId: string): Promise<DriveFolder> {
    return fetchJson<DriveFolder>(`/api/namer/folders?id=${encodeURIComponent(folderId)}`);
}

// ---------------------------------------------------------------------------
// AI Analysis
// ---------------------------------------------------------------------------

/** Analyze an image with Gemini AI. Returns structured metadata. */
export async function analyzeImage(
    fileId: string,
    aiSettings?: Partial<AISettings>
): Promise<AIMetadata> {
    return post('/api/namer/analyze', { fileId, aiSettings });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Fetch all namer settings. */
export async function getSettings(): Promise<NamerSettings> {
    return fetchJson<NamerSettings>('/api/namer/settings');
}

/** Update namer settings (partial — only provided keys are updated). */
export async function updateSettings(
    updates: Partial<{
        schemas: NamingSchemas;
        dropdowns: Dropdowns;
        aiSettings: AISettings;
        helpGuideContent: string;
    }>
): Promise<{ success: boolean }> {
    return put('/api/namer/settings', updates);
}
