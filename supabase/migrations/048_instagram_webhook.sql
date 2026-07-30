-- إنستقرام Direct: حسابات الأعمال + الرسائل الواردة (مصدر ويبهوك ميتا instagram-webhook).
CREATE TABLE IF NOT EXISTS ig_accounts (
  ig_account_id text PRIMARY KEY,
  username      text,
  access_token  text,
  country       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instagram_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_account_id text REFERENCES ig_accounts(ig_account_id),
  sender_igsid  text,
  recipient_id  text,
  mid           text UNIQUE,                 -- معرّف رسالة ميتا — لمنع التكرار
  message_text  text,
  direction     text DEFAULT 'inbound',
  sent_at       timestamptz,
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_messages_acct_created_idx
  ON instagram_messages (ig_account_id, created_at DESC);

-- تُقرأ/تُكتب عبر service_role (دوال Edge) فقط.
ALTER TABLE ig_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_messages ENABLE ROW LEVEL SECURITY;
