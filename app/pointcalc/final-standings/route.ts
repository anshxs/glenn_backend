import { NextRequest, NextResponse } from "next/server";

import {
  createPointCalcAnonClient,
  createPointCalcUserClient,
} from "@/lib/pointcalc-supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FinalStandingsBody = {
  tournamentId?: string;
  tournamentName?: string;
  matchLabel?: string;
  matchCount?: number;
  messageText?: string;
  standings?: Array<Record<string, unknown>>;
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized", message: "Missing bearer token." },
        { status: 401 },
      );
    }

    const accessToken = authHeader.slice(7);
    const authClient = createPointCalcAnonClient();
    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(accessToken);

    if (userError || !user) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message: userError?.message ?? "Invalid session.",
        },
        { status: 401 },
      );
    }

    const limit = Math.min(
      Number(request.nextUrl.searchParams.get("limit") || "10"),
      50,
    );
    const offset = Math.max(
      Number(request.nextUrl.searchParams.get("offset") || "0"),
      0,
    );

    const client = createPointCalcUserClient(accessToken);
    const { data, error } = await client
      .from("pointcalc_final_standings")
      .select(
        "id, tournament_name, match_label, match_count, message_text, standings, created_at",
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return NextResponse.json(
        {
          error: "Load failed",
          message: error.message || "Unable to load history.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ items: data ?? [] });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Load failed",
        message:
          error instanceof Error ? error.message : "Unable to load history.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized", message: "Missing bearer token." },
        { status: 401 },
      );
    }

    const accessToken = authHeader.slice(7);
    const authClient = createPointCalcAnonClient();
    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(accessToken);

    if (userError || !user) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message: userError?.message ?? "Invalid session.",
        },
        { status: 401 },
      );
    }

    const body = (await request.json()) as FinalStandingsBody;
    const tournamentId = body.tournamentId?.trim();
    const tournamentName = body.tournamentName?.trim();
    const matchLabel = body.matchLabel?.trim();

    if (!tournamentId || !tournamentName || !matchLabel) {
      return NextResponse.json(
        {
          error: "Bad request",
          message: "Tournament id, tournament name, and match label are required.",
        },
        { status: 400 },
      );
    }

    const client = createPointCalcUserClient(accessToken);
    const { error } = await client.from("pointcalc_final_standings").upsert(
      {
        user_id: user.id,
        tournament_local_id: tournamentId,
        tournament_name: tournamentName,
        match_label: matchLabel,
        match_count: body.matchCount ?? 0,
        message_text: body.messageText ?? "",
        standings: body.standings ?? [],
      },
      {
        onConflict: "user_id,tournament_local_id,match_label",
      },
    );

    if (error) {
      return NextResponse.json(
        {
          error: "Save failed",
          message: error.message || "Unable to save final standings.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ saved: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Save failed",
        message:
          error instanceof Error
            ? error.message
            : "Unable to save final standings.",
      },
      { status: 500 },
    );
  }
}
