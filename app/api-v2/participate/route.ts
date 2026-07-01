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
import { ParticipateRequest, Tournament, Wallet } from '@/lib/types';

// Route segment config
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Helper function to calculate required player slots.
function calculateRequiredSlots(tournamentType: string): number {
  const normalizedType = tournamentType.trim().toLowerCase();
  switch (normalizedType) {
    case 'solo':
      return 1;
    case 'duo':
      return 2;
    case 'squad':
      return 4;
    default:
      return 1;
  }
}

// Helper function to get team size from the posted team_members payload only.
// We do not auto-add a captain; the payload is the source of truth.
function getTeamSize(teamMembers: Record<string, unknown>): number {
  if (!teamMembers || typeof teamMembers !== 'object') {
    return 0;
  }

  // Count only actual member entries; ignore stray/meta keys.
  const teammateCount = Object.values(teamMembers).filter((value) => {
    if (!value || typeof value !== 'object') return false;
    const member = value as Record<string, unknown>;
    return (
      typeof member.ffuid === 'string' ||
      typeof member.ffname === 'string' ||
      typeof member.user_id === 'string'
    );
  }).length;

  return teammateCount;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: NextRequest) {
  let reservedSlots = 0;
  let reservedTournamentId: string | null = null;
  let updatedSlotsLeftAfterReservation: number | null = null;

  try {
    // 1. Verify authentication
    const auth = await requireApiV2Auth(request);
    if (auth.response) return auth.response;

    // 2. Parse request body
    let body: ParticipateRequest;
    let bodyText = '';
    try {
      const parsed = await readGlennJsonBody<ParticipateRequest>(request);
      body = parsed.data;
      bodyText = parsed.bodyForSignature;
    } catch (error) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to parse Glenn payload.',
        },
        { status: 400 }
      );
    }

    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) {
      return maintenanceResponse;
    }

    const { amount, user_id, tournament_id, participant_id, team_members, team_name } = body;
    const rawTeamMembers = team_members ?? {};

    // 3. Validate that the authenticated user matches the user_id in the request
    if (auth.user.id !== user_id || auth.user.id !== participant_id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'User ID mismatch with authenticated user' },
        { status: 403 }
      );
    }

    // 4. Fetch tournament details
    const { data: tournament, error: tournamentError } = await supabaseAdmin
      .from('tournaments')
      .select('*')
      .eq('id', tournament_id)
      .single<Tournament>();

    if (tournamentError || !tournament) {
      return NextResponse.json(
        { error: 'Tournament not found', message: 'The specified tournament does not exist' },
        { status: 404 }
      );
    }

    if (tournament.is_external === true) {
      return NextResponse.json(
        { error: 'External registration', message: 'This tournament uses external registration.' },
        { status: 400 }
      );
    }

    // 5. Verify the amount matches the tournament entry fee
    if (amount !== tournament.entryfee) {
      return NextResponse.json(
        { error: 'Invalid amount', message: `Entry fee should be ${tournament.entryfee}` },
        { status: 400 }
      );
    }

    // 6. Check if registration is allowed for this tournament
    if (tournament.registration_allowed === false) {
      return NextResponse.json(
        { error: 'Registration closed', message: 'Registration is not allowed for this tournament' },
        { status: 400 }
      );
    }

    // 7. Check if tournament has already started
    const tournamentDateTime = new Date(tournament.tournament_datetime);
    const now = new Date();
    if (tournamentDateTime <= now) {
      return NextResponse.json(
        { error: 'Tournament already started', message: 'Cannot register for a tournament that has already started' },
        { status: 400 }
      );
    }

    // 8. Validate exact team size from payload and reserve the same number of slots.
    const teamSize = getTeamSize(rawTeamMembers);
    const requiredSlots = calculateRequiredSlots(tournament.type);

    if (teamSize !== requiredSlots) {
      return NextResponse.json(
        {
          error: 'Invalid team size',
          message:
            `Tournament type "${tournament.type}" requires exactly ${requiredSlots} ` +
            `player(s), but received ${teamSize}.`,
        },
        { status: 400 }
      );
    }

    // Extract valid app-user UUIDs from teammate keys only.
    // Keys like "member1" are ignored as requested.
    const teammateUuidKeys = Object.keys(rawTeamMembers).filter(
      (key) => key !== participant_id && isUuid(key)
    );

    let appTeammateIds: string[] = [];
    if (teammateUuidKeys.length > 0) {
      const { data: existingUsers, error: existingUsersError } = await supabaseAdmin
        .from('sensitive_userdata')
        .select('id')
        .in('id', teammateUuidKeys);

      if (!existingUsersError && existingUsers) {
        appTeammateIds = (existingUsers as Array<{ id: string }>).map((u) => u.id);
      }
    }

    // All app participants for this team registration (captain + app teammates)
    const allAppParticipantIds = Array.from(new Set([participant_id, ...appTeammateIds]));

    // 9. Check if user is already registered for this tournament
    const { data: existingParticipants } = await supabaseAdmin
      .from('tournament_participants')
      .select('id, participant_id')
      .eq('tournament_id', tournament_id)
      .in('participant_id', allAppParticipantIds);

    if (existingParticipants && existingParticipants.length > 0) {
      return NextResponse.json(
        { error: 'Already registered', message: 'One or more team members are already registered for this tournament' },
        { status: 400 }
      );
    }

    // 10. Atomically reserve required player slots with optimistic retries.
    // This prevents race-condition false negatives when slots change between read/write.
    let observedSlotsLeft = Number(tournament.slotsleft ?? 0);
    let reservationSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (observedSlotsLeft < requiredSlots) {
        return NextResponse.json(
          {
            error: 'Insufficient slots',
            message: `Not enough slots available. Required: ${requiredSlots}, Available: ${observedSlotsLeft}`,
          },
          { status: 400 }
        );
      }

      const targetSlotsLeft = observedSlotsLeft - requiredSlots;

      const { data: reservedTournamentRows, error: reserveSlotsError } = await supabaseAdmin
        .from('tournaments')
        .update({ slotsleft: targetSlotsLeft })
        .eq('id', tournament_id)
        .eq('slotsleft', observedSlotsLeft)
        .select('slotsleft');

      if (reserveSlotsError) {
        console.error('Slot reservation error:', reserveSlotsError);
        return NextResponse.json(
          { error: 'Registration failed', message: 'Could not reserve tournament slots' },
          { status: 500 }
        );
      }

      if (reservedTournamentRows && reservedTournamentRows.length > 0) {
        reservationSucceeded = true;
        reservedSlots = requiredSlots;
        reservedTournamentId = tournament_id;
        updatedSlotsLeftAfterReservation = Number(
          reservedTournamentRows[0]?.slotsleft ?? targetSlotsLeft,
        );
        break;
      }

      // Refresh current slots and retry.
      const { data: refreshedTournament, error: refreshError } = await supabaseAdmin
        .from('tournaments')
        .select('slotsleft')
        .eq('id', tournament_id)
        .maybeSingle();

      if (refreshError || !refreshedTournament) {
        return NextResponse.json(
          { error: 'Registration failed', message: 'Could not verify slot availability' },
          { status: 500 }
        );
      }

      observedSlotsLeft = Number(refreshedTournament.slotsleft ?? 0);
    }

    if (!reservationSucceeded || updatedSlotsLeftAfterReservation == null) {
      return NextResponse.json(
        {
          error: 'Insufficient slots',
          message: `Not enough slots available. Required: ${requiredSlots}, Available may have changed due to concurrent registrations`,
        },
        { status: 400 }
      );
    }

    // 11. Fetch user's wallet
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', user_id)
      .single<Wallet>();

    if (walletError || !wallet) {
      if (reservedSlots > 0 && reservedTournamentId) {
        await supabaseAdmin
          .from('tournaments')
          .update({ slotsleft: (updatedSlotsLeftAfterReservation ?? 0) + reservedSlots })
          .eq('id', reservedTournamentId)
          .eq('slotsleft', updatedSlotsLeftAfterReservation ?? 0);
      }
      return NextResponse.json(
        { error: 'Wallet not found', message: 'User wallet does not exist' },
        { status: 404 }
      );
    }

    const walletGems = Number(wallet.gems_balance ?? wallet.coins ?? 0);

    // 12. Check if user has sufficient gems
    if (walletGems < amount) {
      if (reservedSlots > 0 && reservedTournamentId) {
        await supabaseAdmin
          .from('tournaments')
          .update({ slotsleft: (updatedSlotsLeftAfterReservation ?? 0) + reservedSlots })
          .eq('id', reservedTournamentId)
          .eq('slotsleft', updatedSlotsLeftAfterReservation ?? 0);
      }
      return NextResponse.json(
        { 
          error: 'Insufficient gems', 
          message: `Insufficient gems. Required: ${amount}, Available: ${walletGems}` 
        },
        { status: 400 }
      );
    }

    // 13. Begin transaction - Deduct from wallet
    const oldBalance = Number(wallet.balance ?? 0);
    const oldGemsBalance = walletGems;
    const newGemsBalance = oldGemsBalance - amount;

    const { error: walletUpdateError } = await supabaseAdmin
      .from('wallets')
      .update({
        balance: 0,
        gems_balance: newGemsBalance,
        coins: Math.min(newGemsBalance, 2147483647),
      })
      .eq('id', wallet.id);

    if (walletUpdateError) {
      if (reservedSlots > 0 && reservedTournamentId) {
        await supabaseAdmin
          .from('tournaments')
          .update({ slotsleft: (updatedSlotsLeftAfterReservation ?? 0) + reservedSlots })
          .eq('id', reservedTournamentId)
          .eq('slotsleft', updatedSlotsLeftAfterReservation ?? 0);
      }
      console.error('Wallet update error:', walletUpdateError);
      return NextResponse.json(
        { error: 'Transaction failed', message: 'Failed to deduct amount from wallet' },
        { status: 500 }
      );
    }

    // 14. Create transaction record
    const { data: transaction, error: transactionError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: user_id,
        wallet_id: wallet.id,
        amount: -amount, // Negative because it's a deduction
        gems_amount: -amount,
        currency: 'GEMS',
        transaction_type: 'TOURNAMENT_ENTRY',
        payment_status: 'completed',
        related_tournament_id: tournament_id,
        old_balance: oldBalance,
        new_balance: 0,
        old_gems_balance: oldGemsBalance,
        new_gems_balance: newGemsBalance,
        payment_metadata: {
          source: 'tournament_entry',
          entry_fee_gems: amount,
        },
      })
      .select()
      .single();

    if (transactionError) {
      // Rollback wallet update
      await supabaseAdmin
        .from('wallets')
        .update({
          balance: oldBalance,
          gems_balance: oldGemsBalance,
          coins: Math.min(oldGemsBalance, 2147483647),
        })
        .eq('id', wallet.id);

      if (reservedSlots > 0 && reservedTournamentId) {
        await supabaseAdmin
          .from('tournaments')
          .update({ slotsleft: (updatedSlotsLeftAfterReservation ?? 0) + reservedSlots })
          .eq('id', reservedTournamentId)
          .eq('slotsleft', updatedSlotsLeftAfterReservation ?? 0);
      }

      console.error('Transaction creation error:', transactionError);
      return NextResponse.json(
        { error: 'Transaction failed', message: 'Failed to create transaction record' },
        { status: 500 }
      );
    }

    // 15. Get next slot number for this tournament
    const { data: maxSlotData } = await supabaseAdmin
      .from('tournament_participants')
      .select('slot_number')
      .eq('tournament_id', tournament_id)
      .order('slot_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextSlotNumber = maxSlotData?.slot_number ? maxSlotData.slot_number + 1 : 1;

    // 16. Add captain row to tournament
    const { data: participant, error: participantError } = await supabaseAdmin
      .from('tournament_participants')
      .insert({
        tournament_id: tournament_id,
        participant_id: participant_id,
        team_members: rawTeamMembers,
        fee_paid: amount,
        team_name: team_name || (tournament.type === 'solo' ? null : 'Squad Team'),
        transaction_id: transaction.id,
        slot_number: nextSlotNumber
      })
      .select()
      .single();

    if (participantError) {
      // Rollback transaction and wallet update
      await supabaseAdmin
        .from('transactions')
        .delete()
        .eq('id', transaction.id);

      await supabaseAdmin
        .from('wallets')
        .update({
          balance: oldBalance,
          gems_balance: oldGemsBalance,
          coins: Math.min(oldGemsBalance, 2147483647),
        })
        .eq('id', wallet.id);

      if (reservedSlots > 0 && reservedTournamentId) {
        await supabaseAdmin
          .from('tournaments')
          .update({ slotsleft: (updatedSlotsLeftAfterReservation ?? 0) + reservedSlots })
          .eq('id', reservedTournamentId)
          .eq('slotsleft', updatedSlotsLeftAfterReservation ?? 0);
      }

      console.error('Participant creation error:', participantError);
      return NextResponse.json(
        { error: 'Registration failed', message: participantError.message || 'Failed to register for tournament' },
        { status: 500 }
      );
    }

    // 17. Increment tournaments played in sensitive_userdata
    const { data: userData, error: userDataError } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('tournmentsplayed')
      .eq('id', user_id)
      .single();

    if (!userDataError && userData) {
      const { error: updateUserError } = await supabaseAdmin
        .from('sensitive_userdata')
        .update({ 
          tournmentsplayed: (userData.tournmentsplayed || 0) + 1 
        })
        .eq('id', user_id);

      if (updateUserError) {
        console.error('User data update error (non-critical):', updateUserError);
        // Don't rollback for this
      }
    }

    // 18. Return success response
    return NextResponse.json(
      {
        success: true,
        message: 'Successfully registered for tournament',
        data: {
          participant_id: participant.id,
          tournament_id: tournament_id,
          transaction_id: transaction.id,
          fee_paid: amount,
          team_name: participant.team_name,
          slot_number: participant.slot_number,
          slots_remaining: updatedSlotsLeftAfterReservation,
          new_wallet_balance: 0,
          new_gems_balance: newGemsBalance
        }
      },
      { status: 200 }
    );

  } catch (error) {
    if (reservedSlots > 0 && reservedTournamentId && updatedSlotsLeftAfterReservation != null) {
      try {
        await supabaseAdmin
          .from('tournaments')
          .update({ slotsleft: updatedSlotsLeftAfterReservation + reservedSlots })
          .eq('id', reservedTournamentId)
          .eq('slotsleft', updatedSlotsLeftAfterReservation);
      } catch {
        // Ignore rollback failure in global error handler.
      }
    }

    console.error('API Error:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error', 
        message: error instanceof Error ? error.message : 'An unexpected error occurred' 
      },
      { status: 500 }
    );
  }
}
