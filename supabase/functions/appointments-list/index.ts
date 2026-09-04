// Edge Function: appointments-list
// Lista agendamentos da unidade com filtros e paginação
// URL: GET /appointments-list?date=2026-08-25&status=PENDING&customer_id=UUID&limit=20&offset=0

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

    // 2. Pega filtros da query string
    const dateFilter = url.searchParams.get("date");
    const statusFilter = url.searchParams.get("status");
    const customerIdFilter = url.searchParams.get("customer_id");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
    const offset = parseInt(url.searchParams.get("offset") || "0");

    // 3. Monta a query base
    let query = supabase
      .from("appointments")
      .select(`
        id,
        status,
        total_price,
        total_duration_minutes,
        created_at,
        updated_at,
        customers (id, name, phone),
        appointment_items (
          id,
          start_time,
          end_time,
          pets (id, name, species),
          services (id, name),
          employees (id, name)
        )
      `, { count: "exact" })
      .eq("unit_id", unit.id)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // 4. Aplica filtros opcionais
    if (statusFilter) {
      query = query.eq("status", statusFilter.toUpperCase());
    }

    if (customerIdFilter) {
      query = query.eq("customer_id", customerIdFilter);
    }

    // 5. Executa a query
    const { data: appointments, error, count } = await query;

    if (error) {
      console.error("List appointments error:", error);
      return jsonResponse({ success: false, error: "Failed to fetch appointments", detail: error.message }, 500);
    }

    // 6. Se filtrou por data, precisa filtrar os items por data também
    let filteredAppointments = appointments || [];

    if (dateFilter) {
      filteredAppointments = filteredAppointments.filter(appt => {
        const items = appt.appointment_items || [];
        return items.some(item => {
          if (!item.start_time) return false;
          const itemDate = new Date(item.start_time).toISOString().split("T")[0];
          return itemDate === dateFilter;
        });
      });
    }

    // 7. Formata o retorno
    const formattedAppointments = filteredAppointments.map(appt => ({
      id: appt.id,
      status: appt.status,
      total_price: appt.total_price,
      total_duration_minutes: appt.total_duration_minutes,
      created_at: appt.created_at,
      updated_at: appt.updated_at,
      customer: appt.customers,
      items: (appt.appointment_items || []).map(item => ({
        id: item.id,
        start_time: item.start_time,
        end_time: item.end_time,
        pet: item.pets,
        service: item.services,
        employee: item.employees,
      })),
    }));

    // 8. Retorna com paginação
    return jsonResponse({
      success: true,
      data: {
        appointments: formattedAppointments,
        pagination: {
          total: count || 0,
          limit,
          offset,
          has_more: (offset + limit) < (count || 0),
        },
        filters: {
          date: dateFilter,
          status: statusFilter,
          customer_id: customerIdFilter,
        },
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
