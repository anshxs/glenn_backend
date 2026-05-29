import { NextRequest, NextResponse } from 'next/server';

import {
  debitWallet,
  LISTING_FEE,
  logMarketplaceEvent,
  readSecureMarketplaceBody,
  UUID_RE,
} from '@/lib/marketplace';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid listing', message: 'Listing ID is invalid.' },
        { status: 400 },
      );
    }

    const secure = await readSecureMarketplaceBody<Record<string, never>>(request);
    if (secure.response) return secure.response;

    const userId = secure.auth.user.id;
    const { data: listing, error: listingError } = await supabaseAdmin
      .from('marketplace_listings')
      .select('id, seller_id, status, listing_fee_amount')
      .eq('id', id)
      .single();

    if (listingError || !listing || listing.seller_id !== userId) {
      return NextResponse.json(
        { error: 'Listing unavailable', message: 'Listing was not found.' },
        { status: 404 },
      );
    }

    if (listing.status !== 'fee_pending') {
      return NextResponse.json(
        { error: 'Already handled', message: 'Listing fee is not pending.' },
        { status: 400 },
      );
    }

    const amount = Number(listing.listing_fee_amount || LISTING_FEE);
    const payment = await debitWallet(userId, amount, `marketplace_listing_fee:${id}`, {
      feature: 'marketplace',
      listing_id: id,
      purpose: 'listing_fee',
      marketplace_transaction_type: 'MARKETPLACE_LISTING_FEE',
    }, 'MARKETPLACE_LISTING_FEE');
    if (payment.response) return payment.response;

    const { data, error } = await supabaseAdmin
      .from('marketplace_listings')
      .update({
        status: 'active',
        listing_fee_transaction_id: payment.transactionId,
        active_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('seller_id', userId)
      .eq('status', 'fee_pending')
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('Could not activate listing.');
    await logMarketplaceEvent('listing_fee_paid', {
      listingId: id,
      actorId: userId,
      metadata: { transactionId: payment.transactionId, amount },
    });

    return NextResponse.json({ apiVersion: 'v2', data });
  } catch (error) {
    console.error('Marketplace listing fee error:', error);
    return NextResponse.json(
      {
        error: 'Payment failed',
        message: error instanceof Error ? error.message : 'Could not pay listing fee.',
      },
      { status: 500 },
    );
  }
}
