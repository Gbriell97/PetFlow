// PUT /super-admin-unit-update
// Atualiza dados da loja (company + unit)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "PUT") return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

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
    const { unit_id, company_id, company_data, unit_data } = body;

    if (!unit_id || !company_id) {
      return new Response(JSON.stringify({ success: false, error: "unit_id e company_id obrigatórios" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Atualizar company
    if (company_data) {
      const { error: cErr } = await supabase.from("companies").update(company_data).eq("id", company_id);
      if (cErr) throw cErr;
    }

    // Atualizar unit
    if (unit_data) {
      const { error: uErr } = await supabase.from("units").update(unit_data).eq("id", unit_id);
      if (uErr) throw uErr;
    }

    return new Response(JSON.stringify({ success: true, message: "Loja atualizada com sucesso" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});