import { randomUUID } from 'crypto';

function getImageKitConfig() {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('IMAGEKIT_PRIVATE_KEY is not configured');
  }

  return { privateKey };
}

export async function uploadToImageKit(params: {
  file: File;
  folder: string;
  prefix?: string;
  tags?: string[];
}) {
  const { privateKey } = getImageKitConfig();
  const { file, folder, prefix = 'file', tags = [] } = params;

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileName = `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}_${sanitized}`;

  const formData = new FormData();
  const blob = new Blob([buffer], { type: file.type || 'application/octet-stream' });

  formData.append('file', blob, fileName);
  formData.append('fileName', fileName);
  formData.append('folder', folder.startsWith('/') ? folder : `/${folder}`);
  formData.append('useUniqueFileName', 'false');

  if (tags.length > 0) {
    formData.append('tags', tags.join(','));
  }

  const auth = Buffer.from(`${privateKey}:`).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
      },
      body: formData,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('ImageKit upload timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ImageKit upload failed: ${response.status} ${body}`);
  }

  const payload = await response.json();

  return {
    url: payload.url as string,
    fileId: payload.fileId as string,
    filePath: payload.filePath as string,
  };
}
