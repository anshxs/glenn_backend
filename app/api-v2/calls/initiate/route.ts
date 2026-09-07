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

    // 2. Fetch callee's OneSignal Player ID (if available)
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

    // 3. Dispatch Push Notification via OneSignal REST API
    const appId = process.env.ONESIGNAL_APP_ID;
    const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (appId && restApiKey) {
      const callIcon = callType === 'video' ? '📹' : '📞';
      const notificationPayload: Record<string, any> = {
        app_id: appId,
        headings: { en: 'Glenn' },
        contents: { en: `${callIcon} ${callerName} is calling you` },
        data: {
          type: 'incoming_call',
          call_id: callId,
          caller_id: callerId,
          caller_name: callerName,
          caller_avatar: callerAvatar || '',
          call_type: callType,
          room_name: roomName,
          token: calleeToken,
          livekit_url: livekitUrl,
        },
        buttons: [
          { id: 'accept', text: 'Accept' },
          { id: 'decline', text: 'Decline' },
        ],
        priority: 10,
        android_channel_id: 'incoming_calls',
        android_sound: 'ringtone',
        ios_sound: 'ringtone.caf',
      };

      if (calleePlayerId) {
        notificationPayload.include_player_ids = [calleePlayerId];
      } else {
        notificationPayload.include_aliases = { external_id: [calleeId] };
        notificationPayload.target_channel = 'push';
      }

      try {
        const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${restApiKey}`,
          },
          body: JSON.stringify(notificationPayload),
        });

        if (!osRes.ok) {
          const errText = await osRes.text();
          console.warn('OneSignal call notification failed:', errText);
        }
      } catch (pushErr) {
        console.warn('Error sending OneSignal call notification:', pushErr);
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
