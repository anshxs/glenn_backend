import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  decodeSecurityContextHeader,
  flagOrganiserSecurityEvent,
  hasBlockingFlagForDevice,
} from '@/lib/organiser-security-flags';
import { supabaseAdmin } from '@/lib/supabase';

const REQUEST_SIGNING_KEY =
  process.env.ORGANISER_REQUEST_SIGNING_KEY ?? 'organiser_req_2026_03_24_v1';
const DEFAULT_REQUIRED_BUILD_HASH =
  process.env.ORGANISER_APP_BUILD_HASH ?? 'organiser_build_2026_03_24_v1';
const TIMESTAMP_WINDOW_MS = 30 * 1000;
const FRESH_INTERACTION_WINDOW_MS = 10 * 60 * 1000;

type VerifyOptions = {
  bodyText?: string;
  allowAnyBuildHash?: boolean;
  allowUnsigned?: boolean;
  allowLegacySignature?: boolean;
};

type OrganiserSecurityContext = {
  device_id: string;
  session_id: string;
  session_age_ms: number;
  interaction_count: number;
  typing_event_count: number;
  typed_char_count: number;
  avg_typing_interval_ms: number;
  last_interaction_age_ms: number;
  recent_request_count_30s: number;
  recent_request_avg_interval_ms: number;
  debugger: boolean;
  rooted: boolean;
  vpn: boolean;
  proxy: boolean;
  suspicious_apps: boolean;
};

type EncryptedPayloadEnvelope = {
  payload: string;
  iv: string;
  tag: string;
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function derivePayloadKey(params: {
  timestamp: string;
  nonce: string;
  buildHash: string;
  deviceId: string;
}): Buffer {
  return crypto
    .createHmac('sha256', REQUEST_SIGNING_KEY)
    .update(
      `enc|${params.timestamp}|${params.nonce}|${params.buildHash}|${params.deviceId}`,
    )
    .digest();
}

function parseSecurityContext(
  encoded: string | null,
): OrganiserSecurityContext | null {
  const raw = decodeSecurityContextHeader(encoded);
  if (!raw) {
    return null;
  }

  const deviceId = String(raw.device_id ?? '').trim();
  const sessionId = String(raw.session_id ?? '').trim();
  if (!deviceId || !sessionId) {
    return null;
  }

  return {
    device_id: deviceId,
    session_id: sessionId,
    session_age_ms: toFiniteNumber(raw.session_age_ms, -1),
    interaction_count: toFiniteNumber(raw.interaction_count, 0),
    typing_event_count: toFiniteNumber(raw.typing_event_count, 0),
    typed_char_count: toFiniteNumber(raw.typed_char_count, 0),
    avg_typing_interval_ms: toFiniteNumber(raw.avg_typing_interval_ms, 0),
    last_interaction_age_ms: toFiniteNumber(raw.last_interaction_age_ms, -1),
    recent_request_count_30s: toFiniteNumber(raw.recent_request_count_30s, 0),
    recent_request_avg_interval_ms: toFiniteNumber(
      raw.recent_request_avg_interval_ms,
      0,
    ),
    debugger: toBoolean(raw.debugger),
    rooted: toBoolean(raw.rooted),
    vpn: toBoolean(raw.vpn),
    proxy: toBoolean(raw.proxy),
    suspicious_apps: toBoolean(raw.suspicious_apps),
  };
}

async function rejectAndFlag(
  request: NextRequest,
  params: {
    endpoint?: string;
    flagType: string;
    reason: string;
    message: string;
    status: number;
    shouldBlock?: boolean;
    securityContext?: Record<string, unknown> | null;
  },
): Promise<NextResponse> {
  await flagOrganiserSecurityEvent({
    request,
    endpoint: params.endpoint ?? request.nextUrl.pathname,
    flagType: params.flagType,
    reason: params.reason,
    severity: params.shouldBlock ? 'critical' : 'high',
    shouldBlock: params.shouldBlock ?? false,
    securityContext: params.securityContext,
    metadata: {
      method: request.method,
    },
  });

  return NextResponse.json(
    { error: params.flagType, message: params.message },
    { status: params.status },
  );
}

async function evaluateSecurityContext(
  request: NextRequest,
  context: OrganiserSecurityContext,
): Promise<NextResponse | null> {
  if (
    context.debugger ||
    context.rooted ||
    context.vpn ||
    context.proxy ||
    context.suspicious_apps
  ) {
    return rejectAndFlag(request, {
      flagType: 'device_state_rejected',
      reason: 'Signed request reported blocked local device state.',
      message: 'Device security checks failed.',
      status: 403,
      shouldBlock: true,
      securityContext: context,
    });
  }

  if (context.recent_request_count_30s >= 20) {
    return rejectAndFlag(request, {
      flagType: 'request_burst_detected',
      reason: `High organiser API frequency detected: ${context.recent_request_count_30s} in 30s.`,
      message: 'Too many organiser requests. Slow down and try again.',
      status: 429,
      securityContext: context,
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (
      context.interaction_count <= 0 ||
      context.last_interaction_age_ms < 0 ||
      context.last_interaction_age_ms > FRESH_INTERACTION_WINDOW_MS
    ) {
      return rejectAndFlag(request, {
        flagType: 'fresh_interaction_required',
        reason: `Mutating organiser request lacked fresh interaction. last=${context.last_interaction_age_ms}ms count=${context.interaction_count}.`,
        message: 'Fresh human interaction is required before this action.',
        status: 403,
        securityContext: context,
      });
    }
  }

  if (
    context.typed_char_count >= 12 &&
    context.avg_typing_interval_ms > 0 &&
    context.avg_typing_interval_ms < 12
  ) {
    await flagOrganiserSecurityEvent({
      request,
      endpoint: request.nextUrl.pathname,
      flagType: 'typing_cadence_anomaly',
      reason: `Typing cadence looked automated. avg=${context.avg_typing_interval_ms}ms chars=${context.typed_char_count}.`,
      severity: 'medium',
      securityContext: context,
      metadata: {
        method: request.method,
      },
    });
  }

  return null;
}

export function getRequiredOrganiserBuildHash(): string {
  return DEFAULT_REQUIRED_BUILD_HASH.trim();
}

export function isSupportedOrganiserBuildHash(
  buildHash: string | null | undefined,
): boolean {
  const requiredBuildHash = getRequiredOrganiserBuildHash();
  if (!requiredBuildHash) {
    return true;
  }

  return String(buildHash ?? '').trim() === requiredBuildHash;
}

export async function verifyOrganiserRequestSecurity(
  request: NextRequest,
  options: VerifyOptions = {},
): Promise<NextResponse | null> {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const host = request.headers.get('host') ?? '';
  const isLocal =
    host.includes('localhost') ||
    host.startsWith('127.0.0.1') ||
    process.env.NODE_ENV === 'development';

  if (!isLocal && forwardedProto && forwardedProto !== 'https') {
    return NextResponse.json(
      { error: 'HTTPS required', message: 'Only HTTPS requests are allowed.' },
      { status: 400 },
    );
  }

  const buildHash = request.headers.get('x-organiser-build-hash') ?? '';
  const timestamp = request.headers.get('x-organiser-timestamp') ?? '';
  const nonce = request.headers.get('x-organiser-nonce') ?? '';
  const signature = request.headers.get('x-organiser-signature') ?? '';
  const payloadMode = request.headers.get('x-organiser-payload-mode') ?? 'plain';
  const deviceId = request.headers.get('x-organiser-device-id') ?? '';
  const securityContextEncoded =
    request.headers.get('x-organiser-security-context') ?? '';
  const bodyText = options.bodyText ?? (await request.clone().text());

  const verifyLegacySignature = () => {
    const legacyPayload =
      `${timestamp}|${nonce}|${request.method.toUpperCase()}|${request.nextUrl.pathname}|${bodyText}|` +
      `${buildHash}`;
    const expectedLegacy = crypto
      .createHmac('sha256', REQUEST_SIGNING_KEY)
      .update(legacyPayload)
      .digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const expected = Buffer.from(expectedLegacy, 'utf8');
    return (
      provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected)
    );
  };

  if (options.allowUnsigned && !timestamp && !nonce && !signature) {
    return null;
  }

  const requiredBuildHash = options.allowAnyBuildHash
    ? null
    : getRequiredOrganiserBuildHash();

  if (requiredBuildHash && buildHash !== requiredBuildHash) {
    return NextResponse.json(
      {
        error: 'Unsupported build',
        message: 'This organiser app build is no longer allowed.',
      },
      { status: 426 },
    );
  }

  if (!deviceId || !securityContextEncoded) {
    if (options.allowLegacySignature && verifyLegacySignature()) {
      return null;
    }
    return NextResponse.json(
      {
        error: 'Invalid security context',
        message: 'Missing organiser device security context.',
      },
      { status: 401 },
    );
  }

  const parsedContext = parseSecurityContext(securityContextEncoded);
  if (!parsedContext || parsedContext.device_id !== deviceId) {
    return rejectAndFlag(request, {
      flagType: 'invalid_security_context',
      reason: 'Security context header was missing, malformed, or mismatched.',
      message: 'Invalid organiser security context.',
      status: 401,
    });
  }

  if (await hasBlockingFlagForDevice(deviceId)) {
    return NextResponse.json(
      {
        error: 'Device blocked',
        message:
          'This organiser device has been blocked after suspicious activity.',
      },
      { status: 403 },
    );
  }

  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    return NextResponse.json(
      {
        error: 'Invalid timestamp',
        message: 'Missing or invalid request timestamp.',
      },
      { status: 401 },
    );
  }

  if (Math.abs(Date.now() - parsedTimestamp) > TIMESTAMP_WINDOW_MS) {
    return NextResponse.json(
      { error: 'Expired request', message: 'Request timestamp is too old.' },
      { status: 401 },
    );
  }

  if (!nonce || nonce.length < 12 || !signature) {
    return NextResponse.json(
      {
        error: 'Invalid security headers',
        message: 'Missing organiser security headers.',
      },
      { status: 401 },
    );
  }

  const payload =
    `${timestamp}|${nonce}|${request.method.toUpperCase()}|${request.nextUrl.pathname}|${bodyText}|` +
    `${buildHash}|${payloadMode}|${securityContextEncoded}`;
  const expectedSignature = crypto
    .createHmac('sha256', REQUEST_SIGNING_KEY)
    .update(payload)
    .digest('hex');

  const provided = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    if (options.allowLegacySignature && verifyLegacySignature()) {
      return null;
    }
    return rejectAndFlag(request, {
      flagType: 'invalid_signature',
      reason: 'Request signature verification failed.',
      message: 'Request signature verification failed.',
      status: 401,
      securityContext: parsedContext,
    });
  }

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await supabaseAdmin
    .from('organiser_request_nonces')
    .delete()
    .lt('created_at', tenMinutesAgo);

  const { error: nonceErr } = await supabaseAdmin
    .from('organiser_request_nonces')
    .insert({
      nonce,
      request_path: request.nextUrl.pathname,
    });

  if (nonceErr) {
    return rejectAndFlag(request, {
      flagType: 'replay_blocked',
      reason: 'Request nonce has already been used.',
      message: 'Request nonce has already been used.',
      status: 409,
      securityContext: parsedContext,
    });
  }

  return evaluateSecurityContext(request, parsedContext);
}

export async function readOrganiserJsonBody<T>(
  request: NextRequest,
): Promise<{ rawBody: string; data: T }> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return { rawBody, data: {} as T };
  }

  const payloadMode = request.headers.get('x-organiser-payload-mode') ?? 'plain';
  if (payloadMode !== 'aes-256-gcm') {
    return { rawBody, data: JSON.parse(rawBody) as T };
  }

  const envelope = JSON.parse(rawBody) as Partial<EncryptedPayloadEnvelope>;
  if (!envelope.payload || !envelope.iv || !envelope.tag) {
    throw new Error('Invalid encrypted organiser payload.');
  }

  const timestamp = request.headers.get('x-organiser-timestamp') ?? '';
  const nonce = request.headers.get('x-organiser-nonce') ?? '';
  const buildHash = request.headers.get('x-organiser-build-hash') ?? '';
  const deviceId = request.headers.get('x-organiser-device-id') ?? '';
  if (!timestamp || !nonce || !buildHash || !deviceId) {
    throw new Error('Missing organiser encryption headers.');
  }

  const key = derivePayloadKey({
    timestamp,
    nonce,
    buildHash,
    deviceId,
  });
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    decodeBase64(envelope.iv),
  );
  decipher.setAuthTag(decodeBase64(envelope.tag));

  const decrypted = Buffer.concat([
    decipher.update(decodeBase64(envelope.payload)),
    decipher.final(),
  ]).toString('utf8');

  return { rawBody, data: JSON.parse(decrypted) as T };
}
