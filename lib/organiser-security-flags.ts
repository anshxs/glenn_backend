import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export type FlagSeverity = 'low' | 'medium' | 'high' | 'critical';
export type SecurityFlagApp = 'organiser' | 'glenn' | 'admin' | 'backend' | string;

type FlagInput = {
  app?: SecurityFlagApp;
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

function readContextString(
  context: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!context) {
    return null;
  }

  for (const key of keys) {
    const value = context[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function collectForensicHeaders(request: NextRequest): Record<string, string> {
  const names = [
    'x-forwarded-for',
    'x-real-ip',
    'x-forwarded-proto',
    'x-vercel-ip-country',
    'x-vercel-ip-country-region',
    'x-vercel-ip-city',
    'x-vercel-id',
    'cf-connecting-ip',
    'cf-ray',
    'host',
    'origin',
    'referer',
    'user-agent',
  ];

  return names.reduce<Record<string, string>>((acc, name) => {
    const value = request.headers.get(name);
    if (value) {
      acc[name] = value;
    }
    return acc;
  }, {});
}

function hasOrganiserProbeSignals(request: NextRequest): boolean {
  return Boolean(
    request.headers.get('Authorization')?.startsWith('Bearer ') ||
      request.headers.get('x-organiser-device-id') ||
      request.headers.get('x-glenn-device-id') ||
      request.headers.get('x-organiser-security-context') ||
      request.headers.get('x-glenn-security-context') ||
      request.headers.get('x-organiser-signature') ||
      request.headers.get('x-glenn-signature') ||
      request.headers.get('x-organiser-timestamp') ||
      request.headers.get('x-glenn-timestamp'),
  );
}

function honeypotPayload(endpoint: string): Record<string, unknown> {
  return {
    success: true,
    data: {
      endpoint,
      enabled: false,
      tools: [],
      sample: true,
    },
  };
}

export async function flagOrganiserSecurityEvent({
  app = 'organiser',
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
    decodeSecurityContextHeader(
      request.headers.get('x-organiser-security-context') ??
        request.headers.get('x-glenn-security-context'),
    );
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
    deviceId ??
    request.headers.get('x-organiser-device-id') ??
    request.headers.get('x-glenn-device-id') ??
    contextDeviceId;
  const resolvedSessionId = sessionId ?? contextSessionId;
  const forensicHeaders = collectForensicHeaders(request);

  const { error } = await supabaseAdmin.from('app_security_flags').insert({
    app,
    user_id: actor,
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
    build_hash:
      request.headers.get('x-organiser-build-hash') ??
      request.headers.get('x-glenn-build-hash'),
    platform: readContextString(parsedContext, ['platform']),
    platform_version: readContextString(parsedContext, [
      'platform_version',
      'platformVersion',
      'os_version',
      'osVersion',
      'release',
    ]),
    app_version: readContextString(parsedContext, ['app_version', 'appVersion']),
    device_model: readContextString(parsedContext, [
      'device_model',
      'deviceModel',
      'model',
    ]),
    device_manufacturer: readContextString(parsedContext, [
      'device_manufacturer',
      'deviceManufacturer',
      'manufacturer',
    ]),
    device_brand: readContextString(parsedContext, ['device_brand', 'deviceBrand', 'brand']),
    device_fingerprint: readContextString(parsedContext, [
      'device_fingerprint',
      'deviceFingerprint',
      'fingerprint',
    ]),
    signature_sha256: readContextString(parsedContext, [
      'signature_sha256',
      'signatureSha256',
    ]),
    request_headers: forensicHeaders,
    security_context: parsedContext ?? {},
    metadata,
  });

  if (error) {
    console.error('Failed to insert app_security_flags row:', error.message);
  }
}

export async function hasBlockingFlagForDevice(
  params:
    | string
    | null
    | undefined
    | { app?: SecurityFlagApp; deviceId: string | null | undefined },
): Promise<boolean> {
  const app = typeof params === 'object' && params !== null ? params.app ?? 'organiser' : 'organiser';
  const deviceId =
    typeof params === 'object' && params !== null ? params.deviceId : params;

  if (!deviceId) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from('app_security_flags')
    .select('id')
    .eq('app', app)
    .eq('device_id', deviceId)
    .eq('status', 'open')
    .eq('should_block', true)
    .limit(1);

  if (error) {
    console.error('Failed to check blocking app flags:', error.message);
    return false;
  }

  return (data?.length ?? 0) > 0;
}

export async function handleHoneypotRequest(
  request: NextRequest,
  endpoint: string,
): Promise<NextResponse> {
  const organiserProbe = hasOrganiserProbeSignals(request);
  await flagOrganiserSecurityEvent({
    app: organiserProbe ? 'organiser' : 'backend',
    request,
    endpoint,
    flagType: organiserProbe ? 'organiser_honeypot_access' : 'honeypot_hit',
    reason: organiserProbe
      ? `An organiser-authenticated probe touched honeypot endpoint: ${endpoint}`
      : `Honeypot endpoint accessed: ${endpoint}`,
    severity: organiserProbe ? 'critical' : 'high',
    shouldBlock: organiserProbe,
    metadata: {
      method: request.method,
      search: request.nextUrl.search,
      had_authorization: request.headers.get('Authorization')?.startsWith('Bearer ') === true,
      had_organiser_headers: organiserProbe,
    },
  });

  if (organiserProbe) {
    return NextResponse.json(honeypotPayload(endpoint), { status: 200 });
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
