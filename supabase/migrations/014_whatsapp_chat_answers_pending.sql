-- ══════════════════════════════════════════════
-- ALEZZ Chat answers + pending program review state
-- ══════════════════════════════════════════════

-- جدول مرآة لورقة ALEZZ Chat على Google Sheets
-- (يُحدَّث من خلال sync-sheets) — لا تُحرَّر يدوياً.
-- Composite key because some IDs reappear with different sub-intents
-- (e.g. PKG001 has both "General" and "Specific _Destination" rows).
CREATE TABLE IF NOT EXISTS chat_answers (
  id                    TEXT          NOT NULL,       -- ID column from sheet (PKG001, PKG002, …)
  intent                TEXT          NOT NULL DEFAULT '',
  sub_intent            TEXT          NOT NULL DEFAULT '',
  keywords              TEXT[]        NOT NULL DEFAULT '{}',   -- normalised tokens for matching
  sample_q              TEXT          NOT NULL DEFAULT '',
  answer_sa1            TEXT          NOT NULL DEFAULT '',
  answer_sa2            TEXT          NOT NULL DEFAULT '',
  answer_clarification  TEXT          NOT NULL DEFAULT '',
  answer_om             TEXT          NOT NULL DEFAULT '',
  status                TEXT          NOT NULL DEFAULT '',
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, sub_intent)
);

CREATE INDEX IF NOT EXISTS chat_answers_keywords_gin ON chat_answers USING GIN (keywords);

ALTER TABLE chat_answers ENABLE ROW LEVEL SECURITY;

-- الحالة المعلّقة (pending review) — برنامج بُني عبر Tourism-AI وينتظر إرسال الموظف
ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS pending_program     TEXT,
  ADD COLUMN IF NOT EXISTS pending_program_at  TIMESTAMPTZ;
