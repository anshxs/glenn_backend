import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!verifyAdminPin(body?.pin)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid PIN' },
        { status: 401 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'PIN verification failed' },
      { status: 500 }
    );
  }
}
