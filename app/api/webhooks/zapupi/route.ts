import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// ZapUPI gateway IP - only accept webhooks from this IP
const ZAPUPI_GATEWAY_IP = '148.135.143.154';

export async function POST(req: NextRequest) {
  // Verify source IP — fail closed: if IP cannot be determined, reject
  const forwardedFor = req.headers.get('x-forwarded-for');
  const realIp = req.headers.get('x-real-ip');
  const sourceIp = (forwardedFor?.split(',')[0] ?? realIp ?? '').trim();

  if (!sourceIp || sourceIp !== ZAPUPI_GATEWAY_IP) {
    console.warn(`ZapUPI webhook blocked from IP: '${sourceIp}'`);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  try {
    const payload = await req.json();
    console.log('ZapUPI webhook received:', payload);

    const {
      order_id,
      status,
      amount,
      txn_id,
      utr,
      custumer_mobile,
      remark,
    } = payload;

    if (!order_id || !status) {
      return NextResponse.json({ error: 'Missing order_id or status' }, { status: 400 });
    }

    // Find the pending transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('*, wallets(id, balance, allow_deposits)')
      .eq('razorpay_order_id', order_id) // reused column stores zapupi order_id
      .single();

    if (txError || !transaction) {
      console.error('ZapUPI webhook: transaction not found for order_id:', order_id);
      // Return 200 to prevent ZapUPI retrying for unknown orders
      return NextResponse.json({ received: true });
    }

    // Already processed — idempotent response
    if (transaction.payment_status === 'verified') {
      return NextResponse.json({ received: true });
    }

    if (status === 'Success') {
      const currentBalance = Number(transaction.wallets.balance);
      const addAmount = Number(transaction.amount);
      const newBalance = currentBalance + addAmount;

      // Update wallet balance
      const { error: walletError } = await supabase
        .from('wallets')
        .update({ balance: newBalance, last_updated: new Date().toISOString() })
        .eq('id', transaction.wallet_id)
        .eq('balance', currentBalance); // optimistic lock

      if (walletError) {
        console.error('ZapUPI webhook: failed to update wallet:', walletError);
        return NextResponse.json({ error: 'Failed to update wallet' }, { status: 500 });
      }

      // Mark transaction verified
      await supabase
        .from('transactions')
        .update({
          payment_status: 'verified',
          new_balance: newBalance,
          payment_metadata: {
            ...transaction.payment_metadata,
            zapupi_txn_id: txn_id,
            zapupi_utr: utr,
            zapupi_mobile: custumer_mobile,
            zapupi_remark: remark,
            verified_at: new Date().toISOString(),
            verified_via: 'webhook',
          },
        })
        .eq('id', transaction.id);

      console.log(`ZapUPI webhook: order ${order_id} verified, wallet credited ₹${addAmount}`);
    } else if (status === 'Failed' || status === 'Expired') {
      if (transaction.payment_status === 'pending') {
        await supabase
          .from('transactions')
          .update({
            payment_status: 'failed',
            payment_metadata: {
              ...transaction.payment_metadata,
              zapupi_txn_id: txn_id,
              zapupi_status: status,
              failed_at: new Date().toISOString(),
              failed_via: 'webhook',
            },
          })
          .eq('id', transaction.id);

        console.log(`ZapUPI webhook: order ${order_id} marked failed (${status})`);
      }
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error('ZapUPI webhook error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
