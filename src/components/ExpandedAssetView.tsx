'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Asset } from '@/types';
import { logger } from '@/lib/logger';
import { getComplianceBadges } from '@/lib/badge-utils';
import { resolveCreator, parseFilename } from '@/lib/filename-utils';
import ComplianceBadge from './ComplianceBadge';
import Image from 'next/image';

interface ExpandedAssetViewProps {
    asset: Asset;
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
    hasPrev: boolean;
    hasNext: boolean;
    onDownload?: (asset: Asset) => void;
    onRelay?: (asset: Asset) => void;
    isQueued?: boolean;
    isRelayed?: boolean;
    googleConnected?: boolean;
    onReconnect?: () => void;
    isPinned?: boolean;
    onTogglePin?: (asset: Asset) => void;
    onThumbnailUpdated?: (assetId: string, newUrl: string) => void;
}

export default function ExpandedAssetView({
    asset,
    onClose,
    onPrev,
    onNext,
    hasPrev,
    hasNext,
    onDownload,
    onRelay,
    isQueued = false,
    isRelayed = false,
    googleConnected = true,
    onReconnect,
    isPinned = false,
    onTogglePin,
    onThumbnailUpdated,
}: ExpandedAssetViewProps) {
    // Format bytes into human-readable size
    const formatFileSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };
    const [orgBadge, paidBadge] = getComplianceBadges(asset);
    const isVideo = asset.assetType === 'video';
    const isLandscape = asset.width > asset.height;
    const creator = resolveCreator(asset);
    const parsed = parseFilename(asset.name);
    const [playing, setPlaying] = useState(false);
    const [videoReady, setVideoReady] = useState(false);
    const [wantPlay, setWantPlay] = useState(false); // user clicked play but video isn't ready
    const [slowBuffer, setSlowBuffer] = useState(false); // true after delay of buffering
    const [descExpanded, setDescExpanded] = useState(false);
    const [captureFeedback, setCaptureFeedback] = useState<'idle' | 'capturing' | 'success' | 'error'>('idle');
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const drivePreviewUrl = `https://drive.google.com/file/d/${asset.driveFileId}/view`;
    const isLargeFile = (asset.fileSize ?? 0) > 100 * 1024 * 1024; // >100MB

    const videoSrc = isVideo ? `/api/drive/stream/${asset.driveFileId}` : '';

    // Download feedback state: 'idle' → 'spinning' → 'confirmed' → 'idle'
    const [downloadFeedback, setDownloadFeedback] = useState<'idle' | 'spinning' | 'confirmed'>('idle');
    // Copy link feedback
    const [linkCopied, setLinkCopied] = useState(false);
    const dlFeedbackTimer = useRef<NodeJS.Timeout | null>(null);

    // Reset states when asset changes (nav prev/next)
    useEffect(() => {
        setPlaying(false);
        setVideoReady(false);
        setWantPlay(false);
        setSlowBuffer(false);
        setDescExpanded(false);
        setDownloadFeedback('idle');
        setCaptureFeedback('idle');
        setLinkCopied(false);
        if (dlFeedbackTimer.current) clearTimeout(dlFeedbackTimer.current);
    }, [asset.id]);

    const handleDownload = useCallback(() => {
        if (!googleConnected || isQueued || !onDownload || downloadFeedback !== 'idle') return;
        onDownload(asset);
        setDownloadFeedback('spinning');
        dlFeedbackTimer.current = setTimeout(() => {
            setDownloadFeedback('confirmed');
            dlFeedbackTimer.current = setTimeout(() => {
                setDownloadFeedback('idle');
            }, 800);
        }, 800);
    }, [googleConnected, isQueued, onDownload, downloadFeedback, asset]);

    // Show "Having trouble?" fallback — immediately for large files, after 8s for others
    useEffect(() => {
        if (!wantPlay || videoReady) {
            setSlowBuffer(false);
            return;
        }
        if (isLargeFile) {
            setSlowBuffer(true);
            return;
        }
        const timer = setTimeout(() => setSlowBuffer(true), 8_000);
        return () => clearTimeout(timer);
    }, [wantPlay, videoReady, isLargeFile]);

    // Preload video on expand — start fetching immediately
    useEffect(() => {
        if (!isVideo || !asset.driveFileId) return;

        const video = videoRef.current;
        if (!video) return;

        const handleCanPlay = () => setVideoReady(true);
        video.addEventListener('canplay', handleCanPlay);

        // Trigger preload
        video.src = videoSrc;
        video.load();

        return () => {
            video.removeEventListener('canplay', handleCanPlay);
            video.pause();
            video.removeAttribute('src');
            video.load(); // release the buffer
        };
    }, [isVideo, asset.driveFileId, videoSrc]);

    // Auto-play when video becomes ready AND user already clicked play
    useEffect(() => {
        if (wantPlay && videoReady) {
            setWantPlay(false);
            setPlaying(true);
            setTimeout(() => {
                videoRef.current?.play();
            }, 50);
        }
    }, [wantPlay, videoReady]);

    const handlePlay = () => {
        if (videoReady) {
            // Video is buffered — play immediately
            setPlaying(true);
            setTimeout(() => {
                videoRef.current?.play();
            }, 50);
        } else {
            // Video still loading — show spinner, will auto-play when ready
            setWantPlay(true);
        }
    };

    const handleVideoEnd = () => {
        setPlaying(false);
        setVideoReady(true); // keep ready state so they can replay instantly
    };

    // Capture current video frame as thumbnail
    const captureFrame = useCallback(async () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;

        setCaptureFeedback('capturing');

        try {
            // Draw current frame to canvas
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Canvas context unavailable');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            // Convert to blob
            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(
                    (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
                    'image/webp',
                    0.85
                );
            });

            // Upload via API
            const formData = new FormData();
            formData.append('file', blob, 'frame.webp');
            formData.append('driveFileId', asset.driveFileId);

            const res = await fetch('/api/assets/thumbnail', {
                method: 'POST',
                body: formData,
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Upload failed');
            }

            const { thumbnailUrl } = await res.json();
            onThumbnailUpdated?.(asset.id, thumbnailUrl);
            setCaptureFeedback('success');
            setTimeout(() => setCaptureFeedback('idle'), 2000);
        } catch (err) {
            logger.error('frame-capture', 'Failed to capture frame', { error: err instanceof Error ? err.message : String(err) });
            setCaptureFeedback('error');
            setTimeout(() => setCaptureFeedback('idle'), 3000);
        }
    }, [asset.driveFileId, asset.id, onThumbnailUpdated]);

    // Cancel / bail on video preview — kills buffering entirely
    const handleCancelPreview = (e: React.MouseEvent) => {
        e.stopPropagation();
        setWantPlay(false);
        setPlaying(false);
        setSlowBuffer(false);
        const video = videoRef.current;
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load(); // release network connection + buffer
        }
        setVideoReady(false);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-content flex flex-col max-w-5xl w-full max-h-[90vh] mx-4 rounded-2xl overflow-hidden"
                style={{
                    background: 'var(--ram-bg-secondary)',
                    border: '1px solid var(--ram-border)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div
                    className="flex items-center justify-between px-5 py-3 flex-shrink-0"
                    style={{ borderBottom: '1px solid var(--ram-border)' }}
                >
                    <div className="flex items-center gap-3 min-w-0">
                        <h2 className="text-sm font-medium truncate" style={{ color: 'var(--ram-text-primary)' }}>
                            {asset.name}
                        </h2>
                        <div className="flex gap-1.5 flex-shrink-0">
                            <ComplianceBadge badge={orgBadge} />
                            <ComplianceBadge badge={paidBadge} />
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-[var(--ram-bg-hover)] transition-colors flex-shrink-0"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-secondary)" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Content area */}
                <div className="flex flex-1 min-h-0">
                    {/* Preview */}
                    <div className="flex-1 relative flex items-center justify-center p-6 min-w-0" style={{ background: 'var(--ram-bg-primary)' }}>
                        {/* Nav arrows */}
                        {hasPrev && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onPrev(); }}
                                className="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full flex items-center justify-center transition-all hover:scale-110"
                                style={{
                                    background: 'rgba(0, 0, 0, 0.55)',
                                    backdropFilter: 'blur(4px)',
                                    border: '1px solid rgba(255, 255, 255, 0.15)',
                                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
                                }}
                                title="Previous (←)"
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                                    <path d="M15 18l-6-6 6-6" />
                                </svg>
                            </button>
                        )}
                        {hasNext && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onNext(); }}
                                className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full flex items-center justify-center transition-all hover:scale-110"
                                style={{
                                    background: 'rgba(0, 0, 0, 0.55)',
                                    backdropFilter: 'blur(4px)',
                                    border: '1px solid rgba(255, 255, 255, 0.15)',
                                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
                                }}
                                title="Next (→)"
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                                    <path d="M9 18l6-6-6-6" />
                                </svg>
                            </button>
                        )}

                        {/* Hidden preload video element */}
                        {isVideo && (
                            <video
                                ref={videoRef}
                                preload="auto"
                                onEnded={handleVideoEnd}
                                className={playing ? `rounded-lg ${isLandscape ? 'w-full' : 'h-full'}` : 'hidden'}
                                style={playing ? { maxHeight: '60vh', maxWidth: '100%', background: '#000' } : { display: 'none' }}
                                controls={playing}
                            />
                        )}

                        {isVideo ? (
                            !playing ? (
                                <div
                                    className="relative cursor-pointer group"
                                    onClick={handlePlay}
                                    style={{ maxHeight: '60vh' }}
                                >
                                    <Image
                                        src={asset.thumbnailUrl}
                                        alt={asset.name}
                                        width={asset.width}
                                        height={asset.height}
                                        className={`object-contain rounded-lg ${isLandscape ? 'w-full' : 'h-full'}`}
                                        style={{ maxHeight: '60vh' }}
                                        priority
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        {wantPlay ? (
                                            /* User clicked play but video still buffering */
                                            <div className="flex flex-col items-center gap-3">
                                                <div
                                                    className="w-12 h-12 rounded-full border-2 border-t-transparent animate-spin"
                                                    style={{ borderColor: 'rgba(255,255,255,0.3)', borderTopColor: 'transparent' }}
                                                />
                                                <span
                                                    className="text-xs font-medium px-3 py-1 rounded-full"
                                                    style={{ background: 'rgba(0, 0, 0, 0.5)', color: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(4px)' }}
                                                >
                                                    Buffering…
                                                </span>
                                            </div>
                                        ) : (
                                            /* Normal play button */
                                            <div
                                                className="w-16 h-16 rounded-full flex items-center justify-center transition-transform group-hover:scale-110"
                                                style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(8px)' }}
                                            >
                                                <svg width="28" height="28" viewBox="0 0 20 20" fill="white">
                                                    <path d="M6 4L16 10L6 16V4Z" />
                                                </svg>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ) : null /* video element shown above via className toggle */
                        ) : (
                            <Image
                                src={asset.thumbnailUrl}
                                alt={asset.description || asset.name}
                                width={asset.width}
                                height={asset.height}
                                className={`object-contain rounded-lg ${isLandscape ? 'w-full' : 'h-full'}`}
                                style={{ maxHeight: '60vh' }}
                                priority
                            />
                        )}

                        {/* Hidden canvas for frame capture */}
                        <canvas ref={canvasRef} style={{ display: 'none' }} />

                        {/* Stop Preview + Use This Frame buttons — visible during playback */}
                        {isVideo && (wantPlay || playing) && (
                            <div className="absolute bottom-3 left-3 flex items-center gap-2 z-10">
                                <button
                                    onClick={handleCancelPreview}
                                    className="flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1 rounded-md transition-opacity opacity-40 hover:opacity-100"
                                    style={{
                                        background: 'rgba(0, 0, 0, 0.5)',
                                        color: 'rgba(255, 255, 255, 0.8)',
                                        backdropFilter: 'blur(4px)',
                                        border: 'none',
                                        cursor: 'pointer',
                                    }}
                                    title="Stop video preview and release buffering"
                                >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                                        <rect x="6" y="6" width="12" height="12" rx="1" />
                                    </svg>
                                    Stop Preview
                                </button>
                                {playing && onThumbnailUpdated && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); captureFrame(); }}
                                        disabled={captureFeedback !== 'idle'}
                                        className="flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1 rounded-md transition-all"
                                        style={{
                                            background: captureFeedback === 'success'
                                                ? 'rgba(52, 211, 153, 0.6)'
                                                : captureFeedback === 'error'
                                                    ? 'rgba(248, 113, 113, 0.6)'
                                                    : 'rgba(232, 168, 56, 0.7)',
                                            color: '#fff',
                                            backdropFilter: 'blur(4px)',
                                            border: 'none',
                                            cursor: captureFeedback !== 'idle' ? 'default' : 'pointer',
                                            opacity: captureFeedback === 'capturing' ? 0.7 : 1,
                                        }}
                                        title="Capture this frame as the thumbnail for this asset"
                                    >
                                        {captureFeedback === 'capturing' ? (
                                            <>
                                                <div
                                                    className="w-2.5 h-2.5 rounded-full border-[1.5px] animate-spin"
                                                    style={{ borderColor: 'transparent', borderTopColor: '#fff' }}
                                                />
                                                Saving…
                                            </>
                                        ) : captureFeedback === 'success' ? (
                                            <>
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                                    <polyline points="20 6 9 17 4 12" />
                                                </svg>
                                                Thumbnail Set ✓
                                            </>
                                        ) : captureFeedback === 'error' ? (
                                            'Failed — try again'
                                        ) : (
                                            <>
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <rect x="3" y="3" width="18" height="18" rx="2" />
                                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                                    <path d="M21 15l-5-5L5 21" />
                                                </svg>
                                                Use This Frame as Thumbnail
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Subtle persistent Drive link for all videos */}
                        {isVideo && (
                            <a
                                href={googleConnected ? drivePreviewUrl : undefined}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (!googleConnected) {
                                        e.preventDefault();
                                        onReconnect?.();
                                    }
                                }}
                                className="absolute bottom-3 right-3 flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1 rounded-md transition-opacity opacity-40 hover:opacity-100 z-10"
                                style={{
                                    background: 'rgba(0, 0, 0, 0.5)',
                                    color: googleConnected ? 'rgba(255, 255, 255, 0.8)' : 'var(--ram-amber, #f59e0b)',
                                    backdropFilter: 'blur(4px)',
                                }}
                                title={googleConnected ? 'Open in Google Drive' : 'Reconnect Google Drive to preview'}
                            >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                </svg>
                                {googleConnected ? 'Having trouble previewing? Open in Drive' : 'Reconnect Drive to preview'}
                            </a>
                        )}
                    </div>

                    {/* Metadata panel */}
                    <div
                        className="w-72 flex-shrink-0 overflow-y-auto p-5 flex flex-col gap-5"
                        style={{ borderLeft: '1px solid var(--ram-border)' }}
                    >
                        {/* Description */}
                        {asset.description && (
                            <MetadataSection title="Description">
                                <p className="text-sm leading-relaxed" style={{ color: 'var(--ram-text-secondary)' }}>
                                    {asset.description.length > 120 && !descExpanded
                                        ? asset.description.slice(0, asset.description.lastIndexOf(' ', 120) || 120) + '…'
                                        : asset.description
                                    }
                                </p>
                                {asset.description.length > 120 && (
                                    <button
                                        onClick={() => setDescExpanded(!descExpanded)}
                                        className="text-xs mt-1.5 font-medium transition-colors"
                                        style={{ color: 'var(--ram-accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                                    >
                                        {descExpanded ? 'Show less' : 'Show more'}
                                    </button>
                                )}
                            </MetadataSection>
                        )}

                        {/* Details */}
                        <MetadataSection title="Details">
                            <MetadataRow label="Type" value={asset.assetType === 'video' ? 'Video' : 'Photo'} />
                            <MetadataRow label="Dimensions" value={`${asset.width} × ${asset.height}`} />
                            <MetadataRow
                                label="Orientation"
                                value={asset.width > asset.height ? 'Landscape' : asset.width < asset.height ? 'Portrait' : 'Square'}
                            />
                            {asset.duration && (
                                <MetadataRow
                                    label="Duration"
                                    value={`${Math.floor(asset.duration / 60)}:${String(asset.duration % 60).padStart(2, '0')}`}
                                />
                            )}
                            <MetadataRow label="Format" value={asset.mimeType.split('/')[1]?.toUpperCase() || asset.mimeType} />
                            {asset.fileSize && (
                                <MetadataRow label="File Size" value={formatFileSize(asset.fileSize)} />
                            )}
                            {asset.createdAt && (
                                <MetadataRow
                                    label="Created"
                                    value={new Date(asset.createdAt).toLocaleDateString('en-US', {
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                    })}
                                />
                            )}
                        </MetadataSection>

                        {/* Credits (from filename parser or Drive Labels) */}
                        {(creator || parsed.shootDescription) && (
                            <MetadataSection title="Credits">
                                {creator && <MetadataRow label="Creator" value={creator} />}
                                {parsed.shootDescription && <MetadataRow label="Project" value={parsed.shootDescription} />}
                                {asset.projectDescription && <MetadataRow label="Project" value={asset.projectDescription} />}
                            </MetadataSection>
                        )}

                        {/* Tags */}
                        {asset.tags.length > 0 && (
                            <MetadataSection title="Tags">
                                <div className="flex flex-wrap gap-1.5">
                                    {asset.tags.map((tag) => (
                                        <span
                                            key={tag}
                                            className="text-xs px-2 py-1 rounded-md"
                                            style={{
                                                background: 'var(--ram-bg-hover)',
                                                color: 'var(--ram-text-secondary)',
                                            }}
                                        >
                                            {tag}
                                        </span>
                                    ))}
                                </div>
                            </MetadataSection>
                        )}

                        {/* Compliance */}
                        <MetadataSection title="Compliance">
                            <div className="flex flex-col gap-2">
                                <ComplianceDetailRow badge={orgBadge} label="Organic Rights" expiration={asset.organicRightsExpiration} />
                                <ComplianceDetailRow badge={paidBadge} label="Paid Rights" expiration={asset.paidRightsExpiration} />
                            </div>
                        </MetadataSection>

                        {/* Shortcut origin — shown when viewing a shortcut clone */}
                        {asset.isShortcut && asset.originalFolderPath && (
                            <MetadataSection title="Shortcut">
                                <div
                                    className="flex items-start gap-2 text-xs p-2.5 rounded-lg"
                                    style={{ background: 'var(--ram-accent-muted)', color: 'var(--ram-accent)' }}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
                                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                    </svg>
                                    <span className="break-all leading-relaxed">
                                        Original file is in <strong>{asset.originalFolderPath}</strong>
                                    </span>
                                </div>
                            </MetadataSection>
                        )}

                        {/* Folder */}
                        <MetadataSection title="Location">
                            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ram-text-secondary)' }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                </svg>
                                <span className="break-all">{asset.isShortcut ? asset.originalFolderPath : asset.folderPath}</span>
                            </div>
                        </MetadataSection>

                        {/* Shortcut provenance — project folders this asset is linked from */}
                        {!asset.isShortcut && asset.shortcutFolders && asset.shortcutFolders.length > 0 && (
                            <MetadataSection title="Also In">
                                <div className="flex flex-col gap-1.5">
                                    {asset.shortcutFolders.map((folder) => {
                                        const folderName = folder.split('/').filter(Boolean).pop() || folder;
                                        return (
                                            <div key={folder} className="flex items-center gap-2 text-xs" style={{ color: 'var(--ram-text-secondary)' }}>
                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ram-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0" style={{ opacity: 0.7 }}>
                                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                                </svg>
                                                <span className="break-all" title={folder}>{folderName}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </MetadataSection>
                        )}

                        {/* Quick actions */}
                        <div className="flex flex-col gap-2 mt-2 pt-4" style={{ borderTop: '1px solid var(--ram-border)' }}>
                            {/* Reconnect banner when Drive is disconnected */}
                            {!googleConnected && (
                                <button
                                    onClick={() => onReconnect?.()}
                                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99]"
                                    style={{
                                        background: 'rgba(251, 191, 36, 0.12)',
                                        border: '1px solid rgba(251, 191, 36, 0.35)',
                                        color: 'var(--ram-amber, #fbbf24)',
                                    }}
                                >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                                        <polyline points="10 17 15 12 10 7" />
                                        <line x1="15" y1="12" x2="3" y2="12" />
                                    </svg>
                                    Reconnect Drive
                                </button>
                            )}

                            {/* Primary: Download */}
                            {onDownload && (
                                <button
                                    onClick={handleDownload}
                                    disabled={!googleConnected || isQueued || downloadFeedback !== 'idle'}
                                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99] disabled:hover:scale-100"
                                    style={{
                                        background: downloadFeedback === 'confirmed' || isQueued
                                            ? 'rgba(52, 211, 153, 0.1)'
                                            : downloadFeedback === 'spinning'
                                                ? 'var(--ram-accent-muted)'
                                                : 'var(--ram-accent)',
                                        border: downloadFeedback === 'confirmed' || isQueued
                                            ? '1px solid rgba(52, 211, 153, 0.3)'
                                            : '1px solid transparent',
                                        color: downloadFeedback === 'confirmed' || isQueued
                                            ? 'var(--ram-green, #34d399)'
                                            : downloadFeedback === 'spinning'
                                                ? 'var(--ram-accent)'
                                                : 'var(--ram-bg-primary)',
                                        opacity: !googleConnected ? 0.35 : 1,
                                        cursor: !googleConnected ? 'not-allowed' : isQueued ? 'default' : 'pointer',
                                    }}
                                >
                                    {downloadFeedback === 'confirmed' || isQueued ? (
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    ) : downloadFeedback === 'spinning' ? (
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                                        </svg>
                                    ) : (
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                            <polyline points="7 10 12 15 17 10" />
                                            <line x1="12" y1="15" x2="12" y2="3" />
                                        </svg>
                                    )}
                                    {downloadFeedback === 'confirmed' || isQueued
                                        ? 'Queued ✓'
                                        : downloadFeedback === 'spinning'
                                            ? 'Downloading…'
                                            : 'Download'}
                                </button>
                            )}

                            {/* Secondary: Shortcut to Folder */}
                            {onRelay && (
                                <div className="relative" title={!googleConnected ? 'Reconnect Drive to create shortcut' : asset.isShortcut ? 'Shortcuts cannot be shortcutted — only original files' : isRelayed ? 'Already shortcutted this session' : undefined}>
                                    <button
                                        onClick={() => googleConnected && !asset.isShortcut && !isRelayed && onRelay(asset)}
                                        disabled={!googleConnected || asset.isShortcut || isRelayed}
                                        className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99] disabled:hover:scale-100"
                                        style={{
                                            background: isRelayed ? 'rgba(52, 211, 153, 0.1)' : asset.isShortcut ? 'var(--ram-bg-tertiary)' : 'var(--ram-bg-hover)',
                                            color: isRelayed ? 'var(--ram-green, #34d399)' : asset.isShortcut ? 'var(--ram-text-tertiary)' : 'var(--ram-text-primary)',
                                            border: `1px solid ${isRelayed ? 'rgba(52, 211, 153, 0.3)' : 'var(--ram-border-hover)'}`,
                                            opacity: !googleConnected ? 0.35 : asset.isShortcut ? 0.4 : 1,
                                            cursor: !googleConnected || asset.isShortcut || isRelayed ? 'not-allowed' : 'pointer',
                                        }}
                                    >
                                        {isRelayed ? (
                                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                        ) : (
                                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M9 3H5a2 2 0 0 0-2 2v4" />
                                                <path d="M15 3h4a2 2 0 0 1 2 2v4" />
                                                <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
                                                <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
                                                <path d="M12 8v8" />
                                                <path d="M8 12h8" />
                                            </svg>
                                        )}
                                        {isRelayed ? 'Shortcut Created ✓' : 'Shortcut to Folder'}
                                    </button>
                                    {asset.isShortcut && (
                                        <p className="text-[10px] mt-1 text-center" style={{ color: 'var(--ram-text-tertiary)' }}>
                                            Shortcuts cannot be shortcutted — only original files
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* Tertiary row: Pin + Copy Link — compact, side by side */}
                            <div className="flex gap-2">
                                {onTogglePin && (
                                    <button
                                        onClick={() => onTogglePin(asset)}
                                        className="flex items-center justify-center gap-1.5 flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all hover:scale-[1.01] active:scale-[0.99]"
                                        style={{
                                            background: isPinned ? 'var(--ram-accent-muted)' : 'var(--ram-bg-tertiary)',
                                            border: `1px solid ${isPinned ? 'rgba(232, 168, 56, 0.35)' : 'var(--ram-border)'}`,
                                            color: isPinned ? 'var(--ram-accent)' : 'var(--ram-text-secondary)',
                                        }}
                                        title={isPinned ? 'Unpin from board' : 'Pin to board'}
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24"
                                            fill={isPinned ? 'currentColor' : 'none'}
                                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                                        >
                                            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                                        </svg>
                                        {isPinned ? 'Pinned' : 'Pin'}
                                    </button>
                                )}
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(`https://drive.google.com/file/d/${asset.driveFileId}/view`);
                                        setLinkCopied(true);
                                        setTimeout(() => setLinkCopied(false), 2000);
                                    }}
                                    className="flex items-center justify-center gap-1.5 flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all hover:scale-[1.01] active:scale-[0.99]"
                                    style={{
                                        background: linkCopied ? 'rgba(52, 211, 153, 0.1)' : 'var(--ram-bg-tertiary)',
                                        border: `1px solid ${linkCopied ? 'rgba(52, 211, 153, 0.3)' : 'var(--ram-border)'}`,
                                        color: linkCopied ? 'var(--ram-green, #34d399)' : 'var(--ram-text-secondary)',
                                    }}
                                    title="Copy Google Drive link to clipboard"
                                >
                                    {linkCopied ? (
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    ) : (
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                    )}
                                    {linkCopied ? 'Copied' : 'Link'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MetadataSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <h3
                className="text-[10px] font-semibold uppercase tracking-wider mb-2"
                style={{ color: 'var(--ram-text-tertiary)' }}
            >
                {title}
            </h3>
            {children}
        </div>
    );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex justify-between items-start py-1">
            <span className="text-xs" style={{ color: 'var(--ram-text-tertiary)' }}>{label}</span>
            <span className="text-xs text-right ml-3" style={{ color: 'var(--ram-text-secondary)' }}>{value}</span>
        </div>
    );
}

function ComplianceDetailRow({
    badge,
    label,
    expiration,
}: {
    badge: { color: string; status: string };
    label: string;
    expiration: string | null;
}) {
    const colorMap: Record<string, string> = {
        green: 'var(--ram-green)',
        amber: 'var(--ram-amber)',
        orange: 'var(--ram-orange)',
        red: 'var(--ram-red)',
        gray: 'var(--ram-gray)',
    };

    return (
        <div
            className="flex items-center justify-between py-2 px-3 rounded-lg"
            style={{ background: 'var(--ram-bg-tertiary)' }}
        >
            <div className="flex items-center gap-2">
                <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: colorMap[badge.color] || colorMap.gray }}
                />
                <span className="text-xs" style={{ color: 'var(--ram-text-secondary)' }}>{label}</span>
            </div>
            <div className="text-xs font-medium" style={{ color: colorMap[badge.color] || colorMap.gray }}>
                {badge.status}
                {expiration && badge.status !== 'Expired' && badge.status !== 'Unlimited' && (
                    <span className="ml-1 opacity-60 font-normal">
                        ({new Date(expiration).toLocaleDateString()})
                    </span>
                )}
            </div>
        </div>
    );
}
