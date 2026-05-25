import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPin } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLES = new Set(['announcements', 'announcements_with_image']);

function tableFromUrl(request: NextRequest): string {
  const table = request.nextUrl.searchParams.get('type') === 'image'
    ? 'announcements_with_image'
    : 'announcements';
  return table;
}

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminPin(request);
  if (unauthorized) return unauthorized;

  const table = tableFromUrl(request);
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminPin(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const table = body?.type === 'image' ? 'announcements_with_image' : 'announcements';
  if (!TABLES.has(table)) {
    return NextResponse.json({ error: 'Invalid announcement type' }, { status: 400 });
  }

  const payload: Record<string, unknown> = {
    message: String(body?.message ?? '').trim(),
    onclick: body?.onclick ? String(body.onclick).trim() : null,
    display: Boolean(body?.display),
  };

  if (!payload.message) {
    return NextResponse.json({ error: 'Message is required' }, { status: 400 });
  }

  if (table === 'announcements_with_image') {
    payload.image_url = String(body?.image_url ?? '').trim();
    if (!payload.image_url) {
      return NextResponse.json({ error: 'Image URL is required' }, { status: 400 });
    }
  }

  const { data, error } = await supabaseAdmin
    .from(table)
    .insert(payload)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ item: data });
}

export async function PATCH(request: NextRequest) {
  const unauthorized = requireAdminPin(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const table = body?.type === 'image' ? 'announcements_with_image' : 'announcements';
  const id = String(body?.id ?? '').trim();
  if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

  const payload: Record<string, unknown> = {};
  if (body.message !== undefined) payload.message = String(body.message).trim();
  if (body.onclick !== undefined) {
    payload.onclick = body.onclick ? String(body.onclick).trim() : null;
  }
  if (body.display !== undefined) payload.display = Boolean(body.display);
  if (table === 'announcements_with_image' && body.image_url !== undefined) {
    payload.image_url = String(body.image_url).trim();
  }

  const { data, error } = await supabaseAdmin
    .from(table)
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ item: data });
}

export async function DELETE(request: NextRequest) {
  const unauthorized = requireAdminPin(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const table = body?.type === 'image' ? 'announcements_with_image' : 'announcements';
  const id = String(body?.id ?? '').trim();
  if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

  const { error } = await supabaseAdmin.from(table).delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
