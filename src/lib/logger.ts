/**
 * Unified Structured Logger
 *
 * Consistent logging across the application.
 * - Dev:        colored human-readable output with [app/tag] prefix
 * - Production: single-line JSON for Vercel Log Drains / machine parsing
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info('sync', 'Upserted assets', { count: 150 });
 *   logger.error('download', 'Token refresh failed', { status: 401 });
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    app: string;
    env: string;
    level: LogLevel;
    tag: string;
    message: string;
    ts: number;
    requestId?: string;
    [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const APP_NAME = process.env.APP_NAME || 'relay-asset-manager';
const ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const IS_JSON = ENV === 'production' || process.env.CI === 'true';

function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function formatDev(level: LogLevel, tag: string, message: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const prefix = `${APP_NAME.split('-')[0]}/${tag}`;
    const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
    return `${ts} [${prefix}] ${message}${metaStr}`;
}

function emit(level: LogLevel, tag: string, message: string, meta?: Record<string, unknown>) {
    if (!shouldLog(level)) return;

    if (IS_JSON) {
        const entry: LogEntry = { app: APP_NAME, env: ENV, level, tag, message, ...meta, ts: Date.now() };
        const line = JSON.stringify(entry);
        if (level === 'error') {
            console.error(line);
        } else if (level === 'warn') {
            console.warn(line);
        } else {
            console.log(line);
        }
    } else {
        const formatted = formatDev(level, tag, message, meta);
        if (level === 'error') {
            console.error(formatted);
        } else if (level === 'warn') {
            console.warn(formatted);
        } else {
            console.log(formatted);
        }
    }
}

export const logger = {
    debug: (tag: string, message: string, meta?: Record<string, unknown>) => emit('debug', tag, message, meta),
    info: (tag: string, message: string, meta?: Record<string, unknown>) => emit('info', tag, message, meta),
    warn: (tag: string, message: string, meta?: Record<string, unknown>) => emit('warn', tag, message, meta),
    error: (tag: string, message: string, meta?: Record<string, unknown>) => emit('error', tag, message, meta),
};
