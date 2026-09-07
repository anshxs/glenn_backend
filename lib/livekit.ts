import { AccessToken } from 'livekit-server-sdk';

export interface LiveKitTokenOptions {
  identity: string;
  name?: string;
  roomName: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

export function getLiveKitConfig() {
  const url = process.env.LIVEKIT_URL || '';
  const apiKey = process.env.LIVEKIT_API_KEY || '';
  const apiSecret = process.env.LIVEKIT_API_SECRET || '';

  return {
    url,
    apiKey,
    apiSecret,
  };
}

export async function createLiveKitToken(options: LiveKitTokenOptions): Promise<string> {
  const { apiKey, apiSecret } = getLiveKitConfig();

  if (!apiKey || !apiSecret) {
    throw new Error('LiveKit API key and secret must be configured');
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: options.identity,
    name: options.name || options.identity,
    ttl: '2h', // token validity duration
  });

  at.addGrant({
    roomJoin: true,
    room: options.roomName,
    canPublish: options.canPublish !== false,
    canSubscribe: options.canSubscribe !== false,
    canPublishData: options.canPublishData !== false,
  });

  return await at.toJwt();
}
