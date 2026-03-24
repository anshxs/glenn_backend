import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
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
      .filter((row) => row.status === 'pending')
      .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

    return NextResponse.json({
      success: true,
      data: {
        balance: Number(organiser.balance ?? 0),
        pending_liability: Math.round(pendingLiability * 100) / 100,
        transactions: enrichedTransactions,
      },
    });
  } catch (error) {
    console.error('organiser transactions GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
