-- ══════════════════════════════════════════════
-- WhatsApp-Router — حالة محادثات Tourism-AI متعددة الأدوار
-- ══════════════════════════════════════════════

-- نخزن تاريخ المحادثة الكامل (user/assistant) عشان نمرره لـ Tourism-AI
-- في كل مرة يرد العميل بمعلومه إضافيه (عدد ليالي لكل مدينة، نوع التنقل، …)
ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS conversation JSONB NOT NULL DEFAULT '[]'::JSONB;
