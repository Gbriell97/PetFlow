// Nó 3 — (Schedule 1 min) Processa eventos do painel + envia lembretes
// Tudo via HTTP; não gera saída para outros nós.

const helpers = this.helpers;
const SUPA = $env.SUPABASE_URL;
const SKEY = $env.SUPABASE_SERVICE_KEY;
const EVO = $env.EVOLUTION_URL;
const EKEY = $env.EVOLUTION_API_KEY;
const INST = $env.EVOLUTION_INSTANCE;
const H = { apikey: SKEY, Authorization: 'Bearer ' + SKEY, 'Content-Type': 'application/json' };

async function sendText(phone, text) {
  try {
    await helpers.httpRequest({
      method: 'POST', url: EVO + '/message/sendText/' + encodeURIComponent(INST), json: true,
      headers: { apikey: EKEY, 'Content-Type': 'application/json' },
      body: { number: phone, text }
    });
    return true;
  } catch (e) { console.log('sendText falhou: ' + (e.message || e)); return false; }
}

const log = [];

// ============ 1. EVENTOS (confirmação/recusa/cancelamento do painel) ============
try {
  const events = await helpers.httpRequest({
    method: 'GET', json: true, headers: H,
    url: SUPA + '/rest/v1/system_events?processed=eq.false&order=created_at.asc&limit=20&select=id,event_type,payload'
  });

  for (const ev of events || []) {
    const p = ev.payload || {};
    const phone = p.customer && p.customer.phone;
    let text = null;
    if (ev.event_type === 'APPOINTMENT_CONFIRMED') {
      text = '✅ *Agendamento confirmado!*\n\n' + (p.service || 'Serviço') + ' para *' + (p.pet || 'seu pet') + '*\n📅 ' +
        (p.date || '') + ' às ' + (p.time || '') + (p.value ? '\n💰 ' + p.value : '') + '\n\nTe esperamos! 🐾';
    } else if (ev.event_type === 'APPOINTMENT_REJECTED') {
      text = '😕 Infelizmente não conseguimos confirmar seu agendamento de *' + (p.service || 'serviço') + '* para *' +
        (p.pet || 'seu pet') + '* em ' + (p.date || '') + ' às ' + (p.time || '') +
        '.\n\nDigite *menu* para escolher outro horário ou *3* para falar com um atendente.';
    } else if (ev.event_type === 'APPOINTMENT_CANCELLED') {
      text = '❌ Seu agendamento de *' + (p.service || 'serviço') + '* para *' + (p.pet || 'seu pet') + '* em ' +
        (p.date || '') + ' às ' + (p.time || '') + ' foi cancelado.\n\nDigite *menu* se quiser reagendar.';
    }
    if (phone && text) {
      const ok = await sendText(phone, text);
      log.push(ev.event_type + ' → ' + phone + ': ' + (ok ? 'enviado' : 'FALHOU'));
    }
    await helpers.httpRequest({
      method: 'PATCH', json: true, headers: H,
      url: SUPA + '/rest/v1/system_events?id=eq.' + ev.id,
      body: { processed: true, processed_at: new Date().toISOString() }
    });
  }
} catch (e) { console.log('eventos erro: ' + (e.message || e)); }

// ============ 2. LEMBRETES (1 dia antes e 2h antes) ============
try {
  const now = Date.now();
  const iso = t => new Date(t).toISOString();
  const items = await helpers.httpRequest({
    method: 'GET', json: true, headers: H,
    url: SUPA + '/rest/v1/appointment_items?status=eq.CONFIRMED' +
      '&start_time=gte.' + encodeURIComponent(iso(now)) +
      '&start_time=lte.' + encodeURIComponent(iso(now + 26 * 3600000)) +
      '&select=id,start_time,appointment_id,pet:pets(name),service:services(name),' +
      'appointment:appointments!inner(id,status,reminder_sent,reminder_2h_sent,unit_timezone,customer:customers(name,phone))' +
      '&appointment.status=eq.CONFIRMED'
  });

  const done = new Set();
  for (const it of items || []) {
    const appt = it.appointment;
    if (!appt || done.has(appt.id)) continue;
    done.add(appt.id);
    const phone = appt.customer && appt.customer.phone;
    if (!phone) continue;
    const tz = appt.unit_timezone || 'America/Sao_Paulo';
    const startMs = new Date(it.start_time).getTime();
    const diffMin = (startMs - now) / 60000;
    const quando = new Date(it.start_time).toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' }) +
      ' às ' + new Date(it.start_time).toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    const desc = ((it.service || {}).name || 'Serviço') + ' p/ *' + ((it.pet || {}).name || 'seu pet') + '*';

    if (!appt.reminder_sent && diffMin > 20 * 60 && diffMin <= 26 * 60) {
      const ok = await sendText(phone, '⏰ *Lembrete:* amanhã é dia de ' + desc + '!\n📅 ' + quando + '\n\nQualquer imprevisto, é só avisar por aqui. 🐾');
      if (ok) await helpers.httpRequest({ method: 'PATCH', json: true, headers: H, url: SUPA + '/rest/v1/appointments?id=eq.' + appt.id, body: { reminder_sent: true, reminder_sent_at: iso(now) } });
      log.push('lembrete24h → ' + phone + ': ' + (ok ? 'enviado' : 'FALHOU'));
    } else if (!appt.reminder_2h_sent && diffMin > 0 && diffMin <= 130) {
      const ok = await sendText(phone, '🔔 *Daqui a pouco!* ' + desc + ' é hoje, ' + quando + '.\n\nAté já! 🐾');
      if (ok) await helpers.httpRequest({ method: 'PATCH', json: true, headers: H, url: SUPA + '/rest/v1/appointments?id=eq.' + appt.id, body: { reminder_2h_sent: true } });
      log.push('lembrete2h → ' + phone + ': ' + (ok ? 'enviado' : 'FALHOU'));
    }
  }
} catch (e) { console.log('lembretes erro: ' + (e.message || e)); }

return [{ json: { ok: true, actions: log } }];
