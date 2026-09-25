// Nó 1 — Extrai telefone/texto do payload da Evolution v2; ignora o que não for mensagem de cliente
const out = [];
for (const item of $input.all()) {
  const body = item.json.body || item.json;
  if (body.event !== 'messages.upsert') continue;
  const d = body.data || {};
  const key = d.key || {};
  if (key.fromMe) continue;
  const jid = key.remoteJid || '';
  if (!jid.endsWith('@s.whatsapp.net')) continue; // ignora grupos/status/broadcast
  const msg = d.message || {};
  const text = (msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || '').trim();
  if (!text) continue;
  out.push({ json: { phone: jid.replace('@s.whatsapp.net', ''), text, pushName: d.pushName || '' } });
}
return out;
