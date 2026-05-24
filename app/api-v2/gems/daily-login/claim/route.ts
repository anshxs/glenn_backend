import { NextRequest, NextResponse } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) {
      return auth.response;
    }

    const parsed = await readGlennJsonBody<Record<string, never>>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    if (Object.keys(parsed.data as Record<string, unknown>).length > 0) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'This endpoint accepts no fields.' },
        { status: 400 },
      );
    }

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) {
      return maintenanceResponse;
    }

    const { data, error } = await supabaseAdmin.rpc(
      'claim_daily_gem_checkin_for_user',
      { p_user_id: auth.user.id },
    );

    if (error || !data) {
      return NextResponse.json(
        {
          error: 'Claim failed',
          message: error?.message ?? 'Unable to claim daily login reward.',
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Claim failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to claim daily login reward.',
      },
      { status: 400 },
    );
  }
}
