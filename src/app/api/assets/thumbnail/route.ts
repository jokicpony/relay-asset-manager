import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * POST /api/assets/thumbnail
 *
 * Upload a custom thumbnail (captured video frame) for an asset.
 * Stores the image in Supabase Storage `thumbnails` bucket and updates
 * the asset's thumbnail_url. The sync pipeline preserves non-Google
 * thumbnail URLs, so this override persists across syncs.
 *
 * Body: FormData with:
 *   - file: Blob (image/png or image/webp)
 *   - driveFileId: string
 */
export async function POST(request: NextRequest) {
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const formData = await request.formData();
        const file = formData.get('file') as Blob | null;
        const driveFileId = formData.get('driveFileId') as string | null;

        if (!file || !driveFileId) {
            return NextResponse.json(
                { error: 'Missing file or driveFileId' },
                { status: 400 }
            );
        }

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        // Upload to Supabase Storage
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const filePath = `custom_${driveFileId}.webp`;

        const { error: uploadError } = await supabase.storage
            .from('thumbnails')
            .upload(filePath, buffer, {
                contentType: 'image/webp',
                upsert: true, // Overwrite if user sets a new thumbnail
            });

        if (uploadError) {
            logger.error('thumbnail', 'Upload failed', { error: uploadError.message });
            return NextResponse.json(
                { error: `Upload failed: ${uploadError.message}` },
                { status: 500 }
            );
        }

        // Get the public URL
        const { data: urlData } = supabase.storage
            .from('thumbnails')
            .getPublicUrl(filePath);

        const publicUrl = urlData.publicUrl;

        // Update the asset's thumbnail_url in the database
        const { error: updateError } = await supabase
            .from('assets')
            .update({ thumbnail_url: publicUrl })
            .eq('drive_file_id', driveFileId);

        if (updateError) {
            logger.error('thumbnail', 'DB update failed', { error: updateError.message });
            return NextResponse.json(
                { error: `Database update failed: ${updateError.message}` },
                { status: 500 }
            );
        }

        return NextResponse.json({ thumbnailUrl: publicUrl });
    } catch (err) {
        logger.error('thumbnail', 'Unexpected error', { error: err instanceof Error ? err.message : String(err) });
        return NextResponse.json(
            { error: 'Unexpected error' },
            { status: 500 }
        );
    }
}
