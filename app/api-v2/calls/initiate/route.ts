import { NextRequest, NextResponse } from 'next/server';
import { createLiveKitToken, getLiveKitConfig } from '@/lib/livekit';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { callerId, calleeId, callerName, callerAvatar, callType = 'video' } = body;

    if (!callerId || !calleeId || !callerName) {
      return NextResponse.json(
        { error: 'Missing required parameters: callerId, calleeId, callerName' },
        { status: 400 }
      );
    }

    const { url: livekitUrl } = getLiveKitConfig();
    const callId = crypto.randomUUID();
    const roomName = `call_${callId}`;

    // 1. Generate LiveKit Tokens for caller & callee
    const callerToken = await createLiveKitToken({
      identity: callerId,
      name: callerName,
      roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const calleeToken = await createLiveKitToken({
      identity: calleeId,
      roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    // 2. Insert record into call_logs table
    try {
      await supabaseAdmin.from('call_logs').insert({
        call_id: callId,
        caller_id: callerId,
        callee_id: calleeId,
        call_type: callType,
        status: 'ringing',
        started_at: new Date().toISOString(),
      });
    } catch (logErr) {
      console.warn('Could not insert call_log record:', logErr);
    }

    // 3. Insert notification into user_notifications table and invoke Edge Function
    const callIcon = callType === 'video' ? '📹' : '📞';
    const notifTitle = 'Glenn';
    const notifMessage = `${callIcon} ${callerName} is calling you`;
    const callData = {
      type: 'incoming_call',
      notification_type: 'incoming_call',
      call_id: callId,
      caller_id: callerId,
      caller_name: callerName,
      caller_avatar: callerAvatar || '',
      call_type: callType,
      room_name: roomName,
      token: calleeToken,
      livekit_url: livekitUrl,
      screen: 'call',
    };

    let userNotifId: string | null = null;
    try {
      const { data: userNotifRow, error: notifInsertError } = await supabaseAdmin
        .from('user_notifications')
        .insert({
          user_id: calleeId,
          type: 'incoming_call',
          title: notifTitle,
          message: notifMessage,
          data: callData,
          payload: {
            headings: { en: notifTitle },
            contents: { en: notifMessage },
            data: callData,
            buttons: [
              { id: 'accept', text: 'Accept' },
              { id: 'decline', text: 'Decline' },
            ],
            priority: 10,
          },
          sent: false,
        })
        .select('id')
        .single();

      if (!notifInsertError && userNotifRow) {
        userNotifId = userNotifRow.id;
      }
    } catch (dbErr) {
      console.warn('Error inserting into user_notifications:', dbErr);
    }

    // 4. Trigger Supabase push_notifications Edge Function
    if (userNotifId) {
      try {
        const edgeUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/push_notifications`;
        const edgeRes = await fetch(edgeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ notification_id: userNotifId }),
        });
        console.log('Supabase Edge Function push triggered:', edgeRes.status);
      } catch (edgeErr) {
        console.warn('Error calling push_notifications edge function:', edgeErr);
      }
    }

    // 5. Fallback: Direct OneSignal API dispatch (ensures delivery if edge function is delayed)
    const appId = process.env.ONESIGNAL_APP_ID;
    const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (appId && restApiKey) {
      // Query player ID if needed
      let calleePlayerId: string | null = null;
      try {
        const { data: notifData } = await supabaseAdmin
          .from('notifications')
          .select('onesignal_player_id')
          .eq('user_id', calleeId)
          .maybeSingle();
        calleePlayerId = notifData?.onesignal_player_id || null;
      } catch (dbErr) {
        console.warn('Could not query player ID from database:', dbErr);
      }

      const directPayload: Record<string, any> = {
        app_id: appId,
        headings: { en: notifTitle },
        contents: { en: notifMessage },
        data: callData,
        buttons: [
          { id: 'accept', text: 'Accept' },
          { id: 'decline', text: 'Decline' },
        ],
        priority: 10,
      };

      if (calleePlayerId) {
        directPayload.include_player_ids = [calleePlayerId];
      } else {
        directPayload.include_aliases = { external_id: [calleeId] };
        directPayload.target_channel = 'push';
      }

      try {
        const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${restApiKey}`,
          },
          body: JSON.stringify(directPayload),
        });

        if (!osRes.ok) {
          const errText = await osRes.text();
          console.warn('Direct OneSignal notification failed:', errText);
        }
      } catch (pushErr) {
        console.warn('Error sending direct OneSignal notification:', pushErr);
      }
    }

    return NextResponse.json({
      success: true,
      callId,
      roomName,
      token: callerToken,
      calleeToken,
      livekitUrl,
    });
  } catch (error: any) {
    console.error('Error initiating call:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to initiate call' },
      { status: 500 }
    );
  }
}
