-- ============================================================
-- PetFlow — Multi-loja N:N: um número atende várias unidades
-- Quando o número tem mais de uma unidade vinculada, o cliente
-- escolhe qual quer falar antes do atendimento (chat-handler).
--   1. remove o unique de whatsapp_connections.phone
--   2. adiciona chat_sessions.unit_id (guarda a escolha da unidade)
-- ============================================================

-- 1. um número pode atender mais de uma unidade
drop index if exists public.whatsapp_connections_phone_key;
create index if not exists whatsapp_connections_phone_idx
  on public.whatsapp_connections (phone);

-- 2. escolha de unidade fica registrada na sessão de seleção
alter table public.chat_sessions
  add column if not exists unit_id uuid;
