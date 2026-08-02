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

type GameProfileInput = {
  game_id: string;
  player_uid: string;
  player_name: string;
};

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
  'team_roles',
  'team_instagram_url',
  'team_youtube_url',
  'team_description',
  'team_builder_enabled',
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
  'team_instagram_url',
  'team_youtube_url',
  'team_description',
]);

function cleanText(value: unknown, maxLength = 500): string | null {
  if (value == null) return null;
  const text = value.toString().trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function cleanSocialUsername(value: unknown): string | null {
  const text = cleanText(value, 120);
  if (!text) return null;
  const username = text
    .replace(/^https?:\/\/(www\.)?/i, '')
    .replace(/^(instagram\.com\/|youtube\.com\/@?)/i, '')
    .replace(/^@/, '')
    .split('?')[0]
    .split('/')[0]
    .trim();
  return username || null;
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

function cleanGameProfiles(value: unknown): GameProfileInput[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('Select at least one valid game.');
  }

  const profiles = value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Invalid game profile.');
    }
    const profile = entry as Record<string, unknown>;
    const gameId = cleanText(profile.game_id, 36);
    const playerUid = cleanText(profile.player_uid, 80);
    const playerName = cleanText(profile.player_name, 80);
    if (!gameId || !playerUid || !playerName) {
      throw new Error('Every selected game needs a player UID and name.');
    }
    return {
      game_id: gameId,
      player_uid: playerUid,
      player_name: playerName,
    };
  });

  if (new Set(profiles.map((profile) => profile.game_id)).size !== profiles.length) {
    throw new Error('A game can only be selected once.');
  }
  return profiles;
}

function sanitizeUpdate(input: UserDataUpdateBody) {
  const update: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`Unsupported user field: ${key}`);
    }

    if (key === 'team_instagram_url' || key === 'team_youtube_url') {
      update[key] = cleanSocialUsername(value);
      continue;
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

    if (key === 'show_tournaments' || key === 'isonline' || key === 'team_builder_enabled') {
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

    if (key === 'team_roles') {
      if (!Array.isArray(value)) throw new Error('Invalid roles');
      update[key] = value
        .map((role) => cleanText(role, 40))
        .filter((role): role is string => Boolean(role));
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

    const input = { ...(parsed.data ?? {}) };
    const gameProfiles = cleanGameProfiles(input.game_profiles);
    const primaryGameId = cleanText(input.primary_game_id, 36);
    delete input.game_profiles;
    delete input.primary_game_id;

    if ((gameProfiles == null) !== (primaryGameId == null)) {
      throw new Error('Game profiles and primary game must be submitted together.');
    }

    const update = sanitizeUpdate(input);
    if (Object.keys(update).length === 0 && gameProfiles == null) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'No user fields to update.' },
        { status: 400 },
      );
    }

    let data: Record<string, unknown> | null = null;
    let error: { message: string } | null = null;

    if (Object.keys(update).length > 0) {
      update.updated_at = new Date().toISOString();
      const result = await supabaseAdmin
        .from('sensitive_userdata')
        .update(update)
        .eq('id', auth.user.id)
        .select()
        .maybeSingle();
      data = result.data;
      error = result.error;
    }

    if (!error && gameProfiles != null && primaryGameId != null) {
      const gameResult = await supabaseAdmin.rpc('set_user_game_profiles', {
        p_user_id: auth.user.id,
        p_profiles: gameProfiles,
        p_primary_game_id: primaryGameId,
      });
      error = gameResult.error;
      if (!error) {
        const refreshed = await supabaseAdmin
          .from('sensitive_userdata')
          .select()
          .eq('id', auth.user.id)
          .maybeSingle();
        data = refreshed.data;
        error = refreshed.error;
      }
    }

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
