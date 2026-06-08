-- ══════════════════════════════════════════════
-- client_requests — B2B intake form → internal build → client proposal
-- ══════════════════════════════════════════════
--
-- Companies submit a trip request through a public form (request.html → the
-- client-intake edge function). The function auto-builds the program with
-- Tourism-AI, stores the FULL internal program (with pricing) for staff review,
-- and a SANITIZED client view (no internal pricing, single group total). The
-- company only ever sees the sanitized client_program — and only after a staff
-- member approves & sends (status = 'sent'), fetched by the unguessable
-- view_token via the client-proposal edge function.
--
-- RLS is enabled with NO policies: anon/public have ZERO direct table access.
-- Every read/write goes through an edge function using the service role (which
-- bypasses RLS). This guarantees the internal program + pricing can never be
-- pulled directly from PostgREST by a company.

CREATE TABLE IF NOT EXISTS client_requests (
  id             UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  ref_no         TEXT         NOT NULL UNIQUE,          -- human ref, e.g. REQ-2026-0012
  view_token     TEXT         NOT NULL UNIQUE,          -- unguessable token for the proposal link

  -- form input
  company_name   TEXT         NOT NULL DEFAULT '',
  contact_name   TEXT         NOT NULL DEFAULT '',
  contact_email  TEXT         NOT NULL DEFAULT '',
  contact_phone  TEXT         NOT NULL DEFAULT '',
  destination    TEXT         NOT NULL DEFAULT '',
  cities_nights  JSONB        NOT NULL DEFAULT '[]',     -- [{ "city": "...", "nights": N }]
  pax            INTEGER      NOT NULL DEFAULT 1,
  days           INTEGER      NOT NULL DEFAULT 0,
  date_from      TEXT         NOT NULL DEFAULT '',
  transport      TEXT         NOT NULL DEFAULT 'private',-- private | shared
  extra_bed      TEXT         NOT NULL DEFAULT '',
  sim_count      INTEGER      NOT NULL DEFAULT 0,
  notes          TEXT         NOT NULL DEFAULT '',

  -- outputs
  status         TEXT         NOT NULL DEFAULT 'new',    -- new | pending_review | sent | build_failed | closed
  built_program  TEXT         NOT NULL DEFAULT '',       -- INTERNAL: full program incl. pricing (never exposed publicly)
  client_program JSONB,                                  -- SANITIZED client view (no internal pricing)
  group_total    NUMERIC(12,2),                          -- single group total shown to the company
  build_message  TEXT         NOT NULL DEFAULT '',       -- CHAT line / error when build didn't produce a program

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sent_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS client_requests_status_idx  ON client_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS client_requests_token_idx   ON client_requests (view_token);

-- Lock the table down: RLS on, NO policies → no anon/public access at all.
-- All access is via edge functions running with the service role.
ALTER TABLE client_requests ENABLE ROW LEVEL SECURITY;
