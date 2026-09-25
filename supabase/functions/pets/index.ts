// Edge Function: pets
// POST   -> cria pet (sex e size aceitam português/inglês)
// PATCH  -> edita pet (?id=UUID) — inclui troca de dono via customer_id
// DELETE -> desativa pet (?id=UUID)
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

function normalizeSize(size: string): string {
  if (!size) return 'MEDIUM';
  const s = size.toLowerCase().trim();
  if (s === 'pequeno' || s === 'small') return 'SMALL';
  if (s === 'médio' || s === 'medio' || s === 'medium') return 'MEDIUM';
  if (s === 'grande' || s === 'large') return 'LARGE';
  return s.toUpperCase();
}

function normalizeSex(sex: string): string | null {
  if (!sex || sex.trim() === '') return null;
  const s = sex.toLowerCase().trim();
  if (s === 'macho' || s === 'male') return 'MALE';
  if (s === 'fêmea' || s === 'femea' || s === 'female') return 'FEMALE';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });

  const supabase = createClient(
    Deno.env.get('SB_URL') || Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const apiKey = (req.headers.get('x-api-key') || req.headers.get('Authorization')?.replace('Bearer ', '') || '').trim();
  if (!apiKey) return json({ success: false, error: 'API Key required' }, 401);

  const { data: unit, error: unitErr } = await supabase
    .from('units').select('id, name, timezone').eq('api_key', apiKey).eq('is_deleted', false).single();
  if (unitErr || !unit) return json({ success: false, error: 'Invalid API key' }, 401);

  try {
    // ---------- POST: criar ----------
    if (req.method === 'POST') {
      const body = await req.json();
      const customer_id = body.customer_id;
      const name = body.name || body.pet_name;
      if (!customer_id || !name || !body.species) {
        return json({ success: false, error: 'Missing required fields: customer_id, name, species' }, 400);
      }
      const { data: pet, error: petErr } = await supabase
        .from('pets')
        .insert({
          customer_id,
          unit_id: unit.id,
          name,
          species: body.species,
          breed: body.breed || null,
          sex: normalizeSex(body.sex || ''),
          weight_kg: parseFloat(body.weight_kg) || 0,
          size: normalizeSize(body.size || ''),
          color: body.color || null,
          notes: body.notes || null,
          active: true,
          is_deleted: false,
        })
        .select()
        .single();
      if (petErr) return json({ success: false, error: petErr.message }, 500);
      return json({ success: true, data: { pet, unit: { id: unit.id, name: unit.name } } });
    }

    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ success: false, error: 'Missing query param: id' }, 400);

    // ---------- PATCH: editar ----------
    if (req.method === 'PATCH') {
      const body = await req.json();
      const update: any = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.species !== undefined) update.species = body.species;
      if (body.breed !== undefined) update.breed = body.breed;
      if (body.sex !== undefined) update.sex = normalizeSex(body.sex);
      if (body.weight_kg !== undefined) update.weight_kg = parseFloat(body.weight_kg) || 0;
      if (body.size !== undefined) update.size = normalizeSize(body.size);
      if (body.color !== undefined) update.color = body.color;
      if (body.notes !== undefined) update.notes = body.notes;
      if (body.customer_id !== undefined) update.customer_id = body.customer_id;

      const { data: pet, error: pErr } = await supabase
        .from('pets')
        .update(update)
        .eq('id', id)
        .eq('unit_id', unit.id)
        .select()
        .single();
      if (pErr) return json({ success: false, error: pErr.message }, 500);
      return json({ success: true, data: { pet } });
    }

    // ---------- DELETE: desativar ----------
    if (req.method === 'DELETE') {
      const { error: dErr } = await supabase
        .from('pets')
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
