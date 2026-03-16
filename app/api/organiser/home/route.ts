import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TOURNAMENT_COLUMNS =
  'id, tournament_name, categories, type, maptype, totalslots, slotsleft, ' +
  'tournament_datetime, entryfee, prizepool, results_submitted, ' +
  'registration_allowed, per_kill, description, image_url, banner_url, ' +
  'organiser_id, organiser_name, organiser_contact, stream_url';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const nowIso = new Date().toISOString();

    const [profileRes, statsRes, myTournamentsRes, availableTournamentsRes] = await Promise.all([
      supabaseAdmin
        .from('sensitive_userdata')
        .select('id, username, email, name, avatarurl, ffuid, ffname, bio, rank, earnings, is_bluetick, is_redtick')
        .eq('id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('organisers')
        .select('hosted_count, balance')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('tournaments')
        .select(TOURNAMENT_COLUMNS)
        .eq('organiser_id', user.id)
        .order('tournament_datetime', { ascending: true }),
      supabaseAdmin
        .from('tournaments')
        .select(TOURNAMENT_COLUMNS)
        .is('organiser_id', null)
        .eq('registration_allowed', true)
        .gte('tournament_datetime', nowIso)
        .order('tournament_datetime', { ascending: true })
        .limit(30),
    ]);

    if (profileRes.error) {
      return NextResponse.json(
        { error: 'Failed to fetch profile', details: profileRes.error.message },
        { status: 500 }
      );
    }

    if (statsRes.error) {
      return NextResponse.json(
        { error: 'Failed to fetch organiser stats', details: statsRes.error.message },
        { status: 500 }
      );
    }

    if (myTournamentsRes.error) {
      return NextResponse.json(
        { error: 'Failed to fetch organiser tournaments', details: myTournamentsRes.error.message },
        { status: 500 }
      );
    }

    if (availableTournamentsRes.error) {
      return NextResponse.json(
        { error: 'Failed to fetch available tournaments', details: availableTournamentsRes.error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        profile: profileRes.data ?? null,
        stats: {
          hosted_count: statsRes.data?.hosted_count ?? 0,
          balance: statsRes.data?.balance ?? 0,
        },
        my_tournaments: myTournamentsRes.data ?? [],
        available_tournaments: availableTournamentsRes.data ?? [],
      },
    });
  } catch (error) {
    console.error('organiser home API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
