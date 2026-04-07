import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TransferPayload = {
  amount?: unknown;
};

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function wholeRupeeAmount(value: number): number {
  return Math.floor(Math.max(value, 0));
}

export async function GET(request: NextRequest) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const [{ data: organiser, error: organiserErr }, { data: wallet, error: walletErr }] =
      await Promise.all([
        supabaseAdmin
          .from('organisers')
          .select('balance')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabaseAdmin
          .from('wallets')
          .select('balance, allow_withdrawals, fraud_reason')
          .eq('user_id', user.id)
          .maybeSingle(),
      ]);

    if (organiserErr) {
      return NextResponse.json(
        { error: 'Failed to fetch organiser account', details: organiserErr.message },
        { status: 500 }
      );
    }

    if (walletErr) {
      return NextResponse.json(
        { error: 'Failed to fetch Glenn wallet', details: walletErr.message },
        { status: 500 }
      );
    }

    const isOrganiser = Boolean(organiser);
    const walletBalance = roundCurrency(Number(wallet?.balance ?? 0));
    const organiserBalance = roundCurrency(Number(organiser?.balance ?? 0));
    const transfersEnabled =
      wallet?.allow_withdrawals === true &&
      String(wallet?.fraud_reason ?? '').trim().isEmpty;
    const transferableBalance =
      isOrganiser && transfersEnabled ? wholeRupeeAmount(walletBalance) : 0;

    let disabledReason: string | null = null;
    if (isOrganiser) {
      if (!wallet) {
        disabledReason = 'Your Glenn wallet is not ready yet.';
      } else if (!transfersEnabled) {
        disabledReason = 'Transfers from your Glenn wallet are disabled right now.';
      } else if (transferableBalance < 1) {
        disabledReason = 'At least ₹1 whole balance is needed to transfer.';
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        is_organiser: isOrganiser,
        wallet_balance: walletBalance,
        organiser_balance: organiserBalance,
        transferable_balance: transferableBalance,
        wallet_transfer_allowed: isOrganiser && transfersEnabled,
        disabled_reason: disabledReason,
      },
    });
  } catch (error) {
    console.error('wallet organiser-transfer GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const body = (await request.json()) as TransferPayload;
    const rawAmount = body.amount;
    const parsedAmount =
      typeof rawAmount === 'number'
        ? rawAmount
        : typeof rawAmount === 'string'
          ? Number.parseFloat(rawAmount)
          : Number.NaN;
    const amount = roundCurrency(parsedAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        {
          error: 'Invalid amount',
          message: 'Enter a valid amount greater than zero.',
        },
        { status: 400 }
      );
    }

    if (!Number.isInteger(amount)) {
      return NextResponse.json(
        {
          error: 'Invalid amount',
          message: 'Only whole rupee amounts can be transferred.',
        },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin.rpc(
      'transfer_wallet_balance_to_organiser',
      {
        p_user_id: user.id,
        p_amount: amount,
      }
    );

    if (error) {
      const message = error.message ?? 'Unable to move money to organiser balance.';
      const loweredMessage = message.toLowerCase();

      if (loweredMessage.includes('only approved organisers')) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            message: 'Only approved organisers can transfer money into organiser balance.',
          },
          { status: 403 }
        );
      }

      if (
        loweredMessage.includes('transfers are disabled') ||
        loweredMessage.includes('glenn wallet not found')
      ) {
        return NextResponse.json(
          {
            error: 'Transfer unavailable',
            message:
              loweredMessage.includes('glenn wallet not found')
                ? 'Your Glenn wallet is not ready right now.'
                : 'Transfers from your Glenn wallet are disabled right now.',
          },
          { status: 403 }
        );
      }

      if (
        loweredMessage.includes('greater than zero') ||
        loweredMessage.includes('whole rupee') ||
        loweredMessage.includes('available glenn wallet balance')
      ) {
        return NextResponse.json(
          { error: 'Invalid amount', message },
          { status: 400 }
        );
      }

      console.error('wallet organiser-transfer POST RPC error:', error);
      return NextResponse.json(
        {
          error: 'Transfer failed',
          message: 'Unable to move money to organiser balance right now.',
        },
        { status: 500 }
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    const transferredAmount = wholeRupeeAmount(Number(row?.transferred_amount ?? amount));
    const walletBalance = roundCurrency(Number(row?.wallet_balance ?? 0));
    const organiserBalance = roundCurrency(Number(row?.organiser_balance ?? 0));
    const transferableBalance = wholeRupeeAmount(Number(row?.transferable_balance ?? 0));

    return NextResponse.json({
      success: true,
      message: `₹${transferredAmount} moved to your organiser wallet successfully.`,
      data: {
        transferred_amount: transferredAmount,
        wallet_balance: walletBalance,
        organiser_balance: organiserBalance,
        transferable_balance: transferableBalance,
      },
    });
  } catch (error) {
    console.error('wallet organiser-transfer POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
