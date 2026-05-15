-- Package suggestions: pre-canned city distributions per destination, keyed
-- by arrival/departure airports + total trip days. Populated by sync-sheets
-- from a free-form column in each destination's tab (e.g. column "اقتراحات
-- توزيع مدن" in vietnam).
create table if not exists package_suggestions (
  id bigserial primary key,
  destination       text not null,
  arrival_airport   text not null,   -- canonical city ("Ha Noi", "Ho Chi Minh", …)
  departure_airport text not null,
  days              integer not null,
  label             text,             -- optional variant tag ("الأرخص", "نسخة دانانغ")
  distribution      text not null,    -- raw Arabic distribution as the employee wrote it
  last_synced_at    timestamptz default now()
);
create index if not exists idx_suggestions_lookup
  on package_suggestions (destination, arrival_airport, departure_airport, days);
