-- Store the FAQ row id that the AI's suggested_reply came from (if any).
-- Set by analyzeUnknownQuestion → createProposalAndNotifyAdmin.
--
-- Used by the approve flow to skip re-saving an answer that's already
-- a chat_answers row:
--   approve + source_row_id IS NULL  → save new FAQ entry
--   approve + source_row_id NOT NULL → skip save (already in sheet)
--   correct (admin typed new reply)  → save (it's a variation)

alter table whatsapp_admin_proposals
  add column if not exists source_row_id text;
