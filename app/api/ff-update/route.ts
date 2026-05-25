import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type FFUpdateRequest = {
  user_id?: unknown;
  ffuid?: unknown;
  ff_name?: unknown;
  ff_creation_date?: unknown;
  level?: unknown;
};

function cleanText(value: unknown, maxLength = 500): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function cleanLevel(value: unknown): number | null {
  if (value == null) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.trunc(number));
}

export async function POST(request: NextRequest) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        {
          success: false,
          error: 'Unauthorized',
          message: 'Invalid or missing authentication token.',
        },
        { status: 401 },
      );
    }

    const body = (await request.json()) as FFUpdateRequest;
    const requestedUserId = cleanText(body.user_id);
    const ffuid = cleanText(body.ffuid, 32);
    const ffName = cleanText(body.ff_name, 120);
    const ffCreationDate = cleanText(body.ff_creation_date, 64);
    const ffLevel = cleanLevel(body.level);

    if (requestedUserId && requestedUserId !== user.id) {
      return NextResponse.json(
        {
          success: false,
          error: 'Forbidden',
          message: 'You can only update your own FF data.',
        },
        { status: 403 },
      );
    }

    if (!ffuid || !ffName || !ffCreationDate) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          message: 'Missing required fields: ffuid, ff_name, ff_creation_date.',
        },
        { status: 400 },
      );
    }

    if (!/^\d+$/.test(ffuid)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          message: 'Invalid FFUID format. Must be numeric.',
        },
        { status: 400 },
      );
    }

    const { data: existingUser, error: userCheckError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('id, ffuid')
      .eq('id', user.id)
      .maybeSingle();

    if (userCheckError) throw userCheckError;
    if (!existingUser) {
      return NextResponse.json(
        {
          success: false,
          error: 'User not found',
          message: 'User does not exist in database.',
        },
        { status: 404 },
      );
    }

    const { data: uidConflict, error: uidConflictError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('id')
      .eq('ffuid', ffuid)
      .neq('id', user.id)
      .maybeSingle();

    if (uidConflictError) throw uidConflictError;
    if (uidConflict) {
      return NextResponse.json(
        {
          success: false,
          error: 'Conflict',
          message: 'This FFUID is already registered to another user.',
        },
        { status: 409 },
      );
    }

    const update: Record<string, unknown> = {
      ffuid,
      ffname: ffName,
      ff_creation_date: ffCreationDate,
      updated_at: new Date().toISOString(),
    };

    if (ffLevel != null) {
      update.ff_level = ffLevel;
    }

    const { error: updateError } = await supabaseAdmin
      .from('sensitive_userdata')
      .update(update)
      .eq('id', user.id);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      message: 'FF data updated successfully',
      data: {
        user_id: user.id,
        ffuid,
        ff_name: ffName,
        ff_creation_date: ffCreationDate,
        ...(ffLevel != null ? { level: ffLevel } : {}),
      },
    });
  } catch (error) {
    console.error('FF update API error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        message:
          error instanceof Error
            ? error.message
            : 'An unexpected error occurred.',
      },
      { status: 500 },
    );
  }
}
