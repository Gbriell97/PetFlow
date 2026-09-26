// Padrao PetFlow: funcoes de unidade autenticam via header x-api-key
// (ou Authorization: Bearer <api_key>). Respostas: { success, data }.
// Edge Function: business-hours
// GET  -> lista os 7 dias da unidade
// PUT  -> salva todos os dias de uma vez (body: { hours: [...] })
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function getApiKey(req: Request): string {
  return (req.headers.get('x-api-key') || req.headers.get('Authorization')?.replace('Bearer ', '') || '').trim();
}

async function getUnit(supabase: any, req: Request) {
  const apiKey = getApiKey(req);
  if (!apiKey) return { error: json({ success: false, error: 'Missing API key' }, 401) };
  const { data: unit, error } = await supabase
    .from('units')
    .select('id, name, timezone')
    .eq('api_key', apiKey)
    .eq('is_deleted', false)
    .single();
  if (error || !unit) return { error: json({ success: false, error: 'Invalid API key' }, 401) };
  return { unit };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });

  const supabase = createClient(
    Deno.env.get('SB_URL') || Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { unit, error } = await getUnit(supabase, req);
  if (error) return error;

  try {
    if (req.method === 'GET') {
      const { data: hours, error: hErr } = await supabase
        .from('business_hours')
        .select('*')
        .eq('unit_id', unit.id)
        .order('day_of_week', { ascending: true });
      if (hErr) return json({ success: false, error: hErr.message }, 500);
      return json({ success: true, data: hours || [] });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await req.json();
      const hours = body.hours || body;
      if (!Array.isArray(hours) || hours.length === 0) {
        return json({ success: false, error: 'Body deve conter { hours: [...] }' }, 400);
      }
      const rows = hours.map((h: any) => ({
        unit_id: unit.id,
        day_of_week: h.day_of_week,
        open_time: h.open_time || null,
        close_time: h.close_time || null,
        is_closed: h.is_closed === undefined ? (h.is_open !== undefined ? !h.is_open : false) : h.is_closed,
      }));
      const { error: uErr } = await supabase
        .from('business_hours')
        .upsert(rows, { onConflict: 'unit_id,day_of_week' });
      if (uErr) return json({ success: false, error: uErr.message }, 500);
      return json({ success: true, data: { updated: rows.length } });
    }

    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
});
