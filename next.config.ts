import type { NextConfig } from "next";

// Extract Supabase hostname from env var so it isn't hardcoded.
// Falls back to a wildcard pattern so `next build` works without env vars.
const supabaseHostname = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
  : '*.supabase.co';

const nextConfig: NextConfig = {
  images: {
    // Optimized thumbnails are cached for 30 days. Safe because rewritten
    // thumbnails get a new URL: custom frames and in-app ingest uploads are
    // versioned (?v=); the cron sync only writes thumbnails that don't exist.
    minimumCacheTTL: 60 * 60 * 24 * 30,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: supabaseHostname,
        pathname: '/storage/**',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
