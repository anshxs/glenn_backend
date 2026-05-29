import { NextRequest, NextResponse } from 'next/server';

import {
  creditWallet,
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

    if (!['fee_pending', 'active'].includes(listing.status)) {
      return NextResponse.json(
        { error: 'Cannot unlist', message: 'This listing is already locked.' },
        { status: 400 },
      );
    }

    let refundTransactionId: string | null = null;
    const storedFee = Number(listing.listing_fee_amount);
    const amount = Number.isFinite(storedFee) && storedFee > 0
      ? storedFee
      : LISTING_FEE;
    if (listing.status === 'active' && amount > 0) {
      refundTransactionId = await creditWallet(
        userId,
        amount,
        `marketplace_listing_refund:${id}`,
        {
          feature: 'marketplace',
          listing_id: id,
          purpose: 'listing_fee_refund',
          marketplace_transaction_type: 'MARKETPLACE_LISTING_REFUND',
        },
        'MARKETPLACE_LISTING_REFUND',
      );
    }

    const { data, error } = await supabaseAdmin
      .from('marketplace_listings')
      .update({ status: 'unlisted', unlisted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('seller_id', userId)
      .in('status', ['fee_pending', 'active'])
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('Could not unlist item.');
    await logMarketplaceEvent('listing_unlisted', {
      listingId: id,
      actorId: userId,
      metadata: { refundTransactionId, refundAmount: amount },
    });

    return NextResponse.json({ apiVersion: 'v2', data });
  } catch (error) {
    console.error('Marketplace unlist error:', error);
    return NextResponse.json(
      {
        error: 'Unlist failed',
        message: error instanceof Error ? error.message : 'Could not unlist item.',
      },
      { status: 500 },
    );
  }
}
