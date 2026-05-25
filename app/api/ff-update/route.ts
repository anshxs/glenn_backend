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

interface FFUpdateRequest {
  user_id: string;
  ffuid: string;
  ff_name: string;
  ff_creation_date: string;
  level?: number;
}

/**
 * POST /api/ff-update
 * Securely updates FF user data (ffuid, ff_name, ff_creation_date)
 * Requires JWT authentication
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Verify authentication
    const authHeader = request.headers.get('Authorization');
    const authenticatedUserId = await verifyToken(authHeader);

    if (!authenticatedUserId) {
      return NextResponse.json(
        { 
          success: false,
          error: 'Unauthorized', 
          message: 'Invalid or missing authentication token' 
        },
        { status: 401 }
      );
    }

    // 2. Parse request body
    const body: FFUpdateRequest = await request.json();
    const {
      user_id: requestedUserId,
      ffuid,
      ff_name,
      ff_creation_date,
      level,
    } = body;
    const user_id = authenticatedUserId;

    // 3. Validate required fields
    if (!ffuid || !ff_name || !ff_creation_date) {
      return NextResponse.json(
        { 
          success: false,
          error: 'Validation error', 
          message: 'Missing required fields: ffuid, ff_name, ff_creation_date' 
        },
        { status: 400 }
      );
    }

    // 4. Never trust a client-supplied user_id.
    if (requestedUserId && requestedUserId !== authenticatedUserId) {
      return NextResponse.json(
        { 
          success: false,
          error: 'Forbidden', 
          message: 'You can only update your own FF data' 
        },
        { status: 403 }
      );
    }

    // 5. Verify FFUID format (numeric)
    if (!/^\d+$/.test(ffuid)) {
      return NextResponse.json(
        { 
          success: false,
          error: 'Validation error', 
          message: 'Invalid FFUID format. Must be numeric.' 
        },
        { status: 400 }
      );
    }

    // 6. Check if user exists
    const { data: existingUser, error: userCheckError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('id, ffuid')
      .eq('id', user_id)
      .single();

    if (userCheckError || !existingUser) {
      return NextResponse.json(
        { 
          success: false,
          error: 'User not found', 
          message: 'User does not exist in database' 
        },
        { status: 404 }
      );
    }

    // 7. Check if FFUID is already taken by another user
    if (existingUser.ffuid && existingUser.ffuid !== ffuid) {
      const { data: uidConflict } = await supabaseAdmin
        .from('sensitive_userdata')
        .select('id')
        .eq('ffuid', ffuid)
        .neq('id', user_id)
        .maybeSingle();

      if (uidConflict) {
        return NextResponse.json(
          { 
            success: false,
            error: 'Conflict', 
            message: 'This FFUID is already registered to another user' 
          },
          { status: 409 }
        );
      }
    }

    // 8. Update sensitive_userdata (ffuid and ffname)
    const { error: publicUpdateError } = await supabaseAdmin
      .from('sensitive_userdata')
      .update({
        ffuid: ffuid,
        ffname: ff_name,
        updated_at: new Date().toISOString()
      })
      .eq('id', user_id);

    if (publicUpdateError) {
      console.error('Error updating sensitive_userdata:', publicUpdateError);
      return NextResponse.json(
        { 
          success: false,
          error: 'Database error', 
          message: 'Failed to update public user data' 
        },
        { status: 500 }
      );
    }

    // 9. Update sensitive_userdata (ff_creation_date, ffuid, ffname)
    // Using service role key to bypass RLS
    const sensitiveUpdate: {
      ff_creation_date: string;
      ffuid: string;
      ffname: string;
      updated_at: string;
      ff_level?: number;
    } = {
      ff_creation_date: ff_creation_date,
      ffuid: ffuid,
      ffname: ff_name,
      updated_at: new Date().toISOString()
    };

    if (level !== undefined) {
      sensitiveUpdate.ff_level = level;
    }

    const { error: sensitiveUpdateError } = await supabaseAdmin
      .from('sensitive_userdata')
      .update(sensitiveUpdate)
      .eq('id', user_id);

    if (sensitiveUpdateError) {
      console.error('Error updating sensitive_userdata:', sensitiveUpdateError);
      return NextResponse.json(
        { 
          success: false,
          error: 'Database error', 
          message: 'Failed to update sensitive user data' 
        },
        { status: 500 }
      );
    }

    // 10. Return success response
    return NextResponse.json(
      {
        success: true,
        message: 'FF data updated successfully',
        data: {
          user_id,
          ffuid,
          ff_name,
          ff_creation_date,
          ...(level !== undefined && { level })
        }
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'An unexpected error occurred'
      },
      { status: 500 }
    );
  }
}
