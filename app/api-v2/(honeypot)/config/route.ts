import { NextRequest } from 'next/server';

import { handleHoneypotRequest } from '@/lib/organiser-security-flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const endpoint = '/api-v2/config';

export async function GET(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint);
}

export async function POST(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint);
}

export async function PUT(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint);
}

export async function PATCH(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint);
}

export async function DELETE(request: NextRequest) {
  return handleHoneypotRequest(request, endpoint);
}
