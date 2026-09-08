import { NextRequest, NextResponse } from 'next/server';
import { createLiveKitToken, getLiveKitConfig } from '@/lib/livekit';
import { createAgoraToken, getAgoraConfig, uuidToNumericUid } from '@/lib/agora';
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

    // 1. Generate LiveKit Tokens for caller & callee (Always generated as reliable fallback)
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

    // 2. Generate Agora RTC Tokens for caller & callee if Agora is configured
    const agoraConfig = getAgoraConfig();
    let agoraAppId: string | null = null;
    let agoraChannelName: string | null = null;
    let callerAgoraToken: string | null = null;
    let calleeAgoraToken: string | null = null;
    let callerAgoraUid: number | null = null;
    let calleeAgoraUid: number | null = null;

    if (agoraConfig) {
      agoraAppId = agoraConfig.appId;
      agoraChannelName = roomName;
      callerAgoraUid = uuidToNumericUid(callerId);
      calleeAgoraUid = uuidToNumericUid(calleeId);

      callerAgoraToken = createAgoraToken({
        channelName: agoraChannelName,
        uid: callerAgoraUid,
      });

      calleeAgoraToken = createAgoraToken({
        channelName: agoraChannelName,
        uid: calleeAgoraUid,
      });
    }

    // 3. Insert record into call_logs table
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

    // 4. Prepare call notification metadata (Includes Agora + LiveKit fallback)
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
      agora_app_id: agoraAppId || '',
      agora_channel_name: agoraChannelName || '',
      agora_token: calleeAgoraToken || '',
      agora_uid: calleeAgoraUid || 0,
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

      // Attempt 1: Target via external_id (links directly to Supabase User UUID across all devices)
      let delivered = false;
      const aliasPayload = {
        ...directPayload,
        include_aliases: { external_id: [calleeId] },
        target_channel: 'push',
      };

      try {
        const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${restApiKey}`,
          },
          body: JSON.stringify(aliasPayload),
        });

        const resData = await osRes.json().catch(() => ({}));
        if (osRes.ok && (resData?.recipients === undefined || resData.recipients > 0)) {
          console.log('Incoming call notification delivered via external_id:', resData.id);
          delivered = true;
        } else {
          console.warn('OneSignal external_id dispatch returned 0 recipients or errors:', resData);
        }
      } catch (pushErr) {
        console.warn('Error dispatching via external_id:', pushErr);
      }

      // Attempt 2 (Fallback): If external_id delivered 0 recipients and we have a cached player_id
      if (!delivered && calleePlayerId) {
        console.log('Attempting fallback push via include_player_ids:', calleePlayerId);
        const playerPayload = {
          ...directPayload,
          include_player_ids: [calleePlayerId],
        };

        try {
          const osRes2 = await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${restApiKey}`,
            },
            body: JSON.stringify(playerPayload),
          });
          const resData2 = await osRes2.json().catch(() => ({}));
          if (osRes2.ok) {
            console.log('Incoming call notification delivered via player_id fallback:', resData2.id);
            delivered = true;
          } else {
            console.warn('OneSignal player_id fallback dispatch failed:', resData2);
          }
        } catch (pushErr2) {
          console.warn('Error in player_id fallback dispatch:', pushErr2);
        }
      }
    }

    return NextResponse.json({
      success: true,
      callId,
      roomName,
      token: callerToken,
      calleeToken,
      livekitUrl,
      agoraAppId,
      agoraChannelName,
      callerAgoraToken,
      calleeAgoraToken,
      callerAgoraUid,
      calleeAgoraUid,
    });
  } catch (error: any) {
    console.error('Error initiating call:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to initiate call' },
      { status: 500 }
    );
  }
}
