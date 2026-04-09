import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';

const ADD_MONEY_ENABLED = false;
const ADD_MONEY_DISABLED_MESSAGE =
  'Wallet add money is temporarily unavailable right now.';

interface CreateOrderRequest {
  amount: number;
  user_id: string;
  phone?: string;
}

async function verifyToken(
  authHeader: string | null,
  supabase: SupabaseClient
): Promise<string | null> {
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

  if (!ADD_MONEY_ENABLED) {
    return NextResponse.json(
      { error: ADD_MONEY_DISABLED_MESSAGE },
      { status: 503 }
    );
  }

  try {
    let body: CreateOrderRequest;
    let bodyText = '';
    try {
      const parsed = await readGlennJsonBody<CreateOrderRequest>(req);
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

    const securityError = await verifyGlennRequestSecurity(req, {
      bodyText,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const { amount, user_id: requestedUserId, phone } = body;
    const user_id = authenticatedUserId;

    if (!amount || amount < 10 || amount > 50000) {
      return NextResponse.json({ error: 'Amount must be between ₹10 and ₹50,000' }, { status: 400 });
    }

    // Never trust a client-supplied user_id.
    if (requestedUserId && requestedUserId !== authenticatedUserId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
      return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      transaction_id: transaction.id,
      order_id: orderId,
      payment_url: zapupiData.payment_url,
      amount,
    });

  } catch (error: unknown) {
    console.error('Error creating ZapUPI order:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
