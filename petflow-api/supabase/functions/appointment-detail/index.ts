// Edge Function: appointment-detail
// Consulta detalhes completos de um agendamento
// URL: GET /appointment-detail?id=UUID_DO_AGENDAMENTO

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
    const url = new URL(req.url);
    const appointmentId = url.searchParams.get("id");

    const authHeader = req.headers.get("Authorization") || "";
    const apiKey = authHeader.replace("Bearer ", "").trim();

    if (!apiKey) {
      return jsonResponse({ success: false, error: "Missing Authorization header" }, 401);
    }

    if (!appointmentId) {
      return jsonResponse({ success: false, error: "Missing query parameter: id" }, 400);
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

    // 2. Busca o agendamento
    const { data: appointment, error: apptError } = await supabase
      .from("appointments")
      .select(`
        id,
        status,
        previous_status,
        total_price,
        total_duration_minutes,
        unit_timezone,
        notes,
        cancellation_reason,
        checked_in_at,
        started_at,
        completed_at,
        cancelled_at,
        reminder_sent,
        created_at,
        updated_at,
        customers (id, name, phone, email)
      `)
      .eq("id", appointmentId)
      .eq("unit_id", unit.id)
      .eq("is_deleted", false)
      .single();

    if (apptError || !appointment) {
      return jsonResponse({ success: false, error: "Appointment not found" }, 404);
    }

    // 3. Busca os itens do agendamento
    const { data: items, error: itemsError } = await supabase
      .from("appointment_items")
      .select(`
        id,
        price,
        duration_minutes,
        buffer_minutes,
        start_time,
        end_time,
        status,
        notes,
        pets (id, name, species, breed, size, weight_kg),
        services (id, name, description),
        employees (id, name, color)
      `)
      .eq("appointment_id", appointmentId)
      .order("created_at", { ascending: true });

    // 4. Busca histórico de status (se existir tabela)
    const { data: statusHistory } = await supabase
      .from("appointment_status_history")
      .select("status, previous_status, changed_at, changed_by, notes")
      .eq("appointment_id", appointmentId)
      .order("changed_at", { ascending: false })
      .limit(10);

    // 5. Retorna tudo formatado
    return jsonResponse({
      success: true,
      data: {
        appointment: {
          id: appointment.id,
          status: appointment.status,
          previous_status: appointment.previous_status,
          total_price: appointment.total_price,
          total_duration_minutes: appointment.total_duration_minutes,
          unit_timezone: appointment.unit_timezone,
          notes: appointment.notes,
          cancellation_reason: appointment.cancellation_reason,
          checked_in_at: appointment.checked_in_at,
          started_at: appointment.started_at,
          completed_at: appointment.completed_at,
          cancelled_at: appointment.cancelled_at,
          reminder_sent: appointment.reminder_sent,
          created_at: appointment.created_at,
          updated_at: appointment.updated_at,
        },
        customer: appointment.customers,
        items: (items || []).map(item => ({
          id: item.id,
          pet: item.pets,
          service: item.services,
          employee: item.employees,
          price: item.price,
          duration_minutes: item.duration_minutes,
          buffer_minutes: item.buffer_minutes,
          start_time: item.start_time,
          end_time: item.end_time,
          status: item.status,
          notes: item.notes,
        })),
        status_history: statusHistory || [],
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
