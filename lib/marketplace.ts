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

export const LISTING_FEE = 50;
export const PLATFORM_FEE = 25;
export const SELLER_BONUS = 25;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MarketplaceAuth = Awaited<ReturnType<typeof requireApiV2Auth>>;

export function cleanText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function cleanStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, 500))
    .filter(Boolean)
    .slice(0, maxItems);
}

export async function readSecureMarketplaceBody<T>(request: NextRequest) {
  const auth = await requireApiV2Auth(request);
  if (auth.response) return { auth, response: auth.response };

  const parsed = await readGlennJsonBody<T>(request);
  const securityError = await verifyGlennRequestSecurity(request, {
    bodyText: parsed.bodyForSignature,
    requireEncryptedPayload: true,
  });
  if (securityError) return { auth, response: securityError };

  const maintenanceResponse = await blockApiV2IfMaintenance();
  if (maintenanceResponse) return { auth, response: maintenanceResponse };

  return { auth, parsed };
}

export async function debitWallet(
  userId: string,
  amount: number,
  reference: string,
  metadata: Record<string, unknown>,
  transactionType = 'MARKETPLACE_DEBIT',
) {
  const { data: wallet, error: walletError } = await supabaseAdmin
    .from('wallets')
    .select('id, balance')
    .eq('user_id', userId)
    .single();

  if (walletError || !wallet) {
    return {
      response: NextResponse.json(
        { error: 'Wallet unavailable', message: 'Could not load wallet.' },
        { status: 500 },
      ),
    };
  }

  const oldBalance = Number(wallet.balance);
  if (oldBalance < amount) {
    return {
      response: NextResponse.json(
        {
          error: 'Insufficient balance',
          message: `You need ₹${amount.toFixed(2)} in wallet.`,
        },
        { status: 400 },
      ),
    };
  }

  const newBalance = oldBalance - amount;
  const { data: updatedWallet, error: updateError } = await supabaseAdmin
    .from('wallets')
    .update({ balance: newBalance, last_updated: new Date().toISOString() })
    .eq('id', wallet.id)
    .gte('balance', amount)
    .select('balance')
    .maybeSingle();

  if (updateError || !updatedWallet) {
    return {
      response: NextResponse.json(
        { error: 'Payment failed', message: 'Wallet balance changed. Try again.' },
        { status: 400 },
      ),
    };
  }

  const { data: transaction, error: transactionError } = await supabaseAdmin
    .from('transactions')
    .insert({
      user_id: userId,
      wallet_id: wallet.id,
      amount: -amount,
      transaction_type: transactionType,
      old_balance: oldBalance,
      new_balance: newBalance,
      payment_status: 'completed',
      payment_reference: reference,
      payment_metadata: metadata,
    })
    .select('id')
    .single();

  if (transactionError || !transaction) {
    await supabaseAdmin
      .from('wallets')
      .update({ balance: oldBalance, last_updated: new Date().toISOString() })
      .eq('id', wallet.id);

    console.error('Marketplace debit transaction insert failed:', transactionError);
    return {
      response: NextResponse.json(
        {
          error: 'Payment failed',
          message:
            [
              transactionError?.message,
              transactionError?.details,
              transactionError?.hint,
              transactionError?.code,
            ]
              .filter(Boolean)
              .join(' | ') || 'Could not record marketplace transaction.',
        },
        { status: 500 },
      ),
    };
  }

  return { walletId: wallet.id as string, transactionId: transaction.id as string };
}

export async function creditWallet(
  userId: string,
  amount: number,
  reference: string,
  metadata: Record<string, unknown>,
  transactionType = 'MARKETPLACE_CREDIT',
) {
  const { data: wallet, error: walletError } = await supabaseAdmin
    .from('wallets')
    .select('id, balance')
    .eq('user_id', userId)
    .single();

  if (walletError || !wallet) throw walletError ?? new Error('Wallet unavailable');

  const oldBalance = Number(wallet.balance);
  const newBalance = oldBalance + amount;

  const { error: updateError } = await supabaseAdmin
    .from('wallets')
    .update({ balance: newBalance, last_updated: new Date().toISOString() })
    .eq('id', wallet.id);

  if (updateError) throw updateError;

  const { data: transaction, error: transactionError } = await supabaseAdmin
    .from('transactions')
    .insert({
      user_id: userId,
      wallet_id: wallet.id,
      amount,
      transaction_type: transactionType,
      old_balance: oldBalance,
      new_balance: newBalance,
      payment_status: 'completed',
      payment_reference: reference,
      payment_metadata: metadata,
    })
    .select('id')
    .single();

  if (transactionError || !transaction) throw transactionError;
  return transaction.id as string;
}

export async function logMarketplaceEvent(
  eventType: string,
  params: {
    listingId?: string | null;
    orderId?: string | null;
    actorId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await supabaseAdmin.from('marketplace_events').insert({
    event_type: eventType,
    listing_id: params.listingId ?? null,
    order_id: params.orderId ?? null,
    actor_id: params.actorId ?? null,
    metadata: params.metadata ?? {},
  });
}
