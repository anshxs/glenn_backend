import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

type VerifyOptions = {
  bodyText?: string;
  allowAnyBuildHash?: boolean;
  allowUnsigned?: boolean;
  allowLegacySignature?: boolean;
};

type EncryptedPayloadEnvelope = {
  payload: string;
  iv: string;
  tag: string;
};

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

export async function verifyOrganiserRequestSecurity(
  request: NextRequest,
  options: VerifyOptions = {},
): Promise<NextResponse | null> {
  // All security checks removed - pass all requests
  // Only check HTTPS on production
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

  // Skip all security validation - device checks, signatures, contexts, timestamps, etc.
  return null;
}

export function isSupportedOrganiserBuildHash(
  buildHash: string | null | undefined,
): boolean {
  // All build hashes supported - no version checks
  return true;
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

  const deviceId = request.headers.get('x-organiser-device-id') ?? '';
  if (!deviceId) {
    throw new Error('Missing organiser device ID for decryption.');
  }

  // Derive key from device ID only (simplified)
  const key = crypto
    .createHmac('sha256', 'organiser_aes_key')
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

  return { rawBody, data: JSON.parse(decrypted) as T };
}
