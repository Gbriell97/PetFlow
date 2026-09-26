# Roteiro de Testes — PetFlow WhatsApp Bot (Evolution)

Cobertura dos cenários obrigatórios (seção 40 do Prompt Mestre) adaptada ao
workflow único `04-evolution-bot.json`.

## Pré-requisitos

- [ ] Workflow `04-evolution-bot.json` importado e **ativo** no n8n
- [ ] Credencial do Gemini configurada no nó **05 · IA Luna**
- [ ] Variáveis no container: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
      `PETFLOW_API_KEY`, `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`
- [ ] Webhook da Evolution apontando para `https://SUA-URL/webhook/whatsapp-inbound`
- [ ] Um celular "cliente" de teste (número **não** cadastrado na base)
- [ ] Acesso ao Supabase (SQL Editor) e ao Painel da loja

Como observar: cada mensagem enviada deve gerar uma execução em
**n8n → Executions**. Em caso de falha, abra a execução e veja o `raw` de cada nó.

---

## 1. Cliente

### 1.1 Número não cadastrado → fluxo de cadastro
1. Envie `Olá` do celular de teste.
2. **Esperado:** boas-vindas + pergunta do *nome completo* (estado `ASK_NAME`).
3. Responda com um nome → pergunta o *nome do pet* (`ASK_PET_NAME`).
4. Responda → pergunta espécie (`1️⃣ Cachorro 2️⃣ Gato`).
5. Envie `9` (inválido) → **Esperado:** "Digite *1* para Cachorro ou *2* para Gato."
6. Envie `1` → pergunta o porte. Envie `2` (Médio).
7. **Esperado:** "Cadastro concluído! 🎉" + menu.
8. **Verificar no Supabase:** `customers` (novo registro, `source = whatsapp`,
   `unit_id` da loja) e `pets` (vinculado, `active = true`).

### 1.2 Número cadastrado
1. Envie `Olá` novamente.
2. **Esperado:** menu direto com seu nome ("Olá, *Nome*!"), sem pedir cadastro.

### 1.3 Cliente com uma loja
- Pré-condição: número da conexão vinculado a apenas 1 loja em `whatsapp_connections`.
- **Esperado:** nunca aparece menu de lojas; atendimento direto.
- **Verificar:** `conversation_state.data.unit_id` preenchido automaticamente.

### 1.4 Cliente com várias lojas
- Pré-condição: mesma conexão vinculada a 2+ lojas (Painel Admin → aba WhatsApp).
1. Envie `Olá`.
2. **Esperado:** "Encontrei mais de uma loja vinculada a este número" + menu numerado.
3. Envie `99` (inválido) → **Esperado:** "Não entendi a opção" + menu de lojas de novo.
4. Envie `1` → **Esperado:** "Você está falando com *Loja X*" + menu principal.
5. Envie `menu` e depois `1` → **Esperado:** serviços **da loja escolhida**
   (confira no Supabase que são os serviços daquele `unit_id`).
6. Envie `trocar loja` → **Esperado:** menu de lojas novamente; escolha a outra.
7. Envie `2` (Meus agendamentos) → **Esperado:** apenas agendamentos **da outra loja**
   (isolamento por `store_id`).
8. Reinicie a conversa (`menu`) e mande mensagem no dia seguinte → **Esperado:**
   não pergunta a loja de novo enquanto `conversation_state.data.unit_id` existir.

---

## 2. Loja

### 2.1 Seleção inválida — coberto em 1.4 (passo 3)
### 2.2 Loja inexistente / conexão sem vínculo
- Pré-condição: remover a conexão de `whatsapp_connections` (ou `active = false`)
  **e** o número não existir em `units.phone`.
- **Esperado:** cai no fallback da unidade padrão (`PETFLOW_API_KEY`).
- Se `PETFLOW_API_KEY` estiver inválida → **Esperado:** "Loja não configurada."

### 2.3 Payload sem `instance` nem número da loja
1. Abra uma execução no n8n → nó **02 · Extrair mensagem** → veja o `raw`.
2. Se `instance` e `storePhone` vierem vazios, o bot usa o fallback (2.2).
3. **Ação:** ajustar o mapeamento no `src/extract.js` conforme o campo real do payload
   e rebuildar (`python build_workflow.py`).

---

## 3. Pets

### 3.1 Nenhum pet
- Pré-condição: cliente cadastrado sem pets (delete o pet de teste ou crie
  cliente novo pulando o cadastro de pet via SQL).
1. Menu → `1` (Agendar).
2. **Esperado:** "Você ainda não tem pet cadastrado. Qual o *nome do seu pet*?"
   e o fluxo de cadastro de pet inicia.

### 3.2 Um pet
1. Menu → `1`.
2. **Esperado:** pula a escolha de pet e vai direto à lista de serviços,
   mencionando o nome do pet.

### 3.3 Vários pets
- Pré-condição: cadastrar 2+ pets para o cliente (SQL ou repetindo 3.1).
1. Menu → `1`.
2. **Esperado:** lista numerada dos pets (nome, espécie, porte).
3. Envie número inválido → **Esperado:** "Digite o número do pet (1 a N) ou *cancelar*."
4. Escolha um → serviços com **preço do porte daquele pet**.

---

## 4. Serviços e preços

### 4.1 Serviço existente + preço por porte
1. Agende com um pet **Pequeno** e anote o preço de "Banho".
2. Repita com um pet **Grande**.
3. **Esperado:** preços diferentes, iguais aos de `service_price_rules`
   (`criteria.size` correspondente). Conferir no SQL:
   ```sql
   select service_id, criteria, price from service_price_rules
   where unit_id = '<UNIT>' and active = true;
   ```

### 4.2 Serviço sem regra de preço
- **Esperado:** serviço aparece sem "— R$" (nunca inventa valor) e no resumo de
  confirmação usa o preço retornado pelo `available-slots` (ou R$ 0,00 se o
  sistema não retornar — nunca um valor estimado pela IA).

### 4.3 Pergunta livre de preço (IA)
1. No menu, envie `quanto custa o banho?` (texto, não número).
2. **Esperado:** modo `fallback` — a Luna **não informa valor inventado**;
   deve convidar a digitar *menu* para ver os preços reais.
3. **Verificar na execução:** nó **02 · Máquina de estados** com `mode = fallback`
   e a resposta da IA sem números de preço.

---

## 5. Horários e disponibilidade

### 5.1 Horário disponível
1. Fluxo de agendamento até `BOOK_DAY`, escolha um dia útil.
2. **Esperado:** lista de horários reais vindos do `available-slots`
   (compare com o painel da loja — devem bater).

### 5.2 Dia sem horários
- Pré-condição: escolher um dia com a loja fechada ou agenda cheia.
- **Esperado:** "😕 Sem horários livres em *<dia>*. Escolha outro dia:" + lista de dias.

### 5.3 Loja fechada (fora do expediente)
- Verificar que os slots oferecidos respeitam `business_hours` da loja
  (o `available-slots` já filtra — o bot nunca monta horário por conta própria).

---

## 6. Agendamento

### 6.1 Solicitação criada (PENDING)
1. Complete o fluxo: pet → serviço → dia → horário → `1` (Confirmar).
2. **Esperado:** "🎉 Pedido enviado! ... ⏳ A loja vai confirmar em instantes" —
   **nunca** "agendamento confirmado".
3. **Verificar:** agendamento `PENDING` no painel da loja e em `appointments`
   com `notes = 'Agendado via WhatsApp (bot)'` e `unit_id` correto.

### 6.2 Confirmação pelo painel
1. No painel da loja, confirme o agendamento.
2. Em até ~1 min (schedule), **Esperado:** WhatsApp "✅ *Agendamento confirmado!*"
   com serviço, pet, data e horário corretos.
3. **Verificar:** `system_events.processed = true` para o evento.

### 6.3 Recusa pelo painel
1. Repita 6.1 e **recuse** no painel.
2. **Esperado:** "😕 Infelizmente não conseguimos confirmar..." + opção de menu/atendente.

### 6.4 Cancelamento
1. Cancele um agendamento confirmado no painel.
2. **Esperado:** "❌ Seu agendamento ... foi cancelado."

### 6.5 Atendimento finalizado
1. Marque o agendamento como concluído no painel.
2. **Esperado:** "🐾 *Atendimento finalizado!* ... Obrigado pela confiança! 💙"

### 6.6 Falha na criação
- Pré-condição: derrube a Edge Function `appointments` ou envie horário que ficou
  indisponível entre a consulta e a confirmação.
- **Esperado:** "😕 Não consegui concluir..." — **nunca** mensagem de sucesso.
- **Verificar:** nenhum registro criado em `appointments`.

---

## 7. Status e contexto

### 7.1 Handoff humano
1. Menu → `3` (Falar com atendente).
2. Envie qualquer mensagem → **Esperado:** silêncio do bot (execução com
   `mode = none` no n8n).
3. Envie `menu` → **Esperado:** bot volta a responder.

### 7.2 Comando cancelar no meio do fluxo
1. Inicie agendamento, na escolha de serviço envie `cancelar`.
2. **Esperado:** "Tudo bem, cancelei. 🙂" + menu; estado volta a `MENU`
   **mantendo** `unit_id` (não pergunta a loja de novo).

### 7.3 Webhook duplicado (idempotência)
1. No n8n, pegue o `raw` de uma execução do webhook e **reexecute** a mesma
   execução (ou reenvie o mesmo payload via curl com o mesmo `key.id`).
2. **Esperado:** segunda execução termina em `mode = none` — nenhuma mensagem
   duplicada no WhatsApp, nenhuma operação em dobro.

### 7.4 Cliente sem conversa ativa recebe evento
- Pré-condição: evento de confirmação para cliente que nunca falou com o bot.
- **Esperado:** mensagem enviada normalmente (eventos não dependem de contexto;
  usam `payload.customer.phone`).

---

## 8. Lembretes

### 8.1 Lembrete 24h
- Pré-condição: agendamento `CONFIRMED` começando entre 20h e 26h a partir de agora.
- **Esperado:** em até 1 min, "⏰ *Lembrete:* amanhã é dia de ..." e
  `appointments.reminder_sent = true`.
- Aguarde mais 2 min → **Esperado:** **não** reenvia (controle de duplicidade).

### 8.2 Lembrete 2h
- Pré-condição: agendamento `CONFIRMED` começando entre agora e 2h10.
- **Esperado:** "🔔 *Daqui a pouco!* ..." e `reminder_2h_sent = true`. Sem reenvio.

### 8.3 Agendamento cancelado / não confirmado
- **Esperado:** nenhum lembrete para `PENDING`, `CANCELLED` ou `REJECTED`
  (a query filtra `status = CONFIRMED` no item e no agendamento).

### 8.4 Fora da janela
- Agendamento daqui a 3 dias → **Esperado:** nenhum lembrete (janela 20h–26h e 0–2h10).

---

## 9. Falhas

### 9.1 Supabase indisponível
- Pré-condição: aponte `SUPABASE_URL` para um host inválido e reinicie o container.
- Envie mensagem → **Esperado:** "😅 Tive um probleminha técnico. Pode tentar de novo?"
  (modo `fixed`) — nunca afirma sucesso.

### 9.2 Evolution API indisponível
- Pré-condição: URL da Evolution errada só no nó de envio.
- **Esperado:** execução com erro no nó **05/06 · Enviar WhatsApp**; a máquina de
  estados completou antes (erro visível em Executions, sem falso sucesso ao cliente).

### 9.3 Payload inválido
1. `curl -X POST https://SUA-URL/webhook/whatsapp-inbound -d '{}'`
2. **Esperado:** execução limpa, nó *Extrair mensagem* retorna vazio, nada enviado.

### 9.4 Mensagem de grupo / status / próprio número
- Envie mensagem em grupo onde o número conectado participa, ou do próprio número.
- **Esperado:** ignorado no *Extrair mensagem* (`@g.us`, `fromMe`, broadcast).

---

## 10. Checklist final de regressão

- [ ] Um único workflow ativo (04-evolution-bot)
- [ ] Cadastro completo grava `customers` + `pets` com `unit_id` correto
- [ ] Multi-loja: seleção, persistência, troca explícita e isolamento por `store_id`
- [ ] IA nunca informa preço/horário/disponibilidade sem vir do sistema
- [ ] Nenhuma mensagem diz "confirmado" antes do evento `APPOINTMENT_CONFIRMED`
- [ ] Lembretes 24h/2h sem duplicidade e só para `CONFIRMED`
- [ ] Webhook duplicado não reprocessa (`last_msg_id`)
- [ ] Falhas geram mensagem de erro honesta, nunca falso sucesso
