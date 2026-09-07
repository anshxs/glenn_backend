import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { callId, recipientId, action } = body; // action: 'accepted' | 'declined' | 'ended' | 'missed'

    if (!callId || !action) {
      return NextResponse.json(
        { error: 'Missing required parameters: callId, action' },
        { status: 400 }
      );
    }

    // Notify other party via OneSignal data message or cancel notification
    const appId = process.env.ONESIGNAL_APP_ID;
    const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (recipientId && appId && restApiKey && (action === 'declined' || action === 'ended')) {
      try {
        await fetch('https://onesignal.com/api/v1/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${restApiKey}`,
          },
          body: JSON.stringify({
            app_id: appId,
            include_aliases: { external_id: [recipientId] },
            target_channel: 'push',
            headings: { en: 'Glenn' },
            contents: { en: action === 'declined' ? 'Call declined' : 'Call ended' },
            data: {
              type: 'call_ended',
              call_id: callId,
              action,
            },
          }),
        });
      } catch (err) {
        console.warn('Error sending call status notification:', err);
      }
    }

    return NextResponse.json({
      success: true,
      callId,
      action,
    });
  } catch (error: any) {
    console.error('Error responding to call:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to update call status' },
      { status: 500 }
    );
  }
}
