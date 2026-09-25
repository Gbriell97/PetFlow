// Edge Function: services-manage
// POST   -> cria serviço + regras de preço/duração por porte
// PATCH  -> edita serviço (?id=UUID) e, se enviado, substitui as regras de preço/duração
// DELETE -> desativa serviço (?id=UUID)
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

const SIZE_TO_EN: Record<string, string> = { 'Pequeno': 'SMALL', 'Médio': 'MEDIUM', 'Medio': 'MEDIUM', 'Grande': 'LARGE' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });

  const supabase = createClient(
    Deno.env.get('SB_URL') || Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const apiKey = (req.headers.get('x-api-key') || req.headers.get('Authorization')?.replace('Bearer ', '') || '').trim();
  if (!apiKey) return json({ success: false, error: 'Missing API key' }, 401);

  const { data: unit, error: unitErr } = await supabase
    .from('units').select('id, name, timezone').eq('api_key', apiKey).eq('is_deleted', false).single();
  if (unitErr || !unit) return json({ success: false, error: 'Invalid API key' }, 401);

  try {
    // ---------- POST: criar serviço ----------
    if (req.method === 'POST') {
      const body = await req.json();
      if (!body.name) return json({ success: false, error: 'name é obrigatório' }, 400);

      const { data: svc, error: sErr } = await supabase
        .from('services')
        .insert({
          unit_id: unit.id,
          name: body.name,
          description: body.description || null,
          default_price: parseFloat(body.default_price) || 0,
          default_duration_minutes: parseInt(body.duration_minutes) || parseInt(body.default_duration_minutes) || 60,
          capacity: parseInt(body.capacity) || 1,
          buffer_minutes: parseInt(body.buffer_minutes) || 0,
          booking_enabled: true,
          requires_professional: false,
          active: body.is_active !== false,
        })
        .select()
        .single();
      if (sErr) return json({ success: false, error: sErr.message }, 500);

      await upsertRules(supabase, unit.id, svc.id, body);
      return json({ success: true, data: svc });
    }

    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ success: false, error: 'Missing query param: id' }, 400);

    // ---------- PATCH: editar serviço ----------
    if (req.method === 'PATCH') {
      const body = await req.json();
      const update: any = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.description !== undefined) update.description = body.description;
      if (body.duration_minutes !== undefined) update.default_duration_minutes = parseInt(body.duration_minutes);
      if (body.capacity !== undefined) update.capacity = parseInt(body.capacity);
      if (body.is_active !== undefined) update.active = !!body.is_active;

      if (Object.keys(update).length > 0) {
        const { error: uErr } = await supabase.from('services').update(update).eq('id', id).eq('unit_id', unit.id);
        if (uErr) return json({ success: false, error: uErr.message }, 500);
      }

      if (Array.isArray(body.prices)) {
        await supabase.from('service_price_rules').delete().eq('service_id', id).eq('unit_id', unit.id);
        await supabase.from('service_duration_rules').delete().eq('service_id', id).eq('unit_id', unit.id);
        await upsertRules(supabase, unit.id, id, body);
      }

      return json({ success: true, data: { id, updated: true } });
    }

    // ---------- DELETE: desativar ----------
    if (req.method === 'DELETE') {
      const { error: dErr } = await supabase
        .from('services')
        .update({ active: false, is_deleted: true })
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

async function upsertRules(supabase: any, unitId: string, serviceId: string, body: any) {
  const prices: any[] = body.prices || [];
  const duration = parseInt(body.duration_minutes) || 60;

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const sizeEn = SIZE_TO_EN[p.pet_size] || p.pet_size || 'MEDIUM';
    await supabase.from('service_price_rules').insert({
      unit_id: unitId,
      service_id: serviceId,
      name: p.pet_size || sizeEn,
      price: parseFloat(p.price) || 0,
      criteria: { size: sizeEn },
      sort_order: i,
      active: true,
    });
    await supabase.from('service_duration_rules').insert({
      unit_id: unitId,
      service_id: serviceId,
      name: p.pet_size || sizeEn,
      duration_minutes: duration,
      criteria: { size: sizeEn },
      sort_order: i,
      active: true,
    });
  }
}
