import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          message: 'Invalid or missing authentication token',
        },
        { status: 401 },
      );
    }

    const parsed = await readGlennJsonBody<Record<string, never>>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const { data, error } = await supabaseAdmin.rpc(
      'claim_sunday_gem_spin_for_user',
      { p_user_id: user.id },
    );

    if (error || !data) {
      return NextResponse.json(
        {
          error: 'Claim failed',
          message: error?.message ?? 'Unable to claim Sunday spin reward.',
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Claim failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to claim Sunday spin reward.',
      },
      { status: 400 },
    );
  }
}
