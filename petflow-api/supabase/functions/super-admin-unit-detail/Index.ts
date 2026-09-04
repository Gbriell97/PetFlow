// GET /super-admin-unit-detail?id=UUID
// Retorna dados completos da loja (company + unit + subscription + users)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

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

    // Pegar unit_id da URL
    const url = new URL(req.url);
    const unitId = url.searchParams.get("id");
    if (!unitId) return new Response(JSON.stringify({ success: false, error: "ID da unidade obrigatório" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Buscar dados completos
    const { data: unit } = await supabase.from("units").select("*, companies(*)").eq("id", unitId).single();
    const { data: subscription } = await supabase.from("subscriptions").select("*, plans(*)").eq("unit_id", unitId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const { data: users } = await supabase.from("unit_users").select("*, users:user_id(id, name, email, phone)").eq("unit_id", unitId);
    const { data: audit } = await supabase.from("audit_logs").select("*").eq("unit_id", unitId).order("created_at", { ascending: false }).limit(20);

    return new Response(JSON.stringify({
      success: true,
      data: { unit, subscription, users, audit_logs: audit }
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});