// Nó 2 — Máquina de estados da conversa (fluxo determinístico, sem IA)
// Entrada: { phone, text, pushName, instance, storePhone, messageId }
// Saída:  { phone, reply, mode, userText, systemPrompt, unitName }
// mode: 'none' (silêncio) | 'fixed' (envia direto) | 'polish' (IA humaniza) | 'fallback' (IA responde livre)
//
// MULTI-LOJA N:N: a loja é resolvida pela conexão que recebeu a mensagem
// (storePhone/instance → whatsapp_connections → units). Lógica reutilizada
// do chat-handler: telefone com/sem DDI → instance_name → units.phone →
// fallback unidade padrão (PETFLOW_API_KEY).
//   - 1 loja  → seleciona automaticamente e salva store_id no contexto
//   - N lojas → menu numerado; escolha validada e salva no contexto
//   - contexto com store_id válido → reutiliza, não pergunta de novo
//   - troca de loja: somente comando explícito ("trocar loja")

const SUPA = $env.SUPABASE_URL;
const SKEY = $env.SUPABASE_SERVICE_KEY;
const APIKEY = $env.PETFLOW_API_KEY; // fallback: unidade padrão
const helpers = this.helpers;
const H = { apikey: SKEY, Authorization: 'Bearer ' + SKEY, 'Content-Type': 'application/json' };

async function req(method, path, body, extraHeaders) {
  const opt = { method, url: SUPA + path, headers: Object.assign({}, H, extraHeaders || {}), json: true };
  if (body !== undefined) opt.body = body;
  return await helpers.httpRequest(opt);
}

const digits = s => String(s || '').replace(/\D/g, '');
const SIZE_LABEL = { SMALL: 'Pequeno', MEDIUM: 'Médio', LARGE: 'Grande' };
const SPECIES_LABEL = { dog: 'Cachorro', cat: 'Gato' };

function cap(s) { return (s || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function fmtDate(iso, tz) {
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' });
}
function fmtTime(iso, tz) {
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}
function menuText(unit, name) {
  return '🐾 *' + unit.name + '*\n\n' + (name ? 'Olá, *' + name.split(' ')[0] + '*! ' : 'Olá! ') +
    'O que você deseja?\n\n1️⃣ Agendar serviço\n2️⃣ Meus agendamentos\n3️⃣ Falar com atendente\n\nDigite o número da opção.';
}

// ============ RESOLUÇÃO DE LOJAS (multi-loja N:N) ============
// Reutiliza a estratégia do chat-handler. Retorna a LISTA de lojas atendidas
// pela conexão que recebeu a mensagem.
async function resolveUnits(storePhone, instance) {
  const storeDigits = digits(storePhone);
  const inst = (instance || '').trim();
  const unitIds = new Set();

  // 1. whatsapp_connections ativas por número (variações com/sem DDI 55)
  if (storeDigits) {
    const variants = [storeDigits];
    if (storeDigits.startsWith('55') && storeDigits.length > 11) variants.push(storeDigits.slice(2));
    else variants.push('55' + storeDigits);
    try {
      const rows = await req('GET', '/rest/v1/whatsapp_connections?active=eq.true&phone=in.(' + variants.join(',') + ')&select=unit_id');
      for (const r of rows || []) if (r.unit_id) unitIds.add(r.unit_id);
    } catch (e) { console.log('resolve por telefone falhou: ' + (e.message || e)); }
  }

  // 2. whatsapp_connections por instance_name
  if (unitIds.size === 0 && inst) {
    try {
      const rows = await req('GET', '/rest/v1/whatsapp_connections?active=eq.true&instance_name=eq.' + encodeURIComponent(inst) + '&select=unit_id');
      for (const r of rows || []) if (r.unit_id) unitIds.add(r.unit_id);
    } catch (e) { console.log('resolve por instância falhou: ' + (e.message || e)); }
  }

  // 2b. Auto-registro: se a instância que recebeu a mensagem ainda não está
  // gravada em nenhuma conexão, preenche instance_name automaticamente.
  // TRAVA DE SEGURANÇA: só auto-registra quando TODAS as conexões ativas sem
  // instance_name pertencem ao mesmo número (evita misturar conexões distintas).
  if (unitIds.size === 0 && inst) {
    try {
      const pend = await req('GET', '/rest/v1/whatsapp_connections?active=eq.true&instance_name=is.null&select=id,phone,unit_id');
      const phones = new Set((pend || []).map(r => r.phone));
      if (pend && pend.length > 0 && phones.size === 1) {
        await req('PATCH', '/rest/v1/whatsapp_connections?instance_name=is.null', { instance_name: inst });
        for (const r of pend) if (r.unit_id) unitIds.add(r.unit_id);
        console.log('instance_name auto-registrado como "' + inst + '" em ' + pend.length + ' conexão(ões)');
      }
    } catch (e) { console.log('auto-registro de instância falhou: ' + (e.message || e)); }
  }

  // 3. telefone cadastrado direto na unidade
  if (unitIds.size === 0 && storeDigits) {
    const variants = [storeDigits];
    if (storeDigits.startsWith('55') && storeDigits.length > 11) variants.push(storeDigits.slice(2));
    else variants.push('55' + storeDigits);
    try {
      const rows = await req('GET', '/rest/v1/units?is_deleted=eq.false&phone=in.(' + variants.join(',') + ')&select=id');
      for (const r of rows || []) if (r.id) unitIds.add(r.id);
    } catch (e) { console.log('resolve por units.phone falhou: ' + (e.message || e)); }
  }

  if (unitIds.size > 0) {
    const units = await req('GET', '/rest/v1/units?id=in.(' + [...unitIds].join(',') + ')&is_deleted=eq.false&select=id,name,timezone,api_key,city&order=name.asc');
    if (Array.isArray(units) && units.length > 0) return units;
  }

  // 4. fallback: unidade padrão (compatibilidade com comportamento anterior)
  const def = await req('GET', '/rest/v1/units?api_key=eq.' + APIKEY + '&is_deleted=eq.false&select=id,name,timezone,api_key,city');
  return def && def[0] ? [def[0]] : [];
}

function storeMenuText(units) {
  return 'Olá! 😊\n\nEncontrei mais de uma loja vinculada a este número.\n\nQual loja você deseja acessar?\n' +
    units.map((u, i) => '\n' + (i + 1) + '️⃣ ' + u.name + (u.city ? ' — ' + u.city : '')).join('');
}

const results = [];

for (const item of $input.all()) {
  const { phone, text, pushName, instance, storePhone, messageId } = item.json;
  const lower = text.toLowerCase().trim();
  let reply = null, mode = 'polish';

  // Função local para persistir o contexto da conversa (contexto central)
  async function saveState(st, unit) {
    await req('POST', '/rest/v1/conversation_state',
      { phone, unit_id: unit ? unit.id : (st.data.unit_id || null), state: st.state, data: st.data, handoff: st.handoff, updated_at: new Date().toISOString() },
      { Prefer: 'resolution=merge-duplicates' });
  }

  try {
    // --- Contexto da conversa (carrega antes de tudo: idempotência + store_id) ---
    const stArr = await req('GET', '/rest/v1/conversation_state?phone=eq.' + encodeURIComponent(phone) + '&select=*');
    let st = stArr[0] || { phone, state: 'MENU', data: {}, handoff: false };
    st.data = st.data || {};

    // --- Idempotência: mesmo webhook entregue 2x não processa de novo ---
    if (messageId && st.data.last_msg_id === messageId) {
      results.push({ json: { phone, reply: null, mode: 'none' } });
      continue;
    }
    if (messageId) st.data.last_msg_id = messageId;

    // --- Resolver lojas vinculadas à conexão que recebeu a mensagem ---
    const units = await resolveUnits(storePhone, instance);
    if (!units.length) { results.push({ json: { phone, reply: 'Loja não configurada.', mode: 'fixed' } }); continue; }

    // --- Seleção de loja (regra de múltiplas lojas) ---
    let unit = null;
    if (units.length === 1) {
      unit = units[0];
      st.data.unit_id = unit.id; // 1 loja: seleciona automaticamente
    } else {
      // Troca de loja somente por solicitação explícita do cliente
      if (lower === 'trocar loja' || lower === 'trocar de loja' || lower === 'mudar loja') {
        st.data.unit_id = null;
        st.state = 'SELECT_STORE';
        st.data.units = units.map(u => ({ id: u.id, name: u.name, city: u.city }));
        reply = 'Sem problema! 😊\n\nQual loja você deseja acessar?\n' +
          st.data.units.map((u, i) => '\n' + (i + 1) + '️⃣ ' + u.name + (u.city ? ' — ' + u.city : '')).join('');
        await saveState(st, null);
        results.push({ json: { phone, reply, mode: 'polish', userText: text, unitName: '' } });
        continue;
      }

      // Contexto já tem store_id válido? Reutiliza sem perguntar de novo.
      if (st.data.unit_id) unit = units.find(u => u.id === st.data.unit_id) || null;

      if (!unit && st.state !== 'SELECT_STORE') {
        st.state = 'SELECT_STORE';
        st.data.units = units.map(u => ({ id: u.id, name: u.name, city: u.city }));
        await saveState(st, null);
        results.push({ json: { phone, reply: storeMenuText(st.data.units), mode: 'polish', userText: text, unitName: '' } });
        continue;
      }

      if (!unit && st.state === 'SELECT_STORE') {
        // Cliente está escolhendo a loja: aceita número ou nome exato
        const list = st.data.units || [];
        let idx = /^\d{1,2}$/.test(lower) ? parseInt(lower, 10) - 1 : -1;
        if (idx < 0) idx = list.findIndex(u => (u.name || '').toLowerCase() === lower);
        if (idx >= 0 && idx < list.length) {
          unit = units.find(u => u.id === list[idx].id) || null;
          if (unit) {
            st.data.unit_id = unit.id; // salva store_id no contexto
            st.state = 'MENU'; st.data.units = undefined;
            reply = 'Perfeito! Você está falando com *' + unit.name + '*. 🐾\n\n' + menuText(unit, null);
            await saveState(st, unit);
            results.push({ json: { phone, reply, mode: 'polish', userText: text, unitName: unit.name } });
            continue;
          }
        }
        // Escolha inválida → valida e pergunta de novo
        await saveState(st, null);
        results.push({ json: { phone, reply: 'Não entendi a opção. 🤔\n\n' + storeMenuText(list), mode: 'polish', userText: text, unitName: '' } });
        continue;
      }
    }

    const tz = unit.timezone || 'America/Sao_Paulo';
    const unitKey = unit.api_key || APIKEY;

    // --- Cliente + pets (isolado pela loja selecionada) ---
    const custArr = await req('GET', '/rest/v1/customers?unit_id=eq.' + unit.id +
      '&phone=ilike.*' + phone.slice(-8) + '*&is_deleted=eq.false&select=id,name,phone,pets(id,name,species,size,active,is_deleted)&limit=1');
    let customer = custArr[0] || null;
    const activePets = () => (customer && customer.pets || []).filter(p => p.active && !p.is_deleted);

    // --- Comandos globais ---
    if (['menu', 'inicio', 'início', 'voltar', 'oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite'].includes(lower)) {
      st.state = 'MENU'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id }; st.handoff = false;
      // Cliente já cadastrado recebe o menu determinístico; novo cliente cai no cadastro abaixo
      if (customer) reply = menuText(unit, customer.name);
    } else if (lower === 'cancelar') {
      st.state = 'MENU'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
      reply = 'Tudo bem, cancelei. 🙂\n\n' + menuText(unit, customer && customer.name);
    }

    // --- Humano atendendo: bot fica mudo até cliente digitar "menu" ---
    if (reply === null && st.handoff) {
      results.push({ json: { phone, reply: null, mode: 'none' } });
      await saveState(st, unit);
      continue;
    }

    // ================= ESTADOS =================
    if (reply === null) {
      const S = st.state;

      // ---- Novo cliente: cadastro ----
      if (!customer && S !== 'ASK_NAME' && S !== 'ASK_PET_NAME' && S !== 'ASK_PET_SPECIES' && S !== 'ASK_PET_SIZE') {
        st.state = 'ASK_NAME'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
        reply = 'Olá' + (pushName ? ' *' + pushName + '*' : '') + '! 👋 Bem-vindo(a) ao *' + unit.name + '*!\n\nVi que é sua primeira vez por aqui. Vamos fazer um cadastro rapidinho.\n\nQual é o seu *nome completo*?';
      }
      else if (S === 'ASK_NAME') {
        const name = cap(text);
        const created = await req('POST', '/rest/v1/customers', { unit_id: unit.id, name, phone, source: 'whatsapp' }, { Prefer: 'return=representation' });
        customer = created[0];
        customer.pets = [];
        st.state = 'ASK_PET_NAME'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
        reply = 'Prazer, *' + name.split(' ')[0] + '*! ✅\n\nAgora me conta: qual o *nome do seu pet*?';
      }
      else if (S === 'ASK_PET_NAME') {
        st.data.pet_name = cap(text);
        st.state = 'ASK_PET_SPECIES';
        reply = 'Que nome fofo! 🐶🐱\n\n*' + st.data.pet_name + '* é:\n\n1️⃣ Cachorro\n2️⃣ Gato';
      }
      else if (S === 'ASK_PET_SPECIES') {
        const sp = lower === '1' ? 'dog' : lower === '2' ? 'cat' : null;
        if (!sp) reply = 'Digite *1* para Cachorro ou *2* para Gato.';
        else {
          st.data.species = sp;
          st.state = 'ASK_PET_SIZE';
          reply = 'E qual o *porte* de ' + st.data.pet_name + '?\n\n1️⃣ Pequeno (até 10kg)\n2️⃣ Médio (10 a 25kg)\n3️⃣ Grande (acima de 25kg)';
        }
      }
      else if (S === 'ASK_PET_SIZE') {
        const size = lower === '1' ? 'SMALL' : lower === '2' ? 'MEDIUM' : lower === '3' ? 'LARGE' : null;
        if (!size) reply = 'Digite *1* (Pequeno), *2* (Médio) ou *3* (Grande).';
        else {
          await req('POST', '/rest/v1/pets', { unit_id: unit.id, customer_id: customer.id, name: st.data.pet_name, species: st.data.species, size, active: true }, { Prefer: 'return=minimal' });
          st.state = 'MENU'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
          reply = 'Cadastro concluído! 🎉\n\n' + menuText(unit, customer.name);
        }
      }

      // ---- MENU ----
      else if (S === 'MENU') {
        if (lower === '1') {
          const pets = activePets();
          if (pets.length === 0) {
            st.state = 'ASK_PET_NAME'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
            reply = 'Você ainda não tem pet cadastrado. Qual o *nome do seu pet*?';
          } else if (pets.length === 1) {
            st.data.pet_id = pets[0].id; st.data.pet_name = pets[0].name; st.data.pet_size = pets[0].size;
            st.state = 'BOOK_SERVICE';
            const svc = await req('GET', '/rest/v1/services?unit_id=eq.' + unit.id + '&active=eq.true&booking_enabled=eq.true&is_deleted=eq.false&order=name.asc&select=id,name,prices:service_price_rules(criteria,price,active)');
            const list = svc.map(s => ({ id: s.id, name: s.name, price: priceFor(s, pets[0].size) }));
            st.data.services = list;
            reply = 'Vamos agendar para *' + pets[0].name + '*! 🛁\n\nEscolha o serviço:\n' +
              list.map((s, i) => '\n' + (i + 1) + '️⃣ ' + s.name + (s.price ? ' — R$ ' + s.price.toFixed(2) : '')).join('');
          } else {
            st.state = 'BOOK_PET';
            st.data.pets = pets.map(p => ({ id: p.id, name: p.name, size: p.size }));
            reply = 'Para qual pet é o agendamento?\n' + pets.map((p, i) => '\n' + (i + 1) + '️⃣ ' + p.name + ' (' + (SPECIES_LABEL[p.species] || p.species) + ' ' + (SIZE_LABEL[p.size] || '') + ')').join('');
          }
        } else if (lower === '2') {
          const appts = await req('GET', '/rest/v1/appointments?customer_id=eq.' + customer.id +
            '&unit_id=eq.' + unit.id +
            '&status=in.(PENDING,CONFIRMED)&is_deleted=eq.false&order=created_at.desc&limit=5' +
            '&select=id,status,total_price,items:appointment_items(start_time,service:services(name),pet:pets(name))');
          if (!appts.length) reply = 'Você não tem agendamentos ativos no momento. 📭\n\n' + menuText(unit, customer.name);
          else {
            const lines = appts.map(a => {
              const it = (a.items || [])[0] || {};
              const st2 = a.status === 'PENDING' ? '⏳ aguardando confirmação' : '✅ confirmado';
              return '• *' + ((it.service || {}).name || 'Serviço') + '* p/ *' + ((it.pet || {}).name || 'pet') + '* — ' +
                (it.start_time ? fmtDate(it.start_time, tz) + ' às ' + fmtTime(it.start_time, tz) : '') + ' — ' + st2;
            });
            reply = '📋 *Seus agendamentos:*\n\n' + lines.join('\n') + '\n\nDigite *menu* para voltar.';
          }
        } else if (lower === '3') {
          st.handoff = true;
          reply = 'Certo! Já chamei um atendente humano. 👤\n\nEnquanto isso, o robozinho fica quietinho. Quando quiser voltar ao menu, digite *menu*.';
        } else if (/^\d+$/.test(lower)) {
          reply = 'Opção inválida. 🤔\n\n' + menuText(unit, customer.name);
        } else {
          mode = 'fallback'; // IA responde pergunta livre
        }
      }

      // ---- Escolher pet ----
      else if (S === 'BOOK_PET') {
        const n = parseInt(lower, 10);
        const pets = st.data.pets || [];
        if (!n || n < 1 || n > pets.length) reply = 'Digite o número do pet (1 a ' + pets.length + ') ou *cancelar*.';
        else {
          const pet = pets[n - 1];
          st.data.pet_id = pet.id; st.data.pet_name = pet.name; st.data.pet_size = pet.size;
          const svc = await req('GET', '/rest/v1/services?unit_id=eq.' + unit.id + '&active=eq.true&booking_enabled=eq.true&is_deleted=eq.false&order=name.asc&select=id,name,prices:service_price_rules(criteria,price,active)');
          const list = svc.map(s => ({ id: s.id, name: s.name, price: priceFor(s, pet.size) }));
          st.data.services = list;
          st.state = 'BOOK_SERVICE';
          reply = 'Serviço para *' + pet.name + '*:\n' + list.map((s, i) => '\n' + (i + 1) + '️⃣ ' + s.name + (s.price ? ' — R$ ' + s.price.toFixed(2) : '')).join('');
        }
      }

      // ---- Escolher serviço ----
      else if (S === 'BOOK_SERVICE') {
        const n = parseInt(lower, 10);
        const list = st.data.services || [];
        if (!n || n < 1 || n > list.length) reply = 'Digite o número do serviço (1 a ' + list.length + ') ou *cancelar*.';
        else {
          const svc = list[n - 1];
          st.data.service_id = svc.id; st.data.service_name = svc.name; st.data.price = svc.price;
          // Consulta a disponibilidade dos próximos 7 dias de uma vez e
          // exibe SOMENTE os dias que têm horário livre
          const startIso = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: tz });
          let all = [];
          try {
            const res = await helpers.httpRequest({
              method: 'POST', url: SUPA + '/functions/v1/available-slots', json: true,
              headers: { Authorization: 'Bearer ' + unitKey, 'Content-Type': 'application/json' },
              body: { unit_id: unit.id, service_ids: [svc.id], pet_ids: [st.data.pet_id], date: startIso, max_days: 7 }
            });
            all = ((res && res.data && res.data.slots) || []).filter(s => s.available);
          } catch (e) { console.log('available-slots falhou: ' + (e.message || e)); }
          if (!all.length) {
            st.state = 'MENU'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
            reply = '😕 Poxa, não encontrei horários livres para *' + svc.name + '* nos próximos 7 dias.\n\nDigite *menu* para voltar ou *3* para falar com um atendente.';
          } else {
            const byDay = {};
            for (const s of all) {
              const dIso = new Date(s.slot_start).toLocaleDateString('sv-SE', { timeZone: tz });
              (byDay[dIso] = byDay[dIso] || []).push(s);
            }
            const days = Object.keys(byDay).sort().map(iso => ({ iso, label: fmtDate(iso + 'T12:00:00Z', tz) }));
            st.data.days = days;
            st.data.slotsByDay = byDay;
            st.state = 'BOOK_DAY';
            reply = 'Ótima escolha! ✨ *' + svc.name + '* para *' + st.data.pet_name + '*' + (svc.price ? ' — R$ ' + svc.price.toFixed(2) : '') +
              '\n\nEscolha o dia (somente dias com horário livre):\n' +
              days.map((d, i) => '\n' + (i + 1) + '️⃣ ' + d.label).join('');
          }
        }
      }

      // ---- Escolher dia → listar horários daquele dia ----
      else if (S === 'BOOK_DAY') {
        const n = parseInt(lower, 10);
        const days = st.data.days || [];
        if (!n || n < 1 || n > days.length) reply = 'Digite o número do dia (1 a ' + days.length + ') ou *cancelar*.';
        else {
          const day = days[n - 1];
          const slots = ((st.data.slotsByDay || {})[day.iso] || []).filter(s => s.available);
          if (!slots.length) {
            reply = '😕 Sem horários livres em *' + day.label + '*. Escolha outro dia:\n' +
              days.map((d, i) => '\n' + (i + 1) + '️⃣ ' + d.label).join('');
          } else {
            const shown = slots.slice(0, 10);
            st.data.slots = shown.map(s => ({ start: s.slot_start, employee_id: s.suggested_employee_id, price: s.total_price, duration: s.total_duration_minutes }));
            st.data.day_label = day.label;
            st.state = 'BOOK_TIME';
            reply = '⏰ Horários disponíveis em *' + day.label + '*:\n' +
              shown.map((s, i) => '\n' + (i + 1) + '️⃣ ' + fmtTime(s.slot_start, tz)).join('') +
              (slots.length > 10 ? '\n\n(mostrando os 10 primeiros)' : '');
          }
        }
      }

      // ---- Escolher horário ----
      else if (S === 'BOOK_TIME') {
        const n = parseInt(lower, 10);
        const slots = st.data.slots || [];
        if (!n || n < 1 || n > slots.length) reply = 'Digite o número do horário (1 a ' + slots.length + ') ou *cancelar*.';
        else {
          st.data.slot = slots[n - 1];
          st.state = 'BOOK_CONFIRM';
          reply = '📋 *Confirme seu agendamento:*\n\n🐾 Pet: *' + st.data.pet_name + '*\n✂️ Serviço: *' + st.data.service_name +
            '*\n📅 Data: *' + st.data.day_label + ' às ' + fmtTime(st.data.slot.start, tz) + '*' +
            '\n💰 Valor: *R$ ' + (st.data.slot.price != null ? st.data.slot.price.toFixed(2) : (st.data.price || 0).toFixed(2)) + '*\n\n1️⃣ Confirmar\n2️⃣ Cancelar';
        }
      }

      // ---- Confirmar ----
      else if (S === 'BOOK_CONFIRM') {
        if (lower === '1') {
          try {
            const res = await helpers.httpRequest({
              method: 'POST', url: SUPA + '/functions/v1/appointments', json: true,
              headers: { Authorization: 'Bearer ' + unitKey, 'Content-Type': 'application/json' },
              body: {
                customer_id: customer.id, service_ids: [st.data.service_id], pet_ids: [st.data.pet_id],
                start_datetime: st.data.slot.start, employee_id: st.data.slot.employee_id || undefined,
                notes: 'Agendado via WhatsApp (bot)'
              }
            });
            if (res && res.success) {
              reply = '🎉 Pedido enviado!\n\n*' + st.data.service_name + '* para *' + st.data.pet_name + '* em *' + st.data.day_label +
                ' às ' + fmtTime(st.data.slot.start, tz) + '*.\n\n⏳ A loja vai confirmar em instantes e você recebe o aviso aqui mesmo.';
            } else {
              reply = '😕 Não consegui concluir: ' + ((res && res.error) || 'erro desconhecido') + '\n\nDigite *menu* para tentar de novo.';
            }
          } catch (e) {
            reply = '😕 Não consegui concluir o agendamento (' + (e.message || 'erro') + ').\n\nDigite *menu* para tentar de novo.';
          }
          st.state = 'MENU'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
        } else if (lower === '2') {
          st.state = 'MENU'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
          reply = 'Agendamento cancelado. 👍\n\n' + menuText(unit, customer.name);
        } else {
          reply = 'Digite *1* para confirmar ou *2* para cancelar.';
        }
      }

      // ---- Estado desconhecido → menu ----
      else {
        st.state = 'MENU'; st.data = { unit_id: st.data.unit_id, last_msg_id: st.data.last_msg_id };
        reply = menuText(unit, customer && customer.name);
      }

      // Se estava no MENU e chegou aqui sem reply (fallback), não muda estado
    }

    // --- Salvar contexto ---
    await saveState(st, unit);

    const sysPolish = 'Voce e a Luna, atendente virtual do pet shop ' + unit.name + '. Reescreva a mensagem do sistema abaixo de forma natural, calorosa e profissional, em portugues brasileiro. REGRAS: mantenha TODOS os numeros de opcoes, datas, horarios, precos e a formatacao *negrito* do WhatsApp exatamente iguais. Nao adicione informacoes novas. Use emojis com moderacao. Responda APENAS a mensagem final.';
    const sysFallback = 'Voce e a Luna, atendente virtual simpatica do pet shop ' + unit.name + '. Responda a pergunta do cliente de forma breve, calorosa e profissional, em portugues brasileiro. Se a pergunta for sobre agendamento, precos ou horarios, convide a digitar *menu*. Se nao souber algo, sugira digitar *3* para falar com um atendente. Nao invente precos, horarios, servicos, funcionarios, disponibilidade, tempo de espera nem dados do cliente ou do pet. Nunca confirme agendamento sem confirmacao explicita do sistema. Se a informacao nao estiver disponivel, nao tente adivinhar.';
    const systemPrompt = mode === 'fallback' ? sysFallback : sysPolish;
    if (mode === 'fallback') {
      results.push({ json: { phone, reply: null, mode, userText: text, systemPrompt, unitName: unit.name } });
    } else {
      results.push({ json: { phone, reply, mode, userText: text, systemPrompt, unitName: unit.name } });
    }
  } catch (e) {
    results.push({ json: { phone, reply: '😅 Tive um probleminha técnico. Pode tentar de novo? Se persistir, digite *3* para falar com um atendente.', mode: 'fixed' } });
  }
}

return results;

// helper de preço por porte
function priceFor(service, size) {
  const rules = (service.prices || []).filter(r => r.active !== false);
  const m = rules.find(r => r.criteria && r.criteria.size === size);
  const r = m || rules[0];
  return r ? parseFloat(r.price) : null;
}
