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

type TeamResultInput = {
  slot_number: number;
  team_name?: string | null;
  rank: number;
  points: number;
  kills: number;
  participants: Array<{
    participant_id: string;
    rank?: number;
    points?: number;
    kills?: number;
  }>;
};

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeResults(input: unknown): TeamResultInput[] {
  if (!Array.isArray(input)) {
    throw new Error('results must be an array');
  }

  const teams: TeamResultInput[] = [];

  for (const rawTeam of input) {
    if (!rawTeam || typeof rawTeam !== 'object') {
      throw new Error('Each team result must be an object');
    }

    const team = rawTeam as Record<string, unknown>;
    const participantsRaw = team.participants;

    if (!Array.isArray(participantsRaw) || participantsRaw.length === 0) {
      throw new Error('Each team result must include at least one participant');
    }

    const participants = participantsRaw.map((p) => {
      if (!p || typeof p !== 'object') {
        throw new Error('Invalid participant result object');
      }

      const participant = p as Record<string, unknown>;
      const participantId = String(participant.participant_id ?? '').trim();
      if (!participantId) {
        throw new Error('participant_id is required for each participant result');
      }

      return {
        participant_id: participantId,
        rank: toNumber(participant.rank, 0),
        points: toNumber(participant.points, 0),
        kills: toNumber(participant.kills, 0),
      };
    });

    teams.push({
      slot_number: toNumber(team.slot_number, 0),
      team_name: team.team_name ? String(team.team_name) : null,
      rank: toNumber(team.rank, 0),
      points: toNumber(team.points, 0),
      kills: toNumber(team.kills, 0),
      participants,
    });
  }

  return teams;
}

export async function GET(request: NextRequest, context: RouteContext) {
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

    const { tournamentId } = await context.params;

    const { data: tournament, error: tournamentErr } = await supabaseAdmin
      .from('tournaments')
      .select('id, tournament_name, type, organiser_id, results_submitted')
      .eq('id', tournamentId)
      .maybeSingle();

    if (tournamentErr || !tournament) {
      return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }

    if (tournament.organiser_id !== user.id) {
      return NextResponse.json({ error: 'Only host can access tournament results editor' }, { status: 403 });
    }

    const { data: participantRows, error: participantErr } = await supabaseAdmin
      .from('tournament_participants')
      .select('participant_id, team_name, slot_number')
      .eq('tournament_id', tournamentId)
      .order('slot_number', { ascending: true });

    if (participantErr) {
      return NextResponse.json(
        { error: 'Failed to fetch participants', details: participantErr.message },
        { status: 500 }
      );
    }

    const participantIds = Array.from(
      new Set((participantRows ?? []).map((p) => p.participant_id).filter(Boolean))
    );

    let userMap = new Map<string, { name: string | null; ffname: string | null; ffuid: string | null }>();
    if (participantIds.length > 0) {
      const { data: users, error: usersErr } = await supabaseAdmin
        .from('sensitive_userdata')
        .select('id, name, ffname, ffuid')
        .in('id', participantIds);

      if (usersErr) {
        return NextResponse.json(
          { error: 'Failed to fetch participant profiles', details: usersErr.message },
          { status: 500 }
        );
      }

      userMap = new Map(
        (users ?? []).map((u) => [
          u.id as string,
          { name: u.name ?? null, ffname: u.ffname ?? null, ffuid: u.ffuid ?? null },
        ])
      );
    }

    const bySlot = new Map<
      number,
      {
        slot_number: number;
        team_name: string | null;
        participants: Array<{
          participant_id: string;
          name: string | null;
          ffname: string | null;
          ffuid: string | null;
        }>;
      }
    >();

    for (const row of participantRows ?? []) {
      const slot = Number(row.slot_number ?? 0);
      const pid = String(row.participant_id ?? '');
      if (!pid) continue;

      if (!bySlot.has(slot)) {
        bySlot.set(slot, {
          slot_number: slot,
          team_name: row.team_name ?? null,
          participants: [],
        });
      }

      const existing = bySlot.get(slot)!;
      if (existing.participants.some((p) => p.participant_id === pid)) {
        continue;
      }

      const profile = userMap.get(pid);
      existing.participants.push({
        participant_id: pid,
        name: profile?.name ?? null,
        ffname: profile?.ffname ?? null,
        ffuid: profile?.ffuid ?? null,
      });
    }

    const teams = Array.from(bySlot.values());

    const { data: existingResult, error: resultErr } = await supabaseAdmin
      .from('tournament_results')
      .select('id, host_id, host_remarks, results, created_at, updated_at')
      .eq('tournament_id', tournamentId)
      .maybeSingle();

    if (resultErr) {
      return NextResponse.json(
        { error: 'Failed to fetch existing results', details: resultErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        tournament,
        teams,
        existing_result: existingResult ?? null,
      },
    });
  } catch (error) {
    console.error('organiser tournament results GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    let rawBody = '';
    let body: {
      host_remarks?: string;
      results?: unknown;
    } = {};
    try {
      const parsed = await readOrganiserJsonBody<{
        host_remarks?: string;
        results?: unknown;
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

    const { data: tournament, error: tournamentErr } = await supabaseAdmin
      .from('tournaments')
      .select('id, tournament_name, organiser_id')
      .eq('id', tournamentId)
      .maybeSingle();

    if (tournamentErr || !tournament) {
      return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }

    if (tournament.organiser_id !== user.id) {
      return NextResponse.json({ error: 'Only host can submit tournament results' }, { status: 403 });
    }

    const hostRemarks = body.host_remarks?.trim() || null;
    let results: TeamResultInput[];

    try {
      results = sanitizeResults(body.results);
    } catch (validationError) {
      return NextResponse.json(
        { error: 'Invalid results payload', message: (validationError as Error).message },
        { status: 400 }
      );
    }

    const { data: rosterRows, error: rosterErr } = await supabaseAdmin
      .from('tournament_participants')
      .select('participant_id')
      .eq('tournament_id', tournamentId);

    if (rosterErr) {
      return NextResponse.json(
        { error: 'Failed to validate participants', details: rosterErr.message },
        { status: 500 }
      );
    }

    const rosterParticipantIds = new Set(
      (rosterRows ?? []).map((r) => String(r.participant_id ?? '')).filter(Boolean)
    );

    for (const team of results) {
      for (const participant of team.participants) {
        if (!rosterParticipantIds.has(participant.participant_id)) {
          return NextResponse.json(
            {
              error: 'Invalid participant in results',
              message: `Participant ${participant.participant_id} is not registered for this tournament`,
            },
            { status: 400 }
          );
        }
      }
    }

    const finalResults = {
      teams: results,
      submitted_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabaseAdmin
      .from('tournament_results')
      .upsert(
        {
          tournament_id: tournamentId,
          host_id: user.id,
          host_remarks: hostRemarks,
          results: finalResults,
        },
        { onConflict: 'tournament_id' }
      );

    if (upsertErr) {
      return NextResponse.json(
        { error: 'Failed to save tournament results', details: upsertErr.message },
        { status: 500 }
      );
    }

    const { error: updateTournamentErr } = await supabaseAdmin
      .from('tournaments')
      .update({ results_submitted: true })
      .eq('id', tournamentId)
      .eq('organiser_id', user.id);

    if (updateTournamentErr) {
      return NextResponse.json(
        {
          error: 'Failed to mark tournament result submission status',
          details: updateTournamentErr.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Tournament results submitted successfully',
      data: {
        tournament_id: tournamentId,
        results_submitted: true,
      },
    });
  } catch (error) {
    console.error('organiser tournament results POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
