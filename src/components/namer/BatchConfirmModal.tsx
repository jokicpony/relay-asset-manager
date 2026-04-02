'use client';

import type { SchemaField, DriveLabel } from '@/lib/namer/types';
import { PASSTHROUGH_SCHEMA_KEY } from '@/lib/namer/types';

interface BatchConfirmModalProps {
    pendingCount: number;
    aiEnabled: boolean;
    selectedSchema: string;
    schemaFields: SchemaField[];
    labels: DriveLabel[];
    selectedLabelIds: string[];
    labelFieldValues: Record<string, Record<string, { value: string | string[]; type: string }>>;
    destFolderName: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function BatchConfirmModal({
    pendingCount,
    aiEnabled,
    selectedSchema,
    schemaFields,
    labels,
    selectedLabelIds,
    labelFieldValues,
    destFolderName,
    onConfirm,
    onCancel,
}: BatchConfirmModalProps) {
    // Build naming template preview
    const templateParts = schemaFields
        .filter(f => f.value || f.type === 'counter')
        .map(f => f.type === 'counter' ? '001' : f.value!.replace(/\s+/g, '-'));

    // Count label field stats
    const selectedLabels = labels.filter(l => selectedLabelIds.includes(l.id));
    const labelStats = selectedLabels.map(label => {
        const fields = label.fields || [];
        const values = labelFieldValues[label.id] || {};
        const appliedFields = fields.filter(f => {
            const v = values[f.id];
            if (!v) return false;
            if (Array.isArray(v.value)) return v.value.length > 0;
            return !!v.value;
        });
        const blankFields = fields.filter(f => {
            const v = values[f.id];
            if (!v) return true;
            if (Array.isArray(v.value)) return v.value.length === 0;
            return !v.value;
        });
        return { label, fields, appliedFields, blankFields, values };
    });

    const hasLabels = selectedLabels.length > 0;

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.6)',
                backdropFilter: 'blur(4px)',
            }}
            onClick={onCancel}
        >
            <div
                onClick={e => e.stopPropagation()}
                style={{
                    width: hasLabels ? '760px' : '440px',
                    maxWidth: '90vw',
                    maxHeight: '85vh',
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#1a1c22',
                    borderRadius: '16px',
                    border: '1px solid var(--ram-border)',
                    boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
                    overflow: 'hidden',
                }}
            >
                {/* Header */}
                <div style={{
                    padding: '20px 24px 16px',
                    borderBottom: '1px solid var(--ram-border)',
                    flexShrink: 0,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ram-teal)" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ram-text-primary)', margin: 0 }}>
                            Confirm Batch Execution
                        </h2>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--ram-text-tertiary)', margin: '4px 0 0 30px' }}>
                        Review settings before processing
                    </p>
                </div>

                {/* Body — two-column when labels exist */}
                <div style={{
                    display: 'flex',
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                }}>
                    {/* Left column: Files, AI, Naming */}
                    <div style={{
                        flex: hasLabels ? '0 0 50%' : '1',
                        padding: '20px 24px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '18px',
                        borderRight: hasLabels ? '1px solid var(--ram-border)' : 'none',
                    }}>
                        {/* FILES TO PROCESS */}
                        <SectionRow
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ram-accent)" strokeWidth="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                            </svg>}
                            label="FILES TO PROCESS"
                            color="var(--ram-accent)"
                        >
                            <p style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ram-text-primary)', margin: 0 }}>
                                {pendingCount} file{pendingCount !== 1 ? 's' : ''}
                            </p>
                            <p style={{ fontSize: '12px', color: 'var(--ram-text-tertiary)', margin: '2px 0 0' }}>
                                → {destFolderName || 'No destination set'}
                            </p>
                        </SectionRow>

                        {/* AI ANALYSIS */}
                        <SectionRow
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
                                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                                <path d="M2 17l10 5 10-5" />
                                <path d="M2 12l10 5 10-5" />
                            </svg>}
                            label="AI ANALYSIS"
                            color="#a78bfa"
                        >
                            <p style={{
                                fontSize: '14px',
                                fontWeight: 600,
                                color: aiEnabled ? 'var(--ram-teal)' : 'var(--ram-text-tertiary)',
                                margin: 0,
                            }}>
                                {aiEnabled
                                    ? `${pendingCount} photo${pendingCount !== 1 ? 's' : ''} will be analyzed via Gemini`
                                    : 'AI analysis disabled'}
                            </p>
                        </SectionRow>

                        {/* NAMING TEMPLATE */}
                        <SectionRow
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c084fc" strokeWidth="2">
                                <line x1="4" y1="9" x2="20" y2="9" />
                                <line x1="4" y1="15" x2="20" y2="15" />
                                <line x1="10" y1="3" x2="8" y2="21" />
                                <line x1="16" y1="3" x2="14" y2="21" />
                            </svg>}
                            label="NAMING TEMPLATE"
                            color="#c084fc"
                        >
                            {selectedSchema === PASSTHROUGH_SCHEMA_KEY ? (
                                <>
                                    <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--ram-teal)', margin: 0 }}>
                                        Keep Original Name
                                    </p>
                                    <p style={{
                                        fontSize: '12px',
                                        color: 'var(--ram-text-tertiary)',
                                        margin: '4px 0 0',
                                    }}>
                                        Files will not be renamed
                                    </p>
                                </>
                            ) : (
                                <>
                                    <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--ram-text-primary)', margin: 0 }}>
                                        {selectedSchema.replace(/_/g, '_')}
                                    </p>
                                    <p style={{
                                        fontSize: '12px',
                                        color: 'var(--ram-text-secondary)',
                                        fontFamily: 'monospace',
                                        margin: '4px 0 0',
                                        wordBreak: 'break-all',
                                    }}>
                                        {templateParts.join(' → ')}
                                    </p>
                                </>
                            )}
                        </SectionRow>

                        {/* No labels message */}
                        {!hasLabels && (
                            <div style={{ fontSize: '12px', color: 'var(--ram-text-tertiary)', fontStyle: 'italic' }}>
                                No content tags selected
                            </div>
                        )}
                    </div>

                    {/* Right column: Labels (only when labels selected) */}
                    {hasLabels && (
                        <div style={{
                            flex: '0 0 50%',
                            padding: '20px 24px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '18px',
                            overflowY: 'auto',
                        }}>
                            {labelStats.map(({ label, appliedFields, blankFields, fields, values }) => (
                                <SectionRow
                                    key={label.id}
                                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ram-accent)" strokeWidth="2">
                                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                                        <line x1="7" y1="7" x2="7.01" y2="7" />
                                    </svg>}
                                    label={(label.properties?.title || label.id).toUpperCase()}
                                    color="var(--ram-accent)"
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                                        <span style={{ fontSize: '13px', color: 'var(--ram-teal)', fontWeight: 600 }}>
                                            ✓ {appliedFields.length} applied
                                        </span>
                                        <span style={{ fontSize: '13px', color: 'var(--ram-text-tertiary)' }}>
                                            — {blankFields.length} blank
                                        </span>
                                    </div>

                                    {/* Tag detail card */}
                                    <div style={{
                                        background: 'rgba(255,255,255,0.03)',
                                        borderRadius: '8px',
                                        border: '1px solid var(--ram-border)',
                                        overflow: 'hidden',
                                    }}>
                                        <div style={{
                                            padding: '8px 12px',
                                            borderBottom: '1px solid var(--ram-border)',
                                            fontSize: '12px',
                                            fontWeight: 700,
                                            color: 'var(--ram-text-primary)',
                                        }}>
                                            {label.properties?.title || label.id}
                                        </div>
                                        {fields.map(field => {
                                            const v = values[field.id];
                                            const hasValue = v && (Array.isArray(v.value) ? v.value.length > 0 : !!v.value);
                                            // Resolve selection choice IDs to display names
                                            let displayValue = '—';
                                            if (hasValue) {
                                                const rawValues = Array.isArray(v!.value) ? v!.value : [v!.value];
                                                if (field.selectionOptions?.choices) {
                                                    const resolved = rawValues.map(id => {
                                                        const choice = field.selectionOptions!.choices.find(c => c.id === id);
                                                        return choice?.properties?.displayName || id;
                                                    });
                                                    displayValue = resolved.join(', ');
                                                } else {
                                                    displayValue = rawValues.join(', ');
                                                }
                                            }

                                            return (
                                                <div
                                                    key={field.id}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'space-between',
                                                        padding: '6px 12px',
                                                        borderBottom: '1px solid var(--ram-border)',
                                                        borderLeft: hasValue ? '3px solid var(--ram-teal)' : '3px solid transparent',
                                                    }}
                                                >
                                                    <span style={{
                                                        fontSize: '12px',
                                                        color: hasValue ? 'var(--ram-text-primary)' : 'var(--ram-text-tertiary)',
                                                    }}>
                                                        {field.properties?.displayName || field.id}
                                                    </span>
                                                    <span style={{
                                                        fontSize: '12px',
                                                        fontWeight: hasValue ? 600 : 400,
                                                        color: hasValue ? 'var(--ram-teal)' : 'var(--ram-text-tertiary)',
                                                        marginLeft: '12px',
                                                        textAlign: 'right',
                                                    }}>
                                                        {displayValue}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </SectionRow>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer: Cancel + Execute */}
                <div style={{
                    padding: '16px 24px 20px',
                    borderTop: '1px solid var(--ram-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: '12px',
                    flexShrink: 0,
                }}>
                    <button
                        onClick={onCancel}
                        style={{
                            padding: '8px 20px',
                            borderRadius: '8px',
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--ram-text-secondary)',
                            fontSize: '13px',
                            fontWeight: 600,
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '10px 24px',
                            borderRadius: '8px',
                            border: 'none',
                            background: 'linear-gradient(135deg, var(--ram-teal), #2aa878)',
                            color: '#fff',
                            fontSize: '14px',
                            fontWeight: 700,
                            cursor: 'pointer',
                            boxShadow: '0 2px 16px rgba(45,212,191,0.3)',
                            transition: 'all 0.15s',
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Execute Batch
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Reusable section row with icon + label + children */
function SectionRow({ icon, label, color, children }: {
    icon: React.ReactNode;
    label: string;
    color: string;
    children: React.ReactNode;
}) {
    return (
        <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: `${color}15`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
            }}>
                {icon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    color,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    margin: '0 0 4px',
                }}>
                    {label}
                </p>
                {children}
            </div>
        </div>
    );
}
