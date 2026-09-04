// Edge Function: available-slots (v2 - usa wrapper JSONB)
// URL: POST https://jnmtwalmfkcxixiwqbjm.supabase.co/functions/v1/available-slots

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, x-client-info, apikey, content-type",
};

// Helper: converte qualquer entrada em array de UUIDs
function parseUUIDArray(input: any): string[] {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch (e) {
      return [input];
    }
  }
  return [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = req.headers.get("authorization")?.replace("Bearer ", "") || 
                   req.headers.get("x-api-key");

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API Key required" }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const body = await req.json();

    // Converte para arrays
    const service_ids = parseUUIDArray(body.service_ids);
    const pet_ids = parseUUIDArray(body.pet_ids);

    const unit_id = body.unit_id;
    const date = body.date;
    const employee_id = body.employee_id || null;
    const max_days = body.max_days || 1;

    if (!unit_id || service_ids.length === 0 || pet_ids.length === 0 || !date) {
      return new Response(JSON.stringify({ 
        error: "Missing required fields: unit_id, service_ids, pet_ids, date" 
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_SERVICE_ROLE_KEY")!
    );

    // Busca unidade pela API key
    const { data: unit, error: unitError } = await supabase
      .from("units")
      .select("id, name, timezone")
      .eq("api_key", apiKey)
      .eq("is_deleted", false)
      .single();

    if (unitError || !unit) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // ✅ USA A FUNÇÃO WRAPPER JSONB (evita reordenação de parâmetros!)
    const { data: slots, error: slotsError } = await supabase.rpc(
      "get_available_slots_jsonb",
      {
        p_params: {
          unit_id: unit.id,
          service_ids: service_ids,
          pet_ids: pet_ids,
          date: date,
          employee_id: employee_id,
          max_days: max_days
        }
      }
    );

    if (slotsError) {
      console.error("Slots error:", slotsError);
      return new Response(JSON.stringify({ error: slotsError.message }), { 
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        unit: { id: unit.id, name: unit.name, timezone: unit.timezone },
        date,
        slots: slots || []
      }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
});
