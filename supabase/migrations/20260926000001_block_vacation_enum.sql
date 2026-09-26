-- PetFlow — Adiciona VACATION ao enum de tipos de bloqueio
-- (o painel da loja oferece "Férias" como opção de bloqueio)
alter type public.blocked_period_type add value if not exists 'VACATION';
