import { NextRequest, NextResponse } from "next/server";

import { createPointCalcAnonClient } from "@/lib/pointcalc-supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}

export async function GET(request: NextRequest) {
  try {
    void request;
    const client = createPointCalcAnonClient();
    const { data, error } = await client
      .from("pointcalc_app_config")
      .select(
        "id, config_version, min_supported_app_version, latest_app_version, download_url, release_notes, updated_at",
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
