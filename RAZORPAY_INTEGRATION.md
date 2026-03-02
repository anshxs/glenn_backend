# Razorpay Payment Integration Guide

## Overview
This guide explains how to integrate Razorpay payments for wallet top-ups in Glenn.

## Database Schema
The transactions table now includes:
- `razorpay_order_id`: Razorpay order ID
- `razorpay_payment_id`: Payment ID from Razorpay
- `razorpay_signature`: Signature for verification
- `payment_status`: pending | verified | completed | failed | refunded | cancelled
- `payment_metadata`: Additional payment data (JSONB)
- `transaction_type`: Now includes 'RAZORPAY_MONEY_ADD'

## Payment Flow

### 1. User Initiates Payment (Frontend → Backend)
```typescript
// POST /api/payments/create-order
interface CreateOrderRequest {
  amount: number; // Amount in rupees
  user_id: string;
}

interface CreateOrderResponse {
  transaction_id: string;
  razorpay_order_id: string;
  amount: number;
  currency: string;
  key_id: string; // Razorpay key for frontend
}
```

### 2. Backend Creates Pending Transaction
```typescript
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export async function createPaymentOrder(userId: string, amount: number) {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Get user's current wallet
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('id, balance')
    .eq('user_id', userId)
    .single();

  if (walletError || !wallet) {
    throw new Error('Wallet not found');
  }

  // Create Razorpay order
  const razorpayOrder = await razorpay.orders.create({
    amount: amount * 100, // Convert to paise
    currency: 'INR',
    receipt: `wallet_topup_${Date.now()}`,
    notes: {
      user_id: userId,
      wallet_id: wallet.id,
    },
  });

  // Create pending transaction in database
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .insert({
      user_id: userId,
      wallet_id: wallet.id,
      amount: amount,
      transaction_type: 'RAZORPAY_MONEY_ADD',
      payment_status: 'pending',
      razorpay_order_id: razorpayOrder.id,
      old_balance: wallet.balance,
      new_balance: wallet.balance, // Not updated yet
      payment_metadata: {
        razorpay_order: razorpayOrder,
        initiated_at: new Date().toISOString(),
      },
    })
    .select()
    .single();

  if (txError) {
    throw new Error('Failed to create transaction: ' + txError.message);
  }

  return {
    transaction_id: transaction.id,
    razorpay_order_id: razorpayOrder.id,
    amount: razorpayOrder.amount / 100,
    currency: razorpayOrder.currency,
    key_id: process.env.RAZORPAY_KEY_ID!,
  };
}
```

### 3. Frontend Shows Razorpay Checkout
```typescript
// Flutter/Frontend code
const options = {
  key: response.key_id,
  amount: response.amount * 100,
  currency: response.currency,
  name: 'Glenn',
  description: 'Wallet Top-up',
  order_id: response.razorpay_order_id,
  handler: async (razorpayResponse) => {
    // Send to backend for verification
    await verifyPayment({
      transaction_id: response.transaction_id,
      razorpay_payment_id: razorpayResponse.razorpay_payment_id,
      razorpay_order_id: razorpayResponse.razorpay_order_id,
      razorpay_signature: razorpayResponse.razorpay_signature,
    });
  },
};

razorpay.open(options);
```

### 4. Payment Verification (Frontend → Backend)
```typescript
// POST /api/payments/verify
interface VerifyPaymentRequest {
  transaction_id: string;
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface VerifyPaymentResponse {
  success: boolean;
  transaction_id: string;
  new_balance: number;
}
```

### 5. Backend Verifies and Updates Wallet
```typescript
import crypto from 'crypto';

export async function verifyAndProcessPayment(
  transactionId: string,
  razorpayPaymentId: string,
  razorpayOrderId: string,
  razorpaySignature: string
) {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Step 1: Get the pending transaction
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('*, wallets(*)')
    .eq('id', transactionId)
    .eq('payment_status', 'pending')
    .eq('razorpay_order_id', razorpayOrderId)
    .single();

  if (txError || !transaction) {
    throw new Error('Transaction not found or already processed');
  }

  // Step 2: Verify signature
  const body = razorpayOrderId + '|' + razorpayPaymentId;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
    .update(body)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    // Mark as failed
    await supabase
      .from('transactions')
      .update({
        payment_status: 'failed',
        payment_metadata: {
          ...transaction.payment_metadata,
          error: 'Signature verification failed',
          failed_at: new Date().toISOString(),
        },
      })
      .eq('id', transactionId);

    throw new Error('Payment signature verification failed');
  }

  // Step 3: Fetch payment details from Razorpay (optional but recommended)
  try {
    const payment = await razorpay.payments.fetch(razorpayPaymentId);
    
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      throw new Error('Payment not captured');
    }

    // Verify amount matches
    if (payment.amount !== transaction.amount * 100) {
      throw new Error('Amount mismatch');
    }
  } catch (error) {
    // Mark as failed
    await supabase
      .from('transactions')
      .update({
        payment_status: 'failed',
        payment_metadata: {
          ...transaction.payment_metadata,
          error: 'Payment verification failed',
          failed_at: new Date().toISOString(),
        },
      })
      .eq('id', transactionId);

    throw error;
  }

  // Step 4: Update wallet balance
  const newBalance = Number(transaction.wallets.balance) + Number(transaction.amount);

  const { error: walletError } = await supabase
    .from('wallets')
    .update({
      balance: newBalance,
      last_updated: new Date().toISOString(),
    })
    .eq('id', transaction.wallet_id);

  if (walletError) {
    throw new Error('Failed to update wallet: ' + walletError.message);
  }

  // Step 5: Update transaction as verified
  const { error: updateError } = await supabase
    .from('transactions')
    .update({
      payment_status: 'verified',
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
      new_balance: newBalance,
      payment_metadata: {
        ...transaction.payment_metadata,
        verified_at: new Date().toISOString(),
      },
    })
    .eq('id', transactionId);

  if (updateError) {
    // Critical: wallet updated but transaction not marked as verified
    // Log this for manual review
    console.error('CRITICAL: Transaction not marked as verified', {
      transactionId,
      error: updateError,
    });
  }

  return {
    success: true,
    transaction_id: transactionId,
    new_balance: newBalance,
  };
}
```

### 6. Webhook Handling (Razorpay → Backend)
```typescript
// POST /api/webhooks/razorpay
import crypto from 'crypto';

export async function handleRazorpayWebhook(req: Request) {
  const webhookSignature = req.headers.get('x-razorpay-signature');
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!;

  // Verify webhook signature
  const body = await req.text();
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  if (webhookSignature !== expectedSignature) {
    return new Response('Invalid signature', { status: 400 });
  }

  const event = JSON.parse(body);

  // Handle different events
  switch (event.event) {
    case 'payment.captured':
      await handlePaymentCaptured(event.payload.payment.entity);
      break;

    case 'payment.failed':
      await handlePaymentFailed(event.payload.payment.entity);
      break;

    case 'payment.refunded':
      await handlePaymentRefunded(event.payload.refund.entity);
      break;
  }

  return new Response('OK', { status: 200 });
}

async function handlePaymentCaptured(payment: any) {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Find transaction by order_id
  const { data: transaction } = await supabase
    .from('transactions')
    .select('*')
    .eq('razorpay_order_id', payment.order_id)
    .single();

  if (!transaction) {
    console.error('Transaction not found for webhook:', payment.order_id);
    return;
  }

  // If already verified, skip
  if (transaction.payment_status === 'verified') {
    return;
  }

  // Update transaction metadata
  await supabase
    .from('transactions')
    .update({
      payment_metadata: {
        ...transaction.payment_metadata,
        webhook_received: true,
        webhook_at: new Date().toISOString(),
        payment_details: payment,
      },
    })
    .eq('id', transaction.id);
}

async function handlePaymentFailed(payment: any) {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  await supabase
    .from('transactions')
    .update({
      payment_status: 'failed',
      payment_metadata: {
        error: payment.error_description,
        failed_at: new Date().toISOString(),
      },
    })
    .eq('razorpay_order_id', payment.order_id);
}
```

## Environment Variables
Add to your `.env`:
```bash
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx
```

## Testing
1. Use Razorpay test mode keys
2. Test cards: https://razorpay.com/docs/payments/payments/test-card-details/
3. Monitor pending transactions: `SELECT * FROM transactions WHERE payment_status = 'pending' AND created_at < NOW() - INTERVAL '10 minutes'`

## Security Checklist
- ✅ Verify signature on payment verification
- ✅ Verify signature on webhooks
- ✅ Check payment status from Razorpay API
- ✅ Verify amount matches
- ✅ Use service role key for database operations
- ✅ Ensure idempotency (don't process same payment twice)
- ✅ Log all payment operations
- ✅ Set up monitoring for stuck pending payments

## Row Level Security (RLS)
Add RLS policies for transactions table:
```sql
-- Users can only view their own transactions
CREATE POLICY "Users can view own transactions"
  ON public.transactions
  FOR SELECT
  USING (auth.uid() = user_id);

-- Only backend service can insert transactions
-- (using service role key)
```

## Error Handling
- Failed payments remain in `pending` status with error in metadata
- Set up a cron job to auto-cancel pending payments older than 30 minutes
- Send notifications to users on payment success/failure
