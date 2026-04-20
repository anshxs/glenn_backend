import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { markRewardedSessionOpened } from '@/lib/gem-rewards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type OpenBody = {
  session_id: string;
  session_token: string;
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

    const parsed = await readGlennJsonBody<OpenBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    await markRewardedSessionOpened({
      userId: user.id,
      sessionId: parsed.data.session_id,
      sessionToken: parsed.data.session_token,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Open tracking failed',
        message: error instanceof Error ? error.message : 'Unable to track rewarded ad open.',
      },
      { status: 400 },
    );
  }
}
