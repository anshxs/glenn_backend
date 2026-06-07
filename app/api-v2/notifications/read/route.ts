import { NextRequest, NextResponse } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type MarkNotificationsReadBody = {
  notification_id?: unknown;
  notification_ids?: unknown;
  mark_all?: unknown;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseNotificationIds(body: MarkNotificationsReadBody) {
  const ids = new Set<string>();

  if (
    typeof body.notification_id === 'string' &&
    UUID_REGEX.test(body.notification_id)
  ) {
    ids.add(body.notification_id);
  }

  if (Array.isArray(body.notification_ids)) {
    for (const value of body.notification_ids) {
      if (typeof value === 'string' && UUID_REGEX.test(value)) {
        ids.add(value);
      }
    }
  }

  return [...ids].slice(0, 200);
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<MarkNotificationsReadBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    const markAll = parsed.data?.mark_all === true;
    const notificationIds = parseNotificationIds(parsed.data ?? {});

    if (!markAll && notificationIds.length === 0) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          message: 'notification_id or notification_ids is required.',
        },
        { status: 400 },
      );
    }

    let query = supabaseAdmin
      .from('user_notifications')
      .update({ is_read: true })
      .eq('user_id', auth.user.id)
      .eq('is_read', false);

    if (!markAll) {
      query = query.in('id', notificationIds);
    }

    const { data, error } = await query.select('id');
    if (error) throw error;

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data: {
        marked_read_count: data?.length ?? 0,
        notification_ids: data?.map((row) => row.id) ?? [],
      },
      userId: auth.user.id,
    });
  } catch (error) {
    console.error('Notifications read API v2 error:', error);
    return NextResponse.json(
      {
        error: 'Notification update failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to update notifications.',
      },
      { status: 500 },
    );
  }
}
