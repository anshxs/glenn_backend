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

type MiniGameStatusBody = {
  game_type?: unknown;
};

const ALLOWED_BODY_KEYS = new Set(['game_type']);
const ALLOWED_GAME_TYPES = new Set(['spin', 'scratch']);

function indiaDateKey(): string {
  const indiaNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return indiaNow.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<MiniGameStatusBody>(request);
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
        { error: 'Invalid game', message: 'Choose either spin or scratch.' },
        { status: 400 },
      );
    }

    const today = indiaDateKey();
    const { count, error } = await supabaseAdmin
      .from('user_gem_mini_game_plays')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', auth.user.id)
      .eq('game_type', gameType)
      .eq('play_date', today);

    if (error) {
      return NextResponse.json(
        {
          error: 'Status failed',
          message: error.message || 'Unable to load plays left.',
        },
        { status: 400 },
      );
    }

    const playsUsed = count ?? 0;
    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data: {
        game_type: gameType,
        today,
        plays_used: playsUsed,
        plays_remaining: Math.max(0, 1 - playsUsed),
      },
      userId: auth.user.id,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Status failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to load plays left.',
      },
      { status: 400 },
    );
  }
}
