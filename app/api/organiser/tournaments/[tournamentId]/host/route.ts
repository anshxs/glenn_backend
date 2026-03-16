import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ tournamentId: string }>;
};

function errorStatus(message: string): number {
  if (message.includes('Unauthorized')) return 401;
  if (message.includes('not found')) return 404;
  if (message.includes('already has an organiser')) return 409;
  return 400;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const { tournamentId } = await context.params;

    const { data, error } = await supabaseAdmin.rpc('assign_organiser_to_tournament', {
      p_user_id: user.id,
      p_tournament_id: tournamentId,
    });

    if (error) {
      return NextResponse.json(
        { error: 'Unable to host tournament', message: error.message },
        { status: errorStatus(error.message) }
      );
    }

    const row = Array.isArray(data) ? data[0] : data;

    return NextResponse.json({
      success: true,
      message: 'Tournament assigned to organiser successfully',
      data: row ?? null,
    });
  } catch (error) {
    console.error('organiser host tournament POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const { tournamentId } = await context.params;

    const { data, error } = await supabaseAdmin.rpc('unassign_organiser_from_tournament', {
      p_user_id: user.id,
      p_tournament_id: tournamentId,
    });

    if (error) {
      return NextResponse.json(
        { error: 'Unable to unregister tournament', message: error.message },
        { status: errorStatus(error.message) }
      );
    }

    const row = Array.isArray(data) ? data[0] : data;

    return NextResponse.json({
      success: true,
      message: 'Tournament unregistered successfully',
      data: row ?? null,
    });
  } catch (error) {
    console.error('organiser host tournament DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
