import { RtcTokenBuilder, RtcRole } from 'agora-token';

export interface AgoraConfig {
  appId: string;
  appCertificate: string;
}

export function getAgoraConfig(): AgoraConfig | null {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    return null;
  }

  return { appId, appCertificate };
}

export function uuidToNumericUid(uuid: string): number {
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    const char = uuid.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash) % 2147483647 || 1;
}

export function createAgoraToken({
  channelName,
  uid,
  role = RtcRole.PUBLISHER,
  expireSeconds = 86400,
}: {
  channelName: string;
  uid: number;
  role?: number;
  expireSeconds?: number;
}): string | null {
  const config = getAgoraConfig();
  if (!config) return null;

  try {
    return RtcTokenBuilder.buildTokenWithUid(
      config.appId,
      config.appCertificate,
      channelName,
      uid,
      role,
      expireSeconds,
      expireSeconds
    );
  } catch (err) {
    console.error('Error generating Agora token:', err);
    return null;
  }
}
