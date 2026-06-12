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
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<Record<string, never>>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    const { data, error } = await supabaseAdmin.rpc(
      'get_referral_status_for_user',
      { p_user_id: auth.user.id },
    );

    if (error) {
      return NextResponse.json(
        { error: 'Referral status failed', message: error.message },
        { status: 400 },
      );
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data,
      userId: auth.user.id,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Referral status failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to load referral status.',
      },
      { status: 400 },
    );
  }
}
