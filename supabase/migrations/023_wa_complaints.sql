-- Complaint tracking for the monitor (مراقبين) dashboard view. Every
-- inbound message the AI flags as case_type=COMPLAINT, plus every keyword-
-- classified complaint that goes through handleComplaint, auto-creates a
-- row here so monitors get a curated queue separate from the regular
-- proposals/conversations.
--
-- Severity ladder:
--   normal  → default for keyword-classified complaints
--   medium  → admin/monitor manually escalates
--   urgent  → derived from priority=URGENT (CONFIRMED booking + COMPLAINT)
--
-- Status lifecycle:
--   in_progress      → just received, monitor/staff working on it
--   resolved         → fixed; resolution_notes describes how
--   closed_unresolved → won't be solved (customer dropped off, etc.)

create table if not exists wa_complaints (
  id uuid primary key default gen_random_uuid(),
  customer_phone text not null,
  customer_name text,
  complaint_type text,                -- PAYMENT_ISSUE | HOTEL_ISSUE | FLIGHT_ISSUE | SERVICE_ISSUE | DELAY_RESPONSE | GENERAL_DISSATISFACTION
  severity text not null default 'normal',  -- normal | medium | urgent
  description text,                   -- the customer's original message
  assigned_staff_phone text,          -- who's following up (mirrors session.assigned_staff_phone at creation time)
  status text not null default 'in_progress',  -- in_progress | resolved | closed_unresolved
  resolution_notes text,              -- "كيف تم حلها"
  source text not null default 'ai',  -- 'ai' (analyzeUnknownQuestion) | 'keyword' (handleComplaint)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists wa_complaints_status_idx
  on wa_complaints (status, created_at desc);
create index if not exists wa_complaints_severity_idx
  on wa_complaints (severity, created_at desc);
create index if not exists wa_complaints_phone_idx
  on wa_complaints (customer_phone, created_at desc);

-- Staff role differentiates sales operators from monitors. The dashboard
-- routes each role to its own view; existing rows are sales by default.
alter table wa_staff
  add column if not exists role text not null default 'sales'; -- 'sales' | 'monitor'
