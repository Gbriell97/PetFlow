// Edge Function: auth-login
// Autentica email/senha e retorna token + role + unidades

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return new Response(
        JSON.stringify({ success: false, error: "Email e senha são obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sbUrl = Deno.env.get("SB_URL") || Deno.env.get("SUPABASE_URL");
    const sbServiceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const sbAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!sbUrl || !sbServiceKey) {
      return new Response(
        JSON.stringify({ success: false, error: "Configuração do servidor incompleta" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Autenticar no Supabase Auth
    const authRes = await fetch(`${sbUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": sbAnonKey || sbServiceKey,
      },
      body: JSON.stringify({ email, password }),
    });

    const authData = await authRes.json();

    if (!authRes.ok || authData.error) {
      return new Response(
        JSON.stringify({ success: false, error: "Email ou senha incorretos" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = authData.user.id;
    const accessToken = authData.access_token;

    // 2. Buscar dados do usuário e vínculos
    const supabase = createClient(sbUrl, sbServiceKey);

    const { data: userData } = await supabase
      .from("users")
      .select("id, name, email, phone")
      .eq("id", userId)
      .single();

    const { data: unitUsers } = await supabase
      .from("unit_users")
      .select("unit_id, role, is_active, units:unit_id(id, name, timezone, api_key, status)")
      .eq("user_id", userId)
      .eq("is_active", true);

    if (!unitUsers || unitUsers.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Usuário sem acesso a nenhuma unidade" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isSuperAdmin = unitUsers.some((u: any) => u.role === "SUPER_ADMIN");

    const responseData: any = {
      access_token: accessToken,
      user: {
        id: userId,
        email: authData.user.email,
        name: userData?.name || authData.user.user_metadata?.name || email.split("@")[0],
        phone: userData?.phone || null,
        is_super_admin: isSuperAdmin,
      },
    };

    if (isSuperAdmin) {
      // Super Admin vê TODAS as unidades
      const { data: allUnits } = await supabase
        .from("units")
        .select("id, name, timezone, api_key, status, phone, city, state")
        .eq("is_deleted", false)
        .order("created_at", { ascending: false });

      responseData.user.units = allUnits || [];
    } else {
      // Dono da loja vê só as dele
      responseData.user.units = unitUsers.map((u: any) => ({
        unit_id: u.unit_id,
        role: u.role,
        ...u.units,
      }));
    }

    return new Response(
      JSON.stringify({ success: true, data: responseData }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("LOGIN ERROR:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno no servidor" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});