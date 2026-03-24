import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ALLOWED_ORIGINS = [
  'https://glennesports.app',
  'https://www.glennesports.app',
  'http://localhost:3000',
];

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? '';
  const host = request.headers.get('host') ?? '';
  const isLocalhost = host.includes('localhost') || host.startsWith('127.0.0.1');

  if (pathname.startsWith('/api/organiser') && forwardedProto && forwardedProto !== 'https' && !isLocalhost) {
    return NextResponse.json(
      { error: 'HTTPS required', message: 'Only HTTPS requests are allowed.' },
      { status: 400 },
    );
  }

  const origin = request.headers.get('origin') ?? '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const corsOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, x-admin-secret, x-organiser-build-hash, x-organiser-timestamp, x-organiser-nonce, x-organiser-signature, x-organiser-payload-mode, x-organiser-device-id, x-organiser-security-context',
        'Access-Control-Max-Age': '86400',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      },
    });
  }

  const response = NextResponse.next();
  response.headers.set('Access-Control-Allow-Origin', corsOrigin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-secret, x-organiser-build-hash, x-organiser-timestamp, x-organiser-nonce, x-organiser-signature, x-organiser-payload-mode, x-organiser-device-id, x-organiser-security-context',
  );
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
