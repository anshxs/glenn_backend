import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { ParticipateRequest, Tournament, Wallet } from '@/lib/types';

// Route segment config
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Helper function to verify JWT token
async function verifyToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);

  try {
    // Verify the token using Supabase Admin
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    
    if (error || !user) {
      return null;
    }

    return user.id;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Helper function to calculate required player slots.
// Slots are counted per player, not per team.
function calculateRequiredSlots(tournamentType: string, teamMembersCount: number): number {
  switch (tournamentType) {
    case 'solo':
      return 1;
    case 'duo':
      // Duo always reserves at least 2 player slots.
      return Math.max(2, teamMembersCount);
    case 'squad':
      // Squad always reserves at least 4 player slots.
      return Math.max(4, teamMembersCount);
    default:
      return 1;
  }
}

// Helper function to get team size
function getTeamSize(teamMembers: Record<string, any>): number {
  return Object.keys(teamMembers).length + 1; // +1 for the participant themselves
}

function validateTeamSizeForType(tournamentType: string, teamSize: number): string | null {
  switch (tournamentType) {
    case 'solo':
      return teamSize === 1 ? null : 'Solo tournament allows exactly 1 player';
    case 'duo':
      return teamSize <= 2 ? null : 'Duo tournament allows maximum 2 players';
    case 'squad':
      return teamSize <= 4 ? null : 'Squad tournament allows maximum 4 players';
    default:
      return 'Invalid tournament type';
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Helper function to send OneSignal tournament notification
async function sendTournamentNotification(
  playerIds: string[],
  tournamentName: string
): Promise<void> {
  const oneSignalAppId = process.env.ONESIGNAL_APP_ID;
  const oneSignalRestKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!oneSignalAppId || !oneSignalRestKey) {
    console.error('OneSignal credentials not configured');
    throw new Error('OneSignal credentials not configured');
  }

  if (!playerIds || playerIds.length === 0) {
    console.log('No player IDs to send notification to');
    throw new Error('No player IDs provided');
  }

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${oneSignalRestKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: oneSignalAppId,
        include_player_ids: playerIds,
        headings: { en: 'Registration Successful! 🎮' },
        contents: { en: `You are registered for ${tournamentName}` },
        data: {
          type: 'tournament_registration',
          tournament_name: tournamentName,
        },
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('OneSignal notification error:', result);
      throw new Error(`OneSignal API error: ${JSON.stringify(result)}`);
    }

    // Check if the response contains errors (OneSignal returns 200 even with errors)
    if (result.errors) {
      console.error('OneSignal notification failed:', result);
      throw new Error(`OneSignal notification errors: ${JSON.stringify(result.errors)}`);
    }

    // Success - notification was sent
    console.log('Tournament notification sent successfully:', result);
  } catch (error) {
    console.error('Failed to send OneSignal notification:', error);
    throw error; // Re-throw to prevent marking as sent
  }
}

export async function POST(request: NextRequest) {
  let reservedSlots = 0;
  let reservedTournamentId: string | null = null;
  let updatedSlotsLeftAfterReservation: number | null = null;

  try {
    // 1. Verify authentication
    const authHeader = request.headers.get('Authorization');
    const authenticatedUserId = await verifyToken(authHeader);

    if (!authenticatedUserId) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    // 2. Parse request body
    const body: ParticipateRequest = await request.json();
    const { amount, user_id, tournament_id, participant_id, team_members, team_name } = body;
    const normalizedTeamMembers = team_members ?? {};

    // 3. Validate that the authenticated user matches the user_id in the request
    if (authenticatedUserId !== user_id || authenticatedUserId !== participant_id) {
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

    // 8. Calculate player count and required slots.
    // Required slots represent reserved player capacity.
    const teamSize = getTeamSize(normalizedTeamMembers);
    const teamSizeValidationError = validateTeamSizeForType(tournament.type, teamSize);
    if (teamSizeValidationError) {
      return NextResponse.json(
        { error: 'Invalid team size', message: teamSizeValidationError },
        { status: 400 }
      );
    }

    const requiredSlots = calculateRequiredSlots(tournament.type, teamSize);

    // Extract valid app-user UUIDs from team_members keys only.
    // Keys like "member1" are ignored as requested.
    const teammateUuidKeys = Object.keys(normalizedTeamMembers).filter(isUuid);

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

    // 10. Atomically reserve required player slots.
    // This prevents race conditions where concurrent requests overbook.
    const expectedSlotsLeft = tournament.slotsleft;
    const targetSlotsLeft = expectedSlotsLeft - requiredSlots;

    if (targetSlotsLeft < 0) {
      return NextResponse.json(
        {
          error: 'Insufficient slots',
          message: `Not enough slots available. Required: ${requiredSlots}, Available: ${expectedSlotsLeft}`,
        },
        { status: 400 }
      );
    }

    const { data: reservedTournamentRows, error: reserveSlotsError } = await supabaseAdmin
      .from('tournaments')
      .update({ slotsleft: targetSlotsLeft })
      .eq('id', tournament_id)
      .eq('slotsleft', expectedSlotsLeft)
      .gte('slotsleft', requiredSlots)
      .select('slotsleft');

    if (reserveSlotsError) {
      console.error('Slot reservation error:', reserveSlotsError);
      return NextResponse.json(
        { error: 'Registration failed', message: 'Could not reserve tournament slots' },
        { status: 500 }
      );
    }

    if (!reservedTournamentRows || reservedTournamentRows.length === 0) {
      return NextResponse.json(
        {
          error: 'Insufficient slots',
          message: `Not enough slots available. Required: ${requiredSlots}, Available may have changed due to concurrent registrations`,
        },
        { status: 400 }
      );
    }

    reservedSlots = requiredSlots;
    reservedTournamentId = tournament_id;
    updatedSlotsLeftAfterReservation = reservedTournamentRows[0]?.slotsleft ?? targetSlotsLeft;

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

    // 12. Check if user has sufficient balance
    if (wallet.balance < amount) {
      if (reservedSlots > 0 && reservedTournamentId) {
        await supabaseAdmin
          .from('tournaments')
          .update({ slotsleft: (updatedSlotsLeftAfterReservation ?? 0) + reservedSlots })
          .eq('id', reservedTournamentId)
          .eq('slotsleft', updatedSlotsLeftAfterReservation ?? 0);
      }
      return NextResponse.json(
        { 
          error: 'Insufficient balance', 
          message: `Insufficient funds in wallet. Required: ${amount}, Available: ${wallet.balance}` 
        },
        { status: 400 }
      );
    }

    // 13. Begin transaction - Deduct from wallet
    const oldBalance = wallet.balance;
    const newBalance = oldBalance - amount;

    const { error: walletUpdateError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
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
        transaction_type: 'TOURNAMENT_ENTRY',
        related_tournament_id: tournament_id,
        old_balance: oldBalance,
        new_balance: newBalance
      })
      .select()
      .single();

    if (transactionError) {
      // Rollback wallet update
      await supabaseAdmin
        .from('wallets')
        .update({ balance: oldBalance })
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
        team_members: normalizedTeamMembers,
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
        .update({ balance: oldBalance })
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

    // 16b. For duo/squad, add additional rows for app users in team_members.
    // Non-app placeholders like member1/member2 are skipped.
    const additionalParticipantIds = allAppParticipantIds.filter((id) => id !== participant_id);
    if (additionalParticipantIds.length > 0) {
      const additionalRows = additionalParticipantIds.map((id) => ({
        tournament_id,
        participant_id: id,
        team_members: normalizedTeamMembers,
        fee_paid: 0,
        team_name: team_name || (tournament.type === 'solo' ? null : 'Squad Team'),
        transaction_id: transaction.id,
        slot_number: nextSlotNumber,
      }));

      const { error: additionalParticipantsError } = await supabaseAdmin
        .from('tournament_participants')
        .insert(additionalRows);

      if (additionalParticipantsError) {
        // Roll back all related writes if team participant insertion fails.
        await supabaseAdmin
          .from('tournament_participants')
          .delete()
          .eq('transaction_id', transaction.id);

        await supabaseAdmin
          .from('transactions')
          .delete()
          .eq('id', transaction.id);

        await supabaseAdmin
          .from('wallets')
          .update({ balance: oldBalance })
          .eq('id', wallet.id);

        if (reservedSlots > 0 && reservedTournamentId) {
          await supabaseAdmin
            .from('tournaments')
            .update({ slotsleft: (updatedSlotsLeftAfterReservation ?? 0) + reservedSlots })
            .eq('id', reservedTournamentId)
            .eq('slotsleft', updatedSlotsLeftAfterReservation ?? 0);
        }

        return NextResponse.json(
          { error: 'Registration failed', message: additionalParticipantsError.message || 'Failed to add team members' },
          { status: 500 }
        );
      }
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

    // 18. Get user's OneSignal player ID
    const { data: userNotifications } = await supabaseAdmin
      .from('notifications')
      .select('onesignal_player_id, is_notifications_enabled')
      .eq('user_id', user_id)
      .maybeSingle();

    // Send push first, then insert a single user_notifications row with final sent state.
    let pushSent = false;
    if (userNotifications?.onesignal_player_id && userNotifications?.is_notifications_enabled) {
      try {
        await Promise.race([
          sendTournamentNotification(
            [userNotifications.onesignal_player_id],
            tournament.tournament_name
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('push_timeout')), 1500)),
        ]);
        pushSent = true;
      } catch (err) {
        console.error('Push notification failed:', err);
        pushSent = false;
      }
    }

    const { error: notificationInsertError } = await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_id: user_id,
        type: 'tournament_registration',
        title: 'Registration Successful! 🎮',
        message: `You are registered for ${tournament.tournament_name}`,
        data: {
          tournament_id: tournament_id,
          tournament_name: tournament.tournament_name,
          participant_id: participant.id,
          slot_number: participant.slot_number,
        },
        is_read: false,
        sent: pushSent,
      });

    if (notificationInsertError) {
      console.error('Failed to store notification:', notificationInsertError);
    }

    // 19. Return success response
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
          new_wallet_balance: newBalance
        }
      },
      { status: 200 }
    );

  } catch (error) {
    if (reservedSlots > 0 && reservedTournamentId && updatedSlotsLeftAfterReservation != null) {
      await supabaseAdmin
        .from('tournaments')
        .update({ slotsleft: updatedSlotsLeftAfterReservation + reservedSlots })
        .eq('id', reservedTournamentId)
        .eq('slotsleft', updatedSlotsLeftAfterReservation)
        .catch(() => null);
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
