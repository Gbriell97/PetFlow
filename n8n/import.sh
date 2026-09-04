#!/usr/bin/env bash
# Importa os workflows do PetFlow para o n8n via API REST.
# Uso: N8N_API_KEY=sua-chave ./import.sh
# Gere a chave em: n8n -> Settings -> n8n API -> Create API Key

set -euo pipefail

N8N_URL="${N8N_URL:-http://localhost:5678}"
N8N_API_KEY="${N8N_API_KEY:?Defina N8N_API_KEY (Settings -> n8n API)}"

cd "$(dirname "$0")"

for f in workflows/*.json; do
  echo "Importando $f ..."
  curl -sS -X POST "$N8N_URL/api/v1/workflows" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    --data-binary "@$f" | python -c "import json,sys; d=json.load(sys.stdin); print('  OK ->', d.get('name'), '(id:', str(d.get('id')) + ')')"
done

echo
echo "Pronto. Ative os workflows na interface: $N8N_URL"
