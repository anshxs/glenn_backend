import { NextRequest, NextResponse } from 'next/server';

import {
  creditWallet,
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

type Body = {
  negotiationId?: unknown;
};

function supabaseErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback;
  const item = error as {
    message?: string;
    details?: string | null;
    hint?: string | null;
    code?: string | null;
  };
  return [item.message, item.details, item.hint, item.code]
    .filter(Boolean)
    .join(' | ') || fallback;
}

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

    const secure = await readSecureMarketplaceBody<Body>(request);
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

    const negotiationId =
      typeof secure.parsed.data.negotiationId === 'string'
        ? secure.parsed.data.negotiationId
        : '';
    let price = Number(listing.price);
    let negotiated = false;

    if (negotiationId) {
      if (!UUID_RE.test(negotiationId)) {
        return NextResponse.json(
          { error: 'Invalid negotiation', message: 'Negotiation ID is invalid.' },
          { status: 400 },
        );
      }

      const { data: negotiation, error: negotiationError } = await supabaseAdmin
        .from('marketplace_negotiations')
        .select('id, listing_id, seller_id, buyer_id, status, current_offer')
        .eq('id', negotiationId)
        .single();

      if (
        negotiationError ||
        !negotiation ||
        negotiation.listing_id !== listingId ||
        negotiation.buyer_id !== buyerId ||
        negotiation.seller_id !== listing.seller_id ||
        !['seller_countered', 'accepted', 'denied'].includes(negotiation.status)
      ) {
        return NextResponse.json(
          {
            error: 'Negotiation unavailable',
            message: 'This negotiated price is not available for purchase.',
          },
          { status: 400 },
        );
      }

      const negotiatedPrice = Number(negotiation.current_offer);
      if (
        !Number.isFinite(negotiatedPrice) ||
        !Number.isInteger(negotiatedPrice) ||
        negotiatedPrice <= 0
      ) {
        return NextResponse.json(
          {
            error: 'Invalid price',
            message: 'Negotiated price is invalid.',
          },
          { status: 400 },
        );
      }

      price = negotiatedPrice;
      negotiated = true;
    }

    const payment = await debitWallet(buyerId, price, `marketplace_purchase:${listingId}`, {
      feature: 'marketplace',
      listing_id: listingId,
      negotiation_id: negotiationId || null,
      purpose: 'purchase_escrow',
      negotiated,
      marketplace_transaction_type: 'MARKETPLACE_PURCHASE',
    }, 'MARKETPLACE_PURCHASE');
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
      await creditWallet(
        buyerId,
        price,
        `marketplace_purchase_rollback:${listingId}`,
        {
          feature: 'marketplace',
          listing_id: listingId,
          reason: 'listing_reserve_failed',
          original_transaction_id: payment.transactionId,
          marketplace_transaction_type: 'MARKETPLACE_BUYER_REFUND',
        },
        'MARKETPLACE_BUYER_REFUND',
      ).catch((refundError) => {
        console.error('Marketplace purchase rollback refund failed:', refundError);
      });
      console.error('Marketplace listing reserve failed:', lockError);
      return NextResponse.json(
        {
          error: 'Unavailable',
          message: supabaseErrorMessage(
            lockError,
            'Someone reserved this listing first.',
          ),
        },
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

    if (orderError || !order) {
      await supabaseAdmin
        .from('marketplace_listings')
        .update({
          status: 'active',
          buyer_id: null,
          purchase_transaction_id: null,
          reserved_at: null,
        })
        .eq('id', listingId)
        .eq('buyer_id', buyerId)
        .eq('purchase_transaction_id', payment.transactionId);

      await creditWallet(
        buyerId,
        price,
        `marketplace_purchase_rollback:${listingId}`,
        {
          feature: 'marketplace',
          listing_id: listingId,
          reason: 'order_create_failed',
          original_transaction_id: payment.transactionId,
          marketplace_transaction_type: 'MARKETPLACE_BUYER_REFUND',
        },
        'MARKETPLACE_BUYER_REFUND',
      ).catch((refundError) => {
        console.error('Marketplace order rollback refund failed:', refundError);
      });

      console.error('Marketplace order insert failed:', orderError);
      return NextResponse.json(
        {
          error: 'Order failed',
          message: supabaseErrorMessage(orderError, 'Could not create order.'),
        },
        { status: 500 },
      );
    }
    await logMarketplaceEvent('order_paid', {
      listingId,
      orderId: order.id,
      actorId: buyerId,
      metadata: {
        transactionId: payment.transactionId,
        amount: price,
        negotiationId: negotiationId || null,
        negotiated,
      },
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
