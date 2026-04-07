import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_RADIUS_KM = 50;
const DEFAULT_LIMIT = 200;
const SUGGESTED_USERS_LIMIT = 10;

function getBoundingDelta(radiusKm: number): number {
  if (radiusKm <= 2) return 0.018;
  if (radiusKm <= 10) return 0.09;
  if (radiusKm <= 50) return 0.45;
  return 0.9;
}

export async function GET(request: NextRequest) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          message: 'Invalid or missing authentication token',
        },
        { status: 401 },
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const requestedLat = Number(searchParams.get('lat'));
    const requestedLng = Number(searchParams.get('lng'));
    const requestedRadiusKm = Number(searchParams.get('radius_km'));
    const requestedLimit = Number(searchParams.get('limit'));

    const hasRequestedCoordinates =
      Number.isFinite(requestedLat) && Number.isFinite(requestedLng);
    const effectiveRadiusKm =
      Number.isFinite(requestedRadiusKm) && requestedRadiusKm > 0
        ? Math.min(Math.round(requestedRadiusKm), 100)
        : DEFAULT_RADIUS_KM;
    const effectiveLimit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.round(requestedLimit), 500)
        : DEFAULT_LIMIT;

    const [currentUserRes, suggestedUsersRes] = await Promise.all([
      supabaseAdmin
        .from('public_userdata')
        .select('avatarurl, location_lat, location_lng')
        .eq('id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('sensitive_userdata')
        .select('id, username, name, avatarurl, is_bluetick, is_redtick, rank')
        .limit(SUGGESTED_USERS_LIMIT),
    ]);

    if (currentUserRes.error) {
      return NextResponse.json(
        {
          error: 'Failed to fetch explore preview user data',
          details: currentUserRes.error.message,
        },
        { status: 500 },
      );
    }

    if (suggestedUsersRes.error) {
      return NextResponse.json(
        {
          error: 'Failed to fetch explore suggestions',
          details: suggestedUsersRes.error.message,
        },
        { status: 500 },
      );
    }

    const currentUser = (currentUserRes.data ?? null) as
      | Record<string, unknown>
      | null;
    const storedLat = (currentUser?.['location_lat'] as number | null) ?? null;
    const storedLng = (currentUser?.['location_lng'] as number | null) ?? null;
    const previewLat = hasRequestedCoordinates ? requestedLat : storedLat;
    const previewLng = hasRequestedCoordinates ? requestedLng : storedLng;

    let nearbyUsers: Record<string, unknown>[] = [];

    if (previewLat !== null && previewLng !== null) {
      const delta = getBoundingDelta(effectiveRadiusKm);

      const { data: nearbyRes, error: nearbyError } = await supabaseAdmin
        .from('public_userdata')
        .select(
          'id, username, avatarurl, location_lat, location_lng, location_updated_at',
        )
        .gte('location_lat', previewLat - delta)
        .lte('location_lat', previewLat + delta)
        .gte('location_lng', previewLng - delta)
        .lte('location_lng', previewLng + delta)
        .not('location_lat', 'is', null)
        .not('location_lng', 'is', null)
        .neq('id', user.id)
        .limit(effectiveLimit);

      if (nearbyError) {
        return NextResponse.json(
          {
            error: 'Failed to fetch nearby users preview',
            details: nearbyError.message,
          },
          { status: 500 },
        );
      }

      nearbyUsers = (nearbyRes ?? []) as Record<string, unknown>[];
    }

    return NextResponse.json({
      success: true,
      data: {
        current_user: currentUser,
        suggested_users: suggestedUsersRes.data ?? [],
        nearby_users: nearbyUsers,
        preview_radius_km: effectiveRadiusKm,
      },
    });
  } catch (error) {
    console.error('glenn explore API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
