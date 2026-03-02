import { NextRequest, NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

interface CreateOrderRequest {
  amount: number; // Amount in INR
  user_id: string;
}

export async function POST(req: NextRequest) {
  // Initialize Razorpay inside request handler
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
  try {
    const body: CreateOrderRequest = await req.json();
    const { amount, user_id } = body;

    // Validate input
    if (!amount || amount <= 0) {
      return NextResponse.json(
        { error: 'Invalid amount' },
        { status: 400 }
      );
    }

    if (!user_id) {
      return NextResponse.json(
        { error: 'User ID is required' },
        { status: 400 }
      );
    }

    // Validate minimum amount (e.g., ₹10)
    if (amount < 10) {
      return NextResponse.json(
        { error: 'Minimum amount is ₹10' },
        { status: 400 }
      );
    }

    // Validate maximum amount (e.g., ₹50,000)
    if (amount > 50000) {
      return NextResponse.json(
        { error: 'Maximum amount is ₹50,000' },
        { status: 400 }
      );
    }

    // Get user's wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, balance, allow_deposits')
      .eq('user_id', user_id)
      .single();

    if (walletError || !wallet) {
      return NextResponse.json(
        { error: 'Wallet not found' },
        { status: 404 }
      );
    }

    // Check if deposits are allowed
    if (!wallet.allow_deposits) {
      return NextResponse.json(
        { error: 'Deposits are not allowed for this wallet' },
        { status: 403 }
      );
    }

    // Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paise and ensure integer
      currency: 'INR',
      receipt: `wt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Max 40 chars
      notes: {
        user_id: user_id,
        wallet_id: wallet.id,
        purpose: 'wallet_topup',
      },
    });

    // Create pending transaction in database
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        user_id: user_id,
        wallet_id: wallet.id,
        amount: amount,
        transaction_type: 'RAZORPAY_MONEY_ADD',
        payment_status: 'pending',
        razorpay_order_id: razorpayOrder.id,
        old_balance: wallet.balance,
        new_balance: wallet.balance, // Will be updated on verification
        payment_metadata: {
          razorpay_order: {
            id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            receipt: razorpayOrder.receipt,
          },
          initiated_at: new Date().toISOString(),
          ip_address: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip'),
          user_agent: req.headers.get('user-agent'),
        },
      })
      .select()
      .single();

    if (txError) {
      console.error('Failed to create transaction:', txError);
      return NextResponse.json(
        { error: 'Failed to create transaction' },
        { status: 500 }
      );
    }

    // Return order details to frontend
    return NextResponse.json({
      success: true,
      transaction_id: transaction.id,
      razorpay_order_id: razorpayOrder.id,
      amount: amount,
      currency: 'INR',
      key_id: process.env.RAZORPAY_KEY_ID!,
    });

  } catch (error: any) {
    console.error('Error creating payment order:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET endpoint to check order status
export async function GET(req: NextRequest) {
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

  try {
    const searchParams = req.nextUrl.searchParams;
    const transaction_id = searchParams.get('transaction_id');

    if (!transaction_id) {
      return NextResponse.json(
        { error: 'Transaction ID is required' },
        { status: 400 }
      );
    }

    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('id, payment_status, razorpay_order_id, amount, created_at')
      .eq('id', transaction_id)
      .single();

    if (error || !transaction) {
      return NextResponse.json(
        { error: 'Transaction not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      transaction,
    });

  } catch (error: any) {
    console.error('Error fetching transaction:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
