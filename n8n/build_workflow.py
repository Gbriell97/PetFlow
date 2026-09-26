# Monta o workflow único PetFlow WhatsApp Bot (Evolution) e salva o JSON
import json, pathlib

SRC = pathlib.Path(__file__).parent / 'src'
extract = (SRC / 'extract.js').read_text(encoding='utf-8')
statemachine = (SRC / 'statemachine.js').read_text(encoding='utf-8')
events = (SRC / 'events.js').read_text(encoding='utf-8')

SYS_POLISH = ("Voce e a Luna, atendente virtual do pet shop {{ $('02 · Máquina de estados').item.json.unitName || 'pet shop' }}. "
              "Reescreva a mensagem do sistema abaixo de forma natural, calorosa e profissional, em portugues brasileiro. "
              "REGRAS: mantenha TODOS os numeros de opcoes, datas, horarios, precos e formatacao *negrito* do WhatsApp exatamente iguais. "
              "Nao adicione informacoes novas. Use emojis com moderacao. Responda APENAS a mensagem final.")
SYS_FALLBACK = ("Voce e a Luna, atendente virtual simpatica do pet shop {{ $json.unitName || 'pet shop' }}. "
                "Responda a pergunta do cliente de forma breve, calorosa e profissional, em portugues brasileiro. "
                "Se a pergunta for sobre agendamento, precos ou horarios, explique que pelo menu numerado e mais rapido e convide a digitar *menu*. "
                "Se nao souber algo, diga que um atendente pode ajudar e sugira digitar *3*. Nao invente precos nem horarios.")

nodes = [
    {
        "parameters": {"httpMethod": "POST", "path": "whatsapp-inbound", "responseMode": "onReceived", "options": {}},
        "id": "n-webhook", "name": "01 · Webhook Evolution",
        "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [-1200, 300]
    },
    {
        "parameters": {"jsCode": extract},
        "id": "n-extract", "name": "02 · Extrair mensagem",
        "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [-980, 300]
    },
    {
        "parameters": {"jsCode": statemachine},
        "id": "n-state", "name": "02 · Máquina de estados",
        "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [-760, 300]
    },
    {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [{
                    "id": "c1", "leftValue": "={{ $json.mode }}", "rightValue": "none",
                    "operator": {"type": "string", "operation": "notEquals"}
                }],
                "combinator": "and"
            }, "options": {}
        },
        "id": "n-if1", "name": "03 · Tem resposta?",
        "type": "n8n-nodes-base.if", "typeVersion": 2, "position": [-540, 300]
    },
    {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [{
                    "id": "c1", "leftValue": "={{ $json.mode }}", "rightValue": "fixed",
                    "operator": {"type": "string", "operation": "equals"}
                }],
                "combinator": "and"
            }, "options": {}
        },
        "id": "n-if2", "name": "04 · Texto pronto?",
        "type": "n8n-nodes-base.if", "typeVersion": 2, "position": [-320, 300]
    },
    {
        "parameters": {
            "method": "POST",
            "url": "=http://evolution_api:8080/message/sendText/{{ $env.EVOLUTION_INSTANCE }}",
            "sendHeaders": True,
            "headerParameters": {"parameters": [{"name": "apikey", "value": "={{ $env.EVOLUTION_API_KEY }}"}]},
            "sendBody": True, "specifyBody": "json",
            "jsonBody": '={"number": "{{ $json.phone }}", "text": {{ JSON.stringify($json.reply) }}}',
            "options": {}
        },
        "id": "n-send1", "name": "05 · Enviar WhatsApp",
        "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [-80, 200]
    },
    {
        "parameters": {
            "promptType": "define",
            "text": "={{ $json.mode === 'fallback' ? ('Cliente: ' + $json.userText) : ('Mensagem do sistema:\\n' + $json.reply) }}",
            "options": {"systemMessage": "={{ $json.systemPrompt }}"}
        },
        "id": "n-agent", "name": "05 · IA Luna (Gemini)",
        "type": "@n8n/n8n-nodes-langchain.agent", "typeVersion": 1.8, "position": [-80, 420]
    },
    {
        "parameters": {
            "sessionIdType": "customKey",
            "sessionKey": "={{ $('02 · Máquina de estados').item.json.phone }}",
            "contextWindowLength": 10
        },
        "id": "n-memory", "name": "Memória da conversa",
        "type": "@n8n/n8n-nodes-langchain.memoryBufferWindow", "typeVersion": 1.3, "position": [140, 620]
    },
    {
        "parameters": {"modelName": "models/gemini-3.5-flash-lite", "options": {}},
        "id": "n-gemini", "name": "Google Gemini Chat Model",
        "type": "@n8n/n8n-nodes-langchain.lmChatGoogleGemini", "typeVersion": 1, "position": [-80, 620]
    },
    {
        "parameters": {
            "method": "POST",
            "url": "=http://evolution_api:8080/message/sendText/{{ $env.EVOLUTION_INSTANCE }}",
            "sendHeaders": True,
            "headerParameters": {"parameters": [{"name": "apikey", "value": "={{ $env.EVOLUTION_API_KEY }}"}]},
            "sendBody": True, "specifyBody": "json",
            "jsonBody": '={"number": "{{ $(\'02 · Máquina de estados\').item.json.phone }}", "text": {{ JSON.stringify($json.output) }}}',
            "options": {}
        },
        "id": "n-send2", "name": "06 · Enviar WhatsApp (IA)",
        "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [180, 420]
    },
    {
        "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}},
        "id": "n-schedule", "name": "10 · A cada 1 minuto",
        "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2, "position": [-1200, 720]
    },
    {
        "parameters": {"jsCode": events},
        "id": "n-events", "name": "11 · Eventos + Lembretes",
        "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [-980, 720]
    },
]

workflow = {
    "name": "PetFlow · WhatsApp Bot (Evolution)",
    "nodes": nodes,
    "connections": {
        "01 · Webhook Evolution": {"main": [[{"node": "02 · Extrair mensagem", "type": "main", "index": 0}]]},
        "02 · Extrair mensagem": {"main": [[{"node": "02 · Máquina de estados", "type": "main", "index": 0}]]},
        "02 · Máquina de estados": {"main": [[{"node": "03 · Tem resposta?", "type": "main", "index": 0}]]},
        "03 · Tem resposta?": {"main": [[{"node": "04 · Texto pronto?", "type": "main", "index": 0}]]},
        "04 · Texto pronto?": {"main": [
            [{"node": "05 · Enviar WhatsApp", "type": "main", "index": 0}],
            [{"node": "05 · IA Luna (Gemini)", "type": "main", "index": 0}]
        ]},
        "05 · IA Luna (Gemini)": {"main": [[{"node": "06 · Enviar WhatsApp (IA)", "type": "main", "index": 0}]]},
        "Google Gemini Chat Model": {"ai_languageModel": [[{"node": "05 · IA Luna (Gemini)", "type": "ai_languageModel", "index": 0}]]},
        "Memória da conversa": {"ai_memory": [[{"node": "05 · IA Luna (Gemini)", "type": "ai_memory", "index": 0}]]},
        "10 · A cada 1 minuto": {"main": [[{"node": "11 · Eventos + Lembretes", "type": "main", "index": 0}]]},
    },
    "settings": {"executionOrder": "v1"},
    "staticData": None,
    "pinData": {},
}

out = pathlib.Path(__file__).parent / 'workflows' / '04-evolution-bot.json'
out.write_text(json.dumps(workflow, ensure_ascii=False, indent=2), encoding='utf-8')
print('OK ->', out, len(json.dumps(workflow)), 'bytes')
