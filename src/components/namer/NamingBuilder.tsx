'use client';

import type { SchemaField, Dropdowns } from '@/lib/namer/types';
import NamerSelect from './NamerSelect';

interface NamingBuilderProps {
    fields: SchemaField[];
    onChange: (fields: SchemaField[]) => void;
    dropdowns: Dropdowns;
    counter: number;
    onCounterChange: (val: number) => void;
}

export default function NamingBuilder({ fields, onChange, dropdowns, counter, onCounterChange }: NamingBuilderProps) {
    const updateField = (index: number, value: string) => {
        const updated = fields.map((f, i) => i === index ? { ...f, value } : f);
        onChange(updated);
    };

    // Build preview segments for color-coded display
    const previewSegments: Array<{ text: string; filled: boolean }> = [];
    for (const field of fields) {
        if (field.type === 'counter') {
            previewSegments.push({ text: String(counter).padStart(3, '0'), filled: true });
        } else if (field.value) {
            previewSegments.push({ text: field.value, filled: true });
        } else {
            previewSegments.push({ text: `[${field.label}]`, filled: false });
        }
    }

    return (
        <div>
            {/* Field cards grid */}
            <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '10px',
                marginBottom: '20px',
            }}>
                {fields.map((field, i) => {
                    const isRequired = field.required !== false;
                    const isOptional = field.required === false;
                    const borderAccent = isRequired ? 'var(--ram-accent)' : 'var(--ram-teal)';

                    return (
                        <div
                            key={field.id}
                            style={{
                                position: 'relative',
                                minWidth: '140px',
                                maxWidth: '200px',
                                flex: '1 1 140px',
                                padding: '12px 12px 10px',
                                borderRadius: '8px',
                                border: `1px solid ${borderAccent}40`,
                                borderLeft: `3px solid ${borderAccent}`,
                                background: 'rgba(255,255,255,0.03)',
                                display: 'flex',
                                flexDirection: 'column',
                            }}
                        >
                            {/* Numbered badge */}
                            <div style={{
                                position: 'absolute',
                                top: '-8px',
                                left: '-8px',
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                background: borderAccent,
                                color: 'var(--ram-bg-primary)',
                                fontSize: '10px',
                                fontWeight: 700,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}>
                                {i + 1}
                            </div>

                            {/* Label + REQ/OPT badge */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginBottom: '6px',
                            }}>
                                <span style={{
                                    fontSize: '11px',
                                    fontWeight: 600,
                                    color: 'var(--ram-text-primary)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                }}>
                                    {field.label}
                                </span>
                                <span style={{
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    padding: '1px 5px',
                                    borderRadius: '3px',
                                    background: isRequired ? 'rgba(232, 160, 72, 0.15)' : 'rgba(45, 212, 191, 0.15)',
                                    color: isRequired ? 'var(--ram-accent)' : 'var(--ram-teal)',
                                    textTransform: 'uppercase',
                                }}>
                                    {isOptional ? 'OPT' : 'REQ'}
                                </span>
                            </div>

                            {/* Field input — pushed to bottom for alignment */}
                            <div style={{ marginTop: 'auto' }}>
                            {field.type === 'counter' ? (
                                <input
                                    type="number"
                                    min={1}
                                    value={counter}
                                    onChange={e => onCounterChange(parseInt(e.target.value) || 1)}
                                    style={{
                                        width: '100%',
                                        padding: '5px 8px',
                                        borderRadius: '5px',
                                        border: '1px solid var(--ram-border)',
                                        background: 'var(--ram-bg-primary)',
                                        color: 'var(--ram-text-primary)',
                                        fontSize: '12px',
                                    }}
                                />
                            ) : field.type === 'select' && field.source && dropdowns[field.source] ? (
                                <NamerSelect
                                    options={dropdowns[field.source]}
                                    value={field.value}
                                    onChange={val => updateField(i, val)}
                                    placeholder={isRequired ? 'Required…' : 'Optional…'}
                                    disabled={field.frozen}
                                    variant={isRequired ? 'required' : 'optional'}
                                />
                            ) : field.type === 'date' ? (
                                <input
                                    type="text"
                                    value={field.value}
                                    onChange={e => updateField(i, e.target.value)}
                                    disabled={field.frozen}
                                    placeholder="YYYYMMDD"
                                    style={{
                                        width: '100%',
                                        padding: '5px 8px',
                                        borderRadius: '5px',
                                        border: '1px solid var(--ram-border)',
                                        background: 'var(--ram-bg-primary)',
                                        color: 'var(--ram-text-primary)',
                                        fontSize: '12px',
                                        opacity: field.frozen ? 0.5 : 1,
                                    }}
                                />
                            ) : (
                                <input
                                    type="text"
                                    value={field.value}
                                    onChange={e => updateField(i, e.target.value)}
                                    disabled={field.frozen}
                                    placeholder={isRequired ? 'Required…' : 'Optional…'}
                                    style={{
                                        width: '100%',
                                        padding: '5px 8px',
                                        borderRadius: '5px',
                                        border: '1px solid var(--ram-border)',
                                        background: 'var(--ram-bg-primary)',
                                        color: 'var(--ram-text-primary)',
                                        fontSize: '12px',
                                        opacity: field.frozen ? 0.5 : 1,
                                    }}
                                />
                            )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Color-coded name preview */}
            {fields.length > 0 && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(232,160,72,0.25)',
                }}>
                    <span style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        color: 'var(--ram-text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        flexShrink: 0,
                    }}>
                        Preview:
                    </span>
                    <span style={{ fontFamily: 'monospace', fontSize: '13px', lineHeight: 1.4 }}>
                        {previewSegments.map((seg, i) => (
                            <span key={i}>
                                {i > 0 && (
                                    <span style={{ color: 'var(--ram-text-tertiary)', margin: '0 1px' }}>_</span>
                                )}
                                <span style={{
                                    color: seg.filled ? 'var(--ram-accent)' : 'var(--ram-text-tertiary)',
                                    fontWeight: seg.filled ? 600 : 400,
                                }}>
                                    {seg.text}
                                </span>
                            </span>
                        ))}
                    </span>
                </div>
            )}
        </div>
    );
}
