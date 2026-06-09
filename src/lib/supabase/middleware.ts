import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optional sign-in allowlist. Default-open: when neither env var is set,
 * everyone who can authenticate is allowed (preserves prior behavior).
 * Set AUTH_ALLOWED_EMAILS and/or AUTH_ALLOWED_DOMAINS (comma-separated) to
 * restrict access at the app layer, independent of the Google OAuth screen.
 */
function isAllowedUser(email: string | undefined): boolean {
    const emails = (process.env.AUTH_ALLOWED_EMAILS ?? '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const domains = (process.env.AUTH_ALLOWED_DOMAINS ?? '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (emails.length === 0 && domains.length === 0) return true; // default-open
    if (!email) return false;
    const normalized = email.toLowerCase();
    if (emails.includes(normalized)) return true;
    const domain = normalized.split('@')[1] ?? '';
    return domain.length > 0 && domains.includes(domain);
}

/**
 * Middleware to refresh Supabase auth sessions on every request.
 * This ensures the session cookie stays fresh and the user stays logged in.
 *
 */
export async function updateSession(request: NextRequest) {
    let supabaseResponse = NextResponse.next({
        request,
    });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) =>
                        request.cookies.set(name, value)
                    );
                    supabaseResponse = NextResponse.next({
                        request,
                    });
                    cookiesToSet.forEach(({ name, value, options }) =>
                        supabaseResponse.cookies.set(name, value, options)
                    );
                },
            },
        }
    );

    // Refresh the session — this is the important part
    const {
        data: { user },
    } = await supabase.auth.getUser();

    // If no user and not on the login page, redirect to login
    if (
        !user &&
        !request.nextUrl.pathname.startsWith('/login') &&
        !request.nextUrl.pathname.startsWith('/auth')
    ) {
        const url = request.nextUrl.clone();
        // Preserve the original destination so the login page can stash it
        const dest = request.nextUrl.pathname + request.nextUrl.search;
        url.pathname = '/login';
        url.search = dest !== '/' ? `?next=${encodeURIComponent(dest)}` : '';
        return NextResponse.redirect(url);
    }

    // Allowlist enforcement (default-open): if AUTH_ALLOWED_EMAILS /
    // AUTH_ALLOWED_DOMAINS are set, a signed-in user whose email isn't
    // permitted is bounced to login with their Supabase cookies cleared.
    // Defense-in-depth for deployments whose Google OAuth screen isn't locked.
    if (
        user &&
        !isAllowedUser(user.email) &&
        !request.nextUrl.pathname.startsWith('/login') &&
        !request.nextUrl.pathname.startsWith('/auth')
    ) {
        const url = request.nextUrl.clone();
        url.pathname = '/login';
        url.search = '?error=not_authorized';
        const redirect = NextResponse.redirect(url);
        for (const cookie of request.cookies.getAll()) {
            if (cookie.name.startsWith('sb-')) redirect.cookies.delete(cookie.name);
        }
        return redirect;
    }

    return supabaseResponse;
}
