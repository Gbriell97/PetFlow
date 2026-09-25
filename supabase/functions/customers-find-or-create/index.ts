// Edge Function: customers-find-or-create
// Busca cliente pelo telefone (WhatsApp) ou cria novo
// Essencial para o fluxo: bot recebe mensagem → identifica/cria cliente

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse({ ok: true });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const authHeader = req.headers.get("Authorization") || "";
    const apiKey = authHeader.replace("Bearer ", "").trim();

    if (!apiKey) {
      return jsonResponse({ success: false, error: "Missing Authorization header" }, 401);
    }

    const sbUrl = Deno.env.get("SB_URL");
    const sbServiceRole = Deno.env.get("SB_SERVICE_ROLE_KEY");

    if (!sbUrl || !sbServiceRole) {
      return jsonResponse({ success: false, error: "Server configuration error" }, 500);
    }

    const supabase = createClient(sbUrl, sbServiceRole, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Valida API Key e pega unidade
    const { data: unitData, error: unitError } = await supabase
      .from("units")
      .select("id, name, timezone")
      .eq("api_key", apiKey)
      .eq("is_deleted", false)
      .single();

    if (unitError || !unitData) {
      return jsonResponse({ success: false, error: "Invalid API key" }, 401);
    }

    const unit = unitData;

    // 2. Valida campos obrigatórios
    const { phone, name } = body;

    if (!phone) {
      return jsonResponse({ success: false, error: "Missing required field: phone" }, 400);
    }

    // Normaliza o telefone (remove espaços, traços, etc.)
    const normalizedPhone = phone.replace(/\s/g, "").replace(/[-.()]/g, "");

    // 3. Busca cliente pelo telefone
    const { data: existingCustomer, error: searchError } = await supabase
      .from("customers")
      .select("id, name, phone, email, notes, created_at")
      .eq("unit_id", unit.id)
      .eq("is_deleted", false)
      .or(`phone.eq.${normalizedPhone},phone.ilike.%${normalizedPhone.slice(-8)}%`)
      .maybeSingle();

    // Se encontrou, busca os pets do cliente
    if (existingCustomer) {
      const { data: pets, error: petsError } = await supabase
        .from("pets")
        .select("id, name, species, breed, size, weight_kg, active, notes")
        .eq("customer_id", existingCustomer.id)
        .eq("unit_id", unit.id)
        .eq("is_deleted", false)
        .eq("active", true)
        .order("name", { ascending: true });

      return jsonResponse({
        success: true,
        data: {
          found: true,
          customer: existingCustomer,
          pets: pets || [],
          unit: {
            id: unit.id,
            name: unit.name,
            timezone: unit.timezone,
          },
        },
      });
    }

    // 4. Cliente não encontrado — cria novo
    const { data: newCustomer, error: createError } = await supabase
      .from("customers")
      .insert({
        unit_id: unit.id,
        name: name || "Cliente WhatsApp",
        phone: normalizedPhone,
        is_deleted: false,
      })
      .select()
      .single();

    if (createError || !newCustomer) {
      console.error("Create customer error:", createError);
      return jsonResponse({ success: false, error: "Failed to create customer", detail: createError?.message }, 500);
    }

    // 5. Retorna o cliente recém-criado (sem pets ainda)
    return jsonResponse({
      success: true,
      data: {
        found: false,
        created: true,
        customer: newCustomer,
        pets: [],
        unit: {
          id: unit.id,
          name: unit.name,
          timezone: unit.timezone,
        },
      },
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ success: false, error: "Internal server error", detail: err.message }, 500);
  }
});
