import crypto from 'crypto';

import { supabaseAdmin } from '@/lib/supabase';

export type GemRewardPlacement = 'daily_gem_checkin' | 'sunday_spin';
export type RewardedProvider = 'startio' | 'internal';

export type RewardedSessionRow = {
  id: string;
  user_id: string;
  placement: GemRewardPlacement;
  provider: RewardedProvider;
  ad_id: string | null;
  session_token: string;
  status: string;
  required_view_seconds: number;
  opened_at: string | null;
  completed_at: string | null;
  claimed_at: string | null;
  expires_at: string;
  ad_payload_snapshot: Record<string, unknown>;
};

type StartSessionResult = {
  session: RewardedSessionRow;
};

function nowIso(): string {
  return new Date().toISOString();
}

function chooseStatusRpc(placement: GemRewardPlacement): string {
  return placement === 'daily_gem_checkin'
    ? 'claim_daily_gem_checkin_for_user'
    : 'claim_sunday_gem_spin_for_user';
}

export async function createRewardedClaimSession({
  userId,
  placement,
  deviceId,
  buildHash,
  securityContext,
}: {
  userId: string;
  placement: GemRewardPlacement;
  deviceId: string | null;
  buildHash: string | null;
  securityContext: string | null;
}): Promise<StartSessionResult> {
  const now = new Date();

  const { data: internalAds } = await supabaseAdmin
    .from('app_ads')
    .select(
      'id, provider, format, placement, title, body, image_url, video_url, click_url, cta_text, metadata, reward_amount, min_view_seconds, priority, starts_at, ends_at',
    )
    .eq('format', 'rewarded')
    .eq('provider', 'internal')
    .eq('is_active', true)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(10);

  const internalAd =
    internalAds?.find((candidate) => {
      const startsAt = candidate.starts_at
        ? new Date(candidate.starts_at).getTime()
        : null;
      const endsAt = candidate.ends_at
        ? new Date(candidate.ends_at).getTime()
        : null;

      const placementMatches =
        candidate.placement === placement || candidate.placement === 'all';
      const afterStart = startsAt == null || startsAt <= now.getTime();
      const beforeEnd = endsAt == null || endsAt >= now.getTime();

      return placementMatches && afterStart && beforeEnd;
    }) ?? null;

  const provider: RewardedProvider = internalAd ? 'internal' : 'startio';
  const snapshot = internalAd
    ? {
        id: internalAd.id,
        title: internalAd.title,
        body: internalAd.body,
        image_url: internalAd.image_url,
        video_url: internalAd.video_url,
        click_url: internalAd.click_url,
        cta_text: internalAd.cta_text,
        metadata: internalAd.metadata ?? {},
      }
    : {};

  const { data, error } = await supabaseAdmin
    .from('rewarded_ad_claim_sessions')
    .insert({
      user_id: userId,
      placement,
      provider,
      ad_id: internalAd?.id ?? null,
      session_token: crypto.randomUUID(),
      status: 'issued',
      required_view_seconds: internalAd?.min_view_seconds ?? 0,
      security_context: {
        device_id: deviceId,
        build_hash: buildHash,
        encoded_context: securityContext,
      },
      request_metadata: {
        created_via: 'glenn_backend',
        created_at: nowIso(),
      },
      ad_payload_snapshot: snapshot,
    })
    .select(
      'id, user_id, placement, provider, ad_id, session_token, status, required_view_seconds, opened_at, completed_at, claimed_at, expires_at, ad_payload_snapshot',
    )
    .single<RewardedSessionRow>();

  if (error || !data) {
    throw new Error(error?.message ?? 'Unable to create rewarded session');
  }

  return { session: data };
}

export async function markRewardedSessionOpened({
  userId,
  sessionId,
  sessionToken,
}: {
  userId: string;
  sessionId: string;
  sessionToken: string;
}): Promise<RewardedSessionRow> {
  const { data: session, error: fetchError } = await supabaseAdmin
    .from('rewarded_ad_claim_sessions')
    .select(
      'id, user_id, placement, provider, ad_id, session_token, status, required_view_seconds, opened_at, completed_at, claimed_at, expires_at, ad_payload_snapshot',
    )
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('session_token', sessionToken)
    .maybeSingle<RewardedSessionRow>();

  if (fetchError || !session) {
    throw new Error('Rewarded ad session not found');
  }

  if (session.provider !== 'internal') {
    throw new Error('Only internal rewarded sessions can be opened explicitly');
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw new Error('Rewarded ad session expired');
  }

  if (session.status === 'opened' || session.status === 'completed') {
    return session;
  }

  const { data, error } = await supabaseAdmin
    .from('rewarded_ad_claim_sessions')
    .update({
      status: 'opened',
      opened_at: nowIso(),
    })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('session_token', sessionToken)
    .select(
      'id, user_id, placement, provider, ad_id, session_token, status, required_view_seconds, opened_at, completed_at, claimed_at, expires_at, ad_payload_snapshot',
    )
    .single<RewardedSessionRow>();

  if (error || !data) {
    throw new Error(error?.message ?? 'Unable to mark rewarded ad as opened');
  }

  return data;
}

export async function finalizeRewardedClaim({
  userId,
  sessionId,
  sessionToken,
  placement,
}: {
  userId: string;
  sessionId: string;
  sessionToken: string;
  placement: GemRewardPlacement;
}): Promise<Record<string, unknown>> {
  const { data: session, error: fetchError } = await supabaseAdmin
    .from('rewarded_ad_claim_sessions')
    .select(
      'id, user_id, placement, provider, ad_id, session_token, status, required_view_seconds, opened_at, completed_at, claimed_at, expires_at, ad_payload_snapshot',
    )
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('session_token', sessionToken)
    .maybeSingle<RewardedSessionRow>();

  if (fetchError || !session) {
    throw new Error('Rewarded ad session not found');
  }

  if (session.placement !== placement) {
    throw new Error('Rewarded ad placement mismatch');
  }

  if (session.claimed_at || session.status === 'claimed') {
    throw new Error('Rewarded ad session already consumed');
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await supabaseAdmin
      .from('rewarded_ad_claim_sessions')
      .update({ status: 'expired', failure_reason: 'session_expired' })
      .eq('id', session.id);
    throw new Error('Rewarded ad session expired');
  }

  if (session.provider === 'internal') {
    if (!session.opened_at) {
      throw new Error('Internal rewarded ad was not opened');
    }

    const openedAtMs = new Date(session.opened_at).getTime();
    const minElapsedMs = (session.required_view_seconds ?? 0) * 1000;
    if (Date.now() - openedAtMs < minElapsedMs) {
      throw new Error('Internal rewarded ad has not been viewed long enough');
    }
  }

  const completedAt = nowIso();

  const { error: sessionUpdateError } = await supabaseAdmin
    .from('rewarded_ad_claim_sessions')
    .update({
      status: 'completed',
      completed_at: completedAt,
    })
    .eq('id', session.id)
    .eq('user_id', userId)
    .eq('session_token', sessionToken)
    .in('status', ['issued', 'opened']);

  if (sessionUpdateError) {
    throw new Error(sessionUpdateError.message);
  }

  const rpcName = chooseStatusRpc(placement);
  const { data: claimData, error: claimError } = await supabaseAdmin.rpc(
    rpcName,
    { p_user_id: userId },
  );

  if (claimError || !claimData) {
    await supabaseAdmin
      .from('rewarded_ad_claim_sessions')
      .update({
        status: 'failed',
        failure_reason: claimError?.message ?? 'claim_failed',
      })
      .eq('id', session.id);
    throw new Error(claimError?.message ?? 'Unable to finalize gem claim');
  }

  const { error: claimedUpdateError } = await supabaseAdmin
    .from('rewarded_ad_claim_sessions')
    .update({
      status: 'claimed',
      claimed_at: nowIso(),
    })
    .eq('id', session.id);

  if (claimedUpdateError) {
    throw new Error(claimedUpdateError.message);
  }

  return claimData as Record<string, unknown>;
}
