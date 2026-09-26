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

// Sincroniza os serviços vinculados ao funcionário (tabela employee_services).
// O painel envia NOMES de serviços; aqui resolvemos para IDs, sempre restritos
// à unidade do funcionário. Estratégia: remove os vínculos antigos e recria.
async function syncServices(supabase: any, unitId: string, employeeId: string, serviceNames: any) {
  if (!Array.isArray(serviceNames)) return;
  const { error: delErr } = await supabase
    .from('employee_services').delete().eq('employee_id', employeeId);
  if (delErr) throw new Error('Falha ao limpar vínculos: ' + delErr.message);
  if (serviceNames.length === 0) return;
  const { data: svcs, error: sErr } = await supabase
    .from('services').select('id,name')
    .eq('unit_id', unitId).eq('is_deleted', false)
    .in('name', serviceNames);
  if (sErr) throw new Error('Falha ao buscar serviços: ' + sErr.message);
  const rows = (svcs || []).map((s: any) => ({ employee_id: employeeId, service_id: s.id }));
  if (rows.length > 0) {
    const { error: iErr } = await supabase.from('employee_services').insert(rows);
    if (iErr) throw new Error('Falha ao vincular serviços: ' + iErr.message);
  }
}

// Anexa em cada funcionário a lista de NOMES de serviços vinculados
// (o painel exibe/compara por nome).
async function attachServices(supabase: any, unitId: string, employees: any[]) {
  const ids = employees.map((e: any) => e.id);
  if (ids.length === 0) return employees;
  const { data: links } = await supabase
    .from('employee_services').select('employee_id, service_id').in('employee_id', ids);
  const { data: svcs } = await supabase
    .from('services').select('id,name').eq('unit_id', unitId).eq('is_deleted', false);
  const nameById = new Map((svcs || []).map((s: any) => [s.id, s.name]));
  const byEmp = new Map<string, string[]>();
  for (const l of links || []) {
    const nm = nameById.get(l.service_id);
    if (!nm) continue;
    if (!byEmp.has(l.employee_id)) byEmp.set(l.employee_id, []);
    byEmp.get(l.employee_id)!.push(nm);
  }
  for (const e of employees) e.services = byEmp.get(e.id) || [];
  return employees;
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
      const withServices = await attachServices(supabase, unit.id, employees || []);
      return json({ success: true, data: withServices });
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
      if (data && data.id) await syncServices(supabase, unit.id, data.id, body.services);
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
      if (Object.keys(payload).length > 0) {
        const { error } = await writeSafe(supabase, 'employees', payload, true, id, unit.id);
        if (error) return json({ success: false, error: error.message }, 500);
      }
      if (body.services !== undefined) await syncServices(supabase, unit.id, id, body.services);
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
