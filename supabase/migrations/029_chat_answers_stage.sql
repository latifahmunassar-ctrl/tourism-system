-- Stage-aware FAQ answers — Option B (one row per stage).
--
-- Same customer question can have different correct answers depending on
-- the customer's stage in the journey. The FAQ matcher prefers a row
-- whose stage equals the customer's current stage; falls back to a NULL
-- stage row (a default that applies to all stages) when no exact match
-- exists.
--
-- The Google Sheet "ALEZZ Chat" needs a new "Stage" header in column K.
-- sync-sheets will read it and populate this column on every sync.

alter table chat_answers
  add column if not exists stage text;
  -- one of: INQUIRY | OFFER_SENT | BOOKING_IN_PROGRESS |
  -- BOOKING_CONFIRMED | TRAVELING | POST_TRAVEL  (or NULL = ALL stages)

create index if not exists chat_answers_stage_idx
  on chat_answers (stage);
