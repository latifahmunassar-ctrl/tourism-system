-- Per-proposal CRM classification produced by Claude alongside the
-- suggested reply. Stored on whatsapp_admin_proposals so the dashboard
-- can sort URGENT to the top and show category badges to the admin.

alter table whatsapp_admin_proposals
  add column if not exists customer_type text,
  add column if not exists case_type text,
  add column if not exists complaint_type text,
  add column if not exists booking_status text,
  add column if not exists priority text,
  add column if not exists priority_label text;

-- Help the dashboard query that sorts URGENT first.
create index if not exists whatsapp_admin_proposals_priority_idx
  on whatsapp_admin_proposals (priority, created_at desc);
