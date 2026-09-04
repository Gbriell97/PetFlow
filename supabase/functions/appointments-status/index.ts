// Edge Function: appointments-status
// Atualiza o status de um agendamento (confirmar, cancelar, concluir, etc.)
// URL: PATCH /appointments-status?id=UUID_DO_AGENDAMENTO

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "PATCH, OPTIONS",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse({ ok: true });
  if (req.method !== "PATCH") return jsonResponse({ success: false, error: "Method not allowed. Use PATCH" }, 405);

  try {
    const url = new URL(req.url);
    const appointmentId = url.searchParams.get("id");

    const body = await req.json();
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

    // 2. Valida status
    const { status, cancellation_reason, notes } = body;

    if (!status) {
      return jsonResponse({ success: false, error: "Missing required field: status" }, 400);
    }

    const validStatuses = ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"];
    if (!validStatuses.includes(status)) {
      return jsonResponse({ success: false, error: `Invalid status. Valid: ${validStatuses.join(", ")}` }, 400);
    }

    // 3. Busca o agendamento
    const { data: appointment, error: apptError } = await supabase
      .from("appointments")
      .select("id, status, customer_id, total_price, total_duration_minutes, unit_id, is_deleted")
      .eq("id", appointmentId)
      .eq("unit_id", unit.id)
      .eq("is_deleted", false)
      .single();

    if (apptError || !appointment) {
      return jsonResponse({ success: false, error: "Appointment not found" }, 404);
    }

    // 4. Monta o update
    const updateData = {
      status: status,
      previous_status: appointment.status,
      updated_at: new Date().toISOString(),
    };

    if (status === "CANCELLED") {
      updateData.cancellation_reason = cancellation_reason || null;
      updateData.cancelled_at = new Date().toISOString();
    }

    if (status === "CHECKED_IN") {
      updateData.checked_in_at = new Date().toISOString();
    }

    if (status === "IN_PROGRESS") {
      updateData.started_at = new Date().toISOString();
    }

    if (status === "COMPLETED") {
      updateData.completed_at = new Date().toISOString();
    }

    if (notes) {
      updateData.notes = notes;
    }

    // 5. Atualiza o agendamento
    const { data: updatedAppt, error: updateError } = await supabase
      .from("appointments")
      .update(updateData)
      .eq("id", appointmentId)
      .select()
      .single();

    if (updateError || !updatedAppt) {
      console.error("Update error:", updateError);
      return jsonResponse({ success: false, error: "Failed to update appointment", detail: updateError?.message }, 500);
    }

    // 6. Atualiza os items também (mesmo status)
    const { error: itemsError } = await supabase
      .from("appointment_items")
      .update({ status: status })
      .eq("appointment_id", appointmentId);

    if (itemsError) {
      console.error("Update items error:", itemsError);
    }

    // 7. Retorna sucesso
    return jsonResponse({
      success: true,
      data: {
        appointment: {
          id: updatedAppt.id,
          status: updatedAppt.status,
          previous_status: updatedAppt.previous_status,
          updated_at: updatedAppt.updated_at,
        },
        message: `Appointment status updated from ${appointment.status} to ${status}`,
      },
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ success: false, error: "Internal server error", detail: err.message }, 500);
  }
});
