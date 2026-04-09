import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import {
  readOrganiserJsonBody,
  verifyOrganiserRequestSecurity,
} from '@/lib/organiser-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TransferPayload = {
  amount?: unknown;
  direction?: unknown;
};

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function wholeRupeeAmount(value: number): number {
  return Math.floor(Math.max(value, 0));
}

export async function GET(request: NextRequest) {
  try {
    const securityError = await verifyOrganiserRequestSecurity(request);
    if (securityError) {
      return securityError;
    }

    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const { data: organiser, error: organiserErr } = await supabaseAdmin
      .from('organisers')
      .select('balance')
      .eq('user_id', user.id)
      .maybeSingle();

    if (organiserErr || !organiser) {
      return NextResponse.json(
        { error: 'Only approved organisers can view organiser transactions' },
        { status: 403 }
      );
    }

    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from('wallets')
      .select('balance, allow_withdrawals, fraud_reason')
      .eq('user_id', user.id)
      .maybeSingle();

    if (walletErr) {
      return NextResponse.json(
        { error: 'Failed to fetch Glenn wallet', details: walletErr.message },
        { status: 500 }
      );
    }

    const { data: transactions, error: transactionsErr } = await supabaseAdmin
      .from('organiser_transactions')
      .select('id, organiser_id, amount, type, description, tournament_id, created_at, status, updated_at')
      .eq('organiser_id', user.id)
      .order('created_at', { ascending: false });

    if (transactionsErr) {
      return NextResponse.json(
        { error: 'Failed to fetch organiser transactions', details: transactionsErr.message },
        { status: 500 }
      );
    }

    const tournamentIds = Array.from(
      new Set((transactions ?? []).map((row) => String(row.tournament_id ?? '')).filter(Boolean))
    );

    let tournamentNameMap = new Map<string, string>();
    if (tournamentIds.length > 0) {
      const { data: tournaments, error: tournamentsErr } = await supabaseAdmin
        .from('tournaments')
        .select('id, tournament_name')
        .in('id', tournamentIds);

      if (tournamentsErr) {
        return NextResponse.json(
          { error: 'Failed to fetch organiser transaction tournaments', details: tournamentsErr.message },
          { status: 500 }
        );
      }

      tournamentNameMap = new Map(
        (tournaments ?? []).map((row) => [
          String(row.id),
          String(row.tournament_name ?? ''),
        ])
      );
    }

    const enrichedTransactions = (transactions ?? []).map((row) => ({
      ...row,
      tournament_name: row.tournament_id
        ? (tournamentNameMap.get(String(row.tournament_id)) ?? null)
        : null,
    }));

    const pendingLiability = enrichedTransactions
      .filter((row) => row.status === 'pending' && row.type === 'commission')
      .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const balance = Number(organiser.balance ?? 0);
    const transferableBalance = wholeRupeeAmount(balance - pendingLiability);
    const glennWalletBalance = roundCurrency(Number(wallet?.balance ?? 0));
    const canImportFromGlenn =
      wallet?.allow_withdrawals === true &&
      String(wallet?.fraud_reason ?? '').trim() === '';
    const importableBalance = canImportFromGlenn
      ? wholeRupeeAmount(glennWalletBalance)
      : 0;

    let glennImportDisabledReason: string | null = null;
    if (!wallet) {
      glennImportDisabledReason = 'Your Glenn wallet is not ready yet.';
    } else if (!canImportFromGlenn) {
      glennImportDisabledReason =
        'Transfers from your Glenn wallet are disabled right now.';
    } else if (importableBalance < 1) {
      glennImportDisabledReason =
        'At least ₹1 whole balance is needed to import.';
    }

    return NextResponse.json({
      success: true,
      data: {
        balance,
        pending_liability: Math.round(pendingLiability * 100) / 100,
        transferable_balance: transferableBalance,
        glenn_wallet_balance: glennWalletBalance,
        importable_balance: importableBalance,
        glenn_import_allowed: canImportFromGlenn,
        glenn_import_disabled_reason: glennImportDisabledReason,
        transactions: enrichedTransactions,
      },
    });
  } catch (error) {
    console.error('organiser transactions GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    let bodyText = '';
    let body: TransferPayload = {};

    try {
      const parsed = await readOrganiserJsonBody<TransferPayload>(request);
      bodyText = parsed.bodyForSignature;
      body = parsed.data;
    } catch {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          message: 'Unable to read the transfer request.',
        },
        { status: 400 }
      );
    }

    const securityError = await verifyOrganiserRequestSecurity(request, {
      bodyText,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const rawAmount = body.amount;
    const direction =
      typeof body.direction === 'string' ? body.direction.trim() : 'to_glenn';
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

    if (direction !== 'to_glenn' && direction !== 'from_glenn') {
      return NextResponse.json(
        {
          error: 'Invalid transfer direction',
          message: 'Unsupported wallet transfer direction.',
        },
        { status: 400 }
      );
    }

    const rpcName =
      direction === 'from_glenn'
        ? 'transfer_wallet_balance_to_organiser'
        : 'transfer_organiser_balance_to_wallet';

    const { data, error } = await supabaseAdmin.rpc(rpcName, {
      p_user_id: user.id,
      p_amount: amount,
    });

    if (error) {
      const message = error.message ?? 'Unable to move organiser balance.';
      const loweredMessage = message.toLowerCase();

      if (loweredMessage.includes('only approved organisers')) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            message:
              direction === 'from_glenn'
                ? 'Only approved organisers can import money from Glenn wallet.'
                : 'Only approved organisers can transfer organiser balance.',
          },
          { status: 403 }
        );
      }

      if (loweredMessage.includes('deposits are disabled')) {
        return NextResponse.json(
          { error: 'Deposits disabled', message: 'Deposits are disabled for your Glenn wallet right now.' },
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
        loweredMessage.includes('exceeds available organiser balance') ||
        loweredMessage.includes('exceeds available glenn wallet balance') ||
        loweredMessage.includes('greater than zero') ||
        loweredMessage.includes('whole rupee')
      ) {
        return NextResponse.json(
          { error: 'Invalid amount', message },
          { status: 400 }
        );
      }

      console.error('organiser transactions POST RPC error:', error);
      return NextResponse.json(
        {
          error: 'Transfer failed',
          message:
            direction === 'from_glenn'
              ? 'Unable to import money from your Glenn wallet right now.'
              : 'Unable to move money to your Glenn wallet right now.',
        },
        { status: 500 }
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    const transferredAmount = wholeRupeeAmount(Number(row?.transferred_amount ?? amount));
    const organiserBalance = roundCurrency(Number(row?.organiser_balance ?? 0));
    const reservedBalance = roundCurrency(Number(row?.reserved_balance ?? 0));
    const transferableBalance = wholeRupeeAmount(Number(row?.transferable_balance ?? 0));
    const walletBalance = roundCurrency(Number(row?.wallet_balance ?? 0));

    return NextResponse.json({
      success: true,
      message:
        direction === 'from_glenn'
          ? `₹${transferredAmount} imported from your Glenn wallet successfully.`
          : `₹${transferredAmount} moved to your Glenn wallet successfully.`,
      data: {
        transferred_amount: transferredAmount,
        organiser_balance: organiserBalance,
        reserved_balance: reservedBalance,
        transferable_balance: transferableBalance,
        wallet_balance: walletBalance,
        direction,
      },
    });
  } catch (error) {
    console.error('organiser transactions POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
