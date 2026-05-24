import { NextRequest, NextResponse } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireApiV2Auth(request);
  if (auth.response) {
    return auth.response;
  }

  const maintenanceResponse = await blockApiV2IfMaintenance();
  if (maintenanceResponse) {
    return maintenanceResponse;
  }

  return NextResponse.json({
    status: 'ok',
    apiVersion: 'v2',
    authenticated: true,
    userId: auth.user.id,
    timestamp: new Date().toISOString(),
  });
}
