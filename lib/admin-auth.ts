import { NextRequest, NextResponse } from 'next/server';

export const ADMIN_PIN = '2580';

export function verifyAdminPin(pin: unknown): boolean {
  return typeof pin === 'string' && pin === ADMIN_PIN;
}

export function requireAdminPin(request: NextRequest): NextResponse | null {
  const pin = request.headers.get('x-admin-pin');
  if (!verifyAdminPin(pin)) {
    return NextResponse.json(
      { error: 'Unauthorized', message: 'Invalid admin PIN' },
      { status: 401 }
    );
  }
  return null;
}
