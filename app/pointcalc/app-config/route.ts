import { NextRequest, NextResponse } from "next/server";

import {
  createPointCalcAnonClient,
  createPointCalcUserClient,
} from "@/lib/pointcalc-supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

    const client = createPointCalcUserClient(accessToken);
    const { data, error } = await client
      .from("pointcalc_app_config")
      .select(
        "id, config_version, min_supported_app_version, latest_app_version, active_theme_name, release_notes, themes_json, updated_at",
      )
      .eq("id", "default")
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        {
          error: "Load failed",
          message: error.message || "Unable to load app config.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      item: data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Load failed",
        message:
          error instanceof Error ? error.message : "Unable to load app config.",
      },
      { status: 500 },
    );
  }
}
