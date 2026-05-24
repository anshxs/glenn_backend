import { NextRequest } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';
import { POST as legacyParticipatePost } from '@/app/api/participate/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireApiV2Auth(request);
  if (auth.response) {
    return auth.response;
  }

  const maintenanceResponse = await blockApiV2IfMaintenance();
  if (maintenanceResponse) {
    return maintenanceResponse;
  }

  // The legacy handler already performs the full encrypted-payload security
  // verification, authenticated user match, slot reservation, wallet debit,
  // participant insert, rollback, and notification logic. This v2 shell adds
  // the v2-wide guards while the registration transaction is migrated safely.
  return legacyParticipatePost(request);
}
