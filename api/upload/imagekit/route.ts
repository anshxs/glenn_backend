import { NextRequest, NextResponse } from 'next/server';

// Route segment config
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Rate limiting storage (in-memory, consider Redis for production)
const uploadHistory = new Map<string, number[]>();

// Rate limits
const MAX_UPLOADS_PER_MINUTE = 5;
const MAX_UPLOADS_PER_HOUR = 50;

// Clean old entries from upload history
function cleanOldEntries(userId: string) {
  const now = Date.now();
  const userUploads = uploadHistory.get(userId) || [];
  
  // Remove entries older than 1 hour
  const filtered = userUploads.filter(timestamp => now - timestamp < 3600000);
  
  if (filtered.length > 0) {
    uploadHistory.set(userId, filtered);
  } else {
    uploadHistory.delete(userId);
  }
}

// Check if rate limit is exceeded
function isRateLimitExceeded(userId: string): { exceeded: boolean; message?: string } {
  const now = Date.now();
  cleanOldEntries(userId);
  
  const userUploads = uploadHistory.get(userId) || [];
  
  // Check uploads in last minute
  const uploadsLastMinute = userUploads.filter(timestamp => now - timestamp < 60000).length;
  if (uploadsLastMinute >= MAX_UPLOADS_PER_MINUTE) {
    return { 
      exceeded: true, 
      message: `Rate limit exceeded: ${uploadsLastMinute} uploads in last minute. Max is ${MAX_UPLOADS_PER_MINUTE}/minute.` 
    };
  }
  
  // Check uploads in last hour
  const uploadsLastHour = userUploads.filter(timestamp => now - timestamp < 3600000).length;
  if (uploadsLastHour >= MAX_UPLOADS_PER_HOUR) {
    return { 
      exceeded: true, 
      message: `Rate limit exceeded: ${uploadsLastHour} uploads in last hour. Max is ${MAX_UPLOADS_PER_HOUR}/hour.` 
    };
  }
  
  return { exceeded: false };
}

// Record upload attempt
function recordUpload(userId: string) {
  const now = Date.now();
  const userUploads = uploadHistory.get(userId) || [];
  userUploads.push(now);
  uploadHistory.set(userId, userUploads);
}

/**
 * POST /api/upload/imagekit
 * Securely upload images to ImageKit.io
 * 
 * Required environment variables:
 * - IMAGEKIT_PRIVATE_KEY
 * - IMAGEKIT_PUBLIC_KEY
 * - IMAGEKIT_URL_ENDPOINT
 */
export async function POST(request: NextRequest) {
  try {
    // Get ImageKit credentials from environment (server-side only)
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
    const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;

    if (!privateKey || !publicKey || !urlEndpoint) {
      console.error('ImageKit credentials not configured');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const folder = (formData.get('folder') as string) || 'avatars';
    const userId = formData.get('userId') as string;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Rate limiting check
    if (userId) {
      const rateLimitCheck = isRateLimitExceeded(userId);
      if (rateLimitCheck.exceeded) {
        return NextResponse.json(
          { error: rateLimitCheck.message },
          { status: 429 }
        );
      }
    }

    // Generate unique filename
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
    const uniqueFileName = `${timestamp}_${sanitizedName}`;

    // Convert file to buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Prepare ImageKit upload
    const uploadFormData = new FormData();
    // Create blob with proper type
    const blob = new Blob([buffer], { type: file.type || 'application/octet-stream' });
    uploadFormData.append('file', blob, uniqueFileName);
    uploadFormData.append('fileName', uniqueFileName);
    uploadFormData.append('folder', `/${folder}`);
    uploadFormData.append('useUniqueFileName', 'false'); // We're already making it unique
    uploadFormData.append('tags', `glenn-app,${folder}`);

    // Upload to ImageKit with Basic Auth
    const auth = Buffer.from(`${privateKey}:`).toString('base64');
    const uploadResponse = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
      body: uploadFormData,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('ImageKit upload failed:', uploadResponse.status, errorText);
      return NextResponse.json(
        { error: 'Upload failed', details: errorText },
        { status: uploadResponse.status }
      );
    }

    const result = await uploadResponse.json();

    // Record successful upload for rate limiting
    if (userId) {
      recordUpload(userId);
    }

    console.log('Successfully uploaded to ImageKit:', result.url);

    return NextResponse.json({
      success: true,
      url: result.url,
      fileId: result.fileId,
      name: result.name,
      size: result.size,
      filePath: result.filePath,
    });

  } catch (error) {
    console.error('Error in ImageKit upload API:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/upload/imagekit
 * Get rate limit status for a user
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');

  if (!userId) {
    return NextResponse.json(
      { error: 'userId parameter required' },
      { status: 400 }
    );
  }

  const now = Date.now();
  const userUploads = uploadHistory.get(userId) || [];
  
  const uploadsLastMinute = userUploads.filter(timestamp => now - timestamp < 60000).length;
  const uploadsLastHour = userUploads.filter(timestamp => now - timestamp < 3600000).length;

  return NextResponse.json({
    userId,
    uploadsLastMinute,
    maxUploadsPerMinute: MAX_UPLOADS_PER_MINUTE,
    uploadsLastHour,
    maxUploadsPerHour: MAX_UPLOADS_PER_HOUR,
    remainingMinute: Math.max(0, MAX_UPLOADS_PER_MINUTE - uploadsLastMinute),
    remainingHour: Math.max(0, MAX_UPLOADS_PER_HOUR - uploadsLastHour),
  });
}
