// Edge Function: services
// Lista todos os serviços disponíveis da unidade
// URL: GET /services

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse({ ok: true });
  if (req.method !== "GET") return jsonResponse({ success: false, error: "Method not allowed. Use GET" }, 405);

  try {
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

    // 2. Busca serviços ativos da unidade
    const { data: services, error: svcError } = await supabase
      .from("services")
      .select(`
        id,
        name,
        description,
        default_price,
        default_duration_minutes,
        capacity,
        buffer_minutes,
        booking_enabled,
        requires_professional,
        service_categories (name)
      `)
      .eq("unit_id", unit.id)
      .eq("active", true)
      .eq("is_deleted", false)
      .eq("booking_enabled", true)
      .order("name", { ascending: true });

    if (svcError) {
      console.error("Services error:", svcError);
      return jsonResponse({ success: false, error: "Failed to fetch services", detail: svcError.message }, 500);
    }

    // 3. Busca preços e durações por porte para cada serviço
    const servicesWithDetails = [];
    for (const svc of (services || [])) {
      const { data: priceRules } = await supabase
        .from("service_price_rules")
        .select("name, price, criteria")
        .eq("service_id", svc.id)
        .eq("unit_id", unit.id)
        .eq("active", true)
        .order("sort_order", { ascending: true });

      const { data: durationRules } = await supabase
        .from("service_duration_rules")
        .select("name, duration_minutes, criteria")
        .eq("service_id", svc.id)
        .eq("unit_id", unit.id)
        .eq("active", true)
        .order("sort_order", { ascending: true });

      servicesWithDetails.push({
        id: svc.id,
        name: svc.name,
        description: svc.description,
        category: svc.service_categories?.name || null,
        default_price: svc.default_price,
        default_duration_minutes: svc.default_duration_minutes,
        capacity: svc.capacity,
        buffer_minutes: svc.buffer_minutes,
        requires_professional: svc.requires_professional,
        prices_by_size: priceRules || [],
        durations_by_size: durationRules || [],
      });
    }

    // 4. Retorna
    return jsonResponse({
      success: true,
      data: {
        unit: {
          id: unit.id,
          name: unit.name,
          timezone: unit.timezone,
        },
        services: servicesWithDetails,
        count: servicesWithDetails.length,
      },
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ success: false, error: "Internal server error", detail: err.message }, 500);
  }
});
