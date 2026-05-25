import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPin } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminPin(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseAdmin
    .from('app_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ config: data });
}

export async function PATCH(request: NextRequest) {
  const unauthorized = requireAdminPin(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const payload = {
    maintenance_mode: Boolean(body?.maintenance_mode),
    maintenance_message: body?.maintenance_message
      ? String(body.maintenance_message).trim()
      : null,
    minimum_version: String(body?.minimum_version ?? '1.0.0').trim(),
    download_url: body?.download_url ? String(body.download_url).trim() : null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('app_config')
    .upsert({ id: 1, ...payload }, { onConflict: 'id' })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ config: data });
}
