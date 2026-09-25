-- ============================================================
-- PetFlow — Multi-loja N:N (parte 2): remover unique legado de unit_id
-- A tabela legada tinha unique(unit_id) — 1 número por unidade nas duas
-- direções. Com N:N, uma unidade pode ter vários números e um número
-- atende várias unidades.
-- ============================================================

alter table public.whatsapp_connections
  drop constraint if exists whatsapp_connections_unit_id_key;
