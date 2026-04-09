import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ALLOWED_ORIGINS = [
  'https://glennesports.app',
  'https://www.glennesports.app',
  'http://localhost:3000',
];

function isLocalRequest(request: NextRequest): boolean {
  const host = request.headers.get('host') ?? '';
  return host.includes('localhost') || host.startsWith('127.0.0.1');
}

function resolvedRequestProtocol(request: NextRequest): string {
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
    ?.toLowerCase();
  if (forwardedProto) {
    return forwardedProto;
  }

  const protocol = request.nextUrl.protocol.replace(':', '').toLowerCase();
  return protocol || 'http';
}

function applyBaseSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload',
  );
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

function applyApiSecurityHeaders(
  response: NextResponse,
  corsOrigin: string,
): NextResponse {
  applyBaseSecurityHeaders(response);
  response.headers.set('Access-Control-Allow-Origin', corsOrigin);
  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS',
  );
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-secret, x-organiser-build-hash, x-organiser-timestamp, x-organiser-nonce, x-organiser-signature, x-organiser-payload-mode, x-organiser-device-id, x-organiser-security-context',
  );
  return response;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isApiRoute = pathname.startsWith('/api/');
  const protocol = resolvedRequestProtocol(request);
  const isLocalhost = isLocalRequest(request);
  const origin = request.headers.get('origin') ?? '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const corsOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

  if (!isLocalhost && protocol !== 'https') {
    const insecureResponse = isApiRoute
      ? NextResponse.json(
          {
            error: 'HTTPS required',
            message: 'Only HTTPS requests are allowed.',
          },
          { status: 400 },
        )
      : new NextResponse('HTTPS required', { status: 400 });

    return isApiRoute
      ? applyApiSecurityHeaders(insecureResponse, corsOrigin)
      : applyBaseSecurityHeaders(insecureResponse);
  }

  if (isApiRoute && request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 200 });
    response.headers.set('Access-Control-Max-Age', '86400');
    return applyApiSecurityHeaders(response, corsOrigin);
  }

  const response = NextResponse.next();
  return isApiRoute
    ? applyApiSecurityHeaders(response, corsOrigin)
    : applyBaseSecurityHeaders(response);
}

export const config = {
  matcher: '/:path*',
};
