import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { verifyGlennRequestSecurity } from '@/lib/glenn-request-security';
import { uploadToImageKit } from '@/lib/imagekit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const uploadHistory = new Map<string, number[]>();
const MAX_UPLOADS_PER_MINUTE = 5;
const MAX_UPLOADS_PER_HOUR = 50;

function cleanOldEntries(userId: string) {
  const now = Date.now();
  const userUploads = uploadHistory.get(userId) || [];
  const filtered = userUploads.filter((timestamp) => now - timestamp < 3600000);

  if (filtered.length > 0) {
    uploadHistory.set(userId, filtered);
  } else {
    uploadHistory.delete(userId);
  }
}

function rateLimitStatus(userId: string) {
  const now = Date.now();
  cleanOldEntries(userId);

  const userUploads = uploadHistory.get(userId) || [];
  const uploadsLastMinute = userUploads.filter(
    (timestamp) => now - timestamp < 60000,
  ).length;
  const uploadsLastHour = userUploads.filter(
    (timestamp) => now - timestamp < 3600000,
  ).length;

  return {
    uploadsLastMinute,
    uploadsLastHour,
    maxUploadsPerMinute: MAX_UPLOADS_PER_MINUTE,
    maxUploadsPerHour: MAX_UPLOADS_PER_HOUR,
    remainingMinute: Math.max(0, MAX_UPLOADS_PER_MINUTE - uploadsLastMinute),
    remainingHour: Math.max(0, MAX_UPLOADS_PER_HOUR - uploadsLastHour),
  };
}

function rateLimitError(userId: string): string | null {
  const status = rateLimitStatus(userId);

  if (status.uploadsLastMinute >= MAX_UPLOADS_PER_MINUTE) {
    return `Rate limit exceeded: ${status.uploadsLastMinute} uploads in last minute. Max is ${MAX_UPLOADS_PER_MINUTE}/minute.`;
  }

  if (status.uploadsLastHour >= MAX_UPLOADS_PER_HOUR) {
    return `Rate limit exceeded: ${status.uploadsLastHour} uploads in last hour. Max is ${MAX_UPLOADS_PER_HOUR}/hour.`;
  }

  return null;
}

function recordUpload(userId: string) {
  const userUploads = uploadHistory.get(userId) || [];
  userUploads.push(Date.now());
  uploadHistory.set(userId, userUploads);
}

function sanitizeFolder(value: FormDataEntryValue | null): string {
  const folder = typeof value === 'string' && value.trim() ? value.trim() : 'avatars';
  return folder.replace(/[^a-zA-Z0-9/_-]/g, '').replace(/^\/+/, '') || 'avatars';
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const folder = sanitizeFolder(formData.get('folder'));
    const requestedUserId = formData.get('userId');
    const securityBody = JSON.stringify({
      folder,
      user_id: typeof requestedUserId === 'string' ? requestedUserId : '',
      file_name: file instanceof File ? file.name : '',
      file_size: file instanceof File ? file.size : null,
    });

    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: securityBody,
    });
    if (securityError) {
      return securityError;
    }

    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          message: 'Invalid or missing authentication token.',
        },
        { status: 401 },
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 },
      );
    }

    if (!file.type.startsWith('image/')) {
      return NextResponse.json(
        { error: 'Only image uploads are allowed.' },
        { status: 400 },
      );
    }

    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Image must be 8 MB or smaller.' },
        { status: 400 },
      );
    }

    if (
      typeof requestedUserId === 'string' &&
      requestedUserId.trim().length > 0 &&
      requestedUserId !== user.id
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rateError = rateLimitError(user.id);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 429 });
    }

    const result = await uploadToImageKit({
      file,
      folder,
      prefix: 'glenn',
      tags: ['glenn-app', folder],
    });

    recordUpload(user.id);

    return NextResponse.json({
      success: true,
      url: result.url,
      fileId: result.fileId,
      filePath: result.filePath,
    });
  } catch (error) {
    console.error('API v2 ImageKit upload error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const securityError = await verifyGlennRequestSecurity(request);
  if (securityError) {
    return securityError;
  }

  const user = await verifyBearerToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json(
      {
        error: 'Unauthorized',
        message: 'Invalid or missing authentication token.',
      },
      { status: 401 },
    );
  }

  return NextResponse.json({
    userId: user.id,
    ...rateLimitStatus(user.id),
  });
}
