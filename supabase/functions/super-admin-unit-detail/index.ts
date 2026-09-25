// Edge Function: super-admin-unit-detail (CORRIGIDA)
// Retorna unit + company + subscription (com plano) + users + audit_logs

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const sbUrl = Deno.env.get("SB_URL") || Deno.env.get("SUPABASE_URL");
    const sbServiceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(sbUrl!, sbServiceKey!);

    // Verificar Super Admin
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: "Não autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: adminCheck } = await supabase.from("unit_users").select("role").eq("user_id", user.id).eq("role", "SUPER_ADMIN").eq("is_active", true).maybeSingle();
    if (!adminCheck) {
      return new Response(JSON.stringify({ success: false, error: "Acesso negado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Pegar unit_id da URL
    const url = new URL(req.url);
    const unitId = url.searchParams.get("id");
    if (!unitId) {
      return new Response(JSON.stringify({ success: false, error: "ID da unidade obrigatório" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Buscar UNIT + COMPANY (join explícito)
    const { data: unit, error: unitErr } = await supabase
      .from("units")
      .select(`
        *,
        companies:company_id (*)
      `)
      .eq("id", unitId)
      .single();

    if (unitErr || !unit) {
      return new Response(JSON.stringify({ success: false, error: "Unidade não encontrada" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Buscar SUBSCRIPTION + PLAN (join explícito)
    const { data: subscription, error: subErr } = await supabase
      .from("subscriptions")
      .select(`
        *,
        plans:plan_id (*)
      `)
      .eq("unit_id", unitId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Buscar USERS da unidade
    const { data: users, error: usersErr } = await supabase
      .from("unit_users")
      .select(`
        *,
        users:user_id (id, name, email, phone)
      `)
      .eq("unit_id", unitId);

    // Buscar AUDIT LOGS
    const { data: audit_logs, error: auditErr } = await supabase
      .from("audit_logs")
      .select("*")
      .eq("unit_id", unitId)
      .order("created_at", { ascending: false })
      .limit(20);

    return new Response(JSON.stringify({
      success: true,
      data: {
        unit: unit || null,
        subscription: subscription || null,
        users: users || [],
        audit_logs: audit_logs || []
      }
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("UNIT DETAIL ERROR:", err);
    return new Response(JSON.stringify({ success: false, error: "Erro interno: " + err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});