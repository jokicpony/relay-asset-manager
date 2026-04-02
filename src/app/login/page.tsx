'use client';

import { createClient } from '@/lib/supabase/client';
import { useState } from 'react';

/**
 * Login page with Google SSO.
 * Redirects to Google OAuth flow via Supabase Auth.
 */
export default function LoginPage() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleGoogleLogin = async () => {
        setLoading(true);
        setError(null);

        // Stash the intended destination in localStorage so the app
        // can restore it after the OAuth round-trip completes.
        // This avoids modifying the OAuth redirectTo chain entirely.
        const params = new URLSearchParams(window.location.search);
        const next = params.get('next');
        if (next && next !== '/') {
            localStorage.setItem('relay_post_login_redirect', next);
        }

        const supabase = createClient();

        // In production (Vercel), Drive access goes through WIF service account
        // — no need to ask users for Drive permissions.
        // In local dev, we need the user's OAuth token as a fallback.
        const isProduction = !!process.env.NEXT_PUBLIC_VERCEL_ENV;

        const oauthOptions: Parameters<typeof supabase.auth.signInWithOAuth>[0] = {
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/auth/callback`,
                skipBrowserRedirect: false,
            },
        };

        if (!isProduction) {
            // Local dev: request Drive scopes so the user's OAuth token can
            // be used as a fallback for Drive API calls.
            oauthOptions.options!.scopes = [
                'https://www.googleapis.com/auth/drive',
                'https://www.googleapis.com/auth/drive.labels',
            ].join(' ');
            oauthOptions.options!.queryParams = {
                access_type: 'offline',
                prompt: 'consent',
            };
        }

        const { error } = await supabase.auth.signInWithOAuth(oauthOptions);

        if (error) {
            setError(error.message);
            setLoading(false);
        }
    };

    return (
        <div
            className="min-h-screen flex items-center justify-center"
            style={{ background: 'var(--ram-surface)' }}
        >
            <div
                className="w-full max-w-sm p-8 rounded-2xl"
                style={{
                    background: 'var(--ram-surface-raised)',
                    border: '1px solid var(--ram-border)',
                }}
            >
                {/* Logo / Brand */}
                <div className="text-center mb-8">
                    <div
                        className="inline-flex items-center justify-center w-14 h-14 rounded-xl mb-4 text-2xl font-bold"
                        style={{
                            background: 'var(--ram-teal-bg)',
                            color: 'var(--ram-teal)',
                        }}
                    >
                        R
                    </div>
                    <h1
                        className="text-xl font-semibold"
                        style={{ color: 'var(--ram-text-primary)' }}
                    >
                        Relay Asset Manager
                    </h1>
                    <p
                        className="text-sm mt-1"
                        style={{ color: 'var(--ram-text-tertiary)' }}
                    >
                        Sign in to manage your creative library
                    </p>
                </div>

                {/* Error Message */}
                {error && (
                    <div
                        className="mb-4 px-3 py-2 rounded-lg text-xs"
                        style={{
                            background: 'var(--ram-red-bg)',
                            color: 'var(--ram-red)',
                            border: '1px solid rgba(248, 113, 113, 0.2)',
                        }}
                    >
                        {error}
                    </div>
                )}

                {/* Google Sign-In Button */}
                <button
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200"
                    style={{
                        background: loading
                            ? 'var(--ram-surface-raised)'
                            : 'white',
                        color: loading ? 'var(--ram-text-tertiary)' : '#1f1f1f',
                        border: '1px solid var(--ram-border)',
                        cursor: loading ? 'not-allowed' : 'pointer',
                        opacity: loading ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => {
                        if (!loading) {
                            e.currentTarget.style.background = '#f8f9fa';
                            e.currentTarget.style.borderColor = '#dadce0';
                        }
                    }}
                    onMouseLeave={(e) => {
                        if (!loading) {
                            e.currentTarget.style.background = 'white';
                            e.currentTarget.style.borderColor =
                                'var(--ram-border)';
                        }
                    }}
                >
                    {/* Google "G" Logo */}
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 18 18"
                        fill="none"
                    >
                        <path
                            d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
                            fill="#4285F4"
                        />
                        <path
                            d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
                            fill="#34A853"
                        />
                        <path
                            d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
                            fill="#FBBC05"
                        />
                        <path
                            d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
                            fill="#EA4335"
                        />
                    </svg>
                    {loading ? 'Signing in...' : 'Sign in with Google'}
                </button>

                {/* Footer note */}
                <p
                    className="text-center text-[11px] mt-6"
                    style={{ color: 'var(--ram-text-tertiary)' }}
                >
                    Requires access to Google Drive for asset management
                </p>
            </div>
        </div>
    );
}
