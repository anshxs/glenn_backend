import { NextRequest, NextResponse } from 'next/server';

import { fetchActiveAppAds, AppAdFormat } from '@/lib/app-ads';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ListAdsBody = {
  format: AppAdFormat;
  placement: string;
  limit?: number;
};

export async function POST(request: NextRequest) {
  try {
    const parsed = await readGlennJsonBody<ListAdsBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const format = parsed.data.format;
    const placement = parsed.data.placement?.trim();
    const limit = Math.min(Math.max(parsed.data.limit ?? 1, 1), 10);

    if (
      format !== 'banner' &&
      format !== 'interstitial' &&
      format !== 'rewarded' &&
      format !== 'native'
    ) {
      return NextResponse.json(
        { error: 'Invalid format', message: 'Unsupported ad format.' },
        { status: 400 },
      );
    }

    if (!placement) {
      return NextResponse.json(
        { error: 'Invalid placement', message: 'Placement is required.' },
        { status: 400 },
      );
    }

    const ads = await fetchActiveAppAds({ format, placement, limit });

    return NextResponse.json({
      data: ads.map((ad) => ({
        id: ad.id,
        provider: ad.provider,
        format: ad.format,
        placement: ad.placement,
        title: ad.title,
        body: ad.body,
        image_url: ad.image_url,
        video_url: ad.video_url,
        click_url: ad.click_url,
        cta_text: ad.cta_text,
        html_content: ad.html_content,
        metadata: ad.metadata ?? {},
        reward_amount: ad.reward_amount,
        min_view_seconds: ad.min_view_seconds,
        priority: ad.priority,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Ad fetch failed',
        message:
          error instanceof Error ? error.message : 'Unable to fetch ads.',
      },
      { status: 500 },
    );
  }
}
