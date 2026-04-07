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
    const transferableBalance = wholeRupeeAmount(
      balance - pendingLiability
    );

    return NextResponse.json({
      success: true,
      data: {
        balance,
        pending_liability: Math.round(pendingLiability * 100) / 100,
        transferable_balance: transferableBalance,
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
      'transfer_organiser_balance_to_wallet',
      {
        p_user_id: user.id,
        p_amount: amount,
      }
    );

    if (error) {
      const message = error.message ?? 'Unable to move organiser balance.';
      const loweredMessage = message.toLowerCase();

      if (loweredMessage.includes('only approved organisers')) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Only approved organisers can transfer organiser balance.' },
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
        loweredMessage.includes('exceeds available organiser balance') ||
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
          message: 'Unable to move money to your Glenn wallet right now.',
        },
        { status: 500 }
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    const transferredAmount = wholeRupeeAmount(
      Number(row?.transferred_amount ?? amount)
    );
    const organiserBalance = roundCurrency(Number(row?.organiser_balance ?? 0));
    const reservedBalance = roundCurrency(Number(row?.reserved_balance ?? 0));
    const transferableBalance = wholeRupeeAmount(
      Number(row?.transferable_balance ?? 0)
    );
    const walletBalance = roundCurrency(Number(row?.wallet_balance ?? 0));

    return NextResponse.json({
      success: true,
      message: `₹${transferredAmount} moved to your Glenn wallet successfully.`,
      data: {
        transferred_amount: transferredAmount,
        organiser_balance: organiserBalance,
        reserved_balance: reservedBalance,
        transferable_balance: transferableBalance,
        wallet_balance: walletBalance,
      },
    });
  } catch (error) {
    console.error('organiser transactions POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
