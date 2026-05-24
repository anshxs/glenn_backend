import { NextRequest } from 'next/server';

import { handleHoneypotRequest } from '@/lib/organiser-security-flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function endpoint(request: NextRequest) {
  return request.nextUrl.pathname;
}

export async function GET(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint(request));
}

export async function POST(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint(request));
}

export async function PUT(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint(request));
}

export async function PATCH(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint(request));
}

export async function DELETE(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint(request));
}
