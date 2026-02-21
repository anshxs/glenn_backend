import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// Route segment config
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Helper function to verify JWT token
async function verifyToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    
    if (error || !user) {
      return null;
    }

    return user.id;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Helper function to send OneSignal notification
async function sendFollowNotification(
  playerIds: string[],
  followerUsername: string
): Promise<void> {
  const oneSignalAppId = process.env.ONESIGNAL_APP_ID;
  const oneSignalRestKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!oneSignalAppId || !oneSignalRestKey) {
    console.error('OneSignal credentials not configured');
    throw new Error('OneSignal credentials not configured');
  }

  if (!playerIds || playerIds.length === 0) {
    console.log('No player IDs to send notification to');
    throw new Error('No player IDs provided');
  }

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${oneSignalRestKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: oneSignalAppId,
        include_player_ids: playerIds,
        headings: { en: 'New Follower! 🎉' },
        contents: { en: `@${followerUsername} started following you` },
        data: {
          type: 'new_follower',
          follower_username: followerUsername,
        },
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('OneSignal notification error:', result);
      throw new Error(`OneSignal API error: ${JSON.stringify(result)}`);
    }

    // Check if the response contains errors (OneSignal returns 200 even with errors)
    if (result.errors) {
      console.error('OneSignal notification failed:', result);
      throw new Error(`OneSignal notification errors: ${JSON.stringify(result.errors)}`);
    }

    // Success - notification was sent
    console.log('Notification sent successfully:', result);
  } catch (error) {
    console.error('Failed to send OneSignal notification:', error);
    throw error; // Re-throw to prevent marking as sent
  }
}

export async function POST(request: NextRequest) {
  try {
    // 1. Verify authentication
    const authHeader = request.headers.get('Authorization');
    const authenticatedUserId = await verifyToken(authHeader);

    if (!authenticatedUserId) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or expired authentication token' },
        { status: 401 }
      );
    }

    // 2. Parse request body
    const body = await request.json();
    const { user_id: follower_id, followee_id } = body;

    console.log('Follow request:', { follower_id, followee_id, authenticated: authenticatedUserId });

    // 3. Validate request data
    if (!follower_id || !followee_id) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Both user_id and followee_id are required' },
        { status: 400 }
      );
    }

    // 4. Validate that the authenticated user matches the follower
    if (authenticatedUserId !== follower_id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'User ID mismatch with authenticated user' },
        { status: 403 }
      );
    }

    // 5. Validate UUIDs format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(follower_id) || !uuidRegex.test(followee_id)) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Invalid user ID format' },
        { status: 400 }
      );
    }

    // 6. Check if users exist
    const { data: followerUser, error: followerError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('id, username')
      .eq('id', follower_id)
      .maybeSingle();

    if (followerError) {
      console.error('Follower lookup error:', followerError);
      return NextResponse.json(
        { error: 'Database error', message: 'Error checking follower user' },
        { status: 500 }
      );
    }

    if (!followerUser) {
      return NextResponse.json(
        { error: 'User not found', message: 'Follower user does not exist' },
        { status: 404 }
      );
    }

    const { data: followeeUser, error: followeeError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('id, username')
      .eq('id', followee_id)
      .maybeSingle();

    if (followeeError) {
      console.error('Followee lookup error:', followeeError);
      return NextResponse.json(
        { error: 'Database error', message: 'Error checking user to follow' },
        { status: 500 }
      );
    }

    if (!followeeUser) {
      console.log('Followee not found. ID provided:', followee_id);
      return NextResponse.json(
        { error: 'User not found', message: 'User to follow does not exist' },
        { status: 404 }
      );
    }

    // Get followee's OneSignal player ID from notifications table
    const { data: followeeNotifications } = await supabaseAdmin
      .from('notifications')
      .select('onesignal_player_id, is_notifications_enabled')
      .eq('user_id', followee_id)
      .maybeSingle();

    // 7. Check if already following
    const { data: existingFollow } = await supabaseAdmin
      .from('followers')
      .select('id')
      .eq('follower_id', follower_id)
      .eq('following_id', followee_id)
      .maybeSingle();

    if (existingFollow) {
      return NextResponse.json(
        { error: 'Already following', message: 'You are already following this user' },
        { status: 400 }
      );
    }

    // 8. Create follow relationship
    const { data: followData, error: followError } = await supabaseAdmin
      .from('followers')
      .insert({
        follower_id: follower_id,
        following_id: followee_id,
      })
      .select()
      .single();

    if (followError) {
      console.error('Follow creation error:', followError);
      return NextResponse.json(
        { error: 'Follow failed', message: followError.message || 'Failed to follow user' },
        { status: 500 }
      );
    }

    // 9. Store notification in user_notifications table
    const { data: notificationData, error: notificationInsertError } = await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_id: followee_id, // The user receiving the notification
        type: 'new_follower',
        title: 'New Follower! 🎉',
        message: `@${followerUser.username} started following you`,
        data: {
          follower_id: follower_id,
          follower_username: followerUser.username,
          follow_id: followData.id,
        },
        is_read: false,
        sent: false, // Initially false, will be updated after successful push notification
      })
      .select('id')
      .single();

    if (notificationInsertError) {
      console.error('Failed to store notification:', notificationInsertError);
      // Don't fail the request if notification storage fails
    }

    // 10. Send push notification to the user being followed
    if (followeeNotifications?.onesignal_player_id && followeeNotifications?.is_notifications_enabled) {
      // Send notification and update 'sent' status
      sendFollowNotification(
        [followeeNotifications.onesignal_player_id],
        followerUser.username
      ).then(async () => {
        // Mark notification as sent only if push notification succeeded
        if (notificationData?.id) {
          await supabaseAdmin
            .from('user_notifications')
            .update({ sent: true })
            .eq('id', notificationData.id);
          console.log('Notification marked as sent in database');
        }
      }).catch(err => {
        console.error('Push notification failed - not marking as sent:', err.message || err);
        // Notification remains sent: false in database for potential retry
      });
    }

    // 11. Return success response
    return NextResponse.json(
      {
        success: true,
        message: `You are now following ${followeeUser.username}`,
        data: {
          follow_id: followData.id,
          follower_id: follower_id,
          following_id: followee_id,
          following_username: followeeUser.username,
          created_at: followData.created_at,
        }
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error', 
        message: error instanceof Error ? error.message : 'An unexpected error occurred' 
      },
      { status: 500 }
    );
  }
}
