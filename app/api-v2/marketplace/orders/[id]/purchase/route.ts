import { NextRequest, NextResponse } from 'next/server';

import {
  debitWallet,
  LISTING_FEE,
  PLATFORM_FEE,
  SELLER_BONUS,
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
    const { id: listingId } = await context.params;
    if (!UUID_RE.test(listingId)) {
      return NextResponse.json(
        { error: 'Invalid listing', message: 'Listing ID is invalid.' },
        { status: 400 },
      );
    }

    const secure = await readSecureMarketplaceBody<Record<string, never>>(request);
    if (secure.response) return secure.response;
    const buyerId = secure.auth.user.id;

    const { data: listing, error: listingError } = await supabaseAdmin
      .from('marketplace_listings')
      .select('id, seller_id, status, price, listing_fee_amount')
      .eq('id', listingId)
      .single();

    if (listingError || !listing || listing.status !== 'active') {
      return NextResponse.json(
        { error: 'Unavailable', message: 'This listing is not available.' },
        { status: 404 },
      );
    }

    if (listing.seller_id === buyerId) {
      return NextResponse.json(
        { error: 'Invalid purchase', message: 'You cannot buy your own listing.' },
        { status: 400 },
      );
    }

    const price = Number(listing.price);
    const payment = await debitWallet(buyerId, price, `marketplace_purchase:${listingId}`, {
      feature: 'marketplace',
      listing_id: listingId,
      purpose: 'purchase_escrow',
      marketplace_transaction_type: 'MARKETPLACE_PURCHASE',
    });
    if (payment.response) return payment.response;

    const { data: lockedListing, error: lockError } = await supabaseAdmin
      .from('marketplace_listings')
      .update({
        status: 'reserved',
        buyer_id: buyerId,
        purchase_transaction_id: payment.transactionId,
        reserved_at: new Date().toISOString(),
      })
      .eq('id', listingId)
      .eq('status', 'active')
      .select('*')
      .single();

    if (lockError || !lockedListing) {
      return NextResponse.json(
        { error: 'Unavailable', message: 'Someone reserved this listing first.' },
        { status: 409 },
      );
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('marketplace_orders')
      .insert({
        listing_id: listingId,
        buyer_id: buyerId,
        seller_id: listing.seller_id,
        status: 'seller_credentials_pending',
        item_price: price,
        listing_fee_amount: Number(listing.listing_fee_amount || LISTING_FEE),
        platform_fee_amount: PLATFORM_FEE,
        seller_bonus_amount: SELLER_BONUS,
        purchase_transaction_id: payment.transactionId,
      })
      .select('*')
      .single();

    if (orderError || !order) throw orderError ?? new Error('Could not create order.');
    await logMarketplaceEvent('order_paid', {
      listingId,
      orderId: order.id,
      actorId: buyerId,
      metadata: { transactionId: payment.transactionId, amount: price },
    });

    return NextResponse.json({ apiVersion: 'v2', data: order });
  } catch (error) {
    console.error('Marketplace purchase error:', error);
    return NextResponse.json(
      {
        error: 'Purchase failed',
        message: error instanceof Error ? error.message : 'Could not purchase listing.',
      },
      { status: 500 },
    );
  }
}
