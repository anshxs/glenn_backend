import { NextRequest, NextResponse } from "next/server";

import {
  createPointCalcAnonClient,
  getPointCalcUserData,
  getPointCalcWhatsappUrl,
} from "@/lib/pointcalc-supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LoginBody = {
  email?: string;
  password?: string;
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as LoginBody;
    const email = body.email?.trim().toLowerCase();
    const password = body.password?.trim();

    if (!email || !password) {
      return NextResponse.json(
        {
          error: "Missing credentials",
          message: "Email and password are required.",
        },
        { status: 400 },
      );
    }

    const supabase = createPointCalcAnonClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session || !data.user) {
      return NextResponse.json(
        {
          error: "Invalid credentials",
          message: error?.message ?? "Unable to sign in.",
        },
        { status: 401 },
      );
    }

    const profile = await getPointCalcUserData(
      data.session.access_token,
      data.user.id,
    );

    return NextResponse.json({
      authenticated: true,
      blocked: !(profile?.has_access ?? false),
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
      profile,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Login failed",
        message: error instanceof Error ? error.message : "Unable to sign in.",
      },
      { status: 500 },
    );
  }
}
