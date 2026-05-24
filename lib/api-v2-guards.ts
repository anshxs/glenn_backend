import { NextRequest, NextResponse } from 'next/server';

import { AuthenticatedUser, verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

type AuthGuardResult =
  | { user: AuthenticatedUser; response?: never }
  | { user?: never; response: NextResponse };

export async function requireApiV2Auth(
  request: NextRequest,
): Promise<AuthGuardResult> {
  const user = await verifyBearerToken(request.headers.get('Authorization'));
  if (!user) {
    return {
      response: NextResponse.json(
        {
          error: 'Unauthorized',
          message: 'Invalid or missing authentication token.',
        },
        { status: 401 },
      ),
    };
  }

  return { user };
}

export async function blockApiV2IfMaintenance(): Promise<NextResponse | null> {
  const { data, error } = await supabaseAdmin
    .from('app_config')
    .select('maintenance_mode, maintenance_message')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    console.error('API v2 maintenance check failed:', error);
    return NextResponse.json(
      {
        error: 'Server configuration unavailable',
        message: 'Unable to verify Glenn maintenance status.',
      },
      { status: 503 },
    );
  }

  if (data?.maintenance_mode === true) {
    return NextResponse.json(
      {
        error: 'MAINTENANCE_MODE',
        message:
          data.maintenance_message ||
          'Glenn is under maintenance right now. Please try again later.',
      },
      { status: 503 },
    );
  }

  return null;
}
