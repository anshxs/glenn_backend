import { NextRequest, NextResponse } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<Record<string, never>>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    return NextResponse.json(
      {
        error: 'Conversion disabled',
        message:
          'Glenn now uses gems only. Gem-to-money conversion is no longer available.',
      },
      { status: 410 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Conversion disabled',
        message:
          error instanceof Error
            ? error.message
            : 'Gem-to-money conversion is no longer available.',
      },
      { status: 410 },
    );
  }
}
