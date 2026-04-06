import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { verifyOrganiserRequestSecurity } from '@/lib/organiser-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TournamentRow = {
  id: string;
  [key: string]: unknown;
};

const TOURNAMENT_COLUMNS =
  'id, tournament_name, description, host_notes, categories, type, maptype, totalslots, slotsleft, ' +
  'tournament_datetime, entryfee, prizepool, image_url, prizedistribution, stream_url, ' +
  'results_submitted, banner_url, support_contact, revive_allowed, per_kill, ' +
  'registration_allowed, organiser_id, organiser_name, organiser_contact, organiser_commission, ' +
  'roomid, roompass, result_verified';

export async function GET(request: NextRequest) {
  try {
    const securityError = await verifyOrganiserRequestSecurity(request);
    if (securityError) {
      return securityError;
    }

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
        .select('balance')
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

    const myTournaments = (myTournamentsRes.data ?? []) as unknown as TournamentRow[];
    const availableTournaments =
      (availableTournamentsRes.data ?? []) as unknown as TournamentRow[];
    const allTournamentIds = Array.from(
      new Set([
        ...myTournaments.map((t) => t.id).filter(Boolean),
        ...availableTournaments.map((t) => t.id).filter(Boolean),
      ])
    );

    const participantCountByTournament: Record<string, number> = {};

    if (allTournamentIds.length > 0) {
      const { data: participantRows, error: participantErr } = await supabaseAdmin
        .from('tournament_participants')
        .select('tournament_id, participant_id')
        .in('tournament_id', allTournamentIds);

      if (participantErr) {
        return NextResponse.json(
          { error: 'Failed to fetch tournament participant stats', details: participantErr.message },
          { status: 500 }
        );
      }

      for (const row of participantRows ?? []) {
        const tid = row.tournament_id as string | null;
        const pid = row.participant_id as string | null;
        if (!tid || !pid) continue;
        if (!(tid in participantCountByTournament)) {
          participantCountByTournament[tid] = 0;
        }
      }

      const uniqueByTournament = new Map<string, Set<string>>();
      for (const row of participantRows ?? []) {
        const tid = row.tournament_id as string | null;
        const pid = row.participant_id as string | null;
        if (!tid || !pid) continue;
        if (!uniqueByTournament.has(tid)) {
          uniqueByTournament.set(tid, new Set<string>());
        }
        uniqueByTournament.get(tid)!.add(pid);
      }

      for (const [tid, participantIds] of uniqueByTournament.entries()) {
        participantCountByTournament[tid] = participantIds.size;
      }
    }

    const withParticipantCount = (list: TournamentRow[]) =>
      list.map((t) => ({
        ...t,
        participant_count: participantCountByTournament[t.id] ?? 0,
      }));

    return NextResponse.json({
      success: true,
      data: {
        profile: profileRes.data ?? null,
        stats: {
          balance: statsRes.data?.balance ?? 0,
        },
        my_tournaments: withParticipantCount(myTournaments),
        available_tournaments: withParticipantCount(availableTournaments),
      },
    });
  } catch (error) {
    console.error('organiser home API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
