import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      callId,
      recipientId,
      action,
      status,
      durationSeconds,
      duration_seconds,
    } = body;
    const resolvedStatus = status || action; // 'connected' | 'declined' | 'ended' | 'missed'

    if (!callId || !resolvedStatus) {
      return NextResponse.json(
        { error: 'Missing required parameters: callId, status' },
        { status: 400 }
      );
    }

    // 1. Update call_logs table in Supabase
    try {
      const updateData: Record<string, any> = { status: resolvedStatus };
      if (
        resolvedStatus === 'ended' ||
        resolvedStatus === 'declined' ||
        resolvedStatus === 'missed'
      ) {
        updateData.ended_at = new Date().toISOString();
        const duration = durationSeconds ?? duration_seconds;
        if (typeof duration === 'number') {
          updateData.duration_seconds = duration;
        }
      }

      await supabaseAdmin
        .from('call_logs')
        .update(updateData)
        .eq('call_id', callId);
    } catch (logErr) {
      console.warn('Could not update call_logs record:', logErr);
    }

    // 2. Notify other party via OneSignal data message if ended or declined
    const appId = process.env.ONESIGNAL_APP_ID;
    const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (
      recipientId &&
      appId &&
      restApiKey &&
      (resolvedStatus === 'declined' || resolvedStatus === 'ended')
    ) {
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
