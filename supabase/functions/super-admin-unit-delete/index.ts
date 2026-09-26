// Edge Function: super-admin-unit-delete
// Exclui (soft-delete) uma unidade

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@Supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const sbUrl = Deno.env.get("SB_URL") || Deno.env.get("SUPABASE_URL");
    const sbServiceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(sbUrl!, sbServiceKey!);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: "Token ausente" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: "Não autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: adminCheck } = await supabase
      .from("unit_users")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "SUPER_ADMIN")
      .eq("is_active", true)
      .maybeSingle();

    if (!adminCheck) {
      return new Response(JSON.stringify({ success: false, error: "Acesso negado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json().catch(() => ({}));
    const unitId = body.unit_id;

    if (!unitId) {
      return new Response(JSON.stringify({ success: false, error: "unit_id obrigatório" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { error: unitErr } = await supabase
      .from("units")
      .update({
        is_deleted: true,
        status: "SOFT_CLOSED",
        deleted_at: new Date().toISOString(),
      })
      .eq("id", unitId);

    if (unitErr) {
      return new Response(JSON.stringify({ success: false, error: "Erro ao excluir unidade: " + unitErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Desativa os vínculos WhatsApp da loja (o número deixa de rotear para ela)
    await supabase
      .from("whatsapp_connections")
      .update({ active: false })
      .eq("unit_id", unitId);

    return new Response(
      JSON.stringify({ success: true, message: "Loja excluída com sucesso" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (err: any) {
    console.error("DELETE UNIT ERROR:", err);
    return new Response(JSON.stringify({ success: false, error: "Erro interno: " + err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});