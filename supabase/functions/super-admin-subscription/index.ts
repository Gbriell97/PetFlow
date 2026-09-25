// Edge Function: super-admin-subscription
// GET    -> lista planos  |  GET ?unit_id= -> assinatura da unidade (formato garantido)
// POST   -> cria plano { name, price, ... }
// PUT    -> atualiza plano { plan_id, ... } OU assinatura { unit_id, ... }
// DELETE -> exclui plano (?plan_id=UUID)
// Auth: role SUPER_ADMIN na tabela unit_users (mesmo padrão da plataforma)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function writeSafe(supabase: any, table: string, payload: any, isUpdate: boolean, id?: string) {
  let body = { ...payload };
  for (let attempt = 0; attempt < 8; attempt++) {
    const query = isUpdate
      ? supabase.from(table).update(body).eq('id', id).select().single()
      : supabase.from(table).insert(body).select().single();
    const { data, error } = await query;
    if (!error) return { data };
    const m = error.message.match(/Could not find the '(\w+)' column/);
    if (m && body[m[1]] !== undefined) { delete body[m[1]]; continue; }
    return { error };
  }
  return { error: new Error('Falha após remover colunas desconhecidas') };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const sbUrl = Deno.env.get('SB_URL') || Deno.env.get('SUPABASE_URL');
  const sbServiceKey = Deno.env.get('SB_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(sbUrl!, sbServiceKey!);

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return json({ success: false, error: 'Não autorizado' }, 401);

  const { data: adminCheck } = await supabase
    .from('unit_users').select('role')
    .eq('user_id', user.id)
    .eq('role', 'SUPER_ADMIN')
    .eq('is_active', true)
    .maybeSingle();
  if (!adminCheck) return json({ success: false, error: 'Acesso negado' }, 403);

  const url = new URL(req.url);

  try {
    // ---------- GET: assinatura da unidade OU lista de planos ----------
    if (req.method === 'GET') {
      const unitId = url.searchParams.get('unit_id');
      if (unitId) {
        const { data: plans } = await supabase
          .from('plans').select('*')
          .order('price', { ascending: true });
        const { data: sub } = await supabase
          .from('subscriptions').select('*')
          .eq('unit_id', unitId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        let subscription = null;
        if (sub) {
          const planObj = ((plans || []) as any[]).find(p => p.id === (sub as any).plan_id) || null;
          subscription = { ...sub, plans: planObj };
        }
        // Histórico: todas as assinaturas da unidade (mais recentes primeiro)
        const { data: subs } = await supabase
          .from('subscriptions').select('*')
          .eq('unit_id', unitId)
          .order('created_at', { ascending: false })
          .limit(20);
        const history = ((subs || []) as any[]).map(s => ({
          ...s,
          plan_name: ((plans || []) as any[]).find(p => p.id === s.plan_id)?.name || null,
        }));
        return json({ success: true, data: { plans: plans || [], subscription, history } });
      }
      const { data: plans, error } = await supabase
        .from('plans').select('*')
        .order('price', { ascending: true });
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data: plans || [] });
    }

    // ---------- DELETE: excluir plano ----------
    if (req.method === 'DELETE') {
      const planId = url.searchParams.get('plan_id');
      if (!planId) return json({ success: false, error: 'Missing query param: plan_id' }, 400);
      const { error } = await supabase.from('plans').delete().eq('id', planId);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, message: 'Plano excluído' });
    }

    const body = await req.json();

    // ---------- POST: criar plano ----------
    if (req.method === 'POST' && !body.unit_id) {
      if (!body.name) return json({ success: false, error: 'name é obrigatório' }, 400);
      const payload: any = {};
      for (const f of ['name', 'price', 'description', 'features', 'interval', 'max_units', 'active']) {
        if (body[f] !== undefined) payload[f] = body[f];
      }
      if (payload.price !== undefined) payload.price = parseFloat(payload.price) || 0;
      const { data, error } = await writeSafe(supabase, 'plans', payload, false);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data, message: 'Plano criado' });
    }

    // ---------- PUT: atualizar plano ----------
    if (req.method === 'PUT' && body.plan_id && !body.unit_id) {
      const payload: any = {};
      for (const f of ['name', 'price', 'description', 'features', 'interval', 'max_units', 'active']) {
        if (body[f] !== undefined && body[f] !== '') payload[f] = body[f];
      }
      if (payload.price !== undefined) payload.price = parseFloat(payload.price) || 0;
      if (Object.keys(payload).length === 0) return json({ success: false, error: 'Nada para atualizar' }, 400);
      const { data, error } = await writeSafe(supabase, 'plans', payload, true, body.plan_id);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data, message: 'Plano atualizado' });
    }

    // ---------- PUT/POST: criar/atualizar assinatura da unidade ----------
    if ((req.method === 'PUT' || req.method === 'POST') && body.unit_id) {
      const { data: unit } = await supabase
        .from('units').select('id').eq('id', body.unit_id).eq('is_deleted', false).single();
      if (!unit) return json({ success: false, error: 'Unidade não encontrada' }, 404);

      const payload: any = {};
      for (const f of ['plan_id', 'amount', 'billing_cycle', 'status', 'start_date', 'end_date',
                       'renewal_date', 'next_billing_date', 'payment_status', 'auto_renew']) {
        if (body[f] !== undefined && body[f] !== '') payload[f] = body[f];
      }
      if (payload.amount !== undefined) payload.amount = parseFloat(payload.amount) || 0;
      if (payload.auto_renew !== undefined) payload.auto_renew = !!payload.auto_renew;

      const { data: existing } = await supabase
        .from('subscriptions').select('id').eq('unit_id', body.unit_id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();

      if (existing) {
        const { data, error } = await writeSafe(supabase, 'subscriptions', payload, true, (existing as any).id);
        if (error) return json({ success: false, error: error.message }, 500);
        return json({ success: true, data, message: 'Assinatura atualizada' });
      }
      const { data, error } = await writeSafe(supabase, 'subscriptions', { unit_id: body.unit_id, ...payload }, false);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data, message: 'Assinatura criada' });
    }

    return json({ success: false, error: 'Requisição inválida: envie plan_id (plano) ou unit_id (assinatura)' }, 400);
  } catch (e) {
    return json({ success: false, error: 'Erro interno: ' + (e as Error).message }, 500);
  }
});
