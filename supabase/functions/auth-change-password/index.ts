// Edge Function: auth-change-password
// POST { current_password, new_password } — autenticado pelo JWT do usuário (Bearer)
// Verifica a senha atual antes de trocar.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  const sbUrl = Deno.env.get('SB_URL') || Deno.env.get('SUPABASE_URL')!;
  const sbServiceKey = Deno.env.get('SB_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sbAnonKey = Deno.env.get('SB_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!;

  const supabase = createClient(sbUrl, sbServiceKey);

  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return json({ success: false, error: 'Token obrigatório' }, 401);

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user || !user.email) return json({ success: false, error: 'Sessão inválida. Faça login novamente.' }, 401);

  try {
    const body = await req.json();
    const { current_password, new_password } = body || {};

    if (!current_password || !new_password) {
      return json({ success: false, error: 'Senha atual e nova senha são obrigatórias' }, 400);
    }
    if (typeof new_password !== 'string' || new_password.length < 6) {
      return json({ success: false, error: 'A nova senha precisa de pelo menos 6 caracteres' }, 400);
    }

    // Verifica a senha atual fazendo login com ela
    const anonClient = createClient(sbUrl, sbAnonKey);
    const { error: signInErr } = await anonClient.auth.signInWithPassword({
      email: user.email,
      password: current_password,
    });
    if (signInErr) {
      return json({ success: false, error: 'Senha atual incorreta' }, 400);
    }

    // Troca a senha
    const { error: updErr } = await supabase.auth.admin.updateUserById(user.id, {
      password: new_password,
    });
    if (updErr) return json({ success: false, error: updErr.message }, 500);

    return json({ success: true, message: 'Senha alterada com sucesso!' });
  } catch (e) {
    return json({ success: false, error: 'Erro interno: ' + e.message }, 500);
  }
});
