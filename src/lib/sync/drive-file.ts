import type { drive_v3 } from 'googleapis';
import type { DriveFile } from './types';
import type { RightsLabelFields } from './rights-labels';
import { VIDEO_MIMES } from './mime';
import { parseFilename } from '../filename-utils';

/**
 * Drive API → DriveFile, the one mapping used by the cron crawl and the
 * in-app ingest. Both used to hand-map dimensions, duration, dates and
 * parsed filename fields separately.
 *
 * No app-alias imports: scripts import this module by relative path.
 */

/** Per-file fields both paths request (files.list wraps it in `files(...)`). */
export const DRIVE_FILE_FIELDS = [
    'id', 'name', 'mimeType', 'size', 'description', 'parents',
    'thumbnailLink', 'webViewLink', 'labelInfo', 'createdTime', 'modifiedTime',
    'imageMediaMetadata(width,height)',
    'videoMediaMetadata(width,height,durationMillis)',
].join(',');

/**
 * Build a DriveFile from a Drive API file. The caller has already checked
 * that the file has an id, name and supported MIME type, and resolved its
 * folder path and rights labels.
 */
export function toDriveFile(
    file: drive_v3.Schema$File,
    folderPath: string,
    rights: RightsLabelFields,
): DriveFile {
    const name = file.name!;
    const mimeType = file.mimeType!;
    const isVideo = VIDEO_MIMES.has(mimeType);
    const media = isVideo ? file.videoMediaMetadata : file.imageMediaMetadata;
    const durationMillis = isVideo ? file.videoMediaMetadata?.durationMillis : null;
    const parsed = parseFilename(name);
    const now = new Date().toISOString();

    return {
        id: file.id!,
        name,
        mimeType,
        description: file.description ?? null,
        folderPath,
        thumbnailLink: file.thumbnailLink ?? null,
        webViewLink: file.webViewLink ?? null,
        width: media?.width ?? 0,
        height: media?.height ?? 0,
        duration: durationMillis ? Number(durationMillis) / 1000 : null,
        assetType: isVideo ? 'video' : 'photo',
        createdTime: file.createdTime ?? file.modifiedTime ?? now,
        modifiedTime: file.modifiedTime ?? now,
        fileSize: file.size ? Number(file.size) : null,
        organicRights: rights.organicRights,
        organicRightsExpiration: rights.organicRightsExpiration,
        paidRights: rights.paidRights,
        paidRightsExpiration: rights.paidRightsExpiration,
        // User- or namer-managed columns — never set from Drive metadata
        creator: null,
        projectDescription: null,
        parsedCreator: parsed.creator,
        parsedShootDate: parsed.shootDate?.toISOString().split('T')[0] ?? null,
        parsedShootDescription: parsed.shootDescription,
    };
}
