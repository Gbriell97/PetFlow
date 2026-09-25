// Edge Function: chat-handler
// Recebe mensagem do cliente, processa com IA, consulta banco, retorna resposta.
// MULTI-LOJA (Decisão 10): resolve a unidade pelo número da loja que recebeu a
// mensagem (whatsapp_connections) e usa a api_key da unidade em todas as tools.
// Fallback para unidade padrão via env DEFAULT_UNIT_API_KEY.
// Deploy: .\supabase.exe functions deploy chat-handler --no-verify-jwt
//
// Payload esperado (n8n workflow 01):
//   { message, phone, name, sessionId?, storePhone?, instance? }
//   - phone:      telefone do CLIENTE (quem mandou a mensagem)
//   - storePhone: número da LOJA que recebeu (vem do webhook da AvisaAPI)
//   - instance:   nome da instância no painel da AvisaAPI (alternativa ao número)

const SB_URL = Deno.env.get("SB_URL") || "https://jnmtwalmfkcxixiwqbjm.supabase.co";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";

const DEFAULT_UNIT_API_KEY = Deno.env.get("DEFAULT_UNIT_API_KEY") || "3bb9f0d2-6e9e-4bb0-bed4-2bd88894adb3";

const digits = (s: unknown) => String(s || "").replace(/\D/g, "");

function first(arr: any[] | null | undefined) {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

// ==================== RESOLUÇÃO DA UNIDADE (multi-loja) ====================
// Estratégia:
//   1. whatsapp_connections por número exato (com DDI)
//   2. número sem DDI / com DDI (55...)
//   3. whatsapp_connections por instance_name
//   4. units.phone direto
//   5. fallback: unidade padrão (DEFAULT_UNIT_API_KEY)
async function resolveUnit(restHeaders: Record<string, string>, storePhone?: string, instance?: string) {
  const storeDigits = digits(storePhone);
  const inst = (instance || "").trim();

  // 1/2. por telefone (variações com/sem DDI)
  if (storeDigits) {
    const variants = [storeDigits];
    if (storeDigits.startsWith("55") && storeDigits.length > 11) variants.push(storeDigits.slice(2));
    else variants.push("55" + storeDigits);

    const res = await fetch(
      `${SB_URL}/rest/v1/whatsapp_connections?active=eq.true&phone=in.(${variants.join(",")})&select=unit_id`,
      { headers: restHeaders }
    );
    const conn = first(await res.json());
    if (conn?.unit_id) return unitById(restHeaders, conn.unit_id);
  }

  // 3. por nome da instância
  if (inst) {
    const res = await fetch(
      `${SB_URL}/rest/v1/whatsapp_connections?active=eq.true&instance_name=eq.${encodeURIComponent(inst)}&select=unit_id`,
      { headers: restHeaders }
    );
    const conn = first(await res.json());
    if (conn?.unit_id) return unitById(restHeaders, conn.unit_id);
  }

  // 4. telefone cadastrado direto na unidade
  if (storeDigits) {
    const variants = [storeDigits];
    if (storeDigits.startsWith("55") && storeDigits.length > 11) variants.push(storeDigits.slice(2));
    else variants.push("55" + storeDigits);

    const res = await fetch(
      `${SB_URL}/rest/v1/units?is_deleted=eq.false&phone=in.(${variants.join(",")})&select=id,name,timezone,api_key`,
      { headers: restHeaders }
    );
    const unit = first(await res.json());
    if (unit) return unit;
  }

  // 5. unidade padrão (compatibilidade com a loja atual)
  if (DEFAULT_UNIT_API_KEY) {
    return unitByApiKey(restHeaders, DEFAULT_UNIT_API_KEY);
  }

  return null;
}

async function unitById(restHeaders: Record<string, string>, unitId: string) {
  const res = await fetch(
    `${SB_URL}/rest/v1/units?id=eq.${unitId}&is_deleted=eq.false&select=id,name,timezone,api_key`,
    { headers: restHeaders }
  );
  return first(await res.json());
}

async function unitByApiKey(restHeaders: Record<string, string>, apiKey: string) {
  const res = await fetch(
    `${SB_URL}/rest/v1/units?api_key=eq.${apiKey}&is_deleted=eq.false&select=id,name,timezone,api_key`,
    { headers: restHeaders }
  );
  return first(await res.json());
}

// ==================== GEMINI ====================
async function callGemini(messages: any[], tools: any[], attempt = 0) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  const toolDeclarations = tools.map(t => ({
    function_declarations: [{
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }]
  }));

  const body = {
    contents: messages,
    tools: toolDeclarations,
    tool_config: { function_calling_config: { mode: "AUTO" } }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  // Se bater na quota (429), aguarda o tempo sugerido e tenta de novo (ate 2x)
  if (data?.error?.code === 429 && attempt < 2) {
    const retryMsg = data.error.message.match(/retry in ([\d.]+)s/i);
    const waitSec = Math.min(parseFloat(retryMsg?.[1] || "5"), 20);
    console.error(`Quota Gemini (429), aguardando ${waitSec}s para tentar de novo...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
    return callGemini(messages, tools, attempt + 1);
  }

  return data;
}

// ==================== TOOLS (chamadas ao backend com a api_key da unidade) ====================
async function executeTool(name: string, args: any, apiKey: string) {
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };

  switch (name) {
    case "find_customer": {
      const res = await fetch(`${SB_URL}/functions/v1/customers-find-or-create`, {
        method: "POST", headers, body: JSON.stringify(args)
      });
      return await res.json();
    }
    case "list_services": {
      const res = await fetch(`${SB_URL}/functions/v1/services`, {
        method: "GET", headers
      });
      return await res.json();
    }
    case "check_slots": {
      const body = {
        service_ids: [args.service_id],
        pet_ids: [args.pet_id],
        date: args.date,
        max_days: 1
      };
      const res = await fetch(`${SB_URL}/functions/v1/available-slots`, {
        method: "POST", headers, body: JSON.stringify(body)
      });
      return await res.json();
    }
    case "book_appointment": {
      const body = {
        customer_id: args.customer_id,
        service_ids: [args.service_id],
        pet_ids: [args.pet_id],
        start_datetime: args.start_datetime,
        notes: args.notes || ""
      };
      const res = await fetch(`${SB_URL}/functions/v1/appointments`, {
        method: "POST", headers, body: JSON.stringify(body)
      });
      return await res.json();
    }
    case "create_pet": {
      const res = await fetch(`${SB_URL}/functions/v1/pets`, {
        method: "POST", headers, body: JSON.stringify(args)
      });
      return await res.json();
    }
    default:
      return { error: "Tool desconhecida" };
  }
}

// ==================== HANDLER ====================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  const { message, phone, name, storePhone, instance } = await req.json();

  const SB_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const restHeaders = {
    "apikey": SB_KEY,
    "Authorization": `Bearer ${SB_KEY}`,
    "Content-Type": "application/json"
  };

  // --- RESOLVER A LOJA (multi-loja) ---
  let unit: any = null;
  try {
    unit = await resolveUnit(restHeaders, storePhone, instance);
  } catch (e) {
    console.error("Falha ao resolver unidade:", e);
  }

  if (!unit || !unit.api_key) {
    console.error(`Nenhuma unidade para storePhone=${storePhone} instance=${instance}`);
    return new Response(JSON.stringify({
      success: false,
      response: "Desculpe, este número ainda não está vinculado a uma loja. Por favor, contate o suporte. 🐾"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const apiKey = unit.api_key;
  const unitName = unit.name || "pet shop";
  const timezone = unit.timezone || "America/Sao_Paulo";

  // Sessão isolada por loja: mesmo cliente em duas lojas = duas conversas
  const customerDigits = digits(phone);
  const sid = `${unit.id}:${customerDigits || "anon"}`;

  // Carrega histórico da conversa (memória da Luna)
  let history = [];
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/chat_sessions?session_id=eq.${encodeURIComponent(sid)}&select=messages`,
      { headers: restHeaders }
    );
    const rows = await r.json();
    const raw = rows?.[0]?.messages || [];
    // Normaliza roles antigas ('function' -> 'user') para compatibilidade com modelos novos
    history = raw.map(m => (m && m.role === 'function') ? { ...m, role: 'user' } : m)
                 .filter(m => m && (m.role === 'user' || m.role === 'model') && Array.isArray(m.parts));
  } catch (e) {
    console.error("Falha ao carregar historico:", e);
  }

  const agora = new Date().toLocaleString("pt-BR", { timeZone: timezone });

  const systemPrompt = `Voce e a Luna, assistente virtual de ${unitName}.

DATA E HORA ATUAL: ${agora} (fuso ${timezone}). Use isso para interpretar "hoje", "amanha", "segunda" etc.

REGRAS:
1. SEMPRE confirme nome do cliente e pet antes de agendar
2. NUNCA invente precos ou horarios - use as ferramentas
3. Seja calorosa, profissional, emojis ocasionais 🐾
4. NAO prometa horario fora do expediente - a disponibilidade so e valida quando a ferramenta confirmar
5. NAO se apresente novamente se a conversa ja estiver em andamento - continue de onde parou
6. Seja objetiva: nao repita perguntas ja respondidas nesta conversa

FERRAMENTAS DISPONIVEIS:
- find_customer: Busca cliente pelo telefone. Parametros: phone, name
- list_services: Lista servicos. Sem parametros.
- check_slots: Verifica horarios. Parametros: service_id, pet_id, date (YYYY-MM-DD)
- book_appointment: Agenda. Parametros: customer_id, service_id, pet_id, start_datetime (ISO), notes
- create_pet: Cadastra pet. Parametros: customer_id, name, species, breed, sex, size, weight_kg

Guarde os UUIDs retornados para usar nas proximas chamadas.`;

  const tools = [
    {
      name: "find_customer",
      description: "Busca cliente pelo telefone ou cria novo",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Telefone com DDI+DDD" },
          name: { type: "string", description: "Nome do cliente" }
        },
        required: ["phone"]
      }
    },
    {
      name: "list_services",
      description: "Lista todos os servicos com precos",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "check_slots",
      description: "Verifica horarios disponiveis",
      parameters: {
        type: "object",
        properties: {
          service_id: { type: "string", description: "UUID do servico" },
          pet_id: { type: "string", description: "UUID do pet" },
          date: { type: "string", description: "Data YYYY-MM-DD" }
        },
        required: ["service_id", "pet_id", "date"]
      }
    },
    {
      name: "book_appointment",
      description: "Cria agendamento",
      parameters: {
        type: "object",
        properties: {
          customer_id: { type: "string" },
          service_id: { type: "string" },
          pet_id: { type: "string" },
          start_datetime: { type: "string", description: "ISO datetime" },
          notes: { type: "string" }
        },
        required: ["customer_id", "service_id", "pet_id", "start_datetime"]
      }
    },
    {
      name: "create_pet",
      description: "Cadastra novo pet",
      parameters: {
        type: "object",
        properties: {
          customer_id: { type: "string" },
          name: { type: "string" },
          species: { type: "string", enum: ["dog", "cat"] },
          breed: { type: "string" },
          sex: { type: "string", enum: ["MALE", "FEMALE"] },
          size: { type: "string", enum: ["SMALL", "MEDIUM", "LARGE"] },
          weight_kg: { type: "number" }
        },
        required: ["customer_id", "name", "species", "breed", "sex", "size"]
      }
    }
  ];

  let messages = [
    { role: "user", parts: [{ text: systemPrompt }] },
    { role: "model", parts: [{ text: "Entendido! Estou pronta para atender." }] },
    ...history,
    { role: "user", parts: [{ text: `Cliente (${name}, ${phone}): ${message}` }] }
  ];

  let maxTurns = 5;
  let finalResponse = "";
  let debugInfo = "";

  while (maxTurns > 0) {
    maxTurns--;
    const geminiRes = await callGemini(messages, tools);

    const candidate = geminiRes.candidates?.[0];
    if (!candidate) {
      debugInfo = JSON.stringify(geminiRes).slice(0, 800);
      console.error("Gemini sem candidates:", debugInfo);
      break;
    }

    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);

    if (functionCalls.length === 0) {
      finalResponse = textParts.map(p => p.text).join("");
      break;
    }

    for (const fc of functionCalls) {
      const toolResult = await executeTool(fc.functionCall.name, fc.functionCall.args, apiKey);
      // Envia a part original de volta (preserva thought_signature exigida pelo Gemini 3.x)
      messages.push({
        role: "model",
        parts: [fc]
      });
      messages.push({
        role: "user",
        parts: [{ functionResponse: { name: fc.functionCall.name, response: toolResult } }]
      });
    }
  }

  // Salva histórico (sem system prompt e sem chamadas de ferramenta) — máx. 40 entradas
  try {
    const toSave = messages.slice(2)
      .filter(m => Array.isArray(m.parts) && m.parts.every(p => p.text))
      .slice(-40);
    await fetch(`${SB_URL}/rest/v1/chat_sessions`, {
      method: "POST",
      headers: { ...restHeaders, "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ session_id: sid, messages: toSave, updated_at: new Date().toISOString() })
    });
  } catch (e) {
    console.error("Falha ao salvar historico:", e);
  }

  return new Response(JSON.stringify({
    success: true,
    response: finalResponse || "Desculpe, nao consegui processar sua solicitacao.",
    unit: { id: unit.id, name: unitName },
    debug: debugInfo || undefined
  }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
});
