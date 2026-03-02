import { NextRequest, NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// Initialize Supabase with service role
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

interface VerifyPaymentRequest {
  transaction_id: string;
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature?: string; // Optional since Flutter SDK doesn't provide it
}

export async function POST(req: NextRequest) {
  try {
    const body: VerifyPaymentRequest = await req.json();
    const {
      transaction_id,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    } = body;

    // Validate input
    if (!transaction_id || !razorpay_payment_id || !razorpay_order_id) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Step 1: Get the pending transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select(`
        *,
        wallets (
          id,
          balance,
          user_id,
          allow_deposits
        )
      `)
      .eq('id', transaction_id)
      .eq('razorpay_order_id', razorpay_order_id)
      .single();

    if (txError || !transaction) {
      return NextResponse.json(
        { error: 'Transaction not found' },
        { status: 404 }
      );
    }

    // Check if already processed
    if (transaction.payment_status === 'verified') {
      return NextResponse.json({
        success: true,
        message: 'Payment already verified',
        transaction_id: transaction.id,
        new_balance: transaction.new_balance,
      });
    }

    if (transaction.payment_status !== 'pending') {
      return NextResponse.json(
        { error: `Transaction is ${transaction.payment_status}, cannot verify` },
        { status: 400 }
      );
    }

    // Check if deposits are still allowed
    if (!transaction.wallets.allow_deposits) {
      await supabase
        .from('transactions')
        .update({
          payment_status: 'failed',
          payment_metadata: {
            ...transaction.payment_metadata,
            error: 'Deposits not allowed for this wallet',
            failed_at: new Date().toISOString(),
          },
        })
        .eq('id', transaction_id);

      return NextResponse.json(
        { error: 'Deposits are not allowed for this wallet' },
        { status: 403 }
      );
    }

    // Step 2: Verify Razorpay signature (if provided)
    if (razorpay_signature) {
      const body_signature = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
        .update(body_signature)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        // Mark as failed
        await supabase
          .from('transactions')
          .update({
            payment_status: 'failed',
            razorpay_payment_id: razorpay_payment_id,
            razorpay_signature: razorpay_signature,
            payment_metadata: {
              ...transaction.payment_metadata,
              error: 'Signature verification failed',
              failed_at: new Date().toISOString(),
              expected_signature: expectedSignature,
              received_signature: razorpay_signature,
            },
          })
          .eq('id', transaction_id);

        return NextResponse.json(
          { error: 'Payment signature verification failed' },
          { status: 400 }
        );
      }
    }

    // Step 3: Fetch payment details from Razorpay to double-check
    let razorpayPayment;
    try {
      razorpayPayment = await razorpay.payments.fetch(razorpay_payment_id);

      // Verify payment status
      if (razorpayPayment.status !== 'captured' && razorpayPayment.status !== 'authorized') {
        throw new Error(`Payment status is ${razorpayPayment.status}`);
      }

      // Verify order_id matches
      if (razorpayPayment.order_id !== razorpay_order_id) {
        throw new Error('Order ID mismatch');
      }

      // Verify amount matches (Razorpay amount is in paise)
      const expectedAmount = Math.round(Number(transaction.amount) * 100);
      if (razorpayPayment.amount !== expectedAmount) {
        throw new Error(`Amount mismatch: expected ${expectedAmount}, got ${razorpayPayment.amount}`);
      }

    } catch (error: any) {
      console.error('Razorpay payment fetch error:', error);
      
      // Mark as failed
      await supabase
        .from('transactions')
        .update({
          payment_status: 'failed',
          razorpay_payment_id: razorpay_payment_id,
          payment_metadata: {
            ...transaction.payment_metadata,
            error: 'Payment verification with Razorpay failed',
            error_details: error.message,
            failed_at: new Date().toISOString(),
          },
        })
        .eq('id', transaction_id);

      return NextResponse.json(
        { error: 'Payment verification failed: ' + error.message },
        { status: 400 }
      );
    }

    // Step 4: Calculate new balance
    const currentBalance = Number(transaction.wallets.balance);
    const addAmount = Number(transaction.amount);
    const newBalance = currentBalance + addAmount;

    // Step 5: Update wallet balance (using optimistic locking)
    const { error: walletError } = await supabase
      .from('wallets')
      .update({
        balance: newBalance,
        last_updated: new Date().toISOString(),
      })
      .eq('id', transaction.wallet_id)
      .eq('balance', currentBalance); // Optimistic locking: only update if balance hasn't changed

    if (walletError) {
      console.error('Failed to update wallet:', walletError);
      
      // Mark transaction as failed
      await supabase
        .from('transactions')
        .update({
          payment_status: 'failed',
          payment_metadata: {
            ...transaction.payment_metadata,
            error: 'Failed to update wallet balance',
            error_details: walletError.message,
            failed_at: new Date().toISOString(),
          },
        })
        .eq('id', transaction_id);

      return NextResponse.json(
        { error: 'Failed to update wallet balance. Please contact support.' },
        { status: 500 }
      );
    }

    // Step 6: Mark transaction as verified
    const updateData: any = {
      payment_status: 'verified',
      razorpay_payment_id: razorpay_payment_id,
      new_balance: newBalance,
      payment_metadata: {
        ...transaction.payment_metadata,
        verified_at: new Date().toISOString(),
        razorpay_payment_details: {
          id: razorpayPayment.id,
          status: razorpayPayment.status,
          method: razorpayPayment.method,
          amount: razorpayPayment.amount,
          captured: razorpayPayment.captured,
          email: razorpayPayment.email,
          contact: razorpayPayment.contact,
        },
      },
    };

    // Add signature only if provided
    if (razorpay_signature) {
      updateData.razorpay_signature = razorpay_signature;
    }

    const { error: updateError } = await supabase
      .from('transactions')
      .update(updateData)
      .eq('id', transaction_id);

    if (updateError) {
      // CRITICAL: Wallet updated but transaction not marked as verified
      // This should trigger an alert for manual review
      console.error('CRITICAL ERROR: Transaction not marked as verified after wallet update', {
        transaction_id,
        user_id: transaction.user_id,
        wallet_id: transaction.wallet_id,
        amount: transaction.amount,
        error: updateError,
      });

      // Still return success since wallet was updated
      // But log this for investigation
    }

    // Optional: Send notification to user about successful payment
    // You can add your notification logic here

    return NextResponse.json({
      success: true,
      transaction_id: transaction_id,
      new_balance: newBalance,
      amount_added: addAmount,
      payment_id: razorpay_payment_id,
    });

  } catch (error: any) {
    console.error('Error verifying payment:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
