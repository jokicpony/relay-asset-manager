// Core types for Relay Asset Manager

export type AssetType = 'photo' | 'video';

export type RightsStatus = 'unlimited' | 'limited' | 'expired' | null;

export type BadgeColor = 'green' | 'amber' | 'orange' | 'red' | 'gray';

export interface ComplianceBadge {
  label: 'ORG' | 'PAID';
  color: BadgeColor;
  status: string; // e.g., "Unlimited", "12d", "Expired", "Not Labeled"
  daysRemaining?: number;
}

export interface Asset {
  id: string;
  driveFileId: string;
  name: string;
  description: string | null;
  mimeType: string;
  assetType: AssetType;
  folderPath: string;
  thumbnailUrl: string;
  thumbColor?: string; // dominant colour (#rrggbb), shown while the thumbnail loads
  width: number;
  height: number;
  duration?: number; // video only, in seconds
  fileSize?: number; // bytes, from Google Drive

  // Rights / Compliance
  organicRights: RightsStatus;
  organicRightsExpiration: string | null; // ISO date string
  paidRights: RightsStatus;
  paidRightsExpiration: string | null; // ISO date string

  // Metadata (Drive Label overrides — filename parser is the fallback)
  creator: string | null;             // Drive Label override for creator (photographer, videographer, etc.)
  projectDescription: string | null;  // Drive Label field — project/product description string
  tags: string[];

  // System
  createdAt: string;

  // Shortcut provenance — project folders this asset is linked from
  shortcutFolders?: string[];

  // Shortcut clone marker — set when this entry represents a shortcut, not the original
  isShortcut?: boolean;
  originalFolderPath?: string;  // the master asset's real folder path
}

/**
 * GET /api/assets response. Shortcuts travel as [assetId, folderPath] pairs
 * and are expanded into clone entries client-side (see expandAssetList) —
 * sending full clones duplicated every field, descriptions included, for
 * each of ~1.2k shortcuts.
 */
export interface AssetListPayload {
  assets: Asset[];
  shortcuts: [string, string][];
}

export interface SearchFilters {
  query: string;
  folderPath: string | null;
  orientation: 'all' | 'landscape' | 'portrait' | 'square';
  expiredMode: 'hide' | 'show' | 'only';  // hide=default, show=include expired, only=cleanup mode
  assetType: AssetType | 'all';
  sortBy: 'newest' | 'oldest' | 'expiring-organic' | 'expiring-paid';
}

export interface FolderNode {
  id: string;
  name: string;
  path: string;
  children: FolderNode[];
}
