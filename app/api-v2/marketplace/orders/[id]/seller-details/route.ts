import { NextRequest, NextResponse } from 'next/server';

import {
  cleanText,
  logMarketplaceEvent,
  readSecureMarketplaceBody,
  UUID_RE,
} from '@/lib/marketplace';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = {
  loginId?: unknown;
  password?: unknown;
  recoveryInfo?: unknown;
  notes?: unknown;
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: orderId } = await context.params;
    if (!UUID_RE.test(orderId)) {
      return NextResponse.json(
        { error: 'Invalid order', message: 'Order ID is invalid.' },
        { status: 400 },
      );
    }

    const secure = await readSecureMarketplaceBody<Body>(request);
    if (secure.response) return secure.response;
    const sellerId = secure.auth.user.id;

    const loginId = cleanText(secure.parsed.data.loginId, 200);
    const password = cleanText(secure.parsed.data.password, 200);
    const recoveryInfo = cleanText(secure.parsed.data.recoveryInfo, 1000);
    const notes = cleanText(secure.parsed.data.notes, 1000);

    if (!loginId || !password) {
      return NextResponse.json(
        { error: 'Missing details', message: 'Login ID and password are required.' },
        { status: 400 },
      );
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('marketplace_orders')
      .select('id, listing_id, seller_id, status')
      .eq('id', orderId)
      .single();

    if (orderError || !order || order.seller_id !== sellerId) {
      return NextResponse.json(
        { error: 'Order unavailable', message: 'Order was not found.' },
        { status: 404 },
      );
    }

    if (order.status !== 'seller_credentials_pending') {
      return NextResponse.json(
        { error: 'Cannot submit', message: 'Seller details are not pending.' },
        { status: 400 },
      );
    }

    const { error: detailsError } = await supabaseAdmin
      .from('marketplace_private_details')
      .upsert(
        {
          order_id: orderId,
          listing_id: order.listing_id,
          seller_id: sellerId,
          secret_payload: { loginId, password, recoveryInfo, notes },
        },
        { onConflict: 'order_id' },
      );

    if (detailsError) throw detailsError;

    const { data, error } = await supabaseAdmin
      .from('marketplace_orders')
      .update({ status: 'admin_verifying' })
      .eq('id', orderId)
      .eq('seller_id', sellerId)
      .eq('status', 'seller_credentials_pending')
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('Could not update order.');
    await supabaseAdmin
      .from('marketplace_listings')
      .update({ status: 'verification_pending' })
      .eq('id', order.listing_id);

    await logMarketplaceEvent('seller_details_submitted', {
      listingId: order.listing_id,
      orderId,
      actorId: sellerId,
    });

    return NextResponse.json({ apiVersion: 'v2', data });
  } catch (error) {
    console.error('Marketplace seller details error:', error);
    return NextResponse.json(
      {
        error: 'Submit failed',
        message:
          error instanceof Error ? error.message : 'Could not submit seller details.',
      },
      { status: 500 },
    );
  }
}
