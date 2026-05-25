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

type FollowBody = {
  action?: unknown;
  followee_id?: unknown;
  target_user_id?: unknown;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sendFollowNotification(
  playerIds: string[],
  followerUsername: string,
  followerAvatarUrl?: string | null,
) {
  const appId = process.env.ONESIGNAL_APP_ID;
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!appId || !restApiKey) {
    console.error('OneSignal credentials not configured');
    return;
  }

  const response = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${restApiKey}`,
    },
    body: JSON.stringify({
      app_id: appId,
      include_player_ids: playerIds,
      headings: { en: 'New Follower! 🎉' },
      contents: { en: `@${followerUsername} started following you` },
      data: {
        type: 'new_follower',
        follower_username: followerUsername,
        screen: 'profile',
        username: followerUsername,
      },
      ...(followerAvatarUrl
        ? {
            big_picture: followerAvatarUrl,
            large_icon: followerAvatarUrl,
            ios_attachments: { image: followerAvatarUrl },
          }
        : {}),
    }),
  });

  const result = await response.json().catch(() => null);
  if (!response.ok || result?.errors) {
    console.error('OneSignal notification failed:', result);
  }
}

async function countFollowers(userId: string) {
  const { count, error } = await supabaseAdmin
    .from('followers')
    .select('id', { count: 'exact', head: true })
    .eq('following_id', userId);

  if (error) throw error;
  return count ?? 0;
}

async function countFollowing(userId: string) {
  const { count, error } = await supabaseAdmin
    .from('followers')
    .select('id', { count: 'exact', head: true })
    .eq('follower_id', userId);

  if (error) throw error;
  return count ?? 0;
}

async function syncFollowCounts(followerId: string, followeeId: string) {
  const [followeeFollowerCount, followerFollowingCount] = await Promise.all([
    countFollowers(followeeId),
    countFollowing(followerId),
  ]);

  const results = await Promise.all([
    supabaseAdmin
      .from('sensitive_userdata')
      .update({ followercount: followeeFollowerCount })
      .eq('id', followeeId),
    supabaseAdmin
      .from('sensitive_userdata')
      .update({ followingcount: followerFollowingCount })
      .eq('id', followerId),
  ]);

  for (const result of results) {
    if (result.error) throw result.error;
  }

  return {
    follower_count: followeeFollowerCount,
    following_count: followerFollowingCount,
  };
}

async function maybeCreateFollowNotification(
  followId: string,
  followerId: string,
  followeeId: string,
  followerUsername: string,
  followerAvatarUrl?: string | null,
) {
  const { data: notificationData, error: notificationInsertError } =
    await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_id: followeeId,
        type: 'new_follower',
        title: 'New Follower! 🎉',
        message: `@${followerUsername} started following you`,
        data: {
          follower_id: followerId,
          follower_username: followerUsername,
          follow_id: followId,
        },
        is_read: false,
        sent: false,
      })
      .select('id')
      .single();

  if (notificationInsertError) {
    console.error('Failed to store notification:', notificationInsertError);
    return;
  }

  const { data: followeeNotifications, error: followeeNotificationsError } =
    await supabaseAdmin
      .from('notifications')
      .select('onesignal_player_id, is_notifications_enabled')
      .eq('user_id', followeeId)
      .maybeSingle();

  if (followeeNotificationsError) {
    console.error(
      'Failed to load followee notification settings:',
      followeeNotificationsError,
    );
    return;
  }

  if (
    !followeeNotifications?.onesignal_player_id ||
    !followeeNotifications?.is_notifications_enabled
  ) {
    return;
  }

  await sendFollowNotification(
    [followeeNotifications.onesignal_player_id],
    followerUsername,
    followerAvatarUrl,
  );

  if (notificationData?.id) {
    await supabaseAdmin
      .from('user_notifications')
      .update({ sent: true })
      .eq('id', notificationData.id);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<FollowBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    const action =
      parsed.data?.action === 'unfollow' ||
      parsed.data?.action === 'remove_follower'
        ? parsed.data.action
        : 'follow';
    const targetUserId =
      typeof parsed.data?.followee_id === 'string'
        ? parsed.data.followee_id
        : typeof parsed.data?.target_user_id === 'string'
          ? parsed.data.target_user_id
          : null;
    const followerId = auth.user.id;

    if (!targetUserId) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'followee_id is required.' },
        { status: 400 },
      );
    }

    if (!UUID_REGEX.test(followerId) || !UUID_REGEX.test(targetUserId)) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Invalid user ID format.' },
        { status: 400 },
      );
    }

    if (followerId === targetUserId) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Users cannot follow themselves.' },
        { status: 400 },
      );
    }

    const { data: followerUser, error: followerError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('id, username, avatarurl')
      .eq('id', followerId)
      .maybeSingle();

    if (followerError) throw followerError;
    if (!followerUser) {
      return NextResponse.json(
        { error: 'User not found', message: 'Follower user does not exist.' },
        { status: 404 },
      );
    }

    const { data: followeeUser, error: followeeError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('id, username')
      .eq('id', targetUserId)
      .maybeSingle();

    if (followeeError) throw followeeError;
    if (!followeeUser) {
      return NextResponse.json(
        { error: 'User not found', message: 'User to follow does not exist.' },
        { status: 404 },
      );
    }

    if (action === 'unfollow' || action === 'remove_follower') {
      const deleteFollowerId =
        action === 'remove_follower' ? targetUserId : followerId;
      const deleteFollowingId =
        action === 'remove_follower' ? followerId : targetUserId;

      const { error } = await supabaseAdmin
        .from('followers')
        .delete()
        .eq('follower_id', deleteFollowerId)
        .eq('following_id', deleteFollowingId);

      if (error) throw error;
      const counts =
        action === 'remove_follower'
          ? await syncFollowCounts(targetUserId, followerId)
          : await syncFollowCounts(followerId, targetUserId);

      return NextResponse.json({
        apiVersion: 'v2',
        authenticated: true,
        data: {
          is_following: false,
          follower_id: deleteFollowerId,
          following_id: deleteFollowingId,
          action,
          ...counts,
        },
        userId: followerId,
      });
    }

    const { data: existingFollow, error: existingError } = await supabaseAdmin
      .from('followers')
      .select('id, created_at')
      .eq('follower_id', followerId)
      .eq('following_id', targetUserId)
      .maybeSingle();

    if (existingError) throw existingError;

    let followData = existingFollow;
    let createdFollow = false;

    if (!followData) {
      const { data, error } = await supabaseAdmin
        .from('followers')
        .insert({
          follower_id: followerId,
          following_id: targetUserId,
        })
        .select('id, created_at')
        .single();

      if (error) throw error;
      followData = data;
      createdFollow = true;
    }

    const counts = await syncFollowCounts(followerId, targetUserId);

    if (createdFollow && followData?.id) {
      maybeCreateFollowNotification(
        followData.id,
        followerId,
        targetUserId,
        followerUser.username,
        followerUser.avatarurl,
      ).catch((error) => {
        console.error(
          'Follow notification failed:',
          error instanceof Error ? error.message : error,
        );
      });
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data: {
        follow_id: followData?.id,
        is_following: true,
        follower_id: followerId,
        following_id: targetUserId,
        following_username: followeeUser.username,
        created_at: followData?.created_at,
        ...counts,
      },
      userId: followerId,
    });
  } catch (error) {
    console.error('Follow API v2 error:', error);
    return NextResponse.json(
      {
        error: 'Follow request failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to update follow status.',
      },
      { status: 500 },
    );
  }
}
