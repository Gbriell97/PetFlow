// Edge Function: pets (sex opcional, aceita português/inglês)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, x-client-info, apikey, content-type",
};

function normalizeSize(size: string): string {
  if (!size) return 'MEDIUM'; // default
  const s = size.toLowerCase().trim();
  if (s === 'pequeno' || s === 'small') return 'SMALL';
  if (s === 'médio' || s === 'medio' || s === 'medium') return 'MEDIUM';
  if (s === 'grande' || s === 'large') return 'LARGE';
  return s.toUpperCase();
}

function normalizeSex(sex: string): string | null {
  if (!sex || sex.trim() === '') return null; // permite null
  const s = sex.toLowerCase().trim();
  if (s === 'macho' || s === 'male') return 'MALE';
  if (s === 'fêmea' || s === 'femea' || s === 'female') return 'FEMALE';
  return null; // se não reconhecer, deixa null
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

    const customer_id = body.customer_id;
    const name = body.name || body.pet_name;
    const species = body.species;
    const breed = body.breed || null;
    const sex = normalizeSex(body.sex || '');
    const weight_kg = parseFloat(body.weight_kg) || 0;
    const size = normalizeSize(body.size || '');
    const color = body.color || null;
    const notes = body.notes || null;

    const supabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_SERVICE_ROLE_KEY")!
    );

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

    if (!customer_id || !name || !species) {
      return new Response(JSON.stringify({ error: "Missing required fields: customer_id, name, species" }), { 
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const { data: pet, error: petError } = await supabase
      .from("pets")
      .insert({
        customer_id,
        unit_id: unit.id,
        name,
        species,
        breed,
        sex,
        weight_kg,
        size,
        color,
        notes,
        active: true,
        is_deleted: false
      })
      .select()
      .single();

    if (petError) {
      console.error("Pet error:", petError);
      return new Response(JSON.stringify({ error: petError.message }), { 
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("id, name, phone")
      .eq("id", customer_id)
      .single();

    return new Response(JSON.stringify({
      success: true,
      data: {
        pet,
        customer: customer || null,
        unit: { id: unit.id, name: unit.name, timezone: unit.timezone }
      }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
});
