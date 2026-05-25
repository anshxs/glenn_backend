import { NextRequest, NextResponse } from "next/server";

import { blockApiV2IfMaintenance, requireApiV2Auth } from "@/lib/api-v2-guards";
import { verifyGlennRequestSecurity } from "@/lib/glenn-request-security";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireApiV2Auth(request);
  if (auth.response) return auth.response;

  const securityError = await verifyGlennRequestSecurity(request, {
    bodyText: "",
  });
  if (securityError) {
    return securityError;
  }

  const maintenanceResponse = await blockApiV2IfMaintenance();
  if (maintenanceResponse) {
    return maintenanceResponse;
  }

  const { id: tournamentId } = await params;

  const { data: participantRows, error: participantError } = await supabaseAdmin
    .from("tournament_participants")
    .select("id, participant_id, team_members")
    .eq("tournament_id", tournamentId);

  if (participantError) {
    console.error("Failed to verify tournament participant:", participantError);
    return NextResponse.json(
      {
        error: "Participant verification failed",
        message: "Could not verify tournament access.",
      },
      { status: 500 },
    );
  }

  const isParticipant = (participantRows ?? []).some((row) => {
    if (row.participant_id === auth.user.id) {
      return true;
    }

    const teamMembers =
      row.team_members &&
      typeof row.team_members === "object" &&
      !Array.isArray(row.team_members)
        ? (row.team_members as Record<string, unknown>)
        : null;

    return teamMembers != null && auth.user.id in teamMembers;
  });

  if (!isParticipant) {
    return NextResponse.json(
      {
        error: "Forbidden",
        message: "Only registered participants can view room details.",
      },
      { status: 403 },
    );
  }

  const { data: tournament, error: tournamentError } = await supabaseAdmin
    .from("tournaments")
    .select("id, results_submitted")
    .eq("id", tournamentId)
    .maybeSingle();

  if (tournamentError) {
    console.error("Failed to load tournament metadata:", tournamentError);
    return NextResponse.json(
      {
        error: "Tournament lookup failed",
        message: "Could not load tournament details.",
      },
      { status: 500 },
    );
  }

  if (!tournament) {
    return NextResponse.json(
      {
        error: "Tournament not found",
        message: "The requested tournament does not exist.",
      },
      { status: 404 },
    );
  }

  if (tournament.results_submitted === true) {
    return NextResponse.json({
      roomId: null,
      roomPass: null,
      resultsSubmitted: true,
      available: false,
    });
  }

  const { data: credentials, error: credentialsError } = await supabaseAdmin
    .from("tournament_room_credentials")
    .select("room_id, room_password")
    .eq("tournament_id", tournamentId)
    .maybeSingle();

  if (credentialsError) {
    console.error("Failed to load room credentials:", credentialsError);
    return NextResponse.json(
      {
        error: "Room details unavailable",
        message: "Could not load tournament room details.",
      },
      { status: 500 },
    );
  }

  const roomId = credentials?.room_id?.toString().trim() ?? "";
  const roomPass = credentials?.room_password?.toString().trim() ?? "";
  const available = roomId.length > 0 && roomPass.length > 0;

  return NextResponse.json({
    roomId: available ? roomId : null,
    roomPass: available ? roomPass : null,
    resultsSubmitted: false,
    available,
  });
}
