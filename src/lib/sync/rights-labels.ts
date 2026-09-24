/**
 * Drive Label rights parsing — the single implementation used by the
 * overnight crawler (scripts/sync.ts) and the namer's targeted ingest.
 *
 * Field IDs and choice mappings come from app_settings via the caller
 * (Settings → Rights Label Config).
 *
 * No app-alias imports here: scripts import this module by relative path
 * under tsx, same as src/lib/filename-utils.
 */

export interface RightsLabelConfig {
    fieldIds: {
        organicRights: string;
        organicExpiration: string;
        paidRights: string;
        paidExpiration: string;
    };
    choiceMap: Record<string, string>;  // choice ID → 'unlimited' | 'limited' | 'expired'
}

export interface RightsLabelFields {
    organicRights: string | null;
    organicRightsExpiration: string | null;
    paidRights: string | null;
    paidRightsExpiration: string | null;
}

export function emptyRightsFields(): RightsLabelFields {
    return {
        organicRights: null,
        organicRightsExpiration: null,
        paidRights: null,
        paidRightsExpiration: null,
    };
}

/**
 * Extract rights fields from a Drive file's labelInfo.
 *
 * @param onLabelFields  Called with the raw label fields whenever a matching
 *                       label is found — the crawler uses this to log the
 *                       first labeled file for debugging.
 */
export function parseLabelFields(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    file: any,
    labelId: string,
    config: RightsLabelConfig,
    onLabelFields?: (fields: Record<string, unknown>) => void,
): RightsLabelFields {
    const result = emptyRightsFields();

    // Skip if rights label config is not set up
    const { fieldIds, choiceMap } = config;
    if (!fieldIds.organicRights && !fieldIds.paidRights) return result;

    if (!file.labelInfo?.labels) return result;

    for (const label of file.labelInfo.labels) {
        if (label.id !== labelId) continue;
        if (!label.fields) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fields = label.fields as Record<string, any>;
        onLabelFields?.(fields);

        if (fieldIds.organicRights && fields[fieldIds.organicRights]?.selection) {
            const choiceId = fields[fieldIds.organicRights].selection[0];
            result.organicRights = choiceMap[choiceId] ?? choiceId;
        }
        if (fieldIds.organicExpiration && fields[fieldIds.organicExpiration]?.dateString) {
            result.organicRightsExpiration = fields[fieldIds.organicExpiration].dateString[0] ?? null;
        }
        if (fieldIds.paidRights && fields[fieldIds.paidRights]?.selection) {
            const choiceId = fields[fieldIds.paidRights].selection[0];
            result.paidRights = choiceMap[choiceId] ?? choiceId;
        }
        if (fieldIds.paidExpiration && fields[fieldIds.paidExpiration]?.dateString) {
            result.paidRightsExpiration = fields[fieldIds.paidExpiration].dateString[0] ?? null;
        }
    }

    return result;
}
