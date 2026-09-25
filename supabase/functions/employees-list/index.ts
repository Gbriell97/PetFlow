// Edge Function: employees-list
// GET    -> funcionários da unidade
// POST   -> cria funcionário (colunas desconhecidas são ignoradas automaticamente)
// PATCH  -> edita funcionário (?id=UUID)
// DELETE -> soft delete (?id=UUID)
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

// Tenta insert/update; se o PostgREST reclamar de coluna inexistente,
// remove a coluna e tenta de novo (max 8 tentativas). A prova de schema drift.
async function writeSafe(supabase: any, table: string, payload: any, isUpdate: boolean, id?: string, unitId?: string) {
  let body = { ...payload };
  for (let attempt = 0; attempt < 8; attempt++) {
    let query = isUpdate
      ? supabase.from(table).update(body).eq('id', id)
      : supabase.from(table).insert(body).select().single();
    if (isUpdate && unitId) query = query.eq('unit_id', unitId);
    const { data, error } = await query;
    if (!error) return { data };
    const m = error.message.match(/Could not find the '(\w+)' column/);
    if (m && body[m[1]] !== undefined) { delete body[m[1]]; continue; }
    return { error };
  }
  return { error: new Error('Falha após remover colunas desconhecidas') };
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
    .from('units').select('id').eq('api_key', apiKey).eq('is_deleted', false).single();
  if (unitErr || !unit) return json({ success: false, error: 'Invalid API key' }, 401);

  try {
    if (req.method === 'GET') {
      const { data: employees, error: eErr } = await supabase
        .from('employees')
        .select('*')
        .eq('unit_id', unit.id)
        .eq('is_deleted', false)
        .order('name', { ascending: true });
      if (eErr) return json({ success: false, error: eErr.message }, 500);
      return json({ success: true, data: employees || [] });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      if (!body.name) return json({ success: false, error: 'name é obrigatório' }, 400);
      const payload: any = { unit_id: unit.id, status: 'ACTIVE', is_deleted: false };
      for (const f of ['name', 'phone', 'email', 'color', 'bio', 'photo_url']) {
        if (body[f] !== undefined) payload[f] = body[f] === '' ? null : body[f];
      }
      const { data, error } = await writeSafe(supabase, 'employees', payload, false);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data });
    }

    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ success: false, error: 'Missing query param: id' }, 400);

    if (req.method === 'PATCH') {
      const body = await req.json();
      const payload: any = {};
      for (const f of ['name', 'phone', 'email', 'color', 'bio', 'photo_url']) {
        if (body[f] !== undefined) payload[f] = body[f] === '' ? null : body[f];
      }
      if (body.is_active !== undefined) payload.status = body.is_active ? 'ACTIVE' : 'INACTIVE';
      if (Object.keys(payload).length === 0) return json({ success: false, error: 'Nada para atualizar' }, 400);
      const { error } = await writeSafe(supabase, 'employees', payload, true, id, unit.id);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data: { id, updated: true } });
    }

    if (req.method === 'DELETE') {
      const { error: dErr } = await supabase
        .from('employees')
        .update({ is_deleted: true })
        .eq('id', id)
        .eq('unit_id', unit.id);
      if (dErr) return json({ success: false, error: dErr.message }, 500);
      return json({ success: true, data: { deleted: id } });
    }

    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
});
