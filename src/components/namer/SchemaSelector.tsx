'use client';

import NamerSelect from './NamerSelect';
import { PASSTHROUGH_SCHEMA_KEY } from '@/lib/namer/types';

interface SchemaSelectorProps {
    schemas: string[];
    selected: string;
    onSelect: (schema: string) => void;
}

export default function SchemaSelector({ schemas, selected, onSelect }: SchemaSelectorProps) {
    // Format schema names for display (capitalize, replace underscores)
    const displayName = (s: string) => s
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

    // Prepend passthrough option ahead of user-defined schemas
    const allOptions = [PASSTHROUGH_SCHEMA_KEY, ...schemas];

    // Custom display name mapper — passthrough gets a friendly label
    const formatLabel = (s: string) =>
        s === PASSTHROUGH_SCHEMA_KEY ? 'Passthrough (Keep Original Name)' : displayName(s);

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--ram-text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                whiteSpace: 'nowrap',
            }}>
                Asset Type
            </span>
            <div style={{ minWidth: '180px' }}>
                <NamerSelect
                    options={allOptions}
                    value={selected}
                    onChange={onSelect}
                    placeholder="Select asset type…"
                    formatLabel={formatLabel}
                />
            </div>
        </div>
    );
}
