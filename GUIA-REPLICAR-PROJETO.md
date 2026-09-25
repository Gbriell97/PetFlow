# 🔄 Guia: Como replicar este projeto do zero (WhatsApp + IA + Painel)

Este guia ensina a montar, manualmente, a mesma arquitetura do PetFlow em outro projeto
(outro nicho, outra empresa). Tempo estimado: 2 a 4 horas na primeira vez.

## Arquitetura que vamos montar

```
WhatsApp → AvisaAPI → ngrok → n8n (Docker) → Supabase (banco + Edge Functions) → Gemini (IA)
                                          ↘ Painel HTML lê o Supabase
```

---

## Pré-requisitos (instalar uma vez no PC)

1. **Docker Desktop** — https://www.docker.com/products/docker-desktop/
2. **ngrok** — https://ngrok.com/download (criar conta gratuita e pegar o authtoken)
3. **Conta Supabase** — https://supabase.com (plano free)
4. **Conta AvisaAPI** — https://www.avisaapi.com.br (conectar o número de WhatsApp da loja)
5. **Chave da API Gemini** — https://aistudio.google.com/apikey

---

## Etapa 1 — Banco de dados (Supabase)

1. Em https://supabase.com → **New Project** → anote: `Project URL` e as chaves `anon` e `service_role` (em Settings → API Keys).
2. No **SQL Editor**, crie as tabelas conforme o nicho. Modelo mínimo (adapte os campos):

```sql
-- Empresa/unidade
create table units (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_key uuid default gen_random_uuid(),  -- usada pelo painel
  timezone text default 'America/Sao_Paulo',
  created_at timestamptz default now()
);

-- Clientes
create table customers (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references units(id),
  name text,
  phone text unique,
  created_at timestamptz default now()
);

-- Agendamentos/pedidos (entidade principal do nicho)
create table appointments (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references units(id),
  customer_id uuid references customers(id),
  status text default 'PENDING',  -- PENDING, CONFIRMED, CANCELLED, COMPLETED
  notes text,
  created_at timestamptz default now()
);

-- Memória da IA (histórico de conversas)
create table chat_sessions (
  session_id text primary key,  -- telefone do cliente
  messages jsonb default '[]',
  updated_at timestamptz default now()
);
alter table chat_sessions enable row level security; -- sem policy = só service_role acessa
```

3. Crie 1 unidade de teste e anote o `api_key` dela:
```sql
insert into units (name) values ('Minha Loja') returning id, api_key;
```

---

## Etapa 2 — Edge Functions (a "API" do projeto)

As Edge Functions são pequenos programas em TypeScript que rodam na nuvem da Supabase.
O n8n e o painel conversam com elas, nunca direto com o banco.

1. Instale o CLI: `npm install -g supabase`
2. Na pasta do novo projeto:
```bash
supabase login
supabase init
supabase link --project-ref SEU_PROJECT_REF
```
3. Crie as funções: `supabase functions new chat-handler` (a IA), `appointments` (criar),
   `appointments-list` (listar), `appointments-status` (confirmar/recusar), `auth-login` (login do painel).
4. Copie o código das funções do projeto PetFlow (`supabase/functions/`) e adapte:
   - No `chat-handler`: troque o **prompt da Luna** pelo novo nicho e ajuste as ferramentas (tools) que a IA pode chamar.
5. Configure os segredos:
```bash
supabase secrets set GEMINI_API_KEY=sua_chave_gemini
```
6. Publique:
```bash
supabase functions deploy chat-handler --no-verify-jwt
supabase functions deploy appointments --no-verify-jwt
# ...idem para as outras
```

---

## Etapa 3 — n8n (Docker)

```bash
docker run -d --name n8n_local ^
  -p 5678:5678 ^
  -v C:\caminho\do\projeto\n8n_data:/home/node/.n8n ^
  -e SUPABASE_URL=https://SEU_REF.supabase.co ^
  -e SUPABASE_SERVICE_KEY=sua_service_role ^
  -e PETFLOW_API_KEY=api_key_da_unidade ^
  -e AVISA_API_KEY=sua_chave_avisaapi ^
  -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false ^
  -e WEBHOOK_URL=https://SUA-URL.ngrok-free.dev/ ^
  docker.n8n.io/n8nio/n8n
```

1. Abra http://localhost:5678 e crie o login do n8n.
2. Importe os workflows de `n8n/workflows/` (menu ⋮ → Import from File) e **adapte**:
   - URL das Edge Functions (novo project ref);
   - Campos do banco conforme o novo nicho.
3. **Ative** o workflow (botão Active no topo) — workflow inativo não recebe webhook.

---

## Etapa 4 — ngrok (expor o n8n na internet)

```bash
ngrok http --url=SUA-URL.ngrok-free.dev 5678
```
- Na conta gratuita você tem direito a 1 domínio fixo — use-o para a URL não mudar.
- Deixe essa janela sempre aberta enquanto o sistema estiver no ar.

---

## Etapa 5 — AvisaAPI (WhatsApp)

1. No painel da AvisaAPI, conecte o número de WhatsApp da loja (QR Code).
2. Configure o **webhook de recebimento** apontando para:
   `https://SUA-URL.ngrok-free.dev/webhook/whatsapp-inbound`
   (o caminho exato está no nó Webhook do workflow 01)
3. Envio de mensagem (já configurado no workflow):
   `POST https://www.avisaapi.com.br/api/actions/sendMessage`
   Header `Authorization: Bearer SUA_CHAVE`, body `{"number":"55...","message":"..."}`

---

## Etapa 6 — Painel da loja

1. Copie `Painel-loja/index.html` para o novo projeto.
2. Troque no código (seção `CONFIG`):
   - `defaultApiUrl` → `https://NOVO_REF.supabase.co/functions/v1`
   - `defaultApiKey` → api_key da unidade do novo projeto
3. Ajuste textos, cores e entidades do nicho (serviços, pets → o que for o novo domínio).
4. O vigia de notificações (`apptWatcher`) já vem junto — notifica novos PENDING a cada 30s.

---

## Etapa 7 — Teste de ponta a ponta

1. Mande mensagem no WhatsApp da loja → a IA deve responder.
2. Faça um agendamento completo pela conversa.
3. Em até 30s o painel deve mostrar o alerta 🔔 com o agendamento Pendente.
4. Confirme no painel → status muda no banco.

---

## Checklist de "mudou de PC / reiniciou tudo"

- [ ] Docker Desktop aberto → `docker start n8n_local`
- [ ] ngrok rodando com o domínio fixo
- [ ] Workflow 01 **Active** no n8n
- [ ] Webhook da AvisaAPI apontando para a URL do ngrok
