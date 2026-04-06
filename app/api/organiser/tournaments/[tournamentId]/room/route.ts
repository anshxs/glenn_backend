import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import {
  readOrganiserJsonBody,
  verifyOrganiserRequestSecurity,
} from '@/lib/organiser-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ tournamentId: string }>;
};

function parseTeamMembers(value: unknown): Record<string, unknown> {
  if (!value) return {};

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

// ── POST – set room ID & password (only within 10 min before start) ───────────
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    let rawBody = '';
    let body: { room_id?: string; room_pass?: string } = {};
    try {
      const parsed = await readOrganiserJsonBody<{
        room_id?: string;
        room_pass?: string;
      }>(request);
      rawBody = parsed.rawBody;
      body = parsed.data;
    } catch (error) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to parse organiser payload.',
        },
        { status: 400 },
      );
    }

    const securityError = await verifyOrganiserRequestSecurity(request, {
      bodyText: rawBody,
    });
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

    const { tournamentId } = await context.params;

    const roomId = (body.room_id ?? '').trim();
    const roomPass = (body.room_pass ?? '').trim();

    if (!roomId || !roomPass) {
      return NextResponse.json(
        { error: 'room_id and room_pass are required' },
        { status: 400 }
      );
    }

    // 1. Fetch tournament
    const { data: tournament, error: tournamentErr } = await supabaseAdmin
      .from('tournaments')
      .select('id, tournament_name, organiser_id, results_submitted, tournament_datetime')
      .eq('id', tournamentId)
      .maybeSingle();

    if (tournamentErr || !tournament) {
      return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }

    if (tournament.organiser_id !== user.id) {
      return NextResponse.json(
        { error: 'You are not the organiser of this tournament' },
        { status: 403 }
      );
    }

    if (tournament.results_submitted) {
      return NextResponse.json(
        { error: 'Tournament results already submitted' },
        { status: 400 }
      );
    }

    // 2. Enforce 10-minute window: now must be >= (tournament_datetime - 10 min)
    const tournamentTime = new Date(tournament.tournament_datetime).getTime();
    const windowOpen = tournamentTime - 10 * 60 * 1000;
    const now = Date.now();

    if (now < windowOpen) {
      const minutesLeft = Math.ceil((windowOpen - now) / 60000);
      return NextResponse.json(
        {
          error: 'Too early',
          message: `Room details can only be set within 10 minutes of the tournament start. ${minutesLeft} minute(s) remaining.`,
        },
        { status: 400 }
      );
    }

    // 3. Update tournament roomid / roompass
    const { error: updateErr } = await supabaseAdmin
      .from('tournaments')
      .update({ roomid: roomId, roompass: roomPass })
      .eq('id', tournamentId);

    if (updateErr) {
      return NextResponse.json(
        { error: 'Failed to update room details', message: updateErr.message },
        { status: 500 }
      );
    }

    // 4. Fetch all registered participant user IDs
    const { data: participants, error: partErr } = await supabaseAdmin
      .from('tournament_participants')
      .select('participant_id, team_members')
      .eq('tournament_id', tournamentId);

    if (!partErr && participants && participants.length > 0) {
      const notifiedUserIds = new Set<string>();

      for (const participant of participants) {
        const participantId = String(participant.participant_id ?? '').trim();
        if (participantId) {
          notifiedUserIds.add(participantId);
        }

        const teamMembers = parseTeamMembers(participant.team_members);
        for (const memberId of Object.keys(teamMembers)) {
          if (isUuid(memberId)) {
            notifiedUserIds.add(memberId);
          }
        }
      }

      const notifications = Array.from(notifiedUserIds).map((userId) => ({
        user_id: userId,
        type: 'tournament_room_details',
        title: `Room Details — ${tournament.tournament_name}`,
        message: `Room ID: ${roomId} | Password: ${roomPass}`,
        data: {
          screen: 'tournament_detail',
          tournament_id: tournamentId,
          tournament_name: tournament.tournament_name,
          room_id: roomId,
          room_pass: roomPass,
        },
        is_read: false,
        sent: false,
      }));

      if (notifications.length > 0) {
        await supabaseAdmin.from('user_notifications').insert(notifications);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Room details set and notifications queued successfully.`,
      data: { room_id: roomId, room_pass: roomPass },
    });
  } catch (error) {
    console.error('organiser room POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
