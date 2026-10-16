-- 050: إضافة مرفق «طلب الإرجاع من الشركة» (اعتماد داخلي) إلى مستند المرتجع
-- يُرفق بجانب طلب العميل بالإرجاع ليتأكّد من أنه طلب حقيقي صادر عن الشركة
alter table acc_refund_docs
  add column if not exists company_doc_base64 text,
  add column if not exists company_doc_name   text,
  add column if not exists company_doc_type   text;
