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
  action?: unknown;
  amount?: unknown;
  note?: unknown;
};

const ACTIONS = new Set(['counter', 'accept', 'deny']);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid negotiation', message: 'Negotiation ID is invalid.' },
        { status: 400 },
      );
    }

    const secure = await readSecureMarketplaceBody<Body>(request);
    if (secure.response) return secure.response;

    const sellerId = secure.auth.user.id;
    const action = cleanText(secure.parsed.data.action, 20);
    const amount = Number(secure.parsed.data.amount);
    const note = cleanText(secure.parsed.data.note, 300);

    if (!ACTIONS.has(action)) {
      return NextResponse.json(
        { error: 'Invalid action', message: 'Choose a valid response.' },
        { status: 400 },
      );
    }

    const { data: negotiation, error: fetchError } = await supabaseAdmin
      .from('marketplace_negotiations')
      .select('*, marketplace_listings(price)')
      .eq('id', id)
      .single();

    if (fetchError || !negotiation || negotiation.seller_id !== sellerId) {
      return NextResponse.json(
        { error: 'Unavailable', message: 'Negotiation was not found.' },
        { status: 404 },
      );
    }

    const listingPrice = Number(negotiation.marketplace_listings?.price ?? 0);
    const { data: lastSellerMessage } = await supabaseAdmin
      .from('marketplace_negotiation_messages')
      .select('amount')
      .eq('negotiation_id', id)
      .eq('message_type', 'seller_counter')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let status = negotiation.status;
    let currentOffer = negotiation.current_offer;
    let messageType = action;

    if (action === 'counter') {
      if (
        !Number.isFinite(amount) ||
        !Number.isInteger(amount) ||
        amount <= 0 ||
        amount > listingPrice
      ) {
        return NextResponse.json(
          {
            error: 'Invalid price',
            message:
              'Seller price must be a whole rupee and not above listed price.',
          },
          { status: 400 },
        );
      }
      status = 'seller_countered';
      currentOffer = amount;
      messageType = 'seller_counter';
    } else if (action === 'accept') {
      if (negotiation.last_actor_id === sellerId) {
        return NextResponse.json(
          {
            error: 'No buyer offer',
            message: 'Accept is available only after the buyer sends an offer.',
          },
          { status: 400 },
        );
      }
      status = 'accepted';
      messageType = 'accepted';
    } else if (action === 'deny') {
      if (negotiation.last_actor_id === sellerId) {
        return NextResponse.json(
          {
            error: 'No buyer offer',
            message: 'Deny is available only after the buyer sends an offer.',
          },
          { status: 400 },
        );
      }
      const lastSellerPrice = Number(lastSellerMessage?.amount ?? listingPrice);
      status = 'denied';
      currentOffer =
        Number.isFinite(lastSellerPrice) && lastSellerPrice > 0
          ? lastSellerPrice
          : listingPrice;
      messageType = 'denied';
    }

    const { data, error } = await supabaseAdmin
      .from('marketplace_negotiations')
      .update({
        status,
        current_offer: currentOffer,
        last_actor_id: sellerId,
      })
      .eq('id', id)
      .eq('seller_id', sellerId)
      .select('*')
      .single();

    if (error || !data) throw error;

    await supabaseAdmin.from('marketplace_negotiation_messages').insert({
      negotiation_id: id,
      listing_id: negotiation.listing_id,
      sender_id: sellerId,
      message_type: messageType,
      amount: currentOffer,
      note: note || null,
    });

    return NextResponse.json({ apiVersion: 'v2', data });
  } catch (error) {
    console.error('Marketplace negotiation response error:', error);
    return NextResponse.json(
      {
        error: 'Response failed',
        message: error instanceof Error ? error.message : 'Could not respond.',
      },
      { status: 500 },
    );
  }
}
