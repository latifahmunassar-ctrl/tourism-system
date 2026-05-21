-- ══════════════════════════════════════════════
-- WhatsApp-Router — حالة المحادثات + الأسئلة الشائعة
-- ══════════════════════════════════════════════

-- حالة محادثات الواتساب (لجمع destination/persons/date عبر عدّة رسائل)
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  phone           TEXT         PRIMARY KEY,                     -- whatsapp:+9665XXX
  profile_name    TEXT         NOT NULL DEFAULT '',
  stage           TEXT         NOT NULL DEFAULT 'new',          -- new|awaiting_destination|awaiting_persons|awaiting_date|done
  destination     TEXT,
  persons         INTEGER,
  travel_date     TEXT,
  hubspot_contact_id TEXT,
  last_message_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS whatsapp_sessions_last_message_idx
  ON whatsapp_sessions (last_message_at DESC);

-- الأسئلة الشائعة — يستخدمها الـ Router للرد على general inquiries
CREATE TABLE IF NOT EXISTS faqs (
  id                UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  question_keywords TEXT[]       NOT NULL,                       -- كلمات مفتاحية تطابق سؤال العميل
  answer            TEXT         NOT NULL,
  priority          INTEGER      NOT NULL DEFAULT 0,             -- الأعلى يُختار عند تساوي المطابقة
  active            BOOLEAN      NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- تأمين الجداول (الـ Edge Function يستخدم service_role، فالـ RLS تحجب الواجهة العامة)
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE faqs              ENABLE ROW LEVEL SECURITY;

-- بذرة بسيطة لـ FAQ (تُعدّل من Supabase UI لاحقاً)
INSERT INTO faqs (question_keywords, answer, priority) VALUES
  (ARRAY['دوام','الدوام','اوقات','أوقات','ساعات','مفتوحين','مفتوح'],
   'دوامنا من السبت إلى الخميس، 9 صباحاً حتى 9 مساءً. الجمعة إجازة.', 10),
  (ARRAY['طريقة','الدفع','تحويل','حساب','ايبان','آيبان','iban'],
   'الدفع عن طريق تحويل بنكي. بعد تأكيد البرنامج، نرسل لك التفاصيل والآيبان.', 10),
  (ARRAY['كيف','اطلب','أطلب','حجز','احجز','بدي','أبي','ابي','عرض','سعر'],
   'تفضّل! أرسل لنا: الوجهة، عدد الأشخاص، وتاريخ السفر، وراح نجهز لك عرض خاص.', 5),
  (ARRAY['تأشيرة','فيزا','visa'],
   'بعض الوجهات تتطلب تأشيرة. أخبرنا بالوجهة وراح نوضح لك المتطلبات.', 5),
  (ARRAY['الغاء','إلغاء','استرداد','استرجاع'],
   'سياسة الإلغاء تختلف حسب الفندق والطيران. تواصل مع المبيعات لمعرفة شروط برنامجك.', 5)
ON CONFLICT DO NOTHING;
