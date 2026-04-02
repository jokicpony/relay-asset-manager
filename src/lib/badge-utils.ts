import { RightsStatus, BadgeColor, ComplianceBadge } from '@/types';

/**
 * Calculate days remaining until a date.
 * Returns negative if the date is in the past.
 */
function daysUntil(dateStr: string | null): number | null {
    if (!dateStr) return null;
    const target = new Date(dateStr);
    const now = new Date();
    const diff = target.getTime() - now.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

/**
 * Format a number of days into a human-friendly compact string.
 *
 *   730 → "2y"     365 → "1y"
 *   548 → "1.5y"   270 → "9mo"
 *    45 → "45d"     12 → "12d"
 */
function formatTimeRemaining(days: number): string {
    if (days >= 365) {
        const years = days / 365;
        // Show decimal only for half-year increments (1.5y, 2.5y)
        if (years % 1 >= 0.4 && years % 1 <= 0.6) {
            return `${Math.floor(years)}.5y`;
        }
        return `${Math.round(years)}y`;
    }
    if (days >= 90) {
        return `${Math.round(days / 30)}mo`;
    }
    return `${days}d`;
}

/**
 * Determine the badge color and display status for a rights track.
 *
 * Tiered thresholds:
 *   - Unlimited          → Green  ("Unlimited")
 *   - Limited, 90+ days  → Green  ("2y", "8mo", "92d") — safe, with time context
 *   - Limited, 30–89     → Amber  ("45d") — approaching expiration
 *   - Limited, 1–29      → Orange ("12d") — urgent, expiring soon
 *   - Limited, ≤ 0       → Red    ("Expired")
 *   - Expired             → Red    ("Expired")
 *   - Not set             → Gray   ("Not Labeled")
 */
export function computeBadge(
    label: 'ORG' | 'PAID',
    rights: RightsStatus,
    expiration: string | null
): ComplianceBadge {
    if (!rights) {
        return { label, color: 'gray', status: 'Not Labeled' };
    }

    switch (rights) {
        case 'unlimited':
            return { label, color: 'green', status: 'Unlimited' };

        case 'limited': {
            const days = daysUntil(expiration);
            if (days === null || days <= 0) {
                return { label, color: 'red', status: 'Expired' };
            }

            const status = formatTimeRemaining(days);
            let color: BadgeColor;

            if (days >= 90) {
                color = 'green';       // Safe — plenty of runway
            } else if (days >= 30) {
                color = 'amber';       // Heads up — approaching expiration
            } else {
                color = 'orange';      // Urgent — expiring soon
            }

            return { label, color, status, daysRemaining: days };
        }

        case 'expired':
            return { label, color: 'red', status: 'Expired' };

        default:
            return { label, color: 'gray', status: 'Not Labeled' };
    }
}

/**
 * Get both compliance badges for an asset.
 */
export function getComplianceBadges(asset: {
    organicRights: RightsStatus;
    organicRightsExpiration: string | null;
    paidRights: RightsStatus;
    paidRightsExpiration: string | null;
}): [ComplianceBadge, ComplianceBadge] {
    return [
        computeBadge('ORG', asset.organicRights, asset.organicRightsExpiration),
        computeBadge('PAID', asset.paidRights, asset.paidRightsExpiration),
    ];
}

/**
 * Check if an asset is FULLY expired — at least one rights track is
 * expired AND the other is either also expired or unlabeled.
 * Used by "Hide Expired": hides assets with no usable rights remaining.
 *
 * Examples:
 *   expired + expired  → true  (both dead)
 *   expired + unlabeled → true  (one dead, other unknown)
 *   unlabeled + expired → true  (converse)
 *   expired + limited   → false (paid expired but organic still usable)
 *   unlabeled + unlabeled → false (no expiration, just unlabeled)
 */
export function isAssetFullyExpired(asset: {
    organicRights: RightsStatus;
    organicRightsExpiration: string | null;
    paidRights: RightsStatus;
    paidRightsExpiration: string | null;
}): boolean {
    const [orgBadge, paidBadge] = getComplianceBadges(asset);
    const orgExpired = orgBadge.color === 'red';
    const paidExpired = paidBadge.color === 'red';
    const orgUnusable = orgExpired || orgBadge.color === 'gray';
    const paidUnusable = paidExpired || paidBadge.color === 'gray';
    // At least one must be actually expired, and the other must have no usable rights
    return (orgExpired || paidExpired) && orgUnusable && paidUnusable;
}

/**
 * Check if an asset has ANY expired rights (organic OR paid).
 * Used by "Only Expired" cleanup mode and visual dimming.
 */
export function isAnyRightExpired(asset: {
    organicRights: RightsStatus;
    organicRightsExpiration: string | null;
    paidRights: RightsStatus;
    paidRightsExpiration: string | null;
}): boolean {
    const [orgBadge, paidBadge] = getComplianceBadges(asset);
    return orgBadge.color === 'red' || paidBadge.color === 'red';
}
