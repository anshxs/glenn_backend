import { NextRequest, NextResponse } from 'next/server';
import { verifyAdMobSSVSignature } from '@/lib/admob-ssv';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SCRATCH_AD_UNIT = 'ca-app-pub-5483534954389996/8722122769';
const SPINNER_AD_UNIT = 'ca-app-pub-5483534954389996/6798667004';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const searchParams = url.searchParams;
    const rawQueryString = url.search.startsWith('?')
      ? url.search.substring(1)
      : url.search;

    const userId = searchParams.get('user_id')?.trim();
    const customData = searchParams.get('custom_data')?.trim().toLowerCase();
    const adUnit = searchParams.get('ad_unit')?.trim() || '';
    const transactionId = searchParams.get('transaction_id')?.trim();
    const signature = searchParams.get('signature');
    const keyId = searchParams.get('key_id');

    // Google AdMob test pings or health checks might not include user_id
    if (!transactionId) {
      return new NextResponse('OK', { status: 200 });
    }

    // Verify cryptographic signature from Google AdMob servers
    if (signature && keyId) {
      const verification = await verifyAdMobSSVSignature(
        searchParams,
        rawQueryString,
      );
      if (!verification.isValid) {
        console.warn('AdMob SSV signature verification failed:', verification.reason);
        // If strictly invalid signature, return 400
        return NextResponse.json(
          { error: 'Invalid signature', reason: verification.reason },
          { status: 400 },
        );
      }
    }

    // Infer game type
    let gameType: 'spin' | 'scratch' = 'spin';
    if (customData === 'scratch' || adUnit === SCRATCH_AD_UNIT || adUnit.includes('8722122769')) {
      gameType = 'scratch';
    } else if (customData === 'spin' || adUnit === SPINNER_AD_UNIT || adUnit.includes('6798667004')) {
      gameType = 'spin';
    }

    // If a valid userId is present, record the SSV verification into database
    if (userId) {
      const { error: dbError } = await supabaseAdmin
        .from('user_admob_reward_verifications')
        .upsert(
          {
            user_id: userId,
            game_type: gameType,
            ad_unit_id: adUnit,
            transaction_id: transactionId,
            verified_at: new Date().toISOString(),
            consumed: false,
          },
          { onConflict: 'transaction_id' },
        );

      if (dbError) {
        console.error('Failed to store AdMob SSV verification in database:', dbError);
      }
    }

    return new NextResponse('OK', { status: 200 });
  } catch (error) {
    console.error('AdMob SSV endpoint error:', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
