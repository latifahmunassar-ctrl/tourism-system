-- ملاحظة داخلية لكل عرض — تظهر للموظف في الداشبورد فقط ولا تُرسَل للعميل.
alter table wa_offers
  add column if not exists note text;
