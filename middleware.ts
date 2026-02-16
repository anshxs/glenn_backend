import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // For Flutter Web apps, add CORS headers
  // Note: Flutter native (iOS/Android) apps don't need CORS
  
  const response = NextResponse.next();

  // CORS Configuration
  const origin = request.headers.get('origin');
  
  // Allow requests from your Flutter Web app domain
  // For development: allow localhost
  // For production: specify your exact domains
  const allowedOrigins = [
    'http://localhost:3000',
    'https://your-flutter-web-domain.com', // Replace with your actual domain
  ];

  if (origin && allowedOrigins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }

  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Access-Control-Max-Age', '86400');

  // Security headers (good for all apps)
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');

  return response;
}

// Apply middleware only to API routes
export const config = {
  matcher: '/api/:path*',
};
