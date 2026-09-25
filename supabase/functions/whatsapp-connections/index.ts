// Edge Function: whatsapp-connections (CRUD — Super Admin)
// Gerencia o vínculo número WhatsApp (AvisaAPI) ↔ unidade.
// Deploy: .\supabase.exe functions deploy whatsapp-connections --no-verify-jwt
//
// Rotas:
//   GET    ?unit_id=<uuid>          → lista conexões da unidade (ou todas, sem filtro)
//   POST   { unit_id, phone, instance_name?, active? }          → cria
//   PATCH  { id, phone?, instance_name?, active?, notes? }      → atualiza
//   DELETE ?id=<uuid>               → remove

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const digits = (s: unknown) => String(s || "").replace(/\D/g, "");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const sbUrl = Deno.env.get("SB_URL") || Deno.env.get("SUPABASE_URL");
    const sbServiceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(sbUrl!, sbServiceKey!);

    // --- Auth: Super Admin ---
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return json({ success: false, error: "Não autorizado" }, 401);

    const { data: adminCheck } = await supabase
      .from("unit_users").select("role")
      .eq("user_id", user.id).eq("role", "SUPER_ADMIN").eq("is_active", true)
      .maybeSingle();
    if (!adminCheck) return json({ success: false, error: "Acesso negado" }, 403);

    // --- GET ---
    if (req.method === "GET") {
      const unitId = new URL(req.url).searchParams.get("unit_id");
      let query = supabase
        .from("whatsapp_connections")
        .select("*, units(name)")
        .order("created_at", { ascending: false });
      if (unitId) query = query.eq("unit_id", unitId);

      const { data, error } = await query;
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, data: data || [] });
    }

    // --- POST ---
    if (req.method === "POST") {
      const body = await req.json();
      const unitId = body.unit_id;
      const phone = digits(body.phone);
      const instanceName = (body.instance_name || "").trim() || null;

      if (!unitId) return json({ success: false, error: "unit_id é obrigatório" }, 400);
      if (!phone) return json({ success: false, error: "phone é obrigatório" }, 400);

      // Valida se a unidade existe
      const { data: unit } = await supabase.from("units").select("id").eq("id", unitId).eq("is_deleted", false).maybeSingle();
      if (!unit) return json({ success: false, error: "Unidade não encontrada" }, 404);

      const { data, error } = await supabase
        .from("whatsapp_connections")
        .insert({
          unit_id: unitId,
          phone,
          instance_name: instanceName,
          active: body.active !== false,
          notes: body.notes || null,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") return json({ success: false, error: "Este número já está vinculado a outra unidade" }, 409);
        return json({ success: false, error: error.message }, 500);
      }
      return json({ success: true, data }, 201);
    }

    // --- PATCH ---
    if (req.method === "PATCH") {
      const body = await req.json();
      const id = body.id;
      if (!id) return json({ success: false, error: "id é obrigatório" }, 400);

      const update: Record<string, unknown> = {};
      if (body.phone !== undefined) {
        const p = digits(body.phone);
        if (!p) return json({ success: false, error: "phone inválido" }, 400);
        update.phone = p;
      }
      if (body.instance_name !== undefined) update.instance_name = (body.instance_name || "").trim() || null;
      if (body.active !== undefined) update.active = !!body.active;
      if (body.notes !== undefined) update.notes = body.notes || null;

      if (Object.keys(update).length === 0) return json({ success: false, error: "Nada para atualizar" }, 400);

      const { data, error } = await supabase
        .from("whatsapp_connections")
        .update(update)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") return json({ success: false, error: "Este número já está vinculado a outra unidade" }, 409);
        return json({ success: false, error: error.message }, 500);
      }
      return json({ success: true, data });
    }

    // --- DELETE ---
    if (req.method === "DELETE") {
      const id = new URL(req.url).searchParams.get("id");
      if (!id) return json({ success: false, error: "id é obrigatório" }, 400);

      const { error } = await supabase.from("whatsapp_connections").delete().eq("id", id);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, message: "Conexão removida" });
    }

    return json({ success: false, error: "Method not allowed" }, 405);

  } catch (err: any) {
    console.error("WHATSAPP CONNECTIONS ERROR:", err);
    return json({ success: false, error: "Erro interno: " + err.message }, 500);
  }
});
