import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SEARCH_LIMIT = 50;

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

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.trim() ?? '';

    if (query.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          query: '',
          users: [],
        },
      });
    }

    const queryLower = query.toLowerCase();

    const searchRes = await supabaseAdmin
      .from('sensitive_userdata')
      .select(
        'id, username, name, avatarurl, bio, email, is_bluetick, is_redtick, rank',
      )
      .or(
        `username.ilike.%${query}%,name.ilike.%${query}%,email.ilike.%${query}%,bio.ilike.%${query}%`,
      )
      .limit(SEARCH_LIMIT);

    let users = (searchRes.data ?? []) as Record<string, unknown>[];

    if (searchRes.error) {
      const fallbackRes = await supabaseAdmin
        .from('public_userdata')
        .select('id, username, name, avatarurl, bio, rank')
        .or(
          `username.ilike.%${query}%,name.ilike.%${query}%,bio.ilike.%${query}%`,
        )
        .limit(SEARCH_LIMIT);

      if (fallbackRes.error) {
        return NextResponse.json(
          {
            error: 'Failed to search users',
            details: fallbackRes.error.message,
          },
          { status: 500 },
        );
      }

      users = (fallbackRes.data ?? []) as Record<string, unknown>[];
    }

    users.sort((a, b) => {
      const getPriority = (userRow: Record<string, unknown>) => {
        const name = String(userRow['name'] ?? '').toLowerCase();
        const username = String(userRow['username'] ?? '').toLowerCase();
        const email = String(userRow['email'] ?? '').toLowerCase();
        const bio = String(userRow['bio'] ?? '').toLowerCase();

        if (name.includes(queryLower)) return 1;
        if (username.includes(queryLower)) return 2;
        if (email.includes(queryLower)) return 3;
        if (bio.includes(queryLower)) return 4;
        return 5;
      };

      return getPriority(a) - getPriority(b);
    });

    return NextResponse.json({
      success: true,
      data: {
        query,
        users: users.slice(0, 10),
      },
    });
  } catch (error) {
    console.error('glenn explore search API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
