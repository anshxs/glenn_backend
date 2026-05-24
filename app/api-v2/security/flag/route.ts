import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';
import { flagOrganiserSecurityEvent } from '@/lib/organiser-security-flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SecurityFlagPayload = {
  endpoint?: unknown;
  flag_type?: unknown;
  reason?: unknown;
  severity?: unknown;
  should_block?: unknown;
  metadata?: unknown;
  security_context?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function POST(request: NextRequest) {
  try {
    let bodyText = '';
    let body: SecurityFlagPayload = {};

    try {
      const parsed = await readGlennJsonBody<SecurityFlagPayload>(request);
      bodyText = parsed.bodyForSignature;
      body = parsed.data;
    } catch (error) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to parse Glenn payload.',
        },
        { status: 400 },
      );
    }

    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText,
      allowBlockedDevice: true,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const user = await verifyBearerToken(request.headers.get('Authorization'));
    const flagType =
      typeof body.flag_type === 'string' && body.flag_type.trim()
        ? body.flag_type.trim()
        : null;
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : null;

    if (!flagType || !reason) {
      return NextResponse.json(
        {
          error: 'Invalid payload',
          message: 'flag_type and reason are required.',
        },
        { status: 400 },
      );
    }

    const endpoint =
      typeof body.endpoint === 'string' && body.endpoint.trim()
        ? body.endpoint.trim()
        : '/app-launch';
    const severity =
      body.severity === 'low' ||
      body.severity === 'medium' ||
      body.severity === 'high' ||
      body.severity === 'critical'
        ? body.severity
        : 'high';

    await flagOrganiserSecurityEvent({
      app: 'glenn',
      request,
      organiserId: user?.id ?? null,
      endpoint,
      flagType,
      reason,
      severity,
      shouldBlock: body.should_block === true,
      securityContext: asRecord(body.security_context),
      metadata: asRecord(body.metadata) ?? {},
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('API v2 Glenn security flag error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
