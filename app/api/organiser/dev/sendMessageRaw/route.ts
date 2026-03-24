import { NextRequest } from 'next/server';

import { handleHoneypotRequest } from '@/lib/organiser-security-flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return handleHoneypotRequest(request, '/api/organiser/dev/sendMessageRaw');
}

export async function POST(request: NextRequest) {
  return handleHoneypotRequest(request, '/api/organiser/dev/sendMessageRaw');
}

export async function PUT(request: NextRequest) {
  return handleHoneypotRequest(request, '/api/organiser/dev/sendMessageRaw');
}

export async function PATCH(request: NextRequest) {
  return handleHoneypotRequest(request, '/api/organiser/dev/sendMessageRaw');
}

export async function DELETE(request: NextRequest) {
  return handleHoneypotRequest(request, '/api/organiser/dev/sendMessageRaw');
}
