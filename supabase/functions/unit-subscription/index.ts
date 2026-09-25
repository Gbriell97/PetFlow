// supabase/functions/unit-subscription/index.ts
// Retorna a assinatura atual da unidade (identificada pela x-api-key)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) return json({ error: 'x-api-key obrigatória' }, 401);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: unit } = await supabase
      .from('units')
      .select('id')
      .eq('api_key', apiKey)
      .single();

    if (!unit) return json({ error: 'Unidade não encontrada' }, 404);

    // Assinatura mais recente da unidade (sem join — evita erro de relação)
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('unit_id', unit.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return json({ error: error.message }, 500);

    // Plano em consulta separada (tolerante a coluna plan_id inexistente)
    let plan = null;
    if (subscription && subscription.plan_id) {
      const { data: planData } = await supabase
        .from('plans')
        .select('name, price')
        .eq('id', subscription.plan_id)
        .maybeSingle();
      plan = planData;
    }

    return json({ success: true, data: { ...subscription, plans: plan } });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
});
