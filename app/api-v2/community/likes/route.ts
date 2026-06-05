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

type CommunityLikeBody = {
  action?: unknown;
  message_id?: unknown;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getLikesCount(messageId: string) {
  const { count, error } = await supabaseAdmin
    .from('community_likes')
    .select('id', { count: 'exact', head: true })
    .eq('message_id', messageId);

  if (error) throw error;
  return count ?? 0;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<CommunityLikeBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    const messageId =
      typeof parsed.data?.message_id === 'string'
        ? parsed.data.message_id
        : null;
    const action = parsed.data?.action === 'unlike' ? 'unlike' : 'like';

    if (!messageId || !UUID_REGEX.test(messageId)) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Valid message_id is required.' },
        { status: 400 },
      );
    }

    const { data: post, error: postError } = await supabaseAdmin
      .from('community_messages')
      .select('id')
      .eq('id', messageId)
      .maybeSingle();

    if (postError) throw postError;
    if (!post) {
      return NextResponse.json(
        { error: 'Post not found', message: 'Community post does not exist.' },
        { status: 404 },
      );
    }

    if (action === 'unlike') {
      const { error } = await supabaseAdmin
        .from('community_likes')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', auth.user.id);

      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from('community_likes')
        .upsert(
          {
            message_id: messageId,
            user_id: auth.user.id,
          },
          { onConflict: 'message_id,user_id' },
        );

      if (error) throw error;
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data: {
        message_id: messageId,
        is_liked: action === 'like',
        likes_count: await getLikesCount(messageId),
      },
      userId: auth.user.id,
    });
  } catch (error) {
    console.error('Community like API v2 error:', error);
    return NextResponse.json(
      {
        error: 'Community like failed',
        message:
          error instanceof Error ? error.message : 'Unable to update like.',
      },
      { status: 500 },
    );
  }
}
