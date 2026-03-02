import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { transactionId, status, paymentReference, adminNotes } = body;

    // Validate required fields
    if (!transactionId || !status) {
      return NextResponse.json(
        { error: 'Missing required fields: transactionId, status' },
        { status: 400 }
      );
    }

    // Validate status
    const validStatuses = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      );
    }

    // Get the transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('transaction_type', 'WITHDRAWAL')
      .single();

    if (txError || !transaction) {
      return NextResponse.json(
        { error: 'Withdrawal transaction not found' },
        { status: 404 }
      );
    }

    // If cancelling or failing, refund the amount to wallet
    if ((status === 'CANCELLED' || status === 'FAILED') && 
        transaction.withdrawal_status === 'PENDING') {
      const refundAmount = Math.abs(transaction.amount) + (transaction.platform_fee || 0);
      
      // Get the wallet
      const { data: wallet, error: walletError } = await supabase
        .from('wallets')
        .select('*')
        .eq('id', transaction.wallet_id)
        .single();

      if (walletError || !wallet) {
        return NextResponse.json(
          { error: 'Wallet not found for refund' },
          { status: 404 }
        );
      }

      // Update wallet balance (refund)
      const { error: updateError } = await supabase
        .from('wallets')
        .update({
          balance: wallet.balance + refundAmount,
          last_updated: new Date().toISOString(),
        })
        .eq('id', wallet.id);

      if (updateError) {
        console.error('Wallet refund error:', updateError);
        return NextResponse.json(
          { error: 'Failed to refund amount to wallet' },
          { status: 500 }
        );
      }
    }

    // Update transaction status
    const updateData: any = {
      withdrawal_status: status,
      payment_status: status === 'PAID' ? 'completed' : status.toLowerCase(),
    };

    if (paymentReference) {
      updateData.payment_reference = paymentReference;
    }

    if (adminNotes) {
      updateData.payment_metadata = {
        ...(transaction.payment_metadata || {}),
        admin_notes: adminNotes,
        status_updated_at: new Date().toISOString(),
      };
    }

    const { data: updatedTransaction, error: updateError } = await supabase
      .from('transactions')
      .update(updateData)
      .eq('id', transactionId)
      .select()
      .single();

    if (updateError) {
      console.error('Transaction update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update withdrawal status' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      transaction: updatedTransaction,
      message: `Withdrawal status updated to ${status}`,
    });

  } catch (error) {
    console.error('Withdrawal status update error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET endpoint to fetch withdrawal details
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const transactionId = searchParams.get('transactionId');
    const userId = searchParams.get('userId');
    const status = searchParams.get('status');

    let query = supabase
      .from('transactions')
      .select('*')
      .eq('transaction_type', 'WITHDRAWAL');

    if (transactionId) {
      query = query.eq('id', transactionId);
    }

    if (userId) {
      query = query.eq('user_id', userId);
    }

    if (status) {
      query = query.eq('withdrawal_status', status);
    }

    query = query.order('created_at', { ascending: false }).limit(50);

    const { data, error } = await query;

    if (error) {
      console.error('Query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch withdrawals' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      withdrawals: data,
      count: data?.length || 0,
    });

  } catch (error) {
    console.error('Withdrawal fetch error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
