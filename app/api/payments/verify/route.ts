import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

async function verifyToken(authHeader: string | null, supabase: any): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

export async function POST(req: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const authenticatedUserId = await verifyToken(req.headers.get('Authorization'), supabase);
  if (!authenticatedUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { transaction_id } = body;

    if (!transaction_id) {
      return NextResponse.json({ error: 'transaction_id is required' }, { status: 400 });
    }

    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('*, wallets(id, balance, allow_deposits)')
      .eq('id', transaction_id)
      .single();

    if (txError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    // Ensure the caller owns this transaction
    if (transaction.user_id !== authenticatedUserId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (transaction.payment_status === 'verified') {
      return NextResponse.json({ success: true, status: 'verified', new_balance: transaction.new_balance });
    }
    if (transaction.payment_status === 'failed') {
      return NextResponse.json({ success: false, status: 'failed' });
    }

    // Check ZapUPI order status
    const orderId = transaction.razorpay_order_id;

    const formData = new URLSearchParams();
    formData.append('token_key', process.env.ZAPUPI_TOKEN_KEY!);
    formData.append('secret_key', process.env.ZAPUPI_SECRET_KEY!);
    formData.append('order_id', orderId);

    const zapupiRes = await fetch('https://api.zapupi.com/api/order-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    const zapupiData = await zapupiRes.json();

    if (zapupiData.status !== 'success') {
      return NextResponse.json({ success: false, status: 'pending' });
    }

    const orderStatus = zapupiData.data?.status;

    if (orderStatus === 'Success') {
      const currentBalance = Number(transaction.wallets.balance);
      const addAmount = Number(transaction.amount);
      const newBalance = currentBalance + addAmount;

      const { error: walletError } = await supabase
        .from('wallets')
        .update({ balance: newBalance, last_updated: new Date().toISOString() })
        .eq('id', transaction.wallet_id)
        .eq('balance', currentBalance);

      if (walletError) {
        console.error('Failed to update wallet:', walletError);
        return NextResponse.json({ error: 'Failed to update wallet' }, { status: 500 });
      }

      await supabase
        .from('transactions')
        .update({
          payment_status: 'verified',
          new_balance: newBalance,
          payment_metadata: {
            ...transaction.payment_metadata,
            zapupi_txn_id: zapupiData.data.txn_id,
            zapupi_utr: zapupiData.data.utr,
            verified_at: new Date().toISOString(),
          },
        })
        .eq('id', transaction_id);

      return NextResponse.json({ success: true, status: 'verified', new_balance: newBalance });
    }

    if (orderStatus === 'Failed' || orderStatus === 'Expired') {
      await supabase
        .from('transactions')
        .update({
          payment_status: 'failed',
          payment_metadata: {
            ...transaction.payment_metadata,
            zapupi_status: orderStatus,
            failed_at: new Date().toISOString(),
          },
        })
        .eq('id', transaction_id);

      return NextResponse.json({ success: false, status: 'failed' });
    }

    // Still pending
    return NextResponse.json({ success: false, status: 'pending' });

  } catch (error: any) {
    console.error('Error checking ZapUPI status:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
