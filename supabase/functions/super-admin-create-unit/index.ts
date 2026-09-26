// Edge Function: super-admin-create-unit
// Cria empresa + unidade + usuário admin + senha temporária
// Só aceita chamadas de SUPER_ADMIN

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Gerar senha temporária aleatória
function generateTempPassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const sbUrl = Deno.env.get("SB_URL") || Deno.env.get("SUPABASE_URL");
    const sbServiceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!sbUrl || !sbServiceKey) {
      return new Response(
        JSON.stringify({ success: false, error: "Server config error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(sbUrl, sbServiceKey);

    // --- 1. VERIFICAR SE QUEM CHAMA É SUPER_ADMIN ---
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: "Token ausente" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: "Token inválido" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: adminCheck } = await supabase
      .from("unit_users")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "SUPER_ADMIN")
      .eq("is_active", true)
      .maybeSingle();

    if (!adminCheck) {
      return new Response(
        JSON.stringify({ success: false, error: "Acesso negado. Somente SUPER_ADMIN." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- 2. RECEBER DADOS DA NOVA LOJA ---
    const body = await req.json();
    const {
      company_name,
      unit_name,
      owner_email,
      owner_name,
      phone,
      city,
      state,
      timezone = "America/Bahia",
    } = body;

    if (!company_name || !unit_name || !owner_email || !owner_name) {
      return new Response(
        JSON.stringify({ success: false, error: "Campos obrigatórios: company_name, unit_name, owner_email, owner_name" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- 3. CRIAR EMPRESA ---
    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .insert({ name: company_name, phone: phone || null })
      .select()
      .single();

    if (companyErr || !company) {
      return new Response(
        JSON.stringify({ success: false, error: "Erro ao criar empresa: " + companyErr?.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- 4. CRIAR UNIDADE COM API KEY ---
    const { data: unit, error: unitErr } = await supabase
      .from("units")
      .insert({
        company_id: company.id,
        name: unit_name,
        phone: phone || "+5571999999999",
        email: owner_email,
        city: city || "Salvador",
        state: state || "BA",
        country: "BR",
        timezone: timezone,
        api_key: crypto.randomUUID(),
        status: "ACTIVE",
        slot_interval_minutes: 30,
        booking_confirmation_mode: "MANUAL",
        default_buffer_minutes: 15,
        late_tolerance_minutes: 15,
        no_show_threshold_minutes: 30,
      })
      .select()
      .single();

    if (unitErr || !unit) {
      return new Response(
        JSON.stringify({ success: false, error: "Erro ao criar unidade: " + unitErr?.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- 5. CRIAR USUÁRIO NO AUTH (senha temporária) ---
    // Se o email já existe (ex.: mesmo dono de várias lojas), REUTILIZA o
    // usuário em vez de falhar — a loja é vinculada ao login existente.
    let newUserId = "";
    let tempPassword: string | null = generateTempPassword();
    let reusedUser = false;

    const { data: userList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const existing = userList?.users?.find(
      (u) => (u.email || "").toLowerCase() === owner_email.toLowerCase()
    );

    if (existing) {
      newUserId = existing.id;
      tempPassword = null;
      reusedUser = true;
    } else {
      const { data: authUser, error: createUserErr } = await supabase.auth.admin.createUser({
        email: owner_email,
        password: tempPassword!,
        email_confirm: true,
        user_metadata: { name: owner_name },
      });

      if (createUserErr || !authUser.user) {
        return new Response(
          JSON.stringify({ success: false, error: "Erro ao criar usuário: " + createUserErr?.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      newUserId = authUser.user.id;
    }

    // --- 6. CRIAR PERFIL EM public.users (se ainda não existir) ---
    await supabase.from("users").upsert({
      id: newUserId,
      name: owner_name,
      email: owner_email,
      phone: phone || null,
    }, { onConflict: "id" });

    // --- 7. VINCULAR COMO UNIT_ADMIN ---
    await supabase.from("unit_users").insert({
      unit_id: unit.id,
      user_id: newUserId,
      role: "UNIT_ADMIN",
      is_active: true,
    });

    // --- 8. CRIAR ASSINATURA PADRÃO + HORÁRIO DE FUNCIONAMENTO ---
    const { data: defaultPlan } = await supabase
      .from("plans")
      .select("id, price")
      .eq("name", "Profissional")
      .single();

    await supabase.from("subscriptions").insert({
      unit_id: unit.id,
      plan_id: defaultPlan?.id || null,
      status: "ACTIVE",
      start_date: new Date().toISOString().split("T")[0],
      end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      renewal_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      amount: defaultPlan?.price || 197.00,
      billing_cycle: "MONTHLY",
      payment_status: "PAID",
      auto_renew: true,
    });

    const defaultHours = [
      { day_of_week: 0, open_time: "08:00:00", close_time: "14:00:00", is_closed: false },
      { day_of_week: 1, open_time: "08:00:00", close_time: "18:00:00", is_closed: false },
      { day_of_week: 2, open_time: "08:00:00", close_time: "18:00:00", is_closed: false },
      { day_of_week: 3, open_time: "08:00:00", close_time: "18:00:00", is_closed: false },
      { day_of_week: 4, open_time: "08:00:00", close_time: "18:00:00", is_closed: false },
      { day_of_week: 5, open_time: "08:00:00", close_time: "18:00:00", is_closed: false },
      { day_of_week: 6, open_time: "08:00:00", close_time: "16:00:00", is_closed: false },
    ];

    for (const h of defaultHours) {
      await supabase.from("business_hours").insert({
        unit_id: unit.id,
        ...h,
      });
    }

    // --- 9. RETORNAR DADOS DE ACESSO ---
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          message: "Loja criada com sucesso!",
          company: { id: company.id, name: company.name },
          unit: {
            id: unit.id,
            name: unit.name,
            api_key: unit.api_key,
            timezone: unit.timezone,
          },
          owner: {
            id: newUserId,
            name: owner_name,
            email: owner_email,
            temp_password: tempPassword,
            reused: reusedUser,
          },
          instructions: reusedUser
            ? [
                "1. Esta loja foi vinculada a um login que já existe (" + owner_email + ")",
                "2. O dono acessa o painel com o email e a senha que já usa",
                "3. A API Key (para n8n/WhatsApp) já está configurada",
              ]
            : [
                "1. Acesse o painel da loja no link que você enviar",
                "2. Login: email + senha temporária acima",
                "3. A API Key (para n8n/WhatsApp) já está configurada",
                "4. Peça para o dono trocar a senha no primeiro acesso",
              ],
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("CREATE UNIT ERROR:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno: " + err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
