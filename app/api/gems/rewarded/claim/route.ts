import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import {
  finalizeRewardedClaim,
  GemRewardPlacement,
} from '@/lib/gem-rewards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ClaimBody = {
  session_id: string;
  session_token: string;
  placement: GemRewardPlacement;
};

export async function POST(request: NextRequest) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 },
      );
    }

    const parsed = await readGlennJsonBody<ClaimBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const placement = parsed.data.placement;
    if (placement !== 'daily_gem_checkin' && placement !== 'sunday_spin') {
      return NextResponse.json(
        { error: 'Invalid placement', message: 'Unsupported rewarded ad placement.' },
        { status: 400 },
      );
    }

    const data = await finalizeRewardedClaim({
      userId: user.id,
      sessionId: parsed.data.session_id,
      sessionToken: parsed.data.session_token,
      placement,
    });

    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Claim failed',
        message: error instanceof Error ? error.message : 'Unable to complete rewarded claim.',
      },
      { status: 400 },
    );
  }
}
