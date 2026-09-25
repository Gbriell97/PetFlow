// Edge Function: blocks
// GET    -> lista bloqueios da unidade
// POST   -> cria bloqueio (period_type tolerante ao enum do banco)
// PATCH  -> edita bloqueio (?id=UUID)
// DELETE -> remove bloqueio (?id=UUID)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// Tenta salvar com várias formas do period_type até o enum do banco aceitar
async function insertWithType(supabase: any, row: any, rawType: string, id?: string, isUpdate = false) {
  const candidates = [...new Set([
    rawType, rawType.toUpperCase(), rawType.toLowerCase(),
    'OTHER', 'other', 'HOLIDAY', 'FERIADO', null,
  ])];
  let lastErr: any = null;
  for (const pt of candidates) {
    const payload = { ...row, period_type: pt };
    const query = isUpdate
      ? supabase.from('blocked_periods').update(payload).eq('id', id)
      : supabase.from('blocked_periods').insert(payload).select().single();
    const { data, error } = await query;
    if (!error) return { data };
    if (!/invalid input value for enum/i.test(error.message)) return { error };
    lastErr = error;
  }
  return { error: lastErr || new Error('Enum blocked_period_type sem valor compatível') };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });

  const supabase = createClient(
    Deno.env.get('SB_URL') || Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const apiKey = (req.headers.get('x-api-key') || req.headers.get('Authorization')?.replace('Bearer ', '') || '').trim();
  if (!apiKey) return json({ success: false, error: 'Missing API key' }, 401);

  const { data: unit, error: unitErr } = await supabase
    .from('units').select('id, name').eq('api_key', apiKey).eq('is_deleted', false).single();
  if (unitErr || !unit) return json({ success: false, error: 'Invalid API key' }, 401);

  try {
    if (req.method === 'GET') {
      const { data: blocks, error: bErr } = await supabase
        .from('blocked_periods').select('*').eq('unit_id', unit.id)
        .order('start_datetime', { ascending: false });
      if (bErr) return json({ success: false, error: bErr.message }, 500);
      return json({ success: true, data: blocks || [] });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      if (!body.start_datetime || !body.end_datetime) {
        return json({ success: false, error: 'start_datetime e end_datetime são obrigatórios' }, 400);
      }
      const row = {
        unit_id: unit.id,
        start_datetime: body.start_datetime,
        end_datetime: body.end_datetime,
        reason: body.reason || null,
      };
      const { data, error } = await insertWithType(supabase, row, (body.period_type || body.type || '').toString());
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data });
    }

    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ success: false, error: 'Missing query param: id' }, 400);

    if (req.method === 'PATCH') {
      const body = await req.json();
      const row: any = {};
      if (body.start_datetime) row.start_datetime = body.start_datetime;
      if (body.end_datetime) row.end_datetime = body.end_datetime;
      if (body.reason !== undefined) row.reason = body.reason;
      const { data, error } = await insertWithType(
        supabase, row,
        (body.period_type || body.type || '').toString(), id, true,
      );
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data: { id, updated: true } });
    }

    if (req.method === 'DELETE') {
      const { error: dErr } = await supabase
        .from('blocked_periods').delete().eq('id', id).eq('unit_id', unit.id);
      if (dErr) return json({ success: false, error: dErr.message }, 500);
      return json({ success: true, data: { deleted: id } });
    }

    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
});
