import { NextRequest, NextResponse } from 'next/server';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';
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

export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    let bodyText = '';
    try {
      const parsed = await readGlennJsonBody<Record<string, unknown>>(request);
      body = parsed.data;
      bodyText = parsed.bodyForSignature;
    } catch (error) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to parse Glenn payload.',
        },
        { status: 400 },
      );
    }

    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

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
    const requestedFollowerId =
      typeof body.user_id === 'string' ? body.user_id : null;
    const followee_id =
      typeof body.followee_id === 'string' ? body.followee_id : null;
    const follower_id = authenticatedUserId;

    console.log('Follow request:', {
      requestedFollowerId,
      follower_id,
      followee_id,
      authenticated: authenticatedUserId,
    });

    // 3. Validate request data
    if (!followee_id) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'followee_id is required' },
        { status: 400 }
      );
    }

    // 4. Never trust a client-supplied follower ID.
    if (requestedFollowerId !== null && requestedFollowerId !== authenticatedUserId) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'User ID mismatch with authenticated user' },
        { status: 403 }
      );
    }

    if (follower_id === followee_id) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Users cannot follow themselves' },
        { status: 400 }
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

    // 9. Return success response
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
