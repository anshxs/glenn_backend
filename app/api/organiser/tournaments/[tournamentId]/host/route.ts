import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { defaultOrganiserCommission } from '@/lib/organiser-commission';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ tournamentId: string }>;
};

// ── POST – host a tournament ──────────────────────────────────────────────────
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const { tournamentId } = await context.params;

    // 1. Fetch organiser row
    const { data: organiser, error: organiserErr } = await supabaseAdmin
      .from('organisers')
      .select('hosted_count, organiser_commission, name, contact_number, balance')
      .eq('user_id', user.id)
      .maybeSingle();

    if (organiserErr || !organiser) {
      return NextResponse.json(
        { error: 'Only approved organisers can host tournaments' },
        { status: 403 }
      );
    }

    // 2. Fetch tournament row
    const { data: tournament, error: tournamentErr } = await supabaseAdmin
      .from('tournaments')
      .select('id, tournament_name, entryfee, totalslots, organiser_id, registration_allowed, tournament_datetime')
      .eq('id', tournamentId)
      .maybeSingle();

    if (tournamentErr || !tournament) {
      return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }

    if (tournament.organiser_id) {
      return NextResponse.json(
        { error: 'Tournament already has an organiser' },
        { status: 409 }
      );
    }

    if (!tournament.registration_allowed) {
      return NextResponse.json(
        { error: 'Tournament is not open for organiser registration' },
        { status: 400 }
      );
    }

    if (new Date(tournament.tournament_datetime) <= new Date()) {
      return NextResponse.json(
        { error: 'Cannot host a tournament that has already started' },
        { status: 400 }
      );
    }

    // 3. Compute new hosted_count and commission
    const oldCount: number = organiser.hosted_count ?? 0;
    const newCount = oldCount + 1;
    const newCommission = defaultOrganiserCommission(newCount);
    const currentBalance: number = organiser.balance ?? 0;

    const { data: pendingTransactions, error: pendingTransactionsErr } = await supabaseAdmin
      .from('organiser_transactions')
      .select('amount')
      .eq('organiser_id', user.id)
      .eq('type', 'commission')
      .eq('status', 'pending');

    if (pendingTransactionsErr) {
      return NextResponse.json(
        { error: 'Failed to verify organiser transaction balance', message: pendingTransactionsErr.message },
        { status: 500 }
      );
    }

    const entryFee: number = tournament.entryfee ?? 0;
    const totalSlots: number = tournament.totalslots ?? 0;
    const pendingAmount = Math.round(((entryFee * totalSlots * newCommission) / 100) * 100) / 100;
    const existingPendingAmount = (pendingTransactions ?? []).reduce(
      (sum, row) => sum + Number(row.amount ?? 0),
      0
    );
    const requiredMinimumBalance = Math.round((existingPendingAmount + pendingAmount) * 100) / 100;

    if (currentBalance < requiredMinimumBalance) {
      return NextResponse.json(
        {
          error: 'Insufficient organiser balance',
          message:
            `Maintain at least ₹${requiredMinimumBalance.toFixed(2)} balance to host this tournament. ` +
            `Current balance: ₹${currentBalance.toFixed(2)}.`,
        },
        { status: 400 }
      );
    }

    // 4. Update organiser
    const { error: updateOrganiserErr } = await supabaseAdmin
      .from('organisers')
      .update({ hosted_count: newCount, organiser_commission: newCommission })
      .eq('user_id', user.id);

    if (updateOrganiserErr) {
      return NextResponse.json(
        { error: 'Failed to update organiser record', message: updateOrganiserErr.message },
        { status: 500 }
      );
    }

    // 5. Assign organiser to tournament
    const { error: updateTournamentErr } = await supabaseAdmin
      .from('tournaments')
      .update({
        organiser_id: user.id,
        organiser_name: organiser.name,
        organiser_contact: organiser.contact_number,
        organiser_commission: newCommission,
      })
      .eq('id', tournamentId);

    if (updateTournamentErr) {
      return NextResponse.json(
        { error: 'Failed to assign organiser to tournament', message: updateTournamentErr.message },
        { status: 500 }
      );
    }

    // 6. Insert pending commission transaction

    await supabaseAdmin.from('organiser_transactions').insert({
      organiser_id: user.id,
      amount: pendingAmount,
      type: 'commission',
      description: `Pending hosting commission for tournament: ${tournament.tournament_name}`,
      tournament_id: tournamentId,
      status: 'pending',
    });

    return NextResponse.json({
      success: true,
      message: 'Tournament assigned to organiser successfully',
      data: {
        hosted_count: newCount,
        organiser_commission: newCommission,
        required_minimum_balance: requiredMinimumBalance,
      },
    });
  } catch (error) {
    console.error('organiser host tournament POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE – unregister from a tournament ─────────────────────────────────────
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const { tournamentId } = await context.params;

    // 1. Fetch organiser row
    const { data: organiser, error: organiserErr } = await supabaseAdmin
      .from('organisers')
      .select('hosted_count, organiser_commission, balance')
      .eq('user_id', user.id)
      .maybeSingle();

    if (organiserErr || !organiser) {
      return NextResponse.json(
        { error: 'Only approved organisers can unregister tournaments' },
        { status: 403 }
      );
    }

    // 2. Fetch tournament row
    const { data: tournament, error: tournamentErr } = await supabaseAdmin
      .from('tournaments')
      .select('id, tournament_name, organiser_id, results_submitted, entryfee, totalslots, organiser_commission')
      .eq('id', tournamentId)
      .maybeSingle();

    if (tournamentErr || !tournament) {
      return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }

    if (tournament.organiser_id !== user.id) {
      return NextResponse.json(
        { error: 'You are not the organiser of this tournament' },
        { status: 403 }
      );
    }

    if (tournament.results_submitted) {
      return NextResponse.json(
        { error: 'Cannot unregister after results are submitted' },
        { status: 400 }
      );
    }

    // 3. Compute penalty amount = what they would have earned
    const entryFee: number = tournament.entryfee ?? 0;
    const totalSlots: number = tournament.totalslots ?? 0;
    const commissionPct: number = tournament.organiser_commission ?? organiser.organiser_commission ?? 3;
    const penaltyAmount = Math.round(((entryFee * totalSlots * commissionPct) / 100) * 100) / 100;

    // 4. Decrement hosted_count by 1 and deduct penalty from balance
    const oldCount: number = organiser.hosted_count ?? 0;
    const newCount = Math.max(oldCount - 1, 0);
    const newCommission = defaultOrganiserCommission(newCount);
    const currentBalance: number = organiser.balance ?? 0;
    const newBalance = currentBalance - penaltyAmount;

    const { error: updateOrganiserErr } = await supabaseAdmin
      .from('organisers')
      .update({
        hosted_count: newCount,
        organiser_commission: newCommission,
        balance: newBalance,
      })
      .eq('user_id', user.id);

    if (updateOrganiserErr) {
      return NextResponse.json(
        { error: 'Failed to update organiser record', message: updateOrganiserErr.message },
        { status: 500 }
      );
    }

    // 5. Clear organiser from tournament
    const { error: updateTournamentErr } = await supabaseAdmin
      .from('tournaments')
      .update({
        organiser_id: null,
        organiser_name: null,
        organiser_contact: null,
        organiser_commission: 0,
      })
      .eq('id', tournamentId);

    if (updateTournamentErr) {
      return NextResponse.json(
        { error: 'Failed to clear organiser from tournament', message: updateTournamentErr.message },
        { status: 500 }
      );
    }

    // 6. Mark pending commission transactions as failed
    await supabaseAdmin
      .from('organiser_transactions')
      .update({
        status: 'failed',
        description: `Failed hosting commission for tournament: ${tournament.tournament_name}`,
      })
      .eq('organiser_id', user.id)
      .eq('tournament_id', tournamentId)
      .eq('type', 'commission')
      .eq('status', 'pending');

    // 7. Insert penalty transaction (deduct the would-have-been commission)
    if (penaltyAmount > 0) {
      await supabaseAdmin.from('organiser_transactions').insert({
        organiser_id: user.id,
        amount: penaltyAmount,
        type: 'penalty',
        description: `Unregister penalty for tournament: ${tournament.tournament_name} (forfeited ${commissionPct}% commission)`,
        tournament_id: tournamentId,
        status: 'pending',
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Tournament unregistered successfully',
      data: { hosted_count: newCount, organiser_commission: newCommission, penalty_amount: penaltyAmount },
    });
  } catch (error) {
    console.error('organiser host tournament DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
