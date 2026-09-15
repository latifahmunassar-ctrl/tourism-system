/**
 * group-intake — يستقبل رسائل قروب الواتساب ويلتقط الطلبات منها.
 *
 * أي POST لازم يحمل هيدر x-intake-secret يساوي قيمة السر INTAKE_SECRET، وإلا 401.
 *
 * المنطق: نقرأ نص الرسالة. لو ما يبدأ بـ "#طلب" نتجاهله بهدوء (ok:true, skipped)
 * — عشان رسائل القروب العادية ما تتسجّل. لو يبدأ بـ "#طلب" نفصّل منه:
 * الوجهة، التواريخ، الركاب، الميزانية، الشركة — وندرج صفاً في جدول requests.
 *
 * لا يلمس أي دالة أخرى. يدرج فقط في requests عبر SERVICE_ROLE (يتجاوز RLS).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-intake-secret",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

// أول سطر/كلمة في الرسالة لازم تكون هذي العلامة عشان نعتبرها طلباً.
const TRIGGER = "#طلب";

// أزل المسافات والرموز غير المرئية من بداية النص.
function leftTrim(s: string): string {
  return String(s ?? "").replace(/^[\s​-‏‪-‮﻿]+/, "");
}

// يلتقط قيمة حقل حسب مرادفات الاسم: "الوجهة: ماليزيا" → "ماليزيا".
// يبحث في كل النص (أسطر متعددة)، ويأخذ ما بعد ":" أو "：" حتى نهاية السطر.
function field(text: string, labels: string[]): string | null {
  for (const label of labels) {
    // label يليه نقطتان (عربية/إنجليزية) أو "=" ثم القيمة حتى آخر السطر.
    const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：=]\\s*([^\\n]+)`, "i");
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // ── حماية بالسر في الهيدر ─────────────────────────────────────────────
  const expected = (Deno.env.get("INTAKE_SECRET") || "").trim();
  const got = (req.headers.get("x-intake-secret") || "").trim();
  if (!expected || !got || got !== expected) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // ── قراءة الجسم (JSON، ومرن مع أسماء حقول شائعة من جسور الواتساب) ──────
  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = payload[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  const rawText = pick("raw_text", "text", "message", "body", "Body");
  if (!rawText) return json({ ok: false, error: "empty_message" }, 400);

  const groupJid = pick("group_jid", "groupJid", "From", "group", "chat_id") || null;
  const senderName = pick("sender_name", "senderName", "name", "ProfileName", "author") || null;
  // المصدر يخضع لقيد الجدول (company | staff). الافتراضي company لطلبات القروب.
  const srcRaw = pick("source").toLowerCase();
  const source = srcRaw === "staff" ? "staff" : "company";

  // ── تجاهل ما لا يبدأ بـ #طلب ──────────────────────────────────────────
  const trimmed = leftTrim(rawText);
  if (!trimmed.startsWith(TRIGGER)) {
    return json({ ok: true, skipped: true, reason: "not_a_request" });
  }

  // النص بعد العلامة (نحلّل منه الحقول). نحتفظ بالنص الكامل في raw_text.
  const afterTrigger = trimmed.slice(TRIGGER.length);

  const destination = field(afterTrigger, ["الوجهة", "الوجهه", "الدولة", "البلد", "المدينة", "الى", "إلى", "destination"]);
  const travelDates = field(afterTrigger, ["التواريخ", "التاريخ", "الموعد", "الفترة", "الفتره", "dates", "date"]);
  const pax = field(afterTrigger, ["الركاب", "الأشخاص", "الاشخاص", "عدد الركاب", "عدد", "pax", "guests"]);
  const budget = field(afterTrigger, ["الميزانية", "الميزانيه", "الميزان", "المبلغ", "budget"]);
  const companyName = field(afterTrigger, ["الشركة", "الشركه", "company", "company_name"]);

  // ── الإدراج في requests ──────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await supabase
    .from("requests")
    .insert({
      source,
      group_jid: groupJid,
      sender_name: senderName,
      raw_text: rawText,
      destination,
      travel_dates: travelDates,
      pax,
      budget,
      company_name: companyName,
      status: "new",
    })
    .select("id")
    .single();

  if (error) {
    console.error("group-intake insert failed:", error.message);
    return json({ ok: false, error: "db_insert_failed" }, 500);
  }

  return json({
    ok: true,
    id: data.id,
    parsed: { destination, travel_dates: travelDates, pax, budget, company_name: companyName },
  });
});
