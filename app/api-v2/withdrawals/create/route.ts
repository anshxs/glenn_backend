import { NextRequest, NextResponse } from 'next/server';

import {
  blockApiV2IfMaintenance,
  requireApiV2Auth,
} from '@/lib/api-v2-guards';
import {
  readGlennJsonBody,
  verifyGlennRequestSecurity,
} from '@/lib/glenn-request-security';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_WITHDRAWAL_METHODS = ['UPI', 'BANK', 'GIFTCARD'] as const;
const PLATFORM_FEE = 1.0;

type WithdrawalMethod = (typeof VALID_WITHDRAWAL_METHODS)[number];

type CreateWithdrawalBody = {
  userId?: unknown;
  amount?: unknown;
  withdrawalMethod?: unknown;
  accountDetails?: unknown;
};

const ALLOWED_BODY_KEYS = new Set([
  'userId',
  'amount',
  'withdrawalMethod',
  'accountDetails',
]);

function isWithdrawalMethod(value: unknown): value is WithdrawalMethod {
  return (
    typeof value === 'string' &&
    VALID_WITHDRAWAL_METHODS.includes(value as WithdrawalMethod)
  );
}

function textField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= maxLength ? text : '';
}

function nextWorkingDay(): Date {
  const expectedPayoutDate = new Date();
  expectedPayoutDate.setDate(expectedPayoutDate.getDate() + 1);

  const dayOfWeek = expectedPayoutDate.getDay();
  if (dayOfWeek === 6) {
    expectedPayoutDate.setDate(expectedPayoutDate.getDate() + 2);
  } else if (dayOfWeek === 0) {
    expectedPayoutDate.setDate(expectedPayoutDate.getDate() + 1);
  }

  return expectedPayoutDate;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiV2Auth(request);
    if (auth.response) {
      return auth.response;
    }

    let body: CreateWithdrawalBody;
    let bodyText = '';

    try {
      const parsed = await readGlennJsonBody<CreateWithdrawalBody>(request);
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
        { status: 400 },
      );
    }

    const securityError = await verifyGlennRequestSecurity(request, {
      bodyText,
      requireEncryptedPayload: true,
    });
    if (securityError) {
      return securityError;
    }

    const maintenanceResponse = await blockApiV2IfMaintenance();
    if (maintenanceResponse) {
      return maintenanceResponse;
    }

    const requestedUserId = typeof body.userId === 'string' ? body.userId : null;
    if (
      !Object.keys(body as Record<string, unknown>).every((key) =>
        ALLOWED_BODY_KEYS.has(key),
      )
    ) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Unsupported withdrawal fields.' },
        { status: 400 },
      );
    }

    if (requestedUserId !== null && requestedUserId !== auth.user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          message: 'Cannot create withdrawal for another user.',
        },
        { status: 403 },
      );
    }

    if (
      body.amount === null ||
      body.amount === undefined ||
      (typeof body.amount !== 'string' && typeof body.amount !== 'number') ||
      !isWithdrawalMethod(body.withdrawalMethod)
    ) {
      return NextResponse.json(
        {
          error: 'Missing required fields',
          message: 'amount and withdrawalMethod are required.',
        },
        { status: 400 },
      );
    }

    const withdrawAmount =
      typeof body.amount === 'number'
        ? body.amount
        : Number.parseFloat(body.amount);

    const withdrawalMethod = body.withdrawalMethod;
    const minimumWithdrawal = withdrawalMethod === 'GIFTCARD' ? 10 : 1;

    if (
      Number.isNaN(withdrawAmount) ||
      !Number.isFinite(withdrawAmount) ||
      withdrawAmount < minimumWithdrawal ||
      withdrawAmount > 50000
    ) {
      return NextResponse.json(
        {
          error: 'Invalid amount',
          message:
            withdrawalMethod === 'GIFTCARD'
              ? 'Minimum Google Play redeem code is ₹10.'
              : 'Minimum withdrawal is ₹1.',
        },
        { status: 400 },
      );
    }

    const accountDetails =
      body.accountDetails && typeof body.accountDetails === 'object'
        ? (body.accountDetails as Record<string, unknown>)
        : {};

    if (withdrawalMethod === 'UPI' && !textField(accountDetails.upiId, 80)) {
      return NextResponse.json(
        { error: 'Invalid UPI', message: 'Enter a valid UPI ID.' },
        { status: 400 },
      );
    }

    if (
      withdrawalMethod === 'BANK' &&
      (!textField(accountDetails.accountNumber, 40) ||
        !textField(accountDetails.ifscCode, 20) ||
        !textField(accountDetails.accountHolderName, 100))
    ) {
      return NextResponse.json(
        { error: 'Invalid bank details', message: 'Enter valid bank details.' },
        { status: 400 },
      );
    }

    if (
      withdrawalMethod === 'GIFTCARD' &&
      textField(accountDetails.giftCardType, 80) !== 'Google Play'
    ) {
      return NextResponse.json(
        { error: 'Invalid gift card', message: 'Only Google Play redemption is supported.' },
        { status: 400 },
      );
    }
    const totalDeduction = withdrawAmount + PLATFORM_FEE;

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', auth.user.id)
      .single();

    if (walletError) {
      console.error('API v2 wallet fetch error:', walletError);
      return NextResponse.json(
        { error: 'Wallet fetch failed', message: 'Failed to fetch wallet.' },
        { status: 500 },
      );
    }

    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet not found', message: 'Wallet not found.' },
        { status: 404 },
      );
    }

    if (!wallet.allow_withdrawals) {
      return NextResponse.json(
        {
          error: 'Withdrawals disabled',
          message:
            wallet.fraud_reason || 'Withdrawals are disabled for this account.',
        },
        { status: 403 },
      );
    }

    if (Number(wallet.balance) < totalDeduction) {
      return NextResponse.json(
        {
          error: 'Insufficient balance',
          message: `Insufficient balance. Required: ₹${totalDeduction.toFixed(2)} including ₹${PLATFORM_FEE.toFixed(2)} fee.`,
        },
        { status: 400 },
      );
    }

    const maxWithdrawAmount = Number(wallet.balance) - PLATFORM_FEE;
    if (withdrawAmount > maxWithdrawAmount) {
      return NextResponse.json(
        {
          error: 'Invalid amount',
          message: `Maximum withdrawal is ₹${maxWithdrawAmount.toFixed(2)} so the ₹${PLATFORM_FEE.toFixed(2)} platform fee is also covered.`,
        },
        { status: 400 },
      );
    }

    const expectedPayoutDate = nextWorkingDay();

    const { data: transaction, error: txError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: auth.user.id,
        wallet_id: wallet.id,
        amount: -withdrawAmount,
        transaction_type: 'WITHDRAWAL',
        payment_status: 'pending',
        old_balance: wallet.balance,
        new_balance: Number(wallet.balance) - totalDeduction,
        platform_fee: PLATFORM_FEE,
        withdrawal_method: withdrawalMethod,
        withdrawal_account_details: accountDetails,
        expected_payout_date: expectedPayoutDate.toISOString(),
      })
      .select()
      .single();

    if (txError) {
      console.error('API v2 transaction creation error:', txError);
      return NextResponse.json(
        {
          error: 'Transaction creation failed',
          message: txError.message || 'Failed to create withdrawal transaction.',
        },
        { status: 500 },
      );
    }

    const { data: updatedWallet, error: updateError } = await supabaseAdmin
      .from('wallets')
      .update({
        balance: Number(wallet.balance) - totalDeduction,
        last_updated: new Date().toISOString(),
      })
      .eq('id', wallet.id)
      .gte('balance', totalDeduction)
      .select('balance')
      .maybeSingle();

    if (updateError || !updatedWallet) {
      console.error('API v2 wallet update error:', updateError);
      await supabaseAdmin.from('transactions').delete().eq('id', transaction.id);

      return NextResponse.json(
        {
          error: 'Wallet update failed',
          message: updateError?.message || 'Failed to update wallet balance.',
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      apiVersion: 'v2',
      authenticated: true,
      success: true,
      transaction: {
        id: transaction.id,
        amount: withdrawAmount,
        platformFee: PLATFORM_FEE,
        totalDeduction,
        withdrawalMethod,
        expectedPayoutDate: expectedPayoutDate.toISOString(),
        status: 'PENDING',
        remainingBalance: Number(updatedWallet.balance),
      },
      message: `Withdrawal request submitted successfully. You will receive ₹${withdrawAmount} within 1 working day.`,
    });
  } catch (error) {
    console.error('API v2 withdrawal creation error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message:
          error instanceof Error ? error.message : 'Internal server error.',
      },
      { status: 500 },
    );
  }
}
