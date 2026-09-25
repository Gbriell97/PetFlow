-- ============================================================
-- PetFlow — Multi-loja: conexões WhatsApp (Decisão 10)
-- Liga o número conectado na AvisaAPI à unidade (loja).
-- O chat-handler resolve a unidade por essa tabela e passa a
-- usar a api_key da loja correta em todas as chamadas.
-- Aplicar via: SQL Editor do Supabase ou `supabase.exe db push`
-- ============================================================

create table if not exists public.whatsapp_connections (
  id            uuid primary key default gen_random_uuid(),
  unit_id       uuid not null references public.units(id) on delete cascade,
  phone         text not null,               -- número conectado na AvisaAPI (só dígitos, com DDI, ex.: 5571988888888)
  instance_name text,                        -- nome da instância no painel da AvisaAPI (caso o webhook envie o nome em vez do número)
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Se a tabela já existia (ex.: testes anteriores), garante a estrutura completa
alter table public.whatsapp_connections
  add column if not exists unit_id uuid,
  add column if not exists phone text,
  add column if not exists instance_name text,
  add column if not exists active boolean not null default true,
  add column if not exists notes text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- FK: só adiciona se ainda não existir
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_connections_unit_id_fkey') then
    alter table public.whatsapp_connections
      add constraint whatsapp_connections_unit_id_fkey
      foreign key (unit_id) references public.units(id) on delete cascade;
  end if;
end $$;

-- Um mesmo número só pode apontar para uma unidade
create unique index if not exists whatsapp_connections_phone_key
  on public.whatsapp_connections (phone);

create index if not exists whatsapp_connections_unit_idx
  on public.whatsapp_connections (unit_id);

-- Atualiza updated_at automaticamente
create or replace function public.touch_whatsapp_connections()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_whatsapp_connections on public.whatsapp_connections;
create trigger trg_touch_whatsapp_connections
  before update on public.whatsapp_connections
  for each row execute function public.touch_whatsapp_connections();

-- ------------------------------------------------------------
-- Seed opcional (descomente se quiser já vincular a loja atual
-- pelo telefone cadastrado em units):
--
-- insert into public.whatsapp_connections (unit_id, phone)
--   select id, regexp_replace(phone, '\D', '', 'g')
--   from public.units
--   where phone is not null
--     and api_key = '3bb9f0d2-6e9e-4bb0-bed4-2bd88894adb3'
--   on conflict (phone) do nothing;
-- ------------------------------------------------------------
