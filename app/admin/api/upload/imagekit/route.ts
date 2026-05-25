import { NextRequest, NextResponse } from 'next/server';

import { requireAdminPin } from '@/lib/admin-auth';
import { uploadToImageKit } from '@/lib/imagekit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const uploadHistory = new Map<string, number[]>();
const MAX_UPLOADS_PER_MINUTE = 10;
const MAX_UPLOADS_PER_HOUR = 120;

function requesterKey(request: NextRequest) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'admin'
  );
}

function cleanOldEntries(key: string) {
  const now = Date.now();
  const uploads = uploadHistory.get(key) || [];
  const filtered = uploads.filter((timestamp) => now - timestamp < 3600000);

  if (filtered.length > 0) {
    uploadHistory.set(key, filtered);
  } else {
    uploadHistory.delete(key);
  }
}

function rateLimitError(key: string): string | null {
  const now = Date.now();
  cleanOldEntries(key);

  const uploads = uploadHistory.get(key) || [];
  const uploadsLastMinute = uploads.filter(
    (timestamp) => now - timestamp < 60000,
  ).length;
  const uploadsLastHour = uploads.length;

  if (uploadsLastMinute >= MAX_UPLOADS_PER_MINUTE) {
    return `Rate limit exceeded: max ${MAX_UPLOADS_PER_MINUTE} uploads/minute.`;
  }

  if (uploadsLastHour >= MAX_UPLOADS_PER_HOUR) {
    return `Rate limit exceeded: max ${MAX_UPLOADS_PER_HOUR} uploads/hour.`;
  }

  return null;
}

function recordUpload(key: string) {
  const uploads = uploadHistory.get(key) || [];
  uploads.push(Date.now());
  uploadHistory.set(key, uploads);
}

function sanitizeFolder(value: FormDataEntryValue | null): string {
  const folder =
    typeof value === 'string' && value.trim() ? value.trim() : 'admin';
  return folder.replace(/[^a-zA-Z0-9/_-]/g, '').replace(/^\/+/, '') || 'admin';
}

export async function POST(request: NextRequest) {
  try {
    const pinError = requireAdminPin(request);
    if (pinError) return pinError;

    const key = requesterKey(request);
    const rateError = rateLimitError(key);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 429 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const folder = sanitizeFolder(formData.get('folder'));

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!file.type.startsWith('image/')) {
      return NextResponse.json(
        { error: 'Only image uploads are allowed.' },
        { status: 400 },
      );
    }

    if (file.size > 12 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Image must be 12 MB or smaller.' },
        { status: 400 },
      );
    }

    const result = await uploadToImageKit({
      file,
      folder,
      prefix: 'glenn_admin',
      tags: ['glenn-admin', folder],
    });

    recordUpload(key);

    return NextResponse.json({
      success: true,
      url: result.url,
      fileId: result.fileId,
      filePath: result.filePath,
    });
  } catch (error) {
    console.error('Admin ImageKit upload error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
