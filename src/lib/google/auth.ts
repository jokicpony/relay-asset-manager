/**
 * Google Drive authentication — 3-tier strategy:
 *
 * 1. PRODUCTION (Vercel): WIF via @vercel/oidc → service account impersonation
 * 2. LOCAL TEST: Application Default Credentials via `gcloud auth` → service account impersonation
 * 3. LOCAL DEV:  User's Google OAuth token from the Supabase session (no setup needed)
 */

import { ExternalAccountClient, GoogleAuth, type AuthClient } from 'google-auth-library';
import { logger } from '@/lib/logger';

// WIF configuration from environment
const GCP_PROJECT_NUMBER = process.env.GCP_PROJECT_NUMBER;
const GCP_SERVICE_ACCOUNT_EMAIL = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
const GCP_WORKLOAD_IDENTITY_POOL_ID = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID;
const GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;

// Cached auth client (reused across requests)
let _authClient: AuthClient | null = null;

function isWifConfigured(): boolean {
    return !!(
        GCP_PROJECT_NUMBER &&
        GCP_SERVICE_ACCOUNT_EMAIL &&
        GCP_WORKLOAD_IDENTITY_POOL_ID &&
        GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
    );
}

function getAuthClient(): AuthClient {
    if (_authClient) return _authClient;

    // Dynamic import of @vercel/oidc to avoid errors in local dev
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getVercelOidcToken } = require('@vercel/oidc');

    // The Vercel OIDC token must carry the audience we configured in the
    // GCP WIF provider. google-auth-library passes its own STS audience
    // by default, which doesn't match — so we wrap the call.
    const vercelTeam = process.env.VERCEL_TEAM_SLUG || process.env.VERCEL_TEAM_ID;
    if (!vercelTeam) {
        throw new Error(
            'WIF requires VERCEL_TEAM_SLUG (your Vercel team slug from the dashboard URL). ' +
            'Add it as an environment variable in Vercel project settings.'
        );
    }
    const vercelAudience = `https://vercel.com/${vercelTeam}`;

    const client = ExternalAccountClient.fromJSON({
        type: 'external_account',
        audience: `//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: 'https://sts.googleapis.com/v1/token',
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
        subject_token_supplier: {
            getSubjectToken: async () => getVercelOidcToken({ audience: vercelAudience }),
        },
    });

    if (!client) {
        throw new Error('Failed to create ExternalAccountClient from WIF config');
    }

    // Set Drive scopes — required for the service account impersonation
    // token to include Drive API access. drive.labels is needed for the
    // Namer's Drive Labels functionality.
    client.scopes = [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.labels',
    ];

    _authClient = client;
    return _authClient;
}

/**
 * Get a Google Drive access token.
 *
 * In production: uses WIF (Vercel OIDC → service account impersonation)
 * In local dev:  falls back to user's OAuth token from Supabase session
 */
export async function getDriveAccessToken(): Promise<string> {
    // Production path: WIF (Vercel OIDC → service account)
    if (isWifConfigured()) {
        try {
            const client = getAuthClient();
            const tokenResponse = await client.getAccessToken();
            const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
            if (!token) {
                throw new Error('WIF returned null access token');
            }
            return token;
        } catch (err) {
            logger.error('google-auth', 'WIF token exchange failed', { error: String(err) });
            throw new Error(`Failed to get Drive access token via WIF: ${err}`);
        }
    }

    // Local testing path: Application Default Credentials (gcloud auth)
    // Activate by setting USE_SERVICE_ACCOUNT=true in .env.local
    if (process.env.USE_SERVICE_ACCOUNT === 'true') {
        try {
            const auth = new GoogleAuth({
                scopes: [
                    'https://www.googleapis.com/auth/drive',
                    'https://www.googleapis.com/auth/drive.labels',
                ],
            });
            const client = await auth.getClient();
            const tokenResponse = await client.getAccessToken();
            const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
            if (!token) {
                throw new Error('ADC returned null access token');
            }
            logger.info('google-auth', 'Got access token via Application Default Credentials');
            return token;
        } catch (err) {
            logger.error('google-auth', 'ADC token failed', { error: String(err) });
            throw new Error(`Failed to get Drive access token via ADC: ${err}`);
        }
    }

    // Local dev fallback: use user's OAuth token from Supabase session
    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error(
            'Google auth not configured. Set GCP_PROJECT_NUMBER + GCP_SERVICE_ACCOUNT_EMAIL + ' +
            'GCP_WORKLOAD_IDENTITY_POOL_ID + GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID for WIF, ' +
            'or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET for local dev.'
        );
    }

    // Import Supabase server client dynamically to avoid circular deps
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
        throw new Error('Not authenticated — no Supabase session');
    }

    let accessToken = session.provider_token;

    // Try refreshing session
    if (!accessToken) {
        const { data: { session: refreshed } } = await supabase.auth.refreshSession();
        if (refreshed) accessToken = refreshed.provider_token;
    }

    // Manual Google token refresh
    if (!accessToken && session.provider_refresh_token) {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: session.provider_refresh_token,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
            }),
        });
        const tokenData = await tokenRes.json();
        accessToken = tokenData.access_token;
    }

    if (!accessToken) {
        throw new Error('No Google access token available');
    }

    return accessToken;
}
