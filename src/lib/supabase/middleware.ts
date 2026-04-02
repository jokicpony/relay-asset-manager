import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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

    return supabaseResponse;
}
