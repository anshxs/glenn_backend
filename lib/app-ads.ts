import { supabaseAdmin } from '@/lib/supabase';

export type AppAdFormat = 'banner' | 'interstitial' | 'rewarded' | 'native';

export type AppAdRow = {
  id: string;
  provider: 'internal' | 'startio';
  format: AppAdFormat;
  placement: string;
  title: string | null;
  body: string | null;
  image_url: string | null;
  video_url: string | null;
  click_url: string | null;
  cta_text: string | null;
  html_content: string | null;
  metadata: Record<string, unknown> | null;
  reward_amount: number;
  min_view_seconds: number;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
};

function shuffleInPlace<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

export async function fetchActiveAppAds({
  format,
  placement,
  limit = 1,
}: {
  format: AppAdFormat;
  placement: string;
  limit?: number;
}): Promise<AppAdRow[]> {
  const now = Date.now();

  const { data, error } = await supabaseAdmin
    .from('app_ads')
    .select(
      'id, provider, format, placement, title, body, image_url, video_url, click_url, cta_text, html_content, metadata, reward_amount, min_view_seconds, priority, starts_at, ends_at, created_at',
    )
    .eq('provider', 'internal')
    .eq('format', format)
    .eq('is_active', true)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.max(limit * 4, 12));

  if (error) {
    throw new Error(error.message);
  }

  const eligible =
    (data as AppAdRow[] | null)?.filter((candidate) => {
      const placementMatches =
        candidate.placement === placement || candidate.placement === 'all';
      const startsAt = candidate.starts_at
        ? new Date(candidate.starts_at).getTime()
        : null;
      const endsAt = candidate.ends_at
        ? new Date(candidate.ends_at).getTime()
        : null;

      return (
        placementMatches &&
        (startsAt == null || startsAt <= now) &&
        (endsAt == null || endsAt >= now)
      );
    }) ?? [];

  shuffleInPlace(eligible);
  eligible.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return eligible.slice(0, Math.max(limit, 1));
}
