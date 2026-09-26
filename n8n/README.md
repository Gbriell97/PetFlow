# PetFlow — Projeto n8n

Automação e integração do PetFlow: ponte entre **WhatsApp (Evolution API)**,
o **backend (Supabase)** e as **notificações/lembretes**:

```
Cliente → WhatsApp → Evolution API → webhook → n8n → máquina de estados → Backend/Supabase
                                                     ↘ IA Luna (humaniza) → WhatsApp
                     Schedule (1 min) → eventos do painel + lembretes → WhatsApp
```

Regras de ouro respeitadas no workflow: **o sistema é a fonte da verdade, o n8n decide,
a IA só humaniza a comunicação**. Nenhuma regra de negócio (preço, disponibilidade,
confirmação) é decidida pela IA. Tudo roda em **um único workflow**.

> ⚠️ Os workflows antigos da AvisaAPI (01–03) foram removidos. O canal oficial
> agora é a **Evolution API**, no workflow único `04-evolution-bot.json`.

## Estrutura

```
n8n/
├── docker-compose.yml          # Stack n8n + Postgres (reprodução/migração)
├── build_workflow.py           # Monta o workflow único a partir de src/*.js
├── import.sh                   # Importa os workflows via API do n8n
├── src/
│   ├── extract.js              # Nó 1 — normaliza payload Evolution (fono, texto, instância, messageId)
│   ├── statemachine.js         # Nó 2 — máquina de estados + multi-loja + idempotência
│   └── events.js               # Nó 11 — eventos do painel + lembretes (24h e 2h)
└── workflows/
    └── 04-evolution-bot.json   # WORKFLOW ÚNICO (gerado por build_workflow.py)
```

> Para alterar o comportamento do bot, edite os arquivos em `src/` e rode
> `python build_workflow.py`. Depois reimporte o JSON no n8n.

## Workflow único — blocos

**Gatilho 1 — Webhook Evolution** (`POST /webhook/whatsapp-inbound`)
1. **01 · Webhook Evolution** — recebe `messages.upsert` da Evolution v2.
2. **02 · Extrair mensagem** — normaliza o payload, ignora grupos/fromMe (evita loop)
   e captura `phone`, `text`, `pushName`, `instance`, `storePhone` e `messageId`.
3. **02 · Máquina de estados** — toda a lógica determinística (ver abaixo).
4. **03 · Tem resposta?** → silêncio (`mode=none`) não envia nada.
5. **04 · Texto pronto?** → `fixed` vai direto para **05 · Enviar WhatsApp**;
   `polish`/`fallback` passam pela **05 · IA Luna (Gemini)** que apenas humaniza,
   e o texto final sai por **06 · Enviar WhatsApp (IA)**.

**Gatilho 2 — Schedule (a cada 1 minuto)**
- **11 · Eventos + Lembretes** — processa `system_events` não processados
  (`APPOINTMENT_CONFIRMED`, `APPOINTMENT_REJECTED`, `APPOINTMENT_CANCELLED`,
  `APPOINTMENT_COMPLETED`) e envia lembretes de **24h** e **2h** antes, com controle
  de duplicidade (`reminder_sent` / `reminder_2h_sent`). Só lembra agendamentos
  `CONFIRMED`.

## Máquina de estados (`src/statemachine.js`)

- **Contexto central** na tabela `conversation_state` (por telefone): `state`,
  `data` (JSON com `unit_id`, pet/serviço/horário escolhidos, `last_msg_id`) e
  `handoff` (humano atendendo → bot mudo até o cliente digitar *menu*).
- **Idempotência**: se o `messageId` da mensagem já foi processado
  (`data.last_msg_id`), a execução é ignorada — webhook duplicado não gera
  resposta nem operação em dobro.
- **Cadastro**: cliente novo → nome → pet (nome, espécie, porte) → grava no
  Supabase e só continua após confirmação do insert.
- **Agendamento**: pet → serviço (preços reais por porte, `service_price_rules`)
  → dia → horários (`available-slots`) → confirmação → `POST /functions/v1/appointments`.
  Só diz "enviado" se `res.success`; nunca diz "confirmado" — quem confirma é a loja
  no painel (chega via `APPOINTMENT_CONFIRMED`).
- **Erros**: qualquer falha no Supabase/API responde "probleminha técnico" e nunca
  afirma que a operação foi concluída.

## Multi-loja (N:N) — IMPLEMENTADO no workflow único

Uma conexão Evolution pode atender **uma ou várias lojas** (tabela
`whatsapp_connections`, gerenciada no **Painel Admin → Gerenciar Loja → aba WhatsApp**).

Fluxo na máquina de estados (recebe `storePhone`/`instance` do nó *Extrair mensagem*):
1. Resolve TODAS as lojas da conexão: conexões ativas por telefone (com/sem DDI 55)
   → `instance_name` → `units.phone` direto → fallback unidade padrão (`PETFLOW_API_KEY`).
2. **1 loja** → seleciona automaticamente e salva `unit_id` no contexto.
3. **N lojas** → menu numerado; a escolha (número ou nome exato) é validada e salva
   em `data.unit_id` — vale enquanto o contexto for válido, não pergunta de novo.
4. **Troca de loja**: somente por comando explícito do cliente
   (*"trocar loja"*, *"trocar de loja"*, *"mudar loja"*).
5. Com a loja definida, **todas** as consultas e operações usam o `unit_id` e a
   `api_key` dela (cliente, pets, serviços, preços, horários, agendamentos) —
   isolamento total por loja.

> ⚠️ Se o payload da Evolution não trouxer `instance` nem número da loja em campo
> conhecido, veja o `raw` da execução no n8n e ajuste o mapeamento no nó
> *Extrair mensagem*. Sem identificação, o sistema cai no fallback da unidade padrão.

## Setup

1. **Variáveis** no container n8n: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `PETFLOW_API_KEY` (unidade padrão/fallback), `EVOLUTION_URL`,
   `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` e `WEBHOOK_URL`.
2. **Build**: `python build_workflow.py` (gera `workflows/04-evolution-bot.json`).
3. **Importar**: n8n → menu **⋯ → Import from File** → `04-evolution-bot.json`.
4. **Ativar** o workflow (toggle "Active") e conferir a credencial do Gemini.
5. **URL pública**: em desenvolvimento, `ngrok http 5678` e configure o webhook
   da instância Evolution para `https://SUA-URL-PUBLICA/webhook/whatsapp-inbound`.
6. **Teste**: envie "Olá" de outro celular. A execução deve aparecer no n8n e a
   resposta chegar no WhatsApp.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `SUPABASE_URL` | Base do backend (Edge Functions + REST) |
| `SUPABASE_SERVICE_KEY` | Acesso REST (tabelas) |
| `PETFLOW_API_KEY` | Unidade padrão (fallback da resolução multi-loja) |
| `EVOLUTION_URL` | Base da Evolution API (envio de mensagens) |
| `EVOLUTION_API_KEY` | apikey da Evolution |
| `EVOLUTION_INSTANCE` | Instância usada no nó de envio |
| `WEBHOOK_URL` | URL pública do n8n (referência) |
