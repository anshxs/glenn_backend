import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Public bootstrap payload for mobile home screen.
// Keeps Supabase keys and SQL details on backend only.
export async function GET() {
  const [appConfigRes, textAnnouncementsRes, imageAnnouncementsRes] = await Promise.all([
    supabaseAdmin
      .from('app_config')
      .select('maintenance_mode, maintenance_message, minimum_version, download_url')
      .eq('id', 1)
      .maybeSingle(),
    supabaseAdmin
      .from('announcements')
      .select('id, message, onclick, created_at')
      .eq('display', true)
      .order('created_at', { ascending: false })
      .limit(10),
    supabaseAdmin
      .from('announcements_with_image')
      .select('id, message, image_url, onclick, created_at')
      .eq('display', true)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const firstError = [
    appConfigRes.error,
    textAnnouncementsRes.error,
    imageAnnouncementsRes.error,
  ].find(Boolean);

  if (firstError) {
    return NextResponse.json(
      { error: firstError.message ?? 'Failed to load mobile bootstrap data' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    appConfig: appConfigRes.data ?? {
      maintenance_mode: false,
      maintenance_message: null,
      minimum_version: '1.0.0',
      download_url: null,
    },
    textAnnouncements: textAnnouncementsRes.data ?? [],
    imageAnnouncements: imageAnnouncementsRes.data ?? [],
    generatedAt: new Date().toISOString(),
  });
}
