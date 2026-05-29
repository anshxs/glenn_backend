import { NextRequest, NextResponse } from 'next/server';

import {
  cleanText,
  readSecureMarketplaceBody,
  UUID_RE,
} from '@/lib/marketplace';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = {
  amount?: unknown;
  note?: unknown;
};

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
    const amount = Number(secure.parsed.data.amount);
    const note = cleanText(secure.parsed.data.note, 300);

    const { data: listing, error: listingError } = await supabaseAdmin
      .from('marketplace_listings')
      .select('id, seller_id, price, status')
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
        { error: 'Invalid offer', message: 'You cannot negotiate on your own listing.' },
        { status: 400 },
      );
    }

    if (!Number.isFinite(amount) || amount <= 0 || amount >= Number(listing.price)) {
      return NextResponse.json(
        { error: 'Invalid offer', message: 'Offer must be below current price.' },
        { status: 400 },
      );
    }

    const { data: negotiation, error: upsertError } = await supabaseAdmin
      .from('marketplace_negotiations')
      .upsert(
        {
          listing_id: listingId,
          seller_id: listing.seller_id,
          buyer_id: buyerId,
          status: 'buyer_countered',
          current_offer: amount,
          last_actor_id: buyerId,
          blocked_at: null,
        },
        { onConflict: 'listing_id,buyer_id' },
      )
      .select('*')
      .single();

    if (upsertError || !negotiation) throw upsertError;

    if (negotiation.status === 'blocked') {
      return NextResponse.json(
        { error: 'Blocked', message: 'Seller blocked further negotiations.' },
        { status: 403 },
      );
    }

    await supabaseAdmin.from('marketplace_negotiation_messages').insert({
      negotiation_id: negotiation.id,
      listing_id: listingId,
      sender_id: buyerId,
      message_type: 'buyer_offer',
      amount,
      note: note || null,
    });

    return NextResponse.json({ apiVersion: 'v2', data: negotiation });
  } catch (error) {
    console.error('Marketplace offer error:', error);
    return NextResponse.json(
      {
        error: 'Offer failed',
        message: error instanceof Error ? error.message : 'Could not send offer.',
      },
      { status: 500 },
    );
  }
}
