'use client';

import { memo, useState, useMemo } from 'react';

import { Asset } from '@/types';
import { getComplianceBadges } from '@/lib/badge-utils';
import { resolveCreator, parseFilename } from '@/lib/filename-utils';
import ComplianceBadge from './ComplianceBadge';
import Image from 'next/image';

// Grid row unit must match grid-auto-rows in globals.css
const ROW_UNIT = 10;

interface AssetCardProps {
    asset: Asset;
    selected: boolean;
    isExpired?: boolean;
    similarity?: number;
    textMatch?: boolean;
    onSelect: (id: string, shiftKey: boolean) => void;
    onExpand: (asset: Asset) => void;
    isPinned?: boolean;
    onTogglePin?: (id: string) => void;
    colWidth?: number;
}

const AssetCard = memo(function AssetCard({ asset, selected, isExpired, similarity, textMatch, onSelect, onExpand, isPinned, onTogglePin, colWidth = 300 }: AssetCardProps) {
    const [orgBadge, paidBadge] = getComplianceBadges(asset);
    const isVideo = asset.assetType === 'video';
    const creator = resolveCreator(asset);
    const parsed = parseFilename(asset.name);
    const [justPinned, setJustPinned] = useState(false);

    // Compute row span from aspect ratio for CSS Grid masonry.
    // colWidth is the actual measured column width from the parent's ResizeObserver.
    const rowSpan = useMemo(() => {
        const w = asset.width || 400;
        const h = asset.height || 300;
        const ratio = h / w;

        const estimatedHeight = Math.round(colWidth * ratio);
        // Minimum = 40% of column width so horizontals stay visible
        const minHeight = Math.round(colWidth * 0.4);
        return Math.max(
            Math.ceil(minHeight / ROW_UNIT),
            Math.ceil(estimatedHeight / ROW_UNIT)
        );
    }, [asset.width, asset.height, colWidth]);

    const handleClick = (e: React.MouseEvent) => {
        if (e.shiftKey || e.metaKey) {
            e.preventDefault();
            onSelect(asset.id, e.shiftKey);
        } else {
            onExpand(asset);
        }
    };

    const handleCheckboxClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onSelect(asset.id, e.shiftKey);
    };

    const handlePinClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onTogglePin) {
            onTogglePin(asset.id);
            if (!isPinned) {
                setJustPinned(true);
                setTimeout(() => setJustPinned(false), 350);
            }
        }
    };

    return (
        <div
            className={`asset-card masonry-item ${selected ? 'selected' : ''} ${isExpired ? 'expired-dimmed' : ''}`}
            style={{ gridRow: `span ${rowSpan}` }}
            onClick={handleClick}
        >
            {/* Selection checkbox */}
            <div className="select-check" onClick={handleCheckboxClick}>
                {selected && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M3 7L6 10L11 4" stroke="var(--ram-bg-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                )}
            </div>

            {/* Pin to board — bottom-right pill */}
            {onTogglePin && (
                <div
                    className={`pinboard-pin ${isPinned ? 'pinned' : ''} ${justPinned ? 'just-pinned' : ''}`}
                    onClick={handlePinClick}
                    title={isPinned ? 'Remove from Pinboard' : 'Pin to Board'}
                >
                    <svg width="11" height="11" viewBox="0 0 24 24"
                        fill={isPinned ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    >
                        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                    </svg>
                    {isPinned ? 'Pinned' : 'Pin'}
                </div>
            )}

            {/* Compliance badges */}
            <div className="badges">
                <ComplianceBadge badge={orgBadge} />
                <ComplianceBadge badge={paidBadge} />
            </div>

            {/* Thumbnail */}
            <Image
                src={asset.thumbnailUrl}
                alt={asset.description || asset.name}
                width={asset.width}
                height={asset.height}
                className="w-full h-auto block"
                sizes="(max-width: 480px) 100vw, (max-width: 768px) 50vw, (max-width: 1280px) 33vw, 25vw"
                loading="lazy"
            />

            {/* Video indicator */}
            {isVideo && (
                <div className="video-indicator">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path d="M6 4L16 10L6 16V4Z" fill="white" />
                    </svg>
                </div>
            )}


            {/* Hover overlay + HUD */}
            <div className="overlay" />
            <div className="hud">
                <div className="flex flex-col gap-1" style={{ maxWidth: '70%' }}>
                    {creator && (
                        <div className="flex items-center gap-1.5 text-[11px] text-white/80">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                                <circle cx="12" cy="8" r="4" />
                                <path d="M3 21c0-4.97 4.03-9 9-9s9 4.03 9 9" />
                            </svg>
                            <span className="truncate">{creator}</span>
                        </div>
                    )}
                    {parsed.shootDescription && (
                        <div className="flex items-center gap-1.5 text-[11px] text-white/80">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <path d="M3 9h18" />
                            </svg>
                            <span className="truncate">{parsed.shootDescription}</span>
                        </div>
                    )}
                    {(() => {
                        // Merge database tags with filename-parsed tags, deduplicated
                        const allTags = [...new Set([...asset.tags, ...parsed.tags])];
                        return allTags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                                {allTags.slice(0, 4).map((tag) => (
                                    <span
                                        key={tag}
                                        className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70"
                                    >
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        );
                    })()}
                    {isVideo && asset.duration && (
                        <div className="text-[10px] text-white/60 mt-0.5">
                            {Math.floor(asset.duration / 60)}:{String(asset.duration % 60).padStart(2, '0')}
                        </div>
                    )}
                    {similarity !== undefined && (
                        <div className="flex items-center gap-1.5 text-[10px] mt-0.5" style={{ color: 'rgba(52, 211, 153, 0.9)' }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                                <path d="M10 21h4" />
                            </svg>
                            <span>{Math.round(similarity * 100)}% semantic match</span>
                        </div>
                    )}
                    {textMatch && (
                        <div className="flex items-center gap-1.5 text-[10px] mt-0.5" style={{ color: 'rgba(147, 197, 253, 0.9)' }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M4 7h16M4 12h10M4 17h12" />
                            </svg>
                            <span>text match</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

export default AssetCard;
