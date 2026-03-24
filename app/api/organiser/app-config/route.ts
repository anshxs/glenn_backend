import { NextRequest, NextResponse } from 'next/server';

import { verifyOrganiserRequestSecurity } from '@/lib/organiser-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const securityError = await verifyOrganiserRequestSecurity(request, {
      allowAnyBuildHash: true,
      allowUnsigned: true,
    });
    if (securityError) {
      return securityError;
    }

    const { data, error } = await supabaseAdmin
      .from('organiser_app_config')
      .select('maintenance_mode, maintenance_message, minimum_version, download_url, updated_at')
      .eq('id', 1)
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: 'Failed to load organiser app config', details: error?.message ?? 'Unknown error' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('organiser app-config error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
