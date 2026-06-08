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

type MiniGameBody = {
  game_type?: unknown;
};

const ALLOWED_BODY_KEYS = new Set(['game_type']);
const ALLOWED_GAME_TYPES = new Set(['spin', 'scratch']);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<MiniGameBody>(request);
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
        { error: 'Invalid request', message: 'Unsupported reward fields.' },
        { status: 400 },
      );
    }

    const gameType = parsed.data.game_type?.toString().trim().toLowerCase();
    if (!gameType || !ALLOWED_GAME_TYPES.has(gameType)) {
      return NextResponse.json(
        {
          error: 'Invalid game',
          message: 'Choose either spin or scratch.',
        },
        { status: 400 },
      );
    }

    const { data, error } = await supabaseAdmin.rpc(
      'claim_gem_mini_game_reward_for_user',
      {
        p_user_id: auth.user.id,
        p_game_type: gameType,
      },
    );

    if (error || !data) {
      return NextResponse.json(
        {
          error: 'Reward failed',
          message: error?.message ?? 'Unable to claim reward.',
        },
        { status: 400 },
      );
    }

    const status = data as Record<string, unknown>;
    const success = status.success === true;

    return NextResponse.json(
      {
        apiVersion: 'v2',
        authenticated: true,
        data,
        userId: auth.user.id,
      },
      { status: success ? 200 : 429 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Reward failed',
        message:
          error instanceof Error ? error.message : 'Unable to claim reward.',
      },
      { status: 400 },
    );
  }
}
