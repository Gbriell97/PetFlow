# PetFlow — Projeto n8n

Automação e integração do PetFlow: ponte entre **WhatsApp (AvisaAPI)**,
o **backend (Supabase Edge Functions)** e as **notificações/lembretes** — conforme a
arquitetura definida no documento do projeto:

```
Cliente → WhatsApp → AvisaAPI → webhook → n8n → chat-handler (IA) → Backend/Supabase
                                             ↘ Eventos/Lembretes → WhatsApp
```

Regra de ouro respeitada nos workflows: **a IA entende, o backend decide**. O n8n só
transporta mensagens e eventos — nenhuma regra de negócio (preço, disponibilidade,
confirmação) é calculada aqui.

> ⚠️ **AvisaAPI é um gateway não-oficial.** Para o MVP é rápido e barato, mas quando o
> produto for vendido comercialmente (multi-loja), o plano é migrar para a WhatsApp
> Business Platform oficial (Decisão 10). A troca afeta apenas os nós de envio/recebimento
> do n8n — o backend não muda.

## Estrutura

```
n8n/
├── docker-compose.yml      # Stack n8n + Postgres (reprodução/migração)
├── .env.example            # Todas as variáveis necessárias
├── import.sh               # Importa os workflows via API do n8n
└── workflows/
    ├── 01-whatsapp-inbound.json   # Webhook AvisaAPI → IA (chat-handler) → resposta
    ├── 02-system-events.json      # Eventos do backend → WhatsApp do cliente
    └── 03-reminders.json          # Lembretes automáticos (24h antes)
```

## Workflows

### 01 — WhatsApp Inbound (AvisaAPI)
- `POST /webhook/petflow/whatsapp` — recebe as mensagens que a AvisaAPI encaminha.
- O nó **Extrair mensagem** normaliza o payload (tolerante aos formatos Evolution/Baileys
  e genérico), ignora grupos e mensagens enviadas pelo próprio número (evita loop).
- Chama a Edge Function `chat-handler` (IA Luna) e devolve a resposta pela AvisaAPI.
- Nó **Log mensagem (Supabase)** desabilitado — habilite quando a tabela `messages`
  existir (Decisão 19).

### 02 — Eventos do Sistema
- `POST /webhook/petflow/events` — o backend dispara eventos (`system_events`):
  `APPOINTMENT_CREATED`, `APPOINTMENT_CONFIRMED`, `APPOINTMENT_REJECTED`,
  `APPOINTMENT_CANCELLED`, `APPOINTMENT_COMPLETED`, `QUOTE_SENT`, `REMINDER`,
  `HUMAN_HANDOFF`.
- Cada evento vira uma mensagem com variáveis (cliente, pet, serviço, data, horário)
  enviada ao cliente pela AvisaAPI.

### 03 — Lembretes Automáticos
- A cada 15 min, busca agendamentos `CONFIRMED` que começam entre 24h00 e 24h15,
  envia o lembrete e marca `reminder_sent = true`.
- ⚠️ Nomes de colunas provisórios — ajuste o nó **Mapear campos** quando o DER final
  estiver fechado (há uma nota dentro do workflow).

## Setup

1. **Variáveis**: o container `n8n_local` já foi recriado com `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `PETFLOW_API_KEY` e `AVISA_API_KEY`.
   Para mudar algum valor, edite e recrie o container (ou use o `docker-compose.yml`).
2. **Importar workflows**: n8n → menu **⋯ → Import from File**, um JSON por vez.
   Se você já tinha importado a versão Meta, reimporte — a versão AvisaAPI substitui.
3. **Ative os 3 workflows** (toggle "Active").
4. **URL pública**: o webhook precisa ser acessível pela internet. Em desenvolvimento:
   ```bash
   ngrok http 5678
   ```
   (o container já está com `WEBHOOK_URL=https://stinking-radiated-watch.ngrok-free.dev/` —
   se o seu ngrok gerar outra URL, recrie o container com a nova.)
5. **Webhook na AvisaAPI**: no painel (https://www.avisaapi.com.br), conecte seu número
   e configure o webhook de mensagens recebidas para:
   ```
   https://SUA-URL-PUBLICA/webhook/petflow/whatsapp
   ```
6. **Teste**: envie "Olá" de outro celular para o número conectado. A mensagem deve
   aparecer em **Executions** no n8n e a IA deve responder no WhatsApp.

## Variáveis de ambiente usadas pelos workflows

| Variável | Uso |
|---|---|
| `SUPABASE_URL` | Base do backend (Edge Functions + REST) |
| `SUPABASE_SERVICE_KEY` | Acesso REST (tabelas appointments/messages) |
| `PETFLOW_API_KEY` | Bearer aceito pelas Edge Functions PetFlow |
| `AVISA_API_KEY` | Bearer da AvisaAPI (envio de mensagens) |
| `WEBHOOK_URL` | URL pública do n8n (para referência nos webhooks) |

## Multi-loja (Decisão 10)

Cada loja terá seu próprio número conectado na AvisaAPI. O `whatsapp_connections`
do banco vai mapear número → unidade; quando houver mais de uma loja, o nó
**Extrair mensagem** do workflow 01 já expõe o telefone e o backend resolve a
unidade correspondente.
