import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';

const REQUEST_SIGNING_KEY =
  process.env.ORGANISER_REQUEST_SIGNING_KEY ?? 'organiser_req_2026_03_24_v1';
const REQUIRED_BUILD_HASH =
  process.env.ORGANISER_APP_BUILD_HASH ?? 'organiser_build_2026_03_24_v1';
const TIMESTAMP_WINDOW_MS = 30 * 1000;

type VerifyOptions = {
  bodyText?: string;
  allowAnyBuildHash?: boolean;
  allowUnsigned?: boolean;
};

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

  if (options.allowUnsigned && !timestamp && !nonce && !signature) {
    return null;
  }

  if (!options.allowAnyBuildHash && buildHash !== REQUIRED_BUILD_HASH) {
    return NextResponse.json(
      { error: 'Unsupported build', message: 'This organiser app build is no longer allowed.' },
      { status: 426 },
    );
  }

  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    return NextResponse.json(
      { error: 'Invalid timestamp', message: 'Missing or invalid request timestamp.' },
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
      { error: 'Invalid security headers', message: 'Missing organiser security headers.' },
      { status: 401 },
    );
  }

  const bodyText = options.bodyText ?? (await request.clone().text());
  const payload = `${timestamp}|${nonce}|${request.method.toUpperCase()}|${request.nextUrl.pathname}|${bodyText}|${buildHash}`;
  const expectedSignature = crypto
    .createHmac('sha256', REQUEST_SIGNING_KEY)
    .update(payload)
    .digest('hex');

  const provided = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return NextResponse.json(
      { error: 'Invalid signature', message: 'Request signature verification failed.' },
      { status: 401 },
    );
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
    return NextResponse.json(
      { error: 'Replay blocked', message: 'Request nonce has already been used.' },
      { status: 409 },
    );
  }

  return null;
}
