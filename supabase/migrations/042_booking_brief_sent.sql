-- حقول إرسال عرض الفرد (PDF للعميل) + سجل «المُرسل» في صندوق طلبات الأفراد.
alter table public.booking_brief
  add column if not exists sent_at       timestamptz,
  add column if not exists sent_by       text,
  add column if not exists built_program text,
  add column if not exists sent_price    numeric,
  add column if not exists sent_currency text,
  add column if not exists send_note     text;
