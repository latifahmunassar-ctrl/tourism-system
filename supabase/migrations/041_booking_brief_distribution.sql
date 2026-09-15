-- إضافة تخزين توزيع المدن المختار في booking_brief.
-- المصدر: نفس اقتراحات النظام السياحي (client-intake?suggestions=<dest>).
-- بناء إضافي غير كاسر: عمودان جديدان قابلان للـ NULL فقط.

alter table public.booking_brief
  add column if not exists distribution  text,   -- النص: "2 سيلانجور - 2 لانكاوي - 2 كوالالمبور"
  add column if not exists cities_nights jsonb;   -- [{ "city": "...", "nights": N }] — صيغة client_requests للتحويل المباشر
