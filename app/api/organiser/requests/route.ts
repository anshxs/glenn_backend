import { NextRequest, NextResponse } from 'next/server';
import { verifyBearerToken } from '@/lib/auth';
import { verifyOrganiserRequestSecurity } from '@/lib/organiser-request-security';
import { supabaseAdmin } from '@/lib/supabase';
import { uploadToImageKit } from '@/lib/imagekit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface OrganiserRequestRow {
  id: string;
  user_id: string;
  glenn_id: string;
  name: string;
  contact_number: string;
  alternate_contact_number: string | null;
  address: string;
  aadhar_card_url: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  permanently_banned: boolean;
  can_reappeal: boolean;
  is_reappeal: boolean;
  reappeal_of: string | null;
  created_at: string;
  updated_at: string;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function parseBoolean(v: FormDataEntryValue | null): boolean {
  if (!v) return false;
  return String(v).toLowerCase() === 'true';
}

export async function GET(request: NextRequest) {
  try {
    const securityError = await verifyOrganiserRequestSecurity(request);
    if (securityError) {
      return securityError;
    }

    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const { data, error } = await supabaseAdmin
      .from('organiser_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: 'Failed to fetch requests', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: data ?? [],
    });
  } catch (error) {
    console.error('organiser requests GET error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const aadharFile = formData.get('aadhar_file');
    const securityBody = JSON.stringify({
      name: String(formData.get('name') ?? '').trim(),
      contact_number: String(formData.get('contact_number') ?? '').trim(),
      alternate_contact_number: String(formData.get('alternate_contact_number') ?? '').trim(),
      address: String(formData.get('address') ?? '').trim(),
      glenn_id: String(formData.get('glenn_id') ?? '').trim(),
      is_reappeal: String(formData.get('is_reappeal') ?? '').trim(),
      reappeal_of: String(formData.get('reappeal_of') ?? '').trim(),
      has_aadhar_file: aadharFile instanceof File,
      aadhar_file_size: aadharFile instanceof File ? aadharFile.size : null,
    });
    const securityError = await verifyOrganiserRequestSecurity(request, {
      bodyText: securityBody,
    });
    if (securityError) {
      return securityError;
    }

    const user = await verifyBearerToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or missing authentication token' },
        { status: 401 }
      );
    }

    const name = String(formData.get('name') ?? '').trim();
    const contactNumber = String(formData.get('contact_number') ?? '').trim();
    const alternateContactNumberRaw = String(formData.get('alternate_contact_number') ?? '').trim();
    const address = String(formData.get('address') ?? '').trim();
    const glennIdRaw = String(formData.get('glenn_id') ?? '').trim();
    const reappealOfRaw = String(formData.get('reappeal_of') ?? '').trim();
    const forceReappeal = parseBoolean(formData.get('is_reappeal'));

    if (!name) return badRequest('name is required');
    if (!contactNumber) return badRequest('contact_number is required');
    if (!address) return badRequest('address is required');

    const glennId = glennIdRaw || user.id;
    const alternateContactNumber = alternateContactNumberRaw || null;
    const reappealOf = reappealOfRaw || null;

    const { data: existingOrganiser, error: organiserError } = await supabaseAdmin
      .from('organisers')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (organiserError) {
      return NextResponse.json(
        { error: 'Failed to check organiser profile', details: organiserError.message },
        { status: 500 }
      );
    }

    if (existingOrganiser) {
      return badRequest('User is already an organiser');
    }

    const { data: latestRequest, error: latestRequestError } = await supabaseAdmin
      .from('organiser_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<OrganiserRequestRow>();

    if (latestRequestError) {
      return NextResponse.json(
        { error: 'Failed to load latest request', details: latestRequestError.message },
        { status: 500 }
      );
    }

    if (latestRequest?.permanently_banned) {
      return NextResponse.json(
        { error: 'BANNED', message: 'Your organiser account is permanently banned.' },
        { status: 403 }
      );
    }

    if (latestRequest?.status === 'pending') {
      return badRequest('A request is already pending approval');
    }

    let isReappeal = forceReappeal;
    let reappealBaseId: string | null = reappealOf;

    if (
      latestRequest &&
      latestRequest.status === 'rejected' &&
      latestRequest.can_reappeal &&
      (forceReappeal || !reappealOf)
    ) {
      isReappeal = true;
      reappealBaseId = latestRequest.id;
    }

    let aadharCardUrl: string | null = null;

    if (aadharFile && aadharFile instanceof File && aadharFile.size > 0) {
      const upload = await uploadToImageKit({
        file: aadharFile,
        folder: '/organiser-aadhar',
        prefix: user.id,
        tags: ['organiser', 'aadhar'],
      });
      aadharCardUrl = upload.url;
    } else if (latestRequest?.aadhar_card_url) {
      aadharCardUrl = latestRequest.aadhar_card_url;
    }

    if (!aadharCardUrl) {
      return badRequest('aadhar_file is required for first submission');
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('organiser_requests')
      .insert({
        user_id: user.id,
        glenn_id: glennId,
        name,
        contact_number: contactNumber,
        alternate_contact_number: alternateContactNumber,
        address,
        aadhar_card_url: aadharCardUrl,
        status: 'pending',
        rejection_reason: null,
        permanently_banned: false,
        can_reappeal: false,
        is_reappeal: isReappeal,
        reappeal_of: reappealBaseId,
      })
      .select('*')
      .single();

    if (insertError) {
      return NextResponse.json(
        { error: 'Failed to create organiser request', details: insertError.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: inserted,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('organiser requests POST error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
