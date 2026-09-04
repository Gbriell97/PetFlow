// Edge Function: available-slots-by-name
// Aceita NOMES ou UUIDs + normaliza telefone

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, x-client-info, apikey, content-type",
};

function isUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function normalizePhone(phone: string): string {
  // Remove tudo que não é número
  let clean = phone.replace(/\D/g, '');
  // Se começar com 55 e tiver 13 dígitos, remove o 55
  if (clean.startsWith('55') && clean.length === 13) {
    clean = clean.substring(2);
  }
  return clean;
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

    const service_input = body.service_name || body.service_ids || '';
    const pet_input = body.pet_name || body.pet_ids || '';
    const customer_phone = normalizePhone(body.customer_phone || '');
    const date = body.date;
    const employee_id = body.employee_id || null;
    const max_days = body.max_days || 1;

    const supabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_SERVICE_ROLE_KEY")!
    );

    // 1. Busca unidade pela API key
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

    // 2. Resolve service_id (UUID ou nome)
    let service_id: string;
    let service_name: string;

    if (isUUID(service_input)) {
      const { data: svc } = await supabase
        .from("services")
        .select("id, name")
        .eq("id", service_input)
        .eq("unit_id", unit.id)
        .single();
      if (!svc) {
        return new Response(JSON.stringify({ error: `Serviço '${service_input}' não encontrado` }), { 
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
      service_id = svc.id;
      service_name = svc.name;
    } else {
      const { data: services } = await supabase
        .from("services")
        .select("id, name")
        .eq("unit_id", unit.id)
        .eq("active", true)
        .eq("is_deleted", false)
        .ilike("name", `%${service_input}%`)
        .limit(1);

      if (!services || services.length === 0) {
        return new Response(JSON.stringify({ error: `Serviço '${service_input}' não encontrado` }), { 
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
      service_id = services[0].id;
      service_name = services[0].name;
    }

    // 3. Busca cliente pelo telefone (normalizado)
    const { data: customers } = await supabase
      .from("customers")
      .select("id")
      .eq("unit_id", unit.id)
      .eq("phone", customer_phone)
      .eq("is_deleted", false)
      .limit(1);

    if (!customers || customers.length === 0) {
      return new Response(JSON.stringify({ 
        error: `Cliente com telefone ${customer_phone} não encontrado` 
      }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const customer_id = customers[0].id;

    // 4. Resolve pet_id (UUID ou nome)
    let pet_id: string;
    let pet_name: string;

    if (isUUID(pet_input)) {
      const { data: pet } = await supabase
        .from("pets")
        .select("id, name")
        .eq("id", pet_input)
        .eq("unit_id", unit.id)
        .single();
      if (!pet) {
        return new Response(JSON.stringify({ error: `Pet '${pet_input}' não encontrado` }), { 
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
      pet_id = pet.id;
      pet_name = pet.name;
    } else {
      const { data: pets } = await supabase
        .from("pets")
        .select("id, name")
        .eq("unit_id", unit.id)
        .eq("customer_id", customer_id)
        .ilike("name", `%${pet_input}%`)
        .eq("is_deleted", false)
        .limit(1);

      if (!pets || pets.length === 0) {
        return new Response(JSON.stringify({ error: `Pet '${pet_input}' não encontrado` }), { 
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
      pet_id = pets[0].id;
      pet_name = pets[0].name;
    }

    // 5. Chama a função original com UUIDs
    const { data: slots, error: slotsError } = await supabase.rpc(
      "get_available_slots",
      {
        p_unit_id: unit.id,
        p_service_ids: [service_id],
        p_pet_ids: [pet_id],
        p_date: date,
        p_employee_id: employee_id,
        p_max_days: max_days
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
        service: { id: service_id, name: service_name },
        pet: { id: pet_id, name: pet_name },
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
