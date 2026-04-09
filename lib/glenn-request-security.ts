import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  decodeSecurityContextHeader,
  flagOrganiserSecurityEvent,
  hasBlockingFlagForDevice,
} from '@/lib/organiser-security-flags';

type VerifyOptions = {
  bodyText?: string;
  allowAnyBuildHash?: boolean;
  allowUnsigned?: boolean;
  allowBlockedDevice?: boolean;
  requireEncryptedPayload?: boolean;
};

type EncryptedPayloadEnvelope = {
  payload: string;
  iv: string;
  tag: string;
};

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

function getGlennSharedSecret(): string {
  const configured = process.env.GLENN_REQUEST_HMAC_SECRET?.trim();
  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === 'development') {
    return 'glenn_dev_shared_secret';
  }

  throw new Error('Missing GLENN_REQUEST_HMAC_SECRET');
}

function isLocalRequest(request: NextRequest): boolean {
  const host = request.headers.get('host') ?? '';
  return (
    host.includes('localhost') ||
    host.startsWith('127.0.0.1') ||
    process.env.NODE_ENV === 'development'
  );
}

function isGlennDebugRequest(
  request: NextRequest,
  parsedContext?: Record<string, unknown> | null,
): boolean {
  const headerValue = request.headers
    .get('x-glenn-debug-mode')
    ?.trim()
    .toLowerCase();
  return (
    headerValue === '1' ||
    headerValue === 'true' ||
    parsedContext?.debug_mode_enabled === true ||
    parsedContext?.debugModeEnabled === true
  );
}

function isGlennDebugAllowed(): boolean {
  return (
    process.env.GLENN_ALLOW_DEBUG_REQUESTS === 'true' ||
    process.env.NODE_ENV === 'development'
  );
}

function normalizeFingerprint(value: string | null | undefined): string | null {
  const normalized = value?.replace(/:/g, '').trim().toUpperCase() ?? '';
  return normalized ? normalized : null;
}

function getExpectedGlennReleaseFingerprint(): string | null {
  return normalizeFingerprint(
    process.env.GLENN_RELEASE_SIGNING_CERT_SHA256 ??
      process.env.GLENN_SIGNING_CERT_SHA256,
  );
}

function isSupportedBuildHashValue(buildHash: string | null | undefined): boolean {
  const allowed = (
    process.env.GLENN_ALLOWED_BUILD_HASHES ?? process.env.GLENN_APP_BUILD_HASH ?? ''
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    return true;
  }

  if (!buildHash || !buildHash.trim()) {
    return false;
  }

  return allowed.includes(buildHash.trim());
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

export async function verifyGlennRequestSecurity(
  request: NextRequest,
  options: VerifyOptions = {},
): Promise<NextResponse | null> {
  const parsedContext = decodeSecurityContextHeader(
    request.headers.get('x-glenn-security-context'),
  );
  const buildHash = request.headers.get('x-glenn-build-hash');
  const contextDeviceId =
    typeof parsedContext?.device_id === 'string' ? parsedContext.device_id : null;
  const deviceId = request.headers.get('x-glenn-device-id') ?? contextDeviceId;
  const isRooted =
    parsedContext?.is_rooted === true || parsedContext?.isRooted === true;
  const isJailbroken =
    parsedContext?.is_jailbroken === true || parsedContext?.isJailbroken === true;
  const hasSuspiciousApps =
    parsedContext?.has_suspicious_apps === true ||
    parsedContext?.hasSuspiciousApps === true ||
    parsedContext?.has_frida_or_hooking === true ||
    parsedContext?.hasFridaOrHooking === true;
  const isTampered =
    parsedContext?.is_tampered === true || parsedContext?.isTampered === true;
  const isDebuggerAttached =
    parsedContext?.is_debugger_attached === true ||
    parsedContext?.isDebuggerAttached === true ||
    parsedContext?.is_debugged === true ||
    parsedContext?.isDebugged === true;
  const clientReportedSignatureMismatch =
    parsedContext?.signature_mismatch === true ||
    parsedContext?.signatureMismatch === true ||
    parsedContext?.signature_valid === false ||
    parsedContext?.signatureValid === false;
  const runtimeSignature = normalizeFingerprint(
    typeof parsedContext?.signature_sha256 === 'string'
      ? parsedContext.signature_sha256
      : null,
  );
  const clientExpectedSignature = normalizeFingerprint(
    typeof parsedContext?.signature_expected_sha256 === 'string'
      ? parsedContext.signature_expected_sha256
      : null,
  );
  const serverExpectedSignature = getExpectedGlennReleaseFingerprint();
  const signatureExpectedMismatch =
    !!serverExpectedSignature &&
    !!clientExpectedSignature &&
    clientExpectedSignature !== serverExpectedSignature;
  const serverDetectedSignatureMismatch =
    !!serverExpectedSignature &&
    (!runtimeSignature || runtimeSignature !== serverExpectedSignature);
  const signatureMismatch =
    clientReportedSignatureMismatch ||
    signatureExpectedMismatch ||
    serverDetectedSignatureMismatch;
  const isDebugRequest = isGlennDebugRequest(request, parsedContext);
  const debugAllowed = isDebugRequest && isGlennDebugAllowed();
  const allowAnyBuildHash = options.allowAnyBuildHash || debugAllowed;
  const allowUnsigned = options.allowUnsigned || debugAllowed;
  const payloadMode =
    request.headers.get('x-glenn-payload-mode')?.trim().toLowerCase() ?? '';

  const forwardedProto = request.headers.get('x-forwarded-proto') ?? '';
  if (!isLocalRequest(request) && forwardedProto !== 'https') {
    return NextResponse.json(
      { error: 'HTTPS required', message: 'Only HTTPS requests are allowed.' },
      { status: 400 },
    );
  }

  if (isDebugRequest && !debugAllowed) {
    return NextResponse.json(
      {
        error: 'Debug client blocked',
        message: 'This backend is not configured to accept Glenn debug builds.',
      },
      { status: 403 },
    );
  }

  if (
    !debugAllowed &&
    process.env.NODE_ENV !== 'development' &&
    !serverExpectedSignature
  ) {
    return NextResponse.json(
      {
        error: 'Server misconfigured',
        message: 'Glenn signing verification is not configured on the backend.',
      },
      { status: 500 },
    );
  }

  if (
    options.requireEncryptedPayload &&
    !debugAllowed &&
    payloadMode !== 'aes-256-gcm'
  ) {
    await flagOrganiserSecurityEvent({
      app: 'glenn',
      request,
      endpoint: request.nextUrl.pathname,
      flagType: 'unencrypted_payload',
      reason:
        'A sensitive Glenn request was sent without the required encrypted payload envelope.',
      severity: 'high',
      shouldBlock: true,
      deviceId,
      securityContext: parsedContext,
      metadata: {
        method: request.method,
        payload_mode: payloadMode || null,
        build_hash: buildHash,
      },
    });

    return NextResponse.json(
      {
        error: 'Encrypted payload required',
        message: 'This Glenn action requires an encrypted request payload.',
      },
      { status: 403 },
    );
  }

  if (!allowAnyBuildHash && !isSupportedBuildHashValue(buildHash)) {
    await flagOrganiserSecurityEvent({
      app: 'glenn',
      request,
      endpoint: request.nextUrl.pathname,
      flagType: 'unsupported_build_hash',
      reason: 'An unsupported Glenn build attempted to access protected APIs.',
      severity: 'high',
      shouldBlock: true,
      deviceId,
      securityContext: parsedContext,
      metadata: {
        method: request.method,
        build_hash: buildHash,
      },
    });

    return NextResponse.json(
      {
        error: 'Update required',
        message: 'This Glenn build is no longer supported.',
      },
      { status: 426 },
    );
  }

  const timestamp = request.headers.get('x-glenn-timestamp')?.trim() ?? '';
  const signature = request.headers.get('x-glenn-signature')?.trim() ?? '';

  if (!timestamp || !signature) {
    await flagOrganiserSecurityEvent({
      app: 'glenn',
      request,
      endpoint: request.nextUrl.pathname,
      flagType: 'missing_request_signature',
      reason: 'A Glenn request was missing the signed timestamp headers.',
      severity: 'high',
      shouldBlock: true,
      deviceId,
      securityContext: parsedContext,
      metadata: {
        method: request.method,
        has_timestamp: !!timestamp,
        build_hash: buildHash,
      },
    });

    if (!allowUnsigned) {
      return NextResponse.json(
        {
          error: 'Unsigned request',
          message: 'Glenn requests must include a valid signed timestamp.',
        },
        { status: 403 },
      );
    }
  } else {
    const timestampMs = Number(timestamp);
    const now = Date.now();
    const isFresh =
      Number.isFinite(timestampMs) &&
      Math.abs(now - timestampMs) <= MAX_SIGNATURE_AGE_MS;

    if (!isFresh) {
      await flagOrganiserSecurityEvent({
        app: 'glenn',
        request,
        endpoint: request.nextUrl.pathname,
        flagType: 'stale_request_timestamp',
        reason: 'A Glenn request used a stale or invalid signed timestamp.',
        severity: 'high',
        shouldBlock: true,
        deviceId,
        securityContext: parsedContext,
        metadata: {
          method: request.method,
          timestamp,
          now,
          build_hash: buildHash,
        },
      });

      return NextResponse.json(
        {
          error: 'Expired request',
          message: 'This Glenn request is too old or has an invalid timestamp.',
        },
        { status: 403 },
      );
    }

    const bodyText =
      options.bodyText ??
      (request.method === 'GET' ||
              request.method === 'DELETE' ||
              request.method === 'HEAD'
          ? ''
          : await request.clone().text());
    const expectedSignature = crypto
      .createHmac('sha256', getGlennSharedSecret())
      .update(`${timestamp}${bodyText}`)
      .digest('hex');

    if (!timingSafeEqualHex(signature.toLowerCase(), expectedSignature)) {
      await flagOrganiserSecurityEvent({
        app: 'glenn',
        request,
        endpoint: request.nextUrl.pathname,
        flagType: 'invalid_request_signature',
        reason: 'A Glenn request failed HMAC signature validation.',
        severity: 'critical',
        shouldBlock: true,
        deviceId,
        securityContext: parsedContext,
        metadata: {
          method: request.method,
          timestamp,
          build_hash: buildHash,
        },
      });

      return NextResponse.json(
        {
          error: 'Invalid signature',
          message: 'Glenn request signature validation failed.',
        },
        { status: 403 },
      );
    }
  }

  if (!debugAllowed && (isDebuggerAttached || signatureMismatch)) {
    await flagOrganiserSecurityEvent({
      app: 'glenn',
      request,
      endpoint: request.nextUrl.pathname,
      flagType: signatureMismatch
        ? 'signing_certificate_mismatch'
        : 'debugger_attached',
      reason: signatureMismatch
        ? 'The Glenn app signature did not match the expected release certificate.'
        : 'A debugger was detected on the Glenn runtime.',
      severity: 'critical',
      shouldBlock: true,
      deviceId,
      securityContext: parsedContext,
      metadata: {
        method: request.method,
        signature_sha256: runtimeSignature,
        signature_expected_sha256: clientExpectedSignature,
        signature_server_expected_sha256: serverExpectedSignature,
        build_hash: buildHash,
      },
    });

    return NextResponse.json(
      {
        error: 'Security blocked',
        message: 'This Glenn runtime failed integrity checks.',
      },
      { status: 403 },
    );
  }

  if (
    !debugAllowed &&
    !options.allowBlockedDevice &&
    (isRooted || isJailbroken || hasSuspiciousApps || isTampered)
  ) {
    await flagOrganiserSecurityEvent({
      app: 'glenn',
      request,
      endpoint: request.nextUrl.pathname,
      flagType: isJailbroken
        ? 'jailbroken_device'
        : isTampered
          ? 'tampered_runtime'
          : 'rooted_device',
      reason: hasSuspiciousApps
        ? 'Root or tampering tools were detected on the Glenn device.'
        : isTampered
          ? 'Runtime tampering signals were detected on the Glenn device.'
          : 'A rooted or jailbroken device attempted to use protected Glenn APIs.',
      severity: 'critical',
      shouldBlock: true,
      deviceId,
      securityContext: parsedContext,
      metadata: {
        method: request.method,
        search: request.nextUrl.search,
        has_suspicious_apps: hasSuspiciousApps,
        is_rooted: isRooted,
        is_jailbroken: isJailbroken,
        is_tampered: isTampered,
        build_hash: buildHash,
      },
    });

    return NextResponse.json(
      {
        error: 'Security blocked',
        message: 'This device is not allowed to use Glenn.',
      },
      { status: 403 },
    );
  }

  if (
    !debugAllowed &&
    !options.allowBlockedDevice &&
    (await hasBlockingFlagForDevice({ app: 'glenn', deviceId }))
  ) {
    return NextResponse.json(
      {
        error: 'Device blocked',
        message: 'This device has been blocked for Glenn access.',
      },
      { status: 403 },
    );
  }

  return null;
}

export async function readGlennJsonBody<T>(
  request: NextRequest,
): Promise<{ rawBody: string; bodyForSignature: string; data: T }> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return { rawBody, bodyForSignature: '', data: {} as T };
  }

  const payloadMode = request.headers.get('x-glenn-payload-mode') ?? 'plain';
  if (payloadMode !== 'aes-256-gcm') {
    return {
      rawBody,
      bodyForSignature: rawBody,
      data: JSON.parse(rawBody) as T,
    };
  }

  const envelope = JSON.parse(rawBody) as Partial<EncryptedPayloadEnvelope>;
  if (!envelope.payload || !envelope.iv || !envelope.tag) {
    throw new Error('Invalid encrypted Glenn payload.');
  }

  const deviceId = request.headers.get('x-glenn-device-id') ?? '';
  if (!deviceId) {
    throw new Error('Missing Glenn device ID for decryption.');
  }

  const key = crypto
    .createHmac('sha256', getGlennSharedSecret())
    .update(deviceId)
    .digest();

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

  return {
    rawBody,
    bodyForSignature: decrypted,
    data: JSON.parse(decrypted) as T,
  };
}
