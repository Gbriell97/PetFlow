// Edge Function: chat-handler
// Recebe mensagem do cliente, processa com IA, consulta banco, retorna resposta

const SB_URL = "https://jnmtwalmfkcxixiwqbjm.supabase.co";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";

const API_KEY = "3bb9f0d2-6e9e-4bb0-bed4-2bd88894adb3";

async function callGemini(messages, tools, attempt = 0) {
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

async function executeTool(name, args) {
  const headers = {
    "Authorization": `Bearer ${API_KEY}`,
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  const { message, phone, name, sessionId } = await req.json();
  const sid = sessionId || phone || "anon";

  const SB_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const restHeaders = {
    "apikey": SB_KEY,
    "Authorization": `Bearer ${SB_KEY}`,
    "Content-Type": "application/json"
  };

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

  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Bahia" });

  const systemPrompt = `Voce e a Luna, assistente virtual da Pet Shop Bicho Feliz.

DATA E HORA ATUAL: ${agora} (fuso America/Bahia). Use isso para interpretar "hoje", "amanha", "segunda" etc.

REGRAS:
1. SEMPRE confirme nome do cliente e pet antes de agendar
2. NUNCA invente precos ou horarios - use as ferramentas
3. Seja calorosa, profissional, emojis ocasionais 🐾
4. Horario: Seg-Sex 08h-18h, Sab 08h-16h, Dom 08h-14h
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
      const toolResult = await executeTool(fc.functionCall.name, fc.functionCall.args);
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
    debug: debugInfo || undefined
  }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
});
