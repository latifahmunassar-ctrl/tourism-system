-- قاعدة المالكة (2026-11-10): كل محادثة شركة يرد عليها «سارة» تلقائياً طالما المفتاح الرئيسي
-- (b2b_settings.auto_reply_enabled) مفعّل. الاستثناء الوحيد: محادثة أوقفتها المالكة يدوياً
-- (auto_reply=false من زر «رد يدوي» في اللوحة) — تبقى موقوفة مهما تغيّر المفتاح الرئيسي.
-- محادثات الحملات كانت تُنشأ خطأً بـ auto_reply=false (b2b-send) → نعيدها للافتراضي مرة واحدة.
update b2b_conversations set auto_reply = true where auto_reply is distinct from true;
alter table b2b_conversations alter column auto_reply set default true;
