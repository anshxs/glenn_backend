import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/mobile/me/participations
// Auth required: Bearer <supabase access token>
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const user = await verifyBearerToken(authHeader);

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from('tournament_participants')
    .select('tournament_id')
    .eq('participant_id', user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const tournamentIds = (data ?? [])
    .map((row) => row.tournament_id as string)
    .filter((id): id is string => !!id);

  return NextResponse.json({ tournamentIds });
}
