import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/mobile/tournaments?status=all|upcoming|ongoing&category=&search=&limit=100
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') ?? 'all';
  const category = searchParams.get('category');
  const search = searchParams.get('search');
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? '100')));

  const nowIso = new Date().toISOString();

  let query = supabaseAdmin
    .from('tournaments')
    .select('*')
    .order('tournament_datetime', { ascending: true })
    .limit(limit);

  // Preserve app behavior: completed means results_submitted=true, others false.
  if (status === 'upcoming') {
    query = query.eq('results_submitted', false).gte('tournament_datetime', nowIso);
  } else if (status === 'ongoing') {
    query = query.eq('results_submitted', false).lte('tournament_datetime', nowIso);
  } else if (status === 'completed') {
    query = query.eq('results_submitted', true);
  }

  if (category && category.toLowerCase() != 'all') {
    query = query.ilike('categories', `%${category}%`);
  }

  if (search && search.trim().isNotEmpty) {
    const q = search.trim();
    query = query.or(`tournament_name.ilike.%${q}%,description.ilike.%${q}%`);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}
