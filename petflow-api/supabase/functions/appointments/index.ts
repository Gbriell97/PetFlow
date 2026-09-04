// Edge Function: appointments (com validações robustas)
// Deploy: .\supabase.exe functions deploy appointments --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

function res(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Helper seguro para extrair primeiro elemento de array
function first(arr: any[] | null | undefined) {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return res({ ok: true });
  if (req.method !== "POST") return res({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const { customer_id, service_ids, pet_ids, start_datetime, employee_id, notes } = body;

    if (!customer_id || !service_ids || !pet_ids || !start_datetime) {
      return res({ success: false, error: "Missing required fields: customer_id, service_ids, pet_ids, start_datetime" }, 400);
    }

    // --- 1. VALIDAR API KEY ---
    const apiKey = req.headers.get("Authorization")?.replace("Bearer ", "") || req.headers.get("x-api-key");
    if (!apiKey) return res({ success: false, error: "Missing API key" }, 401);

    const sbUrl = Deno.env.get("SB_URL") || Deno.env.get("SUPABASE_URL");
    const sbKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!sbUrl || !sbKey) return res({ success: false, error: "Server configuration error" }, 500);

    // Buscar unidade
    const unitRes = await fetch(`${sbUrl}/rest/v1/units?api_key=eq.${apiKey}&is_deleted=eq.false&select=*`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    const units = await unitRes.json();
    const unit = first(units);
    if (!unit) return res({ success: false, error: "Invalid API key" }, 401);

    const unitId = unit.id;
    const timezone = unit.timezone || "America/Sao_Paulo";

    // --- 2. VALIDAR CLIENTE ---
    const customerRes = await fetch(`${sbUrl}/rest/v1/customers?id=eq.${customer_id}&unit_id=eq.${unitId}&is_deleted=eq.false&select=*`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    const customer = first(await customerRes.json());
    if (!customer) return res({ success: false, error: "Customer not found for this unit" }, 404);

    // --- 3. VALIDAR PETS ---
    for (const petId of pet_ids) {
      const petRes = await fetch(`${sbUrl}/rest/v1/pets?id=eq.${petId}&unit_id=eq.${unitId}&is_deleted=eq.false&active=eq.true&select=*`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      if (!first(await petRes.json())) {
        return res({ success: false, error: `Pet not found or inactive: ${petId}` }, 404);
      }
    }

    // --- 4. VALIDAR SERVIÇOS (ativos) ---
    for (const serviceId of service_ids) {
      const svcRes = await fetch(`${sbUrl}/rest/v1/services?id=eq.${serviceId}&unit_id=eq.${unitId}&is_deleted=eq.false&active=eq.true&select=*`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      if (!first(await svcRes.json())) {
        return res({ success: false, error: `Service not found or inactive: ${serviceId}` }, 404);
      }
    }

    // --- 5. CONVERTER DATETIME ---
    const startDate = new Date(start_datetime);
    if (isNaN(startDate.getTime())) {
      return res({ success: false, error: "Invalid start_datetime format" }, 400);
    }

    // Converter para o timezone da unidade para extrair dia/hora local
    const localDateStr = startDate.toLocaleString("sv-SE", { timeZone: timezone }); // YYYY-MM-DD HH:MM:SS
    const [localDate, localTime] = localDateStr.split(" ");
    const localHour = localTime.slice(0, 5); // HH:MM
    const dayOfWeek = new Date(localDate + "T12:00:00").getDay(); // 0=Dom, 1=Seg...

    const slotStartUTC = startDate.toISOString();
    const slotEndUTC = new Date(startDate.getTime() + 90 * 60000).toISOString(); // placeholder, será recalculado

    // --- 6. HORÁRIO DE FUNCIONAMENTO ---
    const bhRes = await fetch(`${sbUrl}/rest/v1/business_hours?unit_id=eq.${unitId}&day_of_week=eq.${dayOfWeek}&select=*`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    const bh = first(await bhRes.json());
    if (!bh) {
      return res({ success: false, error: `Unidade fechada neste dia (dia ${dayOfWeek}: sem horário cadastrado)` }, 400);
    }
    if (bh.is_closed) {
      return res({ success: false, error: `Unidade fechada neste dia (${bh.day_name || "domingo"})` }, 400);
    }
    if (localHour < bh.open_time.slice(0, 5) || localHour > bh.close_time.slice(0, 5)) {
      return res({ success: false, error: `Fora do horário de expediente (${bh.open_time.slice(0, 5)} - ${bh.close_time.slice(0, 5)})` }, 400);
    }

    // --- 7. BLOQUEIOS (com overlap real) ---
    // Buscar bloqueios que se sobrepõem ao slot do agendamento
    const blockRes = await fetch(
      `${sbUrl}/rest/v1/blocked_periods?unit_id=eq.${unitId}&start_datetime=lt.${encodeURIComponent(slotEndUTC)}&end_datetime=gt.${encodeURIComponent(slotStartUTC)}&select=*`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
    );
    const blocks = await blockRes.json();
    const block = first(blocks);
    if (block) {
      return res({ success: false, error: `Horário bloqueado: ${block.reason || block.period_type || "Período indisponível"}` }, 400);
    }

    // --- 8. CALCULAR PREÇO E DURAÇÃO ---
    let totalPrice = 0;
    let totalDuration = 0;
    const items = [];

    for (let i = 0; i < service_ids.length; i++) {
      const serviceId = service_ids[i];
      const petId = pet_ids[i];

      // Pet
      const petRes = await fetch(`${sbUrl}/rest/v1/pets?id=eq.${petId}&select=size,name`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      const pet = first(await petRes.json());
      const petSize = pet?.size || "MEDIUM";

      // Preço
      const priceRes = await fetch(`${sbUrl}/rest/v1/service_price_rules?service_id=eq.${serviceId}&unit_id=eq.${unitId}&active=eq.true&order=sort_order.asc&select=*`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      const priceRules = await priceRes.json();
      let price = 0;
      if (Array.isArray(priceRules) && priceRules.length > 0) {
        const matched = priceRules.find((r: any) => r.criteria?.size === petSize);
        price = matched ? parseFloat(matched.price) : parseFloat(priceRules[0].price);
      }

      // Duração
      const durRes = await fetch(`${sbUrl}/rest/v1/service_duration_rules?service_id=eq.${serviceId}&unit_id=eq.${unitId}&active=eq.true&order=sort_order.asc&select=*`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      const durRules = await durRes.json();
      let duration = 0;
      if (Array.isArray(durRules) && durRules.length > 0) {
        const matched = durRules.find((r: any) => r.criteria?.size === petSize);
        duration = matched ? parseInt(matched.duration_minutes) : parseInt(durRules[0].duration_minutes);
      }

      totalPrice += price;
      totalDuration += duration;
      items.push({ pet_id: petId, service_id: serviceId, price, duration_minutes: duration });
    }

    // Recalcular slotEnd com duração real
    const finalSlotEndUTC = new Date(startDate.getTime() + totalDuration * 60000).toISOString();

    // --- 9. CONFLITO DE FUNCIONÁRIO ---
    let targetEmployeeId = employee_id || null;

    if (targetEmployeeId) {
      const empRes = await fetch(`${sbUrl}/rest/v1/employees?id=eq.${targetEmployeeId}&unit_id=eq.${unitId}&is_deleted=eq.false&status=eq.ACTIVE&select=*`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      if (!first(await empRes.json())) {
        return res({ success: false, error: "Funcionário não encontrado ou inativo" }, 400);
      }

      // Verificar conflito: funcionário já tem item neste horário?
      const conflictRes = await fetch(
        `${sbUrl}/rest/v1/appointment_items?employee_id=eq.${targetEmployeeId}&start_time=lt.${encodeURIComponent(finalSlotEndUTC)}&end_time=gt.${encodeURIComponent(slotStartUTC)}&status=in.(PENDING,CONFIRMED,CHECKED_IN)&select=appointment_id,start_time,end_time`,
        { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
      );
      if (first(await conflictRes.json())) {
        return res({ success: false, error: "Funcionário já ocupado neste horário" }, 400);
      }
    }

    // --- 10. CAPACIDADE DO SERVIÇO ---
    for (const serviceId of service_ids) {
      const svcRes = await fetch(`${sbUrl}/rest/v1/services?id=eq.${serviceId}&select=capacity,name`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      const svc = first(await svcRes.json());
      const capacity = svc?.capacity || 1;

      const simRes = await fetch(
        `${sbUrl}/rest/v1/appointment_items?service_id=eq.${serviceId}&start_time=lt.${encodeURIComponent(finalSlotEndUTC)}&end_time=gt.${encodeURIComponent(slotStartUTC)}&status=in.(PENDING,CONFIRMED,CHECKED_IN)&select=*`,
        { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
      );
      const simultaneous = await simRes.json();
      const count = Array.isArray(simultaneous) ? simultaneous.length : 0;
      if (count >= capacity) {
        return res({ success: false, error: `Capacidade do serviço "${svc?.name}" atingida (${capacity} vaga(s))` }, 400);
      }
    }

    // --- 11. CRIAR APPOINTMENT ---
    const apptData = {
      unit_id: unitId,
      customer_id,
      status: "PENDING",
      total_price: totalPrice,
      total_duration_minutes: totalDuration,
      unit_timezone: timezone,
      notes: notes || null,
    };

    const insertApptRes = await fetch(`${sbUrl}/rest/v1/appointments?select=*`, {
      method: "POST",
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(apptData),
    });

    const appointments = await insertApptRes.json();
    const appointment = first(appointments);
    if (!appointment) return res({ success: false, error: "Failed to create appointment" }, 500);

    // --- 12. CRIAR APPOINTMENT ITEMS ---
    for (const item of items) {
      await fetch(`${sbUrl}/rest/v1/appointment_items`, {
        method: "POST",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appointment_id: appointment.id,
          pet_id: item.pet_id,
          service_id: item.service_id,
          employee_id: targetEmployeeId,
          price: item.price,
          duration_minutes: item.duration_minutes,
          start_time: slotStartUTC,
          end_time: finalSlotEndUTC,
          status: "PENDING",
        }),
      });
    }

    return res({
      success: true,
      data: {
        appointment: {
          id: appointment.id,
          status: appointment.status,
          total_price: appointment.total_price,
          total_duration_minutes: appointment.total_duration_minutes,
          start_datetime: start_datetime,
          end_datetime: finalSlotEndUTC,
          unit_timezone: appointment.unit_timezone,
          notes: appointment.notes,
        },
        customer: { id: customer.id, name: customer.name, phone: customer.phone },
        items: items.map((it: any, idx: number) => ({
          pet: pet_ids[idx],
          service: service_ids[idx],
          price: it.price,
          duration_minutes: it.duration_minutes,
          employee_id: targetEmployeeId,
        })),
      },
    });

  } catch (err: any) {
    console.error("APPOINTMENTS ERROR:", err);
    return res({ success: false, error: err.message || "Internal server error" }, 500);
  }
});