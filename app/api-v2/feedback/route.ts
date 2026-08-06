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

type FeedbackBody = {
  category?: unknown;
  title?: unknown;
  message?: unknown;
};

const ALLOWED_CATEGORIES = new Set([
  'feedback',
  'idea',
  'bug',
  'feature_request',
  'child_safety',
  'other',
]);

function cleanText(value: unknown, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<FeedbackBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    const category =
      typeof parsed.data?.category === 'string' &&
      ALLOWED_CATEGORIES.has(parsed.data.category)
        ? parsed.data.category
        : 'other';
    const title = cleanText(parsed.data?.title, 120);
    const message = cleanText(parsed.data?.message, 2000);

    if (!title || !message) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Title and message are required.' },
        { status: 400 },
      );
    }

    const { data, error } = await supabaseAdmin
      .from('user_feedback')
      .insert({
        user_id: auth.user.id,
        category,
        title,
        message,
      })
      .select('id, user_id, category, title, message, created_at')
      .single();

    if (error) throw error;

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data,
      userId: auth.user.id,
    });
  } catch (error) {
    console.error('Feedback API v2 error:', error);
    return NextResponse.json(
      {
        error: 'Feedback submit failed',
        message:
          error instanceof Error ? error.message : 'Unable to submit feedback.',
      },
      { status: 500 },
    );
  }
}
