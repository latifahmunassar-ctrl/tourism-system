-- وضع المعالجة (creative=ذكاء / fast=قوالب سريعة) + تكلفة التوكنز لكل مهمة
alter table public.studio_jobs add column if not exists mode text not null default 'creative';
alter table public.studio_jobs add column if not exists cost_in integer;
alter table public.studio_jobs add column if not exists cost_out integer;
