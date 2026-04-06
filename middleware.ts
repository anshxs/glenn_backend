import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ALLOWED_ORIGINS = [
  'https://glennesports.app',
  'https://www.glennesports.app',
  'http://localhost:3000',
];

function applyApiSecurityHeaders(
  response: NextResponse,
  corsOrigin: string,
): NextResponse {
  response.headers.set('Access-Control-Allow-Origin', corsOrigin);
  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS',
  );
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-secret, x-organiser-build-hash, x-organiser-timestamp, x-organiser-nonce, x-organiser-signature, x-organiser-payload-mode, x-organiser-device-id, x-organiser-security-context',
  );
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload',
  );
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? '';
  const host = request.headers.get('host') ?? '';
  const isLocalhost = host.includes('localhost') || host.startsWith('127.0.0.1');
  const origin = request.headers.get('origin') ?? '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const corsOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

  if (pathname.startsWith('/api/organiser') && forwardedProto && forwardedProto !== 'https' && !isLocalhost) {
    return applyApiSecurityHeaders(
      NextResponse.json(
        { error: 'HTTPS required', message: 'Only HTTPS requests are allowed.' },
        { status: 400 },
      ),
      corsOrigin,
    );
  }

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 200 });
    response.headers.set('Access-Control-Max-Age', '86400');
    return applyApiSecurityHeaders(response, corsOrigin);
  }

  return applyApiSecurityHeaders(NextResponse.next(), corsOrigin);
}

export const config = {
  matcher: '/api/:path*',
};
