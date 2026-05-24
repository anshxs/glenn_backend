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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ConvertGemsBody = {
  gems?: unknown;
};

const ALLOWED_BODY_KEYS = new Set(['gems']);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    const parsed = await readGlennJsonBody<ConvertGemsBody>(request);
    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText: parsed.bodyForSignature,
      requireEncryptedPayload: true,
    });
    if (securityError) return securityError;

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) return maintenanceResponse;

    if (
      !Object.keys(parsed.data as Record<string, unknown>).every((key) =>
        ALLOWED_BODY_KEYS.has(key),
      )
    ) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Unsupported conversion fields.' },
        { status: 400 },
      );
    }

    const gems =
      typeof parsed.data.gems === 'number'
        ? parsed.data.gems
        : Number.parseInt(parsed.data.gems?.toString() ?? '', 10);

    if (!Number.isInteger(gems) || gems <= 0) {
      return NextResponse.json(
        { error: 'Invalid gems', message: 'Enter a valid gem amount.' },
        { status: 400 },
      );
    }

    if (gems % 100 !== 0) {
      return NextResponse.json(
        {
          error: 'Conversion failed',
          message: 'Conversion is only available in multiples of 100 gems.',
        },
        { status: 400 },
      );
    }

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('id, balance, coins, allow_deposits')
      .eq('user_id', auth.user.id)
      .single();

    if (walletError || !wallet) {
      return NextResponse.json(
        { error: 'Wallet unavailable', message: 'Could not load wallet.' },
        { status: 500 },
      );
    }

    if (wallet.allow_deposits !== true) {
      return NextResponse.json(
        {
          error: 'Deposits disabled',
          message: 'Deposits are currently disabled for this wallet.',
        },
        { status: 403 },
      );
    }

    if (Number(wallet.coins) < gems) {
      return NextResponse.json(
        { error: 'Not enough gems', message: 'Not enough gems to convert.' },
        { status: 400 },
      );
    }

    const moneyAdded = gems / 100;
    const oldBalance = Number(wallet.balance);
    const newBalance = oldBalance + moneyAdded;
    const newCoins = Number(wallet.coins) - gems;

    const { data: updatedWallet, error: updateError } = await supabaseAdmin
      .from('wallets')
      .update({
        balance: newBalance,
        coins: newCoins,
        last_updated: new Date().toISOString(),
      })
      .eq('id', wallet.id)
      .gte('coins', gems)
      .eq('allow_deposits', true)
      .select('balance, coins')
      .maybeSingle();

    if (updateError || !updatedWallet) {
      return NextResponse.json(
        {
          error: 'Conversion failed',
          message: updateError?.message || 'Unable to update wallet.',
        },
        { status: 500 },
      );
    }

    const { data: transaction } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: auth.user.id,
        wallet_id: wallet.id,
        amount: moneyAdded,
        transaction_type: 'GEM_TO_MONEY',
        old_balance: oldBalance,
        new_balance: Number(updatedWallet.balance),
        payment_status: 'completed',
        payment_reference: `GEM-${Date.now()}`,
        payment_metadata: {
          source: 'gems',
          gems_converted: gems,
          coins_before: wallet.coins,
          coins_after: Number(updatedWallet.coins),
          conversion_rate: '100 gems = ₹1',
        },
      })
      .select('id')
      .maybeSingle();

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      data: {
        money_added: moneyAdded,
        gems_converted: gems,
        old_balance: oldBalance,
        new_balance: Number(updatedWallet.balance),
        coins_after: Number(updatedWallet.coins),
        transaction_id: transaction?.id ?? null,
        message: `Converted ${gems} gems to ₹${moneyAdded.toFixed(2)}.`,
      },
      userId: auth.user.id,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Conversion failed',
        message:
          error instanceof Error ? error.message : 'Unable to convert gems.',
      },
      { status: 400 },
    );
  }
}
