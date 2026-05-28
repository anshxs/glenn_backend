import { NextRequest, NextResponse } from 'next/server';

import {
  cleanStringList,
  cleanText,
  LISTING_FEE,
  logMarketplaceEvent,
  readSecureMarketplaceBody,
} from '@/lib/marketplace';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = {
  listingType?: unknown;
  title?: unknown;
  description?: unknown;
  price?: unknown;
  gameUid?: unknown;
  guildId?: unknown;
  youtubeUrl?: unknown;
  imageUrls?: unknown;
};

export async function POST(request: NextRequest) {
  try {
    const secure = await readSecureMarketplaceBody<Body>(request);
    if (secure.response) return secure.response;

    const userId = secure.auth.user.id;
    const listingType = cleanText(secure.parsed.data.listingType, 20);
    const title = cleanText(secure.parsed.data.title, 90);
    const description = cleanText(secure.parsed.data.description, 1200);
    const price = Number(secure.parsed.data.price);
    const gameUid = cleanText(secure.parsed.data.gameUid, 40);
    const guildId = cleanText(secure.parsed.data.guildId, 60);
    const youtubeUrl = cleanText(secure.parsed.data.youtubeUrl, 300);
    const imageUrls = cleanStringList(secure.parsed.data.imageUrls, 6);

    if (!['game_id', 'guild'].includes(listingType)) {
      return NextResponse.json(
        { error: 'Invalid listing', message: 'Select ID or Guild listing.' },
        { status: 400 },
      );
    }

    if (!title || !Number.isFinite(price) || price <= 0 || imageUrls.length < 4) {
      return NextResponse.json(
        {
          error: 'Invalid listing',
          message: 'Add title, valid price and 4 to 6 images.',
        },
        { status: 400 },
      );
    }

    if (listingType === 'game_id' && !gameUid) {
      return NextResponse.json(
        { error: 'Missing UID', message: 'Free Fire UID is required.' },
        { status: 400 },
      );
    }

    if (listingType === 'guild' && !guildId) {
      return NextResponse.json(
        { error: 'Missing guild ID', message: 'Guild ID is required.' },
        { status: 400 },
      );
    }

    const { data: restriction, error: restrictionError } = await supabaseAdmin
      .from('marketplace_user_restrictions')
      .select('is_listing_banned, reason')
      .eq('user_id', userId)
      .maybeSingle();

    if (restrictionError) {
      console.error('Marketplace restriction check failed:', restrictionError);
    }

    if (restriction?.is_listing_banned === true) {
      return NextResponse.json(
        {
          error: 'Listing blocked',
          message: restriction.reason || 'Your account cannot list items right now.',
        },
        { status: 403 },
      );
    }

    const { data, error } = await supabaseAdmin
      .from('marketplace_listings')
      .insert({
        seller_id: userId,
        listing_type: listingType,
        status: 'fee_pending',
        title,
        description: description || null,
        price,
        game_uid: listingType === 'game_id' ? gameUid : null,
        guild_id: listingType === 'guild' ? guildId : null,
        youtube_url: youtubeUrl || null,
        image_urls: imageUrls,
        listing_fee_amount: LISTING_FEE,
      })
      .select('*')
      .single();

    if (error) {
      console.error('Marketplace listing insert failed:', error);
      throw error;
    }

    try {
      await logMarketplaceEvent('listing_created', {
        listingId: data.id,
        actorId: userId,
        metadata: { listingType },
      });
    } catch (eventError) {
      console.error('Marketplace listing event log failed:', eventError);
    }

    return NextResponse.json({ apiVersion: 'v2', data });
  } catch (error) {
    console.error('Marketplace listing create error:', error);
    return NextResponse.json(
      {
        error: 'Listing failed',
        message: error instanceof Error ? error.message : 'Could not create listing.',
      },
      { status: 500 },
    );
  }
}
