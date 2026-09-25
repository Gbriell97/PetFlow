// Edge Function: super-admin-list-units
// Retorna todas as unidades ativas para Super Admin

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

    const { data: units, error } = await supabase
      .from("units")
      .select("id, name, timezone, api_key, status, phone, city, state, email, created_at")
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });

    if (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ success: true, data: units || [] }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("LIST UNITS ERROR:", err);
    return new Response(JSON.stringify({ success: false, error: "Erro interno: " + err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
