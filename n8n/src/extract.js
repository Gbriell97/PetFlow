// Nó 1 — Extrai telefone/texto do payload da Evolution v2; ignora o que não for mensagem de cliente
// Também captura: instance (nome da instância que recebeu), storePhone (número da loja, quando presente)
// e messageId (key.id — usado para idempotência no nó da máquina de estados).
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

  // Identifica qual conexão/número da loja recebeu a mensagem (para multi-loja)
  const instance = (body.instance || d.instance || '').trim();
  // Evolution v2 nem sempre envia o número de destino; tenta os campos conhecidos
  const owner = (body.sender || d.sender || body.owner || d.owner || d.destination || '').trim();
  const storePhone = String(owner).replace('@s.whatsapp.net', '').replace(/\D/g, '');

  out.push({
    json: {
      phone: jid.replace('@s.whatsapp.net', ''),
      text,
      pushName: d.pushName || '',
      instance,
      storePhone,
      messageId: key.id || ''
    }
  });
}
return out;
