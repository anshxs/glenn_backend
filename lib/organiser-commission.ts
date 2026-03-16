import { supabaseAdmin } from '@/lib/supabase';

export function defaultOrganiserCommission(hostedCount: number): number {
  if (hostedCount < 10) return 3;
  if (hostedCount < 25) return 4;
  if (hostedCount < 50) return 4.5;
  return 5;
}

export interface SyncedOrganiserCommission {
  user_id: string;
  hosted_count: number;
  organiser_commission: number;
}

// Use this from backend organiser-join / organiser-leave tournament APIs.
// It updates hosted_count atomically and only changes organiser_commission when
// the currently stored commission still matches the old rank-default value.
// Custom commission values are preserved.
export async function syncOrganiserHostedCountAndCommission(
  userId: string,
  delta: number
): Promise<SyncedOrganiserCommission> {
  const { data, error } = await supabaseAdmin.rpc('sync_organiser_hosted_count_and_commission', {
    p_user_id: userId,
    p_delta: delta,
  });

  if (error) {
    throw new Error(`Failed to sync organiser hosted count: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error('Failed to sync organiser hosted count: no data returned');
  }

  return {
    user_id: row.user_id,
    hosted_count: Number(row.hosted_count ?? 0),
    organiser_commission: Number(row.organiser_commission ?? 0),
  };
}
