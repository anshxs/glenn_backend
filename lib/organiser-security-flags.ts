import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export type FlagSeverity = 'low' | 'medium' | 'high' | 'critical';

type FlagInput = {
  request: NextRequest;
  endpoint: string;
  flagType: string;
  reason: string;
  severity?: FlagSeverity;
  shouldBlock?: boolean;
  organiserId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  securityContext?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function decodeSecurityContextHeader(
  value: string | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const decoded = JSON.parse(decodeBase64Url(value));
    return decoded && typeof decoded === 'object'
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requestIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || null;
  }

  return request.headers.get('x-real-ip');
}

export async function flagOrganiserSecurityEvent({
  request,
  endpoint,
  flagType,
  reason,
  severity = 'medium',
  shouldBlock = false,
  organiserId,
  deviceId,
  sessionId,
  securityContext,
  metadata = {},
}: FlagInput): Promise<void> {
  const parsedContext =
    securityContext ??
    decodeSecurityContextHeader(request.headers.get('x-organiser-security-context'));
  const actor =
    organiserId ??
    (await verifyBearerToken(request.headers.get('Authorization')))?.id ??
    null;
  const contextDeviceId =
    typeof parsedContext?.device_id === 'string' ? parsedContext.device_id : null;
  const contextSessionId =
    typeof parsedContext?.session_id === 'string'
      ? parsedContext.session_id
      : null;
  const resolvedDeviceId =
    deviceId ?? request.headers.get('x-organiser-device-id') ?? contextDeviceId;
  const resolvedSessionId = sessionId ?? contextSessionId;

  const { error } = await supabaseAdmin.from('organisers_flagged').insert({
    organiser_id: actor,
    device_id: resolvedDeviceId,
    session_id: resolvedSessionId,
    endpoint,
    flag_type: flagType,
    reason,
    severity,
    should_block: shouldBlock,
    status: 'open',
    ip_address: requestIp(request),
    user_agent: request.headers.get('user-agent'),
    build_hash: request.headers.get('x-organiser-build-hash'),
    security_context: parsedContext ?? {},
    metadata,
  });

  if (error) {
    console.error('Failed to insert organisers_flagged row:', error.message);
  }
}

export async function hasBlockingFlagForDevice(
  deviceId: string | null | undefined,
): Promise<boolean> {
  if (!deviceId) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from('organisers_flagged')
    .select('id')
    .eq('device_id', deviceId)
    .eq('status', 'open')
    .eq('should_block', true)
    .limit(1);

  if (error) {
    console.error('Failed to check blocking organiser flags:', error.message);
    return false;
  }

  return (data?.length ?? 0) > 0;
}

export async function handleHoneypotRequest(
  request: NextRequest,
  endpoint: string,
): Promise<NextResponse> {
  await flagOrganiserSecurityEvent({
    request,
    endpoint,
    flagType: 'honeypot_hit',
    reason: `Honeypot endpoint accessed: ${endpoint}`,
    severity: 'critical',
    shouldBlock: true,
    metadata: {
      method: request.method,
      search: request.nextUrl.search,
    },
  });

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
