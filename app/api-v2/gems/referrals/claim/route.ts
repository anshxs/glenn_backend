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

type ClaimReferralBody = {
  referral_code?: unknown;
};

const ALLOWED_BODY_KEYS = new Set(['referral_code']);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<ClaimReferralBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    if (
      !Object.keys(parsed.data as Record<string, unknown>).every((key) =>
        ALLOWED_BODY_KEYS.has(key),
      )
    ) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Unsupported referral fields.' },
        { status: 400 },
      );
    }

    const referralCode = parsed.data.referral_code?.toString().trim() ?? '';
    if (!/^[A-Za-z0-9]{6}$/.test(referralCode)) {
      return NextResponse.json(
        {
          error: 'Invalid referral code',
          message: 'Enter a valid 6 character referral code.',
        },
        { status: 400 },
      );
    }

    const { data, error } = await supabaseAdmin.rpc(
      'claim_referral_reward_for_user',
      {
        p_referred_user_id: auth.user.id,
        p_referral_code: referralCode,
      },
    );

    if (error || !data) {
      return NextResponse.json(
        {
          error: 'Referral failed',
          message: error?.message ?? 'Unable to apply referral code.',
        },
        { status: 400 },
      );
    }

    if (data.success !== true) {
      return NextResponse.json(
        {
          error: 'Referral failed',
          message: data.message ?? 'Unable to apply referral code.',
          data,
        },
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
        error: 'Referral failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to apply referral code.',
      },
      { status: 400 },
    );
  }
}
