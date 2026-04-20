import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import {
  createRewardedClaimSession,
  GemRewardPlacement,
} from '@/lib/gem-rewards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type StartBody = {
  placement: GemRewardPlacement;
  startio_enabled?: boolean;
};

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

    const parsed = await readGlennJsonBody<StartBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const placement = parsed.data.placement;
    const startioEnabled = parsed.data.startio_enabled === true;
    if (placement !== 'daily_gem_checkin' && placement !== 'sunday_spin') {
      return NextResponse.json(
        {
          error: 'Invalid placement',
          message: 'Unsupported rewarded ad placement.',
        },
        { status: 400 },
      );
    }

    const result = await createRewardedClaimSession({
      userId: user.id,
      placement,
      preferStartIo: startioEnabled,
      deviceId: request.headers.get('x-glenn-device-id'),
      buildHash: request.headers.get('x-glenn-build-hash'),
      securityContext: request.headers.get('x-glenn-security-context'),
    });

    return NextResponse.json({
      data: {
        session_id: result.session.id,
        session_token: result.session.session_token,
        placement: result.session.placement,
        provider: result.session.provider,
        required_view_seconds: result.session.required_view_seconds,
        internal_ad:
          result.session.provider === 'internal'
            ? result.session.ad_payload_snapshot
            : null,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Rewarded session failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to create rewarded session.',
      },
      { status: 500 },
    );
  }
}
