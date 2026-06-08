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

type ClaimBody = {
  task_key?: unknown;
};

const ALLOWED_BODY_KEYS = new Set(['task_key']);
const ALLOWED_TASK_KEYS = new Set([
  'daily_like_post',
  'daily_dm_friend',
  'first_community_post',
  'team_builder_profile',
  'first_follow_user',
  'follow_glenn_instagram',
  'follow_whatsapp_channel',
]);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<ClaimBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    if (
      !Object.keys(parsed.data as Record<string, unknown>).every((key) =>
        ALLOWED_BODY_KEYS.has(key),
      )
    ) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Unsupported task fields.' },
        { status: 400 },
      );
    }

    const taskKey = parsed.data.task_key?.toString().trim();
    if (!taskKey || !ALLOWED_TASK_KEYS.has(taskKey)) {
      return NextResponse.json(
        { error: 'Invalid task', message: 'Choose a valid earn task.' },
        { status: 400 },
      );
    }

    const { data, error } = await supabaseAdmin.rpc(
      'claim_earn_task_reward_for_user',
      {
        p_user_id: auth.user.id,
        p_task_key: taskKey,
      },
    );

    if (error || !data) {
      return NextResponse.json(
        {
          error: 'Claim failed',
          message: error?.message ?? 'Unable to claim task reward.',
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data,
      userId: auth.user.id,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Claim failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to claim task reward.',
      },
      { status: 400 },
    );
  }
}
