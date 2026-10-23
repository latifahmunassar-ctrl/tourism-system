-- ══════════════════════════════════════════════════════════════════
-- B2B — رقم/رابط واتساب الإدارة (يُستبدلان في prompt سارة كمتغيّرين
-- {admin_whatsapp} و {admin_whatsapp_link} داخل b2b-talal). قابلان للتعديل من
-- لوحة «إعدادات سارة» في داشبورد التسويق.
-- ══════════════════════════════════════════════════════════════════
insert into b2b_settings (key, value) values
  ('admin_whatsapp',      '+60 11-1113 6864'),
  ('admin_whatsapp_link', 'https://wa.me/601111136864')
on conflict (key) do nothing;
