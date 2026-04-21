import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { finalizeQuizRewardClaim } from '@/lib/gem-rewards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ClaimQuizBody = {
  session_id: string;
  session_token: string;
  quiz_id: string;
  selected_option_index: number;
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

    const parsed = await readGlennJsonBody<ClaimQuizBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    if (!parsed.data.quiz_id || !parsed.data.session_id || !parsed.data.session_token) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          message: 'Quiz claim payload is incomplete.',
        },
        { status: 400 },
      );
    }

    const data = await finalizeQuizRewardClaim({
      userId: user.id,
      sessionId: parsed.data.session_id,
      sessionToken: parsed.data.session_token,
      quizId: parsed.data.quiz_id,
      selectedOptionIndex: parsed.data.selected_option_index,
    });

    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Quiz claim failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to complete quiz claim.',
      },
      { status: 400 },
    );
  }
}
