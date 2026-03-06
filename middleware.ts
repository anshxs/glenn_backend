import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ALLOWED_ORIGINS = [
  'https://glennesports.app',
  'https://www.glennesports.app',
  'http://localhost:3000',
];

export function middleware(request: NextRequest) {
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const response = NextResponse.next();
  response.headers.set('Access-Control-Allow-Origin', corsOrigin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
