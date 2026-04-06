import { NextRequest, NextResponse } from 'next/server';

import {
  isSupportedOrganiserBuildHash,
  verifyOrganiserRequestSecurity,
} from '@/lib/organiser-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const securityError = await verifyOrganiserRequestSecurity(request, {
      allowAnyBuildHash: true,
    });
    if (securityError) {
      return securityError;
    }

    const buildHash = request.headers.get('x-organiser-build-hash');
    const { data: config, error } = await supabaseAdmin
      .from('organiser_app_config')
      .select(
        'maintenance_mode, maintenance_message, minimum_version, download_url, updated_at',
      )
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        {
          error: 'Failed to load organiser app config',
          details: error.message,
        },
        { status: 500 },
      );
    }

    const data = {
      maintenance_mode: config?.maintenance_mode ?? false,
      maintenance_message: config?.maintenance_message ?? '',
      minimum_version: config?.minimum_version ?? '1.0.0',
      download_url: config?.download_url ?? '',
      updated_at: config?.updated_at ?? null,
      update_required: !isSupportedOrganiserBuildHash(buildHash),
    };

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
