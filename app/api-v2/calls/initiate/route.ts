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

    // 3. Prepare call notification metadata
    const notifTitle = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';
    const notifMessage = `${callerName} is calling...`;
    const callData = {
      type: 'incoming_call',
      notification_type: 'incoming_call',
      call_id: callId,
      caller_id: callerId,
      caller_name: callerName,
      caller_avatar: callerAvatar || '',
      sender_avatarurl: callerAvatar || '',
      large_icon: callerAvatar || '',
      call_type: callType,
      room_name: roomName,
      token: calleeToken,
      livekit_url: livekitUrl,
      screen: 'call',
    };

    // 4. Save notification in database with sent: true so database triggers do NOT send a duplicate push
    try {
      await supabaseAdmin.from('user_notifications').insert({
        user_id: calleeId,
        type: 'incoming_call',
        title: notifTitle,
        message: notifMessage,
        data: callData,
        payload: {
          headings: { en: notifTitle },
          contents: { en: notifMessage },
          data: callData,
          large_icon: callerAvatar || '',
          sender_avatarurl: callerAvatar || '',
          android_sound: 'ringtone',
          ios_sound: 'ringtone.mp3',
          buttons: [
            { id: 'accept', text: 'Answer' },
            { id: 'decline', text: 'Decline' },
          ],
          priority: 10,
        },
        sent: true,
      });
    } catch (dbErr) {
      console.warn('Error inserting into user_notifications:', dbErr);
    }

    // 5. Send EXACTLY ONE high-priority call notification via OneSignal
    const appId = process.env.ONESIGNAL_APP_ID;
    const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (appId && restApiKey) {
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
        content_available: true,
        android_sound: 'ringtone',
        ios_sound: 'ringtone.mp3',
        priority: 10,
        buttons: [
          { id: 'accept', text: 'Answer' },
          { id: 'decline', text: 'Decline' },
        ],
      };

      if (process.env.ONESIGNAL_CALL_CHANNEL_ID) {
        directPayload.android_channel_id = process.env.ONESIGNAL_CALL_CHANNEL_ID;
      }

      if (callerAvatar) {
        directPayload.large_icon = callerAvatar;
      }

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
          console.warn('OneSignal call notification dispatch failed:', errText);
        } else {
          console.log('Single OneSignal incoming call notification dispatched successfully');
        }
      } catch (pushErr) {
        console.warn('Error dispatching OneSignal call notification:', pushErr);
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
