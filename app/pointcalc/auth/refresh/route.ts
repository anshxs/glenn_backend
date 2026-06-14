import { NextRequest, NextResponse } from "next/server";

import {
  createPointCalcAnonClient,
  getPointCalcWhatsappUrl,
} from "@/lib/pointcalc-supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RefreshBody = {
  refreshToken?: string;
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RefreshBody;
    const refreshToken = body.refreshToken?.trim();

    if (!refreshToken) {
      return NextResponse.json(
        {
          error: "Missing refresh token",
          message: "Refresh token is required.",
        },
        { status: 400 },
      );
    }

    const supabase = createPointCalcAnonClient();
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session || !data.user) {
      return NextResponse.json(
        {
          error: "Refresh failed",
          message: error?.message ?? "Unable to refresh session.",
        },
        { status: 401 },
      );
    }

    return NextResponse.json({
      authenticated: true,
      whatsappUrl: getPointCalcWhatsappUrl(),
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
      },
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Refresh failed",
        message:
          error instanceof Error ? error.message : "Unable to refresh session.",
      },
      { status: 500 },
    );
  }
}
