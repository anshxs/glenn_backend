import { NextRequest, NextResponse } from "next/server";

import {
  createPointCalcAnonClient,
  ensurePointCalcUserData,
  getPointCalcUserData,
  getPointCalcWhatsappUrl,
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
    const supabase = createPointCalcAnonClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(accessToken);

    if (error || !user) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message: error?.message ?? "Invalid session.",
        },
        { status: 401 },
      );
    }

    await ensurePointCalcUserData(accessToken, user);
    const profile = await getPointCalcUserData(accessToken, user.id);

    return NextResponse.json({
      authenticated: true,
      blocked: !(profile?.has_access ?? false),
      whatsappUrl: getPointCalcWhatsappUrl(),
      user: {
        id: user.id,
        email: user.email,
      },
      profile,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Profile load failed",
        message:
          error instanceof Error ? error.message : "Unable to load profile.",
      },
      { status: 500 },
    );
  }
}
