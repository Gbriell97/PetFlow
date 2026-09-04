// POST /super-admin-user-manage
// Ações: reset_password, block, unblock, update_email

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function generateTempPassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pass = "";
  for (let i = 0; i < length; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
  return pass;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const sbUrl = Deno.env.get("SB_URL") || Deno.env.get("SUPABASE_URL");
    const sbServiceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(sbUrl!, sbServiceKey!);

    // Verificar Super Admin
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return new Response(JSON.stringify({ success: false, error: "Não autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: adminCheck } = await supabase.from("unit_users").select("role").eq("user_id", user.id).eq("role", "SUPER_ADMIN").eq("is_active", true).maybeSingle();
    if (!adminCheck) return new Response(JSON.stringify({ success: false, error: "Acesso negado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json();
    const { action, user_id, unit_id, new_email } = body;

    if (action === "reset_password") {
      const tempPass = generateTempPassword();
      const { error } = await supabase.auth.admin.updateUserById(user_id, { password: tempPass });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, temp_password: tempPass, message: "Senha redefinida com sucesso" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "block") {
      const { error } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: "876600h" }); // 100 anos
      if (error) throw error;
      await supabase.from("unit_users").update({ is_active: false }).eq("user_id", user_id).eq("unit_id", unit_id);
      return new Response(JSON.stringify({ success: true, message: "Usuário bloqueado" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "unblock") {
      const { error } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: "0h" });
      if (error) throw error;
      await supabase.from("unit_users").update({ is_active: true }).eq("user_id", user_id).eq("unit_id", unit_id);
      return new Response(JSON.stringify({ success: true, message: "Usuário desbloqueado" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "update_email") {
      const { error } = await supabase.auth.admin.updateUserById(user_id, { email: new_email });
      if (error) throw error;
      await supabase.from("users").update({ email: new_email }).eq("id", user_id);
      return new Response(JSON.stringify({ success: true, message: "Email atualizado" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ success: false, error: "Ação inválida" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});