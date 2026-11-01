-- السماح للداشبورد (anon) بحذف مهام الاستوديو
do $$ begin
  create policy "studio_jobs_anon_delete" on public.studio_jobs for delete to anon using (true);
exception when duplicate_object then null; end $$;
