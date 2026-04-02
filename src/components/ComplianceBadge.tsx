'use client';

import { ComplianceBadge as BadgeType } from '@/types';

interface ComplianceBadgeProps {
    badge: BadgeType;
}

const colorMap: Record<string, { bg: string; text: string; dot: string }> = {
    green: {
        bg: 'var(--ram-green-bg)',
        text: 'var(--ram-green)',
        dot: 'var(--ram-green)',
    },
    amber: {
        bg: 'var(--ram-amber-bg)',
        text: 'var(--ram-amber)',
        dot: 'var(--ram-amber)',
    },
    orange: {
        bg: 'var(--ram-orange-bg)',
        text: 'var(--ram-orange)',
        dot: 'var(--ram-orange)',
    },
    red: {
        bg: 'var(--ram-red-bg)',
        text: 'var(--ram-red)',
        dot: 'var(--ram-red)',
    },
    gray: {
        bg: 'var(--ram-gray-bg)',
        text: 'var(--ram-gray)',
        dot: 'var(--ram-gray)',
    },
};

export default function ComplianceBadge({ badge }: ComplianceBadgeProps) {
    const colors = colorMap[badge.color] || colorMap.gray;

    return (
        <div
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide leading-none"
            style={{
                background: colors.bg,
                color: colors.text,
                backdropFilter: 'blur(8px)',
            }}
            title={`${badge.label === 'ORG' ? 'Organic' : 'Paid'} Rights: ${badge.status}`}
        >
            <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: colors.dot }}
            />
            <span>{badge.label}</span>
            {badge.status !== 'Unlimited' && badge.status !== 'Not Labeled' && (
                <span className="opacity-80">{badge.status}</span>
            )}
        </div>
    );
}
