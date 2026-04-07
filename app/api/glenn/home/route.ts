import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TEXT_ANNOUNCEMENT_COLUMNS = 'id, message, onclick, created_at';
const IMAGE_ANNOUNCEMENT_COLUMNS =
  'id, message, image_url, onclick, created_at';

type TournamentParticipantRow = {
  tournament_id: string | null;
  participant_id: string | null;
  team_members: Record<string, unknown> | null;
};

export async function GET(request: NextRequest) {
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

    const [
      walletRes,
      unreadNotificationsRes,
      textAnnouncementsRes,
      imageAnnouncementsRes,
      tournamentsRes,
    ] = await Promise.all([
      supabaseAdmin
        .from('wallets')
        .select('balance')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('user_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_read', false),
      supabaseAdmin
        .from('announcements')
        .select(TEXT_ANNOUNCEMENT_COLUMNS)
        .eq('display', true)
        .order('created_at', { ascending: false })
        .limit(10),
      supabaseAdmin
        .from('announcements_with_image')
        .select(IMAGE_ANNOUNCEMENT_COLUMNS)
        .eq('display', true)
        .order('created_at', { ascending: false })
        .limit(10),
      supabaseAdmin
        .from('tournaments')
        .select('*')
        .eq('results_submitted', false)
        .order('tournament_datetime', { ascending: true }),
    ]);

    if (walletRes.error) {
      return NextResponse.json(
        {
          error: 'Failed to fetch wallet balance',
          details: walletRes.error.message,
        },
        { status: 500 },
      );
    }

    if (unreadNotificationsRes.error) {
      return NextResponse.json(
        {
          error: 'Failed to fetch unread notifications count',
          details: unreadNotificationsRes.error.message,
        },
        { status: 500 },
      );
    }

    if (textAnnouncementsRes.error) {
      return NextResponse.json(
        {
          error: 'Failed to fetch announcements',
          details: textAnnouncementsRes.error.message,
        },
        { status: 500 },
      );
    }

    if (imageAnnouncementsRes.error) {
      return NextResponse.json(
        {
          error: 'Failed to fetch image announcements',
          details: imageAnnouncementsRes.error.message,
        },
        { status: 500 },
      );
    }

    if (tournamentsRes.error) {
      return NextResponse.json(
        {
          error: 'Failed to fetch tournaments',
          details: tournamentsRes.error.message,
        },
        { status: 500 },
      );
    }

    const tournaments = tournamentsRes.data ?? [];
    const tournamentIds = tournaments
      .map((tournament) => tournament.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    let participatedTournamentIds: string[] = [];

    if (tournamentIds.length > 0) {
      const { data: participantRows, error: participantsError } =
        await supabaseAdmin
          .from('tournament_participants')
          .select('tournament_id, participant_id, team_members')
          .in('tournament_id', tournamentIds);

      if (participantsError) {
        return NextResponse.json(
          {
            error: 'Failed to fetch tournament participation',
            details: participantsError.message,
          },
          { status: 500 },
        );
      }

      const participatedIds = new Set<string>();

      for (const participant of (participantRows ??
        []) as TournamentParticipantRow[]) {
        const tournamentId = participant.tournament_id;
        if (!tournamentId) continue;

        if (participant.participant_id === user.id) {
          participatedIds.add(tournamentId);
          continue;
        }

        const teamMembers = participant.team_members;
        if (
          teamMembers &&
          typeof teamMembers === 'object' &&
          user.id in teamMembers
        ) {
          participatedIds.add(tournamentId);
        }
      }

      participatedTournamentIds = Array.from(participatedIds);
    }

    return NextResponse.json({
      success: true,
      data: {
        balance: walletRes.data?.balance ?? 0,
        unread_notifications_count: unreadNotificationsRes.count ?? 0,
        announcements: textAnnouncementsRes.data ?? [],
        image_announcements: imageAnnouncementsRes.data ?? [],
        tournaments,
        participated_tournament_ids: participatedTournamentIds,
      },
    });
  } catch (error) {
    console.error('glenn home API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
