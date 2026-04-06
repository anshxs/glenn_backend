import { NextRequest, NextResponse } from 'next/server';

import { verifyBearerToken } from '@/lib/auth';
import { verifyOrganiserRequestSecurity } from '@/lib/organiser-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ tournamentId: string }>;
};

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

async function restoreTournamentAssignment(params: {
  tournamentId: string;
  organiserId: string;
  organiserName: string | null;
  organiserContact: string | null;
}) {
  const { tournamentId, organiserId, organiserName, organiserContact } = params;

  await supabaseAdmin
    .from('tournaments')
    .update({
      organiser_id: organiserId,
      organiser_name: organiserName,
      organiser_contact: organiserContact,
    })
    .eq('id', tournamentId)
    .is('organiser_id', null);
}

// ── POST – host a tournament ──────────────────────────────────────────────────
export async function POST(request: NextRequest, context: RouteContext) {
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

    const { tournamentId } = await context.params;

    const { data: organiser, error: organiserErr } = await supabaseAdmin
      .from('organisers')
      .select('name, contact_number, balance')
      .eq('user_id', user.id)
      .maybeSingle();

    if (organiserErr || !organiser) {
      return NextResponse.json(
        { error: 'Only approved organisers can host tournaments' },
        { status: 403 }
      );
    }

    const { data: tournament, error: tournamentErr } = await supabaseAdmin
      .from('tournaments')
      .select(
        'id, tournament_name, organiser_id, registration_allowed, tournament_datetime, organiser_commission'
      )
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

    const commissionAmount = roundCurrency(Number(tournament.organiser_commission ?? 0));
    if (commissionAmount < 0) {
      return NextResponse.json(
        { error: 'Tournament organiser commission cannot be negative' },
        { status: 400 }
      );
    }

    const currentBalance = Number(organiser.balance ?? 0);

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

    const existingPendingAmount = (pendingTransactions ?? []).reduce(
      (sum, row) => sum + Number(row.amount ?? 0),
      0
    );
    const requiredMinimumBalance = roundCurrency(existingPendingAmount + commissionAmount);

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

    const { data: assignedTournament, error: updateTournamentErr } = await supabaseAdmin
      .from('tournaments')
      .update({
        organiser_id: user.id,
        organiser_name: organiser.name,
        organiser_contact: organiser.contact_number,
      })
      .eq('id', tournamentId)
      .is('organiser_id', null)
      .select('id')
      .maybeSingle();

    if (updateTournamentErr) {
      return NextResponse.json(
        { error: 'Failed to assign organiser to tournament', message: updateTournamentErr.message },
        { status: 500 }
      );
    }

    if (!assignedTournament) {
      return NextResponse.json(
        { error: 'Tournament already has an organiser' },
        { status: 409 }
      );
    }

    const { error: transactionInsertErr } = await supabaseAdmin
      .from('organiser_transactions')
      .insert({
        organiser_id: user.id,
        amount: commissionAmount,
        type: 'commission',
        description: `Pending hosting commission for tournament: ${tournament.tournament_name}`,
        tournament_id: tournamentId,
        status: 'pending',
      });

    if (transactionInsertErr) {
      await supabaseAdmin
        .from('tournaments')
        .update({
          organiser_id: null,
          organiser_name: null,
          organiser_contact: null,
        })
        .eq('id', tournamentId)
        .eq('organiser_id', user.id);

      return NextResponse.json(
        {
          error: 'Failed to create organiser transaction',
          message: transactionInsertErr.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Tournament assigned to organiser successfully',
      data: {
        commission_amount: commissionAmount,
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

    const { tournamentId } = await context.params;

    const { data: organiser, error: organiserErr } = await supabaseAdmin
      .from('organisers')
      .select('name, contact_number, balance')
      .eq('user_id', user.id)
      .maybeSingle();

    if (organiserErr || !organiser) {
      return NextResponse.json(
        { error: 'Only approved organisers can unregister tournaments' },
        { status: 403 }
      );
    }

    const { data: tournament, error: tournamentErr } = await supabaseAdmin
      .from('tournaments')
      .select(
        'id, tournament_name, organiser_id, organiser_name, organiser_contact, results_submitted, organiser_commission'
      )
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

    const penaltyAmount = roundCurrency(Number(tournament.organiser_commission ?? 0));
    if (penaltyAmount < 0) {
      return NextResponse.json(
        { error: 'Tournament organiser commission cannot be negative' },
        { status: 400 }
      );
    }

    const currentBalance = Number(organiser.balance ?? 0);
    const newBalance = roundCurrency(currentBalance - penaltyAmount);
    const pendingCommissionDescription =
      `Pending hosting commission for tournament: ${tournament.tournament_name}`;
    const failedCommissionDescription =
      `Failed hosting commission for tournament: ${tournament.tournament_name}`;

    const { data: pendingCommissionTransactions, error: pendingCommissionTransactionsErr } =
      await supabaseAdmin
        .from('organiser_transactions')
        .select('id')
        .eq('organiser_id', user.id)
        .eq('tournament_id', tournamentId)
        .eq('type', 'commission')
        .eq('status', 'pending');

    if (pendingCommissionTransactionsErr) {
      return NextResponse.json(
        {
          error: 'Failed to fetch organiser transaction state',
          message: pendingCommissionTransactionsErr.message,
        },
        { status: 500 }
      );
    }

    const restoreAssignment = async () => {
      await supabaseAdmin
        .from('organisers')
        .update({ balance: currentBalance })
        .eq('user_id', user.id);
      await restoreTournamentAssignment({
        tournamentId,
        organiserId: user.id,
        organiserName: tournament.organiser_name ?? organiser.name ?? null,
        organiserContact: tournament.organiser_contact ?? organiser.contact_number ?? null,
      });
    };

    const { error: updateOrganiserErr } = await supabaseAdmin
      .from('organisers')
      .update({
        balance: newBalance,
      })
      .eq('user_id', user.id);

    if (updateOrganiserErr) {
      return NextResponse.json(
        { error: 'Failed to update organiser record', message: updateOrganiserErr.message },
        { status: 500 }
      );
    }

    const { data: clearedTournament, error: updateTournamentErr } = await supabaseAdmin
      .from('tournaments')
      .update({
        organiser_id: null,
        organiser_name: null,
        organiser_contact: null,
      })
      .eq('id', tournamentId)
      .eq('organiser_id', user.id)
      .select('id')
      .maybeSingle();

    if (updateTournamentErr) {
      await supabaseAdmin
        .from('organisers')
        .update({ balance: currentBalance })
        .eq('user_id', user.id);

      return NextResponse.json(
        { error: 'Failed to clear organiser from tournament', message: updateTournamentErr.message },
        { status: 500 }
      );
    }

    if (!clearedTournament) {
      await supabaseAdmin
        .from('organisers')
        .update({ balance: currentBalance })
        .eq('user_id', user.id);

      return NextResponse.json(
        { error: 'You are not the organiser of this tournament' },
        { status: 403 }
      );
    }

    const { error: failPendingErr } = await supabaseAdmin
      .from('organiser_transactions')
      .update({
        status: 'failed',
        description: failedCommissionDescription,
      })
      .eq('organiser_id', user.id)
      .eq('tournament_id', tournamentId)
      .eq('type', 'commission')
      .eq('status', 'pending');

    if (failPendingErr) {
      await restoreAssignment();

      return NextResponse.json(
        {
          error: 'Failed to update organiser transactions',
          message: failPendingErr.message,
        },
        { status: 500 }
      );
    }

    if (penaltyAmount > 0) {
      const { error: penaltyInsertErr } = await supabaseAdmin
        .from('organiser_transactions')
        .insert({
          organiser_id: user.id,
          amount: penaltyAmount,
          type: 'penalty',
          description:
            `Unregister penalty for tournament: ${tournament.tournament_name} ` +
            `(fixed organiser commission forfeited)`,
          tournament_id: tournamentId,
          status: 'pending',
        });

      if (penaltyInsertErr) {
        await restoreAssignment();

        const pendingIds = (pendingCommissionTransactions ?? [])
          .map((row) => row.id)
          .filter((id): id is string => Boolean(id));

        if (pendingIds.length > 0) {
          await supabaseAdmin
            .from('organiser_transactions')
            .update({
              status: 'pending',
              description: pendingCommissionDescription,
            })
            .in('id', pendingIds);
        }

        return NextResponse.json(
          {
            error: 'Failed to create penalty transaction',
            message: penaltyInsertErr.message,
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Tournament unregistered successfully',
      data: {
        penalty_amount: penaltyAmount,
        balance: newBalance,
      },
    });
  } catch (error) {
    console.error('organiser host tournament DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
