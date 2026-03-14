import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { verifyBearerToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const user = await verifyBearerToken(authHeader);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const { data: organiser, error: organiserError } = await supabaseAdmin
      .from('organisers')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (organiserError) {
      return NextResponse.json(
        { error: 'Failed to check organiser profile', details: organiserError.message },
        { status: 500 }
      );
    }

    const { data: requests, error: requestError } = await supabaseAdmin
      .from('organiser_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (requestError) {
      return NextResponse.json(
        { error: 'Failed to fetch organiser requests', details: requestError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        user_id: user.id,
        is_organiser: !!organiser,
        organiser,
        latest_request: requests?.[0] ?? null,
        requests: requests ?? [],
      },
    });
  } catch (error) {
    console.error('organiser me API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
