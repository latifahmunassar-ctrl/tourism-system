-- ══════════════════════════════════════════════
-- Admin-approved AI-suggested replies for unknown questions
-- ══════════════════════════════════════════════
--
-- When a customer asks something that doesn't match any chat_answers row,
-- Claude analyses the question and proposes:
--   (1) a suggested reply (Khaleeji, no punctuation)
--   (2) what to add to the ALEZZ Chat sheet so the same question hits the
--       FAQ on the next try
--
-- The admin (= any number in SALES_WHATSAPP_NUMBERS) approves in two steps
-- via WhatsApp: first the reply, then the sheet-add. Each open proposal is
-- a row here; admin's reply lands on the OLDEST not-yet-decided proposal.

CREATE TABLE IF NOT EXISTS whatsapp_admin_proposals (
  id                    UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_phone        TEXT         NOT NULL,          -- whatsapp:+9665XXX
  customer_profile_name TEXT         NOT NULL DEFAULT '',
  customer_question     TEXT         NOT NULL,

  -- Claude's analysis (populated when the proposal is created)
  interpretation        TEXT         NOT NULL DEFAULT '',
  suggested_reply       TEXT         NOT NULL DEFAULT '',
  proposed_intent       TEXT         NOT NULL DEFAULT '',
  proposed_sub_intent   TEXT         NOT NULL DEFAULT '',
  proposed_keywords     TEXT[]       NOT NULL DEFAULT '{}',

  -- State machine:
  --   pending_reply_approval  → admin must decide whether to send the reply
  --   pending_sheet_approval  → reply was sent; admin must decide on sheet add
  --   completed_added         → reply sent AND sheet row added
  --   completed_no_add        → reply sent, admin declined sheet add
  --   rejected                → admin declined the reply itself
  status                TEXT         NOT NULL DEFAULT 'pending_reply_approval',

  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS whatsapp_admin_proposals_status_created_idx
  ON whatsapp_admin_proposals (status, created_at)
  WHERE status IN ('pending_reply_approval', 'pending_sheet_approval');

ALTER TABLE whatsapp_admin_proposals ENABLE ROW LEVEL SECURITY;
