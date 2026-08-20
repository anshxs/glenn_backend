import crypto from 'crypto';

interface GoogleVerifierKeysResponse {
  keys?: Array<{
    keyId: number;
    pem?: string;
    base64?: string;
  }>;
}

let cachedKeys: GoogleVerifierKeysResponse | null = null;
let lastKeysFetchTime = 0;
const KEYS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchGoogleAdMobVerifierKeys(): Promise<GoogleVerifierKeysResponse> {
  const now = Date.now();
  if (cachedKeys && now - lastKeysFetchTime < KEYS_CACHE_TTL_MS) {
    return cachedKeys;
  }

  try {
    const res = await fetch('https://www.gstatic.com/admob/reward/verifier-keys.json', {
      headers: { 'User-Agent': 'Glenn-SSV-Verifier/1.0' },
      next: { revalidate: 86400 },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch AdMob verifier keys: ${res.statusText}`);
    }
    const data = (await res.json()) as GoogleVerifierKeysResponse;
    cachedKeys = data;
    lastKeysFetchTime = now;
    return data;
  } catch (error) {
    console.error('Error fetching Google AdMob verifier keys:', error);
    if (cachedKeys) return cachedKeys;
    return { keys: [] };
  }
}

export async function verifyAdMobSSVSignature(
  searchParams: URLSearchParams,
  rawQueryString: string,
): Promise<{ isValid: boolean; reason?: string }> {
  const signature = searchParams.get('signature');
  const keyId = searchParams.get('key_id');

  if (!signature || !keyId) {
    return { isValid: false, reason: 'Missing signature or key_id' };
  }

  const keysData = await fetchGoogleAdMobVerifierKeys();
  const matchedKey = keysData.keys?.find(
    (k) => k.keyId.toString() === keyId.toString(),
  );

  if (!matchedKey || !matchedKey.pem) {
    return { isValid: false, reason: `Unknown key_id: ${keyId}` };
  }

  try {
    // Reconstruct message without signature and key_id query parameters
    // Google specifies the query string before `&signature=` is the signed content.
    let contentToVerify = rawQueryString;
    const sigIndex = rawQueryString.indexOf('&signature=');
    if (sigIndex !== -1) {
      contentToVerify = rawQueryString.substring(0, sigIndex);
    } else {
      const sigIndexFirst = rawQueryString.indexOf('signature=');
      if (sigIndexFirst !== -1) {
        contentToVerify = rawQueryString.substring(0, sigIndexFirst);
      }
    }

    // Fallback: If query string manipulation is needed
    if (!contentToVerify) {
      const filtered = new URLSearchParams();
      for (const [key, value] of searchParams.entries()) {
        if (key !== 'signature' && key !== 'key_id') {
          filtered.append(key, value);
        }
      }
      contentToVerify = filtered.toString();
    }

    // Normalize base64url signature to base64
    const normalizedSignature = signature
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const signatureBuffer = Buffer.from(normalizedSignature, 'base64');

    const verifier = crypto.createVerify('SHA256');
    verifier.update(contentToVerify);
    verifier.end();

    const isValid = verifier.verify(matchedKey.pem, signatureBuffer);
    return { isValid };
  } catch (error) {
    console.error('Error during crypto signature verification:', error);
    return {
      isValid: false,
      reason: error instanceof Error ? error.message : 'Signature verification failed',
    };
  }
}
