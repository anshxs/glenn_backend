import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  // Initialize Supabase with service role inside request handler
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
    // Get webhook signature from headers
    const webhookSignature = req.headers.get('x-razorpay-signature');
    
    if (!webhookSignature) {
      return NextResponse.json(
        { error: 'Missing webhook signature' },
        { status: 400 }
      );
    }

    // Get raw body
    const body = await req.text();
    
    // Verify webhook signature
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!;
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');

    if (webhookSignature !== expectedSignature) {
      console.error('Invalid webhook signature');
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      );
    }

    // Parse the event
    const event = JSON.parse(body);
    console.log('Razorpay webhook event:', event.event);

    // Handle different webhook events
    switch (event.event) {
      case 'payment.captured':
        await handlePaymentCaptured(event.payload.payment.entity, supabase);
        break;

      case 'payment.failed':
        await handlePaymentFailed(event.payload.payment.entity, supabase);
        break;

      case 'payment.authorized':
        await handlePaymentAuthorized(event.payload.payment.entity, supabase);
        break;

      case 'order.paid':
        await handleOrderPaid(event.payload.order.entity, supabase);
        break;

      default:
        console.log('Unhandled webhook event:', event.event);
    }

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Webhook error:', error);
    return NextResponse.json(
      { error: error.message || 'Webhook processing failed' },
      { status: 500 }
    );
  }
}

async function handlePaymentCaptured(payment: any, supabase: any) {
  console.log('Payment captured:', payment.id);

  // Find transaction by order_id
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('razorpay_order_id', payment.order_id)
    .eq('transaction_type', 'RAZORPAY_MONEY_ADD')
    .single();

  if (txError || !transaction) {
    console.error('Transaction not found for order:', payment.order_id);
    return;
  }

  // If already verified, skip (avoid duplicate processing)
  if (transaction.payment_status === 'verified') {
    console.log('Transaction already verified:', transaction.id);
    return;
  }

  // Update transaction with webhook data
  await supabase
    .from('transactions')
    .update({
      payment_metadata: {
        ...transaction.payment_metadata,
        webhook_received: true,
        webhook_event: 'payment.captured',
        webhook_at: new Date().toISOString(),
        payment_details: {
          id: payment.id,
          status: payment.status,
          method: payment.method,
          amount: payment.amount,
          captured: payment.captured,
          email: payment.email,
          contact: payment.contact,
        },
      },
    })
    .eq('id', transaction.id);

  console.log('Updated transaction with webhook data:', transaction.id);
}

async function handlePaymentFailed(payment: any, supabase: any) {
  console.log('Payment failed:', payment.id);

  // Find transaction by order_id
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('razorpay_order_id', payment.order_id)
    .eq('transaction_type', 'RAZORPAY_MONEY_ADD')
    .single();

  if (txError || !transaction) {
    console.error('Transaction not found for order:', payment.order_id);
    return;
  }

  // If already in a final state, skip
  if (transaction.payment_status !== 'pending') {
    console.log('Transaction not pending, skipping:', transaction.id);
    return;
  }

  // Mark transaction as failed
  await supabase
    .from('transactions')
    .update({
      payment_status: 'failed',
      payment_metadata: {
        ...transaction.payment_metadata,
        webhook_received: true,
        webhook_event: 'payment.failed',
        webhook_at: new Date().toISOString(),
        error_code: payment.error_code,
        error_description: payment.error_description,
        error_source: payment.error_source,
        error_reason: payment.error_reason,
      },
    })
    .eq('id', transaction.id);

  console.log('Marked transaction as failed:', transaction.id);

  // Optional: Send notification to user about failed payment
}

async function handlePaymentAuthorized(payment: any, supabase: any) {
  console.log('Payment authorized:', payment.id);

  // Similar to captured, but payment is only authorized, not captured yet
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('razorpay_order_id', payment.order_id)
    .eq('transaction_type', 'RAZORPAY_MONEY_ADD')
    .single();

  if (txError || !transaction) {
    console.error('Transaction not found for order:', payment.order_id);
    return;
  }

  // Update metadata
  await supabase
    .from('transactions')
    .update({
      payment_metadata: {
        ...transaction.payment_metadata,
        webhook_received: true,
        webhook_event: 'payment.authorized',
        webhook_at: new Date().toISOString(),
        payment_authorized: true,
      },
    })
    .eq('id', transaction.id);
}

async function handleOrderPaid(order: any, supabase: any) {
  console.log('Order paid:', order.id);

  // Find transaction by order_id
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('razorpay_order_id', order.id)
    .eq('transaction_type', 'RAZORPAY_MONEY_ADD')
    .single();

  if (txError || !transaction) {
    console.error('Transaction not found for order:', order.id);
    return;
  }

  // Update metadata
  await supabase
    .from('transactions')
    .update({
      payment_metadata: {
        ...transaction.payment_metadata,
        webhook_received: true,
        webhook_event: 'order.paid',
        webhook_at: new Date().toISOString(),
        order_status: order.status,
        order_paid: true,
      },
    })
    .eq('id', transaction.id);
}
