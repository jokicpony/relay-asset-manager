'use client';

import { useState, useRef, useEffect } from 'react';
import type { DriveLabel, DriveLabelField } from '@/lib/namer/types';

interface LabelSelectorProps {
    labels: DriveLabel[];
    selectedLabelIds: string[];
    onSelectedChange: (ids: string[]) => void;
    fieldValues: Record<string, Record<string, { value: string | string[]; type: string }>>;
    onFieldValuesChange: (values: Record<string, Record<string, { value: string | string[]; type: string }>>) => void;
}

export default function LabelSelector({
    labels,
    selectedLabelIds,
    onSelectedChange,
    fieldValues,
    onFieldValuesChange,
}: LabelSelectorProps) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    // Close panel on outside click
    useEffect(() => {
        if (!expanded) return;
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setExpanded(null);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [expanded]);

    const toggleLabel = (labelId: string) => {
        if (selectedLabelIds.includes(labelId)) {
            onSelectedChange(selectedLabelIds.filter(id => id !== labelId));
            if (expanded === labelId) setExpanded(null);
        } else {
            onSelectedChange([...selectedLabelIds, labelId]);
            setExpanded(labelId);
        }
    };

    const updateFieldValue = (labelId: string, fieldId: string, value: string | string[], type: string) => {
        const labelFields = { ...(fieldValues[labelId] || {}), [fieldId]: { value, type } };
        onFieldValuesChange({ ...fieldValues, [labelId]: labelFields });
    };

    // Determine field type and render appropriate input
    const getFieldType = (field: DriveLabelField): 'multi-select' | 'single-select' | 'date' | 'text' | 'integer' => {
        if (field.selectionOptions?.choices) {
            const maxEntries = field.selectionOptions.listOptions?.maxEntries;
            // Only multi-select when maxEntries is explicitly > 1
            if (maxEntries !== undefined && maxEntries > 1) return 'multi-select';
            return 'single-select';
        }
        if (field.dateOptions) return 'date';
        if (field.integerOptions) return 'integer';
        return 'text';
    };

    // Build structured summary data for a label's selected values
    const getFieldSummaryItems = (label: DriveLabel): Array<{ name: string; value: string }> => {
        if (!label.fields) return [];
        const items: Array<{ name: string; value: string }> = [];
        for (const field of label.fields) {
            const v = fieldValues[label.id]?.[field.id];
            if (!v || (!v.value || (Array.isArray(v.value) && v.value.length === 0))) continue;

            const name = field.properties?.displayName || field.id;
            let displayValue: string;

            if (Array.isArray(v.value)) {
                const names = v.value.map(choiceId => {
                    const choice = field.selectionOptions?.choices?.find(c => c.id === choiceId);
                    return choice?.properties?.displayName || choiceId;
                });
                displayValue = names.join(', ');
            } else if (field.selectionOptions?.choices) {
                const choice = field.selectionOptions.choices.find(c => c.id === v.value);
                displayValue = choice?.properties?.displayName || (v.value as string);
            } else {
                displayValue = v.value as string;
            }

            items.push({ name, value: displayValue });
        }
        return items;
    };

    const renderFieldInput = (label: DriveLabel, field: DriveLabelField) => {
        const fieldType = getFieldType(field);
        const currentValue = fieldValues[label.id]?.[field.id];

        switch (fieldType) {
            case 'multi-select': {
                const selectedIds = (currentValue?.value as string[] | undefined) || [];
                return (
                    <div style={{
                        border: '1px solid var(--ram-border)',
                        borderRadius: '6px',
                        padding: '6px 8px',
                        maxHeight: '140px',
                        overflowY: 'auto',
                    }}>
                        {field.selectionOptions!.choices.map(choice => {
                            const checked = selectedIds.includes(choice.id);
                            return (
                                <label
                                    key={choice.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        padding: '4px 4px',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                        color: 'var(--ram-text-primary)',
                                        borderRadius: '3px',
                                    }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => {
                                            const newIds = checked
                                                ? selectedIds.filter(id => id !== choice.id)
                                                : [...selectedIds, choice.id];
                                            updateFieldValue(label.id, field.id, newIds, 'selection');
                                        }}
                                        style={{ accentColor: 'var(--ram-teal)' }}
                                    />
                                    {choice.properties?.displayName || choice.id}
                                </label>
                            );
                        })}
                    </div>
                );
            }

            case 'single-select': {
                return (
                    <select
                        value={(currentValue?.value as string) || ''}
                        onChange={e => updateFieldValue(label.id, field.id, e.target.value, 'selection')}
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            border: '1px solid var(--ram-border)',
                            background: 'var(--ram-bg-secondary)',
                            color: 'var(--ram-text-primary)',
                            fontSize: '12px',
                            appearance: 'none' as const,
                        }}
                    >
                        <option value="">Select…</option>
                        {field.selectionOptions!.choices.map(c => (
                            <option key={c.id} value={c.id}>
                                {c.properties?.displayName || c.id}
                            </option>
                        ))}
                    </select>
                );
            }

            case 'date': {
                return (
                    <input
                        type="date"
                        value={(currentValue?.value as string) || ''}
                        onChange={e => updateFieldValue(label.id, field.id, e.target.value, 'date')}
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            border: '1px solid var(--ram-border)',
                            background: 'var(--ram-bg-secondary)',
                            color: 'var(--ram-text-primary)',
                            fontSize: '12px',
                        }}
                    />
                );
            }

            case 'integer': {
                return (
                    <input
                        type="number"
                        value={(currentValue?.value as string) || ''}
                        onChange={e => updateFieldValue(label.id, field.id, e.target.value, 'integer')}
                        placeholder="0"
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            border: '1px solid var(--ram-border)',
                            background: 'var(--ram-bg-secondary)',
                            color: 'var(--ram-text-primary)',
                            fontSize: '12px',
                        }}
                    />
                );
            }

            case 'text':
            default: {
                return (
                    <input
                        type="text"
                        value={(currentValue?.value as string) || ''}
                        onChange={e => updateFieldValue(label.id, field.id, e.target.value, 'text')}
                        placeholder={field.properties?.displayName || field.id}
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            border: '1px solid var(--ram-border)',
                            background: 'var(--ram-bg-secondary)',
                            color: 'var(--ram-text-primary)',
                            fontSize: '12px',
                        }}
                    />
                );
            }
        }
    };

    // Type label hint text
    const fieldTypeHint = (field: DriveLabelField): string | null => {
        const ft = getFieldType(field);
        if (ft === 'multi-select') return '(multi-select)';
        if (ft === 'date') return '(date)';
        return null;
    };

    if (labels.length === 0) {
        return (
            <span style={{ fontSize: '11px', color: 'var(--ram-text-tertiary)' }}>
                No Drive labels available
            </span>
        );
    }

    return (
        <div ref={panelRef} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ram-text-secondary)', paddingTop: '5px' }}>
                Labels:
            </span>

            {labels.map(label => {
                const isSelected = selectedLabelIds.includes(label.id);
                const isExpanded = expanded === label.id;
                const hasFields = label.fields && label.fields.length > 0;

                // Count how many fields have values set
                const fieldsWithValues = hasFields
                    ? label.fields!.filter(f => {
                        const v = fieldValues[label.id]?.[f.id]?.value;
                        return v && (Array.isArray(v) ? v.length > 0 : v !== '');
                    }).length
                    : 0;

                return (
                    <div key={label.id} style={{ position: 'relative' }}>
                        {/* Label pill */}
                        <button
                            onClick={() => {
                                if (isSelected && hasFields) {
                                    setExpanded(isExpanded ? null : label.id);
                                } else {
                                    toggleLabel(label.id);
                                }
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                padding: '4px 12px',
                                borderRadius: '16px',
                                border: `1px solid ${isSelected ? 'var(--ram-teal)' : 'var(--ram-border)'}`,
                                background: isSelected ? 'rgba(45, 212, 191, 0.12)' : 'var(--ram-bg-tertiary)',
                                color: isSelected ? 'var(--ram-teal)' : 'var(--ram-text-tertiary)',
                                fontSize: '11px',
                                fontWeight: 600,
                                cursor: 'pointer',
                                transition: 'all 0.15s',
                            }}
                        >
                            {isSelected && (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            )}
                            {label.properties?.title || label.id}
                            {fieldsWithValues > 0 && (
                                <span style={{
                                    background: 'var(--ram-teal)',
                                    color: '#0a0c10',
                                    borderRadius: '8px',
                                    padding: '0 5px',
                                    fontSize: '9px',
                                    fontWeight: 700,
                                    marginLeft: '2px',
                                }}>
                                    {fieldsWithValues}
                                </span>
                            )}
                            {isSelected && hasFields && (
                                <svg
                                    width="10" height="10" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" strokeWidth="2.5"
                                    style={{
                                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                        transition: 'transform 0.15s',
                                    }}
                                >
                                    <polyline points="6 9 12 15 18 9" />
                                </svg>
                            )}
                        </button>

                        {/* Collapsed summary — vertically stacked field: value pairs */}
                        {isSelected && !isExpanded && (() => {
                            const items = getFieldSummaryItems(label);
                            if (items.length === 0) return null;
                            return (
                                <div style={{
                                    marginTop: '6px',
                                    padding: '6px 10px',
                                    borderRadius: '6px',
                                    background: 'rgba(45, 212, 191, 0.06)',
                                    border: '1px solid rgba(45, 212, 191, 0.12)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '3px',
                                }}>
                                    {items.map((item, idx) => (
                                        <div key={idx} style={{
                                            display: 'flex',
                                            alignItems: 'baseline',
                                            gap: '6px',
                                            fontSize: '10px',
                                            lineHeight: 1.4,
                                        }}>
                                            <span style={{
                                                color: 'var(--ram-text-tertiary)',
                                                fontWeight: 500,
                                                flexShrink: 0,
                                                minWidth: '60px',
                                            }}>
                                                {item.name}:
                                            </span>
                                            <span style={{
                                                color: 'var(--ram-teal)',
                                                fontWeight: 600,
                                            }}>
                                                {item.value}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}

                        {/* Field editor panel */}
                        {isExpanded && hasFields && (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 'calc(100% + 6px)',
                                    minWidth: '320px',
                                    maxWidth: '420px',
                                    maxHeight: '400px',
                                    overflowY: 'auto',
                                    background: '#1e2028',
                                    border: '1px solid var(--ram-border)',
                                    borderRadius: '10px',
                                    boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                                    padding: '14px',
                                    zIndex: 100,
                                }}
                            >
                                {/* Panel header */}
                                <p style={{
                                    fontSize: '10px',
                                    fontWeight: 600,
                                    color: 'var(--ram-text-tertiary)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                    marginBottom: '12px',
                                }}>
                                    {label.properties?.title} Fields
                                </p>

                                {/* Fields grid — 2 columns when there are 4+ fields */}
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: label.fields!.length >= 4 ? '1fr 1fr' : '1fr',
                                    gap: '12px',
                                }}>
                                    {label.fields!
                                        .filter(field => {
                                            // Hide Orientation field — it's auto-applied during processing
                                            if (field.properties?.displayName?.toLowerCase() === 'orientation') return false;
                                            return true;
                                        })
                                        .map(field => {
                                        const hint = fieldTypeHint(field);
                                        return (
                                            <div key={field.id}>
                                                <div style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px',
                                                    marginBottom: '4px',
                                                }}>
                                                    <span style={{
                                                        fontSize: '12px',
                                                        fontWeight: 600,
                                                        color: 'var(--ram-text-primary)',
                                                    }}>
                                                        {field.properties?.displayName || field.id}
                                                    </span>
                                                    {hint && (
                                                        <span style={{
                                                            fontSize: '9px',
                                                            color: 'var(--ram-text-tertiary)',
                                                            fontStyle: 'italic',
                                                        }}>
                                                            {hint}
                                                        </span>
                                                    )}
                                                </div>
                                                {renderFieldInput(label, field)}
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Done + Clear All buttons */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
                                    <button
                                        onClick={() => setExpanded(null)}
                                        style={{
                                            padding: '4px 14px',
                                            borderRadius: '6px',
                                            border: 'none',
                                            background: 'rgba(45, 212, 191, 0.15)',
                                            color: 'var(--ram-teal)',
                                            fontSize: '11px',
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Done
                                    </button>
                                    {fieldsWithValues > 0 && (
                                        <button
                                            onClick={() => {
                                                // Clear all field values for this label
                                                const updated = { ...fieldValues };
                                                delete updated[label.id];
                                                onFieldValuesChange(updated);
                                            }}
                                            style={{
                                                padding: '4px 14px',
                                                borderRadius: '6px',
                                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                                background: 'rgba(239, 68, 68, 0.1)',
                                                color: '#ef4444',
                                                fontSize: '11px',
                                                fontWeight: 600,
                                                cursor: 'pointer',
                                            }}
                                        >
                                            Clear All
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
