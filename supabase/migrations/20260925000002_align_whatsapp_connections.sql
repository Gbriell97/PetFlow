-- ============================================================
-- PetFlow — Alinha whatsapp_connections (legado Meta + novo AvisaAPI)
-- A tabela já existia com estrutura da Meta (phone_number NOT NULL,
-- waba_id, status enum...). O código PetFlow novo grava em `phone`
-- (AvisaAPI). Esta migration:
--   1. relaxa phone_number (não é mais obrigatório)
--   2. sincroniza phone <-> phone_number (trigger)
-- ============================================================

-- 1. phone_number deixa de ser obrigatório (campo legado Meta)
alter table public.whatsapp_connections
  alter column phone_number drop not null;

-- 2. backfill: preenche phone a partir de phone_number existente
update public.whatsapp_connections
set phone = regexp_replace(phone_number, '\D', '', 'g')
where phone is null and phone_number is not null;

-- 3. trigger de sincronismo: phone (novo) <-> phone_number (legado)
create or replace function public.sync_whatsapp_connection_phone()
returns trigger language plpgsql as $$
begin
  -- normaliza phone para só dígitos
  if new.phone is not null then
    new.phone = regexp_replace(new.phone, '\D', '', 'g');
  end if;
  -- mantém phone_number (legado) preenchido
  if new.phone_number is null and new.phone is not null then
    new.phone_number = new.phone;
  elsif new.phone is null and new.phone_number is not null then
    new.phone = regexp_replace(new.phone_number, '\D', '', 'g');
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_wa_connection_phone on public.whatsapp_connections;
create trigger trg_sync_wa_connection_phone
  before insert or update on public.whatsapp_connections
  for each row execute function public.sync_whatsapp_connection_phone();
