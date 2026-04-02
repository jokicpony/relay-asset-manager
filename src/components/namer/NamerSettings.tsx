'use client';

import { useState, useRef, useCallback } from 'react';
import type { NamerSettings, NamingSchemas, Dropdowns, AISettings, SchemaField } from '@/lib/namer/types';

interface NamerSettingsProps {
    settings: NamerSettings;
    onSave: (updates: Partial<NamerSettings>) => Promise<void>;
    onClose: () => void;
}

// ─── Styled toggle switch ──────────────────────────────────────
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
    return (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <div
                onClick={() => onChange(!checked)}
                style={{
                    width: '34px',
                    height: '19px',
                    borderRadius: '10px',
                    background: checked ? 'var(--ram-teal)' : 'rgba(255,255,255,0.08)',
                    border: `1px solid ${checked ? 'var(--ram-teal)' : 'rgba(255,255,255,0.15)'}`,
                    boxShadow: checked ? '0 0 8px rgba(45, 212, 191, 0.4)' : 'inset 0 1px 3px rgba(0,0,0,0.3)',
                    position: 'relative',
                    transition: 'all 0.2s ease',
                    cursor: 'pointer',
                }}
            >
                <div style={{
                    width: '15px',
                    height: '15px',
                    borderRadius: '50%',
                    background: checked ? '#fff' : 'rgba(255,255,255,0.35)',
                    position: 'absolute',
                    top: '1px',
                    left: checked ? '16px' : '1px',
                    transition: 'all 0.2s ease',
                    boxShadow: checked ? '0 1px 4px rgba(0,0,0,0.3)' : 'none',
                }} />
            </div>
            {label && (
                <span style={{
                    fontSize: '11px',
                    color: checked ? 'var(--ram-teal)' : 'var(--ram-text-tertiary)',
                    fontWeight: checked ? 600 : 500,
                    transition: 'all 0.2s ease',
                }}>
                    {label}
                </span>
            )}
        </label>
    );
}

// ─── Field type badge ──────────────────────────────────────────
function TypeBadge({ type }: { type: string }) {
    const colors: Record<string, { bg: string; text: string }> = {
        text: { bg: 'rgba(96, 165, 250, 0.15)', text: '#60a5fa' },
        select: { bg: 'rgba(167, 139, 250, 0.15)', text: '#a78bfa' },
        date: { bg: 'rgba(251, 191, 36, 0.15)', text: '#fbbf24' },
        counter: { bg: 'rgba(52, 211, 153, 0.15)', text: '#34d399' },
    };
    const c = colors[type] || colors.text;
    return (
        <span style={{
            fontSize: '9px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            padding: '2px 6px',
            borderRadius: '4px',
            background: c.bg,
            color: c.text,
        }}>
            {type}
        </span>
    );
}

export default function NamerSettingsPanel({ settings, onSave, onClose }: NamerSettingsProps) {
    const [activeTab, setActiveTab] = useState<'schemas' | 'dropdowns' | 'ai'>('schemas');
    const [saving, setSaving] = useState(false);

    // ─── Schemas ──────────────────────────────────────────────
    const [schemasState, setSchemasState] = useState<NamingSchemas>(() => {
        // Deep clone so edits don't mutate original
        return JSON.parse(JSON.stringify(settings.schemas));
    });
    // Alias for cleaner code
    const schemas = schemasState;
    const setSchemas = setSchemasState;

    const [newSchemaName, setNewSchemaName] = useState('');
    const [expandedSchema, setExpandedSchema] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

    // Drag state for field reordering
    const dragFieldRef = useRef<{ schemaName: string; index: number } | null>(null);

    const addSchema = () => {
        const name = newSchemaName.trim().toLowerCase().replace(/\s+/g, '_');
        if (!name || schemas[name]) return;
        setSchemas({
            ...schemas,
            [name]: {
                aiEnabled: true,
                fields: [
                    { id: 'date', type: 'date', label: 'Date', value: '', required: true, frozen: true },
                    { id: 'index', type: 'counter', label: 'Index', value: '001', required: true, frozen: true },
                ],
            },
        });
        setNewSchemaName('');
        setExpandedSchema(name);
    };

    const removeSchema = (name: string) => {
        const { [name]: _, ...rest } = schemas;
        setSchemas(rest);
        if (expandedSchema === name) setExpandedSchema(null);
        setDeleteConfirm(null);
    };

    const renameSchema = (oldName: string, newName: string) => {
        const clean = newName.trim().toLowerCase().replace(/\s+/g, '_');
        if (!clean || clean === oldName || schemas[clean]) {
            setEditingName(null);
            return;
        }
        const entries = Object.entries(schemas).map(([k, v]) =>
            k === oldName ? [clean, v] : [k, v]
        );
        setSchemas(Object.fromEntries(entries));
        if (expandedSchema === oldName) setExpandedSchema(clean);
        setEditingName(null);
    };

    const updateField = (schemaName: string, fieldIndex: number, updates: Partial<SchemaField>) => {
        const schema = schemas[schemaName];
        if (!schema) return;
        const newFields = schema.fields.map((f, i) =>
            i === fieldIndex ? { ...f, ...updates } : f
        );
        setSchemas({ ...schemas, [schemaName]: { ...schema, fields: newFields } });
    };

    const addField = (schemaName: string) => {
        const schema = schemas[schemaName];
        if (!schema) return;
        const newField: SchemaField = {
            id: `field_${Date.now()}`,
            type: 'text',
            label: 'New Field',
            value: '',
            required: false,
        };
        // Insert before the last field if it's a counter (Index is always last)
        const lastField = schema.fields[schema.fields.length - 1];
        const newFields = lastField?.type === 'counter'
            ? [...schema.fields.slice(0, -1), newField, lastField]
            : [...schema.fields, newField];
        setSchemas({ ...schemas, [schemaName]: { ...schema, fields: newFields } });
    };

    const removeField = (schemaName: string, fieldIndex: number) => {
        const schema = schemas[schemaName];
        if (!schema) return;
        setSchemas({
            ...schemas,
            [schemaName]: { ...schema, fields: schema.fields.filter((_, i) => i !== fieldIndex) },
        });
    };

    // HTML5 DnD handlers for field reordering
    const handleFieldDragStart = (schemaName: string, index: number) => {
        dragFieldRef.current = { schemaName, index };
    };

    const handleFieldDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }, []);

    const handleFieldDrop = (schemaName: string, targetIndex: number) => {
        const src = dragFieldRef.current;
        if (!src || src.schemaName !== schemaName || src.index === targetIndex) return;
        const schema = schemas[schemaName];
        const newFields = [...schema.fields];
        const [moved] = newFields.splice(src.index, 1);
        newFields.splice(targetIndex, 0, moved);
        setSchemas({ ...schemas, [schemaName]: { ...schema, fields: newFields } });
        dragFieldRef.current = null;
    };

    // ─── Dropdowns ────────────────────────────────────────────
    const [dropdowns, setDropdowns] = useState<Dropdowns>(() => JSON.parse(JSON.stringify(settings.dropdowns)));
    const [newCategoryName, setNewCategoryName] = useState('');
    const [newItemValues, setNewItemValues] = useState<Record<string, string>>({});

    const addCategory = () => {
        const name = newCategoryName.trim().toLowerCase().replace(/\s+/g, '_');
        if (!name || dropdowns[name]) return;
        setDropdowns({ ...dropdowns, [name]: [] });
        setNewCategoryName('');
    };

    const removeCategory = (category: string) => {
        const { [category]: _, ...rest } = dropdowns;
        setDropdowns(rest);
    };

    const addItem = (category: string) => {
        const item = newItemValues[category]?.trim();
        if (!item || dropdowns[category]?.includes(item)) return;
        setDropdowns({
            ...dropdowns,
            [category]: [...(dropdowns[category] || []), item],
        });
        setNewItemValues({ ...newItemValues, [category]: '' });
    };

    const removeItem = (category: string, item: string) => {
        setDropdowns({
            ...dropdowns,
            [category]: dropdowns[category].filter(i => i !== item),
        });
    };

    // ─── AI Settings ──────────────────────────────────────────
    const [aiSettings, setAISettings] = useState<AISettings>(() => JSON.parse(JSON.stringify(settings.aiSettings)));
    const [promptsUnlocked, setPromptsUnlocked] = useState(false);

    // ─── Save ─────────────────────────────────────────────────
    const handleSave = async () => {
        setSaving(true);
        try {
            await onSave({
                schemas,
                dropdowns,
                aiSettings,
            });
        } finally {
            setSaving(false);
        }
    };

    const displayName = (s: string) => s
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

    const dropdownCategories = Object.keys(dropdowns);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div
                className="w-full max-w-3xl max-h-[85vh] rounded-2xl flex flex-col overflow-hidden shadow-2xl"
                style={{
                    background: 'var(--ram-bg-elevated)',
                    border: '1px solid var(--ram-border)',
                }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--ram-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '18px' }}>⚙️</span>
                        <h2 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--ram-text-primary)', margin: 0 }}>
                            Namer Settings
                        </h2>
                    </div>
                    <button onClick={onClose} style={{ color: 'var(--ram-text-tertiary)', background: 'none', border: 'none', cursor: 'pointer' }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 px-6 pt-3" style={{ borderBottom: '1px solid var(--ram-border)' }}>
                    {(['schemas', 'dropdowns', 'ai'] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className="text-xs px-4 py-2 rounded-t-lg transition-colors font-medium"
                            style={{
                                background: activeTab === tab ? 'var(--ram-bg-secondary)' : 'transparent',
                                color: activeTab === tab ? 'var(--ram-accent)' : 'var(--ram-text-tertiary)',
                                borderBottom: activeTab === tab ? '2px solid var(--ram-accent)' : '2px solid transparent',
                                borderTop: 'none',
                                borderLeft: 'none',
                                borderRight: 'none',
                                cursor: 'pointer',
                            }}
                        >
                            {tab === 'schemas' ? '📋 Naming Schemas' : tab === 'dropdowns' ? '📁 Dropdown Options' : '🤖 AI Prompts'}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6">
                    {/* ═══ SCHEMAS TAB ═══ */}
                    {activeTab === 'schemas' && (
                        <div>
                            {/* Add new schema */}
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                                <input
                                    value={newSchemaName}
                                    onChange={e => setNewSchemaName(e.target.value)}
                                    placeholder="New schema name…"
                                    style={{
                                        flex: 1,
                                        fontSize: '12px',
                                        padding: '6px 12px',
                                        borderRadius: '8px',
                                        background: 'var(--ram-bg-secondary)',
                                        color: 'var(--ram-text-primary)',
                                        border: '1px solid var(--ram-border)',
                                    }}
                                    onKeyDown={e => e.key === 'Enter' && addSchema()}
                                />
                                <button
                                    onClick={addSchema}
                                    style={{
                                        fontSize: '12px',
                                        padding: '6px 14px',
                                        borderRadius: '8px',
                                        background: 'var(--ram-accent-muted)',
                                        color: 'var(--ram-accent)',
                                        border: 'none',
                                        cursor: 'pointer',
                                        fontWeight: 600,
                                    }}
                                >
                                    + Add Schema
                                </button>
                            </div>

                            {/* Schema list */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {Object.entries(schemas).map(([name, schema]) => {
                                    const isExpanded = expandedSchema === name;
                                    return (
                                        <div
                                            key={name}
                                            style={{
                                                borderRadius: '10px',
                                                background: 'var(--ram-bg-secondary)',
                                                border: `1px solid ${isExpanded ? 'var(--ram-accent)' : 'var(--ram-border)'}`,
                                                transition: 'border-color 0.2s',
                                            }}
                                        >
                                            {/* Schema header */}
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    padding: '10px 14px',
                                                    cursor: 'pointer',
                                                    gap: '10px',
                                                }}
                                                onClick={() => setExpandedSchema(isExpanded ? null : name)}
                                            >
                                                {/* Expand chevron */}
                                                <svg
                                                    width="12" height="12" viewBox="0 0 24 24" fill="none"
                                                    stroke="var(--ram-text-tertiary)" strokeWidth="2"
                                                    style={{
                                                        transition: 'transform 0.2s',
                                                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    <polyline points="9 18 15 12 9 6" />
                                                </svg>

                                                {/* Schema name — editable */}
                                                {editingName === name ? (
                                                    <input
                                                        autoFocus
                                                        defaultValue={displayName(name)}
                                                        onClick={e => e.stopPropagation()}
                                                        onBlur={e => renameSchema(name, e.target.value)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') renameSchema(name, (e.target as HTMLInputElement).value);
                                                            if (e.key === 'Escape') setEditingName(null);
                                                        }}
                                                        style={{
                                                            fontSize: '13px',
                                                            fontWeight: 600,
                                                            color: 'var(--ram-text-primary)',
                                                            background: 'var(--ram-bg-primary)',
                                                            border: '1px solid var(--ram-accent)',
                                                            borderRadius: '4px',
                                                            padding: '2px 6px',
                                                            outline: 'none',
                                                            flex: 1,
                                                        }}
                                                    />
                                                ) : (
                                                    <span
                                                        style={{
                                                            fontSize: '13px',
                                                            fontWeight: 600,
                                                            color: 'var(--ram-text-primary)',
                                                            flex: 1,
                                                        }}
                                                        onDoubleClick={e => { e.stopPropagation(); setEditingName(name); }}
                                                    >
                                                        {displayName(name)}
                                                        <span style={{
                                                            fontSize: '10px',
                                                            fontWeight: 400,
                                                            color: 'var(--ram-text-tertiary)',
                                                            marginLeft: '8px',
                                                        }}>
                                                            {schema.fields.length} fields
                                                        </span>
                                                    </span>
                                                )}

                                                {/* Right-side controls */}
                                                <div
                                                    style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    <Toggle
                                                        checked={schema.aiEnabled}
                                                        onChange={checked => setSchemas({ ...schemas, [name]: { ...schema, aiEnabled: checked } })}
                                                        label="AI"
                                                    />

                                                    {/* Rename button */}
                                                    <button
                                                        onClick={() => setEditingName(name)}
                                                        title="Rename"
                                                        style={{
                                                            background: 'none',
                                                            border: 'none',
                                                            cursor: 'pointer',
                                                            color: 'var(--ram-text-tertiary)',
                                                            padding: '2px',
                                                        }}
                                                    >
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                                                        </svg>
                                                    </button>

                                                    {/* Delete button */}
                                                    {deleteConfirm === name ? (
                                                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                                            <button
                                                                onClick={() => removeSchema(name)}
                                                                style={{
                                                                    fontSize: '10px',
                                                                    padding: '2px 8px',
                                                                    borderRadius: '4px',
                                                                    background: 'rgba(248, 113, 113, 0.2)',
                                                                    color: '#f87171',
                                                                    border: 'none',
                                                                    cursor: 'pointer',
                                                                    fontWeight: 600,
                                                                }}
                                                            >
                                                                Confirm
                                                            </button>
                                                            <button
                                                                onClick={() => setDeleteConfirm(null)}
                                                                style={{
                                                                    fontSize: '10px',
                                                                    padding: '2px 6px',
                                                                    borderRadius: '4px',
                                                                    background: 'var(--ram-bg-tertiary)',
                                                                    color: 'var(--ram-text-tertiary)',
                                                                    border: 'none',
                                                                    cursor: 'pointer',
                                                                }}
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => setDeleteConfirm(name)}
                                                            style={{
                                                                background: 'none',
                                                                border: 'none',
                                                                cursor: 'pointer',
                                                                color: 'var(--ram-text-tertiary)',
                                                                padding: '2px',
                                                            }}
                                                            title="Delete schema"
                                                        >
                                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                <polyline points="3 6 5 6 21 6" />
                                                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                            </svg>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Expanded field editor */}
                                            {isExpanded && (
                                                <div style={{
                                                    padding: '0 14px 14px',
                                                    borderTop: '1px solid var(--ram-border)',
                                                }}>
                                                    {/* Field header */}
                                                    <div style={{
                                                        display: 'grid',
                                                        gridTemplateColumns: '24px 1fr 90px 60px 130px 28px',
                                                        gap: '8px',
                                                        alignItems: 'center',
                                                        padding: '8px 0 4px',
                                                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                                                    }}>
                                                        <span />
                                                        <span style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ram-text-tertiary)', letterSpacing: '0.5px' }}>Label</span>
                                                        <span style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ram-text-tertiary)', letterSpacing: '0.5px' }}>Type</span>
                                                        <span style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ram-text-tertiary)', letterSpacing: '0.5px' }}>Required</span>
                                                        <span style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ram-text-tertiary)', letterSpacing: '0.5px' }}>Source</span>
                                                        <span />
                                                    </div>

                                                    {/* Field rows */}
                                                    {schema.fields.map((field, idx) => (
                                                        <div
                                                            key={field.id}
                                                            draggable
                                                            onDragStart={() => handleFieldDragStart(name, idx)}
                                                            onDragOver={handleFieldDragOver}
                                                            onDrop={() => handleFieldDrop(name, idx)}
                                                            style={{
                                                                display: 'grid',
                                                                gridTemplateColumns: '24px 1fr 90px 60px 130px 28px',
                                                                gap: '8px',
                                                                alignItems: 'center',
                                                                padding: '6px 0',
                                                                borderBottom: '1px solid rgba(255,255,255,0.03)',
                                                                opacity: field.frozen ? 0.6 : 1,
                                                            }}
                                                        >
                                                            {/* Drag handle */}
                                                            <span style={{
                                                                cursor: 'grab',
                                                                color: 'var(--ram-text-tertiary)',
                                                                fontSize: '14px',
                                                                textAlign: 'center',
                                                                userSelect: 'none',
                                                            }}>
                                                                ⠿
                                                            </span>

                                                            {/* Label */}
                                                            <input
                                                                value={field.label}
                                                                onChange={e => updateField(name, idx, { label: e.target.value })}
                                                                disabled={field.frozen}
                                                                style={{
                                                                    fontSize: '12px',
                                                                    padding: '4px 8px',
                                                                    borderRadius: '4px',
                                                                    background: 'var(--ram-bg-primary)',
                                                                    color: 'var(--ram-text-primary)',
                                                                    border: '1px solid var(--ram-border)',
                                                                    opacity: field.frozen ? 0.7 : 1,
                                                                }}
                                                            />

                                                            {/* Type selector */}
                                                            <select
                                                                value={field.type}
                                                                onChange={e => {
                                                                    const newType = e.target.value as SchemaField['type'];
                                                                    const updates: Partial<SchemaField> = { type: newType };
                                                                    // Clear source if switching away from select
                                                                    if (newType !== 'select') updates.source = undefined;
                                                                    updateField(name, idx, updates);
                                                                }}
                                                                disabled={field.frozen}
                                                                style={{
                                                                    fontSize: '11px',
                                                                    padding: '4px 4px',
                                                                    borderRadius: '4px',
                                                                    background: 'var(--ram-bg-primary)',
                                                                    color: 'var(--ram-text-primary)',
                                                                    border: '1px solid var(--ram-border)',
                                                                    cursor: field.frozen ? 'default' : 'pointer',
                                                                }}
                                                            >
                                                                <option value="text">Text</option>
                                                                <option value="select">Dropdown</option>
                                                                <option value="date">Date</option>
                                                                <option value="counter">Counter</option>
                                                            </select>

                                                            {/* Required toggle */}
                                                            <div style={{ display: 'flex', justifyContent: 'center' }}>
                                                                <Toggle
                                                                    checked={field.required}
                                                                    onChange={checked => updateField(name, idx, { required: checked })}
                                                                />
                                                            </div>

                                                            {/* Source dropdown (only for select type) */}
                                                            {field.type === 'select' ? (
                                                                <select
                                                                    value={field.source || ''}
                                                                    onChange={e => updateField(name, idx, { source: e.target.value || undefined })}
                                                                    style={{
                                                                        fontSize: '11px',
                                                                        padding: '4px 4px',
                                                                        borderRadius: '4px',
                                                                        background: 'var(--ram-bg-primary)',
                                                                        color: 'var(--ram-text-primary)',
                                                                        border: '1px solid var(--ram-border)',
                                                                    }}
                                                                >
                                                                    <option value="">— pick source —</option>
                                                                    {dropdownCategories.map(cat => (
                                                                        <option key={cat} value={cat}>{displayName(cat)}</option>
                                                                    ))}
                                                                </select>
                                                            ) : (
                                                                <span style={{ fontSize: '10px', color: 'var(--ram-text-tertiary)' }}>—</span>
                                                            )}

                                                            {/* Delete field */}
                                                            {!field.frozen ? (
                                                                <button
                                                                    onClick={() => removeField(name, idx)}
                                                                    style={{
                                                                        background: 'none',
                                                                        border: 'none',
                                                                        cursor: 'pointer',
                                                                        color: 'var(--ram-text-tertiary)',
                                                                        padding: '2px',
                                                                        fontSize: '14px',
                                                                    }}
                                                                    title="Remove field"
                                                                >
                                                                    ×
                                                                </button>
                                                            ) : (
                                                                <span style={{ fontSize: '9px', color: 'var(--ram-text-tertiary)', textAlign: 'center' }} title="Locked field">🔒</span>
                                                            )}
                                                        </div>
                                                    ))}

                                                    {/* Add field button */}
                                                    <button
                                                        onClick={() => addField(name)}
                                                        style={{
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '6px',
                                                            marginTop: '8px',
                                                            padding: '6px 12px',
                                                            borderRadius: '6px',
                                                            fontSize: '11px',
                                                            fontWeight: 600,
                                                            color: 'var(--ram-teal)',
                                                            background: 'rgba(45, 212, 191, 0.08)',
                                                            border: '1px dashed rgba(45, 212, 191, 0.3)',
                                                            cursor: 'pointer',
                                                            width: '100%',
                                                            justifyContent: 'center',
                                                        }}
                                                    >
                                                        + Add Field
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            <p style={{
                                fontSize: '11px',
                                color: 'var(--ram-text-tertiary)',
                                marginTop: '12px',
                                lineHeight: 1.4,
                            }}>
                                AI image analysis works best with photos. Video support is limited and may produce less accurate results. This is an area of active development.
                            </p>
                        </div>
                    )}

                    {/* ═══ DROPDOWNS TAB ═══ */}
                    {activeTab === 'dropdowns' && (
                        <div>
                            {/* Add new category */}
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                                <input
                                    value={newCategoryName}
                                    onChange={e => setNewCategoryName(e.target.value)}
                                    placeholder="New dropdown category…"
                                    style={{
                                        flex: 1,
                                        fontSize: '12px',
                                        padding: '6px 12px',
                                        borderRadius: '8px',
                                        background: 'var(--ram-bg-secondary)',
                                        color: 'var(--ram-text-primary)',
                                        border: '1px solid var(--ram-border)',
                                    }}
                                    onKeyDown={e => e.key === 'Enter' && addCategory()}
                                />
                                <button
                                    onClick={addCategory}
                                    style={{
                                        fontSize: '12px',
                                        padding: '6px 14px',
                                        borderRadius: '8px',
                                        background: 'var(--ram-accent-muted)',
                                        color: 'var(--ram-accent)',
                                        border: 'none',
                                        cursor: 'pointer',
                                        fontWeight: 600,
                                    }}
                                >
                                    + Add Category
                                </button>
                            </div>

                            {/* Category list */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {Object.entries(dropdowns).map(([category, items]) => (
                                    <div key={category} style={{
                                        borderRadius: '10px',
                                        padding: '12px 14px',
                                        background: 'var(--ram-bg-secondary)',
                                        border: '1px solid var(--ram-border)',
                                    }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ram-text-primary)' }}>
                                                {displayName(category)}
                                                <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--ram-text-tertiary)', marginLeft: '6px' }}>
                                                    ({items.length} items)
                                                </span>
                                            </span>
                                            <button
                                                onClick={() => removeCategory(category)}
                                                style={{
                                                    background: 'none',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    color: 'var(--ram-text-tertiary)',
                                                    fontSize: '14px',
                                                }}
                                                title="Delete category"
                                            >
                                                ×
                                            </button>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                                            {items.map(item => (
                                                <span key={item} style={{
                                                    fontSize: '11px',
                                                    padding: '3px 8px',
                                                    borderRadius: '12px',
                                                    background: 'var(--ram-bg-tertiary)',
                                                    color: 'var(--ram-text-secondary)',
                                                    border: '1px solid var(--ram-border)',
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    gap: '4px',
                                                }}>
                                                    {item}
                                                    <button
                                                        onClick={() => removeItem(category, item)}
                                                        style={{
                                                            background: 'none',
                                                            border: 'none',
                                                            cursor: 'pointer',
                                                            color: 'var(--ram-text-tertiary)',
                                                            fontSize: '12px',
                                                            padding: 0,
                                                            lineHeight: 1,
                                                        }}
                                                    >
                                                        ×
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                            <input
                                                value={newItemValues[category] || ''}
                                                onChange={e => setNewItemValues({ ...newItemValues, [category]: e.target.value })}
                                                placeholder="Add item…"
                                                style={{
                                                    flex: 1,
                                                    fontSize: '11px',
                                                    padding: '4px 8px',
                                                    borderRadius: '6px',
                                                    background: 'var(--ram-bg-primary)',
                                                    color: 'var(--ram-text-primary)',
                                                    border: '1px solid var(--ram-border)',
                                                }}
                                                onKeyDown={e => e.key === 'Enter' && addItem(category)}
                                            />
                                            <button
                                                onClick={() => addItem(category)}
                                                style={{
                                                    fontSize: '11px',
                                                    padding: '4px 10px',
                                                    borderRadius: '6px',
                                                    background: 'var(--ram-accent-muted)',
                                                    color: 'var(--ram-accent)',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    fontWeight: 600,
                                                }}
                                            >
                                                +
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ═══ AI TAB ═══ */}
                    {activeTab === 'ai' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {/* Edit lock warning */}
                            {promptsUnlocked && (
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: '8px',
                                    padding: '10px 14px',
                                    borderRadius: '8px',
                                    background: 'rgba(251, 191, 36, 0.08)',
                                    border: '1px solid rgba(251, 191, 36, 0.25)',
                                }}>
                                    <span style={{ flexShrink: 0 }}>⚠️</span>
                                    <span style={{ fontSize: '11px', color: '#fbbf24', lineHeight: 1.5 }}>
                                        These prompts are coupled to semantic search. If you edit them, you must also update the code that applies vector embedding text in file descriptions.
                                    </span>
                                </div>
                            )}

                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ram-text-secondary)' }}>
                                        🧠 System Prompt
                                    </label>
                                    <button
                                        onClick={() => setPromptsUnlocked(!promptsUnlocked)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '5px',
                                            padding: '3px 10px',
                                            borderRadius: '12px',
                                            border: `1px solid ${promptsUnlocked ? 'rgba(251, 191, 36, 0.4)' : 'var(--ram-border)'}`,
                                            background: promptsUnlocked ? 'rgba(251, 191, 36, 0.08)' : 'var(--ram-bg-tertiary)',
                                            color: promptsUnlocked ? '#fbbf24' : 'var(--ram-text-tertiary)',
                                            fontSize: '10px',
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                            transition: 'all 0.15s',
                                        }}
                                    >
                                        {promptsUnlocked ? '🔓 Editing' : '🔒 Locked'}
                                    </button>
                                </div>
                                <textarea
                                    value={aiSettings.systemPrompt}
                                    onChange={e => setAISettings({ ...aiSettings, systemPrompt: e.target.value })}
                                    readOnly={!promptsUnlocked}
                                    rows={4}
                                    style={{
                                        width: '100%',
                                        fontSize: '12px',
                                        padding: '8px 12px',
                                        borderRadius: '8px',
                                        background: 'var(--ram-bg-secondary)',
                                        color: 'var(--ram-text-primary)',
                                        border: `1px solid ${promptsUnlocked ? 'rgba(251, 191, 36, 0.3)' : 'var(--ram-border)'}`,
                                        resize: 'vertical',
                                        fontFamily: 'monospace',
                                        opacity: promptsUnlocked ? 1 : 0.6,
                                        cursor: promptsUnlocked ? 'text' : 'default',
                                        transition: 'opacity 0.15s, border-color 0.15s',
                                    }}
                                />
                            </div>
                            <div>
                                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ram-text-secondary)' }}>
                                    💬 User Prompt
                                </label>
                                <textarea
                                    value={aiSettings.userPrompt}
                                    onChange={e => setAISettings({ ...aiSettings, userPrompt: e.target.value })}
                                    readOnly={!promptsUnlocked}
                                    rows={10}
                                    style={{
                                        width: '100%',
                                        fontSize: '12px',
                                        padding: '8px 12px',
                                        borderRadius: '8px',
                                        background: 'var(--ram-bg-secondary)',
                                        color: 'var(--ram-text-primary)',
                                        border: `1px solid ${promptsUnlocked ? 'rgba(251, 191, 36, 0.3)' : 'var(--ram-border)'}`,
                                        resize: 'vertical',
                                        fontFamily: 'monospace',
                                        opacity: promptsUnlocked ? 1 : 0.6,
                                        cursor: promptsUnlocked ? 'text' : 'default',
                                        transition: 'opacity 0.15s, border-color 0.15s',
                                    }}
                                />
                                <p style={{
                                    fontSize: '11px',
                                    color: 'var(--ram-text-tertiary)',
                                    marginTop: '6px',
                                    lineHeight: 1.4,
                                }}>
                                    Editing this prompt is not recommended without developer support. The response must include these JSON fields: <code style={{ fontSize: '10px', background: 'var(--ram-bg-tertiary)', padding: '1px 4px', borderRadius: '3px' }}>context_environment</code>, <code style={{ fontSize: '10px', background: 'var(--ram-bg-tertiary)', padding: '1px 4px', borderRadius: '3px' }}>seasonality</code>, <code style={{ fontSize: '10px', background: 'var(--ram-bg-tertiary)', padding: '1px 4px', borderRadius: '3px' }}>lighting_mood</code>, <code style={{ fontSize: '10px', background: 'var(--ram-bg-tertiary)', padding: '1px 4px', borderRadius: '3px' }}>human_experience</code>, <code style={{ fontSize: '10px', background: 'var(--ram-bg-tertiary)', padding: '1px 4px', borderRadius: '3px' }}>primary_objects</code>, <code style={{ fontSize: '10px', background: 'var(--ram-bg-tertiary)', padding: '1px 4px', borderRadius: '3px' }}>color_palette</code>, <code style={{ fontSize: '10px', background: 'var(--ram-bg-tertiary)', padding: '1px 4px', borderRadius: '3px' }}>label_csv</code>. Renaming or removing these fields will break the description pipeline.
                                </p>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--ram-text-secondary)' }}>
                                    <span>Rate limit delay (ms):</span>
                                    <input
                                        type="number"
                                        value={aiSettings.delayMs}
                                        onChange={e => setAISettings({ ...aiSettings, delayMs: parseInt(e.target.value) || 500 })}
                                        style={{
                                            width: '70px',
                                            fontSize: '12px',
                                            padding: '4px 8px',
                                            borderRadius: '6px',
                                            background: 'var(--ram-bg-secondary)',
                                            color: 'var(--ram-text-primary)',
                                            border: '1px solid var(--ram-border)',
                                        }}
                                    />
                                </label>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: '8px',
                    padding: '12px 24px',
                    borderTop: '1px solid var(--ram-border)',
                }}>
                    <button
                        onClick={onClose}
                        style={{
                            fontSize: '12px',
                            padding: '6px 16px',
                            borderRadius: '8px',
                            background: 'var(--ram-bg-tertiary)',
                            color: 'var(--ram-text-secondary)',
                            border: '1px solid var(--ram-border)',
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        style={{
                            fontSize: '12px',
                            padding: '6px 20px',
                            borderRadius: '8px',
                            fontWeight: 600,
                            background: 'linear-gradient(135deg, var(--ram-accent), #d4922e)',
                            color: 'var(--ram-bg-primary)',
                            border: 'none',
                            cursor: saving ? 'default' : 'pointer',
                            opacity: saving ? 0.5 : 1,
                        }}
                    >
                        {saving ? 'Saving…' : 'Save Settings'}
                    </button>
                </div>
            </div>
        </div>
    );
}
