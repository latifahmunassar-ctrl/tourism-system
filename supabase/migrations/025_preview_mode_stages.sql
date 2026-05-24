-- PREVIEW MODE + Customer stage tracking
--
-- Two related changes:
--
-- 1) Each conversation carries a "customer_stage" that the classifier
--    infers from the conversation context. The dashboard's admin
--    notification + the saving flow respect the stage so the FAQ
--    answers are scoped to the right point in the customer journey.
--
-- 2) chat_answers gains six stage-specific answer columns. The reader
--    (findFaqAnswer) prefers the matching stage's answer when the
--    session has one set; falls back to the legacy answer_om / sa1 /
--    clarification chain when the stage column is empty. So existing
--    FAQ rows keep working unchanged.

alter table whatsapp_sessions
  add column if not exists customer_stage text default 'INQUIRY';
  -- INQUIRY | OFFER_SENT | BOOKING_IN_PROGRESS | BOOKING_CONFIRMED |
  -- TRAVELING | POST_TRAVEL

create index if not exists whatsapp_sessions_customer_stage_idx
  on whatsapp_sessions (customer_stage);

alter table chat_answers
  add column if not exists answer_inquiry text,
  add column if not exists answer_offer_sent text,
  add column if not exists answer_booking_in_progress text,
  add column if not exists answer_booking_confirmed text,
  add column if not exists answer_traveling text,
  add column if not exists answer_post_travel text;

-- proposals also remember which stage they were classified under so the
-- admin's "save to FAQ" step can write the answer into the correct
-- stage column without re-classifying.
alter table whatsapp_admin_proposals
  add column if not exists customer_stage text;
