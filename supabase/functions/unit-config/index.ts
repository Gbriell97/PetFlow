// Edge Function: unit-config
// GET -> dados da unidade (painel Configurações)
// PUT -> atualiza dados cadastrais da própria unidade (colunas desconhecidas ignoradas)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function writeSafe(supabase: any, payload: any, unitId: string) {
  let body = { ...payload };
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await supabase.from('units').update(body).eq('id', unitId).select().single();
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
    .from('units').select('*').eq('api_key', apiKey).eq('is_deleted', false).single();
  if (unitErr || !unit) return json({ success: false, error: 'Invalid API key' }, 401);

  try {
    if (req.method === 'GET') {
      return json({ success: true, data: unit });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await req.json();
      const payload: any = {};
      for (const f of ['name', 'phone', 'email', 'zip_code', 'street', 'number', 'complement',
                       'neighborhood', 'city', 'state', 'country', 'description', 'welcome_message', 'footer_text']) {
        if (body[f] !== undefined) payload[f] = body[f] === '' ? null : body[f];
      }
      if (Object.keys(payload).length === 0) {
        return json({ success: false, error: 'Nada para atualizar' }, 400);
      }
      const { data, error } = await writeSafe(supabase, payload, unit.id);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data });
    }

    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
});
