import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verifyToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

export async function POST(request: NextRequest) {
  try {
    const authenticatedUserId = await verifyToken(request.headers.get('Authorization'));
    if (!authenticatedUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json() as Record<string, unknown>;
    const requestedUserId =
      typeof body.userId === 'string' ? body.userId : null;
    const amount = body.amount;
    const withdrawalMethod =
      typeof body.withdrawalMethod === 'string' ? body.withdrawalMethod : null;
    const accountDetails =
      body.accountDetails && typeof body.accountDetails === 'object'
        ? body.accountDetails
        : {};
    const userId = authenticatedUserId;

    // Never trust a client-supplied userId.
    if (requestedUserId !== null && requestedUserId !== authenticatedUserId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Validate required fields
    if (
      amount === null ||
      amount === undefined ||
      (typeof amount !== 'string' && typeof amount !== 'number') ||
      !withdrawalMethod
    ) {
      return NextResponse.json(
        { error: 'Missing required fields: amount, withdrawalMethod' },
        { status: 400 }
      );
    }

    // Validate withdrawal method
    const validMethods = ['UPI', 'BANK', 'GIFTCARD'];
    if (!validMethods.includes(withdrawalMethod)) {
      return NextResponse.json(
        { error: 'Invalid withdrawal method. Must be UPI, BANK, or GIFTCARD' },
        { status: 400 }
      );
    }

    // Fixed platform fee for all withdrawal methods
    const platformFee = 1.0;

    // Validate amount
    const withdrawAmount =
      typeof amount === 'number' ? amount : Number.parseFloat(amount);
    if (isNaN(withdrawAmount) || withdrawAmount < 1) {
      return NextResponse.json(
        { error: 'Invalid amount. Minimum withdrawal is ₹1' },
        { status: 400 }
      );
    }

    const totalDeduction = withdrawAmount + platformFee;

    // Get user's wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      console.error('Wallet fetch error:', walletError);
      return NextResponse.json(
        { error: 'Failed to fetch wallet' },
        { status: 500 }
      );
    }

    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet not found' },
        { status: 404 }
      );
    }

    // Check if user can withdraw
    if (!wallet.allow_withdrawals) {
      return NextResponse.json(
        { error: wallet.fraud_reason || 'Withdrawals are disabled for this account' },
        { status: 403 }
      );
    }

    // Check sufficient balance
    if (wallet.balance < totalDeduction) {
      return NextResponse.json(
        { error: `Insufficient balance. Required: ₹${totalDeduction.toFixed(2)} (including ₹${platformFee} fee)` },
        { status: 400 }
      );
    }

    const maxWithdrawAmount = Number(wallet.balance) - platformFee;
    if (withdrawAmount > maxWithdrawAmount) {
      return NextResponse.json(
        {
          error: `Invalid amount. Maximum withdrawal is ₹${maxWithdrawAmount.toFixed(2)} so the ₹${platformFee.toFixed(2)} platform fee is also covered.`,
        },
        { status: 400 }
      );
    }

    // Calculate expected payout date (1 working day from now)
    const expectedPayoutDate = new Date();
    expectedPayoutDate.setDate(expectedPayoutDate.getDate() + 1);
    // If it's Friday, Saturday, or Sunday, add extra days
    const dayOfWeek = expectedPayoutDate.getDay();
    if (dayOfWeek === 6) { // Saturday
      expectedPayoutDate.setDate(expectedPayoutDate.getDate() + 2);
    } else if (dayOfWeek === 0) { // Sunday
      expectedPayoutDate.setDate(expectedPayoutDate.getDate() + 1);
    }

    // Create withdrawal transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        wallet_id: wallet.id,
        amount: -withdrawAmount, // Negative for withdrawal
        transaction_type: 'WITHDRAWAL',
        payment_status: 'pending',
        old_balance: wallet.balance,
        new_balance: wallet.balance - totalDeduction,
        platform_fee: platformFee,
        withdrawal_method: withdrawalMethod,
        withdrawal_account_details: accountDetails || {},
        expected_payout_date: expectedPayoutDate.toISOString(),
        payment_metadata: {
          withdrawal_method: withdrawalMethod,
          platform_fee: platformFee,
          net_amount: withdrawAmount,
          total_deduction: totalDeduction,
          requested_at: new Date().toISOString(),
          description: `${withdrawalMethod} withdrawal of ₹${withdrawAmount}`,
        },
      })
      .select()
      .single();

    if (txError) {
      console.error('Transaction creation error:', txError);
      return NextResponse.json(
        { error: `Failed to create withdrawal transaction: ${txError.message || JSON.stringify(txError)}` },
        { status: 500 }
      );
    }

    // Update wallet balance
    const { error: updateError } = await supabase
      .from('wallets')
      .update({
        balance: wallet.balance - totalDeduction,
        last_updated: new Date().toISOString(),
      })
      .eq('id', wallet.id);

    if (updateError) {
      console.error('Wallet update error:', updateError);
      // Rollback transaction
      await supabase
        .from('transactions')
        .delete()
        .eq('id', transaction.id);
      
      return NextResponse.json(
        { error: `Failed to update wallet balance: ${updateError.message || JSON.stringify(updateError)}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      transaction: {
        id: transaction.id,
        amount: withdrawAmount,
        platformFee,
        totalDeduction,
        withdrawalMethod,
        expectedPayoutDate: expectedPayoutDate.toISOString(),
        status: 'PENDING',
      },
      message: `Withdrawal request submitted successfully. You will receive ₹${withdrawAmount} within 1 working day.`,
    });

  } catch (error) {
    console.error('Withdrawal creation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
