import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

interface CreateOrderRequest {
  amount: number;
  user_id: string;
  phone?: string;
}

export async function POST(req: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  try {
    const body: CreateOrderRequest = await req.json();
    const { amount, user_id, phone } = body;

    if (!amount || amount < 1 || amount > 50000) {
      return NextResponse.json({ error: 'Amount must be between Rs10 and Rs50,000' }, { status: 400 });
    }
    if (!user_id) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, balance, allow_deposits')
      .eq('user_id', user_id)
      .single();

    if (walletError || !wallet) {
      return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
    }
    if (!wallet.allow_deposits) {
      return NextResponse.json({ error: 'Deposits are not allowed for this wallet' }, { status: 403 });
    }

    // Generate unique order_id for ZapUPI
    const orderId = `GLENN${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // Create ZapUPI order
    const formData = new URLSearchParams();
    formData.append('token_key', process.env.ZAPUPI_TOKEN_KEY!);
    formData.append('secret_key', process.env.ZAPUPI_SECRET_KEY!);
    formData.append('amount', Math.floor(amount).toString());
    formData.append('order_id', orderId);
    formData.append('remark', 'Glenn wallet top-up');
    formData.append('redirect_url', 'https://glennesports.app/payment/callback');
    if (phone && phone.length > 0) formData.append('custumer_mobile', phone);

    const zapupiRes = await fetch('https://api.zapupi.com/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    const zapupiData = await zapupiRes.json();
    console.log('ZapUPI response:', JSON.stringify(zapupiData));

    if (zapupiData.status !== 'success') {
      console.error('ZapUPI error:', zapupiData);
      return NextResponse.json({ error: zapupiData.message || 'Failed to create payment order' }, { status: 500 });
    }

    // Create pending transaction in database
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        user_id,
        wallet_id: wallet.id,
        amount,
        transaction_type: 'RAZORPAY_MONEY_ADD',
        payment_status: 'pending',
        razorpay_order_id: orderId,
        old_balance: wallet.balance,
        new_balance: wallet.balance,
        payment_metadata: {
          gateway: 'zapupi',
          zapupi_order_id: orderId,
          payment_url: zapupiData.payment_url,
          initiated_at: new Date().toISOString(),
          ip_address: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip'),
        },
      })
      .select()
      .single();

    if (txError) {
      console.error('Failed to create transaction:', txError);
      return NextResponse.json({ error: 'Failed to create transaction', detail: txError.message, hint: txError.hint, code: txError.code }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      transaction_id: transaction.id,
      order_id: orderId,
      payment_url: zapupiData.payment_url,
      amount,
    });

  } catch (error: any) {
    console.error('Error creating ZapUPI order:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
