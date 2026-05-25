import { NextRequest, NextResponse } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type UserDataUpdateBody = Record<string, unknown>;

const ALLOWED_FIELDS = new Set([
  'name',
  'ffuid',
  'ffname',
  'ff_creation_date',
  'ff_level',
  'yturl',
  'instaurl',
  'bio',
  'avatarurl',
  'otherurls',
  'squad',
  'sc_character',
  'sc_weapon',
  'sc_weapon2',
  'show_tournaments',
  'isonline',
  'lastseen',
  'location_lat',
  'location_lng',
  'location_updated_at',
]);

const TEXT_FIELDS = new Set([
  'name',
  'ffuid',
  'ffname',
  'ff_creation_date',
  'yturl',
  'instaurl',
  'bio',
  'avatarurl',
  'sc_character',
  'sc_weapon',
  'sc_weapon2',
]);

function cleanText(value: unknown, maxLength = 500): string | null {
  if (value == null) return null;
  const text = value.toString().trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function cleanNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function cleanTimestamp(value: unknown): string | null {
  if (value == null) return null;
  const date = new Date(value.toString());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeUpdate(input: UserDataUpdateBody) {
  const update: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`Unsupported user field: ${key}`);
    }

    if (TEXT_FIELDS.has(key)) {
      update[key] = cleanText(value, key === 'bio' ? 280 : 500);
      continue;
    }

    if (key === 'ff_level') {
      const level = cleanNumber(value);
      update[key] = level == null ? null : Math.trunc(level);
      continue;
    }

    if (key === 'show_tournaments' || key === 'isonline') {
      const bool = cleanBoolean(value);
      if (bool == null) throw new Error(`Invalid boolean for ${key}`);
      update[key] = bool;
      continue;
    }

    if (key === 'location_lat' || key === 'location_lng') {
      const number = cleanNumber(value);
      if (number == null) throw new Error(`Invalid number for ${key}`);
      update[key] = number;
      continue;
    }

    if (key === 'lastseen' || key === 'location_updated_at') {
      const timestamp = cleanTimestamp(value);
      if (timestamp == null) throw new Error(`Invalid timestamp for ${key}`);
      update[key] = timestamp;
      continue;
    }

    if (key === 'otherurls' || key === 'squad') {
      update[key] = value ?? null;
    }
  }

  return update;
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<UserDataUpdateBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    const update = sanitizeUpdate(parsed.data ?? {});
    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'No user fields to update.' },
        { status: 400 },
      );
    }

    update.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('sensitive_userdata')
      .update(update)
      .eq('id', auth.user.id)
      .select()
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json(
        {
          error: 'Update failed',
          message: error?.message ?? 'Unable to update profile.',
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data,
      userId: auth.user.id,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Update failed',
        message:
          error instanceof Error ? error.message : 'Unable to update profile.',
      },
      { status: 400 },
    );
  }
}
