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

// Helper function to calculate required slots based on team type
function calculateRequiredSlots(tournamentType: string, teamMembersCount: number): number {
  switch (tournamentType) {
    case 'solo':
      return 1;
    case 'duo':
      return Math.ceil(teamMembersCount / 2) || 1;
    case 'squad':
      return Math.ceil(teamMembersCount / 4) || 1;
    default:
      return 1;
  }
}

// Helper function to get team size
function getTeamSize(teamMembers: Record<string, any>): number {
  return Object.keys(teamMembers).length + 1; // +1 for the participant themselves
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

    // 6. Check if tournament has already started
    const tournamentDateTime = new Date(tournament.tournament_datetime);
    const now = new Date();
    if (tournamentDateTime <= now) {
      return NextResponse.json(
        { error: 'Tournament already started', message: 'Cannot register for a tournament that has already started' },
        { status: 400 }
      );
    }

    // 7. Calculate team size and required slots
    const teamSize = team_members ? getTeamSize(team_members) : 1;
    const requiredSlots = calculateRequiredSlots(tournament.type, teamSize);

    // 8. Check if enough slots are available
    if (tournament.slotsleft < requiredSlots) {
      return NextResponse.json(
        { error: 'Insufficient slots', message: `Not enough slots available. Required: ${requiredSlots}, Available: ${tournament.slotsleft}` },
        { status: 400 }
      );
    }

    // 9. Team size validation removed - any team size allowed

    // 10. Check if user is already registered for this tournament
    const { data: existingParticipant } = await supabaseAdmin
      .from('tournament_participants')
      .select('id')
      .eq('tournament_id', tournament_id)
      .eq('participant_id', participant_id)
      .single();

    if (existingParticipant) {
      return NextResponse.json(
        { error: 'Already registered', message: 'You are already registered for this tournament' },
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
      return NextResponse.json(
        { error: 'Wallet not found', message: 'User wallet does not exist' },
        { status: 404 }
      );
    }

    // 12. Check if user has sufficient balance
    if (wallet.balance < amount) {
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
        transaction_type: 'TOURNAMENT_FEE_PAY',
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
      .single();

    const nextSlotNumber = maxSlotData?.slot_number ? maxSlotData.slot_number + 1 : 1;

    // 16. Add participant to tournament
    const { data: participant, error: participantError } = await supabaseAdmin
      .from('tournament_participants')
      .insert({
        tournament_id: tournament_id,
        participant_id: participant_id,
        team_members: team_members,
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

      console.error('Participant creation error:', participantError);
      return NextResponse.json(
        { error: 'Registration failed', message: participantError.message || 'Failed to register for tournament' },
        { status: 500 }
      );
    }

    // 16. Update tournament slots (this should be handled by trigger, but we'll do it manually too)
    const { error: slotUpdateError } = await supabaseAdmin
      .from('tournaments')
      .update({ slotsleft: tournament.slotsleft - requiredSlots })
      .eq('id', tournament_id);

    if (slotUpdateError) {
      console.error('Slot update error (non-critical):', slotUpdateError);
      // Don't rollback for this, as triggers might handle it
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

    // 18. Get user's OneSignal player ID and send notification
    const { data: userNotifications } = await supabaseAdmin
      .from('notifications')
      .select('onesignal_player_id, is_notifications_enabled')
      .eq('user_id', user_id)
      .maybeSingle();

    // Store notification in database
    const { data: notificationData, error: notificationInsertError } = await supabaseAdmin
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
        sent: false,
      })
      .select('id')
      .single();

    if (notificationInsertError) {
      console.error('Failed to store notification:', notificationInsertError);
      // Don't fail the request if notification storage fails
    }

    // Send push notification if user has OneSignal player ID and notifications enabled
    if (userNotifications?.onesignal_player_id && userNotifications?.is_notifications_enabled) {
      sendTournamentNotification(
        [userNotifications.onesignal_player_id],
        tournament.tournament_name
      ).then(async () => {
        // Mark notification as sent only if push notification succeeded
        if (notificationData?.id) {
          await supabaseAdmin
            .from('user_notifications')
            .update({ sent: true })
            .eq('id', notificationData.id);
          console.log('Tournament notification marked as sent in database');
        }
      }).catch(err => {
        console.error('Push notification failed - not marking as sent:', err.message || err);
        // Notification remains sent: false in database for potential retry
      });
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
          slots_remaining: tournament.slotsleft - requiredSlots,
          new_wallet_balance: newBalance
        }
      },
      { status: 200 }
    );

  } catch (error) {
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
