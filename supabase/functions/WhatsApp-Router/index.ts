/**
 * WhatsApp-Router — موجّه رسائل واتساب عبر Meta WhatsApp Cloud API
 *
 * نسخة Cloud API (index.cloud.ts) — مهاجَرة من Twilio. كل منطق العمل
 * (طلال، التصنيف general/package/complaint، HubSpot، الجلسات، التدقيق،
 * مطابقة الموظفين) يبقى كما هو. تغيّرت فقط طبقة الإدخال/الإخراج:
 *   • الإدخال: webhook من Meta (application/json) بدل Twilio form-urlencoded
 *   • الإخراج: Graph API /messages بدل Twilio REST
 *
 * مبدأ الترحيل: الترجمة عند الحدود فقط. التمثيل الداخلي للرقم يبقى
 * "whatsapp:+<E164>" تماماً كـ Twilio، فلا يتغيّر أي شيء أسفل الحدود:
 *   • الإدخال: Meta يعطي "96891171630" → نحوّلها لـ "whatsapp:+96891171630"
 *   • الإخراج: نجرّد "whatsapp:+" → نرسل "96891171630" لـ Graph API
 *
 * Supabase Secrets المطلوبة:
 *   ANTHROPIC_API_KEY          → fallback للتصنيف عند ضعف ثقة الكلمات المفتاحية
 *   WHATSAPP_ACCESS_TOKEN      → توكن Graph API الدائم (System User) — للإرسال
 *   WHATSAPP_PHONE_NUMBER_ID   → 1083374618203172 (معرّف الرقم على Cloud API)
 *   WHATSAPP_VERIFY_TOKEN      → سرّ التحقق من الويبهوك (GET hub.verify_token)
 *   SALES_WHATSAPP_NUMBERS     → CSV: whatsapp:+9665XXX,whatsapp:+9665YYY
 *   COMPLAINTS_WHATSAPP_NUMBERS→ CSV نفس الصيغة
 *   HUBSPOT_API_KEY            → Private App token (Bearer)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → تُحقن تلقائياً
 *
 * Meta webhook URL (GET للتحقق + POST للرسائل):
 *   https://ofotvacszlmrqxzfjmtn.supabase.co/functions/v1/WhatsApp-Router
 */

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── ثوابت ─────────────────────────────────────────────────────────────────
const PROJECT_REF = "ofotvacszlmrqxzfjmtn";
const TOURISM_AI_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/Tourism-AI`;

const GRAPH_VERSION = "v22.0";

// ── تخزين وسائط العميل الواردة بشكل دائم ─────────────────────────────────────
// واتساب (Meta) يحذف الوسائط من خوادمه بعد فترة. كنا نخزّن المعرّف فقط (media_id)
// ونجلب الوسيط عند الطلب — فبعد حذف Meta له يرجع 400 «media not found» ولا يظهر
// المرفق بالداشبورد أبداً (شكوى «المرفقات ما تظهر» المتكرّرة). الحل: نحفظ نسخة
// دائمة في باكت whatsapp-attachments مفتاحها media_id — عند الاستلام (warm) وعند
// أول عرض (cache) — ونعرض من نسختنا حتى بعد حذف Meta للأصل.
const MEDIA_BUCKET = "whatsapp-attachments";
const inboundMediaKey = (mediaId: string) => `inbound/${mediaId}`;

// ينزّل الوسيط من Meta ويرجع البايتات + النوع (أو null عند الفشل/انتهاء الصلاحية).
async function fetchMetaMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const TOKEN = (Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim();
  if (!TOKEN || !mediaId) return null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!metaRes.ok) return null;
    const metaJson = await metaRes.json();
    const fileUrl = metaJson?.url;
    const mime = String(metaJson?.mime_type || "application/octet-stream");
    if (!fileUrl) return null;
    const fileRes = await fetch(fileUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!fileRes.ok) return null;
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    return { bytes, mime };
  } catch (_e) { return null; }
}

// أفضل جهد: ينزّل الوسيط الطازج ويخزّنه دائماً في الباكت. لا يرمي أبداً — يُستدعى
// في الخلفية (EdgeRuntime.waitUntil) عند استلام كل رسالة وسائط.
async function warmInboundMedia(mediaId: string): Promise<void> {
  if (!mediaId) return;
  try {
    const store = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const got = await fetchMetaMedia(mediaId);
    if (!got) return;
    await store.storage.from(MEDIA_BUCKET).upload(inboundMediaKey(mediaId), got.bytes, {
      contentType: got.mime, upsert: true,
    });
  } catch (_e) { /* أفضل جهد — لا يكسر الاستقبال */ }
}

// يقرأ صورة أرسلها العميل (غالباً صورة عرض سياحي من إعلاناتنا) عبر Claude vision
// ويستخرج وصفاً موجزاً بالعربي (الوجهة/المدن/الأيام/السعر إن ظهر) ليعرف طلال محتواها
// فلا يسأل عن الوجهة وهي واضحة بالصورة. يرجّع "" لو ما قدر يقرأ أو الصورة ليست عرضاً.
async function describeCustomerImage(mediaId: string): Promise<string> {
  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey || !mediaId) return "";
    const got = await fetchMetaMedia(mediaId);
    if (!got) return "";
    const mime = /jpe?g|png|webp|gif/i.test(got.mime) ? got.mime : "image/jpeg";
    // base64 من البايتات
    let bin = ""; const b = got.bytes; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    const b64 = btoa(bin);
    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 200,
      system: "أنت تقرأ صورة أرسلها عميل لوكالة سفر. غالباً صورة عرض سياحي (وجهة/مدن/عدد أيام/سعر). استخرج بإيجاز شديد بالعربي: الوجهة والمدن وعدد الأيام والسعر إن ظهرت. لو الصورة عرض سفر أعِد سطراً واحداً مثل: «عرض: تايلاند (بانكوك وبوكيت) — 9 أيام — يبدأ من 256 ر.ع». لو الصورة ليست عرض سفر (جواز/إيصال/شيء آخر) أعِد كلمة واحدة: «غير_عرض». بلا أي شرح إضافي.",
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: b64 } },
        { type: "text", text: "وش محتوى هذه الصورة؟" },
      ] }],
    });
    let txt = ""; for (const blk of res.content) if ((blk as { type?: string }).type === "text") txt += (blk as { text?: string }).text || "";
    txt = txt.trim();
    return /غير_?عرض|not|ليست/i.test(txt) ? "" : txt.slice(0, 300);
  } catch (_e) { return ""; }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

// نرد على ويبهوك Meta بـ 200 سريع (الرسائل الصادرة نرسلها عبر Graph REST
// بأنفسنا في الخلفية عبر EdgeRuntime.waitUntil حتى نرسل لعدّة أرقام موظفين).
const OK_RESPONSE = () => new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });

// نافذة «خارج ساعات العمل» بتوقيت عُمان (UTC+4، بلا توقيت صيفي): من الساعة 1 ليلاً
// حتى 9 صباحاً. خلالها لا موظفين متاحين، فلا يرسل طلال رداً يوحي بردّ بشري خلال
// دقائق («أكون معك»)؛ بدلاً منه رسالة صادقة أن الرد سيصل أول الصباح.
function isOmanQuietHours(): boolean {
  const omanHour = (new Date().getUTCHours() + 4) % 24;   // عُمان = UTC+4
  return omanHour >= 1 && omanHour < 9;                   // [1:00 , 9:00)
}
const OMAN_OFF_HOURS_MSG =
  "أهلاً أستاذي 🌙 فريقنا خارج ساعات العمل حالياً، ونرد على استفسارك أول الصباح بإذن الله 🙏";

// ── إعلان فيه كود برنامج جاهز (المرحلة ١: نص منسّق بعملة العميل) ───────────
// يستخرج كوداً نظامياً (مثل OM-2026-069) من نص الإعلان (الكابشن/العنوان).
function extractProgramCode(text: string): string {
  const m = String(text || "").match(/\b([A-Za-z]{2,3}-20\d{2}-\d{1,4})\b/);
  return m ? m[1].toUpperCase() : "";
}
// عملة العميل حسب مقدمة رقمه (أسعار الصرف من جدول currencies — نفس ما يستخدمه الداشبورد).
// السعر الأساس في البرامج بالريال السعودي؛ التحويل = السعر ÷ rate.
async function customerCurrency(
  supabase: ReturnType<typeof createClient>, from: string,
): Promise<{ code: string; name: string; rate: number }> {
  const digits = String(from || "").replace(/\D/g, "");
  let code = "";
  if (/^968/.test(digits)) code = "OMR";
  else if (/^971/.test(digits)) code = "UAE";
  if (!code) return { code: "SAR", name: "ريال سعودي", rate: 1 };   // السعودية وغيرها = الأساس
  try {
    const { data } = await supabase.from("currencies").select("code, name_ar, rate").eq("code", code).maybeSingle();
    const r = data as { name_ar?: string; rate?: number } | null;
    if (r && Number(r.rate) > 0) return { code, name: r.name_ar || code, rate: Number(r.rate) };
  } catch (_e) { /* */ }
  return { code: "SAR", name: "ريال سعودي", rate: 1 };   // fallback آمن — لا نخترع سعراً بعملة بلا سعر صرف
}
// يبني رسالة العرض للعميل من برنامج محفوظ (raw + السعر بعملة العميل).
async function formatAdProgramMessage(
  supabase: ReturnType<typeof createClient>,
  prog: { destination?: string; persons?: number; total_group?: number; raw?: string },
  from: string,
): Promise<string> {
  const raw = String(prog.raw || "");
  const line = (tag: string) => (raw.match(new RegExp("^" + tag + ":\\s*([^\\n]+)", "m")) || [])[1] || "";
  const section = (tag: string) => {
    const m = raw.match(new RegExp(tag + ":([\\s\\S]*?)(?=\\n[A-Z_]+:|$)", "m"));
    return m ? m[1] : "";
  };
  const destRaw = String(prog.destination || line("DEST") || "").trim();
  const destMap: Record<string, string> = {
    "Oman": "عُمان", "South Africa": "جنوب أفريقيا", "Malaysia": "ماليزيا",
    "mauritius": "موريشيوس", "Mauritius": "موريشيوس", "China": "الصين", "Egypt": "مصر", "Morroco": "المغرب", "Abu Dhabi": "أبوظبي",
  };
  const dest = destMap[destRaw] || destRaw;
  const meta = line("META");                                   // "5 أيام | 4 ليالي | ..."
  const daysNights = meta.split("|").slice(0, 2).map((s) => s.trim()).filter(Boolean).join(" / ");
  const persons = Number(prog.persons) || 0;
  const tours = [...section("TOURS").matchAll(/^\s*اليوم\s*\d+\s*\|\s*([^|]+)\|/gm)]
    .map((m) => m[1].trim())
    .filter((t) => t && !/يوم\s*حر|تنقّل|تنقل|استقبال|توديع|توصيل|العوده|العودة/.test(t))
    .slice(0, 5);
  const hotels = [...section("HOTELS").matchAll(/^\s*([^|\n]+)\|[^|]*\|\s*([^|]*نجوم)/gm)]
    .map((m) => `${m[1].trim()} (${m[2].trim()})`).slice(0, 4);
  const hasFlights = /FLIGHTS:\s*\n\s*[^\sA-Z]/.test(raw + "\n");
  const cur = await customerCurrency(supabase, from);
  const sar = Number(prog.total_group) || 0;
  const groupPrice = cur.rate > 0 ? Math.round(sar / cur.rate) : sar;
  const perPerson = persons > 0 ? Math.round(groupPrice / persons) : 0;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const parts: string[] = ["هلا وغلا 🌟 هذي تفاصيل العرض اللي شفته:", ""];
  if (dest) parts.push(`🗺️ الوجهة: ${dest}`);
  if (daysNights) parts.push(`📅 المدة: ${daysNights}`);
  if (hotels.length) parts.push(`🏨 الفنادق: ${hotels.join("، ")}`);
  if (hasFlights) parts.push("✈️ يشمل طيران");
  if (tours.length) parts.push(`✨ يشمل: ${tours.join(" • ")}`);
  if (groupPrice > 0) parts.push("", `💰 السعر: ${fmt(groupPrice)} ${cur.name}${persons ? ` لـ${persons} أشخاص` : ""}${perPerson ? ` (${fmt(perPerson)} للشخص)` : ""}`);
  parts.push("", "حاب تعدّل أو تغيّر أي شي بالبرنامج؟ أنا جاهز 👍");
  return parts.join("\n");
}

// ترجمة الحدود: Meta يعطي الرقم أرقاماً فقط "96891171630"؛ نوحّده إلى صيغة
// Twilio الداخلية "whatsapp:+96891171630" حتى يبقى كل المنطق الأسفل متطابقاً.
function metaFromToInternal(raw: string): string {
  const digits = String(raw).replace(/^whatsapp:/, "").replace(/^\+/, "")
    .replace(/^00/, "").replace(/[^0-9]/g, "");
  return `whatsapp:+${digits}`;
}

// عكسها: من التمثيل الداخلي إلى صيغة Graph API (أرقام فقط، بدون + أو بادئة).
function internalToGraph(to: string): string {
  return String(to).replace(/^whatsapp:/, "").replace(/^\+/, "").replace(/[^0-9]/g, "");
}

// ── تصنيف الرسائل ─────────────────────────────────────────────────────────
// أنماط شكاوى أولاً (الأكثر حسمًا) — لو طابق، لا نسأل Claude.
const COMPLAINT_PATTERNS = [
  /شكوى|شكوه|اشتكي|أشتكي/i,
  /مشكلة|مشكله|مشاكل/i,
  /سيء|سيئة|سيئه|سيئين|تجربة\s*سيئة/i,
  /غش|نصب|احتيال/i,
  /متضرر|متضرّر|تأخر|تأخرنا|تاخرنا/i,
  /زعلان|زعلانه|غاضب|مزعج/i,
  /ما\s*يصير|ماتوقعت|توقعت\s*أحسن/i,
];

// أنماط طلب باقة/برنامج
const PACKAGE_PATTERNS = [
  /برنامج|عرض|باقة|باقه|رحلة|رحله|سياح|سفر/i,
  /سعر|تكلفة|تكلفه|كم\s*يكلف|كم\s*تكلف/i,
  /أبي|ابي|بدي|أريد|اريد|أحتاج|احتاج|ابغى|أبغى|ابغا/i,
  /حجز|احجز|أحجز/i,
  // Travel-action verbs — clear signal of intent to book.
  /اسافر|أسافر|نسافر|تسافر|سافر|نروح|تروح|نزور|تزور/i,
  // Bare destination mentions (very common as a single-word reply to
  // "وين تبي تسافر؟") — these should reach the Travel Agent, not the FAQ.
  /تركيا|ماليزيا|تايلند|تايلاند|اندونيسيا|إندونيسيا|فيتنام|روسيا|البوسنه|البوسنة|اذربيجان|أذربيجان|جورجيا|المالديف|دبي|بالي|تونس|مصر|عمان\s|عمّان|سوتشي|كوالا|اسطنبول|سياحه|سياحة/i,
];

type Category = "general" | "package" | "complaint";

interface ClassifyResult {
  category: Category;
  confidence: number;     // 0..1 — ضعف الثقة يفعّل Claude fallback
  via: "keywords" | "claude";
}

function classifyByKeywords(text: string): ClassifyResult {
  let complaintHits = 0;
  let packageHits = 0;
  for (const re of COMPLAINT_PATTERNS) if (re.test(text)) complaintHits++;
  for (const re of PACKAGE_PATTERNS) if (re.test(text)) packageHits++;

  if (complaintHits >= 1 && complaintHits >= packageHits) {
    return { category: "complaint", confidence: complaintHits >= 2 ? 0.9 : 0.7, via: "keywords" };
  }
  if (packageHits >= 1) {
    // Travel-verb hits (pattern[4]) and destination-name hits (pattern[5]) are
    // strong-on-their-own signals — a single one is enough to skip the Claude
    // fallback. Otherwise need ≥2 hits for high confidence.
    const strongAlone =
      (PACKAGE_PATTERNS[4] && PACKAGE_PATTERNS[4].test(text)) ||
      (PACKAGE_PATTERNS[5] && PACKAGE_PATTERNS[5].test(text));
    const confidence = packageHits >= 2 || strongAlone ? 0.9 : 0.6;
    return { category: "package", confidence, via: "keywords" };
  }
  return { category: "general", confidence: 0.3, via: "keywords" };
}

async function classifyWithClaude(text: string): Promise<Category> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return "general";
  const anthropic = new Anthropic({ apiKey });
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    system:
      "أنت مصنّف رسائل واتساب لوكالة سياحية سعودية. صنّف الرسالة إلى واحدة فقط من: " +
      "general, package, complaint. أعد كلمة واحدة فقط بدون شرح.",
    messages: [{ role: "user", content: text }],
  });
  const out = res.content?.[0];
  const raw = out && out.type === "text" ? out.text.toLowerCase().trim() : "general";
  if (raw.includes("complaint")) return "complaint";
  if (raw.includes("package")) return "package";
  return "general";
}

async function classify(text: string): Promise<ClassifyResult> {
  const kw = classifyByKeywords(text);
  if (kw.confidence >= 0.7) return kw;
  // ثقة ضعيفة → Claude fallback
  try {
    const category = await classifyWithClaude(text);
    return { category, confidence: 0.85, via: "claude" };
  } catch {
    return kw; // فشل Claude؟ نتمسّك بأفضل تخمين من الكلمات
  }
}

// ── استخراج بيانات الباقة من نص حر ───────────────────────────────────────
// Convert Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits to ASCII.
// Customers commonly type "٢ شخص" / "١٥/٠٧/٢٠٢٦" which must parse like "2 شخص"
// / "15/07/2026".
function arabicToAsciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
}

function extractPersons(text: string): number | null {
  const normalized = arabicToAsciiDigits(text);
  // أرقام عربية أو لاتينية: "4 أشخاص" / "اثنين" / "ثلاثة"
  const m = normalized.match(/(\d+)\s*(?:شخص|أشخاص|اشخاص|راكب|مسافر)?/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) return n;
  }
  const words: Record<string, number> = {
    "واحد": 1, "اثنين": 2, "اثنان": 2, "ثلاثة": 3, "ثلاثه": 3,
    "اربعة": 4, "أربعة": 4, "اربعه": 4, "خمسة": 5, "خمسه": 5,
    "ستة": 6, "سته": 6, "سبعة": 7, "سبعه": 7, "ثمانية": 8, "ثمانيه": 8,
  };
  for (const [w, n] of Object.entries(words)) if (text.includes(w)) return n;
  return null;
}

// استخراج **صارم** لعدد المسافرين من كلام العميل فقط: لازم رقم بجانب كلمة شخص/نفر،
// أو صيغة مثنّى («شخصين/نفرين/اثنين»)، أو عدد مكتوب + كلمة أشخاص — حتى لا يلتبس
// برقم تاريخ أو سعر. يُستخدم كشبكة أمان لحارس العدد: لو العميل قال «شخصين» لا يعيد
// طلال السؤال. (المثنّى «شخصين» ما كان يُلتقَط إطلاقاً فيسأل طلال عن عدد قاله العميل.)
function extractPaxStrict(text: string): number | null {
  const t = arabicToAsciiDigits(text || "");
  // "N شخص/أشخاص/نفر/أفراد/بالغ/كبار/مسافر/راكب/معتمر"
  const m = t.match(/(\d{1,2})\s*(?:أشخاص|اشخاص|شخص|أنفار|انفار|نفر|أفراد|افراد|فرد|بالغين|بالغ|كبار|مسافرين|مسافر|ركاب|راكب|معتمرين|معتمر)/);
  if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 50) return n; }
  // المثنّى = ٢
  if (/شخصين|شخصان|نفرين|فردين|راكبين|معتمَرين\b|اثنين|اثنان|اثنتين/.test(text)) return 2;
  // عدد مكتوب ملتصق بكلمة أشخاص: «ثلاثة أشخاص»، «خمس بالغين»
  const wmap: Record<string, number> = { "ثلاث": 3, "أربع": 4, "اربع": 4, "خمس": 5, "ست": 6, "سبع": 7, "ثمان": 8, "تسع": 9, "عشر": 10 };
  for (const [w, n] of Object.entries(wmap)) {
    if (new RegExp(w + "[ةه]?\\s*(?:أشخاص|اشخاص|نفر|أفراد|افراد|بالغين|مسافرين|معتمرين|كبار)").test(text)) return n;
  }
  // «شخص واحد» / «فرد واحد بس» = ١
  if (/(?:شخص|نفر|فرد|راكب|مسافر|معتمر)\s*واحد|واحد\s*(?:بس|فقط)/.test(text)) return 1;
  return null;
}

function extractDate(text: string): string | null {
  const normalized = arabicToAsciiDigits(text);
  // dd/mm أو dd-mm أو dd/mm/yyyy
  const m = normalized.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    const year = m[3] || String(new Date().getFullYear() + (parseInt(m[2]) < new Date().getMonth() + 1 ? 1 : 0));
    return `${day}/${month}/${year.length === 2 ? "20" + year : year}`;
  }
  // شهر مكتوب: "في رمضان" / "شهر 7" / "يوليو"
  const monthMap: Record<string, number> = {
    "يناير": 1, "فبراير": 2, "مارس": 3, "ابريل": 4, "أبريل": 4, "مايو": 5, "يونيو": 6,
    "يوليو": 7, "اغسطس": 8, "أغسطس": 8, "سبتمبر": 9, "اكتوبر": 10, "أكتوبر": 10,
    "نوفمبر": 11, "ديسمبر": 12,
  };
  for (const [name, num] of Object.entries(monthMap)) {
    if (text.includes(name)) {
      const yr = new Date().getFullYear() + (num < new Date().getMonth() + 1 ? 1 : 0);
      return `01/${String(num).padStart(2, "0")}/${yr}`;
    }
  }
  return null;
}

// نستعير DEST_CITIES من Tourism-AI مبسطاً — لائحة كلمات وجهات كافية للتصنيف
// خريطة **شاملة** لكل مدن/وجهات الوكالة → اسم الدولة الصحيح. الغرض: منع
// النموذج من اختلاق اسم دولة خاطئ نهائياً (كان يقول «الإمارات» ومدنه صينية).
// كل مدينة تشير لدولتها بشكل قاطع؛ الترتيب من الأخص للأعم.
const DESTINATION_HINTS: Array<[RegExp, string]> = [
  [/الصين|china|شنغهاي|شنغاي|شانغهاي|shanghai|هان[غ]?[تش]?شو|hangzhou|سوجو|سوزهو|suzhou|بكين|beijing|هون[غجك]\s*كون[غجك]|hong\s*kong|[جق]وان?[غج]?زو|guangzhou|قوانزو|تشنغدو|chengdu|قويلين|guilin/i, "الصين"],
  [/فيتنام|vietnam|hanoi|هانوي|halong|ها\s*لونج|sapa|سابا|danang|دانانغ|phuquoc|فو\s*كووك|هوشي|ho\s*chi|نها\s*ترانج|nha\s*trang|هوي\s*ان|hoi\s*an/i, "فيتنام"],
  [/ماليزيا|مليزيا|malaysia|كوالا|kuala|langkawi|لنكاوي|لنكاوى|penang|بينانج|بينانغ|جنتنج|genting|ملاكا|malacca/i, "ماليزيا"],
  [/إندونيسيا|اندونيسيا|indonesia|بالي|bali|جاكرتا|jakarta|لومبوك|lombok|بندونق|bandung/i, "إندونيسيا"],
  [/تركيا|turkey|turkiye|اسطنبول|إسطنبول|istanbul|طرابزون|trabzon|بورصة|bursa|انطاليا|أنطاليا|antalya|كابادوكيا|cappadocia|سبانجا|sapanca|يلوا|yalova/i, "تركيا"],
  [/تايلاند|تايلند|thailand|بانكوك|bangkok|بوكيت|phuket|باتايا|pattaya|شنغماي|chiang\s*mai|كرابي|krabi|كوسموي|samui/i, "تايلاند"],
  [/البوسنة|البوسنه|bosnia|سراييفو|sarajevo|موستار|mostar|ياهورينا/i, "البوسنة"],
  [/روسيا|russia|موسكو|moscow|سوتشي|sochi|بطرسبرغ|petersburg|بطرسبورغ/i, "روسيا"],
  [/جنوب\s*[أا]فريقيا|south\s*africa|كيب\s*تاون|cape\s*town|جوهانسبرغ|johannesburg|hermanus|هيرمانوس|صن\s*سيتي|sun\s*city/i, "جنوب أفريقيا"],
  [/موريش[يو]س|mauritius/i, "موريشيوس"],
  [/المالديف|maldives|مالديف/i, "المالديف"],
  [/[أا]ذربيجان|azerbaijan|باكو|baku|قابالا|gabala/i, "أذربيجان"],
  [/جورجيا|georgia|تبليسي|tbilisi|باتومي|batumi/i, "جورجيا"],
  [/سريلانكا|sri\s*lanka|كولومبو|colombo/i, "سريلانكا"],
  // ٣ نوفمبر ٢٠٢٦: «مشرمن جده» (= مش من جدة) طابقت «شرم» → «تقصد تغيّر الوجهة إلى مصر؟». حدود كلمة عربية لمصر/شرم.
  [/(?<![ء-ي])[وبلف]?مصر(?![ء-ي])|egypt|القاهرة|cairo|(?<![ء-ي])شرم(?![ء-ي])|sharm|الغردقة|hurghada/i, "مصر"],
  [/المغرب|مغرب|morocco|مراكش|marrakech|الدار\s*البيضاء?|الدارالبيضاء?|casablanca|طنج[ةه]|tanger|[أا][كغ]ادير|agadir|[أا]غافاي|agafay|الصوير[ةه]|essaouira|الرباط|rabat/i, "المغرب"],
  [/[إا]يطاليا|italy|روما|rome|ميلان|milan|البندقية|venice|فلورنسا|florence/i, "إيطاليا"],
  [/[إا]سبانيا|spain|مدريد|madrid|برشلونة|barcelona/i, "إسبانيا"],
  [/فرنسا|france|باريس|paris/i, "فرنسا"],
  [/هولندا|netherland|أمستردام|امستردام|amsterdam/i, "هولندا"],
  [/بريطانيا|إنجلترا|انجلترا|england|britain|لندن|london|مانشستر|manchester/i, "إنجلترا"],
  // أبوظبي وجهة مُسعّرة عندنا (باقات ياس آيلاند) فتسبق التصنيف العام «الإمارات».
  [/[أا]بو\s*ظبي|abu\s*dhabi|abudhabi|ياس\s*آ?ايلاند|جزيرة\s*ياس|yas\s*island|عالم\s*فيراري|ferrari\s*world|وارنر\s*براذرز|warner\s*bros/i, "أبوظبي"],
  [/الإمارات|الامارات|uae|emirates|دبي|dubai|أبوظبي|ابوظبي|abu\s*dhabi|الشارقة|sharjah/i, "الإمارات"],
  [/عمرة|عُمرة|عمره|الحرمين|مكة|مكه|makkah|mecca|المدينة\s*المنورة|madinah|medina/i, "العمرة"],
  [/سلطنة\s*عمان|صلال[ةه]|salalah|مسقط|muscat|نزوى|صور\b/i, "عُمان"],
];

// ✍️ ٤ نوفمبر ٢٠٢٦: «جيب لي برنامج تلاتد» → طلال قال «ما فهمت». أقرب اسم وجهة لكلمة فيها غلط إملائي (نفس أول حرف،
//    مسافة تعديل صغيرة) → يسأل «تقصد تايلاند؟» بدل «ما فهمت». ❌ ما يفترض — يسأل بس.
function _lev(a: string, b: string): number {
  const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function fuzzyDestination(text: string): string | null {
  const norm = (x: string) => x.replace(/[إأآا]/g, "ا").replace(/[ةه]/g, "ه").replace(/ى/g, "ي").replace(/^ال/, "");
  const names = [...new Set(DESTINATION_HINTS.map(([, n]) => n))].filter(n => !/عمر/.test(n));
  let best: { n: string; d: number } | null = null;
  for (const tok of String(text || "").split(/[^\u0621-\u064A]+/).filter(t => t.length >= 5)) {
    const t = norm(tok);
    for (const n of names) {
      const nn = norm(n); if (nn[0] !== t[0]) continue;
      const dd = _lev(t, nn); const lim = Math.max(nn.length, t.length) >= 6 ? 3 : 2;
      if (dd > 0 && dd <= lim && (!best || dd < best.d)) best = { n, d: dd };
    }
  }
  return best ? best.n : null;
}
// ٤ نوفمبر ٢٠٢٦: «الي عمره ١٢ سنه» = سنّه، مو عمرة. عبارات العمر تنشال قبل كشف الوجهة.
function stripAgeWords(t: string): string {
  return String(t || "").replace(/(?:الي|اللي|كم|الطفل|طفل|ولد|بنت|الولد|البنت|ولدي|بنتي)\s*عمر(?:ه|ها|هم|ة)/g, " ")
    .replace(/عمر(?:ه|ها|هم)\s*(?:[0-9٠-٩]{1,2}|سن|سنة|سنه|سنوات)/g, " ");
}
function extractDestination(text: string): string | null {
  text = stripAgeWords(text);
  for (const [re, name] of DESTINATION_HINTS) if (re.test(text)) return name;
  return null;
}

// ── Greetings / acknowledgements that shouldn't burn a Claude call ───────
// If the customer's message is just a greeting or thanks, the welcome (for
// new sessions) is response enough, and existing sessions should stay silent
// rather than treating it as a "novel question". Compares to a normalised
// short list using the same Arabic normaliser used for FAQ matching.
const SMALL_TALK_TOKENS = new Set([
  "مرحبا", "مرحبه", "هلا", "اهلا", "اهلا وسهلا",
  "السلام عليكم", "وعليكم السلام", "سلام عليكم",
  "صباح الخير", "مساء الخير", "صباح النور", "مساء النور",
  "تحية طيبه", "حياك", "حياك الله",
  "شكرا", "شكرا لك", "مشكور", "مشكوره", "تسلم", "يسلموا",
  "تمام", "اوكي", "اوك", "حسنا", "ماشي",
  "ممتاز", "زين", "كويس", "حلو", "جميل", "رائع", "اي", "ايوه", "ايوا", "أيوه", "أيوا",
  "ok", "okay", "thanks", "thank you", "hi", "hello",
]);
function isSmallTalk(text: string): boolean {
  // Reuse the same normaliser the FAQ matcher uses (declared below).
  const norm = String(text)
    .replace(/[إأآا]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[ؤئء]/g, "").replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[؟?!,.،؛:]/g, " ").replace(/\s+/g, " ")
    .trim().toLowerCase();
  if (!norm) return true;
  if (norm.length > 30) return false;  // too long to be just small talk
  return SMALL_TALK_TOKENS.has(norm);
}

// Opener-style greetings only (no acknowledgements like شكرا / تمام). These
// route to the Travel Agent so RULE 1 fires and the customer gets the exact
// "هلا 👋 أمرني كيف أقدر أخدمك؟" reply instead of falling through to the
// FAQ/small-talk silent path.
const GREETING_TOKENS = new Set([
  "مرحبا", "مرحبه", "هلا", "اهلا", "اهلا وسهلا",
  "السلام عليكم", "وعليكم السلام", "سلام عليكم", "سلام",
  "صباح الخير", "مساء الخير", "صباح النور", "مساء النور",
  "حياك", "حياك الله",
  "لو سمحت", "اخوي", "اقولك",
  "hi", "hello", "hey",
]);
function isGreeting(text: string): boolean {
  const norm = String(text)
    .replace(/[إأآا]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[ؤئء]/g, "").replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[؟?!,.،؛:]/g, " ").replace(/\s+/g, " ")
    .trim().toLowerCase();
  if (!norm || norm.length > 30) return false;
  return GREETING_TOKENS.has(norm);
}

// "Is anyone there?" / "are you with me?" presence checks. Distinct from
// greetings because they expect a presence acknowledgement, not a fresh
// "how can I help" opener — and CASE 2 directly contradicts the welcome
// ("معك طلال" vs "ما أنا معاك") so the handler skips the welcome when this
// fires. Includes a few staff-name variants ("معي طلال") but the reply
// NEVER claims any specific human name.
const PRESENCE_TOKENS = new Set([
  "في احد", "فيه احد", "في حد", "فيه حد",
  "معي احد", "معي حد", "معاي احد", "معاي حد",
  "موجود", "موجودين", "في موجود", "فيه موجود",
  "معي طلال", "في طلال", "فيه طلال", "وين طلال",
  "معي الموظف", "في الموظف", "وين الموظف", "وين المسوول",
  "ولا رد", "في رد",
]);
function isPresenceCheck(text: string): boolean {
  const norm = String(text)
    .replace(/[إأآا]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[ؤئء]/g, "").replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[؟?!,.،؛:]/g, " ").replace(/\s+/g, " ")
    .trim().toLowerCase();
  if (!norm || norm.length > 40) return false;
  if (PRESENCE_TOKENS.has(norm)) return true;
  // "محد رد" / "ولا أحد رد" / "ما حد يرد"
  if (/^(?:محد|ولا\s+احد|ما\s+حد|ما\s+احد)\s+(?:رد|يرد)$/.test(norm)) return true;
  return false;
}

// Personal greetings where the customer addresses the bot by name. Each
// normalized phrase maps to its specific Khaleeji reply. Sent verbatim — no
// AI generation. Keys are post-normalization (أ→ا, ة→ه, ى→ي, tashkeel and
// punctuation stripped). Values keep their commas/emojis as written.
const PERSONAL_GREETING_REPLIES: Record<string, string> = {
  "هلا طلال":               "يا هلا وغلا 👋 تفضل",
  "هلا والله طلال":         "يا هلا وغلا 👋 تفضل",
  "اهلا طلال":              "أهلين فيك 👋 تفضل",
  "اهلين طلال":             "أهلين فيك 👋 تفضل",
  "كيف حالك طلال":          "الحمد لله بخير أبشرك 👌 أمرني",
  "كيفك طلال":              "الحمد لله بخير أبشرك 👌 أمرني",
  "كيف الحال طلال":         "الحمد لله بخير أبشرك 👌 أمرني",
  "شلونك طلال":             "بخير ولله الحمد 👌 أمرني",
  "شلون حالك طلال":         "بخير ولله الحمد 👌 أمرني",
  "صباح الخير طلال":        "صباح النور والسرور 🌷 تفضل",
  "مساء الخير طلال":        "مساء الخير 👌 حياك الله، أمرني",
  "يعطيك العافيه طلال":     "الله يعافيك ويبارك فيك 👌 تفضل",
  "الله يعطيك العافيه طلال": "الله يعافيك ويبارك فيك 👌 تفضل",
  "حياك طلال":              "هلا فيك 👋 تفضل",
  "حياك الله طلال":         "هلا فيك 👋 تفضل",
  "الله يحييك طلال":        "هلا فيك 👋 تفضل",
  "هلا فيك طلال":           "يا هلا وغلا 👋 تفضل",
};
function getPersonalGreetingReply(text: string): string | null {
  const norm = String(text)
    .replace(/[إأآا]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[ؤئء]/g, "").replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[؟?!,.،؛:]/g, " ").replace(/\s+/g, " ")
    .trim().toLowerCase();
  if (!norm || norm.length > 50) return null;
  return PERSONAL_GREETING_REPLIES[norm] ?? null;
}

// ── Arabic normalisation for keyword matching ─────────────────────────────
// Saudi/Omani dialect commonly swaps ة↔ه, uses various alef forms, drops
// hamzas, and writes ى for ي. Normalise both haystack and keywords before
// comparing so trivial spelling differences don't block FAQ matches.
function normalizeArabic(s: string): string {
  return String(s)
    .replace(/[إأآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ؤئء]/g, "")
    .replace(/[ًٌٍَُِّْـ]/g, "")          // remove tashkeel + tatweel
    .replace(/[؟?!,.،؛:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ── FAQ lookup against ALEZZ Chat sheet (synced into chat_answers) ────────
// Strategy: count keyword overlaps per row, pick the highest-scoring row.
// For the chosen row, prefer Answer_OM (Omani customers) → fallback SA1 →
// fallback to clarification. Returns null if no row matched any keyword.
async function findFaqAnswer(
  supabase: ReturnType<typeof createClient>,
  text: string,
  customerStage?: string | null,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("chat_answers")
    .select("id, sub_intent, keywords, answer_sa1, answer_om, answer_clarification, stage");
  if (error || !data) return null;

  const haystack = normalizeArabic(text);

  // Word-bounded match: `كم` must not match inside `عندكم`. Boundary = string
  // edge OR any non-letter (whitespace, punctuation). \p{L} covers Arabic +
  // Latin letters. Bare 2-char keywords are too noisy to substring-match
  // anyway, so we also require at least 3 normalised chars for short tokens
  // unless surrounded by clear word boundaries.
  // Arabic prepositions like ال/بال/ب/ل/ف/و/ك attach directly to nouns without
  // spaces (بالفيزا، الطيران، وفيزا) — accept them as optional prefixes so the
  // keyword still matches its natural context.
  const matchesAsWord = (kw: string): boolean => {
    if (kw.length < 2) return false;
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(^|[^\\p{L}])(?:ال|بال|وال|فال|لال|كال|[بلفوك])?${escaped}([^\\p{L}]|$)`,
      "u",
    );
    return re.test(haystack);
  };

  // "Weak" keywords — generic words that appear in many customer questions
  // and shouldn't qualify a row as a match on their own. PKG0067 (about
  // duration) had "البرنامج" as a keyword which was matching ANY question
  // mentioning the program (incl. "البرنامج ايش يشمل"), producing
  // false-positive duration answers. A row that only matches via these
  // weak keywords is skipped → no FAQ match → admin escalation fires.
  const WEAK_KEYWORDS = new Set([
    "البرنامج", "البرامج", "الرحله", "الرحلات", "السفر",
    "العرض", "العروض", "الباقه", "الباقات", "البكج", "البكجات",
    "الفندق", "الفنادق", "الطيران",
    "برنامج", "رحله", "عرض", "باقه", "بكج", "فندق",
  ]);

  // Score rows by *length-weighted* keyword matches so a long phrase like
  // "السفر مع الحيوانات" beats short generic keywords like "سفر" that
  // appear in many rows. Each matched keyword contributes its char length
  // (capped at 20) to the row's score; a row needs ≥1 STRONG keyword
  // (non-weak) to be in the running.
  // Stage-aware scoring: a row whose stage exactly matches the customer's
  // current stage gets a +5 score boost, so it wins over a stage-agnostic
  // (NULL) row when both match. Rows with a DIFFERENT stage are dropped
  // entirely — they don't apply to this customer's current point in the
  // journey.
  const currentStage = (customerStage || "").toUpperCase();
  let best: { score: number; matchCount: number; strongCount: number; row: typeof data[number] } | null = null;
  for (const row of data as Array<{
    id: string; sub_intent: string; keywords: string[];
    answer_sa1: string; answer_om: string; answer_clarification: string;
    stage: string | null;
  }>) {
    const rowStage = (row.stage || "").toUpperCase();
    // Skip rows scoped to a different stage. NULL/empty stage = ALL stages,
    // and is always eligible.
    if (rowStage && currentStage && rowStage !== currentStage) continue;
    let score = 0;
    let matchCount = 0;
    let strongCount = 0;
    for (const kwRaw of row.keywords) {
      const kw = normalizeArabic(kwRaw);
      if (matchesAsWord(kw)) {
        matchCount++;
        score += Math.min(kw.length, 20);
        if (!WEAK_KEYWORDS.has(kw)) strongCount++;
      }
    }
    if (matchCount === 0) continue;
    // Strict mode (admin's policy): a row qualifies only when the question
    // matches the row STRONGLY — at least two distinct keyword matches AND
    // at least one of them is non-weak. Single-keyword matches (even of
    // strong destination names like "ماليزيا") are NOT enough — those
    // escalate to admin so the AI suggests a reply and the admin decides
    // the exact answer + category. Trades some auto-answer coverage for
    // accuracy + a growing curated FAQ over time.
    if (matchCount < 2) continue;
    if (strongCount === 0) continue;
    // Exact stage match → priority boost so it outranks a fallback
    // ALL-stage row of similar keyword strength.
    if (rowStage && rowStage === currentStage) score += 5;
    if (!best || score > best.score) best = { score, matchCount, strongCount, row };
  }
  if (!best) return null;

  const r = best.row;
  return (r.answer_om && r.answer_om.trim())
      || (r.answer_sa1 && r.answer_sa1.trim())
      || (r.answer_clarification && r.answer_clarification.trim())
      || null;
}

// ── HubSpot CRM ───────────────────────────────────────────────────────────
// مفتاح الدولة في رقم الواتساب → اسم الدولة الإنجليزي القياسي (خاصية HubSpot
// `country` المدمجة). مرتّبة بطول المفتاح تنازلياً ليتطابق الأطول أولاً.
const PHONE_COUNTRY: Array<[string, string]> = [
  ["966", "Saudi Arabia"], ["971", "United Arab Emirates"], ["965", "Kuwait"],
  ["973", "Bahrain"], ["974", "Qatar"], ["968", "Oman"], ["967", "Yemen"],
  ["962", "Jordan"], ["961", "Lebanon"], ["963", "Syria"], ["964", "Iraq"],
  ["970", "Palestine"], ["218", "Libya"], ["216", "Tunisia"], ["213", "Algeria"],
  ["212", "Morocco"], ["249", "Sudan"], ["880", "Bangladesh"], ["20", "Egypt"],
  ["90", "Turkey"], ["98", "Iran"], ["91", "India"], ["92", "Pakistan"],
  ["62", "Indonesia"], ["60", "Malaysia"], ["63", "Philippines"], ["66", "Thailand"],
  ["84", "Vietnam"], ["86", "China"], ["7", "Russia"], ["44", "United Kingdom"],
  ["33", "France"], ["49", "Germany"], ["1", "United States"],
].sort((a, b) => b[0].length - a[0].length);
function countryFromPhone(phone: string): string | null {
  const digits = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
  for (const [code, name] of PHONE_COUNTRY) {
    if (digits.startsWith(code)) return name;
  }
  return null;
}

async function upsertHubspotContact(args: {
  phone: string;           // whatsapp:+9665XXX → نشيل بادئة whatsapp:
  name: string;
  destination?: string | null;
  persons?: number | null;
  date?: string | null;
}): Promise<string | null> {
  const apiKey = Deno.env.get("HUBSPOT_API_KEY");
  if (!apiKey) {
    console.warn("HUBSPOT_API_KEY missing — skipping CRM upsert");
    return null;
  }
  const phone = args.phone.replace(/^whatsapp:/, "");
  const [firstname, ...rest] = (args.name || "WhatsApp Client").split(/\s+/);
  const lastname = rest.join(" ") || "-";

  // Only standard HubSpot contact properties — destination/persons/date are
  // captured in the staff WhatsApp notification and whatsapp_sessions table,
  // so we don't need them on the contact. Add custom props here only after
  // creating them under Settings → Properties → Contact properties in HubSpot.
  const props: Record<string, string> = {
    phone,
    firstname,
    lastname,
    hs_lead_status: "NEW",
    lifecyclestage: "lead",
  };
  // الدولة من مفتاح الرقم → خاصية HubSpot المدمجة `country` (نص قياسي إنجليزي).
  const country = countryFromPhone(phone);
  if (country) props.country = country;

  // البحث بالرقم أولاً (upsert بسيط بدون استخدام custom unique property)
  const searchRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }],
        properties: ["phone"],
        limit: 1,
      }),
    },
  );
  if (searchRes.ok) {
    const found = await searchRes.json();
    const existingId = found?.results?.[0]?.id;
    if (existingId) {
      await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${existingId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });
      return existingId;
    }
  }
  const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: props }),
  });
  if (!createRes.ok) {
    console.error("HubSpot create failed", await createRes.text());
    return null;
  }
  const created = await createRes.json();
  return created?.id ?? null;
}

async function createHubspotTicket(args: {
  contactId: string | null;
  subject: string;
  body: string;
  phone: string;
}): Promise<void> {
  const apiKey = Deno.env.get("HUBSPOT_API_KEY");
  if (!apiKey) return;
  const ticketRes = await fetch("https://api.hubapi.com/crm/v3/objects/tickets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        subject: args.subject,
        content: args.body,
        hs_pipeline: "0",          // default pipeline
        hs_pipeline_stage: "1",    // "new" stage of default pipeline
        hs_ticket_priority: "HIGH",
        source_type: "CHAT",
      },
    }),
  });
  if (!ticketRes.ok) {
    console.error("HubSpot ticket failed", await ticketRes.text());
    return;
  }
  const ticket = await ticketRes.json();
  if (args.contactId && ticket?.id) {
    await fetch(
      `https://api.hubapi.com/crm/v3/objects/tickets/${ticket.id}/associations/contacts/${args.contactId}/16`,
      { method: "PUT", headers: { Authorization: `Bearer ${apiKey}` } },
    );
  }
}

// ── Twilio outbound ───────────────────────────────────────────────────────

// Light human-feel delay before sending. Kept short so concurrent webhook
// invocations don't pile up — each sendWhatsapp call holds the function
// open for delay+fetch, and stacked delays were a likely contributor to
// occasional handleMessage hangs under load.
function humanTypingDelayMs(text: string): number {
  const n = (text || "").length;
  if (n <= 50)  return 600;
  if (n <= 150) return 900;
  return 1200;
}

// Wrapper around sendWhatsapp that ALSO stamps last_outbound_at on the
// customer's session. Use this for every customer-facing reply (FAQ,
// greeting, welcome, presence check, admin approval, manual reply via
// the dashboard). Don't use it for sendStaffNotice / staff warnings —
// those go to the staff number and shouldn't reset the "unanswered"
// flag for the customer.
// فلتر أمان: يشيل عبارات المدح/الحشو/المجاملة الممنوعة من رد طلال قبل الإرسال،
// حتى لو انزلقت من الموديل رغم منعها في البرومبت. ثم ينظّف الفراغات والعلامات.
// keepRich=true: للعروض المنسّقة (برنامج العميل) — نُبقي الإيموجي والأسطر الفارغة
// (تنسيق مقصود)، ونكتفي بتجريد التشكيل والعبارات الممنوعة. الوضع الافتراضي (ردود
// طلال العادية) يجرّد الإيموجي ويضغط الفراغات كالسابق.
function stripBannedPhrases(text: string, keepRich = false): string {
  if (!text) return text;
  // تجريد كل التشكيل (الحركات: فتحة/ضمة/كسرة/شدّة/تنوين/سكون + الألف الخنجرية)
  // ضمانًا لانطباع كتابة بشرية على واتساب — حتى لو أضاف الـLLM حركات رغم التعليمات.
  let t = text.replace(/[ً-ْٰ]/g, "");
  // تجريد كل الإيموجي والرموز التصويرية (🌟🙏👍🌹🌙👶😊🕋👋…) — المالكة تبي
  // ردوداً تبدو بشرية بلا إيموجي إطلاقاً، حتى لو أضافها الـLLM أو قالب ثابت.
  // (يُستثنى العرض المنسّق keepRich — إيموجيّاته مقصودة.)
  if (!keepRich) t = t.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}‍️⃣]/gu, "");
  // حذف مخاطبة «أستاذي/أستاذتي» المتكرّرة — لا تُستخدم في كل رسالة (تكرارها يبيّن
  // إنه بوت). المالكة: «ما في داعي يقول أستاذي». نُبقي بقية الجملة طبيعية.
  t = t.replace(/(^|[\s،.])(?:يا\s+)?أستاذ(?:تي|ي)?(?=$|[\s،.!؟…])/gu, "$1");
  const banned: RegExp[] = [
    /تمام\s+تمام/g, /تمام\s+التمام/g,
    /تمام\s+نمرة\s*واحدة/g, /نمرة\s+واحدة/g,
    /إن\s*شاء\s*الله\s+تمام(\s+التمام)?/g,
    /وش\s+(أخبارك|اخبارك)/g, /كيف\s+حالك/g, /كيف\s+الحال/g,
    /اختيار\s+(?:حلو|موفق|رائع|ممتاز|جميل)/g,
    // مجاملة الوجهة/المدينة ممنوعة («ماليزيا وجهة حلوة»، «اختيار ممتاز»…).
    /(?:وجه[ةه]|مدين[ةه]|بلد|اختيار)\s+(?:حلو[ةه]?|ممتاز[ةه]?|رائع[ةه]?|جميل[ةه]?|موفق[ةه]?|خراف[يه]?|مميز[ةه]?)/g,
    /(?:حلو|ممتاز|رائع|جميل|روعة)\s*!+/g,
    /(?:ما\s*شاء\s*الله|الله\s+يعطيك\s+العافية|الله\s+يسعدك|تسلم)\b/g,
    /أنا\s+هنا\s+لتجميع\s+معلوماتك/g, /أنا\s+هنا\s+لمساعدتك/g,
    /شكراً\s+على\s+(?:المعلومة|التواصل)/g,
    // عبارات افتراضية/وعدية غير مناسبة بالعمرة (المالكة: «حاضر/أبشر» فقط).
    // ملاحظة: \b لا يعمل مع الحروف العربية في JS، فنعتمد على اللاحقة الصريحة.
    /(?:أبشر|ابشر)\s+نساعدك\s+ب?عمرت(?:كم|كن|كما|ك)?/g,
    /مبارك(?:ة)?\s+ب?عمرت(?:كم|كن|كما|ك)?/g,
  ];
  // «أبشر بعمرتكم» → «أبشر» (نُبقي الأدب ونحذف الافتراض).
  t = t.replace(/(أبشر|ابشر)\s+ب?عمرت(?:كم|كن|كما|ك)?/g, "$1");
  for (const re of banned) t = t.replace(re, " ");
  if (keepRich) {
    // تنظيف خفيف يحافظ على الأسطر الفارغة (التنسيق): فراغات مزدوجة فقط + أسطر فارغة متتالية ≤1.
    t = t.replace(/[ \t]{2,}/g, " ")
         .replace(/[ \t]+\n/g, "\n")
         .replace(/\n{3,}/g, "\n\n")
         .trim();
    return t;
  }
  // تنظيف ما تبقّى من فراغات/علامات بعد الحذف (ردود عادية — يضغط كل الفراغات).
  t = t.replace(/[ \t]{2,}/g, " ")               // فراغات مزدوجة
       .replace(/\s+([،.!؟…])/g, "$1")           // فراغ قبل علامة
       .replace(/[،.!؟…]\s*(?=[،.!؟…])/g, "")    // علامتان متتاليتان → الأخيرة فقط
       .replace(/^[\s،.!؟…]+/, "")                // علامات/فراغ في البداية
       .replace(/\s{2,}/g, " ")
       .trim();
  return t;
}

async function sendCustomerReply(
  supabase: ReturnType<typeof createClient>,
  to: string,
  body: string,
  mediaUrl?: string,
  opts?: { keepRich?: boolean },
): Promise<string | null> {
  body = stripBannedPhrases(body, opts?.keepRich === true);
  // تأخير طبيعي بزمن «الكتابة» قبل إرسال رد البوت — حتى لا يبدو رداً آلياً فورياً.
  // خفيف ومتناسب مع طول الرسالة (يُضاف فوق زمن معالجة الذكاء)، بحد أقصى ١.٥ ثانية
  // (قُلّص من ٤.٥ بطلب المالكة ١ نوفمبر ٢٠٢٦ — الردود كانت تبان متأخرة).
  if (body) {
    const delayMs = Math.min(1500, 400 + body.length * 20);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const sid = await sendWhatsapp(to, body, mediaUrl);
  // Update session last_outbound_at + last_outbound_body so the
  // dashboard preview can show whichever side spoke last. For pure media
  // sends, use a "[ملف مرفق]" placeholder so the preview line stays
  // meaningful instead of blank.
  const previewBody = body || (mediaUrl ? "📎 [ملف مرفق]" : "");
  try {
    await supabase.from("whatsapp_sessions")
      .update({
        last_outbound_at: new Date().toISOString(),
        last_outbound_body: previewBody.slice(0, 500),
      })
      .eq("phone", to);
  } catch (_) { /* best-effort */ }
  return sid;
}

// Meta (Cloud API/Graph) WhatsApp text body limit = 4096 chars. نرسل العرض
// المنسّق **رسالة واحدة** (كان الحدّ 1500 من عهد Twilio فينقسم البرنامج نصّين).
// نقسّم فقط ما تجاوز ~4000 (حدّ Meta الآمن) على حدود طبيعية:
// فقرة → سطر → جملة → مسافة → قصّ صلب.
function splitForWhatsApp(text: string, maxLen = 4000): string[] {
  if (!text || text.length <= maxLen) return text ? [text] : [];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    const minSplit = Math.floor(maxLen * 0.4);
    // try double newline → single newline → sentence end → space → hard
    const candidates = [
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "),
               window.lastIndexOf("? "), window.lastIndexOf("، "),
               window.lastIndexOf("؟ "), window.lastIndexOf("؛ ")),
      window.lastIndexOf(" "),
    ];
    let splitIdx = candidates.find(i => i >= minSplit) ?? -1;
    if (splitIdx < minSplit) splitIdx = maxLen;   // hard cut fallback
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

// آخر سبب فشل إرسال (نص أو وسائط) من Graph — يقرأه send_admin_message ليُظهر
// للموظفة سبب عدم وصول الرسالة/الملف بدل «تم» الكاذبة. أفضل-جهد (قد يُداس عند
// إرسالين متزامنين) لكنه كافٍ للتشخيص؛ نجاح/فشل الإرسال نفسه يُحدَّد من القيمة المُعادة.
let lastWhatsappError = "";
async function sendWhatsapp(to: string, body: string, mediaUrl?: string): Promise<string | null> {
  lastWhatsappError = "";
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    console.warn("Cloud API credentials missing — would have sent to", to, ":", body);
    lastWhatsappError = "Cloud API credentials missing (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)";
    return null;
  }
  // ترجمة الحدّ الصادر: التمثيل الداخلي "whatsapp:+968…" → "968…" لـ Graph.
  const graphTo = internalToGraph(to);
  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  // POST نصّي واحد لـ Graph. يرجّع messages[0].id أو null عند الفشل (مع لوق).
  const postOne = async (chunkBody: string): Promise<string | null> => {
    if (!chunkBody) return null;   // Graph يرفض رسالة نصية فارغة.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: graphTo,
        type: "text",
        text: { body: chunkBody },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Cloud API send failed", to, res.status, errText.slice(0, 400));
      lastWhatsappError = `text ${res.status}: ${errText.slice(0, 300)}`;
      return null;
    }
    try {
      const data = await res.json();
      const id = data?.messages?.[0]?.id;
      return typeof id === "string" ? id : null;
    } catch { return null; }
  };

  // ── إرسال الوسائط (PDF/صورة) عبر Graph ───────────────────────────────────
  // كان معطّلاً بعد الهجرة من Twilio فالملف ما يصل العميل (يُرسَل نصّ فقط، ولو
  // بلا نص لا شيء). الـbucket عام (getPublicUrl) فـMeta يقدر يجيب الرابط.
  // PDF/غير الصور → document (مع اسم ملف)، الصور → image، وcaption لو فيه نص قصير.
  if (mediaUrl) {
    const cleanUrl = mediaUrl.split("?")[0];
    const isImage = /\.(jpe?g|png|webp|gif)$/i.test(cleanUrl);
    const mediaType = isImage ? "image" : "document";
    const mediaObj: Record<string, unknown> = { link: mediaUrl };
    const caption = (body && body.trim() && body.length <= 1024) ? body.trim() : "";
    if (caption) mediaObj.caption = caption;
    if (!isImage) {
      const fname = decodeURIComponent(cleanUrl.split("/").pop() || "").trim();
      mediaObj.filename = fname || "برنامج.pdf";
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: graphTo, type: mediaType, [mediaType]: mediaObj }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Cloud API media send failed", to, res.status, errText.slice(0, 400));
      lastWhatsappError = `media ${res.status}: ${errText.slice(0, 300)}`;
      return null;
    }
    let mediaId: string | null = null;
    try {
      const data = await res.json();
      const id = data?.messages?.[0]?.id;
      mediaId = typeof id === "string" ? id : null;
    } catch { /* ignore */ }
    // نصّ أطول من حدّ الـcaption (1024) → أرسله رسائل نصية بعد الملف.
    if (body && body.length > 1024) {
      for (const chunk of splitForWhatsApp(body)) {
        await postOne(chunk);
        await new Promise(r => setTimeout(r, 600));
      }
    }
    return mediaId;
  }

  const chunks = splitForWhatsApp(body);
  // لا نص للإرسال (كان رسالة وسائط بحتة في Twilio) — لا شيء يُرسَل بعد.
  if (chunks.length === 0) {
    return null;
  }
  // Short message (single chunk) — preserve the human-typing delay.
  if (chunks.length <= 1) {
    await new Promise(r => setTimeout(r, humanTypingDelayMs(body)));
    return await postOne(chunks[0] || "");
  }
  // Long message — fire each chunk sequentially with a small gap so
  // WhatsApp renders them in order.
  let lastId: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const idOrNull = await postOne(chunks[i]);
    if (idOrNull) lastId = idOrNull;
    if (!isLast) {
      // 700ms gap — keeps message order on the WhatsApp side.
      await new Promise(r => setTimeout(r, 700));
    }
  }
  return lastId;
}

// Send an approved WhatsApp template — REQUIRED to initiate a conversation
// with a number that hasn't messaged us in the last 24h.
//
// TODO(templates): تحويل بنيوي لصيغة Graph أُنجز، لكنه لن يعمل فعلياً حتى:
//   1. تُعتمد قوالب في Meta Business Manager (اسم القالب + لغة).
//   2. يُخزَّن اسم القالب المعتمد في wa_settings (مفتاح greeting_template_sid
//      كان يحمل Twilio ContentSid — لازم يُستبدل باسم قالب Meta الحقيقي).
//   3. تُضبط لغة القالب الصحيحة (نفترض "ar" مبدئياً).
// المتغيّر الثاني (templateName) كان سابقاً ContentSid؛ نعيد تفسيره كاسم
// قالب Meta. المتغيّرات (vars) تتحوّل إلى body component parameters بالترتيب.
// يرمي عند خطأ Graph حتى يُظهر المنادي السبب (قالب غير معتمد، عدم تطابق متغيّرات).
async function sendWhatsappTemplate(
  to: string,
  templateName: string,
  contentVariables?: Record<string, string>,
  languageCode = "ar",
): Promise<string | null> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    console.warn("Cloud API credentials missing — would have sent template to", to);
    throw new Error("Cloud API credentials missing");
  }
  // ترتيب المتغيّرات حسب المفتاح الرقمي ("1","2",…) كما كان مع ContentVariables.
  const orderedVars = contentVariables
    ? Object.keys(contentVariables)
        .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
        .map(k => ({ type: "text", text: String(contentVariables[k]) }))
    : [];
  const components = orderedVars.length
    ? [{ type: "body", parameters: orderedVars }]
    : [];
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: internalToGraph(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("Cloud API template send failed", to, res.status, errText.slice(0, 400));
    throw new Error("graph " + res.status + ": " + errText.slice(0, 200));
  }
  try {
    const data = await res.json();
    const id = data?.messages?.[0]?.id;
    return typeof id === "string" ? id : null;
  } catch { return null; }
}

// اكتشاف مُعرّف حساب واتساب للأعمال (WABA) اللازم لإنشاء/إدارة القوالب على Meta.
// نجرّب بالترتيب: (١) متغيّر بيئة صريح، (٢) حقل whatsapp_business_account على عقدة
// رقم الهاتف، (٣) granular_scopes من debug_token. نرجّع المُعرّف وطريقة اكتشافه
// (how) وأي تشخيص مفيد عند الفشل.
// نُخزّن WABA id المُلتقَط من الويبهوك (entry.id) لتفادي كتابة DB متكرّرة.
let _capturedWaba = "";

// يضمن وجود قالب ترحيب معتمد على Meta. يُستدعى مرة عند التقاط WABA من الويبهوك.
// لو القالب محفوظ بالفعل باسم Meta صحيح (ليس فارغاً وليس ContentSid قديم HX…)
// يخرج فوراً. وإلا ينشئ القالب ويحفظ اسمه. كله best-effort داخل try/catch حتى
// لا يؤثّر على مسار معالجة الرسائل الحسّاس.
async function ensureGreetingTemplate(
  supabase: ReturnType<typeof createClient>, waba: string,
): Promise<void> {
  try {
    const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
    if (!token || !waba) return;
    const { data } = await supabase.from("wa_settings").select("value").eq("key", "greeting_template_sid").maybeSingle();
    const cur = String((data as { value?: unknown } | null)?.value || "").trim();
    // اسم Meta صحيح موجود؟ (ليس فارغاً وليس ContentSid تويليو HX…) → لا شيء نفعله.
    if (cur && !/^HX/i.test(cur)) return;
    const name = "alezz_greeting";
    const language = "ar";
    const body = "مرحباً {{1}} 🌟\nشكراً لتواصلك مع وكالة العز للسياحة والسفر. يسعدنا خدمتك — وش الوجهة اللي تفكّر فيها، وكم عدد المسافرين والتاريخ المتوقع؟";
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${waba}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, language, category: "UTILITY", components: [{ type: "BODY", text: body, example: { body_text: [["العميل"]] } }] }),
    });
    const j = await res.json().catch(() => ({}));
    const errCode = (j as { error?: { code?: number; message?: string } })?.error?.code;
    const already = errCode === 100 && /already exists|name.*exist/i.test(String((j as { error?: { message?: string } })?.error?.message || ""));
    if (res.ok || already) {
      await supabase.from("wa_settings").upsert([
        { key: "greeting_template_sid", value: name, updated_at: new Date().toISOString() },
        { key: "greeting_template_lang", value: language, updated_at: new Date().toISOString() },
        { key: "whatsapp_waba_id", value: waba, updated_at: new Date().toISOString() },
      ]);
      console.log("ensureGreetingTemplate: template ensured", name, already ? "(existed)" : "(created)");
    } else {
      console.warn("ensureGreetingTemplate failed", JSON.stringify((j as { error?: unknown })?.error ?? j).slice(0, 200));
    }
  } catch (e) { console.warn("ensureGreetingTemplate error", (e as Error).message); }
}

async function discoverWabaId(token: string, phoneNumberId: string): Promise<{ waba: string | null; how: string; diag: string }> {
  const envWaba = (Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "").trim();
  if (envWaba) return { waba: envWaba, how: "env", diag: "" };
  let diag = "";
  // (٢) حقل على عقدة رقم الهاتف
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}?fields=whatsapp_business_account{id,name}&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const id = (j as { whatsapp_business_account?: { id?: string } })?.whatsapp_business_account?.id;
    if (id) return { waba: String(id), how: "phone_field", diag: "" };
    diag += "phone_field:" + JSON.stringify(j).slice(0, 200) + " ";
  } catch (e) { diag += "phone_field_err:" + (e as Error).message + " "; }
  // (٣) debug_token → granular_scopes → target_ids
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const scopes = (j as { data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } })?.data?.granular_scopes || [];
    for (const s of scopes) {
      if (String(s?.scope || "").includes("whatsapp_business") && Array.isArray(s?.target_ids) && s.target_ids.length) {
        return { waba: String(s.target_ids[0]), how: "debug_token", diag: "" };
      }
    }
    diag += "debug_token:" + JSON.stringify(scopes).slice(0, 200) + " ";
  } catch (e) { diag += "debug_token_err:" + (e as Error).message + " "; }
  return { waba: null, how: "none", diag };
}

function staffList(envVar: string): string[] {
  return (Deno.env.get(envVar) || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.startsWith("whatsapp:") ? s : `whatsapp:${s}`);
}

// ── Watchdog: detect inbound messages that handleMessage never finished ──
// Every Twilio webhook inserts a wa_message_audit row at 'received'.
// handleMessage flips it to 'completed' on success or 'errored' on
// exception. If neither fires within the threshold (function killed in
// the background after returning TwiML, etc.), this sweep marks it
// 'stalled' and pings admins so the customer's message isn't silently
// dropped. Runs at every incoming webhook — no separate cron needed.
const STALL_THRESHOLD_MS = 60_000;
async function checkStalledMessages(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const cutoff = new Date(Date.now() - STALL_THRESHOLD_MS).toISOString();
  const { data: stalled, error } = await supabase
    .from("wa_message_audit")
    .select("id, from_phone, body, received_at")
    .eq("status", "received")
    .lt("received_at", cutoff)
    .order("received_at", { ascending: true })
    .limit(20);
  if (error || !stalled || stalled.length === 0) return;

  // Flip them so the next sweep doesn't realert on the same rows.
  await supabase.from("wa_message_audit")
    .update({ status: "stalled" })
    .in("id", (stalled as Array<{ id: string }>).map(s => s.id));

  const admins = staffList("SALES_WHATSAPP_NUMBERS");
  if (admins.length === 0) return;

  const rows = stalled as Array<{
    id: string; from_phone: string; body: string | null; received_at: string;
  }>;
  const lines = rows.map((s) => {
    const ph = String(s.from_phone).replace(/^whatsapp:/, "");
    const text = String(s.body || "").slice(0, 120);
    const t = s.received_at?.replace("T", " ").slice(0, 19) || "";
    return `• ${t}\n  ${ph}: ${text}`;
  });
  const notice =
    `🔁 ${rows.length} رسالة لم يكتمل الرد عليها (تجاوزت ${STALL_THRESHOLD_MS / 1000}s)\n\n` +
    lines.join("\n\n") +
    `\n\nراجعوها ورودوا على العملاء يدوياً 🙏`;
  for (const admin of admins) {
    try { await sendStaffNotice(admin, notice); } catch (_) {}
  }
}

// ── Watchdog: detect a TOTAL inbound outage ──────────────────────────────
// حادثة ٥-٦ أكتوبر ٢٠٢٦: توقّف استقبال رسائل العملاء بالكامل (تصل من Meta
// لكن لا تُسجَّل) ومرّت أيام قبل ما ننتبه. هذا الفحص يرصد الصمت الكامل:
// لو ما وصلت أي رسالة واردة منذ مدة طويلة خلال ساعات العمل، ينبّه المالكة
// عبر CallMeBot (قناة مستقلة تماماً عن Meta — نفس رقم تنبيهات الأمان في
// acc_config) حتى لو كان عطل Meta نفسه يمنع الإرسال عبر الواتساب الرسمي.
// مربوط بالكرون run_watchdog. يفحص آخر received_at في wa_message_audit،
// ويمنع التكرار عبر مفتاح inbound_silence_alert_at في wa_settings.
const INBOUND_SILENCE_THRESHOLD_MS = 3 * 60 * 60 * 1000; // ٣ ساعات صمت
const INBOUND_SILENCE_REALERT_MS = 3 * 60 * 60 * 1000;   // لا تكرّر التنبيه قبل ٣ ساعات
async function checkInboundSilence(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  try {
    // بوابة ساعات العمل بتوقيت عُمان (UTC+4): ٨ صباحاً–١١ مساءً محلي = ٤–١٩ UTC.
    const utcHour = new Date().getUTCHours();
    if (utcHour < 4 || utcHour >= 19) return;

    // آخر رسالة واردة فعلاً (wa_message_audit كلها واردة).
    const { data: last } = await supabase
      .from("wa_message_audit")
      .select("received_at")
      .not("received_at", "is", null)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastMs = last?.received_at ? new Date(String(last.received_at)).getTime() : 0;
    const silentMs = Date.now() - lastMs;
    if (silentMs < INBOUND_SILENCE_THRESHOLD_MS) return; // الاستقبال يعمل

    // منع التكرار: لا تنبّه لو نبّهنا مؤخراً.
    const { data: alertRow } = await supabase
      .from("wa_settings")
      .select("value")
      .eq("key", "inbound_silence_alert_at")
      .maybeSingle();
    const lastAlertMs = alertRow?.value ? new Date(String(alertRow.value)).getTime() : 0;
    if (Date.now() - lastAlertMs < INBOUND_SILENCE_REALERT_MS) return;

    // قناة التنبيه المستقلة: CallMeBot (نفس رقم تنبيهات الأمان في acc_config).
    const { data: cfg } = await supabase
      .from("acc_config")
      .select("key,value")
      .in("key", ["callmebot_phone", "callmebot_apikey"]);
    const m: Record<string, string> = {};
    (cfg as Array<{ key: string; value: string }> | null || [])
      .forEach((r) => { m[r.key] = r.value; });
    const phone = m.callmebot_phone;
    const apikey = m.callmebot_apikey;
    if (!phone || !apikey) return; // ما في قناة تنبيه → لا شيء نسويه

    const hrs = (silentMs / 3600000).toFixed(1);
    const msg =
      `⚠️ تنبيه واتساب العمل: ما وصلت أي رسالة عميل منذ ${hrs} ساعة.\n` +
      `قد يكون استقبال الواتساب متوقّف (عطل تسليم من Meta أو توكن).\n` +
      `افحصي اللوحة، أو شغّلي webhook_health للتأكد.`;
    await fetch(
      "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(phone) +
      "&apikey=" + encodeURIComponent(apikey) +
      "&text=" + encodeURIComponent(msg),
    );

    // ختم وقت التنبيه لمنع التكرار.
    await supabase.from("wa_settings").upsert([{
      key: "inbound_silence_alert_at",
      value: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);
  } catch (err) {
    console.error("checkInboundSilence error", err);
  }
}

// ── قناة تنبيه مضمونة عبر البريد (Resend) ────────────────────────────────
// مستقلة تماماً عن Meta/واتساب (فتعمل حتى لو الواتساب نفسه معطّل). from=
// onboarding@resend.dev يرسل لإيميل صاحب حساب Resend فقط — وهو إيميل المالكة
// نفسه، فيعمل بلا تحقق دومين. يقرأ المفتاح من سر RESEND_API_KEY.
// إيميل حساب Resend نفسه — قناة onboarding@resend.dev ترسل له فقط بلا تحقق دومين.
// لتحويله لـgmail: فعّلي تحويلاً من info@alezzgroup.net، أو تحقّقي من الدومين في Resend.
const ALERT_EMAIL_TO = "info@alezzgroup.net";
async function sendAlertEmail(subject: string, text: string): Promise<boolean> {
  try {
    const key = (Deno.env.get("RESEND_API_KEY") || "").trim();
    if (!key) { console.warn("RESEND_API_KEY غير مضبوط — تنبيه الإيميل تخطّي"); return false; }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "onboarding@resend.dev", to: ALERT_EMAIL_TO, subject, text }),
    });
    if (!r.ok) { console.error("Resend alert email failed", r.status, (await r.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error("sendAlertEmail error", e); return false; }
}

// ── فحص صحة الويبهوك الفعّال (الحل الجذري لانقطاع الاستقبال الصامت) ────────
// يحاكي تحقّق Meta تماماً: GET بلا Authorization لنقطة التحقق. لو انقلب
// verify_jwt إلى true، بوابة Supabase ترجع 401 (نفس ما يصير لرسائل Meta
// الواردة) فنكتشف العطل **خلال دقيقة** (الكرون كل دقيقة) بدل انتظار ٣ ساعات
// صمت — وننبّه عبر CallMeBot (قناة مستقلة عن Meta). بلا بوابة ساعات عمل:
// انقطاع الاستقبال حرج دائماً. منع تكرار كل ٣٠ دقيقة.
const WEBHOOK_HEALTH_REALERT_MS = 30 * 60 * 1000;
async function checkWebhookHealth(
  supabase: ReturnType<typeof createClient>,
): Promise<{ healthy: boolean; status: number }> {
  let status = 0;
  try {
    const verifyToken = (Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "").trim();
    const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
    if (!base || !verifyToken) return { healthy: true, status: 0 }; // لا نقدر نفحص → لا إنذار كاذب
    const probe = base + "/functions/v1/WhatsApp-Router"
      + "?hub.mode=subscribe&hub.verify_token=" + encodeURIComponent(verifyToken)
      + "&hub.challenge=ping";
    let body = "";
    try {
      const r = await fetch(probe, { method: "GET" }); // ⚠️ بلا Authorization (تماماً مثل Meta)
      status = r.status;
      body = (await r.text()).slice(0, 32);
    } catch (e) {
      status = -1; body = String(e).slice(0, 40);
    }
    const healthy = status === 200 && body.includes("ping");
    if (healthy) return { healthy: true, status };

    // ── شفاء ذاتي (المشكلة ما ترجع أبداً) ──────────────────────────────────
    // لو السبب 401/403 (البوابة تطلب JWT = انقلب verify_jwt)، نعيده false
    // تلقائياً عبر Management API — فيتصلّح العطل خلال دقيقة بلا تدخّل بشري.
    // يحتاج سرّ SB_MGMT_TOKEN (توكن إدارة شخصي sbp_…). نجرّب كل مرة
    // غير سليمة (قبل منع التكرار) لأن الشفاء أهم من كبح التنبيه.
    let healed = false;
    const mgmtToken = (Deno.env.get("SB_MGMT_TOKEN") || "").trim();
    if (mgmtToken && (status === 401 || status === 403)) {
      try {
        const patch = await fetch(
          "https://api.supabase.com/v1/projects/ofotvacszlmrqxzfjmtn/functions/WhatsApp-Router",
          { method: "PATCH", headers: { "Authorization": "Bearer " + mgmtToken, "Content-Type": "application/json" },
            body: JSON.stringify({ verify_jwt: false }) });
        healed = patch.ok;
        if (!patch.ok) console.error("self-heal PATCH failed", patch.status, (await patch.text()).slice(0, 200));
      } catch (e) { console.error("self-heal error", e); }
    }

    // تنبيه فوري (مع منع تكرار ٣٠ دقيقة).
    const { data: alertRow } = await supabase.from("wa_settings")
      .select("value").eq("key", "webhook_health_alert_at").maybeSingle();
    const lastAlertMs = alertRow?.value ? new Date(String(alertRow.value)).getTime() : 0;
    if (Date.now() - lastAlertMs < WEBHOOK_HEALTH_REALERT_MS) return { healthy: false, status };

    const { data: cfg } = await supabase.from("acc_config")
      .select("key,value").in("key", ["callmebot_phone", "callmebot_apikey"]);
    const m: Record<string, string> = {};
    (cfg as Array<{ key: string; value: string }> | null || []).forEach((r) => { m[r.key] = r.value; });
    // ملاحظة: لا نخرج مبكراً لو CallMeBot غير مضبوط — الإيميل قناة مستقلة تُرسَل دائماً.

    const msg = healed
      ? (`✅ عطل استقبال واتساب — تمّ إصلاحه تلقائياً.\n` +
         `كان الويبهوك يرفض رسائل Meta (HTTP ${status}, انقلب verify_jwt)، والحارس أعاده تلقائياً.\n` +
         `الاستقبال رجع. لا يلزم تدخّل، بس للعلم.`)
      : (`🚨 عطل استقبال واتساب الآن!\n` +
         `الويبهوك يرفض رسائل Meta (HTTP ${status}) — رسائل العملاء ما تصل.\n` +
         `غالباً انقلب verify_jwt. أعيدي نشر WhatsApp-Router بـ«--no-verify-jwt» فوراً.`);
    // قناتان مستقلتان عن Meta: الإيميل (مضمون) + CallMeBot.
    await sendAlertEmail("🚨 عطل استقبال واتساب", msg);
    if (m.callmebot_phone && m.callmebot_apikey) {
      await fetch("https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(m.callmebot_phone) +
        "&apikey=" + encodeURIComponent(m.callmebot_apikey) + "&text=" + encodeURIComponent(msg));
    }

    await supabase.from("wa_settings").upsert([{
      key: "webhook_health_alert_at", value: new Date().toISOString(), updated_at: new Date().toISOString(),
    }]);
    return { healthy: false, status };
  } catch (err) {
    console.error("checkWebhookHealth error", err);
    return { healthy: false, status };
  }
}

// ── Tourism-AI invocation ────────────────────────────────────────────────
// Tourism-AI returns Anthropic-style { content: [{type:"text", text:"..."}] }.
// The text is structured with sectional anchors at line starts:
//   DEST: HOTELS: TOURS: FLIGHTS: TRANSFERS: SUMMARY: CHAT:
// A clarification reply is CHAT: only. A built program has all the others
// followed by a final CHAT: line.
const TAI_ANCHORS = ["DEST", "HOTELS", "TOURS", "FLIGHTS", "TRANSFERS", "SUMMARY", "CHAT"] as const;

function splitTourismAISections(text: string): Record<string, string> {
  const re = new RegExp(`^(${TAI_ANCHORS.join("|")}):`, "gm");
  const hits: Array<{ label: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hits.push({ label: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  const out: Record<string, string> = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    out[hits[i].label] = text.slice(hits[i].bodyStart, end).trim();
  }
  return out;
}

function formatTourismAIForWhatsApp(text: string): string {
  const s = splitTourismAISections(text);
  // Full program — show destination, summary, and any final chat line.
  if (s.SUMMARY) {
    const parts: string[] = [];
    if (s.DEST) parts.push(`🌍 ${s.DEST}`);
    parts.push("💰 *ملخّص السعر*", s.SUMMARY);
    if (s.CHAT) parts.push(s.CHAT);
    const joined = parts.join("\n\n");
    return joined.length > 1500 ? joined.slice(0, 1490) + " …" : joined;
  }
  // Clarification-only reply — return just the CHAT body without the prefix.
  if (s.CHAT) return s.CHAT;
  // No recognized sections — strip any stray label prefixes and return as-is.
  return text.replace(new RegExp(`^(${TAI_ANCHORS.join("|")}):`, "gm"), "").trim();
}

type TaiTurn = { role: "user" | "assistant"; content: string };
type TaiResult = { raw: string; formatted: string; isProgram: boolean };

async function callTourismAI(messages: TaiTurn[]): Promise<TaiResult | null> {
  // Tourism-AI has verify_jwt:true. The project uses the new sb_publishable_/
  // sb_secret_ key system, so the auto-injected SUPABASE_ANON_KEY/SERVICE_ROLE_KEY
  // aren't JWT-shaped. LEGACY_ANON_JWT holds the legacy JWT anon key fetched
  // from the project's API keys.
  const jwt = Deno.env.get("LEGACY_ANON_JWT") || "";
  const res = await fetch(TOURISM_AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      apikey: jwt,
    },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    console.error("Tourism-AI call failed", await res.text());
    return null;
  }
  const data = await res.json();
  const block = Array.isArray(data?.content) ? data.content[0] : null;
  const raw = block?.type === "text" ? String(block.text || "") : "";
  if (!raw) return null;
  return {
    raw,
    formatted: formatTourismAIForWhatsApp(raw),
    // "Program" = response contains a SUMMARY: section, meaning the bot
    // built a complete itinerary. Without SUMMARY, it's still gathering info.
    isProgram: /^SUMMARY:/m.test(raw),
  };
}

// يبني برنامجاً كاملاً تلقائياً عبر Tourism-AI action=auto_build (الأرخص بفنادق
// مختلطة لو التوزيع فارغ، أو توزيع محدّد). يرجّع رسالة الواتساب المنسّقة (مع
// الفنادق/المسار/يشمل-لا يشمل/السعر النهائي بعملة العميل)، و priceReady: هل
// طُبِّق الربح فعلاً (false = خارج شرائح/مواسم الربح ⇒ لا نرسل سعراً تلقائياً).
async function autoBuildProgram(p: {
  dest: string; days: string; date: string; pax: string; ages: string; distribution: string; phone: string;
  return_airport?: string;   // "madinah" = العودة من مطار المدينة (العمرة)
  unique_hotel_per_visit?: boolean;   // كل زيارة لنفس المدينة بفندق مختلف
  exclude_hotels?: string[];          // فنادق طلب العميل تغييرها
  hotel_prefs?: Record<string, unknown>;   // إفطار/اسم فندق/نوع غرفة/إطلالة بحر
}): Promise<{ text: string; priceReady: boolean; priceNote: string; programCode: string; kidAges: number[]; prefMisses?: string[] } | null> {
  const jwt = Deno.env.get("LEGACY_ANON_JWT") || "";
  try {
    const res = await fetch(TOURISM_AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: jwt },
      body: JSON.stringify({
        action: "auto_build", dest: p.dest, days: p.days, date: p.date,
        pax: p.pax, ages: p.ages, distribution: p.distribution,
        phone: p.phone, customer_type: "individual",
        return_airport: p.return_airport || "",
        unique_hotel_per_visit: p.unique_hotel_per_visit === true,
        exclude_hotels: p.exclude_hotels || [],
        hotel_prefs: p.hotel_prefs || {},
      }),
    });
    if (!res.ok) { console.error("auto_build http", res.status, await res.text()); return null; }
    const data = await res.json();
    if (!data?.ok || !data?.program) { console.error("auto_build no program", JSON.stringify(data).slice(0, 200)); return null; }
    const text = String(data.formatted || "").trim() || formatTourismAIForWhatsApp(String(data.program));
    const kidAges = Array.isArray(data.kid_ages) ? (data.kid_ages as unknown[]).map(Number).filter(n => Number.isFinite(n)) : [];
    const prefMisses = Array.isArray(data.pref_misses) ? (data.pref_misses as unknown[]).map(String) : [];
    return { text, priceReady: data.price_ready === true, priceNote: String(data.price_note || ""), programCode: String(data.program_code || ""), kidAges, prefMisses };
  } catch (e) { console.error("autoBuildProgram error", (e as Error).message); return null; }
}

// ليس «تبديل وجهة» حقيقياً → لا نسأل «تقصد X ولا Y؟» (حادثة ٢ نوفمبر: العميل جاوب مطار
//   الإقلاع «مسقط» فأخرج النموذج وجهة «عمان» وسأل طلال «عمرة ولا عمان؟»):
//   (أ) نفس الوجهة بصيغة أخرى (العمرة/عمرة/عمره)، (ب) العمرة مع مدن الحرمين، (ج) العمرة
//   مع عُمان/مسقط/صلالة (بلد الإقلاع للعميل العُماني)، (د) ردّ على سؤال المطار/الإقلاع.
// 🧠 القاعدة ٣ (٣ نوفمبر ٢٠٢٦): ردّ النموذج **بصيغة مضمونة** عبر أداة إلزامية (tool_choice) — كان يرد نص
//    سليم بلا JSON فيُرمى فهمه («الذهاب 12/11 والعودة 17/11، صح؟» → رجع الكرت القديم).
const _S = { type: "string" };
const INTAKE_TOOL = {
  name: "talal_intake", description: "ردّ طلال على العميل + الحقول المستخرجة من كلامه (بالضبط كما قصد العميل).",
  input_schema: { type: "object", required: ["messages", "fields", "complete"], properties: {
    messages: { type: "array", items: _S, description: "عادةً رسالة واحدة قصيرة" },
    fields: { type: "object", properties: {
      destination: _S, pax: { type: ["number", "null"] }, date: _S, ages: _S, cities: _S, nights: _S, days: { type: ["number", "null"] },
      return_airport: { type: "string", enum: ["", "madinah", "jeddah"], description: "العمرة: مطار العودة لو العميل حدّده" } } },
    complete: { type: "boolean" } } },
};
const FOLLOWUP_TOOL = {
  name: "talal_followup", description: "ردّ طلال بعد إرسال البرنامج + نوع الإجراء + الحقول المعدّلة فقط.",
  input_schema: { type: "object", required: ["message", "action"], properties: {
    message: _S, action: { type: "string", enum: ["reply", "modify", "resend_program", "handoff"] },
    frustration: { type: "string", enum: ["none", "misunderstood", "customer_wrong", "talal_error"], description: "العميل متضايق؟ وليش" },
    fields: { type: "object", properties: { pax: { type: ["number", "null"] }, ages: _S, date: _S, nights: _S, days: { type: ["number", "null"] }, cities: _S, destination: _S,
      return_airport: { type: "string", enum: ["", "madinah", "jeddah"] } } } } },
};
// 🧠 ٤ نوفمبر ٢٠٢٦ (قرار المالكة: «ليش طلال ما يفهم اللغة الخليجية مثل ما تفهمها أنت؟»):
//    نية كل رسالة بعد البرنامج يقررها Sonnet أولاً (يفهم اللهجة والأخطاء الإملائية)؛ كاشفات الكلمات احتياط فقط لو فشل النموذج.
const INTENT_TOOL = {
  name: "talal_intent", description: "صنّف رسالة العميل الأخيرة (مع سياق المحادثة) — بدون كتابة رد.",
  input_schema: { type: "object", required: ["intent", "yes_no", "frustrated", "meaning"], properties: {
    intent: { type: "string", enum: ["agree", "decline", "ask_flights", "want_intl_flight", "booking_payment", "resend_program", "waiting", "complaint_program", "modify", "new_request", "question", "thanks_smalltalk", "other"],
      description: "agree=يوافق/يأكد على آخر سؤال لطلال · decline=يرفض · ask_flights=يسأل هل البرنامج شامل الطيران · want_intl_flight=يبي يضيف/يحجز طيران دولي · booking_payment=حجز/دفع/خصم/تأكيد نهائي · resend_program=يطلب البرنامج أو يقول ما وصله · waiting=ينتظر فقط (في انتظارك، وينك، ؟) · complaint_program=يقول البرنامج فيه غلط/راجعه · modify=أي تعديل بالرحلة (تواريخ، أشخاص، ليالي، مدن، فندق، ترتيب، إفطار، غرفة، مطار) · new_request=رحلة مختلفة كلياً · question=سؤال عن البرنامج/الوجهة · thanks_smalltalk=شكر/سلام" },
    yes_no: { type: "string", enum: ["yes", "no", "yes_but_change", "none"], description: "جوابه على آخر سؤال لطلال: yes (ايوه، اكيد، صح، تمام، اوكي، زين، ماشي، يب، عدلها…) · no · yes_but_change (موافق مع تعديل) · none (ما هو جواب نعم/لا)" },
    frustrated: { type: "boolean", description: "متضايق/معصب/يشتكي من التكرار أو عدم الفهم أو التأخير" },
    meaning: { type: "string", description: "وش يقصد العميل بجملة عربية واضحة قصيرة (ترجمة اللهجة والأخطاء)" } } },
};
type FIntent = { intent: string; yes_no: string; frustrated: boolean; meaning: string };
async function _classifyFollowupIntent(transcript: string, lastTalal: string, batch: string): Promise<FIntent | null> {
  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const model = (Deno.env.get("TALAL_MODEL_OVERRIDE") || "").trim() || "claude-sonnet-4-6";
    const anthropic = new Anthropic({ apiKey, maxRetries: 1, timeout: 12000 });
    const sys = "أنت تصنّف رسائل عملاء شركة سياحة عمانية بعد ما أرسل لهم الموظف (طلال) برنامج الرحلة. العملاء يكتبون باللهجة الخليجية/العمانية وبأخطاء إملائية (الطريان=الطيران، برنانج=برنامج، ايوه/ايوا/اي=نعم). افهم القصد مثل إنسان خليجي، واعتمد على آخر سؤال لطلال لتحديد نعم/لا.";
    const res = await anthropic.messages.create({ model, max_tokens: 200, system: sys,
      messages: [{ role: "user", content: `المحادثة:\n${transcript.slice(-3500)}\n\nآخر رسالة لطلال: «${lastTalal.slice(0, 600)}»\n\nرسالة/رسائل العميل الأخيرة المطلوب تصنيفها: «${batch.slice(0, 800)}»` }],
      tools: [INTENT_TOOL as never], tool_choice: { type: "tool", name: INTENT_TOOL.name } as never });
    const blk = ((res as unknown as { content: Array<{ type: string; input?: Record<string, unknown> }> }).content || []).find(b => b.type === "tool_use");
    const i = blk?.input; if (!i) return null;
    const intent = String(i.intent || ""), yes_no = String(i.yes_no || "none");
    if (!(INTENT_TOOL.input_schema.properties.intent.enum as string[]).includes(intent)) return null;
    return { intent, yes_no: ["yes", "no", "yes_but_change", "none"].includes(yes_no) ? yes_no : "none", frustrated: i.frustrated === true, meaning: String(i.meaning || "").slice(0, 300) };
  } catch (_e) { return null; }
}
// نص الرد: من أداة tool_use (المضمونة) وإلا من النص.
// ✈️ ٤ نوفمبر ٢٠٢٦: «هذا شامل الطريان» (حرفين مقلوبين) ما انمسكت → النموذج حاول يحوّل، والحارس منعه، وطلع «وضح لي وش تعدل».
//    كلمة الطيران بأخطائها الشائعة.
const FLIGHT_WORD = "(?:ال)?(?:طيران|طريان|طيرن|طياران|تيران|طياره|طيارة|طيارات|رحل[ةه]\\s*جوي[ةه]|تذاكر|تذكر[ةه]|flights?|flight)";
// 🕋 ٤ نوفمبر ٢٠٢٦ (قرار المالكة): العميل يطلب/يعترض على موقع فندق مكة (بجانب الحرم، الأبراج، بعيد).
const HARAM_WISH_RE = /(?:بجانب|بجنب|جنب|جمب|قريب\s*من|قدام|مقابل|يطل\s*على|مطل\s*على|على)\s*(?:ال)?حرم|(?:ال)?[أا]براج|برج\s*(?:ال)?ساع[ةه]|بعيد\s*(?:عن|من)\s*(?:ال)?حرم/;
const HARAM_COMPLAINT_RE = /(?:ال)?فندق\s*(?:\S+\s*){0,3}?بعيد|بعيد\s*(?:عن|من)\s*(?:ال)?حرم|(?:مو|مش|مب|ما\s*هو|ليس)\s*(?:\S+\s*){0,1}?(?:بجانب|جنب|قريب\s*من)\s*(?:ال)?حرم|(?:ال)?[أا]براج|برج\s*(?:ال)?ساع[ةه]|(?:بجانب|جنب|جمب)\s*(?:ال)?حرم/;
// أسماء المدن (كما في سطور الفنادق بالإنجليزي) → عربي للتوزيعة والرسائل.
const CITY_AR: Record<string, string> = { Phuket: "بوكيت", Krabi: "كرابي", Bangkok: "بانكوك", Pattaya: "باتايا", "Koh Samui": "ساموي", "Chiang Mai": "شيانغ ماي",
  Makkah: "مكة", "Al Madinah": "المدينة", Madinah: "المدينة", Istanbul: "إسطنبول", Trabzon: "طرابزون", Bursa: "بورصة", "Kuala Lumpur": "كوالالمبور", Langkawi: "لنكاوي", Penang: "بينانغ" };
// ٤ نوفمبر ٢٠٢٦: «ضيف لنا بانكوك ٣ ايام» → البناء اختار توزيعة جديدة من الصفر (بانكوك ٤ أولاً، وضاعت إقامة بوكيت الثانية).
//    التوزيعة السابقة من سطور الفنادق بالبرنامج المرسل: «2 بوكيت - 3 كرابي - 3 بوكيت».
function prevDistribution(raw: string): Array<{ city: string; nights: number }> {
  const lines = (String(raw || "").split("HOTELS:")[1] || "").split(/\n\s*\n/)[0].split("\n").filter(l => l.includes("|"));
  return lines.map(l => { const p = l.split("|").map(x => x.trim()); const n = +((l.replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).match(/\|\s*(\d+)\s*(?:ليال[يٍ]?|ليلة|ليلتين)\s*(?:\(|\|)/) || [])[1] || 0); return { city: CITY_AR[p[1]] || p[1], nights: n }; }).filter(x => x.nights > 0);
}
function _modelText(res: { content: unknown[] }): string {
  for (const b of res.content as Array<{ type?: string; input?: unknown; text?: string }>) if (b.type === "tool_use" && b.input) return JSON.stringify(b.input);
  let t = ""; for (const b of res.content as Array<{ type?: string; text?: string }>) if (b.type === "text") t += b.text || "";
  return t;
}

// ✈️ طلب العودة من مطار المدينة (العمرة) — مشترك بين الاستقبال والمتابعة.
const RE_RET_MED = /(?:العود[ةه]|الرجوع|الرجع[ةه]|المغادر[ةه]|نرجع|نعود|ارجع|أرجع|نطلع|الطلع[ةه]|الطيران|طيران)\s*(?:\S+\s*){0,2}?(?:من\s*)?(?:مطار\s*)?(?:ال)?مدين[ةه]|(?:من|عن\s*طريق)\s*مطار\s*(?:ال)?مدين[ةه]/;
const RE_RET_JED = /(?:العود[ةه]|الرجوع|الرجع[ةه]|المغادر[ةه]|نرجع|نعود)\s*(?:\S+\s*){0,2}?(?:من\s*)?(?:مطار\s*)?جد[ةه]/;
// v464: العمرة تغلب عُمان/مسقط/صلالة دائماً (العميل العُماني يذكر بلده كمكان إقلاع).
function _isUmrahDest(x: string): boolean { return /عمر[ةه]|مك[ةه]|المدين[ةه]|الحرم|مدين[ةه]\s*منور|umrah|makkah|mecca|madinah/i.test(String(x || "")); }
function _isOmanDest(x: string): boolean { return /عُ?مان|مسقط|صلال[ةه]|oman|muscat|salalah/i.test(String(x || "")); }
function _sameDestish(oldD: string, newD: string, msgs: Array<{ who: string; body: string }>): boolean {
  const n = (x: string) => String(x || "").trim().replace(/^ال/, "").replace(/ه$/, "ة").replace(/[ًٌٍَُِّْ]/g, "");
  if (n(oldD) === n(newD)) return true;
  const umrah = (x: string) => /عمر[ةه]|مك[ةه]|المدين[ةه]|الحرم|مدين[ةه]\s*منور/.test(x);
  const oman = (x: string) => /عُ?مان|مسقط|صلال[ةه]|oman|muscat|salalah/i.test(x);
  if (umrah(oldD) && (umrah(newD) || oman(newD))) return true;
  if (umrah(newD) && oman(oldD)) return true;   // v464: الاتجاه المعاكس (المخزّن عُمان غلطاً والعميل قال عمرة)
  const lastT = (msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "");
  if (/مطار|الإقلاع|الاقلاع|إقلاع|تطلعون\s*من|المغادر[ةه]\s*من/.test(lastT)) return true;
  return false;
}

// 📨 رسائل ما بعد البرنامج (صيغة المالكة ٢ نوفمبر ٢٠٢٦): رسالة جاهزية دائماً، ورسالة
//    سرير الطفل لو فيه أطفال (١٠ سنوات وتحت) — كلٌّ رسالة مستقلة بعد البرنامج/الـPDF.
//    ⚠️ تُرسَل عبر sendWhatsapp مباشرة (بلا stripBannedPhrases) لأن «أستاذي» هنا صيغة المالكة الحرفية.
function postProgramMessages(kidAges: number[]): string[] {
  const out = ["تفضل أستاذي، برنامجك صار جاهز. أي تعديل في البرنامج أنا حاضر."];
  const k = (kidAges || []).filter(a => Number.isFinite(a) && a <= 10);
  if (k.length === 1) {
    out.push(`علماً أن البرنامج ما فيه سرير إضافي للطفل اللي عمره ${k[0]} ${k[0] <= 1 ? "سنة" : "سنوات"}. إذا حاب أضيف سرير إضافي في البرنامج، عطني خبر عشان أضيف التكلفة تبعه.`);
  } else if (k.length > 1) {
    out.push(`علماً أن البرنامج ما فيه سرير إضافي للأطفال (أعمارهم ${k.join(" و")}). إذا حاب أضيف لهم سرير إضافي في البرنامج، عطني خبر عشان أضيف التكلفة تبعه.`);
  }
  return out;
}
// ٤ نوفمبر ٢٠٢٦ (قرار المالكة): رسائل ما بعد البرنامج انرسلت قبل لنفس العميل → نفس المحتوى بصياغة ثانية
//    («مثل ما ذكرت لك سابقاً…» / «البرنامج بعد التعديل…») بدل تكرارها حرفياً.
function _varyPostMsg(m: string, timesBefore: number): string {
  if (timesBefore <= 0) return m;
  if (/^تفضل أستاذي، برنامجك صار جاهز/.test(m)) {
    const v = ["تفضل أستاذي، البرنامج بعد التعديل صار جاهز. أي تعديل ثاني أنا حاضر.", "تفضل أستاذي، هذا البرنامج المعدّل. لو تحب أي تعديل ثاني أنا حاضر."];
    return v[(timesBefore - 1) % v.length];
  }
  const k = m.match(/^علماً أن البرنامج ما فيه سرير إضافي (للطفل اللي عمره [^.]+|للأطفال \([^)]*\))\./);
  if (k) {
    const v = [`مثل ما ذكرت لك سابقاً، البرنامج ما فيه سرير إضافي ${k[1]}، ولو حاب أضيف سرير إضافي عطني خبر وأضيف التكلفة تبعه.`,
      `وللتذكير، ما فيه سرير إضافي ${k[1]} في البرنامج، ولو حاب نضيفه بلغني وأضيف تكلفته.`];
    return v[(timesBefore - 1) % v.length];
  }
  return m;
}
async function sendPostProgramMessages(supabase: ReturnType<typeof createClient>, phone: string, msgs0: string[]): Promise<void> {
  let msgs = msgs0;
  try {
    const { data: _prev } = await supabase.from("wa_admin_messages").select("body, sent_at").eq("customer_phone", phone).eq("sent_by", "طلال").order("sent_at", { ascending: false }).limit(60);
    const _bodies = ((_prev || []) as Array<{ body?: string }>).map(r => String(r.body || ""));
    const _cnt = (re: RegExp) => _bodies.filter(b => re.test(b)).length;
    // ٤ نوفمبر ٢٠٢٦ (حي): طلب عمرة **جديد** بعد برنامج تايلاند → «البرنامج بعد التعديل صار جاهز». «بعد التعديل» = نفس الطلب فقط
    //    (رسائل الجاهزية من بداية الطلب الحالي started_at).
    let _reqStartP = 0; let _modP = false;
    try { const { data: _ss } = await supabase.from("whatsapp_sessions").select("intake_data").eq("phone", phone).maybeSingle(); const _idP = ((_ss as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>; _modP = _idP.program_modified === true; _reqStartP = Date.parse(String(_idP.started_at || "")) || 0; } catch (_e) { /* */ }
    const _readyRe = /^تفضل أستاذي، (?:برنامجك صار جاهز|البرنامج بعد التعديل|هذا البرنامج المعدّل)/;
    const _nReady0 = ((_prev || []) as Array<{ body?: string; sent_at?: string }>).filter(r => _readyRe.test(String(r.body || "")) && (Date.parse(String(r.sent_at || "")) || 0) >= _reqStartP).length;
    // ٥ نوفمبر ٢٠٢٦ (قرار المالكة): البرنامج انبنى من طلب تعديل → دايماً صيغة «المعدّل»، حتى لو رسائل الجاهزية السابقة ما انعدّت.
    const nReady = _modP ? Math.max(1, _nReady0) : _nReady0;
    // ملاحظة السرير: «سابقاً» فقط لو انذكرت **نفس الأطفال** (نفس الأعمار) قبل — مو أطفال طلب ثاني.
    const _kidKey = (m: string) => (m.match(/(?:عمره|أعمارهم)\s*([^).،]+)/) || [])[1]?.trim() || "";
    msgs = msgs0.map(m => {
      if (/^تفضل أستاذي/.test(m)) return _varyPostMsg(m, nReady);
      if (/^علماً أن البرنامج ما فيه سرير/.test(m)) { const key = _kidKey(m); return _varyPostMsg(m, key ? _bodies.filter(b => /سرير إضافي (?:للطفل|للأطفال)/.test(b) && _kidKey(b) === key).length : 0); }
      return m;
    });
  } catch (_e) { /* أفضل جهد */ }
  for (const m of msgs) {
    try {
      await new Promise(r => setTimeout(r, 1200));
      const sid = await sendWhatsapp(phone, m);
      if (sid) await supabase.from("wa_admin_messages").insert({ twilio_sid: sid, customer_phone: phone, body: m, sent_by: "طلال", sent_at: new Date().toISOString() });
    } catch (e) { console.error("post_program msg", (e as Error).message); }
  }
}

// يؤلّف ملخّص التأكيد الخادمي (لا نعتمد على الـLLM): يعرض ما جمعناه ويطلب تأكيداً
// صريحاً بـ«نعم» قبل بناء العرض. deterministic فيظهر دائماً ويطلب التأكيد بوضوح.
// 🔴 الحل الجذري (قرار المالكة ٣ نوفمبر ٢٠٢٦): **ما يطلع كرت يناقض كلام العميل الأخير.** يقرأ اللي ذكره العميل
//    بعد آخر رد لطلال (تاريخ/عدد/مطار) ويقارنه بالكرت؛ أي تناقض → يرجّع وصف اللي ما فهمه طلال (يُسأل عنه بدل الكرت).
const _MONTHS_RE = "يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر";
function _cardVsCustomer(d: Record<string, unknown>, batch: string): string | null {
  const b = String(batch || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)));
  const NOT_DATE = "(?!\\s*(?:ليل|ليال|أيام|ايام|يوم|شخص|أشخاص|اشخاص|نفر|معتمر|سن|سنة|سنوات|بالغ|طفل|أطفال|اطفال|مكة|مكه|المدين|نجم))";
  const days = new Set<number>();
  const re1 = new RegExp(`(?:تاريخ|بتاريخ|يوم|السفر|الذهاب|القدوم|الطلع[ةه]|العود[ةه]|عوده|عودة|الرجوع|الرجع[ةه])\\s*(?:\\S+\\s*){0,2}?(\\d{1,2})${NOT_DATE}`, "g");
  const re2 = new RegExp(`(\\d{1,2})\\s*(?:/\\s*\\d{1,2}|(?:${_MONTHS_RE}))`, "g");
  for (const m of b.matchAll(re1)) { const n = +m[1]; if (n >= 1 && n <= 31) days.add(n); }
  for (const m of b.matchAll(re2)) { const n = +m[1]; if (n >= 1 && n <= 31) days.add(n); }
  if (days.size) {
    const cur = String(d.date || "");
    const mm = cur.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || cur.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const dep = mm ? (mm[1].length === 4 ? +mm[3] : +mm[1]) : 0;
    const rd = _tripReturnDate(d); const ret = rd ? rd.getUTCDate() : 0;
    const _mo = mm ? (mm[1].length === 4 ? +mm[2] : +mm[2]) : 0;
    const _mn = _mo >= 1 && _mo <= 12 ? " " + _AR_MONTHS[_mo - 1] : "";
    for (const x of days) if (dep && x !== dep && x !== ret) {
      const isRet = new RegExp(`(?:العود[ةه]|عوده|عودة|الرجوع|نرجع|نعود|رجوعنا|عودتنا)\\s*(?:\\S+\\s*){0,3}?${x}(?!\\d)`).test(b);
      const isDep = new RegExp(`(?:السفر|الذهاب|القدوم|نسافر|نطلع|نروح|سفرنا|رحلتنا)\\s*(?:\\S+\\s*){0,3}?${x}(?!\\d)`).test(b);
      return isRet && !isDep ? `العودة بتاريخ ${x}${_mn}` : isDep && !isRet ? `السفر بتاريخ ${x}${_mn}` : `السفر بتاريخ ${x}${_mn} ولا العودة؟ (حالياً السفر ${dep}${_mn} والعودة ${ret}${_mn})`;
    }
  }
  const px = b.match(/(\d{1,2})\s*(?:أشخاص|اشخاص|شخص|نفر|معتمرين|معتمر|أفراد|افراد)/);
  if (px && Number(d.pax) > 0 && +px[1] !== Number(d.pax)) return `العدد ${px[1]}`;
  if (RE_RET_MED.test(b) && !/(?:مش|مو|مب|ما|لا)\s*(?:من\s*)?(?:مطار\s*)?(?:ال)?مدين/.test(b) && String(d.return_airport || "") !== "madinah" && _isUmrahDest(String(d.destination || "") + " " + String(d.nights || ""))) return "العودة من مطار المدينة";
  return null;
}
function _clarifyMsg(what: string, frustrated = false): string {
  const w = what.replace(/؟\s*/, " ").trim();
  return (frustrated ? `أعتذر منك أستاذي، بس فهمني: تقصد ${w}؟` : `عفواً إذا سمحت، تقصد ${w}؟`).replace(/\s+؟/g, "؟").replace(/؟؟/g, "؟");
}
// 🗣️ قرار المالكة ٣ نوفمبر: ❌ الكرت ما يجي بسرعة بعد تعديل — قبله كلام طبيعي (تأكيد بالكلام، أو اعتذار).
const _FRUS_RE = /ليش\s*ما\s*(?:ترد|تردون|ترد[ون]?)|ما\s*تردون|بطي[ءئ]?|بطيئين|متأخر|تأخرتو?ا?|تعبان|سي[ءئ]|زفت|ما\s*ينفع|عيب\s*عليك|مو\s*كل\s*شوي|كل\s*شوي[هة]?\s*(?:اسأل|أسأل|اقول|أقول)|خبرتك|قلت\s*لك|قلتلك|وبعدين\s*معا?ك|كم\s*مر[ةه]|(?:^|\s)افهم|ما\s*(?:تفهم|فهمت)|مو\s*فاهم|غبي|قلت\s*لك|(?:أ|ا)خبرك|يابن\s*الحلال|يا\s*بن\s*الحلال|للمر[ةه]\s*ال/;
// 🗣️ تأكيد بالكلام (جملة طبيعية) قبل أول كرت — بدل ما يطلع الكرت فجأة.
function _talkSummary(d: Record<string, unknown>): string {
  const g = (k: string) => String(d[k] ?? "").trim();
  const parts: string[] = [];
  const dest = g("destination").replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const pax = g("pax");
  const _pw = pax ? (+pax === 1 ? " لشخص واحد" : +pax === 2 ? " لشخصين" : ` لـ${pax} أشخاص`) : "";
  if (dest) parts.push(/عمر/.test(dest) ? `عمرة${_pw}` : `رحلة ${dest}${_pw}`);
  const c = g("date"); const m = c.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || c.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) { const [y, mo, day] = m[1].length === 4 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]]; parts.push(`السفر ${_arDate(new Date(Date.UTC(y, mo - 1, day)))}`); }
  else if (c) parts.push(`السفر ${c.replace(/\s*20\d{2}\s*$/, "")}`);   // صيغة حرّة («24-25 نوفمبر») كما قالها العميل
  const nn = _normNights(d.nights);
  const pm = [...nn.matchAll(/(\d{1,2})\s*(مكة|المدينة|الطائف)/g)].map(x => `${x[1]} ${+x[1] === 1 ? "ليلة" : +x[1] === 2 ? "ليلتين" : "ليالي"} في ${x[2]}`.replace(/^2 ليلتين/, "ليلتين").replace(/^1 ليلة/, "ليلة"));
  if (!pm.length && /^\s*\d{1,2}\s*$/.test(nn) && /عمر/.test(dest)) {   // «3» بلا مدينة → المدن المذكورة (مثلاً مكة فقط)
    const n = +nn.trim(); const city = /مدين/.test(g("cities")) && !/مك/.test(g("cities")) ? "المدينة" : "مكة";
    pm.push(`${n === 1 ? "ليلة" : n === 2 ? "ليلتين" : n + " ليالي"} في ${city}`);
  }
  // العمرة: نوضّح الأيام والليالي معاً (العميل كثير يقول «٣ ايام» ويقصد ٣ ليالي) — صيغة المالكة: «٤ أيام ٣ ليالي».
  const _totN = [...nn.matchAll(/(\d{1,2})/g)].map(x => +x[1]).reduce((a, b) => a + b, 0);
  if (pm.length && /عمر/.test(dest) && _totN > 0) parts.push(`${_totN + 1} أيام ${_totN} ليالي${pm.length > 1 ? ` (${pm.join(" و")})` : pm[0].replace(/^.*?(في\s+\S+)$/, " $1")}`);
  else if (pm.length) parts.push(pm.join(" و"));
  else if (g("days")) parts.push(`${g("days")} أيام`);
  const _ct = g("cities");
  if (!/عمر/.test(dest) && _ct && !/حسب|الوكال|بكيفك|براحتك|رتبو|ترتيب|أي\s*مدن/.test(_ct)) parts.push(`المدن ${_ct}`);
  const r = _tripReturnDate(d);
  if (r) parts.push(`والعودة ${_arDate(r)}${g("return_airport") === "madinah" ? " من مطار المدينة" : ""}`);
  const _r = parts.join("، ").replace(/،\s*والعودة/, "، والعودة");
  return /عمر/.test(dest) ? `فهمت عليك، يعني تقصد ${_r}، صحيح أخي الكريم؟` : `تمام، يعني ${_r}؟`;
}
function _describeChange(prev: Record<string, unknown>, next: Record<string, unknown>): string {
  const g = (d: Record<string, unknown>, k: string) => String(d[k] ?? "").trim();
  const parts: string[] = [];
  const dd = (d: Record<string, unknown>) => { const c = g(d, "date"); const m = c.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || c.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (!m) return null; const [y, mo, day] = m[1].length === 4 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]]; return new Date(Date.UTC(y, mo - 1, day)); };
  const dateCh = g(prev, "date") !== g(next, "date"), nightsCh = g(prev, "nights") !== g(next, "nights");
  const d1 = dd(next), r1 = _tripReturnDate(next);
  if (dateCh && d1) parts.push(`السفر ${_arDate(d1)}`);
  if ((dateCh || nightsCh) && r1) parts.push(`العودة ${_arDate(r1)}${g(next, "return_airport") === "madinah" ? " من مطار المدينة" : ""}`);
  else if (g(prev, "return_airport") !== g(next, "return_airport")) parts.push(g(next, "return_airport") === "madinah" ? "العودة من مطار المدينة" : "العودة من مطار جدة");
  if (nightsCh && g(next, "nights")) parts.push(`الليالي ${g(next, "nights")}`);
  if (g(prev, "pax") !== g(next, "pax") && g(next, "pax")) parts.push(`العدد ${g(next, "pax")}`);
  if (g(prev, "ages") !== g(next, "ages") && g(next, "ages") && g(prev, "ages")) parts.push(`الأعمار ${g(next, "ages")}`);
  return parts.join("، و");
}

function buildIntakeSummary(d: Record<string, unknown>, isUmrah: boolean): string {
  const clean = (s: unknown) => String(s ?? "").trim();
  const dest = clean(d.destination).replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const pax = clean(d.pax);
  const date = clean(d.date);
  const days = clean(d.days);
  const nights = clean(d.nights);
  const ages = clean(d.ages);
  const cities = clean(d.cities);
  const L: string[] = ["خليني أتأكد من طلبك قبل ما أجهّز لك العرض:"];
  if (dest) L.push(`- الوجهة: ${dest}`);
  // قاعدة المالكة: ١١ سنة وفوق = بالغ، ١٠ وتحت = طفل (نفس قاعدة الباني في Tourism-AI).
  const _an = (ages.replace(/[٠-٩]/g, (x: string) => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).match(/\d{1,2}/g) || []).map(Number);
  const _kids = _an.filter(a => a <= 10);
  const _paxN = parseInt(String(pax).replace(/[٠-٩]/g, (x: string) => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))), 10);
  let _split = ages ? ` (${ages})` : "";
  if (_an.length && Number.isFinite(_paxN) && _paxN > _kids.length) {
    const _ad = _paxN - _kids.length;
    const _adTxt = _ad === 1 ? "بالغ واحد" : `${_ad} بالغين`;
    _split = _kids.length === 0 ? ` (${_adTxt})`
      : ` (${_adTxt} + ${_kids.length === 1 ? `طفل عمره ${_kids[0]}` : `${_kids.length} أطفال أعمارهم ${_kids.join(" و")}`})`;
  }
  if (pax) L.push(`- عدد المسافرين: ${pax}${_split}`);
  if (date) L.push(`- تاريخ السفر: ${date}`);
  if (isUmrah) { if (nights) L.push(`- عدد الليالي: ${nights}`); }
  if (isUmrah && clean(d.return_airport) === "madinah") L.push("- المطار: الذهاب إلى مطار جدة، والعودة من مطار المدينة");
  else { if (days) L.push(`- عدد الأيام: ${days}`); }
  if (cities && !/حسب|الوكال|بكيفك|براحتك|رتبو|ترتيب|أي\s*مدن/.test(cities)) L.push(`- المدن: ${cities}`);
  L.push("");
  L.push("المعلومات صحيحة؟ أكّد لي بـ«نعم» وأجهّز لك العرض على طول.");
  return L.join("\n");
}

// ════════════ حُرّاس طلال البرمجية (قواعد قابلة للقياس بكود) ════════════
// الفلسفة: أي خطأ متكرر نحوّله من «تعليمة» (يتبعها النموذج احتمالياً) إلى
// «حارس» (كود يضمنها ١٠٠٪). نوعان: تصحيح تلقائي (ينظّف بصمت)، ورفض (يرجّع
// للنموذج مع السبب؛ بعد محاولتين فاشلتين → معاينة بشرية). كله يُسجَّل في guard_logs.

// جدول اللهجة (منقول من برومبت طلال) — للتصحيح التلقائي للفصحى.
// ⚠️ \b لا يعمل مع العربية (الحروف العربية ليست \w) فكانت كل هذه معطّلة؛
// نستعمل حدوداً عربية (lookbehind/lookahead على نطاق الحروف العربية ء-ي).
// التشكيل/التنوين يُجرَّد قبل تطبيق هذه القائمة، فلا داعي لمطابقته.
const _AB = "(?<![\\u0621-\\u064A])", _AA = "(?![\\u0621-\\u064A])";
const _FUS7A_FIX: Array<[RegExp, string]> = [
  [new RegExp(_AB + "نحن" + _AA, "g"), "احنا"], [new RegExp(_AB + "أنتم" + _AA, "g"), "انتو"], [/متخصصون|مختصون/g, "متخصصين"],
  [new RegExp(_AB + "سوف\\s+", "g"), "راح "], [new RegExp(_AB + "يرجى" + _AA, "g"), "لو تكرمت"], [new RegExp(_AB + "فضلا" + _AA, "g"), "لو سمحت"],
  [new RegExp(_AB + "يمكنك" + _AA, "g"), "تقدر"], [new RegExp(_AB + "أريد\\s+أن" + _AA, "g"), "أبي"], [new RegExp(_AB + "هل\\s+تريد" + _AA, "g"), "تبي"],
  [new RegExp(_AB + "الذي" + _AA, "g"), "اللي"], [new RegExp(_AB + "التي" + _AA, "g"), "اللي"], [new RegExp(_AB + "لكي" + _AA, "g"), "عشان"],
];
// G1–G4 تصحيح تلقائي: يحذف «أستاذي» والتشكيل، يستبدل الفصحى، يصلح الصياغة الركيكة.
// ctx (اختياري): alreadyGreeted = سبق لطلال رد في المحادثة، lastCustomer = آخر رسالة
// من العميل، lastTalal = آخر رسالة أرسلها طلال (لكشف تكرار كلمة الافتتاح).
// G11 regreet: لا تعريف/ترحيب بعد أول رد (إلا لو سأل «مين أنت؟»؛ ونُبقي «وعليكم السلام» لو سلّم العميل).
// G12 how_are_you: حذف السؤال عن الحال. G13 same_opener: لا تبدأ رسالتين متتاليتين بنفس الكلمة.
const _GREET_LEAD = /^(?:وعليكم\s+السلام(?:\s+ورحمة\s+الله(?:\s+وبركاته)?)?|حياك(?:م)?\s+الله(?:\s+من\s+جديد)?|هلا\s+وغلا|هلا\s+والله|هلا\s+فيك|[أا]هلا(?:ً)?(?:\s+وسهلا(?:ً)?)?|مرحب[اً]?(?:\s+فيك)?)[\s،,.!—-]*/;
const _HOW_ARE_YOU = /(?:^|[\s،,—-])(?:(?:وش|شنو|شو|ايش|إيش)\s*(?:[أا]خبارك(?:م)?|علومك(?:م)?|ال[أا]خبار)|كيف\s*(?:الحال|حالك(?:م)?|ال[أا]حوال)|عساك(?:م)?\s*(?:بخير|طيب(?:ين)?)|(?:إن|ان)\s*شاء\s*الله\s*(?:تمام|بخير|طيب(?:ين)?))\s*[؟?]?/g;
const _OPENER = /^(حاضر|[أا]بشر|تمام|[أا]كيد|طيب|زين|ولا\s+يهمك)(?![ء-ي])[\s،,.!—-]*/;
const _normOpener = (w: string) => w.replace(/[أإآ]/g, "ا").replace(/\s+/g, " ");
const _ASKED_WHO = /مين\s*(?:[أا]نت|انت|معي)|(?:[إا]نت|[أا]نت)\s*مين|مع\s*مين\s*[أا]تكلم|(?:[إا]نت|[أا]نت)\s*(?:بوت|روبوت|آلي)|منو\s*(?:[أا]نت|معي)/;
function guardAutofix(text: string, ctx?: { alreadyGreeted?: boolean; lastCustomer?: string; lastTalal?: string }): { text: string; hits: string[] } {
  const hits: string[] = [];
  // الإيموجي يُجرَّد قبل الحُرّاس (كان يُجرَّد لاحقاً في stripBannedPhrases) حتى لا يعيق
  // مطابقة بداية الرسالة («حياك الله 🌟 معك طلال»). لا يُسجَّل كتدخّل — سلوك قائم.
  let t = String(text || "").replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}‍️⃣]/gu, "").replace(/[ \t]{2,}/g, " ").trim();
  if (ctx?.alreadyGreeted && !_ASKED_WHO.test(String(ctx.lastCustomer || ""))) {
    const before = t;
    const custSalam = /السلام\s+عليكم|سلام\s+عليكم/.test(String(ctx.lastCustomer || ""));
    if (!(custSalam && /^وعليكم\s+السلام/.test(t))) t = t.replace(_GREET_LEAD, "");
    t = t.replace(/[\s،,—-]*معك\s+طلال(?:\s+من\s+خدمة\s+العملاء)?[\s،,.!—-]*/g, "، ");
    t = t.replace(/^[\s،,.!—-]+/, "").replace(/([،,])\s*[،,—-]+/g, "$1").replace(/[\s،,—-]+$/, "").trim();
    if (t !== before && t) hits.push("regreet"); else if (!t) t = before;
  }
  if (_HOW_ARE_YOU.test(t)) {
    const before = t;
    t = t.replace(_HOW_ARE_YOU, " ").replace(/^[\s،,.!—-]+/, "").replace(/([،,])\s*[،,—-]+/g, "$1").replace(/[\s،,—-]+$/, "").trim();
    if (t) hits.push("how_are_you"); else t = before;
  }
  if (ctx?.lastTalal) {
    const prevOp = String(ctx.lastTalal).replace(/[\p{Extended_Pictographic}️]/gu, "").trim().match(_OPENER);
    const curOp = t.match(_OPENER);
    if (prevOp && curOp && _normOpener(prevOp[1]) === _normOpener(curOp[1])) {
      const rest = t.slice(curOp[0].length).trim();
      if (rest.length >= 4) { t = rest; hits.push("same_opener"); }
    }
  }
  if (/أستاذي|أستاذتي/.test(t)) { t = t.replace(/\s*يا\s+أستاذ(?:ي|تي)/g, "").replace(/\s*أستاذ(?:ي|تي)/g, ""); hits.push("ustathi"); }
  if (/[ؐ-ًؚ-ْٰ]/.test(t)) { t = t.replace(/[ؐ-ًؚ-ْٰ]/g, ""); hits.push("tashkeel"); }
  for (const [re, rep] of _FUS7A_FIX) { if (re.test(t)) { t = t.replace(re, rep); if (!hits.includes("fus7a")) hits.push("fus7a"); } }
  if (/كم\s*عدد[^؟]*تنوم/.test(t)) { t = t.replace(/كم\s*عدد[^؟]*تنوم[^؟]*؟?/g, "كم عدد المسافرين معكم؟"); hits.push("awkward"); }
  // pax_total (طلب المالكة ٢ نوفمبر ٢٠٢٦): سؤال العدد لازم يوضّح إنه **الإجمالي مع الأطفال**
  //   كي يجاوب العميل صح من أول مرة (كان يقول «٥» ثم «طفل واحد» فيلتبس هل الطفل ضمن الخمسة).
  {
    const _paxQ = /كم\s*(?:عدد\s*)?(?:ال)?(?:معتمرين|مسافرين|أشخاص|اشخاص|أفراد|افراد)(?:كم)?[^؟?\n]*[؟?]|كم\s*عدد(?:كم|هم)\s*[؟?]/;
    const _m = t.match(_paxQ);
    if (_m && !/إجمال|اجمال|كبار|أطفال|اطفال|بالغين|صغار/.test(_m[0])) {
      const _noun = /معتمر/.test(_m[0]) ? "المعتمرين" : "المسافرين";
      t = t.replace(_m[0], `كم عدد ${_noun} الإجمالي، الكبار والأطفال؟`);
      hits.push("pax_total");
    }
  }
  t = t.replace(/[ \t]{2,}/g, " ").replace(/\s+([؟?.،])/g, "$1").trim();
  return { text: t, hits };
}
// ── أدوات مساعدة للحُرّاس ──
const _toLatinDigits = (s: string) => String(s || "").replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const _firstInt = (v: unknown): number | null => { const m = _toLatinDigits(String(v ?? "")).match(/\d+/); return m ? Number(m[0]) : null; };
// جمل الأسئلة فقط (ما ينتهي بـ ؟ أو ?). حُرّاس «إعادة السؤال» تُطبَّق عليها وحدها،
// حتى لا يطابق نصٌّ خبري (مثل سطر «- عدد الأيام: 10» في ملخّص التأكيد) فيُرفض خطأً.
function _questionSegments(t: string): string[] {
  return String(t || "").split(/\n|(?<=[؟?!])/).map(s => s.trim()).filter(s => /[؟?]$/.test(s) && /[ء-يa-z]{2,}/i.test(s));
}
// هل الرسالة ملخّص تأكيد («خليني أتأكد…» أو سطران فأكثر بصيغة «- حقل: قيمة»)؟
// (أي صيغة سطور: «-» أو «•» أو إيموجي أو بلا رمز — المهم سطران فأكثر بأسماء حقول الطلب.)
const _isSummaryText = (t: string) => /خليني\s*[أا]تأكد/.test(t)
  || (String(t).match(/^[^\n:]{0,6}(?:الوجهة|عدد\s*المسافرين|تاريخ\s*السفر|التاريخ|عدد\s*(?:الأيام|الايام|الليالي)|المدة|أعمار\s*الأطفال)\s*:/gm) || []).length >= 2;
// أدوات الاستفهام (مع سابقة و/ف اختيارية) — لتمييز «سؤال معلومة» عن «صح؟» أو تكملة اختيار.
const _Q_PARTICLE = new RegExp("(?<![\\u0621-\\u064A])[وف]?(?:كم|متى|وين|أين|وش|ايش|إيش|شنو|شو|منو|هل|كيف|ليش|مين|أي|تبي|تبون|تحب|تحبون|حاب|حابين|تفضل|تفضلون)(?![\\u0621-\\u064A])");
// أداة استفهام ثانية مسبوقة بـ«و» داخل نفس الجملة («شنو التاريخ… وكم يوم؟») = سؤال ثانٍ.
const _Q_SECOND = /(?<![\u0621-\u064A])و(كم|متى|وش|ايش|إيش|شنو|شو|منو|هل|كيف|ليش|مين|أي)(?![\u0621-\u064A])/;
const _Q_FIRST = new RegExp("(?<![\\u0621-\\u064A])(كم|متى|وين|أين|وش|ايش|إيش|شنو|شو|منو|هل|كيف|ليش|مين|أي)(?![\\u0621-\\u064A])");
// سؤالان في جملة واحدة بأداتين مختلفتين. «كم ليلة في مكة وكم في المدينة؟» (نفس الأداة) = سؤال توزيع واحد، مسموح.
const _twoQsInOne = (q: string) => { const m2 = q.match(_Q_SECOND); if (!m2) return false; const head = q.slice(0, m2.index); const m1 = head.match(_Q_FIRST); return !!m1 && m1[1] !== m2[1]; };
const _Q_TAG = /(?:^|[\s،,—-])(?:صح|صحيح|مضبوط|كذا|تمام|ولا\s*لا)\s*[؟?]$/;
// ── كاشف الأماكن (مدن/دول) — مبني من DESTINATION_HINTS، كل بديل فيها = مكان.
//   سابقة عربية مسموحة (و/ف/ب/ل)؛ والكلمات العربية القصيرة (≤٣ حروف مثل مصر/دبي/شرم)
//   تُشترط لها نهاية كلمة حتى لا تطابق «مصروف/أدبي». كلمة «عمرة» نفسها خدمة لا مكان.
const _PLACE_TOKENS: Array<{ re: RegExp; country: string; isCountry: boolean; tok: string }> = (() => {
  const out: Array<{ re: RegExp; country: string; isCountry: boolean; tok: string }> = [];
  for (const [re, country] of DESTINATION_HINTS) {
    for (const tok of re.source.split("|")) {
      // «صور» تعني أيضاً «صُوَر» (pictures) — تُستثنى من الكشف حتى لا تُرفض «أرسل لي صور».
      if (!tok || /^(?:عمرة|عُمرة|عمره|الحرمين|صور\\b|صور)$/.test(tok)) continue;
      const shortAr = /^[ء-ي]{1,3}$/.test(tok);
      const src = "(?<![\\u0621-\\u064A])(?:[وفبل])?(?:" + tok.replace(/\\b/g, "") + ")" + (shortAr ? "(?![\\u0621-\\u064A])" : "");
      let isCountry = false; try { isCountry = new RegExp("^(?:" + tok + ")$", "i").test(country); } catch (_e) { /* */ }
      try { out.push({ re: new RegExp(src, "i"), country, isCountry, tok }); } catch (_e) { /* بديل غير صالح منفرداً — تجاهل */ }
    }
  }
  return out;
})();
// تعابير شائعة تحتوي اسم مكان وليست مكاناً («في بالي»، «صلاة المغرب»).
const _PLACE_IDIOMS = /(?:في|على|ع)\s+بال[ء-ي]*|(?:صلاة|بعد|قبل|وقت)\s+المغرب/g;
function _placesIn(text: string): Array<{ tok: string; country: string; isCountry: boolean; hit: string }> {
  const s = String(text || "").replace(_PLACE_IDIOMS, " ");
  const out: Array<{ tok: string; country: string; isCountry: boolean; hit: string }> = [];
  for (const p of _PLACE_TOKENS) { const m = s.match(p.re); if (m) out.push({ tok: p.tok, country: p.country, isCountry: p.isCountry, hit: m[0] }); }
  return out;
}

// G5–G8 رفض: يقارن رد طلال بالحقائق المخزّنة ويرجّع سبباً لو خالف.
// opts.allowedPlacesText: نص إضافي مخزّن يُسمح بذكر أماكنه (مثل نص الإعلان الذي جاء منه العميل).
function guardReject(text: string, facts: Record<string, unknown>, opts: { isUmrah: boolean; isOmani: boolean; allowedPlacesText?: string }): { guard: string; reason: string } | null {
  const t = String(text || "");
  const has = (k: string) => { const v = facts[k]; return v !== undefined && v !== null && String(v).trim() !== ""; };
  const qs = _questionSegments(t);
  const qText = qs.join("\n");
  const isSummary = _isSummaryText(t);
  // G5 — إعادة سؤال حقل معروف مسبقاً (على جمل الأسئلة فقط — لا على سطور الملخّص)
  if (has("pax") && new RegExp("كم\\s*(?:عدد|شخص)|معكم\\s*كم|الرحلة\\s*لكم\\s*كم|كم\\s*(?:نفر|فرد)" + _AA).test(qText))
    return { guard: "reask_pax", reason: `العميل ذكر عدد المسافرين=${facts.pax} مسبقاً — لا تسأله عنه، اسأل أول ناقص ثاني` };
  if (has("date") && /موعد\s*السفر|متى\s*(?:تنوون|موعد|ب?تسافر)|أي\s*شهر\s*(?:تنوون|السفر)|وش\s*الفترة|تاريخ\s*السفر\s*[؟?]?$/m.test(qText))
    return { guard: "reask_date", reason: `التاريخ=${facts.date} معروف مسبقاً — لا تسأل عنه` };
  if ((has("days") || has("nights")) && /كم\s*يوم|كم\s*ليلة|عدد\s*(?:الأيام|الايام|الليال)|كم\s*مدة|كم\s*تقضون/.test(qText))
    return { guard: "reask_duration", reason: `المدة معروفة (${facts.days || facts.nights}) — لا تسأل عنها` };
  if (has("destination") && /وين\s*(?:تسافر|حابين|بتروحون)|أي[نّ]?\s*وجه[ةه]\s*(?:تبون|في بالكم)|لأي\s*(?:بلد|وجهة)/.test(qText) && !/نغيّر|تغيير|ثاني/.test(t))
    return { guard: "reask_destination", reason: `الوجهة=${facts.destination} معروفة مسبقاً — لا تسأل عنها` };
  // G9 — ملخّص يخالف الحقائق (مثال حقيقي: «عدد المسافرين: 4» والمخزّن 6)
  if (isSummary) {
    const tl = _toLatinDigits(t);
    const sp = tl.match(/عدد\s*المسافرين\s*:\s*(\d+)/), fp = _firstInt(facts.pax);
    if (sp && fp !== null && Number(sp[1]) !== fp)
      return { guard: "summary_mismatch", reason: `الملخّص يقول عدد المسافرين ${sp[1]} والمخزّن ${fp} — انسخ الأرقام كما هي من المعلومات المجموعة` };
    const sd = tl.match(/عدد\s*(?:الأيام|الايام)\s*:\s*(\d+)/), fd = _firstInt(facts.days);
    if (sd && fd !== null && Number(sd[1]) !== fd)
      return { guard: "summary_mismatch", reason: `الملخّص يقول عدد الأيام ${sd[1]} والمخزّن ${fd} — انسخ الأرقام كما هي من المعلومات المجموعة` };
  }
  // G10 — أكثر من سؤال في رسالة واحدة: سؤالا معلومة، أو «…صح؟» + سؤال معلومة جديد.
  //   لا يُرفض «أي شهر تقصد؟ 11 أو 12؟» (سؤال واحد بخيارات).
  if (!isSummary && qs.length >= 1) {
    const info = qs.filter(q => _Q_PARTICLE.test(q)).length;
    const tags = qs.filter(q => _Q_TAG.test(q)).length;
    if ((qs.length >= 2 && (info >= 2 || (tags >= 1 && info >= 1))) || qs.some(_twoQsInOne))
      return { guard: "multi_question", reason: "رسالتك فيها أكثر من سؤال — اسأل سؤالاً واحداً فقط (أهم معلومة ناقصة)، بلا «صح؟» إضافية قبله" };
  }
  // G6 — تسريب سعر/موقع
  if (/[0-9٠-٩]{2,}\s*(?:ريال|درهم|دولار|ر\.?\s?س|ر\.?\s?ع)/.test(t))
    return { guard: "price_leak", reason: "ممنوع ذكر أي سعر إطلاقاً — قل «بيجاوبك الزميل المختص قريباً»" };
  if (/مقرنا|موقعنا\s*(?:في|بـ|ب )|مكتبنا\s*(?:في|بـ|ب )|فرعنا\s*(?:في|بـ|ب )/.test(t))
    return { guard: "location_leak", reason: "ممنوع ذكر موقع الشركة — حوّل للزميل المختص" };
  // موقع/مدينة غير موجودة في بيانات العميل المخزّنة (الحقائق + نص الإعلان).
  //   أي مدينة داخل دولة مذكورة في البيانات مسموحة. استثناءات: العمرة → مكة/المدينة، والعُماني في العمرة → صلالة/مسقط (سؤال مطار المغادرة).
  {
    const allowedText = JSON.stringify(facts) + " " + String(opts.allowedPlacesText || "");
    const allowed = _placesIn(allowedText);
    const allowedToks = new Set(allowed.map(p => p.tok));
    const allowedCountries = new Set(allowed.map(p => p.country));
    if (opts.isUmrah) { allowedCountries.add("العمرة"); for (const p of _PLACE_TOKENS) if (p.country === "العمرة") allowedToks.add(p.tok); }
    if (opts.isUmrah && opts.isOmani) for (const p of _PLACE_TOKENS) if (p.country === "عُمان") allowedToks.add(p.tok);
    // مدن دولة الوجهة المخزّنة مسموحة (قرار المالكة ١ نوفمبر ٢٠٢٦: بلا التشديد على مستوى المدينة).
    const leaked = _placesIn(t).filter(p => !allowedToks.has(p.tok) && !allowedCountries.has(p.country));
    if (leaked.length) {
      const names = [...new Set(leaked.map(p => p.hit.trim()))].slice(0, 3).join("، ");
      return { guard: "location_leak", reason: `ذكرت مكاناً (${names}) غير موجود في بيانات العميل — لا تقترح ولا تذكر أي مدينة/دولة ما ذكرها العميل` };
    }
  }
  // G7 — مواضيع ممنوعة (نجوم/مطار لغير العمرة/شرائح)
  if (/[0-9٠-٩٤٥]\s*نجوم|فئة\s*الفندق|فندق\s*كم\s*نجم/.test(t))
    return { guard: "topic_stars", reason: "ممنوع تسأل عن فئة النجوم (الافتراضي ٥ نجوم)" };
  if (!opts.isUmrah && /مطار\s*(?:المغادرة|الإقلاع|القدوم)|أي\s*مطار|من\s*أي\s*مطار/.test(t))
    return { guard: "topic_airport", reason: "ممنوع تسأل عن المطار (التنقل خاص افتراضياً)" };
  // يُرفَض فقط لو طلال يسأل/يعرض الشريحة — أما لو يحوّلها للزميل أو يقول إنها خارج الخدمة فهذا صحيح (لا يُرفَض).
  if (/شريح[ةه]|شرائح|\bSIM\b|سيم\s*كارد/i.test(t) &&
      !/الزميل|المختص|يجاوب|يوافي|يتواصل|قريب|ما تدخل|لا تدخل|مو من خدمات|ما نقدّم|خارج (?:خدمات|نطاق)/i.test(t))
    return { guard: "topic_sim", reason: "ممنوع منعاً باتاً تسأل عن شرائح الجوال/الإنترنت إطلاقاً" };
  return null;
}
// تسجيل تدخّل حارس في guard_logs (أفضل-جهد).
async function logGuard(supabase: ReturnType<typeof createClient>, phone: string, guard: string, action: string, reason: string, attempt: number, orig: string, finalTxt: string): Promise<void> {
  try {
    await supabase.from("guard_logs").insert({
      customer_phone: phone, guard_name: guard, action, reason, attempt,
      original_text: String(orig || "").slice(0, 1000), final_text: String(finalTxt || "").slice(0, 1000),
    });
  } catch (_e) { /* best-effort */ }
}

// ── معالج الرسالة الرئيسي ────────────────────────────────────────────────
// ── Password hashing (PBKDF2-SHA256, Web Crypto) ──────────────────────────
// Hashes are stored as "salthex:hashhex" — 16-byte salt, 32-byte hash,
// 100k PBKDF2 iterations. Sufficient for an internal staff dashboard
// with a small population.
function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i*2, i*2+2), 16);
  return out;
}
async function derivePassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password),
    "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key, 256,
  );
  return new Uint8Array(bits);
}
async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePassword(password, salt);
  return `${bytesToHex(salt)}:${bytesToHex(hash)}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const want = hexToBytes(hashHex);
  const got = await derivePassword(password, hexToBytes(saltHex));
  if (got.length !== want.length) return false;
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
function genSessionToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}
function normalizeWhatsappPhone(raw: string): string {
  const digits = String(raw).replace(/^whatsapp:/, "").replace(/^\+/, "")
    .replace(/^00/, "").replace(/[^0-9]/g, "");
  return `whatsapp:+${digits}`;
}

// ── الحضور والنشاط: تسجيل حدث فعلي + تحديث الجلسة المفتوحة (event-based) ──
const ATTEND_IDLE_SEC = 15 * 60; // عتبة الخمول: ١٥ دقيقة بلا نشاط
async function recordActivity(
  supabase: ReturnType<typeof createClient>,
  phone: string, name: string | null, type: string,
  ip: string | null, ua: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  try { await supabase.from("activity_events").insert({ staff_phone: phone, staff_name: name, event_type: type, created_at: now, ip, user_agent: ua }); } catch (_e) { /* */ }
  // أي نشاط يحدّث آخر نشاط للجلسة المفتوحة ويعيد الحالة Active (يوقف الخمول).
  try { await supabase.from("attendance_sessions").update({ last_activity_at: now, status: "active" }).eq("staff_phone", phone).is("check_out_at", null); } catch (_e) { /* */ }
}
// حساب ثواني النشاط/الخمول من فجوات الأحداث (فجوة < العتبة = نشاط، وإلا خمول).
function splitActiveIdle(checkInIso: string, eventIsos: string[], endIso: string): { active: number; idle: number } {
  let prev = new Date(checkInIso).getTime();
  const end = new Date(endIso).getTime();
  let active = 0, idle = 0;
  const ts = eventIsos.map(s => new Date(s).getTime()).filter(t => t >= prev && t <= end).sort((a, b) => a - b);
  for (const t of ts) { const gap = (t - prev) / 1000; if (gap > 0) { if (gap < ATTEND_IDLE_SEC) active += gap; else idle += gap; } prev = t; }
  const tail = (end - prev) / 1000; if (tail > 0) { if (tail < ATTEND_IDLE_SEC) active += tail; else idle += tail; }
  return { active: Math.round(active), idle: Math.round(idle) };
}

// ── Staff identity guard ─────────────────────────────────────────────────
// Any phone in wa_staff (or the legacy SALES_/COMPLAINTS_ env lists) is a
// staff member, not a customer. Free-text messages from staff are blocked
// at the front of handleMessage so a staff WhatsApp reply doesn't pretend
// to be a customer inbound and confuse the FAQ / escalation flow. Admin
// proposal actions (yes/no/correction) still pass through via the
// existing handleAdminResponse path.
const DASHBOARD_URL = "https://latifahmunassar-ctrl.github.io/dashboard/";
const STAFF_WARNING_MESSAGE =
  `⚠️ ردك ما وصل للعميل - افتح الداشبورد للرد على المحادثة\n\n${DASHBOARD_URL}`;
const STAFF_NOTICE_SUFFIX =
  `\n\n⚠️ لا ترد على هذا الرقم - افتح الداشبورد فقط\n${DASHBOARD_URL}`;

async function isRegisteredStaff(
  supabase: ReturnType<typeof createClient>,
  phone: string,
): Promise<boolean> {
  if (staffList("SALES_WHATSAPP_NUMBERS").includes(phone)) return true;
  if (staffList("COMPLAINTS_WHATSAPP_NUMBERS").includes(phone)) return true;
  const { data } = await supabase
    .from("wa_staff")
    .select("phone")
    .eq("phone", phone)
    .eq("active", true)
    .maybeSingle();
  return !!data;
}

// Send a WhatsApp message to a staff member with the "don't reply here,
// use the dashboard" footer attached. Use for any notification where the
// staff member isn't expected to reply on WhatsApp (assignment ping,
// watchdog alert, complaint alert, save-confirmation). Use plain
// sendWhatsapp for the proposal/correction prompts that DO need a
// WhatsApp reply to drive the 4-state admin machine.
async function sendStaffNotice(phone: string, body: string): Promise<void> {
  await sendWhatsapp(phone, body + STAFF_NOTICE_SUFFIX);
}

// ── Staff routing helpers ────────────────────────────────────────────────
// Send a WhatsApp ping to the staff member a conversation just got
// assigned/transferred to. `source` is either "auto" (matched a routing
// rule), the phone of the staff member who transferred, or "admin".
async function notifyStaffAssignment(args: {
  supabase: ReturnType<typeof createClient>;
  staffPhone: string;
  customerPhone: string;
  customerName?: string;
  destination?: string | null;
  source: string;          // "auto" | sender phone | "admin"
}): Promise<void> {
  const customerDigits = args.customerPhone.replace(/^whatsapp:/, "");
  const head = args.source === "auto"
    ? "🎯 محادثة جديدة assigned لك تلقائياً"
    : `🔄 محادثة محوّلة لك${args.source && args.source !== "admin" ? ` من ${args.source.replace(/^whatsapp:/, "")}` : ""}`;
  const lines: string[] = [head];
  if (args.customerName) lines.push(`العميل: ${args.customerName} (${customerDigits})`);
  else lines.push(`العميل: ${customerDigits}`);
  if (args.destination) lines.push(`الوجهة: ${args.destination}`);
  lines.push("راجع المحادثة من الداشبورد وأكمل من هناك");
  try { await sendStaffNotice(args.staffPhone, lines.join("\n")); } catch (_) {}
}

// If the session has no assignee yet AND we just detected a destination,
// look up the routing rules and auto-assign. Idempotent — only fires
// once per session because we check assigned_staff_phone first.
async function maybeAutoAssign(args: {
  supabase: ReturnType<typeof createClient>;
  from: string;
  customerName?: string;
  destination: string | null;
  alreadyAssigned: string | null | undefined;
}): Promise<string | null> {
  if (args.alreadyAssigned || !args.destination) return null;
  const norm = (s: string) => s.trim().toLowerCase();
  const destNorm = norm(args.destination);

  // 1) قواعد التوجيه الصريحة (wa_routing_rules) — لها الأولوية
  const { data: rules } = await args.supabase
    .from("wa_routing_rules")
    .select("assign_to_phone, match_destination")
    .eq("active", true)
    .order("priority", { ascending: false });
  let target: string | null = null;
  const ruleMatch = (rules as Array<{ assign_to_phone: string; match_destination: string | null }> | null ?? [])
    .find(r => r.match_destination && norm(r.match_destination) === destNorm);
  if (ruleMatch) target = ruleMatch.assign_to_phone;

  // 2) Fallback: موظف نشط وجهاته تشمل هذي الوجهة
  if (!target) {
    const { data: staffRows } = await args.supabase
      .from("wa_staff")
      .select("phone, destinations, role")
      .eq("active", true)
      .eq("role", "sales");
    const candidate = (staffRows as Array<{ phone: string; destinations: string[] | null }> | null ?? [])
      .find(s => Array.isArray(s.destinations) && s.destinations.some(d => norm(d) === destNorm));
    if (candidate) target = candidate.phone;
  }

  if (!target) return null;
  await args.supabase.from("whatsapp_sessions").update({
    assigned_staff_phone: target,
    assigned_at: new Date().toISOString(),
    assigned_by: "auto",
  }).eq("phone", args.from);
  await notifyStaffAssignment({
    supabase: args.supabase,
    staffPhone: target,
    customerPhone: args.from,
    customerName: args.customerName,
    destination: args.destination,
    source: "auto",
  });
  return target;
}

// ── AI master switch ─────────────────────────────────────────────────────
// Two-level toggle for whether the bot auto-replies on a given inbound:
//   • wa_sessions.ai_enabled (boolean | null) — per-conversation override.
//     null = inherit global. true/false force regardless of global.
//   • wa_settings.ai_global_enabled (jsonb boolean) — global default.
//   • wa_settings.ai_force_off_all (jsonb boolean) — kill switch. When true
//     ALL conversations are silenced, including explicit ai_enabled=true.
//     Set via "إيقاف الكل".
//   • wa_settings.ai_force_on_all  (jsonb boolean) — mirror kill switch.
//     When true ALL conversations run AI, including explicit
//     ai_enabled=false. Set via "تشغيل الكل".
// "* الكل عدا المخصصين" keeps both force flags = false and just flips
// ai_global_enabled, so per-conversation overrides still win.
// AI master mode — single 3-state setting that replaces the older
// (ai_global_enabled, ai_force_*) combo for routing decisions. The
// older keys are still kept on the wa_settings table for backward
// compat with the dashboard's existing rendering, but new code paths
// consult ai_mode.
//
//   ON      → AI runs and auto-replies (FAQ match) / escalates to admin
//             (no FAQ match) — the historical default behavior.
//   PREVIEW → AI runs (classifies, suggests a reply, fires the
//             admin notification) but NEVER auto-sends. Even FAQ
//             matches go through the admin approval step. The customer
//             receives nothing until the admin approves.
//   OFF     → AI doesn't run at all. handleMessage's FAQ-or-admin
//             flow is short-circuited; conversation rows still
//             get last_message_at touched.
async function getAiMode(
  supabase: ReturnType<typeof createClient>,
): Promise<"ON" | "PREVIEW" | "OFF"> {
  const { data } = await supabase
    .from("wa_settings")
    .select("value")
    .eq("key", "ai_mode")
    .maybeSingle();
  const v = (data as { value?: unknown } | null)?.value;
  const s = typeof v === "string" ? v.toUpperCase().trim() : "";
  if (s === "ON" || s === "PREVIEW" || s === "OFF") return s;
  // «معاينة مع رد» (PREVIEW_REPLY): للرسائل العامة يسلك سلوك المعاينة تماماً
  // (اقتراح للموظف، لا إرسال تلقائي). الفرق الوحيد عن المعاينة هو إرسال
  // **البرنامج النهائي** للعميل تلقائياً، ويُقرَّر منفصلاً في بوابة الإرسال
  // عبر getRawAiMode. فنُطبّعه هنا إلى PREVIEW حتى يبقى منطق المعاينة كما هو.
  if (s === "PREVIEW_REPLY") return "PREVIEW";
  return "ON"; // legacy default
}

// يقرأ قيمة ai_mode **الخام** (قبل التطبيع) — نحتاجها فقط للتمييز بين
// «معاينة» و«معاينة مع رد»، إذ الفرق الوحيد بينهما هو إرسال البرنامج
// المتكامل للعميل تلقائياً بعد اكتمال المعلومات. [[project_wa_auto_program_offer]]
async function getRawAiMode(
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  const { data } = await supabase
    .from("wa_settings")
    .select("value")
    .eq("key", "ai_mode")
    .maybeSingle();
  const v = (data as { value?: unknown } | null)?.value;
  return typeof v === "string" ? v.toUpperCase().trim() : "";
}

async function isAiEnabledForSession(
  supabase: ReturnType<typeof createClient>,
  session: { ai_enabled?: boolean | null } | null,
): Promise<boolean> {
  // OFF mode silences the bot completely — overrides any per-conv ON.
  const mode = await getAiMode(supabase);
  if (mode === "OFF") return false;
  // PREVIEW mode keeps "enabled" semantics so handleMessage still runs
  // the classifier / FAQ check — only the auto-send is suppressed
  // (handled at the FAQ branch). Returning true here is correct.
  if (session && session.ai_enabled === true) return true;
  if (session && session.ai_enabled === false) return false;
  return true;   // PREVIEW or ON, no override → run
}

// يحلّ كود الإعلان المربوط (من الكابشن أو ad_link:source_id) → يجيب البرنامج + رابط
// الـPDF. يرجّع null لو ما فيه إعلان/كود/برنامج. يُستخدم للإرسال عند تأكيد العميل.
async function resolveLinkedAdOffer(
  supabase: ReturnType<typeof createClient>,
  adRef: Record<string, unknown> | null,
): Promise<{ code: string; pdfUrl: string; pr: { destination?: string; persons?: number; total_group?: number; raw?: string } } | null> {
  if (!adRef) return null;
  let adCode = extractProgramCode(String(adRef.body || "") + " " + String(adRef.headline || ""));
  if (!adCode) {
    const srcId = String(adRef.source_id || "").trim();
    if (srcId) {
      try {
        const { data: linkRow } = await supabase.from("wa_settings").select("value").eq("key", "ad_link:" + srcId).maybeSingle();
        adCode = String((linkRow as { value?: { code?: string } } | null)?.value?.code || "").trim().toUpperCase();
      } catch (_e) { /* */ }
    }
  }
  if (!adCode) return null;
  const { data: prog } = await supabase.from("programs")
    .select("destination, persons, total_group, raw").eq("code", adCode).maybeSingle();
  const pr = prog as { destination?: string; persons?: number; total_group?: number; raw?: string } | null;
  if (!pr || !pr.raw) return null;
  let pdfUrl = "";
  try {
    const { data: pdfRow } = await supabase.from("wa_settings").select("value").eq("key", "ad_pdf:" + adCode).maybeSingle();
    pdfUrl = String((pdfRow as { value?: { url?: string } } | null)?.value?.url || "");
  } catch (_e) { /* */ }
  return { code: adCode, pdfUrl, pr };
}
// يرفع الـPDF لواتساب (media id) ثم يرسله document — زي مسار الفواتير. أوثق من
// الإرسال بالرابط (Meta تجلب البايتات منّا لا العكس)، ويسجّل media_id فيظهر
// الملف كأيقونة PDF قابلة للفتح في الداشبورد. يرجّع true عند النجاح.
async function sendAdPdfByUpload(
  supabase: ReturnType<typeof createClient>,
  from: string, pdfUrl: string, caption: string, code: string,
): Promise<boolean> {
  try {
    const TOKEN = (Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim();
    const PHONE_ID = (Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "").trim();
    if (!TOKEN || !PHONE_ID) return false;
    const to = internalToGraph(from);
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) { console.error("ad pdf fetch failed", pdfRes.status, pdfUrl); return false; }
    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    const filename = `عرض-${code}.pdf`;
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("type", "application/pdf");
    fd.append("file", new Blob([bytes], { type: "application/pdf" }), "offer.pdf");
    const upRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/media`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: fd,
    });
    const upJson = await upRes.json();
    if (!upRes.ok || !upJson.id) { console.error("ad pdf upload failed", JSON.stringify(upJson).slice(0, 200)); return false; }
    const cap = stripBannedPhrases(caption).slice(0, 1000);   // نفس تنظيف sendCustomerReply (كان يصل العميل بإيموجي/«أستاذي»)
    const msgBody = { messaging_product: "whatsapp", to, type: "document", document: { id: upJson.id, filename, ...(cap ? { caption: cap } : {}) } };
    const sendRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(msgBody),
    });
    const sendJson = await sendRes.json();
    if (!sendRes.ok) { console.error("ad pdf send failed", JSON.stringify(sendJson?.error ?? sendJson).slice(0, 200)); return false; }
    try {
      await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: (cap ? cap + "\n" : "") + "📄 [ملف العرض PDF]", sent_by: "طلال", sent_at: new Date().toISOString(), media_id: upJson.id, media_mime: "application/pdf", media_filename: filename });
      const _ts = new Date().toISOString();
      await supabase.from("whatsapp_sessions").update({ last_message_at: _ts, last_outbound_at: _ts, last_outbound_body: "📄 ملف العرض" }).eq("phone", from);
    } catch (_e) { /* best-effort */ }
    return true;
  } catch (e) { console.error("sendAdPdfByUpload error", (e as Error).message); return false; }
}

// يرسل ملف العرض المربوط للعميل (PDF مرفوع لواتساب) ويسجّله بالمحادثة.
async function sendLinkedAdOfferFile(
  supabase: ReturnType<typeof createClient>,
  from: string,
  offer: { code: string; pdfUrl: string; pr: { destination?: string; raw?: string } },
): Promise<void> {
  const caption = "تفضّل أستاذي ملف العرض 🌟 وإذا عندك تاريخ معيّن أو تفاصيل ثانية حاب تضيفها بلّغني عشان أرتّب لك برنامج بناءً عليه. علماً أن الأسعار قد تختلف حسب التاريخ وعدد الأفراد 👍";
  let sentOk = false;
  if (offer.pdfUrl) {
    // (١) رفع الـPDF لواتساب (media id) → يصل العميل ويظهر كأيقونة PDF بالداشبورد.
    sentOk = await sendAdPdfByUpload(supabase, from, offer.pdfUrl, caption, offer.code);
    // (٢) بديل موثوق لو فشل الرفع (عابر): إرسال بالرابط المباشر — يصل العميل
    //     (لكن بلا أيقونة بالداشبورد). أفضل من رسالة الانتظار.
    if (!sentOk) {
      const sid = await sendCustomerReply(supabase, from, caption, offer.pdfUrl);
      sentOk = !!sid;
      if (sentOk) { try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: "📎 ملف العرض (PDF) — " + stripBannedPhrases(caption), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ } }
    }
  }
  if (!sentOk) {
    // ❌ لا نرسل نصّاً مبتوراً كأنه «العرض» (يطلع محرج). العرض لازم يكون ملف
    // PDF فخم من المساعد السياحي. لمّا ما فيه PDF مربوط بالكود (لم يُجهَّز بعد)
    // نرسل رسالة انتظار مؤدّبة، ونترك ملاحظة داخلية للموظف يجهّز الملف.
    const hold = "هلا وغلا 🌟 عرضك بيوصلك بالتفصيل الكامل (ملف العرض) من زميلنا المختص خلال وقت قصير بإذن الله. وإذا عندك تاريخ معيّن أو عدد المسافرين، بلّغني عشان يرتّبونه لك بأدقّ صورة 👍";
    await sendCustomerReply(supabase, from, hold);
    try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(hold), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
    // ملاحظة: لا نُدخل تنبيهاً داخلياً في خيط المحادثة (يربك ويبدو موجّهاً للعميل).
    console.warn(`ad-offer no PDF for code ${offer.code} — needs prepareAdPdf`);
  }
}

// ── استقبال العملاء الجدد (طلال) ─────────────────────────────────────────
// يجمع المعلومات الأساسية بمحادثة طبيعية (وجهة/عدد/تاريخ/أعمار/مدينة الوصول
// والمغادرة) ويرد تلقائياً، ثم يتوقّف عند الاكتمال ليتسلّمها الموظف. يخص
// المحادثات الجديدة فقط (intake_active). يفهم النص والأرقام والكلام المجزّأ.
async function handleNewLeadIntake(args: {
  supabase: ReturnType<typeof createClient>; from: string; body: string;
  returning?: boolean;
  referral?: { body?: string; headline?: string; source_id?: string } | null;
}): Promise<void> {
  const { supabase, from } = args;
  const returning = args.returning === true;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");

  // ── نافذة صمت (debounce) لمنع الردود المتوازية المتداخلة ──────────────
  // ⚠️ هذا المعالج يُستدعى **دائماً** من داخل handleMessage **بعد** نافذة الدمج
  // هناك (القسم 0.5)، فالانتظار الطويل هنا كان **تكراراً** صرفاً أضاف ~٨ ثوانٍ
  // لكل رد بلا فائدة (شكوى المالكة: الرد بطيء). ألغينا الانتظار الثاني وأبقينا
  // **فحص** وصول رسالة أحدث فقط (استعلام رخيص) لينسحب هذا المعالج لو سبقته نسخة
  // أحدث أثناء خطوات handleMessage بينهما. التجميع الفعلي يتم في handleMessage.
  const DEBOUNCE_MS = 0;
  const latestInboundTs = async (): Promise<string | null> => {
    const { data } = await supabase.from("wa_message_audit").select("received_at")
      .eq("from_phone", from).not("received_at", "is", null)
      .order("received_at", { ascending: false }).limit(1).maybeSingle();
    return (data as { received_at?: string } | null)?.received_at ?? null;
  };
  const myLatest = await latestInboundTs();
  if (DEBOUNCE_MS) await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
  const afterLatest = await latestInboundTs();
  if (myLatest && afterLatest && new Date(afterLatest).getTime() > new Date(myLatest).getTime()) {
    return;   // وصلت رسالة أحدث → النسخة الأحدث ستتولّى الرد على الصورة الكاملة
  }

  const [inboundRes, outboundRes, sessRes] = await Promise.all([
    supabase.from("wa_message_audit").select("body, received_at").eq("from_phone", from)
      .not("body", "is", null).order("received_at", { ascending: false }).limit(30),
    supabase.from("wa_admin_messages").select("body, sent_at, sent_by").eq("customer_phone", from)
      .order("sent_at", { ascending: false }).limit(30),
    supabase.from("whatsapp_sessions").select("intake_data, ad_referral").eq("phone", from).maybeSingle(),
  ]);
  // 👤 ٤ نوفمبر ٢٠٢٦ (عميل حقيقي): موظف أرسل للعميل برنامج/رسالة وطلال كمّل يسأل «يعني عمرة لـ1 شخص؟».
  //    أي رسالة من موظف (مو طلال/نظام) بعد بداية الطلب الحالي = الموظف استلم → طلال يسكت ويقفل الاستقبال.
  {
    const _st0 = Date.parse(String(((sessRes.data as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}).started_at || "")) || 0;
    const _rows = ((outboundRes.data || []) as Array<{ body?: string | null; sent_at?: string; sent_by?: string | null }>);
    let _resetAt = 0; for (const r of _rows) if (String(r.body || "").startsWith("🔄 أُعيد ضبط المحادثة")) { _resetAt = Math.max(_resetAt, Date.parse(String(r.sent_at || "")) || 0); }
    const _from = Math.max(_st0, _resetAt, Date.now() - 48 * 3600e3);
    const _staff = _rows.find(r => { const by = String(r.sent_by || "").trim(); return by && !/^(?:طلال|نظام|تأكيد تلقائي)$/.test(by) && (Date.parse(String(r.sent_at || "")) || 0) > _from; });
    if (_staff) {
      const _id = (((sessRes.data as { intake_data?: Record<string, unknown> } | null)?.intake_data) || {}) as Record<string, unknown>;
      await supabase.from("whatsapp_sessions").update({ intake_active: false, intake_data: { ..._id, staff_takeover: true } }).eq("phone", from);
      await logGuard(supabase, from, "staff_takeover", "talal_silent", String(_staff.sent_by || ""), 1, "", "");
      return;
    }
  }
  type Row = { body?: string | null; received_at?: string; sent_at?: string };
  const msgs: Array<{ ts: string; who: string; body: string }> = [];
  for (const m of ((inboundRes.data || []) as Row[])) if (m.body && !String(m.body).startsWith("📎")) msgs.push({ ts: m.received_at || "", who: "العميل", body: String(m.body) });
  for (const m of ((outboundRes.data || []) as Row[])) if (m.body) msgs.push({ ts: m.sent_at || "", who: "طلال", body: String(m.body) });
  msgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  // 🔄 إعادة الضبط (زر الداشبورد / reset_conversation) = بداية من الصفر فعلاً: نقصّ
  //    كل ما قبل آخر رسالة «🔄 أُعيد ضبط المحادثة» — وإلا يقرأ طلال العدد/الأطفال القديمة
  //    من السجل ويكمل عليها (كان الضبط شكلياً فقط).
  { let _cut = -1; for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].who === "طلال" && msgs[i].body.startsWith("🔄 أُعيد ضبط المحادثة")) { _cut = i; break; } }
    if (_cut >= 0) msgs.splice(0, _cut + 1); }
  // 🆕 طلب جديد بعد طلب مُقفَل (started_at) → نتجاهل رسائل الطلب السابق كلها.
  { const _st = Date.parse(String(((sessRes.data as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}).started_at || ""));
    if (Number.isFinite(_st)) { const _keep = msgs.filter(m => Date.parse(m.ts) >= _st); msgs.length = 0; msgs.push(..._keep); } }
  const transcript = msgs.slice(-24).map(m => m.who + ": " + m.body).join("\n").slice(-4000);
  // v465 🔴 كلام العميل وحده — الحُرّاس اللي تكشف «إيش قال العميل» ❌ لا تقرأ كلام طلال نفسه
  //   (حادثة ٢ نوفمبر: سؤال طلال «الـ5 كلهم بالغين ولا معكم أطفال؟» اعتُبر تأكيداً أنهم بالغين
  //   فتخطّى سؤال عمر الطفلين؛ وملخّص طلال فيه تاريخ/ليالي يُعتبر كأن العميل قالها).
  const custTranscript = msgs.filter(m => m.who === "العميل").slice(-24).map(m => m.body).join("\n").slice(-4000);
  const prev = (sessRes.data as { intake_data?: unknown } | null)?.intake_data || {};
  // ٤ نوفمبر ٢٠٢٦: النموذج شاف «prev_requests» (عمرة سابقة) وطلّع «تقصد تايلاند ولا العمرة؟» — ❌ نخفي عنه السجل والحقول الداخلية.
  const _promptPrev = (() => { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(prev as Record<string, unknown>)) if (["destination", "pax", "date", "ages", "cities", "nights", "days", "return_airport"].includes(k)) o[k] = v; return o; })();
  // 👀 قرار المالكة (٤ نوفمبر ٢٠٢٦): طلال يقرأ المحادثة كاملة — رسائل العميل «ما انرد عليها» = بعد آخر رسالة **شافها**
  //    طلال فعلاً (last_seen_in_ts)، مو بعد آخر رد له. رسالة وصلت وهو يكتب ردّه = فاتته → «آه صحيح، الحين انتبهت…».
  const _lastSeenIn = Date.parse(String((prev as Record<string, unknown>).last_seen_in_ts || "")) || 0;
  const _lastTalalTs = Math.max(0, ...msgs.filter(m => m.who === "طلال").map(m => Date.parse(m.ts) || 0));
  const _unseenCust = _lastSeenIn ? msgs.filter(m => m.who === "العميل" && (Date.parse(m.ts) || 0) > _lastSeenIn) : [];
  const _missedCust = _unseenCust.filter(m => (Date.parse(m.ts) || 0) < _lastTalalTs);
  const today = new Date().toISOString().slice(0, 10);
  // رقم عُماني (+968)؟ — سؤال مطار المغادرة للعمرة (صلالة/مسقط) حصريّ لهم.
  const isOmani = /^whatsapp:\+?968/.test(String(from));
  // هل الطلب عمرة؟ (نستخدم نموذجاً أقوى Sonnet للعمرة لدقّة تسلسل الأسئلة).
  const _umrahRe = /عمرة|عُمرة|عمره|الحرمين|الحرم\b|مكة|مكه|المدينة\s*المنورة/;
  // ⚠️ على أول رسالة من إعلان، ad_referral لم يُخزَّن بعد على الجلسة (يُخزَّن بعد
  //    handleMessage) — فنستخدم referral المُمرَّر مباشرةً كأولوية، وإلا المخزَّن.
  const _adRefU = args.referral
    || (sessRes.data as { ad_referral?: { body?: string; headline?: string } | null } | null)?.ad_referral;
  // ⚠️ نفحص **آخر رسائل العميل فقط** (لا كل السجل) — سجل محادثة ملوّث برسائل
  //    عمرة قديمة كان يجعل isUmrah=true خطأً لوجهة جديدة غير عمرة (مثل البوسنة).
  //    الوجهة المخزّنة بالجلسة تثبّت القصد لو ذُكرت العمرة سابقاً ثم لم تتكرّر.
  // ٤ نوفمبر ٢٠٢٦: «الي عمره ١٢ سنه» (عُمره = سنّه) انقرت «عمره» = عمرة → «تقصد تايلاند ولا العمرة؟». نشيل عبارات العمر قبل الفحص.
  const _recentCustUm = stripAgeWords(msgs.filter(m => m.who === "العميل").slice(-3).map(m => m.body).join("  "));
  const isUmrah = _umrahRe.test(_recentCustUm)
    || _umrahRe.test(String((prev as { destination?: string })?.destination || ""))
    || _umrahRe.test(String(_adRefU?.body || "") + " " + String(_adRefU?.headline || ""));
  // العميل يسأل عن **عرض محدّد سبق أن أعلنّا عنه** (جاء من إعلان، أو يسأل «العرض/عرضكم/الباقة»)
  // → العرض له تفاصيل ثابتة، فلا نطلب منه يحدّد بنية الرحلة (توزيع الليالي/الأيام).
  const isAdOfferInquiry = !!_adRefU
    || /العرض|عرضكم|عرض[كم]|الباق[ةه]|الباكج|package|وش\s*في(?:ه)?\s*العرض|شو\s*(?:في(?:ه)?|متوفر)/i.test(transcript);
  // هل سبق أن ردّ طلال في هذه المحادثة؟ (لتفادي تكرار التعريف/الترحيب كل رسالة)
  let alreadyGreeted = ((outboundRes.data || []) as Row[]).some(m => !!m.body);

  // ── إعلان فيه كود برنامج جاهز: نعرض البرنامج نفسه (بعملة العميل) بدل أسئلة الاستقبال ──
  // يشتغل مرة واحدة أول ما يجي العميل من إعلان يحمل كوداً في الكابشن/العنوان.
  // لو ما فيه كود بالإعلان (أو البرنامج غير موجود) → نكمل الاستقبال الطبيعي مثل كل مرة.
  const adRef = (args.referral as Record<string, unknown> | null)
    || (sessRes.data as { ad_referral?: Record<string, unknown> | null } | null)?.ad_referral || null;
  const prevData = (prev || {}) as Record<string, unknown>;
  // 🖼️ لو العميل أرسل **صورة عرض بنفسه** (قرأها طلال بالرؤية) → هذا العرض هو المقصود،
  //    لا برنامج الإعلان المربوط (الإعلانات العامة/الكاروسيل مربوطة بكود واحد قد يختلف
  //    عن العرض الذي أرسله العميل — فلا نرسل الصين بينما هو أرسل تايلاند). نتخطّى بلوك
  //    الإعلان ونكمل الاستقبال بناءً على صورته.
  const _sentOwnOfferImage = /^أرسل العميل صورة هذا العرض/.test(String(args.body || ""));
  if (adRef && !prevData.ad_program_shown && !_sentOwnOfferImage) {
    // (١) الكود من الكابشن/العنوان. (٢) وإلا: ربط الإعلان بمُعرّفه source_id (للإعلانات
    //     المُطلَقة بلا كود — تُربَط مرة من الداشبورد فتشتغل تلقائياً لكل عملائها).
    let adCode = extractProgramCode(
      String((adRef as Record<string, unknown>).body || "") + " " + String((adRef as Record<string, unknown>).headline || ""),
    );
    if (!adCode) {
      const srcId = String((adRef as Record<string, unknown>).source_id || "").trim();
      if (srcId) {
        try {
          const { data: linkRow } = await supabase.from("wa_settings").select("value").eq("key", "ad_link:" + srcId).maybeSingle();
          adCode = String((linkRow as { value?: { code?: string } } | null)?.value?.code || "").trim().toUpperCase();
        } catch (_e) { /* */ }
      }
    }
    if (adCode) {
      const { data: prog } = await supabase.from("programs")
        .select("destination, persons, total_group, raw").eq("code", adCode).maybeSingle();
      const pr = prog as { destination?: string; persons?: number; total_group?: number; raw?: string } | null;
      // ⚖️ الإعلان قد يكون **كاروسيل فيه عدة عروض** مربوطاً بكود واحد. لا نفترض أن هذا
      //    الكود هو مقصود العميل: لو ذكر العميل (بكلامه أو صورته) وجهة **تختلف** عن وجهة
      //    البرنامج المربوط → نتجاهل البرنامج المربوط ونعتمد على كلام/صورة العميل.
      // ⚠️ كانت تستدعي detectDestination غير المعرّفة → ReferenceError يوقف الاستقبال بصمت
      //    لكل عميل من إعلان مربوط بكود. extractDestination هي الدالة الموجودة.
      const _custDest = extractDestination(String(args.body || ""));
      const _linkedDest = pr?.destination ? extractDestination(String(pr.destination)) : null;
      const _mismatch = !!_custDest && !!_linkedDest && _custDest !== _linkedDest;
      if (pr && pr.raw && !_mismatch) {
        // ⚠️ لا نرسل الملف تلقائياً على أول رسالة — طلال يحيّي ويسأل بشكل طبيعي أولاً.
        //    نرسل ملف العرض **فقط لمّا يطلبه العميل صراحةً** (ابي العرض / ارسل تفاصيل العرض / شو متوفر…).
        const _curMsg = String(args.body || "");
        // ⚠️ يطابق «عرض/عروض/العرض/العروض/عرضكم/عرض سعر» (مفرد وجمع وبأل وبدونها) +
        //    الباقة/التفاصيل/شو متوفر/ابي اشوف… — كان يطابق «العرض» فقط فيفوت «عروض» و«عرض».
        const wantsOfferFile = /عرو?ض|الباق[ةه]|الباكج|تفاصيل|شو\s*متوفر|وش\s*متوفر|ابي\s*اشوف|ودي\s*اشوف|ارسل.*(?:عرض|تفاصيل|ملف)|رسل.*(?:عرض|تفاصيل)/i.test(_curMsg);
        // 🔎 قاعدة المالكة: طلال **يستوثق أولاً** أي عرض يقصده العميل قبل إرسال الملف —
        //    «تقصد عرض [الوجهة]؟» — ويرسل الملف **فقط بعد ما يؤكّد العميل (ايوه)**.
        //    نعلّم الجلسة بعرض معلّق (ad_offer_pending) بعد سؤال الاستيثاق.
        const _pending = String(prevData.ad_offer_pending || "");
        const _confirmedOffer = _pending === adCode && isAffirmative(_curMsg);
        if (wantsOfferFile && !_pending && !_confirmedOffer) {
          // أول طلب للعرض → استوثق بالوجهة/الوصف بدل الإرسال المباشر.
          const _destAr = String(pr.destination || "").trim();
          const _q = _destAr
            ? `حاضر 🌟 تقصد عرض ${_destAr} اللي شفته بالإعلان؟ أكّد لي «ايوه» وأرسل لك التفاصيل كاملة 👍`
            : "حاضر 🌟 تقصد العرض اللي شفته بالإعلان؟ أكّد لي «ايوه» وأرسل لك التفاصيل 👍";
          await sendCustomerReply(supabase, from, _q);
          try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(_q), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
          await supabase.from("whatsapp_sessions").update({
            intake_data: { ...prevData, ad_offer_pending: adCode },
            last_message_at: new Date().toISOString(),
          }).eq("phone", from);
          return;   // ننتظر تأكيد العميل قبل إرسال الملف.
        }
        if (wantsOfferFile || _confirmedOffer) {
          // «حاضر» + الملف + تنويه أن الأسعار تختلف بالتاريخ وعدد الأفراد.
          const caption = "حاضر 🌟 تفضّل ملف العرض اللي طلبته. وإذا عندك تاريخ معيّن أو تفاصيل ثانية حاب تضيفها بلّغني عشان أرتّب لك برنامج بناءً عليه. علماً أن الأسعار قد تختلف حسب التاريخ وعدد الأفراد 👍";
          let pdfUrl = "";
          try {
            const { data: pdfRow } = await supabase.from("wa_settings").select("value").eq("key", "ad_pdf:" + adCode).maybeSingle();
            pdfUrl = String((pdfRow as { value?: { url?: string } } | null)?.value?.url || "");
          } catch (_e) { /* */ }
          let sentOk = false;
          if (pdfUrl) {
            // (١) رفع الـPDF لواتساب (media id) → يظهر كأيقونة بالداشبورد.
            sentOk = await sendAdPdfByUpload(supabase, from, pdfUrl, caption, adCode);
            // (٢) بديل موثوق: إرسال بالرابط المباشر لو فشل الرفع (عابر).
            if (!sentOk) {
              const sid = await sendCustomerReply(supabase, from, caption, pdfUrl);
              sentOk = !!sid;
              if (sentOk) { try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: "📎 ملف العرض (PDF) — " + stripBannedPhrases(caption), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ } }
            }
          }
          if (!sentOk) {
            // ❌ لا نرسل نصّاً مبتوراً كأنه «العرض». لا PDF مجهّز → رسالة انتظار
            // مؤدّبة + تنبيه داخلي للموظف يجهّز «ملف الإعلان (PDF)» من المساعد.
            const hold = "هلا وغلا 🌟 عرضك بيوصلك بالتفصيل الكامل (ملف العرض) من زميلنا المختص خلال وقت قصير بإذن الله. وإذا عندك تاريخ معيّن أو عدد المسافرين، بلّغني عشان يرتّبونه لك بأدقّ صورة 👍";
            await sendCustomerReply(supabase, from, hold);
            try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(hold), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
            console.warn(`ad-offer no PDF for code ${adCode} — needs prepareAdPdf`);
          }
          await supabase.from("whatsapp_sessions").update({
            intake_data: { ...prevData, ad_program_shown: true, ad_program_code: adCode, destination: pr.destination || prevData.destination },
            destination: pr.destination || null,
            last_message_at: new Date().toISOString(),
          }).eq("phone", from);
          return;   // أرسلنا العرض — الرسالة الجاية يكمل فيها الاستقبال الطبيعي.
        }
        // العميل ما طلب العرض بعد → نكمل استقبالاً طبيعياً (ترحيب + أسئلة)، والوجهة تُكتشَف من الإعلان.
      }
      // كود موجود بالإعلان لكن البرنامج غير محفوظ → نكمل استقبالاً طبيعياً.
    }
  }

  if (!apiKey) {
    await supabase.from("whatsapp_sessions").update({ last_message_at: new Date().toISOString() }).eq("phone", from);
    return;
  }
  // 🔒 مطالبة ذرّية بالترحيب: عند أول تواصل قد تصل رسائل العميل متتالية وتُعالَج بالتوازي،
  //    وكلها ترى «لم يُرحَّب» فترحّب أكثر من مرة. نحسمها بتحديث ذرّي — من ينجح بضبط
  //    greeted=true (من false) هو الوحيد الذي يرحّب؛ الباقي يتوقف فوراً.
  if (!alreadyGreeted && !returning) {
    const { data: claim } = await supabase.from("whatsapp_sessions")
      .update({ greeted: true }).eq("phone", from).eq("greeted", false).select("phone");
    if (!claim || (claim as unknown[]).length === 0) return; // خسرنا السباق — معالجة أخرى ترحّب الآن
  }
  const sys = `أنت «طلال»، موظف خدمة عملاء لوكالة سفر، تتكلم بلهجة خليجية ودودة ومختصرة (لا فصحى).
⛔⛔⛔ **ممنوع منعاً باتاً الفصحى إطلاقاً** — تكلّم لهجة خليجية عُمانية بحتة مثل أي إنسان على واتساب. أمثلة على كلمات فصحى **محرّمة** وبديلها الخليجي (لا تستخدم اليسار أبداً):
  • «نحن» → «احنا» · «أنتم» → «انتو» · «متخصصون/مختصون» → «متخصصين» · «فضلاً/تفضّل بـ» → «لو سمحت» أو احذفها · «سوف» → «راح/بـ» · «قد» احذفها · «يرجى» → «لو تكرمت» · «كي/لكي» → «عشان» · «الذي/التي» → «اللي» · «أريد أن» → «أبي» · «هل تريد» → «تبي؟» · «يمكنك» → «تقدر» · «سعركم يعتمد على» → «السعر يعتمد على».
  • ❌ مثال فصحى ممنوع: «نحن متخصصون في العمرة والسياحة، فضلاً حدّد التاريخ». ✅ الصحيح: «احنا متخصصين بالعمرة والسياحة، حدّد لي التاريخ لو سمحت».
  • أي جملة تحس إنها رسمية/كتاب مدرسي = غلط. خلّها عفوية مثل رسايل الواتساب.
⚠️ الاحترام أساسي: تكلّم بلباقة واحترام دائماً. ابدأ أسئلتك بعبارة مؤدبة مثل «حاضر» أو «أبشر» أو «حياك الله» ثم اطرح السؤال بلطف. ممنوع الأسلوب الجاف أو المختصر بطريقة غير لائقة.
⛔⛔ قاعدة صارمة: **ممنوع منعاً باتاً تذكر اسم العميل إطلاقاً** — حتى لو عرّف عن نفسه أو ظهر اسمه في المحادثة. ❌ ممنوع «حاضر يا عباس». خاطبه بشكل **طبيعي بشري بلا تكرار «أستاذي»** — لا تستخدمها في كل رسالة (نادراً جداً أو لا تستخدمها أصلاً). المهم تبدو المحادثة إنسانية لا قالباً.
⛔ اكتب **بدون أي تشكيل (حركات) إطلاقاً**: لا فتحة ولا ضمة ولا كسرة ولا شدّة ولا تنوين ولا سكون ولا مدّة. كتابة عادية مثل أي إنسان على واتساب، عشان يكون الانطباع بشري بحت.
- مثال صحيح: «أبشر، وين حابين تسافرون؟» / «حاضر، أي وجهة في بالكم؟»
- مثال خاطئ (ممنوع): «وين بتروح؟» / «وش تبي؟» / «كم عددكم؟» بدون مقدمة مؤدبة.
- 👥 **سؤال العدد بصياغة طبيعية فقط:** «كم عدد المسافرين معكم؟» أو «معكم كم شخص بالرحلة؟». ❌❌ ممنوع صياغات ركيكة مثل «كم عدد الأشخاص اللي راح تنومون في الفندق؟» — لا تربط العدد بالنوم/الفندق إطلاقاً. وإذا **ذكر العميل العدد أصلاً** (مثل «شخصين»، «٣ أشخاص»، «إحنا ٤») → ❌ لا تسأل عنه ثانية؛ اعتبره معروفاً وانتقل للناقص التالي.
⛔⛔ القاعدة الأهم على الإطلاق — ممنوع منعاً باتاً أن تعطي أي معلومة من عندك:
- أنت **تجمع** معلومات العميل فقط، ولا **تعطي** أي معلومة (موقع الشركة، الأسعار، تفاصيل البرامج، الفنادق، أي حقيقة).
- ❌ ممنوع تخترع أو تخمّن أي شيء. لو سأل العميل عن أي معلومة (الموقع/السعر/التفاصيل/أي سؤال) → **لا تجاوب من عندك إطلاقاً**، قل بلطف: «بيجاوبك زميلنا المختص على هذا قريباً» وارجع لجمع المعلومات.
- ❌❌ ممنوع منعاً باتاً تقول إن موقعنا في الرياض أو أي مدينة. لا تذكر أي موقع أو مدينة للشركة إطلاقاً — حتى لو ألحّ العميل، حوّله للزميل.
- ✅ **استثناء وحيد — حقائق تأشيرات موثّقة تقولها مباشرة** (هذه فقط، لا تخترع غيرها): لو سأل عميل **عُماني** (رقمه +968) عن **تأشيرة/فيزا دخول الصين** → جاوب مباشرة: «ما يحتاج تأشيرة للعُمانيين للصين ولكم سماح دخول ٣٠ يوم من تاريخ الدخول» ثم أكمل جمع المعلومات.
  • ⚠️ لكن لو ردّ العميل إن **جنسيته غير عُمانية** أو ذكر جنسية **غير خليجية** (وسأل عن تأشيرة الصين) → لا تعطِ معلومة التأشيرة، وقل بصدق: «بصراحة أستاذي ما عندي معلومات كافية عن تأشيرة جنسيتك الأفضل تتواصل مع السفارة الصينية للتحقق من الوضع بشكل أدقّ» ثم أكمل جمع المعلومات.
  • لأي وجهة/جنسية أخرى عن التأشيرة → «بيجاوبك زميلنا المختص على هذا قريباً» (لا تخمّن).
مهمتك جمع ٥ معلومات أساسية من العميل:
1) وجهة السفر  2) عدد المسافرين  3) تاريخ السفر  4) أعمار الأطفال فقط (إن وُجد أطفال)  5) المدن التي يحبون زيارتها (أو ترك الترتيب للوكالة).${adRef ? `
🎯🎯 **العميل جاء من إعلان محدّد — وجهة/موضوع الإعلان معروف مسبقاً.** ❌❌❌ ممنوع منعاً باتاً تسأله عن الوجهة أو «أي وجهة/وين تسافر/وين تبون الفندق/لأي بلد» — الوجهة **واضحة من الإعلان** (إعلان مكة/عمرة = الوجهة مكة والمدينة). استخدمها مباشرة بلا سؤال، واجمع **الباقي فقط** (العدد + التاريخ + ما يلزم). لو سألته عن وجهة واضحة من إعلانه يحس إنك ما تفهم عليه.
  • ✅ **الاستثناء الوحيد:** لو كان طلب العميل **غير واضح/مبهم فعلاً** → استوثق بلطف مع **اقتراح وجهة الإعلان كافتراضي**: «حاب تسافر [مكة أو مدينة الإعلان] ولا مدينة ثانية؟». ❌ لا تسأل سؤالاً مفتوحاً «أي وجهة تبي» — دائماً اقترح وجهة إعلانه أولاً.` : ""}
⚠️ توضيح وجهة مهم: «عُمان» أو «عمان» (بدون شدّة) تعني **دائماً سلطنة عُمان** (وجهة داخلية، مثل صلالة) — **وليست «عَمّان» عاصمة الأردن**. إذا ذكر العميل «عمان» فالمقصود سلطنة عُمان؛ خزّن destination = «عُمان» ولا تخلط بينها وبين الأردن إطلاقاً.
قواعد:
${returning
  ? `- هذا عميل **سبق تعامل معنا وعاد بطلب وجهة جديدة**. ابدأ أول رد بترحيب بعودته بطريقة تُشعره أنك تعرفه (لا كأنها أول مرة): "حياك الله من جديد سعدنا برجوعك! معك طلال" (كرسالة قصيرة لحالها) ثم اسأل عن أول معلومة ناقصة للرحلة الجديدة برسالة ثانية قصيرة.\n- ⚠️ تجاهل تفاصيل أي رحلة قديمة في السياق؛ هذا طلب رحلة جديدة — اجمع معلوماتها من جديد.`
  : alreadyGreeted
    ? `- ⚠️⚠️ أنت **في منتصف المحادثة** وسبق أن عرّفت بنفسك ورحّبت. ❌ ممنوع منعاً باتاً تعرّف بنفسك («معك طلال») أو ترحّب («حياك الله / وعليكم السلام / حياك من جديد») مرة ثانية. أكمل **مباشرة** بسؤال أول معلومة ناقصة برسالة **واحدة** قصيرة.\n  • **استثناء وحيد**: لو سأل العميل صراحةً «مين أنت / إنت مين / مع مين أتكلم / إنت بوت؟» → ردّ فقط: «معك طلال من خدمة العملاء» ثم أكمل سؤالك.`
    : `- أول رد: رحّب وعرّف بنفسك واسأل أول معلومة ناقصة **في رسالة واحدة طبيعية** (لا رسالتين منفصلتين). التعريف **مرة واحدة فقط** طوال المحادثة. ${isUmrah ? "⚠️ **طلب عمرة** — الوجهة معروفة (مكة والمدينة)، ❌ ممنوع تسأل «وين حابين تسافرون»؛ رحّب واسأل أول ناقص غير الوجهة (مثل عدد المعتمرين)، مثال: «حياك الله معك طلال من خدمة العملاء، كم عدد المعتمرين معكم؟». ❌❌ ممنوع تقول «أبشر بعمرتكم» أو «مبارك عمرتكم» أو أي عبارة تَعِد/تفترض — استخدم **«حاضر» أو «أبشر» أو «حياك الله»** فقط ثم السؤال مباشرة." : adRef ? "⚠️⚠️ **العميل جاء من إعلان.** • لو عرفت الوجهة (من **صورة عرض أرسلها**، أو **ذكرها بكلامه**، أو كان الإعلان عن **عرض/وجهة واحدة محددة**) → ❌❌ ممنوع تسأل «وين تسافرون»؛ استخدم الوجهة مباشرة واسأل أول ناقص (عدد المسافرين). • لو كان الإعلان **عدة عروض (كاروسيل)** ولم يحدّد العميل أيّها بعد → اسأله **أي عرض/وجهة يقصد** (لا «وين تسافرون» العامة)، مثال: «حياك الله معك طلال — أي وجهة من عروضنا شدّت انتباهك؟». ❌ لا تفترض أبداً أن الإعلان عن مكة/عمرة ما لم يُذكر ذلك صراحة." : "مثال: «حياك الله معك طلال من خدمة العملاء، وين حابين تسافرون؟»."}`}
- ⚠️ ممنوع منعاً باتاً أي مدح أو تعليق أو عبارة حماس/تأكيد قبل سؤالك. لا تقل نهائياً: «حلو / ممتاز / جميل / رائع / اختيار موفق / تمام تمام / تمام نمرة واحدة / نمرة واحدة / حلو الاختيار / ما شاء الله». ❌ لا تبدأ ردك بأي مجاملة أو تأكيد — ابدأ مباشرة بـ«حياك الله/أبشر/حاضر» (للأدب فقط) ثم السؤال، أو بالسؤال مباشرة. كن مباشراً ومحترفاً.
- ردودك قصيرة جداً: سؤال واحد مختصر، بلا ملخصات ولا علامات ✓ ولا كلام زائد — **الاستثناء الوحيد** هو ملخّص التأكيد الأخير (القاعدة أدناه) عند اكتمال كل المعلومات.
- ⚠️ نوّع صياغتك ولا تجعلها قالباً آلياً: ❌ لا تبدأ **كل** رسالة بنفس الكلمة (حاضر/أبشر)، ولا تكرر «شكراً على المعلومة/التواصل» كل مرة. تكلّم طبيعي ومتنوّع مثل موظف بشري. ❌❌ **ممنوع منعاً باتاً أي إيموجي أو رموز إطلاقاً** (لا 🌟 ولا 🙏 ولا غيرها)، ❌ ولا أي تشكيل/حركات، ❌ ولا تكرار «أستاذي». كتابة بشرية بسيطة فقط.
- ⚠️ لو طلب العميل **التحدث مع شخص/موظف**، أو قال إنه ما يبي رد آلي/تلقائي، أو إنه هو نفسه مكتب/شركة سفر → لا تكمل أسئلة الاستقبال، اجعل complete=true وردّ رسالة واحدة فقط: «حاضر، بيتواصل معك زميلنا مباشرة».
- مثال صحيح: «كم عدد المسافرين؟» — مثال خاطئ (ممنوع): «تايلند اختيار حلو! كم عدد المسافرين؟».
- اسأل عن معلومة ناقصة واحدة فقط في كل رد (الأهم أولاً: الوجهة ثم العدد ثم التاريخ ثم الأعمار ثم مدينة الوصول/المغادرة).
- 📷📷 **العميل أرسل صورة عرض (يظهر بالسجل كـ«أرسل العميل صورة هذا العرض: …»):** الوجهة والمدن وعدد الأيام **معروفة من الصورة** → ❌❌ ممنوع تسأل «وين تسافرون» أو عن الوجهة؛ استخدمها مباشرة. رحّب واسأل **فقط الناقص**: «حياك الله حاضر بخصوص عرض [الوجهة] — كم عدد المسافرين؟ ومتى تاريخ السفر؟». لو العرض فيه عدد أيام محدّد اعتبره المدة (لا تسأل عنها).
- ✈️✈️ **طلب «تذاكر سفر فقط» (بدون برنامج) — قاعدة مهمة:** لو طلب العميل **تذاكر طيران/سفر لحالها** (مثل «شوف لي أسعار تذاكر»، «تذاكر ذهاب وعودة»، «كم سعر التذكرة»، «أبي أطلع من X إلى Y تذاكر») دون أن يذكر برنامجاً/فندقاً/جولات:
  • **الخطوة ١ (استيثاق):** اسأله **سؤالاً واحداً فقط** ولا تجمع غيره: «قصدك تذاكر سفر لحالها من غير برنامج سياحي؟». (complete=false)
  • **الخطوة ٢ — لو أكّد إنه تذاكر فقط** (ايوه/نعم/صح/بس تذاكر/أجل): اعتذر بلطف **ولا تجمع أي معلومات**: «أعتذر منك أستاذي تذاكر السفر لحالها بدون برنامج ما نقدّمها لهذه الوجهة حالياً — لازم تكون ضمن برنامج سياحي». **أبقِ complete=false** (لو رجع يطلب برنامج نكمل معه).
  • **الخطوة ٣ — لو ردّ بعدها إنه يبي برنامج** (مثل «طيب أعطيني برنامج»، «ورّيني عرض»، «طيب رتّبوا لي»، «زين عطني اقتراح»): تعامل معها **كطلب برنامج عادي**، اجمع المعلومات الـ٥ كالمعتاد، وعند اكتمالها أقفل بـ«تمام أستاذي معلوماتك وصلت، زميلنا المختص راح يوافيك بتفاصيل العرض قريباً» (complete=true).
  • ⚠️ لو ذكر العميل من البداية برنامجاً/فندقاً/جولات **مع** التذاكر → هذا طلب برنامج عادي، **تجاهل هذه القاعدة** واجمع المعلومات مباشرة.
  • ⛔⛔ **هذه القاعدة للتذاكر (الطيران) فقط — لا تنطبق أبداً على الفنادق.**
- 🏨🏨 **حجز الفندق فقط = خدمة نقدّمها (لا ترفضها إطلاقاً):** لو طلب العميل **حجز فندق فقط** (مثل «أريد فقط حجز فندق»، «ما أريد تذاكر أبي فندق»، «بس فندق في مكة/المدينة»، «بكم سعر الفندق»، «حجز فندق بس») → ❌❌ **ممنوع منعاً باتاً تعتذر أو تقول «ما نقدّمه»** — نحن **نحجز الفنادق** (خصوصاً فنادق مكة والمدينة للعمرة). عامله كطلب عادي واجمع **الناقص فقط**: ⚠️ **لو الوجهة/المدينة معروفة (من الإعلان أو عمرة أو سبق ذكرها) لا تسأل عنها إطلاقاً** — ❌ ممنوع «وين تبون الفندق/أي مدينة». اجمع (عدد الأشخاص + التواريخ + فئة/تفضيل الفندق) وأقفل بـ«تمام أستاذي معلوماتك وصلت، زميلنا المختص راح يوافيك بأفضل خيارات الفنادق قريباً» (complete=true). لو كان **عمرة/إعلان مكة**، الفندق في مكة/المدينة معروف — اجمع عدد المعتمرين + التواريخ + توزيع الليالي مكة/المدينة، **بلا سؤال عن الوجهة**.
- 💑 **شهر العسل = شخصان (٢):** لو ذكر العميل «شهر عسل / هني مون / honeymoon / عرسنا / متزوجين جدد» فالمسافرون **اثنان بالبداهة**. ❌ لا تسأل «كم عدد المسافرين» من الصفر — بل **أكّد**: «مبارك شهر العسل أفهم إنكم شخصين (٢)، صح؟» وخزّن pax=2، وهما **بالغان** (لا تسأل عن أطفال).
- 🔢 **سؤال واحد كل رد، والترتيب: الوجهة ← عدد المسافرين ← الأطفال/الأعمار ← التاريخ ← عدد الأيام.** (لغير العمرة: بعد التاريخ اسأل «كم يوم تبون الرحلة؟».) ❌❌ ممنوع تدمج سؤالين في رسالة واحدة (مثل «متى السفر وكم عددكم؟») — العميل يجيب عن واحد فقط فتضيع المعلومة الثانية. اسأل **عدد المسافرين قبل التاريخ**، وما تنتقل لسؤال تالٍ قبل ما تاخذ جواب الحالي. المعلومات اللازمة لتسليم الطلب للموظف: **الوجهة + ترتيب/مدن الوجهة + عدد المسافرين + التاريخ + هل فيهم أطفال (وأعمارهم)** — لا تقفل قبل اكتمالها.
- ⚠️ قاعدة الأعمار الصارمة:
  • 👶👶 **بعد ما يعطيك عدد المسافرين، لازم تعرف: هل فيهم أطفال ولا كلهم بالغين؟** لو أعطاك **رقماً فقط** بلا توضيح (مثل «كلنا ٤»، «٤ أشخاص»، «خمسة») ولا فيه ذكر أطفال/عيال → اسأله صراحة **مرة واحدة**: «تمام، الأربعة كلهم بالغين ولا فيه أطفال؟» (أو «العدد كامل بالغين ولا معكم أطفال؟»). ❌ لا تتجاوز هذا افتراضاً أنهم بالغين.
  • لو ذكر العميل **أطفال/عيال/رضيع** (أو ردّ إن فيه أطفال) → اسأل عن **أعمار الأطفال فقط فوراً** (مثل: كم أعمار الأطفال؟) لأن السعر يعتمد على عمر الطفل. خزّن أعمار الأطفال في ages وعددهم في children.
  • لو أكّد **كلهم بالغين** → خزّن العدد كبالغين وانتقل، ولا تسأل عن الأعمار إطلاقاً.
  • ❌ ممنوع منعاً باتاً تسأل عن عمر أي بالغ/كبير (لا الزوج ولا الزوجة/المدام ولا **العاملة المنزلية/الخادمة/الشغالة ولا السائق ولا أي مرافق بالغ**) — سؤال غير لائق ومحرج. كل بالغ يُحسب **عدداً فقط**. الأعمار **حصراً** للأطفال الصغار، ولا أحد غيرهم إطلاقاً.
- ⚠️ التاريخ: **لا تسأل عن السنة إطلاقاً**. لو ذكر العميل شهرًا (أو يومًا) بدون سنة → اعتبرها **سنة هذا العام** تلقائيًا (السنة من «اليوم» أدناه). لا تستخدم سنة أخرى إلا إذا قال العميل صراحةً «السنة الجاية» أو ذكر سنة معيّنة (مثل ٢٠٢٧) من نفسه. يكفي أن تسأل: «متى موعد السفر؟» وتأخذ الشهر.
- ⚠️⚠️ **الشهر يكفي تمامًا للتاريخ**: بمجرد ما يعطيك العميل شهرًا (مثل «سبتمبر» أو «شهر ٩») اعتبر حقل التاريخ **مكتملاً** وخزّنه وانتقل فورًا للمعلومة التالية. ❌ ممنوع منعاً باتاً تلحّ على «أي يوم بالضبط؟» أو تكرّر سؤال التاريخ — لا تسأل عن اليوم المحدّد إطلاقاً، الشهر كافٍ.
  • ⚠️ لو أعطى العميل يومًا وشهرًا (مثل «30/7» أو «بداية من 30/7») فالتاريخ **مكتمل** — ❌ ممنوع تسأل عنه مرة ثانية أو تطلب «التاريخ بالضبط».
  • ⚠️⚠️ لو أعطى العميل **مدى تاريخي** (من تاريخ إلى تاريخ، مثل «4/10 الى 9/10» أو «من ٤ أكتوبر لـ٩ أكتوبر» أو «10 لـ 15») → **المدة معروفة تلقائياً، احسبها بنفسك**: عدد الليالي = الفرق بين التاريخين (٤/١٠ → ٩/١٠ = **5 ليالٍ**)، وعدد الأيام = الليالي + 1. خزّن التاريخ والمدة معاً واعتبرهما **مكتملين**. ❌❌ ممنوع منعاً باتاً تسأل «كم يوم؟» أو «كم ليلة بالمجموع؟» أو «كم مدة الرحلة؟» بعد أن أعطاك مدى — العميل أعطاك البداية والنهاية فالمدة محسومة.
- ⚠️⚠️ العميل الموجود **أصلاً في الوجهة**: لو ذكر أنه موجود/حالياً/واصل الوجهة (مثل «أنا في كوالالمبور»، «موجود بماليزيا»، «واصل دبي») → هو يريد ترتيبات **داخلية** (جولات/فنادق/تنقلات) وهو هناك بالفعل. ❌❌ ممنوع منعاً باتاً تسأل «متى السفر؟» (سؤال محيّر يجعله يرد «أي سفر؟»). بدّلها بسؤال منطقي مثل: «حاضر، متى تحبون نبدأ الترتيبات؟ وكم يوم باقي لكم هناك؟»، واعتبر مدة بقائه/تاريخ بدء الخدمات هو التاريخ (date).
- افهم النص والأرقام المكتوبة بالحروف والكلام المجزّأ على عدة رسائل. لا تكرر سؤالاً أُجيب عنه.
- ❌ ممنوع منعاً باتاً تسأل العميل عن حاله: لا «وش أخبارك» ولا «كيف الحال» ولا «إن شاء الله تمام التمام» ولا أي مجاملة فاضية. أنت **تخدمه** لا تسأله عن حاله. لو حيّاك أو سأل عنك، ردّ «أبشر» باختصار وانتقل **فوراً** للمعلومة الناقصة.
- ❌ ممنوع تقول عبارات آلية مثل «أنا هنا لتجميع معلوماتك» أو «أنا هنا لمساعدتك» — تكلّم طبيعي.
- ❌❌ ممنوع منعاً باتاً تسأل عن **شرائح الجوال أو شرائح الإنترنت (SIM)** إطلاقاً — ليست من مهمتك ولا تُذكر نهائياً.
- ⚠️ راجع كامل سجل المحادثة قبل أي رد:
  • **معلومة أجاب عنها العميل = لا تسألها مرة ثانية أبداً** (ولا بأي صياغة). انتقل لغيرها.
  • معلومة **مطلوبة لم يُجب** عنها (تجاهلها أو غيّر الموضوع) → اسألها من جديد **بصياغة مختلفة تمامًا في كل مرة: غيّر جملة السؤال نفسها، مو بس البادئة (حاضر/أبشر)**. ❌❌ ممنوع تعيد نفس جملة السؤال (مثل «كم عدد المسافرين معك؟») مرتين ولو غيّرت البادئة. أمثلة للتنويع:
    - العدد: «كم عدد المسافرين؟» ← «معكم كم شخص بالرحلة؟» ← «الرحلة لكم فرد تقريبًا؟»
    - التاريخ: «متى موعد السفر؟» ← «أي شهر تنوون السفر فيه؟» ← «وش الفترة المتوقّعة للسفر؟»
    - المدن: «أي مدن تحبون؟» ← «تبون نرتّب لكم المدن بطريقتنا ولا عندكم مدن محدّدة؟»
- لو نسي العميل معلومة ذكّره بها تحديداً بلطف.
- موضوع المدن (بدل سؤال المطار):
  • ❌❌ لو كانت الوجهة **مدينة واحدة محددة** (مثل صلالة، دبي، مكة، المدينة، إسطنبول، شرم الشيخ…) → **لا تسأل عن المدن إطلاقاً** لأن الوجهة نفسها هي المدينة (وغالباً صغيرة ومعروفة). خزّن cities = اسم الوجهة وتجاوز فوراً.
  • لو كانت الوجهة **دولة/منطقة فيها عدة مدن** (مثل فيتنام، ماليزيا، تايلند، تركيا…) → اسأل **مرة واحدة فقط**: "أي مدن تحبون تزورونها؟ أو نرتّب لكم البرنامج بطريقتنا؟". لو حدّد مدنًا خزّنها في cities، ولو قال «رتّبوا لنا/بطريقتكم/أي مدن/ما أدري» خزّن «حسب ترتيب الوكالة».
  • ❌ ممنوع تكرّر سؤال المدن أكثر من مرة. ❌ لا تسأل عن المطار إطلاقاً (إلا استثناء العمرة أدناه).
  • ❌❌ **ممنوع منعاً باتاً تخترع اسم دولة/وجهة.** استنتج الوجهة من **المدن** أو من العرض بالإعلان: شنغهاي/هانغتشو/سوجو/بكين/هونغ كونغ/جوانزو = **الصين** · هانوي/دانانغ = فيتنام · كوالالمبور/لنكاوي = ماليزيا. ❌ لا تخلط وجهتين غير مرتبطتين (مثل «الإمارات وشنغهاي» — خطأ فادح؛ شنغهاي في الصين). لو الإعلان فيه **عدة عروض** والعميل ما حدّد أيّها → اسأله «أي عرض من عروضنا تقصد؟» بدل ما تسمّي وجهة من عندك.
  • 🕋 **استثناء العمرة (مهم):** إذا كان الطلب **عمرة** → الوجهة معروفة تلقائياً (مكة والمدينة / جدة)، فـ❌❌ **ممنوع منعاً باتاً تسأل «من أي مدينة أنت» أو عن الوجهة إطلاقاً**.${isOmani
    ? " رقم هذا العميل **عُماني (+968)**: بدل سؤال الوجهة اسأل **مرة واحدة** عن **مطار المغادرة**: «حاضر، الإقلاع من مطار **صلالة** أو مطار **مسقط**؟» وخزّن الإجابة في notes. (هذا الاستثناء **الوحيد** المسموح فيه سؤال المطار، و**حصريّاً** للأرقام العُمانية.)"
    : " رقم هذا العميل **ليس عُمانياً**: ممنوع منعاً باتاً تذكر «صلالة» أو «مسقط» أو تسأل عن المطار إطلاقاً — اتبع القاعدة العامة (لا سؤال مطار)."}
  🕋 **تسلسل أسئلة العمرة (سؤال واحد كل رد، وتخطّ فورًا أي معلومة أعطاها العميل — راجع السجل قبل كل سؤال):**
     (أ) **عدد المعتمرين** (كم شخص).
     (ب) **تاريخ السفر** — لو أعطى **مدى** (من–إلى) فالمدة محسومة تلقائياً، ❌ لا تسأل عن عددها.
     ${isOmani ? "(ج) **مطار المغادرة**: «الإقلاع من مطار صلالة أو مطار مسقط؟» (حصريّاً للعُماني)." : "(ج) لا تسأل عن المطار (العميل غير عُماني)."}
     (د) ${isAdOfferInquiry
    ? " **العميل جاء من إعلان مكة — الوجهة معروفة (عمرة) فلا تسأل عنها.** لكن إعلان مكة عرضٌ تعريفيّ وليس باقة بعدد ليالٍ ثابت: التسعير يحتاج المدة. اجمع: عدد المعتمرين + التاريخ" + (isOmani ? " + مطار المغادرة (صلالة/مسقط)" : "") + " + **عدد الليالي/الأيام** (⛔ إلزامي). اسأل **مرة واحدة** «كم ليلة تنوون في مكة؟ وإن حاب نضيف المدينة المنورة بلّغني كم ليلة فيها». ❌ لا تقفل قبل معرفة عدد الليالي (إلا إن أعطى مدى تاريخي من–إلى فالمدة محسومة). بعد اكتمالها طمئنه أن زميلنا بيجهّز له العرض."
    : "🕋 **مكة لحالها ولا مع المدينة؟ اسأل هذا (إن لم يحدّد العميل):** «تبي مكة لحالها ولا حاب أضيف لك المدينة المنورة؟». • لو **مكة فقط**: ⛔⛔ لو العميل **أعطى مدى تاريخي (من–إلى) أو عدد ليالٍ إجمالي** فالمدة معروفة، و«مكة فقط» يعني **كل الليالي في مكة تلقائياً** → ❌❌❌ ممنوع تسأل «كم ليلة في مكة» (الجواب = كل المدة)؛ اعتبر التوزيع مكتملاً. اسأل «كم ليلة في مكة؟» **فقط** لو المدة غير معروفة. • لو **الاثنتين** → اسأل التوزيع «كم ليلة في مكة وكم في المدينة؟». ولو أعطى التوزيع من البداية (مثل «3 مكة 2 المدينة») فمكتمل ولا تسأل. ⚠️ المدة بـ«الليالي/الأيام» فقط — ❌❌ ممنوع كلمة «سنة» أو «سنوات» إطلاقاً."}
     (هـ) **أعمار الأطفال** فقط لو ذكر أطفالاً.
     ❌❌ ممنوع في العمرة تسأل عن: الوجهة، ولا المطار لغير العُماني. ⛔⛔ **إلزامي قبل الإقفال: عدد الليالي/الأيام في مكة (وفي المدينة إن أضافها).** ❌❌ ممنوع منعاً باتاً تقفل (complete=true) قبل ما تعرف **كم ليلة/يوم في مكة** — حتى لو العميل من إعلان أو قال «كامل البرنامج»؛ لازم تسأله «كم ليلة تبون في مكة؟» (وكم في المدينة إن اختارها). ⛔ **استثناءان لا تسأل فيهما عن الليالي:** (١) أعطى **مدى تاريخي** (من–إلى) أو عدد ليالٍ إجمالي **واختار مكة فقط** → كل الليالي بمكة تلقائياً، مكتمل. (٢) أعطى توزيعاً صريحاً. عند اكتمال (العدد + التاريخ + **عدد الليالي/التوزيع** + المطار إن عُماني) اشكره وأقفل.
- لو كان كلام العميل شكوى أو سؤال عام (مو حجز)، لا تضغط بأسئلة الاستقبال — ردّ بلطف إن زميلنا بيتواصل معه، واجعل complete=true.
- 📢📢 **العميل من إعلان ويطلب العرض — أرسل العرض فوراً (لا تجمع معلومات قبله):** لو طلب العميل العرض (عروض/العرض/شو متوفر/ابي اشوف) → استوثق «تقصد عرض [الوجهة] اللي شفته بالإعلان؟» ولمّا يؤكّد **يُرسَل ملف العرض مباشرة** (النظام يرسله). ❌❌ ممنوع تجمع منه تاريخ/عدد/ليالي **قبل** إرسال العرض؛ العرض جاهز ويُرسَل أولاً. **بعد إرسال الملف** ادعُه لإضافة تفاصيله: «إذا عندك تاريخ معيّن أو تفاصيل ثانية حاب تضيفها بلّغني عشان أرتّب لك برنامج بناءً عليه». • إن أعطاك بعدها تاريخاً/عدداً/تفاصيل → اجمعها بهدوء (بلا فورمة إلزامية) وطمئنه أن زميلنا بيجهّز له البرنامج المخصّص. • ⚠️ لو **اعترض بشيء غامض ما فهمته** → «حاضر أستاذي بحوّل ملاحظتك لزميلنا المختص وراح يرد عليك قريباً».
- 🤔🤔 **استوثِق قبل الملخّص عند أي التباس (إلزامي):** لو كانت المعلومات **متناقضة** (مثل تاريخين مختلفين، أو عدد يتعارض، أو وجهة تتعارض مع المدن)، أو **الكتابة غير واضحة/مبهمة**، أو العميل **طلب أشياء كثيرة ولم يحسم** ما يريده بالضبط — ❌ **لا ترسل الكرت/الملخّص**؛ اسأله سؤال استيضاح واحد مباشر **«تقصد كذا؟ ولا كذا؟»** حتى يتّضح، وبعد ما **يؤكّد** انتقل للملخّص. ومتى **بدّل معلومة سبق أعطاها** (وجهة/عدد/تاريخ) أكّد التبديل صراحةً «تقصد تبي تغيّره إلى كذا بدل كذا؟» قبل ما تعتمده. (الوجهة والعدد لهما حارسان خادميّان يفرضان ذلك.)
- ⚠️⚠️ **ملخّص التأكيد قبل الإقفال (إلزامي):** متى اكتملت كل الأساسيات (الوجهة + عدد المسافرين [+ أعمار الأطفال إن وُجدوا] + التاريخ [+ عدد الليالي/التوزيع للعمرة]) **ولا التباس معلّق** **لا تقفل فوراً**. أرسل رسالة واحدة فيها ملخّص المعلومات واطلب التأكيد. ❌❌ في رسالة الملخّص **ممنوع منعاً باتاً تعرّف بنفسك («معك طلال») أو ترحّب أو تحيّي** — ابدأ مباشرة بـ«خليني أتأكد...». بهذا الشكل:
«خليني أتأكد من طلبك قبل ما أجهّز لك البرنامج:
- الوجهة: [الوجهة]
- عدد المسافرين: [العدد][، وأطفال أعمارهم كذا إن وُجدوا]
- التاريخ: [التاريخ]
- عدد الأيام: [عدد الأيام][، أو عدد الليالي/التوزيع للعمرة]
المعلومات صحيحة؟ أكّد لي وأجهّز لك البرنامج.»
❌ ممنوع تذكر أي سعر. اجعل **complete=false** في هذه الرسالة وانتظر رد العميل.
  • **لو أكّد العميل** (ايوه/نعم/صح/تمام/أجل/زين): اقفل بـ **complete=true** ورسالة واحدة: «تمام، معلوماتك وصلت، زميلنا بيجهّز لك العرض ويتواصل معك قريباً».
  • **لو صحّح معلومة**: حدّث الحقل وأعد إرسال الملخّص المحدّث (complete=false).
اليوم: ${today}. المعلومات المجموعة سابقاً: ${JSON.stringify(_promptPrev)}.
أعد JSON فقط: {"messages":["رسالة واحدة قصيرة"],"fields":{"destination":"","pax":null,"date":"","ages":"","cities":"","nights":"","days":null},"complete":false}
• nights = عدد الليالي/الأيام أو التوزيع (مثل «٤ ليالي» أو «٣ مكة ٢ المدينة»). للعمرة **إلزامي** لأن السعر بالليلة. لو أعطى العميل مدى تاريخي (من–إلى) احسب الليالي وضعها هنا. وإلا "".
• days = **عدد أيام الرحلة** (رقم فقط). لغير العمرة **مطلوب لبناء البرنامج** — اسأله «كم يوم تبون الرحلة؟» بعد التاريخ. لو أعطى مدى تاريخي (من–إلى) احسب الأيام تلقائياً. العمرة تستخدم nights بدلها.
حيث messages عادةً **رسالة واحدة فقط** — الإنسان الحقيقي يرسل رسالة وحدة لا رسالتين متتاليتين بنفس الثانية. ❌ لا تقسّم ردك إلى رسالتين.`;
  let out: { reply?: string; messages?: unknown; fields?: Record<string, unknown>; complete?: boolean } | null = null;
  // ── خط أنابيب حُرّاس الرفض: نولّد الرد، نفحصه مقابل الحقائق، ولو خالف نرجّعه
  //    للنموذج مع سبب الرفض ونعيد التوليد (حتى محاولتين)، وبعدها → معاينة بشرية.
  let _guardForcePreview = false;
  let _genFails = 0;   // فشل توليد (استثناء/بلا JSON/JSON تالف) — يُعاد مرة واحدة، ثم حارس «لا سكوت»
  const _guardRejects: Array<{ guard: string; reason: string; attempt: number; text: string }> = [];
  {
    const _model = (Deno.env.get("TALAL_MODEL_OVERRIDE") || "").trim()
      || "claude-sonnet-4-6";   // ٤ نوفمبر ٢٠٢٦ (قرار المالكة): نفس الاحترافية لكل الوجهات — Sonnet للجميع (كان Haiku لغير العمرة)
    let _sysTry = sys;
    let _toolsOff = false;   // شبكة أمان: لو الـAPI رفض الأداة → نكمل بدونها (النص كالسابق)
    for (let _att = 1; _att <= 3; _att++) {   // الأصل + محاولتان
      let _cand: typeof out = null;
      let _failWhy = "";
      try {
        const anthropic = new Anthropic({ apiKey });
        const res = await anthropic.messages.create({
          model: _model, max_tokens: 700, system: _sysTry,
          messages: [{ role: "user", content: transcript || "(أول رسالة من العميل)" }],
          ...(_toolsOff ? {} : { tools: [INTAKE_TOOL as never], tool_choice: { type: "tool", name: INTAKE_TOOL.name } as never }),
        });
        const txt = _modelText(res as unknown as { content: unknown[] });
        const m = txt.match(/\{[\s\S]*\}/);
        if (!m) {
          // ٣ نوفمبر ٢٠٢٦: النموذج ردّ نص سليم بلا JSON («حاضر، يعني الذهاب 12/11 والعودة 17/11…، صح؟») → كان يُرمى
          //   ويُعاد الكرت القديم. الحين: لو نص قصير معقول نعتمده رسالة (بلا تحديث حقول)، ويمرّ على الحرّاس عادي.
          const _plain = txt.trim();
          // + رقم مجرّد ردّاً على «كم عدد» → نلتقط العدد (نفس منطق الاحتياطي).
          const _sf: Record<string, unknown> = {};
          { const _lt = (msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || ""); const _bn = String(args.body || "").trim().replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
            if (/^\d{1,2}$/.test(_bn) && /كم\s*عدد/.test(_lt) && !(Number((prev as Record<string, unknown>).pax) > 0)) _sf.pax = Number(_bn); }
          if (_plain && _plain.length <= 400 && !/[{}]/.test(_plain)) { _cand = JSON.parse(JSON.stringify({ messages: [_plain], fields: _sf })); await logGuard(supabase, from, "model_plain_text", "salvaged", _plain.slice(0, 150), _att, "", ""); }
          else _failWhy = "no_json: " + txt.slice(0, 200);
        }
        else { try { _cand = JSON.parse(m[0]); } catch (pe) { _failWhy = "bad_json: " + (pe as Error).message + " | " + m[0].slice(0, 200); } }
      } catch (e) { _failWhy = "api_error: " + String((e as Error)?.message || e).slice(0, 300); if (!_toolsOff) { _toolsOff = true; _failWhy += " [tools→off]"; } }
      if (!_cand) {
        // 🔴 كان: break صامت → لا رد للعميل ولا سجل. الآن: نسجّل السبب ونعيد مرة واحدة،
        //    وبعدها يتولّى حارس «لا سكوت» تحت (سؤال حتميّ من البيانات المخزّنة).
        _genFails++;
        console.error("intake model fail", from, _model, _failWhy);
        await logGuard(supabase, from, "model_fail", "retry", _failWhy, _att, "", "");
        if (_genFails >= 2) break;
        continue;
      }
      const _cm = Array.isArray(_cand.messages) ? (_cand.messages as unknown[]).map(x => String(x || "")) : (_cand.reply ? [String(_cand.reply)] : []);
      const _candText = _cm.join("  ");
      const _cf = (_cand.fields && typeof _cand.fields === "object") ? _cand.fields as Record<string, unknown> : {};
      const _facts = { ...(prev as Record<string, unknown>), ...Object.fromEntries(Object.entries(_cf).filter(([_, v]) => v !== null && v !== undefined && String(v).trim() !== "")) };
      const _rej = guardReject(_candText, _facts, { isUmrah, isOmani, allowedPlacesText: adRef ? JSON.stringify(adRef) : "" });
      if (!_rej) { out = _cand; break; }   // نظيف
      _guardRejects.push({ guard: _rej.guard, reason: _rej.reason, attempt: _att, text: _candText });
      if (_att >= 3) { out = _cand; _guardForcePreview = true; break; }   // استنفدت → معاينة بشرية
      _sysTry = sys + `\n\n⚠️⚠️ حارسٌ رفض ردك السابق للسبب: «${_rej.reason}». أعد صياغة ردك ملتزماً بهذا تماماً، ولا تكرّر نفس الخطأ.`;
    }
  }
  for (const r of _guardRejects) {
    const _isLast = r === _guardRejects[_guardRejects.length - 1];
    await logGuard(supabase, from, r.guard, (_guardForcePreview && _isLast) ? "reject_then_preview" : "reject", r.reason, r.attempt, r.text, "");
  }
  // 🛡️ حارس «لا سكوت في الاستقبال» (طلب المالكة ١ نوفمبر ٢٠٢٦): سؤال حتميّ (بلا نموذج)
  //    عن أول معلومة ناقصة من البيانات المخزّنة — يُستعمل لو فشل النموذج، أو انتهى
  //    الاستقبال بلا أي رسالة للعميل.
  const _intakeFallback = (d: Record<string, unknown>): string => {
    const _h = (k: string) => d[k] !== undefined && d[k] !== null && String(d[k]).trim() !== "";
    if (!_h("destination") && !isUmrah) return alreadyGreeted ? "حياك الله، وين حابين تسافرون؟" : "حياك الله، معك طلال من خدمة العملاء، وين حابين تسافرون؟";
    if (!_h("pax")) return isUmrah ? "أبشر، عندنا برامج عمرة. كم عدد المعتمرين معكم؟" : "أبشر، كم عدد المسافرين معكم؟";
    if (!_h("date")) return "متى موعد السفر؟";
    if (isUmrah && !_h("nights")) return "كم ليلة تبون في مكة؟ وإذا حابين نضيف المدينة المنورة بلغني كم ليلة فيها";
    if (!isUmrah && !_h("days")) return "كم يوم تبون الرحلة؟";
    return "تمام، خليني أراجع تفاصيل طلبك وأرد عليك بأقرب وقت";
  };
  if (!out) {
    // النموذج فشل مرتين → بدل الصمت نسأل سؤالاً حتمياً ونكمل بقية خط الأنابيب كالمعتاد
    // (البوابات/ملخّص التأكيد تتجاوزه لو لزم).
    // ردّ العميل برقم مجرّد على سؤال العدد → نلتقطه خادمياً (كان الاحتياطي يعيد سؤال العدد
    //   فيضطر العميل يكرّر «٦» — حادثة ٢ نوفمبر).
    const _fbFields: Record<string, unknown> = {};
    const _lastT = (msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "");
    const _bareN = String(args.body || "").trim().replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    if (/^\d{1,2}$/.test(_bareN) && /كم\s*عدد/.test(_lastT) && !(Number((prev as Record<string, unknown>).pax) > 0)) _fbFields.pax = Number(_bareN);
    const _fb = _intakeFallback({ ...((prev || {}) as Record<string, unknown>), ..._fbFields });
    out = { messages: [_fb], fields: _fbFields, complete: false };
    await logGuard(supabase, from, "no_silence_fallback", "fallback_reply", "النموذج فشل مرتين", _genFails, "", _fb);
  }
  // رسائل قصيرة منفصلة (تُرسل بالتتابع للحفاظ على الترتيب) — تدعم messages مصفوفة أو reply نصّي.
  let outMsgs: string[] = [];
  if (Array.isArray(out.messages)) outMsgs = (out.messages as unknown[]).map(x => String(x || "").trim()).filter(Boolean);
  else if (out.reply) outMsgs = [String(out.reply).trim()];

  // ── تصحيح الوجهة (خادميّ — منع مطلق للاختلاق): النموذج قد يخترع اسم دولة
  // خاطئ رغم أن المدن تدل على وجهة أخرى (مثال حقيقي: «الإمارات» بينما المدن
  // شنغهاي/سوجو = الصين). القاعدة: **المدن هي المرجع القاطع** للوجهة، لا اسم
  // الدولة الذي يكتبه النموذج (قد يكون مهلوساً). نستنتج الدولة من **المدن
  // وحدها**، فإن اختلفت عمّا سمّاه النموذج نصحّح الحقل المخزّن **والرسالة
  // الصادرة** (نستبدل الاسم المخترَع بالصحيح) قبل الإرسال.
  {
    const _f = (out.fields && typeof out.fields === "object") ? out.fields as Record<string, unknown> : null;
    const _prevRec = (prev || {}) as Record<string, unknown>;
    const _citiesStr = String((_f?.cities) ?? _prevRec.cities ?? "");
    const _destStr = String((_f?.destination) ?? _prevRec.destination ?? "");
    const _claimed = _destStr.split("(")[0].trim();  // اسم الدولة قبل أي قوس
    // المرجع القاطع = المدن وحدها. لا ندخل _destStr في الاستنتاج حتى لا يعيد
    // النموذج المهلوس فرض نفسه. عند غياب المدن، نستأنس بالسجل فقط.
    const _detFromCities = extractDestination(_citiesStr);
    const _detected = _detFromCities || extractDestination(transcript);
    const _claimedDet = _claimed ? extractDestination(_claimed) : null;
    // شرط التصحيح: عرفنا الوجهة الصحيحة، والنموذج سمّى دولة **مختلفة** عنها.
    if (_detected && _claimed && _claimed.length >= 3
        && _claimedDet !== _detected && !_claimed.includes(_detected)) {
      if (_f) _f.destination = _citiesStr ? `${_detected} (${_citiesStr})` : _detected;
      // استبدل الاسم المخترَع بالصحيح في كل رسالة صادرة.
      outMsgs = outMsgs.map(m => m.split(_claimed).join(_detected));
      console.log("destination-guard: corrected", _claimed, "→", _detected, "(cities:", _citiesStr + ")");
    } else if (_detFromCities && _f && (!_claimed || _claimedDet !== _detFromCities)) {
      // شبكة أمان: المدن معروفة والوجهة المخزّنة فاضية/غامضة → اضبطها من المدن.
      _f.destination = `${_detFromCities} (${_citiesStr})`;
    }
  }

  // ── حارس تغيير الوجهة (خادميّ): العميل قد يغيّر رأيه بالوجهة بنص المحادثة
  //    (ماليزيا → البوسنة)، والنموذج قد يبقى على القديمة بسبب السجل. القاعدة:
  //    **أحدث وجهة يذكرها العميل (آخر رسالتين) تفوز** — نصحّح الحقل والرسالة
  //    الصادرة ونمسح المدن القديمة (خاصّة بالوجهة السابقة).
  {
    const _DEST_AR: Record<string, string> = {
      Vietnam: "فيتنام", Malaysia: "ماليزيا", thailand: "تايلند", Turky: "تركيا",
      russia: "روسيا", Bosnia: "البوسنة", indonesia: "إندونيسيا", Oman: "عُمان",
      "South Africa": "جنوب أفريقيا", mauritius: "موريشيوس", England: "إنجلترا",
      China: "الصين", Egypt: "مصر", Morroco: "المغرب", Spain: "إسبانيا", "Sri lanka": "سريلانكا", "Abu Dhabi": "أبوظبي",
    };
    const _lastCust2 = msgs.filter(m => m.who === "العميل").slice(-2).map(m => m.body).join("  ");
    const _recentDest = extractDestination(_lastCust2);                 // وجهة من آخر رسالتين للعميل
    const _f3 = (out.fields && typeof out.fields === "object") ? out.fields as Record<string, unknown> : null;
    const _modelDestKey = _f3 && _f3.destination ? extractDestination(String(_f3.destination)) : null;
    const _prevRec3 = (prev || {}) as Record<string, unknown>;
    const _storedDestKey = _prevRec3.destination ? extractDestination(String(_prevRec3.destination)) : null;
    // الوجهة المعتمدة = الأحدث من العميل، وإلا المخزّنة بالجلسة. (النموذج آخر مرجع.)
    const _authKey = _recentDest || _storedDestKey;
    if (_authKey && _modelDestKey && _authKey !== _modelDestKey) {
      const _newAr = _DEST_AR[_authKey]
        || (_recentDest ? _authKey : String(_prevRec3.destination || "").split("(")[0].trim());
      const _oldAr = _DEST_AR[_modelDestKey] || String(_f3?.destination || "").split("(")[0].trim();
      // امسح المدن القديمة فقط لو العميل **غيّر** الوجهة فعلاً (ذكر وجهة جديدة تخالف المخزّنة).
      if (_f3) { _f3.destination = _newAr; if (_recentDest && _recentDest !== _storedDestKey) _f3.cities = ""; }
      if (_oldAr && _newAr) outMsgs = outMsgs.map(m => m.split(_oldAr).join(_newAr));
      console.log("dest guard:", _modelDestKey, "→", _authKey, _recentDest ? "(recent)" : "(stored)");
    }
  }

  // ── حارس الأعمار (خادميّ، لا يعتمد على التزام النموذج) ─────────────────
  // بعد معرفة عدد المسافرين لازم نعرف: كلهم بالغين ولا فيهم أطفال؟ (السعر
  // يختلف بعمر الطفل). النموذج (Haiku) أحياناً يتخطّى هالسؤال ويكمل للتاريخ/
  // المدن — فنفرضه خادميّاً: لو العدد معروف والأعمار فاضية وما تأكّد إنهم
  // بالغين وما سبق سألنا، نستبدل رد النموذج بسؤال الأطفال ونمنع الإقفال.
  const _gm = { ...(prev as Record<string, unknown>), ...((out.fields && typeof out.fields === "object") ? out.fields as Record<string, unknown> : {}) };
  // شبكة أمان خادميّة: لو النموذج ما استخرج العدد، نستخرجه من كلام العميل نفسه
  // (آخر رسائله) بصرامة — فلا يعيد طلال السؤال عن عدد قاله العميل («شخصين» إلخ).
  const _custText = msgs.filter(m => m.who === "العميل").slice(-8).map(m => m.body).join("  ");
  const _paxFromCust = extractPaxStrict(_custText);
  const _paxNumModel = Number(_gm.pax);
  const _paxNum = (Number.isFinite(_paxNumModel) && _paxNumModel > 0) ? _paxNumModel : (_paxFromCust || NaN);
  const _paxKnown = Number.isFinite(_paxNum) && _paxNum > 0;
  // ثبّت العدد المُستخرَج خادميّاً في البيانات ليُحفظ ويُستخدَم لاحقاً.
  if (_paxFromCust && !(Number.isFinite(_paxNumModel) && _paxNumModel > 0)) _gm.pax = _paxFromCust;
  const _agesEmpty = !String(_gm.ages || "").trim();
  // 🔴 ٤ نوفمبر ٢٠٢٦ (حي، المالكة: «كل مره نفس الموال»): «سألنا عن الأطفال» ≠ «العميل جاوب». «الخمسة كلهم بالغين ولا فيه أطفال؟»
  //    → «عفو ٣» (تصحيح عدد، مو جواب) → طلال اعتبرهم بالغين ووصل لتأكيد «عمرة لـ3 أشخاص» بلا سؤال الأعمار.
  //    الحين: السؤال يُعتبر مُجاب فقط لو رد العميل بعده فيه جواب فعلي (أطفال/بالغين/لا/كلهم…)؛ حد أقصى سؤالين.
  const _startedTs = Date.parse(String(_gm.started_at || "")) || 0;
  const _kidQRe = /بالغين\s*ولا|معكم\s*أطفال|(?:فيه|في|فيهم)\s*أطفال/;
  const _kidQIdx = msgs.map(m => m.who === "طلال" && _kidQRe.test(m.body)).lastIndexOf(true);
  const _kidQCount = msgs.filter(m => m.who === "طلال" && _kidQRe.test(m.body) && (Date.parse(m.ts) || 0) >= _startedTs).length;
  const _afterKidQ = _kidQIdx >= 0 ? msgs.slice(_kidQIdx + 1).filter(m => m.who === "العميل").map(m => m.body).join(" ") + " " + String(args.body || "") : "";
  const _kidAnsweredRe = /طفل|اطفال|أطفال|عيال|صغار|بالغ|كبار|كلهم|كلنا|جميع|رضيع|بزر|ياهل|يهال|ولد|بنت|عمر|سن[ةه]|(?:^|\s)(?:لا|لأ|ابد|أبد|أبداً|ما\s*في|مافي|مافيه|ما\s*فيه|ولا\s*واحد|نعم|ايوه|إيوه|أيوه|إيه|ايه|اي|فيه|في)(?=\s|$|[!.،؟?])/;
  const _askedChildren = _gm.asked_children === true && (_kidQIdx < 0 || _kidQCount >= 2 || !(Number(_gm.pax) >= 2) || _kidAnsweredRe.test(_afterKidQ));

  // ── حارس تغيير الوجهة (خادميّ) ───────────────────────────────────────────
  // لو طلب العميل تغيير الوجهة («أبي أغير الوجهة»)، ❌ لا نتمسّك بالمخزّنة من
  // العرض/السجل: لو ذكر وجهة جديدة بنفس الرسالة نحدّثها، وإلا نمسحها ونسأله عن
  // الجديدة (ونمنع إعادة التقاطها من السجل القديم عبر علم dest_changing). ونمسح
  // توزيع/مدن الوجهة القديمة. (شكوى المالكة ٣١ أكتوبر: طلب تغيير فتمسّك طلال بماليزيا.)
  const _bodyNow = String(args.body || "");
  const _prevChanging = _gm.dest_changing === true;
  const _wantsDestChange = /(?:أغيّ?ر|اغيّ?ر|غيّ?ر(?:ت|ي)?|بدّ?ل|بغيّ?ر)\s*(?:ال)?وجه[ةه]|وجه[ةه]\s*(?:ثاني[ةه]?|غير|أخرى|اخرى|تاني[ةه]?)|change\s*(?:the\s*)?destination/i.test(_bodyNow);
  // 🔴 حارس تأكيد تبديل الوجهة (طلب المالكة ١ نوفمبر ٢٠٢٦): لو طلب العميل تبديل
  //    الوجهة لوجهة جديدة وفيه وجهة قديمة مختلفة → ❌ لا نبدّل بصمت ونرسل الملخّص؛
  //    نسأل «تقصد تبي تغيّر الوجهة من X إلى Y؟» ونطبّق فقط بعد تأكيده (مثل حارس العدد).
  const _oldDest0 = String((prev as Record<string, unknown>).destination || "").trim();
  const _askedDestChange = (prev as Record<string, unknown>).asked_dest_change === true;
  const _pendingDest0 = String((prev as Record<string, unknown>).pending_dest || "").trim();
  let _destChangeApply = false;
  let _destChangeConfirmFired = false;
  let _pendingDestAsk = "";
  let _keepOldDest = false;
  let _destOverride = "";
  // الوجهة التي أخرجها النموذج هذا الدور (قد تكون مدموجة «X وY» أو مختلفة عن المخزّنة).
  const _modelDest = String((out.fields && (out.fields as Record<string, unknown>).destination) || "").trim();
  const _destParts = _modelDest.split(/\s+و\s+|،|,|\/|\s+أو\s+/).map(x => x.trim()).filter(Boolean);
  const _isMultiDest = _destParts.length > 1;
  if (_askedDestChange && _pendingDest0) {
    // الدور التالي: ردّ العميل على سؤال التأكيد. «نعم» → المعلّقة؛ سمّى وجهة → اعتمدها.
    const _respDest = extractDestination(_bodyNow);
    const _umrahPick = _isUmrahDest(_oldDest0) && _isOmanDest(_pendingDest0) ? _oldDest0
      : (_isUmrahDest(_pendingDest0) && _isOmanDest(_oldDest0) ? _pendingDest0 : "");
    if (_umrahPick) { _gm.destination = _umrahPick; _destOverride = _umrahPick; }   // v464: عمرة×عُمان → العمرة بلا سؤال
    else if (isAffirmative(_bodyNow)) { _gm.destination = _pendingDest0; _gm.cities = ""; _gm.dest_changing = false; _destChangeApply = true; }
    else if (_respDest) { _gm.destination = _respDest; _gm.cities = ""; _gm.dest_changing = false; _destChangeApply = true; }
    else if (_oldDest0) { _gm.destination = _oldDest0; _destOverride = _oldDest0; }   // v464: ردّ بلا حسم («وينكم») → تبقى القديمة
    _gm.asked_dest_change = false; _gm.pending_dest = "";
  } else if (_oldDest0 && _modelDest && isOmani && _isOmanDest(_modelDest) && !_isOmanDest(_oldDest0)) {
    // 🔴 قاعدة المالكة الصارمة: رقم عُماني → عُمان مو وجهة بديلة (مكان الإقلاع) — نُبقي القديمة بلا سؤال.
    _gm.destination = _oldDest0; _keepOldDest = true;
  } else if (!_wantsDestChange && _oldDest0 && _modelDest && _modelDest !== _oldDest0 && _sameDestish(_oldDest0, _modelDest, msgs)) {
    _gm.destination = (_isUmrahDest(_modelDest) && !_isUmrahDest(_oldDest0)) ? _modelDest : _oldDest0; _keepOldDest = true;   // ليس تبديلاً (مطار إقلاع/صيغة أخرى) → نُبقي الوجهة المخزّنة
  } else if (_oldDest0 && _modelDest && (_isMultiDest || _modelDest !== _oldDest0) && !extractDestination(_bodyNow) && !fuzzyDestination(_bodyNow)) {
    // النموذج طلّع وجهة ثانية والعميل ما ذكر أي وجهة برسالته → ❌ لا سؤال «تقصد X ولا Y؟»؛ تبقى المخزّنة.
    _gm.destination = _oldDest0; _keepOldDest = true;
  } else if (_oldDest0 && _modelDest && (_isMultiDest || _modelDest !== _oldDest0)) {
    // 🔴 تبديل/تناقض وجهة (أعمّ من صياغة «أغيّر الوجهة» — يمسك حتى الأخطاء الكتابية
    //    والدمج): النموذج أخرج وجهة تختلف عن المخزّنة أو وجهتين معاً → اسأل التأكيد بدل
    //    التبديل/الدمج الصامت، ونُبقي القديمة حتى يحسم العميل. (طلب المالكة.)
    const _newD = _isMultiDest ? (_destParts.find(p => p !== _oldDest0) || _destParts[_destParts.length - 1]) : _modelDest;
    outMsgs = [`تمام 🌟 عشان ما يصير لبس: تقصد وجهتك ${_oldDest0} ولا ${_newD}؟`];
    _destChangeConfirmFired = true; _pendingDestAsk = _newD;
    _gm.destination = _oldDest0;
  } else if (_wantsDestChange) {
    const _nd = extractDestination(_bodyNow); // الرسالة الحالية فقط، لا السجل
    _gm.destination = _nd || "";
    _gm.dest_changing = !_nd;
    _gm.cities = "";
    _destChangeApply = true;
  } else if (_prevChanging && !String(_gm.destination || "").trim()) {
    // بوضع تغيير مستمر والنموذج ما التقط الوجهة الجديدة → جرّبها خادميّاً من رسالته.
    const _nd = extractDestination(_bodyNow);
    if (_nd) { _gm.destination = _nd; _gm.dest_changing = false; _destChangeApply = true; }
  }
  if (_gm.dest_changing === true && String(_gm.destination || "").trim()) { _gm.dest_changing = false; _destChangeApply = true; }
  const _destChanging = _gm.dest_changing === true;

  // ── حارس سؤال الوجهة (خادميّ) ───────────────────────────────────────────
  // ❌ ممنوع نسأل «وين تسافرون» إذا الوجهة معروفة أصلاً: العميل أرسل صورة عرض،
  // أو ذكر وجهة/مدينة، أو مخزّنة سابقاً، أو الطلب عمرة. الإعلانات متعددة العروض
  // (كاروسيل) عندها adRef بلا وجهة محددة، والنموذج أحياناً يسأل «وين تسافرون»
  // حتى بعد ما يذكر العميل وجهته (رسائل متلاحقة) — فنكبح السؤال خادميّاً ونسأل
  // أول ناقص (العدد ثم التاريخ) بدله.
  const _destStored = String(_gm.destination || "").trim();
  // عند التغيير: لا نستنتج الوجهة من السجل/العرض القديم — فقط المخزّنة المحدَّثة.
  let _destLabel = _destStored || (isUmrah && !_destChanging ? "العمرة" : "") || (_destChanging ? "" : (extractDestination(transcript) || ""));
  if (!_destLabel && _sentOwnOfferImage && !_destChanging) {
    // نص الصورة داخل الرسالة: «أرسل العميل صورة هذا العرض: عرض: <الوجهة> (...)».
    const _od = String(args.body || "").replace(/^أرسل العميل صورة هذا العرض:\s*/, "");
    _destLabel = extractDestination(_od) || (_od.match(/عرض:\s*([^\n(—\-|]+)/)?.[1] || "").trim();
  }
  const _destKnown = !!_destLabel || _sentOwnOfferImage;
  const _outAsksDest = /وين\s*(?:حابين\s*|ودكم\s*|ناوين\s*)?(?:ت?سافر(?:ون|وا|وين)?|ودك(?:م)?|تبون|رايحين|قاصدين)|أي[نّ]?\s*وجه[ةه]|اي\s*وجه[ةه]|وين\s*(?:الوجهة|بتروحون)|which\s+destination/i.test(outMsgs.join(" "));
  // رحلة شهر عسل → المسافرون شخصان (٢) بالبداهة؛ نؤكّد بدل ما نسأل من الصفر.
  const _honeymoon = /شهر\s*(?:ال)?عسل|هني\s*مون|honeymoon|عرسنا|متزوجين\s*جدد/i.test(custTranscript);
  // حارس تغيير الوجهة: طلب العميل التغيير بلا تسمية وجهة جديدة → نسأله عنها
  //   مباشرةً (يتقدّم على بقية الحُرّاس، ويمنع الإقفال حتى يعطي الوجهة الجديدة).
  let _destChangeGateFired = false;
  if (_destChanging && !_destStored) {
    outMsgs = ["تمام، لأي وجهة تحب نغيّرها؟"];
    _destChangeGateFired = true;
  }
  let _destGateFired = false;
  if (!_destChangeGateFired && _destKnown && _outAsksDest) {
    const _g = alreadyGreeted ? "" : "حياك الله 🌟 معك طلال، ";
    const _forOffer = _destLabel ? `بخصوص ${/عرض|العمرة/.test(_destLabel) ? _destLabel : "عرض " + _destLabel}` : "بخصوص طلبك";
    if (!_paxKnown && _honeymoon) outMsgs = [`${_g}${_forOffer} — مبارك شهر العسل 🌟 أفهم إنكم شخصين (٢)، صح؟ ومتى موعد السفر تقريباً؟`];
    else if (!_paxKnown) outMsgs = [`${_g}${_forOffer} — كم عدد المسافرين معكم؟`];
    else outMsgs = [`${_g}${_forOffer} — متى موعد السفر تقريباً؟`];
    _destGateFired = true;
  }

  // ── حارس تأكيد عدد مسافري شهر العسل (خادميّ) ───────────────────────────
  // طلب المالكة: شهر العسل = شخصان (٢)، ولازم طلال **يؤكّد** العدد صراحةً بدل
  // ما يفترضه بصمت أو ينتقل للتاريخ. نفرضه إذا لم يذكر ردّ النموذج العدد بعد.
  const _askedHmPax = _gm.asked_hm_pax === true;
  const _outConfirmsPax = /شخصين|اثنين|٢|\b2\b|عدد\s*المسافر/.test(outMsgs.join(" "));
  // هل ذكر العميل عدداً صريحاً؟ (لو نعم لا نؤكّد — معروف أصلاً).
  const _paxStated = /\d+\s*(?:شخص|أشخاص|اشخاص|نفر|بالغ|كبار|معتمر|راكب|فرد)|(?:ثلاث|أربع|اربع|خمس|ست|سبع|ثمان|تسع|عشر)[ةه]?\s*(?:أشخاص|اشخاص|نفر|بالغين|أفراد)/.test(custTranscript);
  let _hmPaxGateFired = false;
  // شهر عسل بلا عدد صريح → أكّد شخصين (٢) صراحةً، حتى لو استنتج النموذج العدد بصمت.
  if (_honeymoon && !_askedHmPax && !_destGateFired && !_outConfirmsPax && !_paxStated && (!_paxKnown || _paxNum === 2)) {
    const _g2 = alreadyGreeted ? "" : "حياك الله 🌟 معك طلال، ";
    const _forHm = _destLabel ? ` إلى ${_destLabel.replace(/^عرض\s*/, "")}` : "";
    outMsgs = [`${_g2}مبارك شهر العسل 🌟 أفهم إنها رحلة شخصين (٢)${_forHm}، صح؟`];
    _hmPaxGateFired = true;
  }

  // ── حارس عدد المسافرين (خادميّ) ─────────────────────────────────────────
  // بعد معرفة الوجهة لازم نعرف العدد قبل التاريخ/الباقي. النموذج أحياناً يسأل
  // سؤالين مع بعض («موعد السفر وعدد المسافرين») فيجيب العميل عن واحد فقط ويبقى
  // العدد مجهولاً؛ أو ينتقل للتاريخ بلا عدد. نفرض سؤال العدد **وحده** متى كانت
  // الوجهة معروفة والعدد مجهولاً ولم يسأله النموذج في هذا الرد.
  const _outAsksPax = /كم\s*(?:هو\s*)?(?:عدد|العدد)?\s*(?:المسافر|الأشخاص|الاشخاص|المعتمر|الركاب|شخص|الأفراد|الاعضاء|الأعضاء)|عدد\s*(?:المسافر|المعتمر|الأشخاص|الاشخاص)|كم\s*(?:شخص|نفر|معتمر|فرد|واحد)|معكم\s*كم|الرحلة\s*لكم/.test(outMsgs.join(" "));
  const _isUmrahPax = isUmrah || /عمرة|مكة|مكه|المدينة\s*المنورة|الحرم/.test(_destLabel);
  let _paxGateFired = false;
  // ملاحظة: لا نشترط alreadyGreeted — لو الوجهة معروفة والعدد مجهول ولم يسأل النموذج
  // العدد (حتى لو كان هذا أول رد، كإعلان مكة) نفرض السؤال مع ترحيب، فلا «يقف» طلال.
  if (_destKnown && !_paxKnown && !_honeymoon && !_destGateFired && !_hmPaxGateFired && !_outAsksPax) {
    const _gp = alreadyGreeted ? "تمام 🌟 " : "حياك الله 🌟 معك طلال، ";
    outMsgs = [_isUmrahPax ? `${_gp}كم عدد المعتمرين معكم؟` : `${_gp}كم عدد المسافرين معكم؟`];
    _paxGateFired = true;
  }

  // تأكيد صريح إنهم بالغين (في نص المحادثة كاملاً) → لا داعي للسؤال.
  // شهر العسل = بالغَان، فلا نسأل عن الأطفال.
  const _adultsConfirmed = _honeymoon || /كل(?:هم|نا)?\s*(?:كبار|بالغين)|جميعهم?\s*بالغين|بالغين\s*فقط|(?:ما|بدون|بلا|مافي|ما\s*في)\s*(?:فيه\s*)?(?:أطفال|اطفال|عيال|صغار)/.test(custTranscript);
  // هل رد النموذج نفسه يسأل عن الأطفال/الكبار؟ (لا نكرّر فوقه)
  const _outAsksAges = /بالغين|كبار|أطفال|اطفال|عيال|صغار|أعمار|اعمار/.test(outMsgs.join(" "));
  let _ageGateFired = false;
  if (_paxKnown && _agesEmpty && !_adultsConfirmed && !_askedChildren && !_outAsksAges) {
    // صياغة مباشرة تسأل: كلهم بالغين ولا فيهم أطفال؟ (بلا سؤال عمر أي بالغ)
    outMsgs = [`تمام 🌟 الـ${_paxNum} كلهم بالغين ولا معكم أطفال؟ 👶 (أسأل لأن سعر الأطفال يختلف حسب أعمارهم)`];
    _ageGateFired = true;
  }
  // 🔴 حارس عمر الطفل (طلب المالكة ٢ نوفمبر ٢٠٢٦): العميل قال «فيه طفل» والأعمار
  //    فاضية → ❌ لا ننتقل للسؤال التالي (الليالي/التاريخ) ولا نقفل؛ نسأل العمر أولاً
  //    (السعر يعتمد عليه). حدّ أقصى مرّتين (asked_ages_n) كي لا يعلق لو رفض العميل.
  const _kidsSaid = /(?:^|[^ء-ي])(?:[وف]?(?:ال)?(?:طفل(?:ين|ة|تين)?|أطفال|اطفال|عيال|رضيع(?:ة)?|بزر|بزورة|صغار|ياهل|يهال))(?![ء-ي])/.test(_custText);
  const _askedAgesN = Number(_gm.asked_ages_n) || 0;
  // ردّ العميل على سؤال العمر برقم ولم يملأه النموذج → نلتقطه خادميّاً (لا نعيد السؤال).
  // الأعمار «معروفة» فقط لو فيها رقم — النموذج أحياناً يكتب ages:«طفلين» فتبدو غير فاضية.
  const _kidAgesUnknown = !/[0-9٠-٩]/.test(String(_gm.ages || ""));
  const _kidAgeFromBody = (_askedAgesN > 0 && _kidAgesUnknown && /[0-9٠-٩]/.test(_bodyNow)) ? _bodyNow.trim().slice(0, 60) : "";
  let _kidAgeGateFired = false;
  // ⚠️ نفرض صيغتنا دائماً (حتى لو النموذج سأل العمر) — وإلا يكتب حارس الليالي فوق سؤال
  //    النموذج (حادثة ٢ نوفمبر: «طفل واحد» → قفز لليالي). عندنا الطفل = ٥ سنوات وأقل،
  //    فلا نفترض عمره أبداً. صيغة المالكة: «ممكن أعرف كم عمره؟».
  if (!_ageGateFired && _paxKnown && _kidAgesUnknown && !_kidAgeFromBody && _kidsSaid && !_adultsConfirmed && _askedAgesN < 2) {
    const _plural = /طفلين|طفلتين|أطفال|اطفال|عيال|صغار|يهال|[2-9٢-٩]\s*(?:طفل|أطفال|اطفال)/.test(_custText);
    const _girl = !_plural && /طفلة|بنت/.test(_custText);
    outMsgs = [_plural ? "ممكن أعرف كم أعمارهم؟" : (_girl ? "ممكن أعرف كم عمرها؟" : "ممكن أعرف كم عمره؟")];
    _ageGateFired = true;
    _kidAgeGateFired = true;
  }

  // ── حارس ليالي العمرة (خادميّ) ──────────────────────────────────────────
  // تسعير العمرة بالليلة، فلازم نعرف عدد الليالي (كم ليلة في مكة/المدينة).
  // مسار «عرض الإعلان» (isAdOfferInquiry) كان يأمر النموذج يتخطّى سؤال الليالي
  // باعتبار العرض ثابتاً — فيقفل بلا مدة. نفرض السؤال خادميّاً للعمرة متى كانت
  // المدة مجهولة (بعد حسم الأعمار، سؤال واحد كل مرة). يُستثنى: أعطى مدى تاريخي
  // (من–إلى) أو عدد ليالٍ/أيام صريح → المدة معروفة.
  const _nightsVal = String(_gm.nights || "").trim();
  const _nightsKnown = !!_nightsVal
    || /\d+\s*(?:ليل|ليال|ايام|أيام|يوم)/.test(custTranscript)
    || /(?:من|from)\s*\d{1,2}[^\d]{0,14}(?:إلى|الى|لـ|ل|-|–|to)\s*\d{1,2}/i.test(custTranscript);
  const _askedNights = _gm.asked_nights === true;
  const _outAsksNights = /كم\s*(?:ليل|يوم|ليال)|عدد\s*(?:الليال|الأيام|الايام)|كم\s*مدة|كم\s*تقضون/.test(outMsgs.join(" "));
  // نسأل الليالي فقط بعد حسم الأعمار (ما يفترض يفوت سؤالين بنفس الرد).
  const _agesResolved = !_ageGateFired && (_askedChildren || !_agesEmpty || _adultsConfirmed);
  let _nightsGateFired = false;
  if (isUmrah && _paxKnown && _agesResolved && !_nightsKnown && !_askedNights && !_outAsksNights) {
    outMsgs = ["كم ليلة تنوون تقضون في مكة؟ 🕋 (وإن حاب نضيف لك المدينة المنورة بلّغني كم ليلة فيها)"];
    _nightsGateFired = true;
  }

  // ── حارس تعارض المدة (خادميّ) ───────────────────────────────────────────
  // لو ذكر العميل عدد أيام يناقض التواريخ/الليالي (مثل «10 days» مع «18-30
  // December» = 12 ليلة ≈ 13 يوم)، طلال **ينبّه العميل** ويطلب يوضّح قبل ما يبني،
  // بدل ما يعتمد رقماً متناقضاً بصمت أو يبني برنامجاً بمدة خاطئة. (طلب المالكة ٣١
  // أكتوبر.) غير العمرة (الليالي وحدة التسعير فيها فلا يُقارَن بالأيام).
  const _durDaysN   = parseInt(String(_gm.days   || "").replace(/[^\d]/g, ""), 10);
  const _durNightsN = parseInt(String(_gm.nights || "").replace(/[^\d]/g, ""), 10);
  const _askedDurConflict = _gm.asked_duration_conflict === true;
  let _durGateFired = false;
  if (!_isUmrahPax
      && Number.isFinite(_durDaysN) && _durDaysN > 0
      && Number.isFinite(_durNightsN) && _durNightsN > 0
      && Math.abs(_durDaysN - (_durNightsN + 1)) >= 2
      && !_askedDurConflict
      && !_destGateFired && !_paxGateFired && !_hmPaxGateFired
      && !_ageGateFired && !_nightsGateFired) {
    const _expDays = _durNightsN + 1;
    outMsgs = [`لاحظت تعارض بسيط في المدة: كتبت ${_durDaysN} أيام، لكن التواريخ اللي ذكرتها تقارب ${_expDays} يوم (${_durNightsN} ليلة). أيهما نعتمد: عدد الأيام ولا التواريخ؟`];
    _durGateFired = true;
  }

  // ── حارس تغيير العدد الملتبس (خادميّ) ───────────────────────────────────
  // طلب المالكة (١ نوفمبر ٢٠٢٦): بعد ما يُظهر طلال كرت/ملخّص العدد ويؤكّده العميل،
  // لو رجع العميل بتغيير **ملتبس** للعدد (مثل «أضيف شخص رابع» والعدد أصلاً ٤، أو
  // «أضيفهم أربعة» وهم أربعة) → ❌ ممنوع يخمّن (كتب ٥ بصمت). لازم **يسأل تأكيداً
  // بشرياً** أولاً: «أنت مؤكّد سابقاً ٤ — يبقون ٤ ولا يصيرون ٥؟» قبل أي رقم جديد.
  // الالتباس = فعل «إضافة» (أضيف/زد/...) مع عدد ≤ الحالي، أو ترتيب شخص (رابع/خامس)
  // لا يساوي الحالي+١. أما «خليهم ٥» (تحديد صريح للإجمالي، عدد > الحالي) فواضح → يُطبَّق
  // بلا سؤال (يحترم [[feedback_talal_pax_stated_no_reask]]).
  const _prevPaxN = Number((prev as Record<string, unknown>).pax);
  const _prevPaxKnown = Number.isFinite(_prevPaxN) && _prevPaxN > 0;
  const _askedPaxConfirm = (prev as Record<string, unknown>).asked_pax_confirm === true;
  const _bnPax = arabicToAsciiDigits(_bodyNow);
  const _hasAddVerb = /(?:أضيف|اضيف|أضيفهم|اضيفهم|أضف|اضف|ضيف|ضف|نضيف|نزيد|أزيد|ازيد|زد|زيد|زيدو)/.test(_bnPax);
  const _ORD_W: Record<string, number> = { "ثالث": 3, "رابع": 4, "خامس": 5, "سادس": 6, "سابع": 7, "ثامن": 8, "تاسع": 9, "عاشر": 10 };
  const _ordM = _bnPax.match(/(?:شخص|نفر|فرد|معتمر|راكب|بالغ|واحد)\s*(ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع|عاشر)/)
    || _bnPax.match(/(ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع|عاشر)\s*(?:شخص|نفر|فرد|معتمر|راكب|بالغ)/);
  const _ordNum = _ordM ? (_ORD_W[_ordM[1]] ?? null) : null;
  const _curPaxStated = extractPaxStrict(_bnPax);   // عدد صريح بجانب كلمة شخص في الرسالة الحالية
  let _paxChangeGateFired = false;
  if (_prevPaxKnown && !_askedPaxConfirm && !_destGateFired && !_destChangeGateFired) {
    const _ambigByOrdinal = _ordNum != null && _ordNum !== _prevPaxN + 1;
    const _ambigByAddVerb = _hasAddVerb && _curPaxStated != null && _curPaxStated <= _prevPaxN;
    if (_ambigByOrdinal || _ambigByAddVerb) {
      const _unit = _isUmrahPax ? "معتمرين" : "أشخاص";
      outMsgs = [`تمام 🌟 أنت مؤكّد سابقاً ${_prevPaxN} ${_unit}. توضيح بسيط: تقصد يبقون ${_prevPaxN}، ولا تبيهم يصيرون ${_prevPaxN + 1}؟`];
      _paxChangeGateFired = true;
      await logGuard(supabase, from, "pax_change_ambiguous", "reject",
        `العدد المؤكّد=${_prevPaxN}، تغيير ملتبس (ordinal=${_ordNum ?? "-"}, stated=${_curPaxStated ?? "-"}) → سؤال تأكيدي`, 1, _bodyNow, outMsgs[0]);
    }
  }

  // 👥 ٤ نوفمبر ٢٠٢٦ (حي): «٥» → «الخمسة كلهم بالغين ولا فيه أطفال؟» → «عفو ٣» → طلال خزّن ٣ واعتبرهم بالغين وراح لليالي.
  //    تصحيح العدد وسؤال الأطفال معلّق → تأكيد العدد الجديد + نفس سؤال الأطفال.
  {
    const _ltI = msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "";
    const _newPaxI = Number((out.fields as Record<string, unknown> | undefined)?.pax);
    if (!_paxChangeGateFired && _prevPaxKnown && /بالغين\s*ولا\s*(?:فيه|في)\s*أطفال|فيهم\s*أطفال/.test(_ltI) && Number.isFinite(_newPaxI) && _newPaxI > 0 && _newPaxI !== _prevPaxN
        && !/طفل|اطفال|أطفال|عيال|بالغ|كبار|صغار|ولد|بنت|سن[ةه]|عمر|رضيع/.test(_bodyNow)) {
      const _pw = (n: number) => n === 1 ? "شخص واحد" : n === 2 ? "شخصين" : `${n} أشخاص`;
      outMsgs = [_newPaxI === 1 ? `تمام، يعني شخص واحد بدل ${_prevPaxN}، صحيح؟` : `تمام، يعني ${_pw(_newPaxI)} بدل ${_prevPaxN}. كلهم بالغين ولا فيه أطفال بينهم؟`];
      await logGuard(supabase, from, "pax_corrected_reask_children", "rewrite", `${_prevPaxN} → ${_newPaxI}`, 1, _bodyNow, outMsgs[0]);
    }
  }
  // حماية صياغة: النموذج أحياناً يسأل العدد بصيغة ركيكة مثل «كم عدد الأشخاص اللي راح
  // تنومون في الفندق؟» — نستبدلها بصياغة طبيعية مهذّبة. (شكوى المالكة ١١ أكتوبر.)
  outMsgs = outMsgs.map(m => String(m)
    .replace(/كم\s*عدد\s*(?:الأشخاص|الاشخاص|المسافرين)\s*(?:اللي|الي)\s*(?:راح\s*|بـ?ت?)?تنوم\S*\s*(?:في\s*|ب)?(?:ال)?(?:فندق|فنادق)[^؟]*؟?/g, "كم عدد المسافرين معكم؟")
    .replace(/\s*(?:اللي|الي)\s*(?:راح\s*|بـ?ت?)?تنوم\S*\s*(?:في\s*|ب)?(?:ال)?(?:فندق|فنادق)/g, " معكم"));

  // للعمرة: نستخدم «المعتمرين» لا «المسافرين» عند سؤال العدد (طلب المالكة).
  if (_isUmrahPax) {
    outMsgs = outMsgs.map(m => String(m)
      .replace(/عدد\s*المسافرين/g, "عدد المعتمرين")
      .replace(/المسافرين\s*معكم/g, "المعتمرين معكم")
      .replace(/كم\s*عدد\s*المسافرين/g, "كم عدد المعتمرين"));
  }
  // ── نبني البيانات المدموجة ونفحص اكتمال الأساسيات **قبل الإرسال** — عشان
  //    نقرّر هل نستبدل رسالة الـLLM بملخّص تأكيد خادميّ (deterministic) ──
  const upd: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  let _mergedData = { ...(prev as Record<string, unknown>) };
  if (out.fields && typeof out.fields === "object") { _mergedData = { ..._mergedData, ...out.fields }; }
  if (_mergedData.nights) _mergedData.nights = _normNights(_mergedData.nights);
  // بمجرد ما نسأل عن الأطفال (سواء النموذج أو الحارس) نثبّت العلم فلا نكرّره.
  if (_ageGateFired || _outAsksAges || _adultsConfirmed) _mergedData.asked_children = true;
  if (_kidAgeGateFired) _mergedData.asked_ages_n = _askedAgesN + 1;
  if (_kidAgeFromBody && !/[0-9٠-٩]/.test(String(_mergedData.ages || ""))) _mergedData.ages = _kidAgeFromBody;
  // وكذلك سؤال ليالي العمرة — نثبّته فلا نكرّره.
  if (_nightsGateFired || _outAsksNights) _mergedData.asked_nights = true;
  // تأكيد عدد مسافري شهر العسل — نثبّته فلا نكرّره.
  if (_hmPaxGateFired || _outConfirmsPax) _mergedData.asked_hm_pax = true;
  // تنبيه تعارض المدة — نثبّته فلا نكرّره (نسأل مرة واحدة ثم نكمل بردّ العميل).
  if (_durGateFired) _mergedData.asked_duration_conflict = true;
  // حفظ قرار تغيير الوجهة: الجديدة (أو مسحها)، + مسح مدن الوجهة القديمة، + علم التغيير.
  if (_destChangeApply) {
    _mergedData.destination = _gm.destination;
    _mergedData.dest_changing = _gm.dest_changing;
    _mergedData.cities = _gm.cities;
    upd.destination = String(_gm.destination || "") || null;
  }
  // حفظ حالة تأكيد تبديل الوجهة: عند السؤال نخزّن المعلّقة ونُبقي القديمة؛ وعند الحسم نمسحها.
  if (_keepOldDest) _mergedData.destination = _gm.destination;
  // 📅 تغيير تاريخ السفر/العودة بالأرقام («خلي السفر تاريخ ١٢» / «العوده ١٧») — حتمي: نحدّث التاريخ، ولو ذكر العودة
  //    نعدّل ليالي آخر مدينة بحيث العودة = اليوم المطلوب (حادثة ٣ نوفمبر: الكرت القديم رجع رغم الطلب).
  // 🧾 طلبات العميل غير المنفّذة = كل رسائله بعد آخر برنامج انرسل (مو آخر رسالة بس) — حادثة ٣ نوفمبر:
  //    «خلي السفر ١٢ والعوده ١٧» ثم «وبعدين معاك» → الكرت طلع ١٢ بـ٣+٣ (العودة ١٨) لأن الفحص قرأ الأخيرة فقط.
  const _sinceProg: string[] = (() => {
    let k = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].who === "طلال" && /📄 برنامج PDF|برنامجك صار جاهز/.test(msgs[i].body)) { k = i; break; }
    const out = msgs.slice(k + 1).filter(m => m.who === "العميل").map(m => m.body);
    const cur = String(args.body || ""); if (cur && !out.includes(cur)) out.push(cur);
    return out;
  })();
  for (const _bodyRaw of _sinceProg) {
    const _b = String(_bodyRaw || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)));
    const _dep = _b.match(/(?:السفر|الذهاب|القدوم|الطلع[ةه]|نسافر|نطلع|الرحل[ةه]|نروح|نمشي|نطير|رحلتنا|سفرنا)\s*(?:من\s*مسقط\s*)?(?:يوم\s*|بتاريخ\s*|تاريخ\s*|ب\s*|ل\s*|(?:يكون|تكون|بتكون)\s*|إلى\s*|الى\s*){0,2}(\d{1,2})(?!\s*(?:ليل|ليال|يوم|أيام|ايام|شخص))/);
    const _ret = _b.match(/(?:العود[ةه]|الرجوع|الرجع[ةه]|نرجع|نعود|رجوعنا|عودتنا|ونرجع|ونعود)\s*(?:من\s*(?:مطار\s*)?\S+\s*)?(?:يوم\s*|بتاريخ\s*|تاريخ\s*|ب\s*|ل\s*|(?:يكون|تكون|بتكون|راح\s*تكون)\s*){0,2}(\d{1,2})(?!\s*(?:ليل|ليال|شخص))/)
      || _b.match(/(?:عود[ةه]|عوده)\s*(?:\S+\s*){0,1}?تاريخ\s*(\d{1,2})/);
    const _cur = String(_mergedData.date || "");
    let _y = 0, _mo = 0, _dd = 0, _mm: RegExpMatchArray | null;
    if ((_mm = _cur.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) { _y = +_mm[1]; _mo = +_mm[2]; _dd = +_mm[3]; }
    else if ((_mm = _cur.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { _dd = +_mm[1]; _mo = +_mm[2]; _y = +_mm[3]; }
    // العودة وحدها («العودة تكون ١٨») → السفر ثابت، ليالي آخر مدينة تتعدّل بحيث العودة = اليوم المطلوب.
    if (_y && !_dep && _ret && +_ret[1] > _dd) {
      const total = +_ret[1] - _dd;
      const parts = String(_mergedData.nights || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).split(/\s+(?=\d)/).map(x => x.trim()).filter(Boolean);
      const nums = parts.map(p => +((p.match(/^\d+/) || ["0"])[0]));
      const sumBefore = nums.slice(0, -1).reduce((a, b) => a + b, 0);
      if (parts.length && total - sumBefore >= 1) {
        parts[parts.length - 1] = parts[parts.length - 1].replace(/^\d+/, String(total - sumBefore));
        _mergedData.nights = parts.join(" "); _mergedData.summary_confirmed = false;
        await logGuard(supabase, from, "date_shift", "return_only", `${_mergedData.date} | ${_mergedData.nights}`, 1, String(args.body || ""), "");
      }
    }
    if (_y && _dep && +_dep[1] >= 1 && +_dep[1] <= 31) {
      const nd = +_dep[1];
      _mergedData.date = `${String(nd).padStart(2, "0")}/${String(_mo).padStart(2, "0")}/${_y}`;
      if (_ret && +_ret[1] > nd) {
        const total = +_ret[1] - nd;
        const parts = String(_mergedData.nights || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).split(/\s+(?=\d)/).map(x => x.trim()).filter(Boolean);
        const nums = parts.map(p => +((p.match(/^\d+/) || ["0"])[0]));
        const sumBefore = nums.slice(0, -1).reduce((a, b) => a + b, 0);
        if (parts.length && total - sumBefore >= 1) parts[parts.length - 1] = parts[parts.length - 1].replace(/^\d+/, String(total - sumBefore));
        if (parts.length) _mergedData.nights = parts.join(" ");
      }
      _mergedData.summary_confirmed = false;
      await logGuard(supabase, from, "date_shift", "applied", `${_mergedData.date} | ${_mergedData.nights}`, 1, String(args.body || ""), "");
    }
  }
  // ✈️ العمرة: العميل طلب العودة من مطار المدينة أثناء الاستقبال → نحفظه (يظهر بالكرت ويُمرَّر للبناء).
  if (_isUmrahDest(String(_mergedData.destination || "") + " " + String(_mergedData.nights || "")) && RE_RET_MED.test(String(args.body || "")) && !/(?:مش|مو|مب|ما|لا)\s*(?:من\s*)?(?:مطار\s*)?(?:ال)?مدين/.test(String(args.body || ""))) _mergedData.return_airport = "madinah";
  if (_destOverride) _mergedData.destination = _destOverride;
  // v464: مدن/ليالي فيها مكة أو المدينة → الوجهة عمرة إجبارياً (لا «عُمان» من مطار الإقلاع).
  if (_isUmrahDest(String(_mergedData.destination || "")) && !/عمر[ةه]/.test(String(_mergedData.destination || ""))) _mergedData.destination = "العمرة";   // v465: «مكة المدينة» → «العمرة»
  if (_isUmrahDest(String(_mergedData.cities || "") + " " + String(_mergedData.nights || "")) && !_isUmrahDest(String(_mergedData.destination || ""))) {
    _mergedData.destination = "العمرة";
    if (_destChangeConfirmFired && _isOmanDest(_pendingDestAsk + " " + _oldDest0)) { _destChangeConfirmFired = false; outMsgs = []; }
  }
  if (_destChangeConfirmFired) { _mergedData.asked_dest_change = true; _mergedData.pending_dest = _pendingDestAsk; _mergedData.destination = _oldDest0; }
  else if (_askedDestChange) { _mergedData.asked_dest_change = false; _mergedData.pending_dest = ""; }
  // تثبيت الوجهة لو عُرفت من صورة العرض ولم يملأها النموذج (تظهر بالداشبورد + تمنع سؤالها).
  if (!String(_mergedData.destination || "").trim() && _destLabel) _mergedData.destination = _destLabel;
  // تثبيت عدد المسافرين المُستخرَج خادميّاً من كلام العميل («شخصين» إلخ) إن لم يملأه النموذج.
  if (_paxFromCust && !(Number.isFinite(Number(_mergedData.pax)) && Number(_mergedData.pax) > 0)) _mergedData.pax = _paxFromCust;
  // حارس تغيير العدد الملتبس: لا نثبّت الرقم المخمَّن — نُبقي العدد المؤكّد سابقاً
  //   ونفتح سؤال التوضيح (نثبّت العلم مرّة واحدة فلا يتكرّر السؤال في الدور التالي).
  if (_paxChangeGateFired) {
    _mergedData.pax = _prevPaxN;
    _mergedData.awaiting_confirm = false;
    _mergedData.summary_confirmed = false;
  }
  _mergedData.asked_pax_confirm = _paxChangeGateFired;
  const _dateKnown = !!String(_mergedData.date || "").trim()
    || /\d{1,2}\s*[\/\-]\s*\d{1,2}|\d{1,2}\s*(?:يناير|فبراير|مارس|إبريل|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)|شهر\s*\d{1,2}|نهاي[ةه]\s*\d{1,2}|بداي[ةه]\s*\d{1,2}/.test(custTranscript);
  const _daysKnown = !!String(_mergedData.days || "").trim();
  const _essentialsMissing = !_destKnown || !_paxKnown || !_dateKnown
    || (_isUmrahPax ? !_nightsKnown : !_daysKnown);
  // الأساسيات كاملة ولا حارس يسأل شيئاً هذا الدور.
  const _essentialsComplete = !_essentialsMissing
    && !_ageGateFired && !_nightsGateFired && !_hmPaxGateFired && !_paxGateFired && !_destGateFired
    && !_durGateFired && !_destChangeGateFired && !_paxChangeGateFired && !_destChangeConfirmFired;

  // ── بوابة التأكيد الخادمية (deterministic، لا تعتمد على نص الـLLM) ──
  //    • أول اكتمال أو تصحيح → نستبدل رد الـLLM بملخّص تأكيد يطلب «نعم».
  //    • العميل كان منتظَراً منه تأكيد وردّ بإيجاب → نقفل ونبني العرض.
  //    هذا يمنع اعتماد الإقفال على «زميلنا بيجهز» التي يخترعها الـLLM. [[project_wa_auto_program_offer]]
  let _doAutoBuild = false;
  if (_essentialsComplete) {
    // ٤ نوفمبر ٢٠٢٦ (قرار المالكة): تأكيد واحد بس — موافقة العميل على تأكيد الكلام (pending_card) = بناء البرنامج مباشرة، بلا كرت.
    const _wasAwaiting = (prev as Record<string, unknown>).awaiting_confirm === true || (prev as Record<string, unknown>).pending_card === true;
    const _lastCust = String(args.body || "").trim()
      || (msgs.filter(m => m.who === "العميل").slice(-1)[0]?.body || "");
    // ٣ نوفمبر ٢٠٢٦: «تمام» ثم «ارسلي لي» → الكرت رجع لأن الفحص قرأ الأخيرة بس. أي رسالة من العميل بعد الكرت تعني الموافقة تكفي.
    const _afterCard: string[] = (() => { const o: string[] = _unseenCust.length ? _unseenCust.map(m => m.body) : []; if (!o.length) for (let i = msgs.length - 1; i >= 0 && msgs[i].who !== "طلال"; i--) if (msgs[i].who === "العميل") o.unshift(msgs[i].body); if (_lastCust && !o.includes(_lastCust)) o.push(_lastCust); return o; })();
    const _yesAny = _afterCard.some(b => isAffirmative(b) || /^\s*(?:ارسل|أرسل|ارسلي|أرسلي|ارسله|ارسلها|جهز|جهّز|جهزه|اعتمد|كمل|كمّل|يلا|خلاص)(?:\s*\S+){0,3}\s*$/.test(String(b || "")));
    const _noChange = !_afterCard.some(b => /\d|غيّ?ر|عدّ?ل|بدّ?ل|لا\s|مو\s|مش\s/.test(String(b || "").replace(/[٠-٩]/g, "1")));
    if (_wasAwaiting && (isYesish(_lastCust) || (_yesAny && _noChange) || (_noChange && _afterCard.some(isYesish)))) {
      _mergedData.summary_confirmed = true;
      _mergedData.awaiting_confirm = false;
      upd.intake_active = false;                 // العميل أكّد الملخّص
      // غير العمرة: لا نرسل رسالة «ثبّتنا طلبك» هنا — الخلفية ترسل **العرض وحده**
      //   (رسالة واحدة). العمرة: لا بناء تلقائي، فنرسل رسالة التسليم.
      _mergedData.pending_card = false;
      // رقم اختبار/تشغيل كامل: «تمام، أبشر، شوية والبرنامج عندك.» ثم الـPDF. غيره: الخلفية ترسل رسالة التسليم للموظف.
      outMsgs = (await isFullAiNumber(supabase, from)) ? ["تمام، أبشر، شوية والبرنامج عندك."] : [];
      // 🕋 قرار المالكة: عمرة والعميل حدّد «بجانب الحرم/الأبراج» → «حاضر، برسل لك العرض اللي عندنا…» (رسالتين) — والعرض بفنادق «موصى به».
      if (outMsgs.length && _isUmrahDest(String(_mergedData.destination || "") + " " + String(_mergedData.cities || ""))) {
        const _reqStartI = Date.parse(String(_mergedData.started_at || "")) || 0;
        const _reqCust = msgs.filter(m => m.who === "العميل" && (Date.parse(m.ts) || 0) >= _reqStartI).map(m => m.body).join(" ") + " " + String(args.body || "");
        if (HARAM_WISH_RE.test(_reqCust) && !_mergedData.haram_explained && !String(((_mergedData.hotel_prefs || {}) as Record<string, unknown>).haram || "")) { outMsgs = ["حاضر، برسل لك العرض اللي عندنا.", "وإذا لك تعليق أو تعديل أنا حاضر."]; _mergedData.haram_wish = true; }
      }
      _doAutoBuild = true;   // 🕋 العمرة أيضاً تُبنى تلقائياً (البيانات تدعمها — مكة/المدينة)
    } else {
      // أول اكتمال أو تصحيح → اعرض ملخّص التأكيد الخادمي واطلب «نعم».
      outMsgs = [buildIntakeSummary(_mergedData, _isUmrahPax)];
      // 🔴 الكرت لازم يطابق كلام العميل الأخير — وإلا نسأل (اعتذار أ) بدل ما نعيد البيانات القديمة.
      {
        const _cbTxt = _sinceProg.join("\n") || String(args.body || "");
        const _bad = _cardVsCustomer(_mergedData, _cbTxt);
        const _p0 = prev as Record<string, unknown>;
        const _frusNow = _FRUS_RE.test(String(args.body || ""));
        const _wasCarded = _p0.awaiting_confirm === true || _p0.summary_confirmed === true || _p0.pending_card === true;
        const _chg = _wasCarded ? _describeChange(_p0, _mergedData) : "";
        // 🔴 قاعدة المالكة الصارمة (٣ نوفمبر): ❌ ولا كرت بدون حوار قبله — أول مرة أو بعد تعديل.
        //    الكرت يطلع فقط: (أ) بعد ما العميل وافق على تأكيد الكلام (pending_card + «نعم»)، أو (ب) بعد رسالة اعتذار مستقلة.
        const _bodyNow2 = String(args.body || "").trim();
        const _waiting = /^[؟?]+$|^\s*(?:وين(?:كم|ك)?|متى|هلا\s*وين|ها|هاه|ايش\s*صار|وش\s*صار)\s*[؟?]*\s*$/.test(_bodyNow2);
        // ٤ نوفمبر: «صحيح» على تأكيد الكلام والنموذج أضاف «8 ليالي» محسوبة من «9 أيام» → انحسبت تغيير وأعاد السؤال.
        //    موافقة العميل على تأكيد الكلام = الكرت (التغيير لازم يجي من كلام العميل نفسه، مو من حقل حسبه النموذج).
        const _talkYes = _p0.pending_card === true && isYesish(_bodyNow2);
        // 👶 ٤ نوفمبر ٢٠٢٦: «الأطفال ٣ خبرتك» (ابن الـ١٢ عندهم طفل) → طلال أعاد نفس الكرت بلا شرح. القاعدة: ١١ وفوق بالغ.
        //    العميل يصرّ على عدد أطفال أكبر من القاعدة → اعتذار (ب) + شرح القاعدة بأدب + تأكيد (موافقته = البناء).
        const _kc = _bodyNow2.replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).match(/(?:ال)?(?:أطفال|اطفال|طفل|عيال|صغار)\s*(?:هم\s*|عددهم\s*)?(\d{1,2})|(\d{1,2})\s*(?:أطفال|اطفال|طفل|عيال)/);
        const _ageNs = (String(_mergedData.ages || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).match(/\d{1,2}/g) || []).map(Number);
        const _kidsRule = _ageNs.filter(a => a <= 10), _teenAd = _ageNs.filter(a => a >= 11 && a <= 17);
        const _claimK = _kc ? +(_kc[1] || _kc[2]) : 0;
        const _askRule = /(?:يعتبر|يعتر|يُعتبر|يحسب|يُحسب|محسوب)\s*(?:\S+\s*)?(?:بالغ|كبير)|(?:بالغ|كبير)\s*[؟?]/.test(_bodyNow2) && _ageNs.some(a => a >= 11 && a <= 17);
        if (!_bad && _askRule) {
          outMsgs = ["إيه نعم أستاذي، عندنا من عمر 11 سنة وفوق يُعتبر بالغ وله سرير خاص. أجهّز لك البرنامج كذا؟"];
          _mergedData.pending_card = true; _mergedData.awaiting_confirm = false;
          await logGuard(supabase, from, "age_rule_explained", "answer_q", "", 1, _bodyNow2, outMsgs[0]);
        } else if (!_bad && _claimK && _ageNs.length && _claimK > _kidsRule.length && _teenAd.length) {
          const _pax = Number(_mergedData.pax) || _ageNs.length;
          const _ad = _pax - _kidsRule.length;
          const _teenTxt = _teenAd.length === 1 ? `والطفل اللي عمره ${_teenAd[0]} سنة يُعتبر عندنا بالغ` : `والأطفال اللي أعمارهم ${_teenAd.join(" و")} يُعتبرون عندنا بالغين`;
          const _kidTxt = _kidsRule.length === 0 ? "بدون أطفال" : _kidsRule.length === 1 ? `وطفل واحد (${_kidsRule[0]})` : _kidsRule.length === 2 ? `وطفلين (${_kidsRule.join(" و")})` : `و${_kidsRule.length} أطفال (${_kidsRule.join(" و")})`;
          // صيغة المالكة: يذكّره باللي قاله هو («أنت خبرتني…») ويوضّح بأدب.
          outMsgs = [`أعتذر منك أستاذي، أنت خبرتني إن أعمار الأطفال ${_ageNs.join(" و")}، ${_teenTxt} (من 11 سنة وفوق) وله سرير خاص، للتوضيح بس. يعني عندكم ${_ad} بالغين ${_kidTxt}، صح؟`];
          _mergedData.pending_card = true; _mergedData.awaiting_confirm = false;
          await logGuard(supabase, from, "age_rule_explained", "apology_b", `claim=${_claimK} rule=${_kidsRule.length}`, 1, _bodyNow2, outMsgs[0]);
        } else if (!_bad && (_frusNow || _waiting)) {
          // متضايق/ينتظر → اعتذار برسالة مستقلة، وبعدها الكرت المرتّب.
          // اعتذار مستقل ثم تأكيد بالكلام (مو كرت) — الموافقة عليه = البناء.
          outMsgs = [_waiting && !_frusNow ? "أعتذر منك على التأخير، خليني أرتب الطلب مرة ثانية." : "أعتذر منك حالاً، خليني أرتب الطلب مرة ثانية.", _talkSummary(_mergedData)];
          _mergedData.pending_card = true;
        } else if (!_bad && _talkYes) {
          _mergedData.pending_card = false;   // وافق على تأكيد الكلام → الكرت
        } else if (!_bad && _p0.pending_card === true && !_chg && isNegative(_bodyNow2)) {
          outMsgs = ["تمام، وش التعديل اللي تبيه بالضبط؟"]; _mergedData.pending_card = false;
        } else if (!_bad && !_chg && _p0.awaiting_confirm === true) {
          // الكرت انعرض والعميل ردّ بشي غير واضح (مو موافقة ولا تعديل) → ❌ لا نعيد سؤال التأكيد؛ نسأل مرة بصيغة مباشرة.
          outMsgs = ["عفواً إذا سمحت، أجهّز لك البرنامج بهذي المعلومات؟"];
          _mergedData.pending_card = false;
        } else if (!_bad) {
          // أي حالة ثانية → تأكيد بالكلام أول (جملة طبيعية)، والكرت بعد «نعم».
          outMsgs = [_chg ? `تمام، يعني تقصد ${_chg}؟` : _talkSummary(_mergedData)];
          _mergedData.pending_card = true;
          await logGuard(supabase, from, "talk_before_card", "confirm_q", _chg || "first", 1, "", outMsgs[0]);
        }
        if (_bad) {
          outMsgs = [_clarifyMsg(_bad, _frusNow)];
          await logGuard(supabase, from, "card_contradicts_customer", "clarify", _bad, 1, buildIntakeSummary(_mergedData, _isUmrahPax).slice(0, 200), outMsgs[0]);
          _mergedData.awaiting_confirm = false;
        }
      }
      // ✈️ العودة من المدينة: قبل الكرت نتأكد إن فيه طيران المدينة ← مسقط بتاريخ العودة.
      if (_isUmrahPax && String(_mergedData.return_airport || "") === "madinah") {
        const _chk = await _medReturnFlightCheck(_mergedData);
        if (_chk && !_chk.ok) {
          outMsgs = [_noMedFlightMsg(_chk)];
          const _ma = { ret: _chk.date ? _chk.date.toISOString().slice(0, 10) : "", dates: (_chk.nearest || []).map(x => x.toISOString().slice(0, 10)) };
          _mergedData.med_alt = _ma;
          await logGuard(supabase, from, "no_medina_flight", "intake", _ma.ret, 1, "", outMsgs[0]);
        }
      }
      if (outMsgs.some(m => /المعلومات صحيحة/.test(String(m || "")))) _mergedData.awaiting_confirm = true;
      else _mergedData.awaiting_confirm = false;
    }
  }
  // معاينة قسرية: رد النموذج فشل الحُرّاس ٣ مرات ولا حارس حتميّ أنتج رسالة آمنة
  //   → لا نرسل رد النموذج للعميل؛ رسالة تطمين محايدة + علم للموظف (guard_preview).
  const _anyDeterministic = _destGateFired || _paxGateFired || _ageGateFired || _nightsGateFired
    || _hmPaxGateFired || _durGateFired || _destChangeGateFired || _paxChangeGateFired || _destChangeConfirmFired || _essentialsComplete;
  if (_guardForcePreview && !_anyDeterministic) {
    outMsgs = ["تمام، خليني أتأكد من تفاصيل طلبك وأرد عليك بأقرب وقت 🌟"];
    _mergedData.guard_preview = true;
  }
  if (myLatest) _mergedData.last_seen_in_ts = myLatest;   // آخر رسالة شافها طلال قبل ما يرد
  upd.intake_data = _mergedData;

  // شبكة أمان أخيرة: لا رسالة للعميل ولا بناء برنامج = صمت → سؤال حتميّ + تسجيل.
  if (!outMsgs.some(m => String(m || "").trim()) && !_doAutoBuild) {
    const _fb2 = _intakeFallback(_mergedData as Record<string, unknown>);
    outMsgs = [_fb2];
    await logGuard(supabase, from, "no_silence_fallback", "empty_reply", "الاستقبال انتهى بلا رسالة", 1, "", _fb2);
  }
  // ── الإرسال (بعد ما حسمنا المحتوى: إمّا رسالة الحارس/الـLLM، أو ملخّص التأكيد) ──
  // سياق حُرّاس التصحيح: آخر رسالة من طلال (تكرار الافتتاح) وآخر رسالة من العميل (سؤال «مين أنت؟» / السلام).
  let _lastTalalBody = String(((outboundRes.data || []) as Row[]).find(m => !!m.body)?.body || "");
  const _lastCustBody = String(args.body || "").trim() || (msgs.filter(m => m.who === "العميل").slice(-1)[0]?.body || "");
  // 🔁 ٤ نوفمبر ٢٠٢٦: رسالتين ورا بعض → ردّين مكرّرين (الاعتذار + الكرت مرتين). وصلت رسالة أحدث أثناء المعالجة → معالجها يرد.
  { const _nowLatest = await latestInboundTs(); if (myLatest && _nowLatest && new Date(_nowLatest).getTime() > new Date(myLatest).getTime()) return; }
  // 🧾 ٤ نوفمبر ٢٠٢٦: النموذج كتب كرت من عنده («خليني أتأكد… المعلومات صحيحة؟ وكم يوم؟») والمعلومات ناقصة —
  //    بلا حوار قبله، وسؤالين، وتقسيم أعمار غلط (١٢ = بالغ). ❌ كرت النموذج ما ينرسل أبداً؛ الكرت الوحيد = كرت الخادم
  //    (buildIntakeSummary) بعد التأكيد بالكلام. بداله: سؤال واحد عن أول معلومة ناقصة.
  {
    const _serverCard = buildIntakeSummary(_mergedData, _isUmrahPax);
    const _isModelCard = (m: string) => /خليني\s*أتأكد|المعلومات\s*صحيحة|أكّ?د\s*لي\s*ب/.test(m) && m.trim() !== _serverCard.trim() && !_essentialsComplete;
    if (outMsgs.some(m => _isModelCard(String(m || "")))) {
      const _fbq = _intakeFallback(_mergedData as Record<string, unknown>);
      await logGuard(supabase, from, "model_card_blocked", "ask_missing", "", 1, outMsgs.join(" | ").slice(0, 200), _fbq);
      outMsgs = [_fbq];
    }
  }
  // 🙏 ٤ نوفمبر ٢٠٢٦: العميل اشتكى («ليش ما تردون بسرعه وليش ردكم تعبان») وطلال عاد السؤال بـ«تمام» كأن ما صار شي.
  //    أي تضايق بأي مرحلة → الرد يبدأ باعتذار (لو ما بدأ فيه أصلاً)، وبلا «تمام» قبله.
  // النموذج اعتذر بنفسه بأي مكان («عذرا على التأخير») → ❌ لا اعتذار ثاني؛ نوحّد صيغته ونقدّمه أول الرسالة.
  if (_FRUS_RE.test(String(args.body || "")) && outMsgs.length && /عذرا|عذراً|معذر[ةه]|آسف|اسف|اعتذر|أعتذر/.test(String(outMsgs[0] || "")) && !/^\s*أعتذر/.test(String(outMsgs[0] || ""))) {
    const _m0 = String(outMsgs[0]);
    const _apol = _m0.match(/(?:عذرا|عذراً|معذر[ةه]|آسفين|آسف|اسف|أعتذر|اعتذر)[^،.!؟]*[،.!]?\s*/);
    if (_apol) outMsgs[0] = "أعتذر منك على التأخير، " + _m0.replace(_apol[0], "").replace(/^\s*(?:تمام|حاضر|أبشر)[،,]?\s*/, "").trim();
  }
  if (_FRUS_RE.test(String(args.body || "")) && outMsgs.length && !/عذرا|عذراً|معذر[ةه]|آسف|اسف|اعتذر|أعتذر/.test(String(outMsgs[0] || ""))) {
    const _first = String(outMsgs[0] || "").replace(/^\s*(?:تمام|حاضر|أبشر|ابشر)[،,]?\s*(?:🌟\s*)?/, "");
    outMsgs = /المعلومات صحيحة/.test(_first) ? ["أعتذر منك على التأخير، معك الحين.", ...outMsgs] : [`أعتذر منك على التأخير، معك الحين. ${_first}`, ...outMsgs.slice(1)];
  }
  // 🗣️ قرار المالكة (٤ نوفمبر ٢٠٢٦): «أبشر، عندنا برامج عمرة…» جملة أول تواصل بس — لو المحادثة فيها نقاش سابق (قالها قبل / طلب سابق)
  //    → «أكيد طبعاً، اتفضل.» بدلها.
  {
    const _openRe = /^\s*(?:أبشر|ابشر)،?\s*عندنا\s*برامج\s*[^.؟?!]*[.!]\s*/;
    const _talked = msgs.some(m => m.who === "طلال" && /عندنا\s*برامج/.test(m.body)) || (Array.isArray((prev as Record<string, unknown>).prev_requests) && ((prev as Record<string, unknown>).prev_requests as unknown[]).length > 0);
    if (outMsgs.length && _talked && _openRe.test(String(outMsgs[0]))) outMsgs[0] = String(outMsgs[0]).replace(_openRe, "أكيد طبعاً، اتفضل. ");
  }
  // 👀 رسالة فاتت طلال (وصلت وهو يكتب ردّه السابق) → ينبّه إنه شافها قبل ما يكمل.
  if (_missedCust.length && outMsgs.length) {
    const _q = _missedCust.map(m => m.body.trim()).filter(Boolean).slice(-1)[0] || "";
    if (_q) outMsgs = [`آه صحيح، الحين انتبهت إنك ذكرت «${_q.length > 60 ? _q.slice(0, 60) + "…" : _q}».`, ...outMsgs];
  }
  for (const raw of outMsgs.slice(0, 3)) {
    // تصحيح تلقائي (أستاذي/تشكيل/فصحى/صياغة ركيكة/ترحيب مكرر/سؤال الحال/تكرار الافتتاح) قبل تنظيف العبارات الممنوعة.
    const _af = guardAutofix(String(raw), { alreadyGreeted, lastCustomer: _lastCustBody, lastTalal: _lastTalalBody });
    const _apolA = /^أعتذر منك أستاذي|^إيه نعم أستاذي|^تمام، أبشر، شوية والبرنامج عندك\.$|^حاضر، برسل لك العرض اللي عندنا\.$|^وإذا لك تعليق أو تعديل أنا حاضر\.$/.test(String(raw));   // صيغ المالكة الحرفية — بلا تنظيف
    const msg = _apolA ? String(raw) : stripBannedPhrases(_af.text);
    if (!msg) continue; // لو الرسالة كانت كلها عبارات ممنوعة، تجاهلها
    if (_af.hits.length && !_apolA) await logGuard(supabase, from, "autofix:" + _af.hits.join("+"), "autofix", "", 1, String(raw), msg);
    if (_apolA) await sendWhatsapp(from, msg); else await sendCustomerReply(supabase, from, msg);
    // نسجّل كل رسالة من طلال (بعد التنظيف) لتظهر بالداشبورد مطابقة للمُرسَل.
    try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: msg, sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* best-effort */ }
    _lastTalalBody = msg;
  }

  // ── بناء العرض تلقائياً بالخلفية (بعد تأكيد العميل، غير العمرة) ──
  // ⚠️ إرسال البرنامج للعميل معلّق على **البند** (ai_mode): يُرسَل عند بند
  //    «معاينة مع رد» (PREVIEW_REPLY) أو لرقم في auto_program_test_numbers،
  //    **و** السعر جاهز (priceReady). في بند «معاينة» (أو ON) يُخزَّن مسوّدةً
  //    للموظف في intake_data.auto_program بلا إرسال، وتُرسَل رسالة تسليم فقط.
  if (_doAutoBuild) {
    // 🕋 العمرة: التوزيع مخزّن في حقل nights («٣ مكة ٢ المدينة»)، والأيام تُشتق من
    //    مجموع الليالي + ١. غير العمرة: التوزيع في cities والأيام كما هي.
    let _dist0 = _isUmrahPax ? String(_mergedData.nights || "").trim() : (String(_mergedData.distribution || "").trim() || String(_mergedData.cities || "").trim());
    // ٤ نوفمبر ٢٠٢٦: «بوكيت» (مدينة بلا ليالي) → «no buildable program» وما وصل العميل شي. مدينة وحدة بلا أرقام + أيام
    //    معروفة → «N ليالي المدينة» (N = الأيام − ١)؛ أكثر من مدينة بلا أرقام → نخلي المحرك يختار التوزيع.
    if (!_isUmrahPax && _dist0 && !/[0-9٠-٩]/.test(_dist0)) {
      const _cs = _dist0.split(/\s*(?:،|,|\s+و\s*|\s+ثم\s+)\s*/).map(x => x.trim()).filter(Boolean);
      const _dy = parseInt(String(_mergedData.days || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))), 10);
      _dist0 = (_cs.length === 1 && _dy > 1) ? `${_dy - 1} ليالي ${_cs[0]}` : "";
    }
    const _deferred = !_dist0 || /حسب|الوكال|بكيفك|براحتك|رتبو|ترتيب|أي\s*مدن/.test(_dist0);
    let _daysVal = String(_mergedData.days || "").trim();
    if (_isUmrahPax) {
      const _nn = (_dist0.match(/\d+/g) || []).reduce((s, x) => s + parseInt(x, 10), 0);
      if (_nn > 0) _daysVal = String(_nn + 1);
    }
    const _bg = (async () => {
      try {
        const prog = await autoBuildProgram({
          dest: String(_mergedData.destination || ""),
          days: _daysVal,
          date: String(_mergedData.date || ""),
          pax: String(_mergedData.pax || ""),
          ages: String(_mergedData.ages || ""),
          distribution: _deferred ? "" : _dist0,
          phone: from,
          return_airport: String(_mergedData.return_airport || ""),
          unique_hotel_per_visit: (_mergedData.hotel_prefs as { unique_visit?: boolean } | undefined)?.unique_visit === true,
          exclude_hotels: ((_mergedData.hotel_prefs as { exclude?: string[] } | undefined)?.exclude) || [],
          hotel_prefs: { ...(_isUmrahDest(String(_mergedData.destination || "") + " " + String(_mergedData.cities || "")) ? { haram: "موصى به" } : {}), ...((_mergedData.hotel_prefs as Record<string, unknown> | undefined) || {}) },
        });
        if (!prog) {
          // ❌ كان صامت: العميل وصله «شوية والبرنامج عندك» وما جاه شي. الحين: نبلغه بصدق + تنبيه الموظف + نمسح «جاري البناء».
          console.error("auto_build: no program for", from);
          const _fm = "أعتذر منك، البرنامج يحتاج ترتيب يدوي بسيط — زميلنا المختص بيجهّزه لك ويرسله قريب إن شاء الله.";
          await sendCustomerReply(supabase, from, _fm);
          try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(_fm), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
          await logGuard(supabase, from, "auto_build_failed", "handoff", `${_mergedData.destination} | ${_daysVal} أيام | ${_dist0}`, 1, "", _fm);
          try { const n = `⚠️ ما قدر طلال يبني البرنامج تلقائياً — جهّزوه يدوياً\nالعميل: ${from.replace(/^whatsapp:/, "")}\nالوجهة: ${_mergedData.destination} · ${_daysVal} أيام · ${_mergedData.pax} أشخاص · ${_mergedData.date}\nالمدن: ${_mergedData.cities || "-"}`; await Promise.all(staffList("SALES_WHATSAPP_NUMBERS").map(x => sendStaffNotice(x, n))); } catch (_e) { /* */ }
          try { await createProposalAndNotifyAdmin({ supabase, customerPhone: from, profileName: "", question: "طلب برنامج ما انبنى تلقائياً: " + String(_mergedData.destination || "") }); } catch (_e) { /* */ }
          return;
        }
        // خزّن المسوّدة دائماً (ليراها الموظف في الداشبورد) دون إرسال.
        try {
          const { data: sRow } = await supabase.from("whatsapp_sessions")
            .select("intake_data").eq("phone", from).maybeSingle();
          const idata = (sRow?.intake_data || {}) as Record<string, unknown>;
          idata.auto_program = prog.text;
          // 🔎 نسخة من الطلب اللي انبنى عليه البرنامج — الفحص الذاتي يقارن بها (مو بالبيانات الحالية اللي ممكن تتغيّر بطلب جديد).
          idata.program_spec = { destination: _mergedData.destination, pax: _mergedData.pax, ages: _mergedData.ages, date: _mergedData.date, nights: _mergedData.nights, days: _mergedData.days, return_airport: _mergedData.return_airport || "" };
          idata.auto_program_ready = prog.priceReady;
          idata.auto_program_at = new Date().toISOString();
          await supabase.from("whatsapp_sessions").update({ intake_data: idata }).eq("phone", from);
        } catch (e) { console.error("auto_build draft save", (e as Error).message); }
        // بوابة الإرسال معلّقة على **البند** (ai_mode):
        //   • «معاينة مع رد» (PREVIEW_REPLY) → يُرسَل البرنامج لكل عميل جديد.
        //   • «معاينة» (PREVIEW) → لا يُرسَل؛ فقط رسالة التسليم للموظف. (رقم
        //     الاختبار يستقبله رغم ذلك لتعاينه المالكة قبل الاعتماد.)
        // + شرط السعر جاهز (priceReady) في الحالتين.
        const _rawMode = await getRawAiMode(supabase);
        const _replyMode = _rawMode === "PREVIEW_REPLY";   // «معاينة مع رد»
        const { data: settingRows } = await supabase.from("wa_settings")
          .select("key,value").in("key", ["auto_program_test_numbers"]);
        const _getSetting = (k: string) => String(((settingRows || []).find((r: Record<string, unknown>) => r.key === k)?.value) ?? "").replace(/["[\]]/g, "");
        const _fromDigits = from.replace(/[^0-9]/g, "");
        const _isTestNum = _getSetting("auto_program_test_numbers").split(/[,\s]+/)
          .map(n => n.replace(/[^0-9]/g, "")).some(d => d.length >= 6 && _fromDigits.endsWith(d));
        if ((_replyMode || _isTestNum) && prog.priceReady) {
          // 📄 «معاينة مع رد» → نُدرِج مهمة PDF: عامل المتصفح الخفي (على جهاز البوت)
          //    يطلّع الـPDF من team.html بحساب «مولّد البرامج» ويرسله للعميل. لو
          //    ما فيه كود (فشل الحفظ) → fallback: نرسل العرض المنسّق نصّاً.
          if (prog.programCode) {
            // رسائل ما بعد البرنامج تُرسَل بعد وصول الـPDF (pdf_job_send) — نخزّنها على الجلسة.
            try {
              const { data: _s } = await supabase.from("whatsapp_sessions").select("intake_data").eq("phone", from).maybeSingle();
              const _d = ((_s as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
              const _pm0 = postProgramMessages(prog.kidAges);
              const _hp0 = (_mergedData.hotel_prefs || {}) as Record<string, unknown>;
              if ((prog.prefMisses || []).length && (_hp0.name || _hp0.breakfast || _hp0.feature || _hp0.sea_view)) {
                const _what = _hp0.name ? `فندق ${_hp0.name}` : _hp0.breakfast ? "فندق فيه إفطار" : _hp0.sea_view ? "غرفة بإطلالة بحر" : (_hp0.feature === "villa" ? "فيلا" : _hp0.feature === "pool" ? "غرفة بمسبح خاص" : "جناح");
                const _cs = [...new Set((prog.prefMisses || []).map(c => CITY_AR[c] || c))].join(" و");
                // قرار المالكة (٤ نوفمبر): ❌ لا نقول للعميل «غير متوفر» — قسم الحجوزات يراجع عند التأكيد ويبلغه الموظف. ملاحظة داخلية فقط.
                try { const _n = `ℹ️ ${from.replace(/^whatsapp:/, "")} طلب ${_what} في ${_cs} وما لقيناه بالبيانات — البرنامج ${prog.programCode} انبنى بأقرب خيار. راجعوه عند الحجز.`; await Promise.all(staffList("SALES_WHATSAPP_NUMBERS").map(x => sendStaffNotice(x, _n))); } catch (_e) { /* */ }
                await logGuard(supabase, from, "hotel_pref_unmet", "staff_note", `${_what} | ${_cs}`, 1, String(prog.programCode || ""), "");
              }
              await supabase.from("whatsapp_sessions").update({ intake_data: { ..._d, post_program_msgs: _pm0 } }).eq("phone", from);
            } catch (_e) { /* */ }
            await supabase.from("program_pdf_jobs").insert({ phone: from, code: prog.programCode });
            console.log("auto_build: ENQUEUED PDF job for", from, prog.programCode);
          } else {
            await sendCustomerReply(supabase, from, prog.text, undefined, { keepRich: true });
            await sendPostProgramMessages(supabase, from, postProgramMessages(prog.kidAges));
            console.log("auto_build: SENT text (no code) to", from);
          }
        } else {
          // بند «معاينة» (أو السعر غير جاهز) → رسالة تسليم واحدة للعميل،
          //   والمسوّدة محفوظة للموظف ليبني العرض ويرسله بنفسه.
          await sendCustomerReply(supabase, from, "تمام، معلوماتك وصلت، زميلنا المختص بيجهّز لك البرنامج ويتواصل معك قريباً.");
          console.log("auto_build: not sent (mode=" + _rawMode + ", test=" + _isTestNum + ", priceReady=" + prog.priceReady + ", note=" + prog.priceNote + ") for", from);
        }
      } catch (e) { console.error("auto_build bg", (e as Error).message); }
    })();
    // @ts-ignore EdgeRuntime injected by Supabase
    if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
      // @ts-ignore
      EdgeRuntime.waitUntil(_bg);
    }
  }
  await supabase.from("whatsapp_sessions").update(upd).eq("phone", from);
}

// 🧪 تشغيل كامل لرقم المالكة (طلب ٣ نوفمبر ٢٠٢٦): أرقام auto_program_test_numbers يرد عليها
//    طلال بالذكاء **بعد إقفال الطلب** أيضاً (بدل تحويل كل رسالة للموظفة)، ملتزماً بكل المعلومات
//    المخزّنة (intake_data + البرنامج المرسل). باقي العملاء على «معاينة» كما هم.
// 💱 عملة العميل من رقمه (نفس جدول currencies اللي يستخدمه Tourism-AI و team.html).
async function _currencyForPhone(supabase: ReturnType<typeof createClient>, from: string): Promise<{ name: string; rate: number } | null> {
  const d = from.replace(/[^0-9]/g, "");
  const code = ([["968", "OMR"], ["971", "AED"], ["965", "KWD"], ["974", "QAR"], ["973", "BHD"], ["20", "EGP"]] as Array<[string, string]>).find(([p]) => d.startsWith(p))?.[1];
  if (!code) return null;
  try {
    const { data } = await supabase.from("currencies").select("code,name_ar,rate");
    const want = code === "AED" ? ["UAE", "AED"] : [code];
    const row = ((data || []) as Array<Record<string, unknown>>).find(c => want.includes(String(c.code)));
    const rate = row ? parseFloat(String(row.rate)) : 0;
    return row && rate > 0 ? { name: String(row.name_ar || code), rate } : null;
  } catch (_e) { return null; }
}

// ✈️ هل فيه طيران المدينة ← مسقط بتاريخ العودة؟ (قرار المالكة ٣ نوفمبر: يتأكد طلال قبل ما يبني العودة من المدينة)
//    العودة = تاريخ السفر + مجموع الليالي. المصدر: Tourism-AI makkah_flights (بلوك Madinah–Muscat من الشيت).
// 🔢 ٣ نوفمبر ٢٠٢٦: النموذج كتب الليالي «5 ليالٍ (3 مكة + 2 المدينة)» → جمع كل الأرقام = ١٠ → العودة ٢٢ بدل ١٧.
//    نوحّد أي صيغة إلى «3 مكة 2 المدينة» (أزواج رقم+مدينة)؛ بدون مدن نبقيها كما هي.
function _normNights(v: unknown): string {
  const t = String(v ?? "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)));
  const re = /(\d{1,2})\s*(?:ليال[ٍيه]?|ليلة|ليالي|ليل)?\s*(?:في\s*|ب\s*)?(مك[ةه](?:\s*المكرم[ةه])?|(?:ال)?مدين[ةه](?:\s*المنور[ةه])?|(?:ال)?طائف)/g;
  const pairs: string[] = [];
  for (const m of t.matchAll(re)) { const city = /مك/.test(m[2]) ? "مكة" : (/مدين/.test(m[2]) ? "المدينة" : "الطائف"); pairs.push(`${+m[1]} ${city}`); }
  return pairs.length ? pairs.join(" ") : String(v ?? "").trim();
}
function _tripReturnDate(d: Record<string, unknown>): Date | null {
  const raw = String(d.date || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).trim();
  let y = 0, m = 0, day = 0, mm;
  if ((mm = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mm[1]; m = +mm[2]; day = +mm[3]; }
  else if ((mm = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { day = +mm[1]; m = +mm[2]; y = +mm[3]; }
  else return null;
  const _nn = _normNights(d.nights);
  const _pairs = _nn.match(/\d{1,2}(?=\s*(?:مكة|المدينة|الطائف))/g);
  let nights = (_pairs || (_nn.replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).match(/\d{1,2}/) || [])).map(Number).reduce((a, b) => a + b, 0);
  // غير العمرة: المدة بالأيام (٦ أيام = ٥ ليالي) — العودة = تاريخ السفر + (الأيام − ١).
  if (!nights) { const dys = parseInt(String(d.days ?? "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))), 10); if (dys > 1) nights = dys - 1; }
  if (!nights) return null;
  return new Date(Date.UTC(y, m - 1, day + nights));
}
const _AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const _arDate = (dt: Date) => `${dt.getUTCDate()} ${_AR_MONTHS[dt.getUTCMonth()]}`;
async function _medReturnFlightCheck(d: Record<string, unknown>): Promise<{ ok: boolean; date?: Date; nearest?: Date[] } | null> {
  const ret = _tripReturnDate(d);
  if (!ret) return null;
  try {
    const jwt = Deno.env.get("LEGACY_ANON_JWT") || "";
    const res = await fetch(TOURISM_AI_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: jwt }, body: JSON.stringify({ action: "makkah_flights" }) });
    const data = await res.json();
    const table = (((data || {}).prices || {}).oman || {}).ret_med || {};
    const keys = Object.keys(table);
    if (!keys.length) return null;   // ما نقدر نقرأ الأسعار → لا نمنع (الـPDF يرجع لجدة مع تنبيه للموظفة)
    const k = (dt: Date) => `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}`;
    if (table[k(ret)]) return { ok: true, date: ret };
    const toD = (s: string) => { const [dd, mo, yy] = s.split("/").map(Number); return new Date(Date.UTC(yy, mo - 1, dd)); };
    const nearest = keys.map(toD).filter(x => Math.abs(x.getTime() - ret.getTime()) <= 7 * 864e5)
      .sort((a, b) => Math.abs(a.getTime() - ret.getTime()) - Math.abs(b.getTime() - ret.getTime())).slice(0, 2)
      .sort((a, b) => a.getTime() - b.getTime());
    return { ok: false, date: ret, nearest };
  } catch (_e) { return null; }
}
function _noMedFlightMsg(c: { date?: Date; nearest?: Date[] }): string {
  const base = `أعتذر منك، ما فيه طيران من المدينة إلى مسقط بتاريخ ${c.date ? _arDate(c.date) : "العودة"}.`;
  const n = (c.nearest || []).map(_arDate);
  return n.length ? `${base} أقرب رحلة متوفرة ${n.join(" أو ")}، تحب نعدّل تاريخ العودة؟ ولا نخلي العودة من جدة؟` : `${base} تحب نخلي العودة من جدة؟`;
}

// 🔎 قرار المالكة (٣ نوفمبر ٢٠٢٦): طلال يكتشف غلطه بنفسه — كل برنامج ينرسل يُفحص مقابل الطلب المؤكد،
//    ولو فيه خطأ يعتذر للعميل ويعيد الإرسال مصحّحاً (مرة وحدة) وينبّه الموظفين. العميل ما يحتاج يكتشفه.
function _programIssues(raw: string, d0: Record<string, unknown>, phone: string): string[] {
  const issues: string[] = [];
  // بلا نسخة من الطلب وقت البناء (برامج قديمة) → ❌ لا نقارن بالبيانات الحالية (ممكن طلب ثاني) — نفحص العملة بس.
  const _hasSpec = !!(d0 && typeof d0.program_spec === "object" && d0.program_spec);
  const d = _hasSpec ? d0.program_spec as Record<string, unknown> : ({} as Record<string, unknown>);
  const t = String(raw || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)));
  const pax = Number(d.pax) || 0;   // pax = الإجمالي (طلال يسأل «الإجمالي، الكبار والأطفال»)
  const fl = (t.split("FLIGHTS:")[1] || "").split(/\n\s*\n/)[0] || "";
  for (const line of fl.split("\n")) { const m = line.match(/\|\s*(\d+)\s*(?:أشخاص|اشخاص|شخص)\s*\|/); if (m && pax && +m[1] < pax) { issues.push("الطيران ما انحسب لكل المسافرين"); break; } }
  if (String(d.return_airport || "") === "madinah" && /جد[ةه]\s*←\s*مسقط/.test(fl) && !/المدين[ةه]\s*←\s*مسقط/.test(fl)) issues.push("العودة طلعت من جدة بدل المدينة");
  const digits = phone.replace(/[^0-9]/g, "");
  if (/^(968|971|965|974|973|20)/.test(digits) && !/(?:^|\n)CURRENCY:/.test(t)) issues.push("السعر طلع بالريال السعودي بدل عملتك");
  const df = (t.match(/DATE_FROM:\s*(\d{1,2})/) || [])[1];
  const cd = String(d.date || ""); const cm = cd.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || cd.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const cday = cm ? (cm[1].length === 4 ? +cm[3] : +cm[1]) : 0;
  if (df && cday && +df !== cday) issues.push("تاريخ السفر في البرنامج غير اللي اتفقنا عليه");
  return issues;
}
async function _selfCorrectProgram(supabase: ReturnType<typeof createClient>, phone: string, code: string, raw: string, d: Record<string, unknown>, alreadyCorrected: boolean): Promise<string[]> {
  const issues = _programIssues(raw, d, phone);
  if (!issues.length) return [];
  await logGuard(supabase, phone, "program_self_check", alreadyCorrected ? "still_wrong" : "issues", issues.join(" | "), 1, code, "");
  if (alreadyCorrected) {
    // التصحيح ما نفع (السبب أعمق) → ما نكرّر على العميل؛ تنبيه الموظفين فقط.
    try { const n = `⚠️ برنامج ${code} للعميل ${phone.replace(/^whatsapp:/, "")} لسا فيه خطأ بعد التصحيح التلقائي: ${issues.join("، ")}`; await Promise.all(staffList("SALES_WHATSAPP_NUMBERS").map(x => sendStaffNotice(x, n))); } catch (_e) { /* */ }
    return issues;
  }
  const msg = `أعتذر منك، لاحظت إن البرنامج اللي أرسلته لك فيه خطأ (${issues.join("، ")}). لو سمحت انتظرني شوي، بعدّله وأرسله لك.`;
  const sid = await sendWhatsapp(phone, msg);
  try { await supabase.from("wa_admin_messages").insert({ twilio_sid: sid, customer_phone: phone, body: msg, sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
  await supabase.from("program_pdf_jobs").insert({ phone, code, caption: "برنامجك بعد التصحيح 🌟" });
  try { const n = `🔎 طلال اكتشف خطأ في برنامج ${code} (${phone.replace(/^whatsapp:/, "")}): ${issues.join("، ")} — اعتذر للعميل وأعاد الإرسال تلقائياً.`; await Promise.all(staffList("SALES_WHATSAPP_NUMBERS").map(x => sendStaffNotice(x, n))); } catch (_e) { /* */ }
  return issues;
}

async function isFullAiNumber(supabase: ReturnType<typeof createClient>, from: string): Promise<boolean> {
  try {
    const { data } = await supabase.from("wa_settings").select("value").eq("key", "auto_program_test_numbers").maybeSingle();
    const v = String((data as { value?: unknown } | null)?.value ?? "").replace(/["[\]]/g, "");
    const d = from.replace(/[^0-9]/g, "");
    return v.split(/[,\s]+/).map(n => n.replace(/[^0-9]/g, "")).some(n => n.length >= 6 && d.endsWith(n));
  } catch (_e) { return false; }
}

async function handleFollowupAI(args: { supabase: ReturnType<typeof createClient>; from: string; profileName: string; body: string }): Promise<void> {
  const { supabase, from, profileName } = args;
  const text = String(args.body || "").trim();
  const [inRes, outRes, sRes] = await Promise.all([
    supabase.from("wa_message_audit").select("body, received_at").eq("from_phone", from).not("body", "is", null).order("received_at", { ascending: false }).limit(20),
    supabase.from("wa_admin_messages").select("body, sent_at").eq("customer_phone", from).order("sent_at", { ascending: false }).limit(20),
    supabase.from("whatsapp_sessions").select("intake_data, destination").eq("phone", from).maybeSingle(),
  ]);
  type R = { body?: string | null; received_at?: string; sent_at?: string };
  const msgs: Array<{ ts: string; who: string; body: string }> = [];
  for (const m of ((inRes.data || []) as R[])) if (m.body && !String(m.body).startsWith("📎")) msgs.push({ ts: m.received_at || "", who: "العميل", body: String(m.body) });
  for (const m of ((outRes.data || []) as R[])) if (m.body) msgs.push({ ts: m.sent_at || "", who: "طلال", body: String(m.body) });
  msgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  { let c = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].who === "طلال" && msgs[i].body.startsWith("🔄 أُعيد ضبط المحادثة")) { c = i; break; }
    if (c >= 0) msgs.splice(0, c + 1); }
  const idata = (((sRes.data as { intake_data?: Record<string, unknown> } | null)?.intake_data) || {}) as Record<string, unknown>;
  if (idata.nights) idata.nights = _normNights(idata.nights);
  // ٥ نوفمبر ٢٠٢٦ (قرار المالكة): المتابعة تقرأ **الطلب الحالي فقط** (من started_at) — زي الاستقبال. كان المصنّف يشوف رسائل
  //    طلبات سابقة ويقول «العميل يكرر للمرة الرابعة» على أول رسالة بالطلب الجديد.
  { const _stF = Date.parse(String(idata.started_at || ""));
    if (Number.isFinite(_stF)) { const _keepF = msgs.filter(m => (Date.parse(m.ts) || 0) >= _stF); msgs.length = 0; msgs.push(..._keepF); } }
  const facts: Record<string, unknown> = {};
  for (const k of ["destination", "pax", "ages", "date", "nights", "days", "cities"]) {
    const v = idata[k]; if (v !== undefined && v !== null && String(v).trim() !== "") facts[k] = v;
  }
  // ٣ نوفمبر ٢٠٢٦: طلال اخترع «وصول وانصراف من مطار المدينة» — المطارات حقيقة مخزّنة، مو تخمين.
  const _retMed = String(idata.return_airport || "") === "madinah";
  // ٤ نوفمبر ٢٠٢٦: «الطيران الدولي (جدة بوكيت)» — كانت تنضاف «مطار جدة» لكل الوجهات. المطارات حقيقة **للعمرة فقط**.
  if (_isUmrahDest(String(facts.destination || "") + " " + String(facts.cities || ""))) facts.airports = _retMed ? "الذهاب إلى مطار جدة، والعودة من مطار المدينة" : "الذهاب والعودة من مطار جدة";
  // 🔁 دمج الرسائل المتلاحقة: لو وصلت رسالة أحدث أثناء المعالجة، معالجها يرد على الكل (حادثة ٣ نوفمبر: ردّين متناقضين).
  const _latestIn = async () => { const { data } = await supabase.from("wa_message_audit").select("received_at").eq("from_phone", from).order("received_at", { ascending: false }).limit(1).maybeSingle(); return String((data as { received_at?: string } | null)?.received_at || ""); };
  const _myLatest = await _latestIn();
  const _lastSeenF = Date.parse(String(idata.last_seen_in_ts || "")) || 0;
  const _lastTalalF = Math.max(0, ...msgs.filter(m => m.who === "طلال").map(m => Date.parse(m.ts) || 0));
  const _unseenF = _lastSeenF ? msgs.filter(m => m.who === "العميل" && (Date.parse(m.ts) || 0) > _lastSeenF) : [];
  const _missedF = _unseenF.filter(m => (Date.parse(m.ts) || 0) < _lastTalalF);
  let _ackDone = false;
  const _superseded = async () => { const now = await _latestIn(); return !!now && !!_myLatest && now > _myLatest; };
  const _say = async (reply: string, guard: string, action: string, reason = "", raw = false) => {
    if (await _superseded()) return false;
    if (_missedF.length && !_ackDone) {
      _ackDone = true;
      const _q = _missedF.map(m => m.body.trim()).filter(Boolean).slice(-1)[0] || "";
      if (_q) { const _ack = `آه صحيح، الحين انتبهت إنك ذكرت «${_q.length > 60 ? _q.slice(0, 60) + "…" : _q}».`; await sendCustomerReply(supabase, from, _ack); try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: _ack, sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ } }
    }
    if (raw) await sendWhatsapp(from, reply); else await sendCustomerReply(supabase, from, reply);
    // ٥ نوفمبر ٢٠٢٦: نحدّث idata أيضاً — أي حفظ لاحق بـ`{ ...idata, … }` (مثل haram_explained) كان يمسح last_seen_in_ts بقيمة قديمة
    //    → الرسالة اللي انرد عليها تنحسب «فاتته» ويبدأ الرد التالي «آه صحيح، الحين انتبهت إنك ذكرت…».
    if (_myLatest) idata.last_seen_in_ts = _myLatest;
    try { if (_myLatest) { const { data: _ss } = await supabase.from("whatsapp_sessions").select("intake_data").eq("phone", from).maybeSingle(); const _dd = ((_ss as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>; await supabase.from("whatsapp_sessions").update({ intake_data: { ..._dd, last_seen_in_ts: _myLatest } }).eq("phone", from); } } catch (_e) { /* */ }
    try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: raw ? reply : stripBannedPhrases(reply), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
    await logGuard(supabase, from, guard, action, reason, 1, text, reply);
    return true;
  };
  const _isUmrahReq = _isUmrahDest(String(facts.destination || "") + " " + String(facts.cities || ""));
  // ✈️ قبل أي تعديل للعودة من المدينة: نتأكد إن فيه طيران المدينة ← مسقط بتاريخ العودة.
  const _medGate = async (changed: Record<string, unknown>): Promise<boolean> => {
    if (changed.return_airport !== "madinah") return true;
    const chk = await _medReturnFlightCheck({ ...idata, ...changed });
    if (!chk || chk.ok) return true;
    // نحفظ البدائل المعروضة — ردّ العميل بتاريخ منها = تعديل الليالي + العودة من المدينة.
    const _alt = { ret: chk.date ? chk.date.toISOString().slice(0, 10) : "", dates: (chk.nearest || []).map(x => x.toISOString().slice(0, 10)), base: { ...changed } };
    idata.med_alt = _alt;
    await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, med_alt: _alt } }).eq("phone", from);
    await _say(_noMedFlightMsg(chk), "followup_ai", "no_medina_flight", _alt.ret);
    return false;
  };
  // 🧩 ٣ نوفمبر ٢٠٢٦: الرسائل تُدمَج (يرد طلال مرة وحدة على آخرها) — فالكشف الحتمي لازم يقرأ **كل** رسائل
  //    العميل بعد آخر رد لطلال، مو الأخيرة بس («احتاج العوده من مطار المدينه / افهم / كم مره أخبرك» ضاع الطلب).
  const _batch = (() => { const out: string[] = _unseenF.length ? _unseenF.map(m => m.body) : []; if (!out.length) { let k = msgs.length - 1; for (; k >= 0 && msgs[k].who !== "طلال"; k--) if (msgs[k].who === "العميل") out.unshift(msgs[k].body); } const j = out.join("\n"); return j.includes(text) ? j : (j ? j + "\n" + text : text); })();
  // 🧠 نية الرسالة من Sonnet أولاً (null = فشل → كاشفات الكلمات).
  const _lastTalalBody = msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "";
  // 💰 قرار المالكة: الكلام الواضح جداً (شكر/سلام/إيموجي فقط) ما يحتاج Sonnet — النموذج للأمور المبهمة بس.
  //    ❌ «ايوه/تمام/لا» مو منها: معناها يتغيّر حسب سؤال طلال.
  const _plainCourtesy = /^(?:\s*(?:شكرا|شكراً|شكرًا|مشكور|مشكورين|تسلم|تسلمون|تسلمين|يعطيك\s*العافي[ةه]|الله\s*يعطيك\s*العافي[ةه]|جزاك\s*الله\s*خير|الله\s*يجزاك\s*خير|ما\s*قصرت|ماقصرت|السلام\s*عليكم(?:\s*ورحم[ةه]\s*الله(?:\s*وبركاته)?)?|وعليكم\s*السلام(?:\s*ورحم[ةه]\s*الله(?:\s*وبركاته)?)?|هلا|مرحبا|صباح\s*الخير|مساء\s*الخير|thanks?|thank\s*you|[👍🙏❤️🌹😊🤍💐✨]+)\s*[.!،,]*)+\s*$/i.test(_batch.replace(/[\u064B-\u0652\uFE0F]/g, ""));
  const _cls = _plainCourtesy ? null : await _classifyFollowupIntent(msgs.slice(-14).map(m => `${m.who}: ${m.body}`).join("\n"), _lastTalalBody, _batch);
  if (_cls) await logGuard(supabase, from, "intent", _cls.intent, `${_cls.yes_no}${_cls.frustrated ? " frustrated" : ""} · ${_cls.meaning}`.slice(0, 300), 1, text, "");
  const _Y = (t = text) => _cls ? _cls.yes_no === "yes" : isAffirmative(t);
  const _YY = (t = text) => _cls ? _cls.yes_no === "yes" : isYesish(t);
  const _N = (t = text) => _cls ? _cls.yes_no === "no" : isNegative(t);
  const _is = (...k: string[]) => !!_cls && k.includes(_cls.intent);
  // ✋ تعديل معلّق ينتظر «نعم» (قرار المالكة: نقاش وتأكيد طبيعي أولاً، ثم الكرت النهائي).
  const _pend = (idata.pending_modify && typeof idata.pending_modify === "object") ? idata.pending_modify as Record<string, unknown> : null;
  const _applyModify = async (changed: Record<string, unknown>, prefix = "") => {
    const nd: Record<string, unknown> = { ...idata, ...changed, awaiting_confirm: true, summary_confirmed: false };
    if ("ages" in changed) nd.asked_children = true;
    delete nd.auto_program; delete nd.post_program_msgs; delete nd.pending_modify; delete nd.program_final_raw; delete nd.program_final_code;
    nd.program_modified = true;   // ٥ نوفمبر ٢٠٢٦: البرنامج الجاي معدّل → رسالة الختام «هذا البرنامج المعدّل…» (مو «برنامجك صار جاهز»)
    await supabase.from("whatsapp_sessions").update({ intake_active: true, intake_data: nd, stage: "new" }).eq("phone", from);
    const _bad = _cardVsCustomer(nd, _batch);
    if (_bad) { await supabase.from("whatsapp_sessions").update({ intake_active: false, intake_data: { ...idata } }).eq("phone", from); await _say(_clarifyMsg(_bad), "card_contradicts_customer", "clarify", _bad, true); return; }
    const card = buildIntakeSummary(nd, _isUmrahDest(String(nd.destination || "") + " " + String(nd.cities || "")));
    if (prefix) await _say(prefix, "followup_ai", "pre_card_talk", JSON.stringify(changed).slice(0, 200));
    // قرار المالكة: العميل أكّد التعديل بالكلام → ❌ لا كرت؛ بناء وإرسال مباشرة («تمام، أبشر، شوية والبرنامج عندك.» من مسار البناء).
    void card;
    await supabase.from("whatsapp_sessions").update({ intake_data: { ...nd, awaiting_confirm: true } }).eq("phone", from);
    await logGuard(supabase, from, "followup_ai", "modify_confirmed_build", JSON.stringify(changed).slice(0, 200), 1, text, "");
    await handleNewLeadIntake({ supabase, from, body: "نعم" });
  };
  // (ج) طلال غلط (أرسل برنامج غير اللي طلبه العميل) → اعتذار + إعادة البناء والإرسال فوراً، بلا كرت (قرار المالكة ٣ نوفمبر).
  const _rebuildNow = async (changed: Record<string, unknown>, apologyMsg = "حاضر، أعتذر منك. بعدّل البرنامج فوراً وأرسله لك.") => {
    if (await _superseded()) return;
    if (!(await _medGate(changed))) return;
    const nd: Record<string, unknown> = { ...idata, ...changed, awaiting_confirm: true, summary_confirmed: false };
    delete nd.auto_program; delete nd.post_program_msgs; delete nd.pending_modify; delete nd.program_final_raw; delete nd.program_final_code;
    nd.program_modified = true;   // ٥ نوفمبر ٢٠٢٦: البرنامج الجاي معدّل → رسالة الختام «هذا البرنامج المعدّل…» (مو «برنامجك صار جاهز»)
    await supabase.from("whatsapp_sessions").update({ intake_active: true, intake_data: nd, stage: "new" }).eq("phone", from);
    if (apologyMsg) await _say(apologyMsg, "followup_ai", "rebuild_apology", JSON.stringify(changed).slice(0, 200));
    await handleNewLeadIntake({ supabase, from, body: "نعم" });   // نفس مسار «نعم» على الكرت → بناء + PDF
  };
  const _clearPend = async () => { const nd = { ...idata }; delete nd.pending_modify; await supabase.from("whatsapp_sessions").update({ intake_data: nd }).eq("phone", from); delete idata.pending_modify; };
  // 🕋 ٥ نوفمبر ٢٠٢٦ (قرار المالكة): ردّ العميل على «وحتى فندق المدينة أغيّره لك بجانب الحرم؟»
  //    إيه → الفندقين بجانب الحرم. لا → فندق مكة بس، والمدينة يبقى نفس الفندق والغرفة (haram_keep).
  if (idata.haram_madinah_asked === true && _isUmrahReq && String(idata.program_final_raw || "")) {
    const _hpQ = ((idata.hotel_prefs && typeof idata.hotel_prefs === "object") ? idata.hotel_prefs : {}) as Record<string, unknown>;
    // ٥ نوفمبر ٢٠٢٦ (حي): «ياريت» ما انمسكت → طلع «تقصد نعدل البرنامج كذا؟». الكلمات أولاً، وإلا تصنيف النموذج (موافقة/رفض).
    const _ans = haramMadinahAnswer(_batch) || (/^yes/.test(String(_cls?.yes_no || "")) ? "yes" : String(_cls?.yes_no || "") === "no" ? "no" : null);
    if (_ans) {
      delete idata.haram_madinah_asked;
      if (_ans === "yes") { await _rebuildNow({ hotel_prefs: { ..._hpQ, haram: "بجانب الحرم" }, haram_madinah_asked: null }, ""); return; }
      const _keepM = madinahHotelFromRaw(String(idata.program_final_raw || ""));
      await _rebuildNow({ hotel_prefs: { ..._hpQ, haram: "بجانب الحرم", ...(_keepM ? { haram_keep: [_keepM] } : {}) }, haram_madinah_asked: null }, "");
      return;
    }
    // ردّ ما له علاقة بالسؤال → نشيل العلم ونكمل المسار العادي.
    delete idata.haram_madinah_asked;
    await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata } }).eq("phone", from);
  }
  if (_pend) {
    // 🧭 ٤ نوفمبر ٢٠٢٦ (قرار المالكة): إضافة مدينة لبرنامج متعدد المدن → بعد «نعم» نسأل عن الترتيب ومطار القدوم/المغادرة مع اقتراح.
    const _segs = String(_pend.distribution || "").split(/\s*-\s*/).map(x => x.trim()).filter(Boolean);
    const _segCity = (x: string) => x.replace(/^\d+\s*/, "").trim();
    if (_segs.length >= 2 && _pend.order_asked === true) {
      // ردّ العميل على سؤال الترتيب: موافقة → نبني؛ ذكر مدينة قدوم/مغادرة → نرتّب ثم نبني.
      const _t = _batch;
      const _arr = (_t.match(/(?:القدوم|الوصول|نوصل|نبدأ|نبدا|البداية|أول)\s*(?:على|في|إلى|الى|ب|من)?\s*(\S+)/) || [])[1] || "";
      const _dep = (_t.match(/(?:المغادر[ةه]|نغادر|العود[ةه]|نرجع|الرجوع|آخر|اخر|ننهي|النهاية)\s*(?:على|في|إلى|الى|ب|من)?\s*(\S+)/) || [])[1] || "";
      const _findIdx = (w: string, fromEnd = false) => { const nw = w.replace(/^ال/, ""); const idxs = _segs.map((x, i) => (_segCity(x).includes(nw) || nw.includes(_segCity(x)) ? i : -1)).filter(i => i >= 0); return idxs.length ? (fromEnd ? idxs[idxs.length - 1] : idxs[0]) : -1; };
      let segs = [..._segs];
      if (_arr) { const i = _findIdx(_arr); if (i > 0) { const [x] = segs.splice(i, 1); segs.unshift(x); } }
      if (_dep) { const i = segs.findIndex((x, k) => k === segs.length - 1 ? false : (_segCity(x).includes(_dep.replace(/^ال/, "")) || _dep.includes(_segCity(x)))); if (i >= 0 && i < segs.length - 1) { const [x] = segs.splice(i, 1); segs.push(x); } }
      if ((_arr || _dep) || _YY()) {
        if (await _superseded()) return;
        const _final = { ..._pend, distribution: segs.join(" - ") }; delete (_final as Record<string, unknown>).order_asked;
        if (!(await _medGate(_final))) { await _clearPend(); return; }
        await _applyModify(_final); return;
      }
    }
    if (_Y() && _segs.length >= 2 && _pend.order_asked !== true && !_isUmrahReq) {
      if (await _superseded()) return;
      const _cs = _segs.map(_segCity);
      const _mid = [...new Set(_cs.slice(1, -1))].filter(c => c !== _cs[0] && c !== _cs[_cs.length - 1]);
      const _q = `تمام، وبالنسبة للترتيب: تحب يكون القدوم على ${_cs[0]}${_mid.length ? `، وبعدها ${_mid.join(" و")}` : ""}، والمغادرة من ${_cs[_cs.length - 1]}؟ ولا حاب ترتيب ثاني؟`;
      await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, pending_modify: { ..._pend, order_asked: true } } }).eq("phone", from);
      await _say(_q, "followup_ai", "order_question", _pend.distribution as string);
      return;
    }
    if (_Y()) { if (await _superseded()) return; if (!(await _medGate(_pend))) { await _clearPend(); return; } await _applyModify(_pend); return; }
    await _clearPend();
    if (_N()) { await _say("تمام، وش التعديل اللي تبيه بالضبط؟", "followup_ai", "modify_declined"); return; }
  }
  // ✈️ ردّ العميل على «ما فيه طيران… أقرب رحلة X أو Y»: اختار تاريخ → نعدّل ليالي آخر مدينة (المدينة) + العودة منها → الكرت.
  //    «جدة/خلها» → تبقى العودة من جدة.
  let _alt = (idata.med_alt && typeof idata.med_alt === "object") ? idata.med_alt as { ret: string; dates: string[] } : null;
  // احتياط: البدائل مو محفوظة (جلسة قديمة) لكن آخر رد لطلال فيه «ما فيه طيران من المدينة… بتاريخ X… Y أو Z» → نستخرجها منه.
  if (!_alt) {
    const _lt = (msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)));
    const _mi = _AR_MONTHS.findIndex(mn => _lt.includes(mn));
    const _yr = (String(idata.date || "").match(/\d{4}/) || [String(new Date().getUTCFullYear())])[0];
    if (/(?:طيران|العود[ةه]|الرجوع)\s*من\s*(?:مطار\s*)?(?:ال)?مدين/.test(_lt) && /\d{1,2}\s*(?:أو|او)\s*\d{1,2}/.test(_lt) && _mi >= 0) {
      const nums = (_lt.match(/\d{1,2}(?=\s|\)|\s*أو|\s*نوفمبر|\s*ديسمبر|\s*يناير|\s*فبراير|\s*أكتوبر)/g) || []).map(Number).filter(n => n >= 1 && n <= 31);
      // تاريخ العودة الأصلي من الرحلة نفسها (تاريخ السفر + الليالي) — مو من ترتيب الأرقام بالنص.
      const _rd = _tripReturnDate(idata);
      if (_rd && nums.length >= 2) {
        const iso = (d: number) => `${_yr}-${String(_mi + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const alts = [...new Set(nums.filter(n => n !== _rd.getUTCDate()))].map(iso);
        if (alts.length) _alt = { ret: _rd.toISOString().slice(0, 10), dates: alts };
      }
    }
  }
  const _hadAlt = !!(_alt && _alt.ret);   // كنّا نناقش بدائل طيران المدينة
  if (_alt && _alt.ret) {
    const _clearAlt = async () => { delete idata.med_alt; await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata } }).eq("phone", from); };
    const _t = _batch.replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)));
    if (/جد[ةه]/.test(_t) && !/مدين/.test(_t)) { await _clearAlt(); await _say("تمام، تبقى العودة من جدة مثل البرنامج.", "followup_ai", "med_alt_keep_jeddah"); return; }
    const _days = (_t.match(/\d{1,2}/g) || []).map(Number);
    let _pick = (_alt.dates || []).find(d => _days.includes(new Date(d + "T00:00:00Z").getUTCDate()));
    if (!_pick && (_alt.dates || []).length) { if (/الأول|الاول|أول|اول/.test(_t)) _pick = _alt.dates[0]; else if (/الثاني|ثاني|الأخير|الاخير/.test(_t)) _pick = _alt.dates[_alt.dates.length - 1]; }
    // «طيب عدّلها / ايوه / تمام» بلا تاريخ → أقرب تاريخ لموعد العودة الأصلي.
    // ❌ «إذا غيرنا تاريخ القدوم ل ١٢» = تغيير تاريخ السفر، مو موافقة على البديل.
    const _otherDate = /القدوم|الذهاب|السفر|الوصول|الطلع[ةه]|المغادر[ةه]\s*من\s*مسقط/.test(_t) || _days.some(d => !(_alt.dates || []).some(x => new Date(x + "T00:00:00Z").getUTCDate() === d));
    if (!_pick && !_otherDate && (_alt.dates || []).length && (_Y(_t) || /^\s*(?:\S+\s+)?(?:عدّ?لها|عدّ?ل|غيّ?رها|زين|اوكي|ok)/i.test(_t))) {
      _pick = [..._alt.dates].sort((a, b) => Math.abs(Date.parse(a) - Date.parse(_alt.ret)) - Math.abs(Date.parse(b) - Date.parse(_alt.ret)))[0];
    }
    if (_pick) {
      const delta = Math.round((Date.parse(_pick) - Date.parse(_alt.ret)) / 864e5);
      const parts = String(idata.nights || "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).split(/\s+(?=\d)/).map(x => x.trim()).filter(Boolean);
      const lastIdx = parts.length - 1;
      const m = lastIdx >= 0 ? parts[lastIdx].match(/^(\d{1,2})(.*)$/) : null;
      if (m && +m[1] + delta >= 1) {
        parts[lastIdx] = `${+m[1] + delta}${m[2]}`;
        const changed = { nights: parts.join(" "), return_airport: "madinah" };
        await _clearAlt();
        if (await _superseded()) return;
        // ❌ لا كرت مباشر — تأكيد بالكلام أول (قرار المالكة).
        await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, pending_modify: changed } }).eq("phone", from);
        idata.pending_modify = changed;
        await _say(`تمام، يعني تقصد العودة ${_arDate(new Date(_pick + "T00:00:00Z"))} من مطار المدينة، والليالي ${changed.nights}؟`, "followup_ai", "modify_confirm_q", JSON.stringify(changed));
        return;
      }
    }
    await _clearAlt();   // ردّ ثاني → نكمل عادي
  }
  // 🗣️ ٤ نوفمبر ٢٠٢٦: «تقصد نخلي الليالي 11 ليالي، ونخلي الرحلة 12 أيام، والمدن…، والوجهة تايلاند (…)» — آلي ومكرّر وغلط نحوياً.
  //    الحين: نذكر **اللي تغيّر بس**، بجملة طبيعية، بأعداد صحيحة، ومع تاريخ العودة الجديد.
  const _numWord = (n: number, one: string, two: string, few: string, many: string) => n === 1 ? one : n === 2 ? two : (n >= 3 && n <= 10) ? `${n} ${few}` : `${n} ${many}`;
  const _modifyConfirmQ = (c0: Record<string, unknown>): string => {
    const same = (k: string) => String(c0[k] ?? "").trim() === String(idata[k] ?? "").trim();
    const c: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c0)) if (!same(k) || k === "return_airport" || k === "hotel_prefs") c[k] = v;
    if (c.destination && (extractDestination(String(c.destination)) === extractDestination(String(idata.destination || "")))) delete c.destination;
    const nd = { ...idata, ...c };
    const parts: string[] = [];
    if (c.return_airport === "madinah") parts.push("الذهاب إلى مطار جدة، وبعد ذلك العودة من مطار المدينة");
    else if (c.return_airport === "jeddah") parts.push("الذهاب والعودة من مطار جدة");
    const newCities = c.cities ? String(c.cities).split(/\s*(?:،|,|\s+و\s*)\s*/).filter(x => x && !String(idata.cities || "").includes(x)) : [];
    const dys = parseInt(String(c.days ?? "").replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))), 10);
    if (newCities.length && dys) parts.push(`نضيف ${newCities.join(" و")} وتصير الرحلة ${_numWord(dys, "يوم واحد", "يومين", "أيام", "يوم")} (${String(c.cities)})`);
    else {
      if (newCities.length) parts.push(`نضيف ${newCities.join(" و")} للبرنامج`);
      else if (c.cities) parts.push(`المدن تصير ${c.cities}`);
      if (dys) parts.push(`تصير الرحلة ${_numWord(dys, "يوم واحد", "يومين", "أيام", "يوم")}`);
      else if (c.nights && _isUmrahReq) parts.push(`الليالي تصير ${c.nights}`);
    }
    if (c.pax) parts.push(`العدد يصير ${c.pax}`);
    if (c.ages) parts.push(`أعمار الأطفال ${c.ages}`);
    if (c.date) parts.push(`السفر يكون ${c.date}`);
    if (c.destination) parts.push(`الوجهة تصير ${c.destination}`);
    const r = (c.date || c.days || c.nights) ? _tripReturnDate(nd) : null;
    if (r && !c.return_airport) parts.push(`والعودة ${_arDate(r)}`);
    if (!parts.length) return "تمام، تقصد نعدّل البرنامج كذا؟";
    // صيغة المالكة الحرفية لسؤال المطار وحده.
    if (parts.length === 1 && c.return_airport === "madinah") return "تمام، تقصد الذهاب إلى مطار جدة، وبعد ذلك العودة من مطار المدينة؟";
    return `تمام، تقصد ${parts.join("، ").replace(/،\s*والعودة/, "، والعودة")}؟`;
  };
  const _askModify = async (changed: Record<string, unknown>) => {
    if (await _superseded()) return;
    if (!(await _medGate(changed))) return;
    await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, pending_modify: changed } }).eq("phone", from);
    await _say(_modifyConfirmQ(changed), "followup_ai", "modify_confirm_q", JSON.stringify(changed).slice(0, 200));
  };
  // ✈️ طلب مطار العودة (حتميّ، بلا نموذج) — العمرة فقط.
  const _frustratedRe = /ليش\s*ما\s*(?:ترد|تردون)|ما\s*تردون|بطي[ءئ]?|بطيئين|متأخر|تعبان|سي[ءئ]|زفت|عيب\s*عليك|مو\s*كل\s*شوي|كل\s*شوي[هة]?\s*(?:اسأل|أسأل|اقول|أقول)|خبرتك|قلتلك|وبعدين\s*معا?ك|كم\s*مر[ةه]|(?:^|\s)افهم|ما\s*(?:تفهم|فهمت)|مو\s*فاهم|غبي|قلت\s*لك|(?:أ|ا)خبرك|يا\s*بن\s*الحلال|يابن\s*الحلال|للمر[ةه]\s*ال/.test(_batch);
  const _frustratedF = _cls ? _cls.frustrated : _frustratedRe;
  // 🧭 ٤ نوفمبر ٢٠٢٦: «خلي القدوم والمغادرة بوكيت» → حوّلها للزميل. ترتيب المدن/القدوم والمغادرة من قدرات طلال (أي وجهة غير العمرة):
  //    نعيد ترتيب توزيعة البرنامج المرسل (ولو القدوم والمغادرة نفس المدينة → نقسم لياليها بين البداية والنهاية) → تأكيد → بناء.
  if (!_isUmrahReq && String(idata.program_final_raw || "")) {
    const _pd = prevDistribution(String(idata.program_final_raw));
    const _t = _batch.replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)));
    const _cityIn = (frag: string) => { const f = frag.replace(/^ال/, ""); const hit = _pd.find(p => f.includes(p.city) || p.city.includes(f.split(/\s+/)[0] || "§")); return hit ? hit.city : ""; };
    const _both = (_t.match(/(?:القدوم|الوصول)\s*و\s*(?:المغادر[ةه]|العود[ةه])\s*(?:من|على|في|ب)?\s*(\S+)/) || [])[1];
    const _arrW = _both || (_t.match(/(?:القدوم|الوصول|نوصل|نبدأ|نبدا)\s*(?:على|في|إلى|الى|ب|من)?\s*(\S+)/) || [])[1] || "";
    const _depW = _both || (_t.match(/(?:المغادر[ةه]|نغادر|العود[ةه]\s*من|الرجوع\s*من|ننهي)\s*(?:على|في|إلى|الى|ب|من)?\s*(\S+)/) || [])[1] || "";
    const _arrC = _arrW ? _cityIn(_arrW) : "", _depC = _depW ? _cityIn(_depW) : "";
    if (_pd.length >= 2 && (_arrC || _depC) && /القدوم|الوصول|المغادر|العود|الرجوع|نبدأ|نبدا|ننهي|نوصل|نغادر/.test(_t)) {
      let segs = _pd.map(p => ({ ...p }));
      if (_arrC && _depC && _arrC === _depC && segs.filter(s0 => s0.city === _arrC).length === 1) {
        const i = segs.findIndex(s0 => s0.city === _arrC); const n = segs[i].nights; const a = Math.ceil(n / 2), b = n - a;
        segs.splice(i, 1);
        if (b >= 1) segs = [{ city: _arrC, nights: a }, ...segs, { city: _arrC, nights: b }]; else segs = [{ city: _arrC, nights: n }, ...segs];
      } else {
        if (_arrC) { const i = segs.findIndex(s0 => s0.city === _arrC); if (i > 0) { const [x] = segs.splice(i, 1); segs.unshift(x); } }
        if (_depC) { let i = -1; segs.forEach((s0, k) => { if (s0.city === _depC && k > 0) i = k; }); if (i >= 0 && i < segs.length - 1) { const [x] = segs.splice(i, 1); segs.push(x); } }
      }
      const _dist = segs.map(s0 => `${s0.nights} ${s0.city}`).join(" - ");
      if (_dist !== _pd.map(p => `${p.nights} ${p.city}`).join(" - ")) {
        const _nw = (n: number) => n === 1 ? "ليلة" : n === 2 ? "ليلتين" : `${n} ليالي`;
        const _desc = segs.map((s0, k) => k === 0 ? `${_nw(s0.nights)} ${s0.city}` : (k === segs.length - 1 ? `و${_nw(s0.nights)} ${s0.city} في الآخر` : `بعدها ${_nw(s0.nights)} ${s0.city}`)).join("، ");
        const _hdr = _arrC && _depC ? (_arrC === _depC ? `يكون القدوم والمغادرة من ${_arrC}` : `يكون القدوم على ${_arrC} والمغادرة من ${_depC}`) : (_arrC ? `يكون القدوم على ${_arrC}` : `تكون المغادرة من ${_depC}`);
        if (await _superseded()) return;
        await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, pending_modify: { distribution: _dist, order_asked: true } } }).eq("phone", from);   // الترتيب محسوم — «نعم» = بناء
        await _say(`تمام، تقصد ${_hdr}: ${_desc}؟`, "followup_ai", "reorder_confirm_q", _dist);
        return;
      }
    }
  }
  // 🍳 ٤ نوفمبر ٢٠٢٦ (قرار المالكة: «أي شي داخل البرنامج يتولاه طلال»): إفطار / فندق باسمه / جناح·فيلا·مسبح / إطلالة بحر.
  {
    const _t = _batch;
    const _hp: Record<string, unknown> = {};
    const _desc: string[] = [];
    if (/(?:فطور|إفطار|افطار|breakfast)/i.test(_t) && !/(?:بدون|بلا|ما\s*نبي|مو\s*لازم)\s*(?:ال)?(?:فطور|إفطار|افطار)/.test(_t)) { _hp.breakfast = true; _desc.push("الفنادق فيها إفطار"); }
    if (/(?:جناح|اجنحة|أجنحة|سويت|suite)/i.test(_t)) { _hp.feature = "suite"; _desc.push("الغرف أجنحة"); }
    else if (/(?:فيلا|فلل|villa)/i.test(_t)) { _hp.feature = /مسبح|pool/i.test(_t) ? "pool" : "villa"; _desc.push(_hp.feature === "pool" ? "فيلا بمسبح خاص" : "فيلا"); }
    else if (/مسبح\s*خاص|private\s*pool/i.test(_t)) { _hp.feature = "pool"; _desc.push("غرفة بمسبح خاص"); }
    if (/(?:إطلال[ةه]|اطلال[ةه]|مطل|على)\s*(?:ال)?(?:بحر|شاطئ)|sea\s*view/i.test(_t)) { _hp.sea_view = true; _desc.push("الغرف بإطلالة بحر"); }
    const _brandAr: Record<string, string> = { "هيلتون": "Hilton", "ماريوت": "Marriott", "شيراتون": "Sheraton", "نوفوتيل": "Novotel", "حياة": "Hyatt", "انتركونتيننتال": "InterContinental", "إنتركونتيننتال": "InterContinental", "راديسون": "Radisson", "موفنبيك": "Movenpick", "فورسيزنز": "Four Seasons", "فور سيزنز": "Four Seasons", "ريتز": "Ritz", "سوفيتيل": "Sofitel", "أماري": "Amari", "اماري": "Amari", "سنتارا": "Centara", "هوليداي ان": "Holiday Inn", "كراون بلازا": "Crowne Plaza", "دوسيت": "Dusit", "بولمان": "Pullman", "فوكو": "voco", "سويس": "Swiss" };
    const _arBrand = Object.keys(_brandAr).find(k => new RegExp(`فندق\\s+${k}|${k}\\s+(?:فندق|اوتيل|أوتيل)`).test(_t));
    const _nm = (_t.match(/فندق\s+([A-Za-z][A-Za-z0-9&' .-]{2,40})/) || [])[1]?.trim() || (_arBrand ? _brandAr[_arBrand] : undefined);
    if (_nm) { _hp.name = _nm; _desc.push(`فندق ${_nm}`); }
    if (Object.keys(_hp).length && /(?:ابي|أبي|ابغى|نبي|نبغى|خل|خلي|حط|حطو|ضيف|غير|بدل|ممكن|اريد|أريد)/.test(_t)) {
      const _hl0 = prevDistribution(String(idata.program_final_raw || ""));
      const _cityHit = _hl0.find(p => _t.includes(p.city));
      if (_hp.name && _cityHit) _hp.city = Object.keys(CITY_AR).find(k => CITY_AR[k] === _cityHit.city) || _cityHit.city;
      const _merged = { ...((idata.hotel_prefs as Record<string, unknown>) || {}), ..._hp };
      const _q = `تمام، تقصد ${_desc.join("، و")}${_cityHit && _hp.name ? ` في ${_cityHit.city}` : ""}؟`;
      if (await _superseded()) return;
      await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, pending_modify: { hotel_prefs: _merged } } }).eq("phone", from);
      await _say(_q, "followup_ai", "hotel_pref_confirm_q", JSON.stringify(_hp));
      return;
    }
  }
  // 🏨 ٤ نوفمبر ٢٠٢٦ (قرار المالكة): «غير لنا الفندق في بوكيت لمن نرجع من كرابي — مو نفس الأول» → طلال يغيّره بنفسه:
  //    تأكيد بالكلام («يعني أغيّر لك فندق بوكيت عند الرجوع من كرابي لفندق ثاني غير Diamond Resort، صحيح؟») → «صحيح» → بناء.
  {
    const _wantHotel = /(?:غيّ?ر|بدّ?ل|نغيّ?ر|تغيّ?ر|ابي|أبي|ابغى|نبي|نبغى)\S*\s*(?:\S+\s*){0,3}?(?:ال)?فندق|فندق\s*(?:ثاني|غير|آخر|اخر|ثانيه|ثانية)|مو\s*نفس\s*(?:ال)?(?:أول|اول|فندق)/.test(_batch) && !/سعر|كم\s*سعر/.test(_batch);
    const _hl = (String(idata.program_final_raw || "").split("HOTELS:")[1] || "").split(/\n\s*\n/)[0].split("\n").filter(l => l.includes("|")).map(l => { const p = l.split("|").map(x => x.trim()); return { name: p[0], city: p[1] }; });
    if (_wantHotel && _hl.length) {
      const _cityAr: Record<string, string> = { Phuket: "بوكيت", Krabi: "كرابي", Bangkok: "بانكوك", Pattaya: "باتايا", Makkah: "مكة", "Al Madinah": "المدينة", Madinah: "المدينة", Istanbul: "إسطنبول", Trabzon: "طرابزون" };
      const _ar = (c: string) => _cityAr[c] || c;
      const _named = _hl.find(h => _batch.includes(_ar(h.city)) || new RegExp(h.city, "i").test(_batch));
      const _target = _named || (_hl.length === 1 ? _hl[0] : null);
      if (_target) {
        const _visits = _hl.filter(h => h.city === _target.city);
        const _repeat = _visits.length > 1 && /(?:ل|لما|لمن|بعد|عند)\s*(?:ما\s*)?(?:نرجع|نعود|الرجوع|العودة|رجوعنا)|مو\s*نفس|الثاني|الثانية|المرة\s*الثانية/.test(_batch);
        const _otherCity = _hl.map(h => h.city).find(c => c !== _target.city);
        const _q = _repeat
          ? `يعني أغيّر لك فندق ${_ar(_target.city)} عند الرجوع${_otherCity ? ` من ${_ar(_otherCity)}` : ""} لفندق ثاني غير ${_target.name}، صحيح؟`
          : `يعني أغيّر لك فندق ${_ar(_target.city)} (${_target.name}) لفندق ثاني، صحيح؟`;
        const _pref = _repeat ? { unique_visit: true } : { exclude: [_target.name] };
        if (await _superseded()) return;
        await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, pending_modify: { hotel_prefs: _pref } } }).eq("phone", from);
        await _say(_q, "followup_ai", "hotel_change_confirm_q", JSON.stringify(_pref));
        return;
      }
    }
  }
  // 🚨 ٤ نوفمبر ٢٠٢٦: طلال أرسل برنامج العمرة لطلب تايلاند، والعميل «ايش هذا أنا طالب تايلند» → ردّ بسؤال تأكيد طويل بلا اعتذار.
  //    آخر برنامج انرسل وجهته ≠ وجهة الطلب الحالي + اعتراض → غلطة طلال (ج): اعتذار يسمّي الغلط + بناء الصحيح فوراً.
  {
    const _sentDest = (String(idata.program_final_raw || "").match(/^DEST:\s*(.+)$/m) || [])[1] || "";
    const _curDest = String(idata.destination || "").trim();
    const _sameD = (a: string, b: string) => !!a && !!b && (a === b || (_isUmrahDest(a) && _isUmrahDest(b)) || extractDestination(a) === extractDestination(b));
    const _objects = /ايش\s*هذا|وش\s*هذا|ش\s*هذا|مو\s*هذا|غلط|خطأ|خطا|(?:أنا|انا)?\s*(?:طالب|طلبت|ابي|أبي|اريد|أريد|ابغى)\s*\S+/.test(_batch);
    if (_sentDest && _curDest && !_sameD(_sentDest, _curDest) && _objects) {
      const _sd = _isUmrahDest(_sentDest) ? "العمرة" : _sentDest.trim();
      await _rebuildNow({}, `حاضر، أعتذر منك، أرسلت لك برنامج ${_sd} بالغلط. بجهّز لك برنامج ${_curDest} فوراً وأرسله لك.`);
      return;
    }
  }
  // ✈️ ٤ نوفمبر ٢٠٢٦ (قرار المالكة): سؤال «شامل الطيران؟» → الجواب من البرنامج نفسه (قسم FLIGHTS)، مو تخمين النموذج.
  {
    const _asksFlight = _cls ? _is("ask_flights") : new RegExp(`(?:شامل|يشمل|فيه|في|مشمول|داخل|تشمل)\\s*(?:\\S+\\s*){0,2}?${FLIGHT_WORD}|${FLIGHT_WORD}\\s*(?:\\S+\\s*){0,1}?(?:مشمول|داخل|شامل|موجود)`, "i").test(_batch);
    const _raw = String(idata.program_final_raw || "");
    if (_asksFlight && _raw) {
      const _fl = (_raw.split("FLIGHTS:")[1] || "").split(/\n\s*\n/)[0].split("\n").filter(l => l.includes("|"));
      const _route = (l: string) => String(l.split("|")[0] || "").replace(/^\s*اليوم\s*\d+\s*:\s*/, "").replace(/\s*\(.*$/, "").replace(/\s*-\s*/g, " ← ").replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();
      const _arCity = (x: string) => x.replace(/[A-Za-z][A-Za-z ]*[A-Za-z]|[A-Za-z]/g, w => CITY_AR[w] || CITY_AR[w.replace(/\b\w/g, c => c.toUpperCase())] || w).replace(/\s*←\s*/g, " ← ");
      const _intl = _fl.filter(l => /\|\s*(?:ذهاب|عودة|عوده)\s*\|/.test(l) || /مسقط|muscat/i.test(l));
      const _dom = _fl.filter(l => /\|\s*داخلي\s*\|/.test(l));
      const _list = (ls: string[]) => ls.map(l => _arCity(_route(l))).filter(Boolean).join("، و");
      let _ans: string;
      if (_intl.length) _ans = `إيه أستاذي، البرنامج شامل الطيران الدولي (${_list(_intl)})${_dom.length ? `، والطيران الداخلي بين المدن (${_list(_dom)})` : ""}.`;
      else if (_dom.length) _ans = `لا أستاذي، البرنامج ما يشمل الطيران الدولي، بس يشمل الطيران الداخلي بين المدن (${_list(_dom)}) مع الاستقبال والتوديع. ولو حاب نضيف لك الطيران الدولي، بحوّل طلبك لزميلي المختص يسعّره لك.`;
      else _ans = "لا أستاذي، البرنامج ما يشمل الطيران، بس يشمل الفنادق والتنقلات المذكورة. ولو حاب نضيف لك الطيران الدولي، بحوّل طلبك لزميلي المختص يسعّره لك.";
      if (await _superseded()) return;
      await _say(_ans, "followup_ai", "flight_inclusion_answer", `intl=${_intl.length} dom=${_dom.length}`, true);
      return;
    }
  }
  // ✈️ ردّ على عرض طلال «ولو حاب نضيف لك الطيران الدولي، بحوّل طلبك لزميلي…»: موافقة صريحة → تحويل؛ «طيب» (ملتبسة) → سؤال واضح.
  {
    const _ltF = msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "";
    if (/نضيف لك الطيران الدولي|نضيف الطيران الدولي/.test(_ltF) && /زميلي/.test(_ltF)) {
      const _t = text.trim().replace(/[\u064B-\u0652]/g, "");
      const _clearYes = /^(?:ايوه|ايوا|إيوه|أيوه|نعم|اكيد|أكيد|ضيفه|ضيفها|أضفه|اضفه|حوله|حوّله|ابي|أبي|نبي|يب|يس|yes)(?=\s|$|[!.،])/.test(_t) || new RegExp(`(?:ضيف|أضف|اضف|ابي|أبي|نبي)\\S*\\s*${FLIGHT_WORD}`, "i").test(_t);
      const _ambig = /^(?:طيب|تمام|اوكي|ok|زين|ماشي)\s*[.!]?$/i.test(_t);
      if (_cls ? (_cls.yes_no === "yes" || _is("want_intl_flight")) : _clearYes) {
        await _say("أبشر، حوّلت طلب الطيران الدولي لزميلي المختص يسعّره لك وبيرد عليك قريب إن شاء الله.", "followup_ai", "flight_handoff");
        try { await createProposalAndNotifyAdmin({ supabase, customerPhone: from, profileName, question: "العميل يبي يضيف الطيران الدولي للبرنامج " + String(idata.program_final_code || "") }); } catch (_e) { /* */ }
        return;
      }
      if (_cls ? (_cls.yes_no === "none" && _ambig) : _ambig) { await _say("تحب نضيف الطيران الدولي للبرنامج؟ أحوّل طلبك لزميلي المختص يسعّره لك.", "followup_ai", "flight_offer_confirm"); return; }
    }
  }
  // ✈️ ٤ نوفمبر ٢٠٢٦ (أول تجربة حية للمصنّف): «انتظر الطيران» → Sonnet فهمها want_intl_flight صح، لكن حارس «متضايق بلا حجز/دفع»
  //    منع التحويل وطلع «فهمني إيش تقصد». الحين: طلب الطيران الدولي (غير العمرة) = تحويل مباشر؛ ولو سبق وتحوّل → طمأنة بلا تحويل ثاني.
  // ⚠️ ٤ نوفمبر ٢٠٢٦ (حي، ثاني مرة): «انتظر الطيران» صنّفها Sonnet «waiting» (ينتظر تسعيرة الطيران) وطلال وعد «زميلي بيرد عليك»
  //    والطلب **ما تحوّل أصلاً** (التحويل الأول انمنع). ينتظر الطيران + ما سبق تحويل → نحوّل فعلاً.
  if ((_is("want_intl_flight") || (_is("waiting") && new RegExp(FLIGHT_WORD, "i").test(_batch))) && !_isUmrahReq) {
    if (await _superseded()) return;
    const _already = msgs.some(m => m.who === "طلال" && /حوّ?لت طلب الطيران الدولي/.test(m.body));
    if (_already) { await _say("طلب الطيران الدولي عند زميلي المختص، وبيرد عليك بالسعر قريب إن شاء الله.", "followup_ai", "flight_handoff_reassure"); return; }
    await _say("أبشر، حوّلت طلب الطيران الدولي لزميلي المختص يسعّره لك وبيرد عليك قريب إن شاء الله.", "followup_ai", "flight_handoff");
    try { await createProposalAndNotifyAdmin({ supabase, customerPhone: from, profileName, question: "العميل يبي يضيف الطيران الدولي للبرنامج " + String(idata.program_final_code || "") }); } catch (_e) { /* */ }
    return;
  }
  // 🕋 ٤ نوفمبر ٢٠٢٦ (قرار المالكة): «ليش الفندق بعيد / مو بجانب الحرم / ابي الأبراج» على عرض الفندق الموصى به →
  //    أول مرة: فكرة عن الفندق (رسائل مجزّأة) + «إذا حبيت الأبراج أو بجانب الحرم بلغني». بعدها لو طلب → العرض الثاني (بجانب الحرم).
  if (_isUmrahReq && String(idata.program_final_raw || "") && HARAM_COMPLAINT_RE.test(_batch)) {
    if (await _superseded()) return;
    const _hpH = ((idata.hotel_prefs && typeof idata.hotel_prefs === "object") ? idata.hotel_prefs : {}) as Record<string, unknown>;
    const _recMakkah = /address\s*jabal\s*omar/i.test(String(idata.program_final_raw || ""));
    if (!idata.haram_explained && _recMakkah && String(_hpH.haram || "") !== "بجانب الحرم") {
      // ٥ نوفمبر ٢٠٢٦ (قرار المالكة): «بجانب الحرم» قد يقصد الحرم المدني (المدينة) أو المكي → لا نفترض مكة:
      //    نبدأ بشرط «إذا كنت تقصد الفندق اللي في مكة» ثم التفاصيل. لو العميل ذكر مكة/الأبراج/برج الساعة صراحة → بلا شرط.
      const _saidMakkah = /مك[ةه]|(?:ال)?[أا]براج|برج\s*(?:ال)?ساع[ةه]/.test(_batch);
      const _parts = [
        _saidMakkah ? "أستاذي، بعطيك فكرة عن الفندق أولاً وبعدين قرّر." : "أستاذي، إذا كنت تقصد الفندق اللي في مكة، خليني أعطيك نبذة عنه وبعدين قرّر.",
        "أولاً الفندق قريب جداً من الحرم، وتقدر تروح له مشي ٥ دقايق من الفندق، أو عبر الباصات المتوفرة على مدار الساعة دون توقف.",
        "الشي الثاني، الفندق ٥ نجوم وراقي جداً، وأسعاره مميزة جداً مقارنة بالفنادق الثانية.",
        "على العموم اطّلع عليه، وإذا حبيت فندق في الأبراج أو بجانب الحرم بلغني وأرسل لك العرض الثاني.",
      ];
      for (const p of _parts) { const ok = await _say(p, "followup_ai", "haram_hotel_explain", "", true); if (!ok) return; }
      await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, haram_explained: true } }).eq("phone", from);
      return;
    }
    // ٥ نوفمبر ٢٠٢٦ (قرار المالكة): قبل ما نغيّر نسأل عن فندق المدينة — إلا لو العميل حدّدها بنفسه.
    const _madAns = /المدين/.test(_batch) ? (haramMadinahAnswer(_batch) || "yes") : null;
    if (!_madAns && madinahHotelFromRaw(String(idata.program_final_raw || ""))) {
      const ok = await _say("تمام أستاذي، وحتى فندق المدينة أغيّره لك بجانب الحرم؟", "followup_ai", "haram_madinah_ask", "", true);
      if (!ok) return;
      await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, haram_madinah_asked: true } }).eq("phone", from);
      return;
    }
    if (_madAns === "no") { const _keepM = madinahHotelFromRaw(String(idata.program_final_raw || "")); await _rebuildNow({ hotel_prefs: { ..._hpH, haram: "بجانب الحرم", ...(_keepM ? { haram_keep: [_keepM] } : {}) } }, ""); return; }
    await _rebuildNow({ hotel_prefs: { ..._hpH, haram: "بجانب الحرم" } }, "");   // رسالة البناء «تمام، أبشر، شوية والبرنامج عندك.» تكفي
    return;
  }
  // ⏳ ٤ نوفمبر ٢٠٢٦: البرنامج قيد التجهيز («تمام، أبشر، شوية والبرنامج عندك») والعميل ينتظر → كان النموذج يقول «طلبك عند زميلي».
  {
    const _lt0 = msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "";
    const _building = /شوية والبرنامج عندك|بجهّ?ز لك برنامج|بعدّ?ل البرنامج فورا/.test(_lt0);
    const _waiting0 = /^\s*(?:في\s*(?:ال)?انتظار\s*\S*|بانتظارك|منتظر|ننتظر|وينك|وينكم|وين\s*البرنامج|متى\s*يوصل|[؟?]+)\s*[؟?]*\s*$/.test(text.replace(/[\u064B-\u0652]/g, ""));
    if (_building && (_cls ? _is("waiting", "resend_program") : _waiting0)) { await _say("البرنامج قيد التجهيز، ثواني ويوصلك إن شاء الله.", "followup_ai", "building_wait"); return; }
  }
  // 🤝 آخر رد لطلال حوّل الطلب للزميل (تعديل خارج قدراته) والعميل ينتظر («في انتظارك») → طمأنة ثابتة، ❌ بلا تراجع ولا وعود.
  {
    const _lt = msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "";
    const _handedOff = /حوّ?لت?\s*(?:لك\s*)?طلبك|بحوّ?ل\s*طلبك|عن\s*طريق\s*زميلي|زميلي\s*المختص/.test(_lt);
    const _waitingF = /^\s*(?:في\s*الانتظار|في\s*انتظارك|بانتظارك|منتظر|ننتظر|وينك|وينكم|[؟?]+)\s*[؟?]*\s*$/.test(text);
    if (_handedOff && (_cls ? _is("waiting") : _waitingF)) { await _say("طلبك عند زميلي المختص وبيرد عليك قريب إن شاء الله.", "followup_ai", "handoff_reassure"); return; }
  }
  // 🔎 العميل يشتكي من البرنامج («شوف البرنامج اللي أرسلته»، «عيب عليك») → طلال يفحص برنامجه بنفسه:
  //    فيه خطأ → اعتذار + تصحيح وإرسال؛ ما لقى → اعتذار (أ) ويسأل وش الغلط. ❌ أبداً «ما فيه خطأ» (قرار المالكة).
  const _complainsProg = _cls ? _is("complaint_program") : /(?:شوف|راجع|تأكد\s*من|افحص)\s*(?:\S+\s*){0,2}?(?:ال)?(?:برنامج|برنانج|ملف)|(?:ال)?برنامج\s*(?:\S+\s*){0,2}?(?:غلط|خطأ|خطا|فيه\s*غلط|مو\s*صح|ناقص)/.test(_batch);
  if ((_complainsProg || _frustratedF) && String(idata.program_final_raw || "").trim() && String(idata.program_final_code || "")) {
    const _iss = _programIssues(String(idata.program_final_raw), idata, from);
    if (_iss.length) { if (await _superseded()) return; await _selfCorrectProgram(supabase, from, String(idata.program_final_code), String(idata.program_final_raw), idata, false); return; }
    if (_complainsProg) { await _say("أعتذر منك أستاذي، بس فهمني وش الغلط اللي لاحظته في البرنامج عشان أصححه لك فوراً؟", "followup_ai", "complaint_no_issue_found", "", true); return; }
  }
  // 🛟 احتياط (القاعدة ٣): كاشفات الكلمات لطلب مطار العودة — تشتغل **بعد** فهم النموذج، لو فاته أو فشل.
  const _medReqs = msgs.filter(m => m.who === "العميل" && (RE_RET_MED.test(m.body) || /مطار\s*(?:ال)?مدين/.test(m.body))).length;
  const _airportRegex = async (): Promise<boolean> => {
    if (!_isUmrahReq) return false;
    const _wantMed = RE_RET_MED.test(_batch) && !/(?:مش|مو|مب|ما|لا)\s*(?:من\s*)?(?:مطار\s*)?(?:ال)?مدين/.test(_batch);
    const _wantJed = RE_RET_JED.test(_batch) && !/(?:مش|مو|مب|ما|لا)\s*(?:من\s*)?(?:مطار\s*)?جد/.test(_batch);
    // ٣ نوفمبر: «وين مطار المدينه» (بلا كلمة عودة)، أو «ايوه/غير» بعد ما عرض طلال تغيير المطار للمدينة.
    const _mentionsMedAirport = /مطار\s*(?:ال)?مدين[ةه]/.test(_batch) && !/(?:مش|مو|مب|ما|لا)\s*(?:من\s*)?مطار\s*(?:ال)?مدين/.test(_batch);
    const _lastT = msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "";
    const _offeredMed = /مطار\s*(?:ال)?مدين/.test(_lastT) && /(?:تبي|تبغى|تحتاج|حاب)\s*(?:\S+\s*){0,3}(?:تغيير|تغير|تعديل|تبديل)/.test(_lastT);
    const _yesOrChange = _Y() || /^\s*(?:غيّ?ر|غيره|غيرها|بدّ?ل|عدّ?ل)\s*$/.test(text);
    // 🧠 طلب سابق ما تنفّذ: العميل طلب العودة من المدينة قبل، والبرنامج ما فيه → «وين البرنامج/كم لي انتظر» = (ج) تصحيح فوري.
    const _lastNoFlight = msgs.map(m => m.who === "طلال" && /ما فيه طيران من المدينة إلى مسقط/.test(m.body)).lastIndexOf(true);
    const _medAsks = msgs.map((m, i) => ({ m, i })).filter(({ m, i }) => i > _lastNoFlight && m.who === "العميل" && (RE_RET_MED.test(m.body) || /مطار\s*(?:ال)?مدين/.test(m.body)) && !/(?:مش|مو|مب|ما|لا)\s*(?:من\s*)?(?:مطار\s*)?(?:ال)?مدين/.test(m.body));
    const _askProgNow = /(?:وين|فين|ارسل|أرسل|رسل|ابي|أبي|ابغى|عطني)\S*\s*(?:لي\s*)?(?:ال)?(?:برنامج|برنانج|ملف|عرض)|(?:ال)?(?:برنامج|ملف)\s*(?:\S+\s*)?(?:وين|فين|وينه|فينه|فينهر)|كم\s*(?:لي\s*)?(?:انتظر|أنتظر|بنتظر)|متى\s*(?:يوصل|بيوصل|ترسل)/.test(_batch);
    if (!_retMed && _medAsks.length && (_askProgNow || _frustratedF) && !_wantMed && !_mentionsMedAirport) { await _rebuildNow({ return_airport: "madinah" }); return true; }
    if ((_wantMed || _mentionsMedAirport || (_offeredMed && _yesOrChange)) && !_retMed) {
      // قرار المالكة ٣ نوفمبر: العميل متضايق أو كرّر الطلب → طلال يعتذر ويصحّح على طول (الكرت المصحّح)، بلا سؤال إضافي ولا تحويل.
      // (ج) الطلب سبق وانقال (أو العميل متضايق منه) والبرنامج المرسل ما فيه → غلطة طلال: اعتذار + تصحيح وإرسال فوراً.
      if (_frustratedF || _medReqs >= 2) { await _rebuildNow({ return_airport: "madinah" }); return true; }
      await _askModify({ return_airport: "madinah" }); return true;
    }
    if (_wantJed && _retMed) { await _askModify({ return_airport: "jeddah" }); return true; }
    return false;
  };
  // طلب سابق للعودة من المدينة ما تنفّذ (بعد آخر «ما فيه طيران»)؟
  const _unmetMed = (() => { const ln = msgs.map(m => m.who === "طلال" && /ما فيه طيران من المدينة إلى مسقط/.test(m.body)).lastIndexOf(true);
    return !_retMed && _isUmrahReq && msgs.some((m, i) => i > ln && m.who === "العميل" && (RE_RET_MED.test(m.body) || /مطار\s*(?:ال)?مدين/.test(m.body)) && !/(?:مش|مو|مب|ما|لا)\s*(?:من\s*)?(?:مطار\s*)?(?:ال)?مدين/.test(m.body)); })();
  // المصدر المعتمد = نص الـPDF النهائي (program_final_raw). نسخة السيرفر الأولى (auto_program) تنقلاتها
  //   قبل التصحيح (حادثة ٣ نوفمبر: فيها «مطار المدينة» والـPDF جدة) → نشيل سطور المطار/المحطة منها.
  const _finalRaw = String(idata.program_final_raw || "").trim();
  const program = (_finalRaw
    ? _finalRaw.replace(/^(?:CHAT|CLIENT_CODE|EXTRA_BED_CITIES|META):.*$/gm, "")
    : String(idata.auto_program || "").split("\n").filter(l => !/مطار|محط[ةه]/.test(l)).join("\n")).slice(0, 4000);
  // 🔴 ٣ نوفمبر ٢٠٢٦: طلال قال «البرنامج فوق في المحادثة» وهو ما انرسل (فشل الـPDF). الحالة الحقيقية من طابور الـPDF.
  const { data: _job0 } = await supabase.from("program_pdf_jobs").select("id, code, status, created_at").eq("phone", from).order("created_at", { ascending: false }).limit(1).maybeSingle();
  // ٤ نوفمبر ٢٠٢٦: «البرنامج وصلك هلأ؟» عن برنامج تايلاند اللي ما انبنى — طلال شاف برنامج العمرة القديم «sent». الطلب الحالي فقط.
  const _reqStart = Date.parse(String(idata.started_at || "")) || 0;
  const _job = (_job0 && (Date.parse(String((_job0 as { created_at?: string }).created_at || "")) || 0) >= _reqStart) ? _job0 : null;
  const _jobSt = String((_job as { status?: string } | null)?.status || "");
  const _textSent = msgs.some(m => m.who === "طلال" && /برنامج\s*العمر[ةه]|الفنادق\s*والإقام[ةه]/.test(m.body));
  const _curFinal = !!String(idata.program_final_raw || "").trim() && (!_reqStart || !!_job);
  const progStatus: "sent" | "pending" | "failed" | "none" = (_jobSt === "sent" || (_textSent && !_reqStart) || _curFinal) ? "sent" : (_jobSt === "pending" ? "pending" : (_jobSt === "failed" ? "failed" : "none"));
  const _wantsProgram = _cls ? _is("resend_program") : /(?:ارسل|أرسل|رسل|ابي|أبي|ابغى|أبغى|وين|فين|عطني|ابعث)\S*\s*(?:لي\s*)?(?:ال)?(?:برنامج|برنانج|ملف|pdf|العرض)|(?:البرنامج|الملف|العرض)\s*(?:ما|مو|مش|مب)\s*(?:وصل|مبين|طالع|ظاهر)|(?:ما|مو|مش|مب)\s*(?:وصل|مبين|طالع|ظاهر)|مره\s*ثاني|مرة\s*ثاني|(?:ال)?(?:برنامج|برنانج|ملف|عرض)\s*(?:\S+\s*)?(?:وين|فين|وينه|فينه|فينهر|وينه?و)/i.test(_batch);
  const _resendProgram = async (): Promise<boolean> => {
    if (progStatus === "none" || !_job) return false;
    const _j = _job as { id: number; code: string; status: string };
    let reply = "أبشر، ثواني ويوصلك البرنامج";
    // 💱 ٣ نوفمبر ٢٠٢٦: برنامج قديم محفوظ بلا عملة → الـPDF يطلع بالسعودي لرقم عُماني. نثبّت عملة العميل فيه قبل الإرسال.
    try {
      const _cur = await _currencyForPhone(supabase, from);
      if (_cur) {
        const { data: _pr } = await supabase.from("programs").select("raw").eq("code", _j.code).maybeSingle();
        const _raw = String((_pr as { raw?: string } | null)?.raw || "");
        if (_raw && !/\nCURRENCY:|^CURRENCY:/.test(_raw)) {
          await supabase.from("programs").update({ raw: _raw.replace(/^(DEST:.*)$/m, `$1\nCURRENCY:${_cur.name}|${_cur.rate}`) }).eq("code", _j.code);
          await logGuard(supabase, from, "followup_ai", "currency_patch", _j.code + " → " + _cur.name, 1, "", "");
        }
      }
    } catch (_e) { /* أفضل جهد */ }
    if (_j.status === "sent") await supabase.from("program_pdf_jobs").insert({ phone: from, code: _j.code });
    else if (_j.status === "failed") await supabase.from("program_pdf_jobs").update({ status: "pending", attempts: 0, error: null }).eq("id", _j.id);
    else reply = "البرنامج قيد التجهيز، ثواني ويوصلك";
    await sendCustomerReply(supabase, from, reply);
    try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(reply), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
    await logGuard(supabase, from, "followup_ai", "resend_program", _j.status, 1, text, reply);
    return true;
  };
  const _progLine = progStatus === "sent" ? "البرنامج اللي **وصل** العميل:"
    : progStatus === "pending" ? "⚠️ البرنامج **قيد التجهيز وما وصل العميل بعد** — لا تقل إنه أُرسل؛ قل «ثواني ويوصلك»:"
    : progStatus === "failed" ? "⚠️ البرنامج **ما وصل العميل** (تعطّل الإرسال) — ❌ لا تقل إنه فوق/أُرسل؛ action=\"handoff\":"
    : "";
  const isUmrahF = _isUmrahDest(String(facts.destination || "") + " " + String(facts.cities || ""));
  const transcript = msgs.slice(-16).map(m => m.who + ": " + m.body).join("\n").slice(-3500);
  const sys = `أنت طلال من خدمة عملاء وكالة سفر عُمانية، تكلّم العميل بلهجة خليجية طبيعية مختصرة (رسالة وحدة، بلا إيموجي، بلا «أستاذي»).
طلب العميل **مؤكّد ومخزّن** — هذي حقائق ثابتة، ❌ لا تسأل عنها أبداً ولا تغيّرها من عندك:
${JSON.stringify(facts)}
${program && _progLine ? _progLine + "\n" + program : "(البرنامج ما انرسل له بعد — ❌ لا تقل إنه أُرسل أو موجود فوق)"}
القواعد:
• جاوب سؤاله من الحقائق والبرنامج فقط. ❌ لا تخترع فنادق/أسعار/مواعيد غير موجودة فيهم.
• ❌ لا تذكر أي سعر رقمي إلا لو موجود حرفياً في البرنامج.
• لو طلب **تعديل** معلومة (عدد/أعمار/تاريخ/ليالي/مدن/مطار العودة) → action="modify" وضع الحقول الجديدة **فقط** في fields (مطار العودة: return_airport="madinah" أو "jeddah").
• تغيير مطار العودة (جدة ↔ المدينة) = action="modify" مع return_airport — ❌ مو handoff ولا «بحوّل للزميل».
• اقرأ المحادثة **كاملة** — لو فيه رسالة من العميل ما رديت عليها (وصلت وأنت ترد)، خذها بعين الاعتبار ولا تتجاهلها.
• كلمة فيها غلط إملائي وتشبه اسم وجهة (مثل «تلاتد» = تايلاند) → ❌ لا تقول «ما فهمت»؛ اسأل «عفواً إذا سمحت، تقصد تايلاند؟».
• العميل يبي رحلة **لناس ثانيين** (عيلة ثانية/أهله/ربعه) = طلب جديد مستقل، مو تعديل البرنامج الحالي.
• ❌ لا تقول للعميل إن شي «غير متوفر» أو «ما لقيناه» (فندق/غرفة/تاريخ) — قسم الحجوزات يراجع عند التأكيد والموظف يبلغه (قرار المالكة).
• 🌴 أسلوب مبيعات (قرار المالكة ٤ نوفمبر ٢٠٢٦): أي كلام عن الوجهة (الطقس، الأماكن، المسافات، الزحمة) = الحقائق **بصياغة إيجابية**
  تشجّع على الرحلة. ❌ لا كلمات منفّرة («حار»، «رطوبة»، «مطر أحياناً»، «زحمة»، «بعيد»، «غالي») — مثال: بدل «الجو حار ورطوبة معتدلة،
  المطر أحياناً» قل «الجو معتدل ودرجات الحرارة بين 25 و32، ومناسب جداً للشواطئ والجولات». ❌ لا تخترع. لو سأل العميل **تحديداً**
  عن عيب («فيه مطر؟») جاوب بصدق وبلطف مع الجانب الإيجابي.
• ❌ لا تذكر للعميل تفاصيل داخلية («أحولك/ما احتاج أحولك»، «أنا أقدر/ما أقدر»، «النظام») — كلّمه عن طلبه بس.
• المطارات: للعمرة = حقل airports بالضبط. لغير العمرة ❌ لا تذكر أي مطار أو مدينة إقلاع (جدة/مسقط…) إلا لو مكتوبة في البرنامج أو قالها العميل.
• ❌ أبداً لا تقول «ما فيه خطأ» أو تحمّل العميل يدوّر الغلط — لو ما عرفت الغلط: «أعتذر منك أستاذي، بس فهمني وش الغلط اللي لاحظته عشان أصححه لك فوراً؟».
• العميل متضايق → اعتذر بإحدى ثلاث (قرار المالكة):
  (أ) ما فهمت قصده → «أعتذر منك أستاذي، بس فهمني إيش تقصد بـ…؟» (اذكر الكلمة اللي ما فهمتها).
  (ب) فهمت والعميل غلطان (يخالف الحقائق/البرنامج) → «أعتذر منك، بس أنا سبق ووضحت لك …» واذكر الحقيقة من الحقائق.
  (ج) أنت غلطت (البرنامج ما فيه شي طلبه) → action="modify" بالحقل الصحيح.
• 🧰 قدراتك الفعلية (٤ نوفمبر ٢٠٢٦ — ❌ لا تعِد بشي خارجها):
  ✅ **أي شي داخل البرنامج تتولاه بنفسك** (قرار المالكة): التاريخ، الليالي/الأيام، العدد، الأعمار، المدن، ترتيب المدن والقدوم/المغادرة،
     مطار العودة (العمرة)، تغيير الفندق، فندق باسمه، الإفطار، نوع الغرفة (جناح/فيلا/مسبح/إطلالة بحر) → action="modify".
  ❌ الزميل المختص **فقط** لـ: الطيران الدولي (لغير العمرة)، الحجز والدفع، الخصومات وتغيير الأسعار
     → action="handoff" برسالة صادقة: «أبشر، [الطلب] يحتاج زميلي المختص، حوّلت له طلبك وبيرد عليك قريب».
  • ❌ لا تذكر «زميلي المختص» إلا لو العميل طلب طيران دولي (لغير العمرة) أو حجز/دفع/خصم بنفسه — غير كذا تتولاه أنت.
• ❌ تعديل البرنامج (من قدراتك) أو تضايق العميل من فهمك = **مو** handoff: اعتذر («أعتذر منك») وحدّد التعديل (action="modify")، أو اسأله وش التعديل بالضبط.
• handoff فقط للحجز/الدفع/التأكيد النهائي/خصم/شكوى على الخدمة نفسها → action="handoff" ورسالة «أبشر، بحوّل طلبك لزميلي المختص ويرد عليك قريب».
• العميل يطلب البرنامج/الملف أو يقول ما وصله/مو مبين («وين البرنامج»، «ارسله مره ثانيه»، «البرنامج فينه») → action="resend_program".
• frustration: none (هادي) | misunderstood (أنت ما فهمت) | customer_wrong (العميل يخالف الحقائق) | talal_error (البرنامج ما فيه شي سبق وطلبه).
• غير ذلك action="reply".
• الطفل عندنا ١٠ سنوات وتحت (بدون سرير إضافي)، و١١ وفوق بالغ.
أعد JSON فقط: {"message":"...","action":"reply|modify|resend_program|handoff","frustration":"none","fields":{}}${_cls ? `\n\n🧠 فهم رسالة العميل الأخيرة (موثوق): «${_cls.meaning}» — النية: ${_cls.intent}${_cls.yes_no !== "none" ? `، جوابه: ${_cls.yes_no}` : ""}. ابنِ ردك على هذا الفهم.` : ""}`;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const model = (Deno.env.get("TALAL_MODEL_OVERRIDE") || "").trim() || "claude-sonnet-4-6";   // Sonnet لكل الوجهات (قرار المالكة)
  type FOut = { message?: string; action?: string; frustration?: string; fields?: Record<string, unknown> };
  let out: FOut | null = null;
  let sysTry = sys;
  let _fToolsOff = false;
  for (let att = 1; att <= 3 && !out; att++) {
    try {
      const anthropic = new Anthropic({ apiKey });
      const res = await anthropic.messages.create({ model, max_tokens: 600, system: sysTry, messages: [{ role: "user", content: transcript || text }],
        ...(_fToolsOff ? {} : { tools: [FOLLOWUP_TOOL as never], tool_choice: { type: "tool", name: FOLLOWUP_TOOL.name } as never }) });
      const txt = _modelText(res as unknown as { content: unknown[] });
      const m = txt.match(/\{[\s\S]*\}/);
      let cand: FOut | null = null;
      if (m) { try { cand = JSON.parse(m[0]); } catch (_e) { cand = null; } }
      if (!cand || !String(cand.message || "").trim()) { await logGuard(supabase, from, "followup_model_fail", "retry", (m ? "bad_json" : "no_json") + ": " + txt.slice(0, 150), att, "", ""); continue; }
      const rej = cand.action === "handoff" ? null : guardReject(String(cand.message), facts, { isUmrah: isUmrahF, isOmani: /^whatsapp:\+?968/.test(from) });
      if (rej) {
        await logGuard(supabase, from, rej.guard, "reject", "followup: " + rej.reason, att, String(cand.message), "");
        sysTry = sys + `\n\n⚠️ حارس رفض ردك السابق: «${rej.reason}». أعد الصياغة ملتزماً بهذا.`;
        if (att >= 3) cand = { message: "أبشر، بحوّل طلبك لزميلي المختص ويرد عليك قريب", action: "handoff", fields: {} };
        else continue;
      }
      out = cand;
    } catch (e) { _fToolsOff = true; await logGuard(supabase, from, "followup_model_fail", "retry", "api_error: " + String((e as Error)?.message || e).slice(0, 150) + " [tools→off]", att, "", ""); }
  }
  if (!out) out = { message: "أبشر، بحوّل طلبك لزميلي المختص ويرد عليك قريب", action: "handoff", fields: {} };
  let action = String(out.action || "reply");
  const _modelFrus = String(out.frustration || "none");
  const _frus = _frustratedF || (_modelFrus !== "none" && _modelFrus !== "");
  // 🧠 القاعدة ٣: قرار النموذج أولاً.
  if (action === "resend_program") {
    if (_unmetMed) { await _rebuildNow({ return_airport: "madinah" }); return; }   // (ج) طلب سابق ما تنفّذ → تصحيح، مو إعادة القديم
    if (await _resendProgram()) return;
    action = "reply";
  }
  if (action === "modify" && out.fields && String((out.fields as Record<string, unknown>).return_airport || "") === "madinah" && !_retMed && _isUmrahReq) {
    if (_frus || _medReqs >= 2) { await _rebuildNow({ return_airport: "madinah" }); return; }
    await _askModify({ return_airport: "madinah" }); return;
  }
  // 🛟 احتياط: النموذج ردّ/حوّل لكن كاشفات الكلمات شافت طلب واضح (مطار/البرنامج) → نطبّقه.
  if (action !== "modify") {
    if (await _airportRegex()) return;
    if (_wantsProgram) { if (_unmetMed) { await _rebuildNow({ return_airport: "madinah" }); return; } if (await _resendProgram()) return; }
  }
  if (action === "modify" && out.fields && Object.keys(out.fields).length) {
    // تعديل → سؤال تأكيد طبيعي أولاً (قرار المالكة ٣ نوفمبر)، و«نعم» → الكرت النهائي → «نعم» → إعادة البناء.
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.fields)) if (["pax", "ages", "date", "nights", "days", "cities", "destination", "return_airport"].includes(k) && v !== null && String(v).trim() !== "") changed[k] = v;
    if (changed.destination && _isUmrahDest(String(facts.destination || "")) && _isOmanDest(String(changed.destination))) delete changed.destination;
    if (changed.return_airport && !["madinah", "jeddah"].includes(String(changed.return_airport))) delete changed.return_airport;
    if (changed.return_airport && (!_isUmrahReq || (changed.return_airport === "madinah") === _retMed)) delete changed.return_airport;
    // إضافة مدينة لبرنامج موجود → نحافظ على التوزيعة السابقة ونضيف المدينة الجديدة بالليالي المطلوبة (مو توزيعة جديدة من الصفر).
    if (!_isUmrahReq && changed.cities && String(idata.program_final_raw || "")) {
      const _pd = prevDistribution(String(idata.program_final_raw));
      const _added = String(changed.cities).split(/\s*(?:،|,|\s+و\s*)\s*/).filter(x => x && !_pd.some(p => p.city === x) && !String(idata.cities || "").includes(x));
      const _oldDays = parseInt(String(idata.days ?? ""), 10) || (_pd.reduce((a, b) => a + b.nights, 0) + 1);
      const _newDays = parseInt(String(changed.days ?? ""), 10) || 0;
      const _addN = _newDays > _oldDays ? _newDays - _oldDays : 0;
      if (_pd.length && _added.length === 1 && _addN > 0) {
        changed.distribution = [..._pd.map(p => `${p.nights} ${p.city}`), `${_addN} ${_added[0]}`].join(" - ");
      }
    }
    // تغيير التاريخ أثناء نقاش «ما فيه طيران من المدينة» = العميل يبي يوافق يوم فيه طيران → نُبقي طلب العودة من المدينة (والبوابة تفحص التاريخ الجديد).
    if ((changed.date || changed.nights) && _hadAlt && !_retMed && _isUmrahReq) changed.return_airport = "madinah";
    if (Object.keys(changed).length) { await _askModify(changed); return; }
  }
  if (action === "handoff" && _frustratedF && !(_cls ? _is("want_intl_flight", "booking_payment") : /حجز|احجز|أحجز|دفع|ادفع|أدفع|تحويل\s*بنكي|فاتور|خصم/.test(_batch))) {
    out = { message: "أعتذر منك أستاذي، بس فهمني إيش تقصد بالضبط عشان أصحّح لك البرنامج وأرسله على طول؟", action: "reply", fields: {} };
    action = "reply";
  }
  // 🚫 ٤ نوفمبر ٢٠٢٦ (قرار المالكة): التحويل للزميل **فقط** للطيران الدولي/الحجز/الدفع/الخصم — غير كذا طلال يتولاه.
  const _handoffTopic = _cls ? _is("want_intl_flight", "booking_payment") : new RegExp(`${FLIGHT_WORD}|حجز|احجز|أحجز|دفع|ادفع|أدفع|تحويل\\s*بنكي|فاتور|خصم|تخفيض|عربون`, "i").test(_batch);
  if (action === "handoff" && !_handoffTopic) {
    out = { message: "عفواً إذا سمحت، وضّح لي وش تحب نعدّل في البرنامج وأجهّزه لك على طول؟", action: "reply", fields: {} };
    action = "reply";
    await logGuard(supabase, from, "handoff_blocked", "not_allowed_topic", "", 1, text, "");
  }
  let reply = String(out.message || "").trim();
  // قرار المالكة ٣ نوفمبر: الاعتذار فقط لو العميل متضايق. عميل هادي (مثلاً «طيب عدلها» على اقتراح طلال) → بلا «أعتذر منك، بس سبق ووضحت».
  if (!_frustratedF && /^\s*(?:أعتذر|اعتذر|آسف|اسف)/.test(reply)) {
    reply = reply.replace(/^\s*(?:أعتذر|اعتذر)\s*منك(?:\s*أستاذي)?[،,]?\s*(?:بس\s*)?(?:أنا\s*)?(?:سبق\s*و\s*?وضحت\s*لك\s*(?:إن|ان)?\s*)?/, "").replace(/^\s*(?:آسف|اسف)[،,]?\s*/, "").trim();
    if (reply) reply = reply.charAt(0) + reply.slice(1);
  }
  { const _fz = /ما\s*(?:فهمت|أفهم|افهم)|وضح\s*لي/.test(reply) ? fuzzyDestination(_batch) : null;
    if (_fz && !extractDestination(_batch)) {
      reply = `عفواً إذا سمحت، تقصد ${_fz}؟`;
      try { await supabase.from("whatsapp_sessions").update({ intake_data: { ...idata, pending_dest_guess: _fz } }).eq("phone", from); } catch (_e) { /* */ }
    } }
  if (_frus && reply && !/^\s*(?:أعتذر|اعتذر|حاضر، أعتذر)/.test(reply)) reply = "أعتذر منك أستاذي، " + reply.replace(/^\s*(?:ما\s*فيه?\s*(?:في\s*البرنامج\s*)?خطأ[^.،]*[.،]\s*)/, "");
  const _wasApolA = /^\s*أعتذر منك أستاذي/.test(reply);
  try { reply = guardAutofix(reply, { alreadyGreeted: true, lastCustomer: text, lastTalal: msgs.filter(m => m.who === "طلال").slice(-1)[0]?.body || "" }).text; } catch (_e) { /* */ }
  if (_wasApolA && !/^أعتذر منك أستاذي/.test(reply)) reply = reply.replace(/^\s*أعتذر منك[،,]?\s*/, "أعتذر منك أستاذي، ");
  // «أعتذر منك أستاذي…» صيغة المالكة الحرفية → نرسلها بلا تنظيف «أستاذي».
  const _apologyRaw = /^أعتذر منك أستاذي/.test(reply);
  if (!(await _say(reply, "followup_ai", action, "", _apologyRaw))) return;   // رسالة أحدث وصلت → معالجها يرد على الكل
  if (action === "handoff") {
    try { await createProposalAndNotifyAdmin({ supabase, customerPhone: from, profileName, question: text }); } catch (e) { console.error("followup handoff", (e as Error).message); }
  }
}

async function handleMessage(args: {
  supabase: ReturnType<typeof createClient>;
  from: string;
  profileName: string;
  body: string;
  msgReceivedAt?: string;
  referral?: { body?: string; headline?: string; source_id?: string } | null;
}): Promise<void> {
  const { supabase, from, profileName, body, msgReceivedAt } = args;
  const _referral = args.referral || null;
  const text = body.trim();

  // 0) Staff guard + admin response interception. If this message comes
  //    from a registered staff phone (wa_staff or the legacy env lists),
  //    we either route it to the 4-state admin handler (if it's a valid
  //    admin action) or block it with the "use the dashboard" warning so
  //    it doesn't get treated as a customer message.
  const fromIsStaff = await isRegisteredStaff(supabase, from);
  if (fromIsStaff) {
    const proposal = await getOldestPendingProposal(supabase);
    if (proposal) {
      const isFreeTextState =
        proposal.status === "pending_correction" ||
        proposal.status === "pending_category_choice";
      if (isFreeTextState || isAffirmative(text) || isNegative(text) || isSkipSave(text)) {
        await handleAdminResponse({ supabase, proposal, text, adminFrom: from });
        return;
      }
    } else if (isAffirmative(text) || isNegative(text)) {
      await sendStaffNotice(from, "ما في طلب معلّق حالياً 👍");
      return;
    }
    // Staff sent free text that doesn't match any admin action. Block it
    // (do NOT treat as a customer inbound) and warn them to use the
    // dashboard instead.
    await sendWhatsapp(from, STAFF_WARNING_MESSAGE);
    return;
  }

  // 0.5) دمج الرسائل المتلاحقة (debounce) ─────────────────────────────────
  // العميل كثير يرسل رسالتين-ثلاث بسرعة («السلام عليكم» ثم «عندكم فيتنام شهر
  // عسل»). بدون دمج: كل رسالة تُعالَج على حدة، فيُبنى الرد على الأولى **قبل**
  // تسجيل الثانية → طلال يسأل «وين تسافرون» رغم ذكرها وجهتها بالرسالة التالية.
  // الحل: ننتظر قليلاً؛ لو وصلت رسالة أحدث نتوقّف ونترك معالجها يرد بالنص
  // الكامل — فيرد طلال مرة واحدة على الدفعة كلها (ويشوف الوجهة/شهر العسل/العدد).
  if (msgReceivedAt) {
    await new Promise((r) => setTimeout(r, 4500));
    const { data: _newer } = await supabase
      .from("wa_message_audit")
      .select("received_at")
      .eq("from_phone", from)
      .gt("received_at", msgReceivedAt)
      .limit(1);
    if (_newer && _newer.length) return; // رسالة أحدث وصلت → معالجها بيرد بالدفعة كاملة
  }

  // 1) اجلب أو أنشئ الجلسة. لازم يكون قبل التحقق من التحية عشان العميل
  //    الجديد ياخذ رسالة الترحيب (طلال من خدمة العملاء) قبل رد التحية.
  const { data: existing } = await supabase
    .from("whatsapp_sessions")
    .select("*")
    .eq("phone", from)
    .maybeSingle();

  const isNew = !existing;
  let session = existing as {
    phone: string; profile_name: string; stage: string;
    destination: string | null; persons: number | null; travel_date: string | null;
    hubspot_contact_id: string | null;
    ai_enabled?: boolean | null;
    assigned_staff_phone?: string | null;
    intake_active?: boolean | null;
  } | null;

  // AI master switch — per-conversation override wins over the global
  // setting. If AI is disabled for this conversation we just record the
  // session (so the dashboard can see it) and return without sending any
  // bot reply. Admin handles replies manually outside the bot.
  const aiOn = await isAiEnabledForSession(supabase, session);

  if (isNew) {
    const contactId = await upsertHubspotContact({ phone: from, name: profileName });
    const seed = {
      phone: from,
      profile_name: profileName,
      stage: "new",
      hubspot_contact_id: contactId,
      last_message_at: new Date().toISOString(),
      intake_active: true,   // عميل جديد → طلال يستقبله ويجمع المعلومات الأساسية
    };
    // upsert (لا insert) لتفادي سباق الرسائل السريعة من عميل جديد: لو وصلت رسالتان
    // متزامنتان كلاهما isNew، يضمن الـupsert ضبط intake_active=true بدل رمي خطأ.
    await supabase.from("whatsapp_sessions").upsert(seed, { onConflict: "phone", ignoreDuplicates: true });
    session = { ...seed, destination: null, persons: null, travel_date: null, ai_enabled: null, assigned_staff_phone: null } as typeof session;
  }

  // Destination detection + auto-routing. Runs regardless of AI state —
  // even if the bot is muted, staff still want the assignment so the
  // right person picks up the conversation.
  // 🕋 عميل عمرة يذكر نقاط سعودية (جدة/المدينة/مكة/مطار/طيران) = يتكلم عن رحلته، مو وجهة جديدة.
  const _rawDetDest = extractDestination(text);
  //    وعُمان/مسقط/صلالة لعميل عمرة = مكان الإقلاع دائماً، مو وجهة (حادثة ٣ نوفمبر: «من مسقط» → «تغير الوجهة إلى عمان؟»).
  const _sessUmrah = _isUmrahDest(String(session?.destination || ""));
  // 🔴 قاعدة المالكة الصارمة (٣ نوفمبر ٢٠٢٦): رقم عُماني + عنده وجهة → عُمان/مسقط/صلالة **أبداً** ما تكون تبديل وجهة.
  const _omaniPhone = /^whatsapp:\+?968/.test(String(from));
  const detectedDest = (_rawDetDest && _omaniPhone && _isOmanDest(_rawDetDest) && String(session?.destination || "").trim()) ? null
    : (_rawDetDest && !_isUmrahDest(_rawDetDest) && _sessUmrah
    && (_isOmanDest(_rawDetDest) || /جد[ةه]|المدين[ةه]|مك[ةه]|مطار|طيران|العود[ةه]|الرجوع|الحرم|القدوم|الذهاب/.test(text))) ? null : _rawDetDest;
  const hadDest = session?.destination ?? null;   // الوجهة قبل هذه الرسالة (لكشف «وجهة جديدة»)
  if (detectedDest && !session?.destination) {
    await supabase.from("whatsapp_sessions").update({ destination: detectedDest }).eq("phone", from);
    if (session) session.destination = detectedDest;
  }
  if (!session?.assigned_staff_phone && (detectedDest || session?.destination)) {
    const newlyAssigned = await maybeAutoAssign({
      supabase, from,
      customerName: session?.profile_name || profileName,
      destination: detectedDest || session?.destination || null,
      alreadyAssigned: session?.assigned_staff_phone,
    });
    if (newlyAssigned && session) session.assigned_staff_phone = newlyAssigned;
  }

  if (!aiOn) {
    // AI silent for this conversation. Just touch last_message_at so the
    // session shows recent activity in the dashboard.
    await supabase
      .from("whatsapp_sessions")
      .update({ last_message_at: new Date().toISOString() })
      .eq("phone", from);
    return;
  }

  // 👨‍👩‍👧 ٤ نوفمبر ٢٠٢٦: «في عندي عيله ثانيه تبي تروح تايلند» = **طلب جديد مستقل** (مو تبديل وجهة) — كان يخلط
  //    بيانات العمرة (٥ أشخاص) بطلب تايلاند ويرفض الأسئلة ٣ مرات ثم «أرد عليك بأقرب وقت». الحين: طلب جديد نظيف.
  {
    const _sid = ((session as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
    const _sepReq = /عيل[ةه]\s*ثاني|عائل[ةه]\s*ثاني|ناس\s*ثاني|ربع\s*ثاني|(?:طلب|حجز|برنامج|رحل[ةه])\s*(?:ثاني|ثانية|جديد|آخر|اخر|ثاني[ةه])\s*(?:ل|غير|لناس|لعيل)|لشخص\s*ثاني|لأهلي|لاهلي|لربعي|لأخوي|لاخوي|لأختي|لاختي|لصديق|غير\s*هذا\s*الطلب|مو\s*(?:بدل|تغيير)/.test(text);
    // 🆕 ٤ نوفمبر ٢٠٢٦ (حي): «احتاج برنامج عمره ثاني» → «تقصد تغير الوجهة…؟» → «لا مش حغير / طلب ثاني هذا» = طلب **مستقل**
    //    (كان يبقى على تايلاند ثم يخلط: ٦ أشخاص + توزيعة تايلاند + حارس «العدد معروف» ٣ مرات).
    const _noChangeSep = _sid.asked_dest_change === true && !!String(_sid.pending_dest || "").trim()
      && /(?:^|\s)(?:لا|لأ|مش|مو|ما|مب)\s*(?:\S+\s*)?(?:ح|ب|ن)?[اأ]?غيّ?ر|مو\s*تغيير|(?:طلب|برنامج|حجز)\s*(?:ثاني|ثانية|جديد|آخر|اخر|ثاني[ةه])|غير\s*هذا|بالإضاف[ةه]|زياد[ةه]\s*على/.test(text);
    const _sepReq2 = _sepReq || _noChangeSep || /(?:طلب|برنامج)\s*(?:ثاني|جديد|آخر|اخر)\s*(?:هذا|هذي)?\s*$/.test(text);
    const _guessYes = !!String(_sid.pending_dest_guess || "") && isYesish(text);
    const _newD = detectedDest || (_guessYes ? String(_sid.pending_dest_guess) : "") || (_sepReq2 ? String(_sid.pending_dest || "") : "");
    if (_sepReq2 && _newD && _newD !== String(_sid.destination || "")) {
      const _prevReq = { destination: _sid.destination, pax: _sid.pax, date: _sid.date, nights: _sid.nights, days: _sid.days, program_code: _sid.program_final_code, at: new Date().toISOString() };
      const _hist = Array.isArray(_sid.prev_requests) ? (_sid.prev_requests as unknown[]) : [];
      await supabase.from("whatsapp_sessions").update({ intake_active: true, stage: "new", destination: _newD,
        intake_data: { destination: _newD, started_at: new Date(Date.now() - 60_000).toISOString(), last_seen_in_ts: new Date().toISOString(), prev_requests: [..._hist, _prevReq].slice(-5) } }).eq("phone", from);
      await logGuard(supabase, from, "separate_request", "fresh_intake", `${String(_sid.destination || "")} → ${_newD}`, 1, text, "");
      // قرار المالكة: محادثة قائمة + طلب جديد بلا تفاصيل بالرسالة → «أكيد طبعا، اتفضل، إيش هو طلبك؟» (مو «أبشر، عندنا برامج…» من جديد).
      if (!detectedDest && !/\d|[٠-٩]|شخص|اشخاص|أشخاص|نفر|كبار|بالغ|اطفال|أطفال|ليال|ليالي|يوم|ايام|أيام|شهر/.test(text)) {
        await sendCustomerReply(supabase, from, "أكيد طبعا، اتفضل، إيش هو طلبك؟");
        try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: "أكيد طبعا، اتفضل، إيش هو طلبك؟", sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
        return;
      }
      await handleNewLeadIntake({ supabase, from, body: text, referral: _referral });
      return;
    }
    if (_guessYes && s0IntakeInactive(session)) {
      // «ايوه» على «تقصد تايلاند؟» → نكمل كأنه ذكر الوجهة (مسار الوجهة الجديدة/التأكيد المعتاد تحت).
      (session as { intake_data?: Record<string, unknown> }).intake_data = { ..._sid, pending_dest_guess: "" };
    }
  }

  // ── استقبال طلال للعملاء الجدد فقط ──────────────────────────────────────
  // المحادثات الجديدة (intake_active=true، تُضبط عند أول تواصل): طلال يرحّب
  // ويجمع المعلومات الأساسية (وجهة/عدد/تاريخ/أعمار/مدينة الوصول والمغادرة)
  // تلقائياً — حتى في وضع PREVIEW (العميل الجديد يحتاج رداً فورياً). أما
  // العملاء الحاليون (intake_active فارغ) فيكملون على التدفّق المعتاد (يدوي).
  // شبكة أمان: لو لأي سبب ما تُضبط intake_active (سباق رسائل سريعة، أو جلسة أنشأها
  // مسار وسائط قديم)، فأي جلسة جديدة (stage=new) لم نردّ عليها قط ولم يُكمَّل
  // استقبالها = عميل جديد → يستقبله طلال. (intake_active===false = اكتمل، نتجاوزه.)
  const s = session as ({ intake_active?: boolean | null; stage?: string; last_outbound_at?: string | null; last_outbound_body?: string | null } | null);
  const isFreshLead = s?.intake_active === true
    || (s != null && s.intake_active == null && s.stage === "new" && !s.last_outbound_at && !s.last_outbound_body);
  if (isFreshLead) {
    // 🟢 تحية بداية محادثة (طلب المالكة ٢ نوفمبر ٢٠٢٦): «مرحبا» وحدها والطلب فاضي (لا وجهة
    //    ولا عدد ولا إعلان) → «أهلاً وسهلاً، حياك الله، آمرني» ثابتة؛ بدل ما يقفز النموذج
    //    لسؤال العدد أو يخترع وجهة من سجل قديم.
    const _fd = ((session as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
    if (isGreeting(text) && !_referral && !String(_fd.destination || "").trim() && !(Number(_fd.pax) > 0)) {
      const _greet = "أهلاً وسهلاً، حياك الله، آمرني";
      await sendCustomerReply(supabase, from, _greet);
      try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(_greet), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
      await supabase.from("whatsapp_sessions").update({ last_message_at: new Date().toISOString() }).eq("phone", from);
      await logGuard(supabase, from, "greeting_reply", "fresh_lead", "", 1, text, _greet);
      return;
    }
    await handleNewLeadIntake({ supabase, from, body: text, referral: _referral });
    return;
  }

  // ── بعد الرد على التحية (awaiting_intent): الرسالة التالية تحدد هل هو طلب جديد أو متابعة.
  //    طلب جديد (ذكر وجهة، أو عدد مسافرين، أو قال «طلب/حجز جديد») → نفتح الاستقبال من جديد
  //    (حتى لو نفس الوجهة السابقة، مثل عمرة ثانية) ويجمع طلال المعلومات. غير ذلك = متابعة
  //    على طلب قديم → يكمل على المسار المعتاد (الموظفة). طلب المالكة ١ نوفمبر ٢٠٢٦.
  {
    const _idata = ((session as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
    if (s?.intake_active !== true && _idata.awaiting_intent === true) {
      const _isNewReq = !!detectedDest
        || /(?:طلب|حجز|برنامج|رحل[ةه]|عرض)\s*(?:جديد|ثاني|ثاني[ةه]|آخر|اخر)/.test(text)
        || /(?:[0-9٠-٩]+\s*(?:أشخاص|اشخاص|شخص|نفر|أفراد|افراد|معتمر(?:ين)?|بالغ(?:ين)?))|شخصين|نفرين|معتمرين/.test(text);
      const { awaiting_intent: _drop, ...rest } = _idata;
      if (_isNewReq) {
        // started_at: الطلب الجديد يبدأ من لحظة التحية — طلال ما يقرأ عدد/أعمار الطلب القديم
        //   (حادثة ٢ نوفمبر: طلب جديد فسأل «الـ4 كلهم بالغين؟» من رسائل الطلب السابق).
        const _st = String(_idata.awaiting_intent_at || "") || new Date(Date.now() - 60_000).toISOString();
        const _seed: Record<string, unknown> = { ...(detectedDest ? { destination: detectedDest } : {}), started_at: _st };
        await supabase.from("whatsapp_sessions")
          .update({ intake_active: true, intake_data: _seed, stage: "new", ...(detectedDest ? { destination: detectedDest } : {}) })
          .eq("phone", from);
        await logGuard(supabase, from, "greeting_new_request", "reopen_intake", "", 1, text, "");
        await handleNewLeadIntake({ supabase, from, body: text, referral: _referral });
        return;
      }
      await supabase.from("whatsapp_sessions").update({ intake_data: rest }).eq("phone", from);
      if (session) (session as { intake_data?: Record<string, unknown> }).intake_data = rest;
    }
  }

  // عميل قديم (سبق رددنا عليه أو اكتمل استقباله) عاد بطلب **وجهة جديدة** (مختلفة عن
  // وجهته السابقة) → نعيد تفعيل طلال لجمع معلومات الرحلة الجديدة.
  // ❌ بلا ترحيب أو تعريف من جديد («سعدنا بعودتك / معك طلال») مهما طالت المدة —
  //    العميل يعرفنا، فلا نمرّر returning (وبوجود ردود سابقة يعتبره طلال «منتصف
  //    محادثة» فلا يعرّف بنفسه). نبذر الوجهة المكتشفة في intake_data حتى لا يعيد
  //    سؤالها، ونمسح بقية تفاصيل الرحلة القديمة فقط (العدد/التاريخ/الأعمار/المدن).
  if (s?.intake_active !== true && detectedDest && detectedDest !== hadDest) {
    // 🔴 تأكيد تبديل الوجهة قبل إعادة البناء (طلب المالكة ١ نوفمبر ٢٠٢٦): العميل على
    //    برنامج مُقفَل وذكر وجهة جديدة مختلفة → ❌ لا نبدّل بصمت ونرسل الملخّص؛ نسأله
    //    «تقصد من X إلى Y؟» ونطبّق فقط بعد تأكيده (الرد «نعم» يعالجه حارس الاستقبال).
    const _idata = ((session as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
    const _oldDest = String(_idata.destination || hadDest || "").trim();
    const _reConfirmed = _idata.asked_dest_change === true && String(_idata.pending_dest || "").trim() === detectedDest;
    // 🕋 ٤ نوفمبر ٢٠٢٦ (حي): «احتاج برامج مكه» وطلبه السابق عمرة → «تقصد تبي تغير الوجهة من العمرة إلى العمرة؟» (عمود الوجهة كان قديم).
    //    نفس الوجهة (أو عمرة↔مكة) = طلب جديد لنفس الوجهة، مو تبديل → طلب نظيف + «أكيد طبعا، اتفضل، إيش هو طلبك؟».
    if (_oldDest && (_oldDest === detectedDest || (_isUmrahDest(_oldDest) && _isUmrahDest(detectedDest)))) {
      const _prevReq = { destination: _idata.destination, pax: _idata.pax, date: _idata.date, nights: _idata.nights, days: _idata.days, program_code: _idata.program_final_code, at: new Date().toISOString() };
      const _hist = Array.isArray(_idata.prev_requests) ? (_idata.prev_requests as unknown[]) : [];
      await supabase.from("whatsapp_sessions").update({ intake_active: true, stage: "new", destination: _oldDest,
        intake_data: { destination: _oldDest, started_at: new Date(Date.now() - 60_000).toISOString(), last_seen_in_ts: new Date().toISOString(), prev_requests: _idata.program_final_code ? [..._hist, _prevReq].slice(-5) : _hist } }).eq("phone", from);
      await logGuard(supabase, from, "same_dest_new_request", "fresh_intake", `${_oldDest} ← ${detectedDest}`, 1, text, "");
      const _hasDetails = /\d|[٠-٩]|شخص|اشخاص|أشخاص|نفر|كبار|بالغ|اطفال|أطفال|ليال|ليالي|يوم|ايام|أيام|شهر/.test(text);
      if (_hasDetails) { await handleNewLeadIntake({ supabase, from, body: text }); return; }
      await sendCustomerReply(supabase, from, "أكيد طبعا، اتفضل، إيش هو طلبك؟");
      try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: "أكيد طبعا، اتفضل، إيش هو طلبك؟", sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
      return;
    }
    if (_oldDest && !_reConfirmed) {
      _idata.asked_dest_change = true; _idata.pending_dest = detectedDest;
      _idata.summary_confirmed = false; _idata.awaiting_confirm = false;
      await supabase.from("whatsapp_sessions").update({ intake_active: true, intake_data: _idata }).eq("phone", from);
      const _q = `تمام 🌟 تقصد تبي تغيّر الوجهة من ${_oldDest} إلى ${detectedDest}؟`;
      await sendCustomerReply(supabase, from, _q);
      try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(_q), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
      return;
    }
    // لا وجهة قديمة، أو العميل أعاد ذكر نفس الوجهة المعلّقة (تأكيد) → طبّق وأعد التفعيل.
    await supabase.from("whatsapp_sessions")
      .update({ intake_active: true, intake_data: { destination: detectedDest, started_at: new Date(Date.now() - 60_000).toISOString() }, destination: detectedDest })
      .eq("phone", from);
    await handleNewLeadIntake({ supabase, from, body: text, referral: _referral });
    return;
  }

  // ── حارس استفسار الإفطار (خادميّ — طلب المالكة ١ نوفمبر ٢٠٢٦) ──────────────
  // لو سأل العميل عن الإفطار **بعد استلام برنامجه**: ❌ ممنوع الصمت، ولا التخمين،
  // ولا تعميم «البرنامج بدون إفطار» بسبب فندق واحد. نراجع فنادق برنامجه الفعلية من
  // **بيانات الفنادق الأصلية** (جدول hotels الحالي، لا نص البرنامج الذي قد يكون
  // قديماً) ونرد رداً دقيقاً ونرسله **مباشرةً حتى في PREVIEW** (لا نتركه معلّقاً):
  //   • كلها إفطار → اعتذار + «يشمل الإفطار في جميع الفنادق».
  //   • فندق واحد بلا → نسمّيه ونؤكّد الباقي يشمل الإفطار.  • بعضها → نسمّيها.
  {
    const _idata = (session as { intake_data?: Record<string, unknown> } | null)?.intake_data || {};
    const _prog = String(_idata.auto_program || "");
    const _asksBreakfast = /إفطار|افطار|فطور|بريك\s*فاست|breakfast|الوجب[ةه]|وجبات|بدون\s*(?:اكل|أكل|فطور|افطار)/i.test(text);
    if (_prog.trim() && _asksBreakfast) {
      try {
        // استخراج أسماء الفنادق من البرنامج (السطر التالي لكل «🏨 <مدينة>»).
        const _lines = _prog.split("\n");
        const _names: string[] = [];
        for (let i = 0; i < _lines.length; i++) {
          if (/^\s*🏨/.test(_lines[i])) {
            for (let j = i + 1; j < _lines.length && j < i + 4; j++) {
              const _l = _lines[j].trim();
              if (!_l) continue;
              if (/^(🍽|🔗|🏨|━|📍|✈|💰)/.test(_l)) break;
              _names.push(_l); break;
            }
          }
        }
        let _reply = "";
        if (_names.length === 0) {
          _reply = "أعتذر على اللبس 🌹 خليني أتأكد من تفاصيل الإفطار في برنامجك وأوافيك بدقة قريباً.";
        } else {
          const { data: _hrows } = await supabase.from("hotels")
            .select("name, includes_breakfast").in("name", _names);
          const _bf = new Map<string, boolean>();
          for (const h of (_hrows || []) as Array<{ name: string; includes_breakfast: boolean }>) {
            const _n = String(h.name || "").trim();
            _bf.set(_n, (_bf.get(_n) || false) || !!h.includes_breakfast);
          }
          const _matched = _names.filter(n => _bf.has(n.trim()));
          if (_matched.length === 0) {
            _reply = "أعتذر على اللبس 🌹 خليني أتأكد من تفاصيل الإفطار في برنامجك وأوافيك بدقة قريباً.";
          } else {
            const _noBf = _matched.filter(n => !_bf.get(n.trim()));
            if (_noBf.length === 0)
              _reply = "نعتذر لك عن اللبس في توضيح تفاصيل البرنامج 🌹 البرنامج يشمل وجبة الإفطار في جميع الفنادق.";
            else if (_noBf.length === _matched.length)
              _reply = "أعتذر على اللبس 🌹 فنادق هذا البرنامج بدون إفطار. إذا تحب نرتّب لك خياراً يشمل الإفطار بلّغني.";
            else if (_noBf.length === 1)
              _reply = `نعتذر عن اللبس 🌹 فندق «${_noBf[0]}» فقط بدون إفطار، وبقية الفنادق في البرنامج تشمل وجبة الإفطار.`;
            else
              _reply = `نعتذر عن اللبس 🌹 الفنادق التالية بدون إفطار: ${_noBf.join("، ")}. وبقية الفنادق تشمل وجبة الإفطار.`;
          }
        }
        await sendCustomerReply(supabase, from, _reply);
        try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(_reply), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
        await supabase.from("whatsapp_sessions").update({ last_message_at: new Date().toISOString() }).eq("phone", from);
        return;
      } catch (_e) { /* فشل → نكمل للمسار العادي (معاينة) */ }
    }
  }

  // PREVIEW MODE: suppress ALL automatic replies (welcome, presence,
  // greeting, personal greeting, FAQ). Every customer message becomes
  // an admin notification — admin approves what (if anything) to send.
  // Side effect: customers in preview mode get NO acknowledgment until
  // admin acts, by design.
  const aiMode = await getAiMode(supabase);
  if (aiMode === "PREVIEW") {
    await supabase
      .from("whatsapp_sessions")
      .update({ last_message_at: new Date().toISOString() })
      .eq("phone", from);
    // 🟢 حارس «لا صمت على التحية» (طلب المالكة ١ نوفمبر ٢٠٢٦): التحية وحدها («مرحبا/السلام
    //    عليكم/هلا») كانت تُصنَّف كلاماً عابراً فلا رد ولا اقتراح للموظفة = صمت تام. الآن طلال
    //    يرد مباشرة، والرسالة التالية تحدد طلب جديد أو متابعة (awaiting_intent أعلاه).
    if (isGreeting(text)) {
      const _greet = "أهلاً وسهلاً، حياك الله، آمرني";   // صيغة تناسب الكل (قرار المالكة)
      await sendCustomerReply(supabase, from, _greet);
      try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: stripBannedPhrases(_greet), sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* */ }
      const _id0 = ((session as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
      await supabase.from("whatsapp_sessions").update({ intake_data: { ..._id0, awaiting_intent: true, awaiting_intent_at: new Date().toISOString() } }).eq("phone", from);
      await logGuard(supabase, from, "greeting_reply", "direct_reply", "", 1, text, _greet);
      return;
    }
    // 🧪 رقم المالكة (تشغيل كامل): متابعة بعد إقفال الطلب → رد طلال بالذكاء ملتزماً بالمخزّن.
    if (s?.intake_active !== true && await isFullAiNumber(supabase, from)) {
      await handleFollowupAI({ supabase, from, profileName, body: text });
      await supabase.from("whatsapp_sessions").update({ last_message_at: new Date().toISOString() }).eq("phone", from);
      return;
    }
    // Skip if a proposal is already pending for this customer (avoid
    // spamming the admin with duplicates while they're deciding).
    const { data: pending } = await supabase
      .from("whatsapp_admin_proposals")
      .select("id")
      .eq("customer_phone", from)
      .in("status", [
        "pending_reply_approval", "pending_correction",
        "pending_sheet_approval", "pending_category_choice",
      ])
      .limit(1)
      .maybeSingle();
    if (!pending && !isSmallTalk(text)) {
      await createProposalAndNotifyAdmin({
        supabase, customerPhone: from, profileName, question: text,
      });
    }
    return;
  }

  if (isNew && !isPresenceCheck(text)) {
    // رسالة ترحيب — تُرسل مرّة واحدة لكل عميل جديد. لكن لو الرسالة الأولى
    // سؤال عن وجود الموظف ("في أحد؟") فالـ welcome يتعارض مع رد CASE 2
    // ("ما أنا معاك"). نتخطى الترحيب في هذي الحالة.
    await sendCustomerReply(supabase, from,
      "حياك الله … معك طلال من خدمة العملاء كيف اقدر اخدمك",
    );
  }

  // 1b) Presence check ("في أحد؟" / "معي أحد؟" / "معي طلال؟"). Replies before
  //     FAQ lookup with one of two fixed messages based on AUTOREPLY_ENABLED.
  //     Default = ON → "أيوه أستاذي، معاك". Set the secret to "false" to
  //     switch the bot to CASE 2 mode ("ما أنا معاك الحين"). The reply NEVER
  //     claims a specific human name.
  if (isPresenceCheck(text)) {
    const autoreplyOn =
      (Deno.env.get("AUTOREPLY_ENABLED") || "true").toLowerCase() !== "false";
    const reply = autoreplyOn
      ? "أيوه أستاذي، معاك 😊 كيف أقدر أخدمك؟"
      : "أستاذي، ما أنا معاك الحين، بس دقائق وأكون معك 🙏";
    await sendCustomerReply(supabase, from, reply);
    if (!isNew) {
      await supabase
        .from("whatsapp_sessions")
        .update({ last_message_at: new Date().toISOString() })
        .eq("phone", from);
    }
    return;
  }

  // 1c) Personal greetings ("هلا طلال" / "كيف حالك طلال" / "صباح الخير طلال").
  //     Each matched variant has its own specific Khaleeji reply from
  //     PERSONAL_GREETING_REPLIES. Sent verbatim — no AI involvement. Runs
  //     before the generic isGreeting() check so "هلا طلال" doesn't fall
  //     through and end up answered with the canonical RULE 1 reply.
  const personalReply = getPersonalGreetingReply(text);
  if (personalReply !== null) {
    await sendCustomerReply(supabase, from, personalReply);
    if (!isNew) {
      await supabase
        .from("whatsapp_sessions")
        .update({ last_message_at: new Date().toISOString() })
        .eq("phone", from);
    }
    return;
  }

  // 1d) Generic greetings short-circuit BEFORE the rest of the routing.
  //     Under the strict FAQ-or-admin flow the Travel Agent is disabled, so
  //     this hardcoded reply is the only path that answers bare
  //     "مرحبا / هلا / ...". On a brand-new session the welcome (just sent
  //     above) comes first, then this greeting reply. On existing sessions
  //     only this reply fires. Skips classify and FAQ/admin escalation.
  if (isGreeting(text)) {
    await sendCustomerReply(supabase, from, "هلا 👋 أمرني كيف أقدر أخدمك؟");
    return;
  }

  // 2) برنامج جاهز ينتظر مراجعة الموظف — رد ودود ثابت بدون استدعاء أي AI.
  //    الموظف هو اللي بيرسل البرنامج لما يجهز.
  if (session && session.stage === "pending_review") {
    await sendCustomerReply(supabase, from, "سيتم إرسال برنامجك قريباً إن شاء الله 🌍 نعتذر عن الانتظار");
    await supabase
      .from("whatsapp_sessions")
      .update({ last_message_at: new Date().toISOString() })
      .eq("phone", from);
    return;
  }

  // 3) Complaints route to the dedicated escalation handler (HubSpot ticket
  //    + complaints staff alert). Same as before — complaints are explicitly
  //    flagged, not "AI-generated answers", so they stay enabled.
  const { category } = await classify(text);
  if (category === "complaint") {
    await handleComplaint({ supabase, session, from, profileName, text });
    // Touch last_message_at so the complaint conversation appears in
    // the dashboard's recent-activity window — handleComplaint creates
    // a wa_complaints row but doesn't update the session, and the
    // function returns here before the bottom-of-flow update fires.
    await supabase
      .from("whatsapp_sessions")
      .update({ last_message_at: new Date().toISOString() })
      .eq("phone", from);
    return;
  }

  // 4) STRICT FAQ-OR-ADMIN FLOW.
  //    The bot is FORBIDDEN from generating any customer-facing reply on its
  //    own. Every reply must come from one of:
  //      (a) chat_answers (FAQ row matched by keywords) — sent verbatim
  //      (b) admin reply after explicit approval via the 4-state machine
  //      (c) fixed system strings (welcome, pending_review holding)
  //    All previous AI-driven paths (Travel Agent, Tourism-AI clarifications,
  //    package-flow info gathering) are disabled at this layer — the agent
  //    functions still exist in the file but are never invoked.
  // Pending check FIRST: any message (even "؟" or a bare ack) sent while
  // the customer's previous question is still being worked on by admin
  // counts as them wondering / pushing. Reply with the patience phrase
  // and skip FAQ / new-proposal entirely. Per admin policy: customers
  // shouldn't get spammed with a "حاضر" on every question — only when
  // they themselves signal they're waiting.
  const { data: pending } = await supabase
    .from("whatsapp_admin_proposals")
    .select("id")
    .eq("customer_phone", from)
    .in("status", [
      "pending_reply_approval",
      "pending_correction",
      "pending_sheet_approval",
      "pending_category_choice",
    ])
    .limit(1)
    .maybeSingle();
  if (pending) {
    // بين 1 ليلاً و9 صباحاً بتوقيت عُمان: لا نوحي بردّ خلال دقائق (لا موظفين).
    await sendCustomerReply(supabase, from,
      isOmanQuietHours() ? OMAN_OFF_HOURS_MSG : "لحظات استاذي واكون معك");
  } else {
    // No pending — normal flow.
    //   ON mode      → FAQ match auto-sent; no match → silent escalation.
    //   PREVIEW mode → NEVER auto-send. Even a FAQ match goes through the
    //                  admin approval step so admin can verify the
    //                  classifier picked the right answer + stage.
    const aiMode = await getAiMode(supabase);
    const answer = await findFaqAnswer(supabase, text,
      (session as { customer_stage?: string | null } | null)?.customer_stage || null);
    if (aiMode === "PREVIEW") {
      // Always escalate in preview, unless small-talk (which we ignore
      // silently as before).
      if (!isSmallTalk(text)) {
        await createProposalAndNotifyAdmin({
          supabase,
          customerPhone: from,
          profileName,
          question: text,
        });
      }
    } else if (answer) {
      await sendCustomerReply(supabase, from, answer);
    } else if (!isSmallTalk(text)) {
      await createProposalAndNotifyAdmin({
        supabase,
        customerPhone: from,
        profileName,
        question: text,
      });
    }
    // small-talk + no pending: stay silent.
  }

  await supabase
    .from("whatsapp_sessions")
    .update({ last_message_at: new Date().toISOString() })
    .eq("phone", from);
}

async function handleComplaint(args: {
  supabase: ReturnType<typeof createClient>;
  session: { hubspot_contact_id: string | null } | null;
  from: string;
  profileName: string;
  text: string;
}): Promise<void> {
  const { supabase, session, from, profileName, text } = args;
  const subject = `شكوى من ${profileName || from}`;
  await createHubspotTicket({
    contactId: session?.hubspot_contact_id ?? null,
    subject,
    body: text,
    phone: from,
  });

  // Track in wa_complaints for the monitor dashboard. Keyword-classified
  // complaints land here at severity='normal' by default; admin/monitor
  // can escalate to medium/urgent.
  const { data: sessionRow } = await supabase
    .from("whatsapp_sessions").select("assigned_staff_phone")
    .eq("phone", from).maybeSingle();
  const assignedToStaff = (sessionRow as { assigned_staff_phone?: string | null } | null)?.assigned_staff_phone;
  await supabase.from("wa_complaints").insert({
    customer_phone: from,
    customer_name: profileName,
    severity: "normal",
    description: text.slice(0, 1000),
    assigned_staff_phone: assignedToStaff || null,
    source: "keyword",
  });

  // تنبيه موظفي الشكاوى
  const staff = staffList("COMPLAINTS_WHATSAPP_NUMBERS");
  const notice = `⚠️ شكوى جديدة\nمن: ${profileName} (${from.replace(/^whatsapp:/, "")})\nالرسالة:\n${text}`;
  await Promise.all(staff.map(num => sendStaffNotice(num, notice)));

  await sendWhatsapp(
    from,
    "تم استلام شكواك، وسيتواصل معك مسؤول خدمة العملاء في أقرب وقت. نعتذر عن أي إزعاج 🌹",
  );
  await supabase
    .from("whatsapp_sessions")
    .update({ stage: "done", last_message_at: new Date().toISOString() })
    .eq("phone", from);
}

// ── AI Travel Sales Agent ────────────────────────────────────────────────
// Replaces regex extractors with a Claude-driven agent that handles
// destination + dates + passengers + budget + duration extraction AND
// composes warm Gulf-Arabic replies in one go. Returns JSON with both the
// extracted data and the next customer message.
const TRAVEL_AGENT_PROMPT = `You are an AI Travel Sales Agent for a travel agency.
Your goal: Convert conversations into qualified travel leads and generate structured data + a customer reply.
You must behave like a senior travel sales consultant, not a chatbot.

TODAY DATE: {{TODAY}}

OUTPUT FORMAT: Return VALID JSON ONLY:
{"data": {}, "intent": "", "action": "", "message": "", "lead_score": 0-100, "lead_type": "hot|warm|cold", "confidence": 0-1}

EXTRACT DATA: destination, travel_dates, passengers, trip_duration_days, budget, notes

INTENTS: request_quote | book_now | visa_inquiry | compare | support | unknown | warm_lead

CORE SALES RULES:
1. ONE QUESTION ONLY per message
2. NEVER repeat questions already answered
3. DESTINATION FIRST - if missing ask only for destination
4. NO EARLY BOOKING - need destination+dates+passengers (AND child ages if any children mentioned — see CHILD AGE RULE)
5. UNCLEAR REQUEST - suggest Turkey, Vietnam, Thailand, Georgia

GREETING RULE (RULE 1) — overrides all other greeting/opener logic:
For ANY opening message (مرحبا / هلا / أهلا / أهلاً / السلام عليكم / لو سمحت / أخوي / أقولك / any general opening without a clear request):
Respond ONLY with the EXACT text:
"هلا 👋 أمرني كيف أقدر أخدمك؟"
- No variations
- No extra text before or after
- No follow-up question
- No context or memory activation
- Wins over the random openers in GULF FRIENDLY TONE RULE for greeting messages only

PACKAGE STATUS RULE (RULE 2):
NEVER say "نحن نعمل على برنامجك" or any similar in-progress phrase unless ALL THREE are confirmed:
- Travel date ✅
- Number of passengers ✅
- Destination ✅

MISSING INFO RULE (RULE 3):
If the client asks about their package status (وش صار / جاهز البرنامج / وين الطلب) and ANY of (destination / passengers / travel date) is still missing, reply EXACTLY:
"والله عذراً، ما قدرت أجهز البرنامج بعد. أحتاج منك تاريخ السفر وعدد المسافرين عشان نكمل 🙏"

LANGUAGE RULE (RULE 4):
ALL replies MUST be in Khaleeji Arabic dialect only. No فصحى / formal Arabic.

STATE HANDLING:
A) GREETING → apply RULE 1
B) STATUS QUESTION → if any of (destination/passengers/date) missing → apply RULE 3; otherwise short status update, no questions
C) NEW REQUEST: focus on new request only

LEAD SCORING: +30 destination, +20 dates, +20 passengers, +10 budget, +20 urgency
0-40=cold, 41-70=warm, 71-100=hot

DATE RULES: Convert all to YYYY-MM-DD. Understand: "15 مايو","15/5","next week","بعد أسبوع","after Eid". If unclear: null + flexible=true

DESTINATION NORMALIZATION: فيتنام→Vietnam, تركيا→Turkey, تايلند→Thailand, جورجيا→Georgia

PASSENGER RULES: "أنا وزوجتي"=2 adults, "عائلة"=2 adults+unknown children

CHILD AGE RULE — MANDATORY when any child is mentioned:
If the customer mentions ANY child/children in their passenger count (طفل / طفلة / أطفال / طفلين / ولد / بنت / أولاد / عيال / رضيع / صغير), you MUST ask for the age(s) BEFORE asking any other question. This overrides the natural next question in the flow.

Triggers and required next reply:
- "احنا 2 شخص وطفل"        → next reply: "كم عمر الطفل؟"
- "3 اكبار وطفل"             → next reply: "كم عمر الطفل؟"
- "أنا وزوجتي وطفلين"        → next reply: "كم أعمار الأطفال؟"
- "عائلة 4 معانا 3 عيال"    → next reply: "كم أعمار العيال؟"
- "أنا وزوجتي ومعنا رضيع"   → next reply: "كم عمر الرضيع؟"

Age brackets (apply when classifying):
- 0–2 years   → passengers.infants
- 2–12 years  → passengers.children
- 12+ years   → passengers.adults

NEVER set action=send_offer while children are mentioned but ages are still null. Lead is not ready without the ages.

Why: hotel/flight pricing depends on age (infant 0-2, child 2-12, adult 12+). Without ages we cannot price correctly.

SUPPORT RULE: For general questions use ALEZZ Chat knowledge base. action=support. Do NOT continue booking flow.

ADMIN CORRECTION FLOW:
Step 1: Send to admin: question + interpretation + suggested answer + ask "هل هذا الفهم صحيح؟ نعم/لا"
Step 2A: Admin says YES → send to customer immediately. STOP.
Step 2B: Admin says NO → ask "تمام 👌 كيف تبين الرد يكون على العميل؟ اكتب الصيغة مباشرة" → wait → send admin answer directly → go to Step 3
Step 3: Say "تم الرد على العميل 👍" then ask "هل تريد حفظ هذا الرد في Excel؟" + show category
Step 4: If تم → save. If لا → ask preferred category.

CATEGORY AUTHORITY RULE:
- AI recommends category ONCE only
- If admin rejects, explain briefly ONCE only
- If admin rejects again → "تم 👍 سيتم الحفظ حسب تعليماتك" and execute
- Admin decision is FINAL

GULF FRIENDLY TONE RULE:
ALLOWED openers (use randomly, no punctuation) — pick ONLY from this list:
هلا والله / أهلين / حياك / بكل سرور / يا هلا / ابشر / أمرني / حالاً
QUESTION STYLE: "أبشر 👌 وين حابين تسافرون؟"
PROHIBITED openers (NEVER start a reply with any of these): ماشي / تمام / تمام تمام / ممتاز / حلو / حلو جداً / ايوة / أكيد / رايقين / وش مسوين
PROHIBITED phrases anywhere: يا هلا انت وزوجتك / personal jokes
TONE = Polite Gulf travel consultant NOT casual friend

NO PERSONAL COMMENTS RULE — NEVER comment on personal details:
NEVER react to or comment on ANY personal detail the customer shares:
- Their family / group composition / ages / kids / marriage / "أنا وزوجتي" / "عيلتي"
- Their destination choice / dates / taste / plans
- ANY personal detail they mention
BANNED reactions (NEVER use any of these or close variants):
- "عائلة حلوة" / "عائلة صغيرة وحلوة" / "عيلة حلوة" / "عائلة وحلوة"
- "ما شاء الله" / "ما شاء الله عليك" / "ما شاء الله عليكم" / "تستاهلون كل خير"
- "اختيار ممتاز" / "ذوقك حلو" / "ذوق راقي" / "حلو الاختيار"
- ANY adjective describing the customer / their family / their choice as حلو / جميل / لطيف / رائع / ممتاز
After receiving a personal detail, do NOT acknowledge or react — go DIRECTLY to the next question.
  ✅ "أمرني 👌 كم يوم بتقضون في ماليزيا"
  ❌ "ماشي تمام 👌 عائلة صغيرة وحلوة كم يوم بتقضون"
  ❌ "ما شاء الله عليكم اختيار ممتاز كم يوم"
  ❌ "حلو 😍 انت وزوجتك كم يوم"

RECOMMENDATION REPLY RULE — when client asks for advice:
Triggers: "ايش تنصحنا" / "ايش تنصحني" / "وش تنصح" / "كم يوم تقترح" / "كم يوم مناسب" / "كم يوم تنصح" / any "what do you recommend" question about duration or itinerary.

Format (in this exact order):
1. Answer the question DIRECTLY based on the destination — no soft opener, no "أبشر/هلا والله" before the recommendation
2. Give a MINIMUM number of days as the floor
3. Keep it open and flexible — explicitly mention they can extend
4. End with an open question back to them ("كم يوم تفكر" / "وش رأيك")

Example:
"أنصحك بـ 7 أيام كحد أدنى عشان تشوف أهم المناطق، بس لو تبي تستمتع أكثر تقدر تمدد لـ 10 أو 15 يوم، هذا يرجع لك 😊 كم يوم تفكر؟"

SOFT OPENING RULE:
Never start with question directly. Always soften first with friendly phrase.

ADDITIONAL RULES:
- NEVER mix customer reply with Excel storage decision
- NEVER proceed without admin input after uncertainty
- NEVER repeat category argument more than once
- ALWAYS follow strict step order
- Prioritize answering current message over history
`;

type AgentDates = { start_date: string | null; end_date: string | null; flexible: boolean };
type AgentPassengers = { adults: number | null; children: number | null; infants: number | null };
type AgentResponse = {
  data: {
    destination: string | null;
    travel_dates: AgentDates;
    passengers: AgentPassengers;
    trip_duration_days: number | null;
    budget: { min: number | null; max: number | null; currency: string };
    notes: string | null;
  };
  intent: string;
  action: string;
  message: string;
  lead_score: number;
  lead_type: string;
  confidence: number;
};

async function runTravelAgent(args: {
  history: TaiTurn[];
  userMessage: string;
  sessionState: { destination: string | null; persons: number | null; travel_date: string | null };
}): Promise<AgentResponse | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const today = new Date().toISOString().slice(0, 10);
  const stateHint =
    `\n\nCURRENT SESSION STATE (already extracted in earlier turns):` +
    `\n- destination: ${args.sessionState.destination ?? "null"}` +
    `\n- travel_dates.start_date: ${args.sessionState.travel_date ?? "null"}` +
    `\n- passengers.adults: ${args.sessionState.persons ?? "null"}` +
    `\nIf any of the above are NOT null, do NOT ask the user for them again. Merge new info into these.`;

  const system = TRAVEL_AGENT_PROMPT.replace("{{TODAY}}", today) + stateHint;
  const messages = [
    ...args.history,
    { role: "user" as const, content: args.userMessage },
  ];

  try {
    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system,
      messages,
    });
    const block = res.content?.[0];
    if (!block || block.type !== "text") return null;
    const m = block.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as AgentResponse;
  } catch (e) {
    console.error("Travel agent failed", (e as Error).message);
    return null;
  }
}

// Map agent's nested response back onto whatsapp_sessions columns and decide
// whether the package data is now complete enough to send to staff.
function applyAgentResultToSession(args: {
  prevDestination: string | null;
  prevPersons: number | null;
  prevTravelDate: string | null;
  agent: AgentResponse;
}): { destination: string | null; persons: number | null; travel_date: string | null; complete: boolean } {
  const d = args.agent.data || ({} as AgentResponse["data"]);
  const newDest = d.destination?.trim() || args.prevDestination;
  const newPersons = d.passengers?.adults ?? args.prevPersons;
  // Keep the existing YYYY-MM-DD or DD/MM/YYYY format we already used elsewhere;
  // store the agent's ISO start_date as-is.
  const newDate = d.travel_dates?.start_date?.trim() || args.prevTravelDate;
  const complete = !!(newDest && newPersons && newDate);
  return { destination: newDest, persons: newPersons, travel_date: newDate, complete };
}

async function startPackageFlow(args: {
  supabase: ReturnType<typeof createClient>;
  session: { destination: string | null; persons: number | null; travel_date: string | null } | null;
  from: string;
  text: string;
}): Promise<void> {
  const { supabase, from, text, session } = args;
  await runTravelAgentTurn({
    supabase, from, text,
    history: [],
    prev: {
      destination: session?.destination ?? null,
      persons: session?.persons ?? null,
      travel_date: session?.travel_date ?? null,
    },
  });
}

async function runTravelAgentTurn(args: {
  supabase: ReturnType<typeof createClient>;
  from: string;
  text: string;
  history: TaiTurn[];
  prev: { destination: string | null; persons: number | null; travel_date: string | null };
}): Promise<void> {
  const { supabase, from, text, history, prev } = args;

  const agent = await runTravelAgent({
    history,
    userMessage: text,
    sessionState: prev,
  });

  if (!agent) {
    // Claude unavailable — fallback to a polite holding message + flag for staff.
    await sendWhatsapp(from,
      isOmanQuietHours() ? OMAN_OFF_HOURS_MSG
        : "تمام أخوي وصلني طلبك راح يجهز لك موظف من المبيعات وارسلك التفاصيل بعد لحظات 🌹");
    await supabase.from("whatsapp_sessions")
      .update({ stage: "in_agent", last_message_at: new Date().toISOString() })
      .eq("phone", from);
    return;
  }

  const merged = applyAgentResultToSession({
    prevDestination: prev.destination,
    prevPersons: prev.persons,
    prevTravelDate: prev.travel_date,
    agent,
  });

  const newHistory: TaiTurn[] = [
    ...history,
    { role: "user", content: text },
    { role: "assistant", content: JSON.stringify({ message: agent.message, action: agent.action }) },
  ];

  // action === "send_offer" → all critical data captured; transition to
  // pending_review and let staff build the program manually (same path as
  // before, just driven by the agent's decision instead of the regex flow).
  if (agent.action === "send_offer" && merged.complete) {
    await supabase
      .from("whatsapp_sessions")
      .update({
        stage: "pending_review",
        destination: merged.destination,
        persons: merged.persons,
        travel_date: merged.travel_date,
        conversation: newHistory,
        pending_program_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
      })
      .eq("phone", from);

    // Customer-facing warm reply (the agent's own message), then staff alert.
    await sendWhatsapp(from, agent.message);
    const sales = staffList("SALES_WHATSAPP_NUMBERS");
    const phoneDigits = from.replace(/^whatsapp:/, "");
    const notice =
      `📨 طلب باقة جديد جاهز للتجهيز\n` +
      `العميل: ${phoneDigits}\n` +
      `الوجهة: ${merged.destination}\n` +
      `الأشخاص: ${merged.persons}\n` +
      `التاريخ: ${merged.travel_date}\n` +
      `Lead score: ${agent.lead_score} (${agent.lead_type})\n\n` +
      `جهّز البرنامج من الواجهة وأرسله للعميل مباشرة من واتسابك`;
    await Promise.all(sales.map(num => sendStaffNotice(num, notice)));
    return;
  }

  // action === "support" → defer to the FAQ. If the FAQ has a match, send
  // that; otherwise fall back to the agent's own message.
  let outgoing = agent.message;
  if (agent.action === "support") {
    const faq = await findFaqAnswer(supabase, text);
    if (faq) outgoing = faq;
  }

  await sendWhatsapp(from, outgoing);
  await supabase
    .from("whatsapp_sessions")
    .update({
      stage: "in_agent",
      destination: merged.destination,
      persons: merged.persons,
      travel_date: merged.travel_date,
      conversation: newHistory,
      last_message_at: new Date().toISOString(),
    })
    .eq("phone", from);
}

async function continuePackageFlow(args: {
  supabase: ReturnType<typeof createClient>;
  session: {
    phone: string; stage: string;
    destination: string | null; persons: number | null; travel_date: string | null;
  };
  text: string;
  from: string;
}): Promise<void> {
  const { supabase, session, text, from } = args;
  // Fetch conversation so the agent has full context.
  const { data: row } = await supabase
    .from("whatsapp_sessions")
    .select("conversation")
    .eq("phone", from)
    .maybeSingle();
  const history = ((row?.conversation || []) as TaiTurn[]);
  await runTravelAgentTurn({
    supabase, from, text, history,
    prev: {
      destination: session.destination,
      persons: session.persons,
      travel_date: session.travel_date,
    },
  });
}

function promptForStage(stage: string): string {
  switch (stage) {
    case "awaiting_destination":
      return "تمام! إلى أي وجهة تودّ السفر؟ (مثلاً: فيتنام، ماليزيا، تركيا...)";
    case "awaiting_persons":
      return "كم عدد المسافرين؟";
    case "awaiting_date":
      return "ومتى تاريخ السفر تقريباً؟ (مثلاً 15/07/2026 أو شهر يوليو)";
    default:
      return "تمام، نجهّز لك العرض الآن.";
  }
}

async function finalizePackage(args: {
  supabase: ReturnType<typeof createClient>;
  from: string;
}): Promise<void> {
  const { supabase, from } = args;
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("*")
    .eq("phone", from)
    .maybeSingle();
  if (!data) return;
  const s = data as {
    phone: string; profile_name: string;
    destination: string | null; persons: number | null; travel_date: string | null;
    hubspot_contact_id: string | null;
  };

  // حدّث HubSpot بالحقول المجموعة
  await upsertHubspotContact({
    phone: s.phone,
    name: s.profile_name,
    destination: s.destination,
    persons: s.persons,
    date: s.travel_date,
  });

  // 1) أبلغ العميل أن الطلب وصل وراح يجهز من قبل الموظف
  await sendWhatsapp(
    from,
    `تمام! استلمنا طلبك: عرض ${s.destination} لـ ${s.persons} أشخاص بتاريخ ${s.travel_date}.\n` +
    `راح يجهز لك الموظف البرنامج ويرسله قريباً إن شاء الله 🌍`,
  );

  // 2) Tourism-AI تخطّي مؤقت — الموظف يبني البرنامج يدوياً.
  //    ننقل الجلسة فوراً إلى pending_review عشان أي رسالة جاية من العميل تأخذ
  //    رد الانتظار التلقائي بدل ما تُعاد للتصنيف.
  const sales = staffList("SALES_WHATSAPP_NUMBERS");
  const phoneDigits = from.replace(/^whatsapp:/, "");
  const notice =
    `📨 طلب باقة جديد جاهز للتجهيز\n` +
    `العميل: ${s.profile_name} (${phoneDigits})\n` +
    `الوجهة: ${s.destination}\n` +
    `الأشخاص: ${s.persons}\n` +
    `التاريخ: ${s.travel_date}\n\n` +
    `جهّز البرنامج من الواجهة وأرسله للعميل مباشرة من واتسابك`;
  await Promise.all(sales.map(num => sendStaffNotice(num, notice)));

  await supabase
    .from("whatsapp_sessions")
    .update({
      stage: "pending_review",
      pending_program_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    })
    .eq("phone", from);
}

// نبّه موظفي المبيعات بأن البرنامج جاهز للمراجعة + أرسل النص الكامل عشان
// ينسخوه ويوصلوه للعميل من الواتس مباشرة
async function sendProgramToStaff(args: {
  profileName: string;
  from: string;
  destination: string | null;
  persons: number | null;
  travelDate: string | null;
  programText: string;
}): Promise<void> {
  const sales = staffList("SALES_WHATSAPP_NUMBERS");
  const phoneDigits = args.from.replace(/^whatsapp:/, "");
  const header =
    `✅ برنامج جاهز للمراجعة والإرسال للعميل\n` +
    `العميل: ${args.profileName} (${phoneDigits})\n` +
    `${args.destination ?? ""} · ${args.persons ?? "?"} أشخاص · ${args.travelDate ?? ""}\n` +
    `\n────────────────\n`;
  // Twilio WhatsApp body limit is ~1600 chars. Chunk into header + program;
  // if program itself is huge, split into multiple parts.
  const chunks: string[] = [];
  const first = header + args.programText;
  if (first.length <= 1500) {
    chunks.push(first);
  } else {
    chunks.push(header + "(البرنامج التالي مقسوم على أجزاء)");
    let s = args.programText;
    while (s.length > 0) {
      chunks.push(s.slice(0, 1500));
      s = s.slice(1500);
    }
  }
  for (const chunk of chunks) {
    await Promise.all(sales.map(num => sendWhatsapp(num, chunk)));
  }
}

// أكمل محادثة Tourism-AI: يأخذ تاريخ المحادثة من الجلسة، يضيف رد العميل
// الجديد، يستدعي Tourism-AI، يحدّث التاريخ ويرسل الرد للعميل. لو وصل
// Tourism-AI لحد ما يبني برنامج كامل (فيه SUMMARY:) ينقل الجلسة لـ done
// وينبه المبيعات بالبرنامج الجاهز.
async function continueTourismAIConversation(args: {
  supabase: ReturnType<typeof createClient>;
  from: string;
  text: string;
  profileName: string;
}): Promise<void> {
  const { supabase, from, text, profileName } = args;

  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("conversation, destination, persons, travel_date")
    .eq("phone", from)
    .maybeSingle();
  const existing = (data?.conversation || []) as TaiTurn[];
  const conversation: TaiTurn[] = [...existing, { role: "user", content: text }];

  const result = await callTourismAI(conversation);
  if (!result) {
    await sendWhatsapp(
      from,
      "صار خلل بسيط ما قدرت ابني البرنامج الحين. خبرني وش حاب وراح يتواصل معك موظف المبيعات",
    );
    await supabase
      .from("whatsapp_sessions")
      .update({ stage: "done", last_message_at: new Date().toISOString() })
      .eq("phone", from);
    return;
  }

  conversation.push({ role: "assistant", content: result.raw });

  // Same gating as finalizePackage: hold the program for staff review when
  // SUMMARY: is present; only the customer-facing clarification stays auto-sent.
  const sessionUpdate: Record<string, unknown> = {
    conversation,
    last_message_at: new Date().toISOString(),
  };

  if (result.isProgram) {
    sessionUpdate.stage = "pending_review";
    sessionUpdate.pending_program = result.formatted;
    sessionUpdate.pending_program_at = new Date().toISOString();
    await sendProgramToStaff({
      profileName,
      from,
      destination: data?.destination ?? null,
      persons: data?.persons ?? null,
      travelDate: data?.travel_date ?? null,
      programText: result.formatted,
    });
  } else {
    sessionUpdate.stage = "tourism_ai_active";
    await sendWhatsapp(from, result.formatted);
  }

  await supabase.from("whatsapp_sessions").update(sessionUpdate).eq("phone", from);
}

// ── Admin-approved AI suggestions for unknown questions ──────────────────
// Flow: customer asks something findFaqAnswer can't resolve →
//   1. Claude analyses + proposes interpretation, reply, category, keywords
//   2. Row inserted in whatsapp_admin_proposals (status='pending_reply_approval')
//   3. Admin (any SALES_WHATSAPP_NUMBERS phone) gets the proposal on WhatsApp
//   4. Admin replies "نعم" / "لا"
//   5. On yes: bot sends the reply to the original customer, then asks admin
//      whether to also add it to the sheet (status='pending_sheet_approval')
//   6. On second "نعم": appendChatAnswerRow writes a new row to the ALEZZ
//      Chat Google Sheet, then triggers sync-sheets so chat_answers reflects
//      it within seconds and the next identical question hits the FAQ
//      deterministically without Claude.

const ALEZZ_CHAT_SPREADSHEET_ID = "1wBbUNMyZvYMFzxhw9CSVWZvnolMX_yzr13bUVfUxmYQ";

type ProposalRow = {
  id: string;
  customer_phone: string;
  customer_profile_name: string;
  customer_question: string;
  interpretation: string;
  suggested_reply: string;
  proposed_intent: string;
  proposed_sub_intent: string;
  proposed_keywords: string[];
  status: string;
  created_at: string;
};

// Customer journey stages — used by the FAQ matcher and the
// admin-preview notification.
const CUSTOMER_STAGES = ["INQUIRY", "READY_FOR_QUOTE", "OFFER_SENT", "BOOKING_IN_PROGRESS", "BOOKING_CONFIRMED", "TRAVELING", "POST_TRAVEL"] as const;
type CustomerStage = typeof CUSTOMER_STAGES[number];
const STAGE_EMOJI: Record<CustomerStage, string> = {
  INQUIRY: "🔍",
  OFFER_SENT: "💼",
  BOOKING_IN_PROGRESS: "📋",
  BOOKING_CONFIRMED: "✅",
  TRAVELING: "✈️",
  POST_TRAVEL: "🔄",
};
const STAGE_LABEL_AR: Record<CustomerStage, string> = {
  INQUIRY: "مجرد استفسار، ما بدأ الحجز",
  OFFER_SENT: "تم إرسال عرض له",
  BOOKING_IN_PROGRESS: "في مرحلة الحجز",
  BOOKING_CONFIRMED: "حجز مؤكد",
  TRAVELING: "في رحلته الآن",
  POST_TRAVEL: "بعد الرحلة",
};
function stageBadge(stage: string | null | undefined): string {
  if (!stage) return "🔍 INQUIRY";
  const s = stage as CustomerStage;
  const e = STAGE_EMOJI[s];
  return e ? `${e} ${s}` : stage;
}

type ClaudeAnalysis = {
  interpretation: string;
  goal: string;                   // هدف العميل الحقيقي من سؤاله — لتحسين الفهم والرد
  suggestedReply: string;
  sourceRowId: string | null;     // id of FAQ row whose answer was reused (null = AI-generated)
  proposedIntent: string;
  proposedSubIntent: string;
  proposedKeywords: string[];
  // CRM classifier output (per spec) — used for dashboard sorting,
  // routing decisions, and surfacing URGENT cases to admin.
  customerType: string;           // NEW_CUSTOMER | REPEAT_CUSTOMER | VIP_CUSTOMER | CORPORATE_BUSINESS | PARTNERSHIP
  caseType: string;               // INQUIRY | BOOKING_REQUEST | BOOKING_CONFIRMED | COMPLAINT | CANCELLATION | MODIFICATION
  complaintType: string | null;   // only when caseType=COMPLAINT
  bookingStatus: string;          // NONE | CONFIRMED | ACTIVE | COMPLETED
  priority: string | null;        // "URGENT" or null
  priorityLabel: string | null;   // "URGENT 🚨" or null
  customerStage: CustomerStage;   // PREVIEW MODE stage classification
  // ── إضافات للمراجعة البشرية (لا تُعتمد إلا بموافقة) ──
  extractedData: Record<string, unknown>;     // destination/travel_dates/adults/children/children_ages/budget/trip_type
  missingData: string[];                       // المعلومات الناقصة لإعداد عرض
  businessMetadata: Record<string, unknown>;   // service_name/service_status/seasonal_availability/start_date/end_date (اقتراح)
};

// يبني نص سياق المحادثة (رسائل العميل + ردود طلال، الأقدم أولاً) لإعطاء المُحلّل
// صورة كاملة فلا يكرّر سؤالاً أجاب عنه العميل ويعرف الناقص لبناء البرنامج.
async function buildConversationContext(
  supabase: ReturnType<typeof createClient>, phone: string, limit = 30,
): Promise<string> {
  const [inb, outb] = await Promise.all([
    supabase.from("wa_message_audit").select("body, received_at").eq("from_phone", phone)
      .not("body", "is", null).order("received_at", { ascending: false }).limit(limit),
    supabase.from("wa_admin_messages").select("body, sent_at").eq("customer_phone", phone)
      .order("sent_at", { ascending: false }).limit(limit),
  ]);
  type R = { body?: string | null; received_at?: string; sent_at?: string };
  const msgs: Array<{ ts: string; who: string; body: string }> = [];
  for (const m of ((inb.data || []) as R[])) if (m.body && !String(m.body).startsWith("📎")) msgs.push({ ts: m.received_at || "", who: "العميل", body: String(m.body) });
  for (const m of ((outb.data || []) as R[])) if (m.body) msgs.push({ ts: m.sent_at || "", who: "طلال", body: String(m.body) });
  msgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return msgs.slice(-24).map(m => m.who + ": " + m.body).join("\n").slice(-4000);
}

const MODEL_FAST = "claude-haiku-4-5-20251001";   // رخيص — للمتكرّر/البسيط
const MODEL_DEEP = "claude-sonnet-4-6";            // أغلى وأذكى — للجديد/التحليل العميق

// تصنيف دفعي لرسائل الموظفين الرمادية: هل كل رسالة ردّ فعلي أم وعد/مجاملة؟
// يُستدعى في الخلفية (waitUntil) للحالات غير المخزّنة فقط، ويُخزَّن في wa_reply_verdict.
// مفتاح كل رسالة ثابت (phone|sent_at) فتُصنَّف مرّة واحدة فقط طوال العمر.
async function classifyStaffReplies(
  supabase: ReturnType<typeof createClient>,
  items: Array<{ key: string; body: string }>,
): Promise<void> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey || !items.length) return;
  try {
    const anthropic = new Anthropic({ apiKey });
    const list = items.map((it, i) => `${i + 1}. ${String(it.body || "").replace(/\s+/g, " ").trim().slice(0, 220)}`).join("\n");
    const sys = "أنت تصنّف رسائل موظف خدمة عملاء في وكالة سياحة (الرسالة من الموظف للعميل). لكل رسالة قرّر true أو false:\n- true = ردّ فعلي يضع الكرة في ملعب العميل: جواب/سعر/برنامج/فندق/معلومة، **أو أي سؤال موجّه للعميل** (مثل «كم مدة الإقامة؟»، «متى السفر؟»، «تحبون فندق ٥ نجوم؟») — لأن العميل هو من يتأخّر بعدها لا الموظف.\n- false = وعد بالإرسال/التجهيز لاحقاً («الآن أرسلك»، «راح أجهّز لك»، «قيد التنفيذ»، «بنعمل لك حجز») أو مجاملة/تطمين بلا محتوى ولا سؤال.\nأي رسالة فيها سؤال للعميل = true دائماً. أعِد JSON array من قيم منطقية فقط بنفس ترتيب الرسائل، بلا أي شرح.";
    const res = await anthropic.messages.create({ model: MODEL_FAST, max_tokens: 800, system: sys, messages: [{ role: "user", content: list }] });
    const txt = (res.content as Array<{ type: string; text?: string }>).filter(b => b.type === "text").map(b => b.text || "").join("");
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return;
    const arr = JSON.parse(m[0]) as unknown[];
    const rows = items.map((it, i) => ({ msg_key: it.key, is_reply: arr[i] === true, body_preview: String(it.body || "").slice(0, 120) }))
      .filter((_, i) => typeof arr[i] === "boolean");
    if (rows.length) await supabase.from("wa_reply_verdict").upsert(rows, { onConflict: "msg_key" });
  } catch (_e) { /* تجاهل — القاعدة المجانية تبقى الاحتياط */ }
}

async function analyzeUnknownQuestion(
  supabase: ReturnType<typeof createClient>,
  question: string,
  conversation: string = "",
  model: string = MODEL_FAST,
): Promise<ClaudeAnalysis | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  // Fetch existing FAQ rows WITH their answers so Claude can semantically
  // match against the curated content first, rather than inventing replies
  // from its own knowledge. This is the admin's policy: prefer ALEZZ Chat
  // content; only generate fresh text if nothing in the sheet fits.
  type FaqRow = {
    id: string; intent: string; sub_intent: string | null;
    keywords: string[] | null;
    answer_om: string | null; answer_sa1: string | null;
    answer_clarification: string | null;
  };
  const { data: existing } = await supabase
    .from("chat_answers")
    .select("id, intent, sub_intent, keywords, answer_om, answer_sa1, answer_clarification");

  // أمثلة الأسئلة وأهداف العملاء المتراكمة لكل رد معتمد — تساعد على المطابقة بالهدف.
  const { data: confExamples } = await supabase
    .from("faq_confirmations")
    .select("row_id, sample_questions, goals");
  const exByRow = new Map<string, { q: string[]; g: string[] }>();
  for (const c of ((confExamples as Array<{ row_id: string; sample_questions?: string[]; goals?: string[] }> | null) ?? [])) {
    exByRow.set(c.row_id, { q: (c.sample_questions || []).slice(-5), g: (c.goals || []).slice(-5) });
  }

  const rows = (existing as FaqRow[] | null ?? []).map((r) => ({
    id: r.id,
    intent: r.intent || "",
    sub_intent: r.sub_intent || "",
    keywords: Array.isArray(r.keywords) ? r.keywords.slice(0, 10).join(", ") : "",
    answer: (
      (r.answer_om && r.answer_om.trim()) ||
      (r.answer_sa1 && r.answer_sa1.trim()) ||
      (r.answer_clarification && r.answer_clarification.trim()) ||
      ""
    ).slice(0, 280),
  })).filter((r) => r.answer);

  const faqRef = rows.map((r) => {
    const ex = exByRow.get(r.id);
    const exLine = ex && ex.q.length ? `\n  أمثلة أسئلة سبق ربطها بهذا الرد: ${ex.q.join(" | ")}` : "";
    const goalLine = ex && ex.g.length ? `\n  أهداف العملاء لهذا الرد: ${ex.g.join(" | ")}` : "";
    return `[${r.id}] ${r.intent}${r.sub_intent ? " / " + r.sub_intent : ""}\n` +
      `  keywords: ${r.keywords}\n` +
      `  answer: ${r.answer}${exLine}${goalLine}`;
  }).join("\n\n");

  const categories = rows
    .map((r) => `${r.intent}${r.sub_intent ? " / " + r.sub_intent : ""}`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  const sys =
    `أنت مساعد لوكالة سياحية تعمل في عُمان والسعودية (ALEZZ Tourism).\n` +
    `يصلك سؤال عميل ما طابق أي إجابة بشكل دقيق في قاعدة الـ FAQ. مهمتك:\n\n` +
    `1) interpretation: اشرح بإيجاز (جملة واحدة) ماذا يقصد العميل.\n\n` +
    `1ب) goal: هدف العميل الحقيقي من سؤاله أو محادثته بإيجاز — وش يبي يحقّق فعلياً (مثل: يقارن الأسعار قبل الحجز، يتأكد من توفّر رحلة بتاريخه، يبي أرخص خيار، يبي برنامج عائلي مريح...). هذا الهدف يساعد على فهم الاستفسار والرد عليه على أصوله.\n\n` +
    `1ج) أنت مساعد مبيعات سياحي. المعلومات الأساسية لبناء برنامج سياحي هي: الوجهة · تاريخ السفر · عدد المسافرين · أعمار الأطفال (إن وُجدوا) · عدد الأيام/المدة · المدن المراد زيارتها أو ترك الترتيب للوكالة · (الميزانية وفئة الفندق إن ذُكرت). اقرأ "سياق المحادثة" أدناه كاملاً واعرف أيّها قدّمه العميل سابقاً وأيّها ناقص.\n\n` +
    `2) suggested_reply + source_row_id (الأهم — أولوية قصوى لإعادة استخدام المعتمد سابقاً):\n` +
    `   • القاعدة الأساسية: لا تخترع رداً جديداً إذا كان في قاعدة الـ FAQ أدناه صف إجابته تناسب نفس الاستفسار — حتى لو الصياغة أو الكلمات مختلفة تماماً. طابق بالمعنى لا بالكلمات.\n` +
    `   • لو لقيت صفاً مناسباً (أو قريباً في المعنى) → استخدم نص إجابته **حرفياً كما هو** كـ suggested_reply، وضع id الصف في source_row_id. هذا هو السلوك الافتراضي المطلوب.\n` +
    `   • اكتب رداً جديداً (source_row_id = null) **فقط** لو كان الاستفسار جديداً فعلاً ولا يوجد أي صف قريب منه إطلاقاً. عند الشك، أعد استخدام أقرب صف بدل اختراع رد جديد.\n` +
    `   • ⚠️ ابنِ الرد بناءً على **سياق المحادثة كاملاً** (أدناه). لا تكرّر سؤالاً أجاب عنه العميل سابقاً — لو ذكر وجهته أو تاريخه أو عدده قبل، لا تسأل عنه مرة ثانية. لو ناقصة معلومات أساسية لبناء البرنامج، اطلب **الناقص منها فقط** بإيجاز ولطف. لو كل الأساسيات متوفرة، أكّد أنك ستجهّز البرنامج وتتواصل معه — بلا أسئلة زائدة.\n` +
    `   • أهم استثناء: إذا كان الصف المعتمد الذي ستعيد استخدامه **يطلب من العميل معلومات قدّمها أصلاً** (مثل الوجهة/العدد/التاريخ)، فلا تعِد طلبها — **عدّل نص الرد** ليطلب الناقص فقط أو ليؤكّد التجهيز. هنا السياق له الأولوية على التكرار الحرفي. (التكرار الحرفي يبقى فقط للردود المعلوماتية التي لا تطلب معلومات من العميل.)\n\n` +
    `3) proposed_intent + proposed_sub_intent: الفئة المناسبة (يفضل من الفئات الحالية).\n\n` +
    `4) proposed_keywords: 10-18 كلمة مفتاحية لو الإدارة قررت تحفظ الرد كصف جديد (لا تستخدمها لو source_row_id موجود).\n` +
    `   قواعد الـ keywords:\n` +
    `   • جذور الكلمات (3-6 حروف) عشان تطابق متغيرات.\n` +
    `   • متغيرات الجمع والملكية (قطه، قطط، قطتي).\n` +
    `   • تجنّب الكلمات الشائعة: سفر، رحلة، برنامج، باكج، عرض، سعر، كم، وش، متى.\n` +
    `   • لا علامات ترقيم.\n\n` +
    `5) CRM classification — صنّف العميل وحالته:\n` +
    `   customer_type (واحد فقط):\n` +
    `     • NEW_CUSTOMER — ما عنده تعامل سابق معنا\n` +
    `     • REPEAT_CUSTOMER — "حجزت معكم قبل" أو "سافرت معكم"\n` +
    `     • VIP_CUSTOMER — يطلب luxury / 5-star / "أفضل" / "VIP" / تجربة فاخرة. يطغى على REPEAT و NEW.\n` +
    `     • CORPORATE_BUSINESS — شركة / منظمة / موظفين / "رحلة عمل"\n` +
    `     • PARTNERSHIP — مؤثّر / مُعلن / "رحلة مقابل إعلان" / barter\n` +
    `   case_type (واحد فقط):\n` +
    `     • INQUIRY — سؤال عام\n` +
    `     • BOOKING_REQUEST — يطلب يحجز\n` +
    `     • BOOKING_CONFIRMED — يأكّد حجزه\n` +
    `     • COMPLAINT — شكوى\n` +
    `     • CANCELLATION — إلغاء\n` +
    `     • MODIFICATION — تعديل\n` +
    `   complaint_type (فقط لو case_type=COMPLAINT، وإلا null):\n` +
    `     • PAYMENT_ISSUE / GENERAL_DISSATISFACTION / DELAY_RESPONSE /\n` +
    `       HOTEL_ISSUE / FLIGHT_ISSUE / SERVICE_ISSUE\n` +
    `   booking_status: NONE | CONFIRMED | ACTIVE | COMPLETED\n` +
    `   priority + priority_label:\n` +
    `     • إذا booking_status=CONFIRMED AND case_type=COMPLAINT →\n` +
    `         priority = "URGENT", priority_label = "URGENT 🚨"\n` +
    `     • وإلا → priority = null, priority_label = null\n\n` +
    `6) customer_stage — مرحلة العميل في رحلة الشراء (واحد فقط):\n` +
    `   • INQUIRY — مجرد استفسار، ما بدأ الحجز بعد\n` +
    `   • READY_FOR_QUOTE — توفّرت المعلومات الأساسية الكافية لإعداد عرض سعر (وجهة + تاريخ + عدد المسافرين على الأقل)\n` +
    `   • OFFER_SENT — استلم عرض/برنامج، يسأل عن تفاصيله أو يقارن\n` +
    `   • BOOKING_IN_PROGRESS — في عملية الحجز، يتفاوض/يطلب تعديل/يدفع\n` +
    `   • BOOKING_CONFIRMED — حجزه مؤكد، يتأكد من تفاصيل قبل السفر\n` +
    `   • TRAVELING — حالياً في رحلته (يسأل عن مكان/سائق/فندق على الأرض)\n` +
    `   • POST_TRAVEL — رجع من السفر، يعطي feedback أو يستفسر بعد الرحلة\n\n` +
    `سياق المحادثة مع العميل (الأقدم أولاً) — اقرأه كاملاً قبل اقتراح الرد لتعرف ما قاله سابقاً:\n${conversation || "(لا سياق سابق — أول رسالة)"}\n\n` +
    `قاعدة الـ FAQ الموجودة (${rows.length} صف):\n${faqRef}\n\n` +
    `الفئات الحالية: ${categories}\n\n` +
    `7) استخراج بيانات منظّمة (إضافة للمراجعة البشرية — لا تُعتمد إلا بموافقة):\n` +
    `   • extracted_data: استخرج من المحادثة كاملةً: destination (الوجهة)، travel_dates (تواريخ/شهر السفر)، adults (عدد الكبار)، children (عدد الأطفال)، children_ages (أعمار الأطفال نص)، budget (الميزانية)، trip_type (نوع الرحلة: عائلية/شهر عسل/مجموعة...). اترك أي حقل فارغاً إن لم يُذكر. عند تعارض جديد مع قديم اعتمد الأحدث المؤكَّد.\n` +
    `   • missing_data: قائمة بأهم المعلومات الأساسية الناقصة لإعداد عرض (مثل ["تاريخ السفر","الميزانية"])، فارغة لو الأساسيات مكتملة.\n` +
    `   • business_metadata (اقتراح فقط، لا يُعتمد إلا بموافقة بشرية): service_name، service_status، seasonal_availability، start_date، end_date. اتركها فارغة إن لم تُكتشف.\n\n` +
    `أعد JSON فقط بدون أي نص آخر:\n` +
    `{"interpretation":"...","goal":"...","suggested_reply":"...","source_row_id":"PKG0xx أو null","proposed_intent":"...","proposed_sub_intent":"...","proposed_keywords":["...","..."],"customer_type":"...","case_type":"...","complaint_type":"...أو null","booking_status":"...","priority":"URGENT أو null","priority_label":"URGENT 🚨 أو null","customer_stage":"INQUIRY|READY_FOR_QUOTE|OFFER_SENT|BOOKING_IN_PROGRESS|BOOKING_CONFIRMED|TRAVELING|POST_TRAVEL","extracted_data":{"destination":"","travel_dates":"","adults":null,"children":null,"children_ages":"","budget":"","trip_type":""},"missing_data":["..."],"business_metadata":{"service_name":"","service_status":"","seasonal_availability":"","start_date":"","end_date":""}}`;

  try {
    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model,   // MODEL_FAST افتراضياً (رخيص)، أو MODEL_DEEP للتحليل العميق عند الحاجة
      max_tokens: 900,
      system: sys,
      messages: [{ role: "user", content: question }],
    });
    const out = res.content?.[0];
    if (!out || out.type !== "text") return null;
    const m = out.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const rawSourceId = String(parsed.source_row_id || "").trim();
    const sourceRowId = (rawSourceId && rawSourceId !== "null") ? rawSourceId : null;
    const customerType = String(parsed.customer_type || "").trim().toUpperCase();
    const caseType = String(parsed.case_type || "").trim().toUpperCase();
    const rawComplaint = String(parsed.complaint_type || "").trim().toUpperCase();
    const complaintType = (caseType === "COMPLAINT" && rawComplaint && rawComplaint !== "NULL")
      ? rawComplaint : null;
    const bookingStatus = String(parsed.booking_status || "NONE").trim().toUpperCase();
    // Enforce the URGENT rule server-side so we don't depend on Claude
    // following it correctly every time.
    const isUrgent = caseType === "COMPLAINT" && bookingStatus === "CONFIRMED";
    // Customer stage — bound to the allowed enum + auto-promote from
    // booking_status when Claude leaves the stage as INQUIRY but the
    // booking is already CONFIRMED.
    const rawStage = String(parsed.customer_stage || "INQUIRY").trim().toUpperCase();
    let customerStage: CustomerStage =
      (CUSTOMER_STAGES as readonly string[]).includes(rawStage)
        ? (rawStage as CustomerStage)
        : "INQUIRY";
    if (customerStage === "INQUIRY" && bookingStatus === "CONFIRMED") {
      customerStage = "BOOKING_CONFIRMED";
    } else if (customerStage === "INQUIRY" && bookingStatus === "ACTIVE") {
      customerStage = "TRAVELING";
    } else if (customerStage === "INQUIRY" && bookingStatus === "COMPLETED") {
      customerStage = "POST_TRAVEL";
    }
    return {
      interpretation: String(parsed.interpretation || "").trim(),
      goal: String(parsed.goal || "").trim(),
      suggestedReply: String(parsed.suggested_reply || "").trim(),
      sourceRowId,
      proposedIntent: String(parsed.proposed_intent || "").trim(),
      proposedSubIntent: String(parsed.proposed_sub_intent || "").trim(),
      proposedKeywords: Array.isArray(parsed.proposed_keywords)
        ? parsed.proposed_keywords.map(String).map(s => s.trim()).filter(Boolean)
        : [],
      customerType,
      caseType,
      complaintType,
      bookingStatus,
      priority: isUrgent ? "URGENT" : null,
      priorityLabel: isUrgent ? "URGENT 🚨" : null,
      customerStage,
      extractedData: (parsed.extracted_data && typeof parsed.extracted_data === "object") ? parsed.extracted_data as Record<string, unknown> : {},
      missingData: Array.isArray(parsed.missing_data) ? (parsed.missing_data as unknown[]).map(String).map(s => s.trim()).filter(Boolean) : [],
      businessMetadata: (parsed.business_metadata && typeof parsed.business_metadata === "object") ? parsed.business_metadata as Record<string, unknown> : {},
    };
  } catch (e) {
    console.error("Claude analyse failed", (e as Error).message);
    return null;
  }
}

async function createProposalAndNotifyAdmin(args: {
  supabase: ReturnType<typeof createClient>;
  customerPhone: string;
  profileName: string;
  question: string;
}): Promise<void> {
  const { supabase, customerPhone, profileName, question } = args;
  const convContext = await buildConversationContext(supabase, customerPhone);
  // توفير: الموديل الرخيص أولاً (مناسب للمتكرّر اللي يطابق رداً معتمداً). لو ما
  // طابق (استفسار جديد) → نرفّع لتحليل أعمق بـ Sonnet. ويبقى زر «تحليل أعمق» يدوياً.
  let analysis = await analyzeUnknownQuestion(supabase, question, convContext, MODEL_FAST);
  if (!analysis || !analysis.sourceRowId) {
    const deep = await analyzeUnknownQuestion(supabase, question, convContext, MODEL_DEEP);
    if (deep) analysis = deep;
  }

  // Defensive fallback: if Claude analysis failed (returned null) we still
  // ESCALATE — the customer was already told "لحظة، راح أوصل سؤالك للمختص"
  // so we MUST notify admin. Skip the AI-suggestion approval step and go
  // straight to pending_correction so the admin's next message becomes the
  // reply sent to the customer.
  if (!analysis) {
    console.warn(
      `analyzeUnknownQuestion returned null; escalating without AI suggestion: ${question.slice(0, 120)}`,
    );
  }
  const safe = analysis ?? {
    interpretation: "",
    goal: "",
    suggestedReply: "",
    sourceRowId: null as string | null,
    proposedIntent: "",
    proposedSubIntent: "",
    proposedKeywords: [] as string[],
    customerType: "",
    caseType: "",
    complaintType: null as string | null,
    bookingStatus: "NONE",
    priority: null as string | null,
    priorityLabel: null as string | null,
    customerStage: "INQUIRY" as CustomerStage,
    extractedData: {} as Record<string, unknown>,
    missingData: [] as string[],
    businessMetadata: {} as Record<string, unknown>,
  };
  const status = analysis ? "pending_reply_approval" : "pending_correction";

  // عدّاد تأكيدات الرد المعتمد (إن طابق صفاً موجوداً) — مؤشّر ثقة يظهر بالداشبورد.
  let sourceConfirmations: number | null = null;
  if (safe.sourceRowId) {
    const { data: fc } = await supabase.from("faq_confirmations")
      .select("confirmations").eq("row_id", safe.sourceRowId).maybeSingle();
    sourceConfirmations = (((fc as { confirmations?: number } | null)?.confirmations) ?? 0);
  }

  const { error } = await supabase.from("whatsapp_admin_proposals").insert({
    customer_phone: customerPhone,
    customer_profile_name: profileName,
    customer_question: question,
    interpretation: safe.interpretation,
    customer_goal: safe.goal,
    suggested_reply: safe.suggestedReply,
    source_row_id: safe.sourceRowId,
    source_confirmations: sourceConfirmations,
    proposed_intent: safe.proposedIntent,
    proposed_sub_intent: safe.proposedSubIntent,
    proposed_keywords: safe.proposedKeywords,
    customer_type: safe.customerType,
    case_type: safe.caseType,
    complaint_type: safe.complaintType,
    booking_status: safe.bookingStatus,
    priority: safe.priority,
    priority_label: safe.priorityLabel,
    customer_stage: safe.customerStage,
    extracted_data: safe.extractedData,
    missing_data: safe.missingData,
    business_metadata: safe.businessMetadata,
    status,
  });
  if (error) { console.error("Proposal insert failed", error.message); return; }
  // Keep the session's customer_stage in sync — the dashboard reads it
  // off whatsapp_sessions and the next FAQ lookup will use it.
  await supabase.from("whatsapp_sessions")
    .update({ customer_stage: safe.customerStage })
    .eq("phone", customerPhone);

  // Pull recent context from wa_message_audit — last N inbound messages
  // from this customer so admin sees the conversation thread, not just
  // the isolated question. Helps when the current question relates to
  // something the customer mentioned earlier.
  const { data: history } = await supabase
    .from("wa_message_audit")
    .select("body, received_at")
    .eq("from_phone", customerPhone)
    .order("received_at", { ascending: false })
    .limit(6);
  // First entry is usually the current question itself; drop it and keep
  // up to 5 earlier ones (oldest-first).
  const earlier = ((history as Array<{ body: string; received_at: string }> | null) ?? [])
    .slice(1, 6)
    .reverse();
  const contextBlock = earlier.length
    ? `📜 رسائل سابقة من العميل:\n` +
      earlier.map((r) => {
        const t = (r.received_at || "").replace("T", " ").slice(0, 19);
        const b = String(r.body || "").slice(0, 120);
        return `  • [${t}] ${b}`;
      }).join("\n") + `\n\n`
    : "";

  const phoneDigits = customerPhone.replace(/^whatsapp:/, "");
  // Show the admin where the suggested reply came from so they can
  // approve confidently when it's from the curated FAQ, or push back
  // when it's invented from AI.
  const source = analysis?.sourceRowId
    ? `📚 المصدر: قاعدة الـ FAQ — ${analysis.sourceRowId}`
    : analysis
      ? `🧠 المصدر: AI (لا يوجد صف مشابه في الـ FAQ)`
      : "";
  // CRM classifier badges (collapsed to one line). Skip values that
  // came back empty.
  const classifierLine = analysis ? (() => {
    const parts: string[] = [];
    if (analysis.customerType) parts.push(analysis.customerType);
    if (analysis.caseType) parts.push(analysis.caseType);
    if (analysis.complaintType) parts.push(analysis.complaintType);
    if (analysis.bookingStatus && analysis.bookingStatus !== "NONE") parts.push(`booking:${analysis.bookingStatus}`);
    return parts.length ? `🏷️ ${parts.join(" · ")}\n\n` : "";
  })() : "";
  // URGENT cases get a banner so the admin can't miss them in the chat.
  const urgentBanner = analysis?.priority === "URGENT" ? `🚨🚨🚨 ${analysis.priorityLabel}\n\n` : "";
  // PREVIEW MODE preamble — admin must approve before customer sees anything
  const previewBanner = `⚠️ وضع المعاينة - لم يُرسل للعميل\n\n`;
  const stageLine = `📊 مرحلة العميل: ${stageBadge(safe.customerStage)} (${STAGE_LABEL_AR[safe.customerStage]})\n\n`;
  const notice = analysis
    ? (
        `${urgentBanner}${previewBanner}` +
        `📩 رسالة العميل: ${question}\n` +
        `👤 ${profileName} (${phoneDigits})\n\n` +
        stageLine +
        contextBlock +
        classifierLine +
        `🧠 فهمت من العميل: ${analysis.interpretation}\n\n` +
        `💡 ردي المقترح بناءً على مرحلته:\n${analysis.suggestedReply}\n\n` +
        `${source}\n\n` +
        `هل هذا صح؟ ✅ نعم / ❌ لا`
      )
    : (
        `${previewBanner}` +
        `📩 رسالة العميل: ${question}\n` +
        `👤 ${profileName} (${phoneDigits})\n\n` +
        stageLine +
        contextBlock +
        `⚠️ تحليل AI تعذّر — اكتب الرد للعميل مباشرة وراح يوصله`
      );
  // Routing: if this conversation has an assigned staff member (auto or
  // manual), send the proposal to that one person. Otherwise broadcast
  // to the full SALES_WHATSAPP_NUMBERS list.
  const { data: assignedRow } = await supabase
    .from("whatsapp_sessions")
    .select("assigned_staff_phone, profile_name")
    .eq("phone", customerPhone)
    .maybeSingle();
  const assigned = (assignedRow as { assigned_staff_phone?: string | null } | null)?.assigned_staff_phone;
  const assignedName = (assignedRow as { profile_name?: string } | null)?.profile_name;

  // Track COMPLAINT cases as wa_complaints rows so the monitor dashboard
  // gets its own curated queue with severity + status + resolution notes.
  if (analysis && analysis.caseType === "COMPLAINT") {
    const severity = analysis.priority === "URGENT" ? "urgent" : "normal";
    await supabase.from("wa_complaints").insert({
      customer_phone: customerPhone,
      customer_name: assignedName || profileName,
      complaint_type: analysis.complaintType,
      severity,
      description: question.slice(0, 1000),
      assigned_staff_phone: assigned || null,
      source: "ai",
    });
  }
  const targets = assigned ? [assigned] : staffList("SALES_WHATSAPP_NUMBERS");
  await Promise.all(targets.map(num => sendStaffNotice(num, notice)));
}

function isAdminPhone(from: string): boolean {
  return staffList("SALES_WHATSAPP_NUMBERS").includes(from);
}

async function getOldestPendingProposal(
  supabase: ReturnType<typeof createClient>,
): Promise<ProposalRow | null> {
  // LATEST pending proposal, not oldest — admin's "نعم/لا" on WhatsApp
  // naturally targets the most recent notification she received, not the
  // oldest one in the queue. (Function name kept for callsite stability.)
  const { data } = await supabase
    .from("whatsapp_admin_proposals")
    .select("*")
    .in("status", [
      "pending_reply_approval",   // admin reviewing AI suggestion (نعم / لا)
      "pending_correction",       // admin typing the corrected reply
      "pending_sheet_approval",   // admin deciding whether to save to Excel
      "pending_category_choice",  // admin typing preferred category
    ])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ProposalRow | null) || null;
}

function isAffirmative(text: string): boolean {
  // ٤ نوفمبر ٢٠٢٦: «تماما» ما انحسبت موافقة → ضاع تعديل الترتيب وانحوّل للزميل. نطبّع الصيغ الشائعة قبل المقارنة:
  //    تنوين/ألف آخر الكلمة («تماما»)، تكرار الحرف الأخير («تمامم»، «اوكيي»)، التشكيل، الإيموجي (👍 ✅ 👌).
  if (/^\s*(?:👍|✅|👌|🙏|✔️?)+\s*$/u.test(String(text || ""))) return true;
  const t = String(text || "").trim().toLowerCase()
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[!.،,؟?]+$/g, "")
    .replace(/(.)\1+$/u, "$1")
    .replace(/^(تمام|اوكي|اوك|زين|اكيد|أكيد|طيب|ماشي|صح)ا$/u, "$1")
    .replace(/^اوكيه$/u, "اوكي").replace(/^(?:ok+|okay|okey)$/u, "ok").replace(/^(?:yes+|yep|ya)$/u, "yes");
  if (["طيب","تمم","ايه","إيه","يب","يس","موافقين","تمام تمام"].includes(t)) return true;
  // "تم" is the new affirmative token used by step 4 ("save to suggested
  // category") in the admin correction flow — also keep all the old yeses.
  return ["نعم","تم","ايوه","أيوه","ايوا","أيوا","موافق","تمام","صح","صحيح","اي","أجل","اجل","زين","اكيد","أكيد","ماشي","yes","y","ok","اوكي","اوك"]
    .some(w => t === w || t.startsWith(w + " ") || t.startsWith(w + "."));
}
// ٤ نوفمبر ٢٠٢٦ (عميل حقيقي): «كل شي صح» و«مليون مره قلت ايوا» ما انحسبت موافقة → طلال سأل نفس السؤال ٤ مرات.
//    موافقة = كلمة إيجاب في أي مكان بالرسالة، بلا نفي ولا طلب تغيير.
function isYesish(text: string): boolean {
  const t = String(text || "").trim();
  // «تمام بس غير التاريخ ١٥» = موافقة + تعديل → مو موافقة صافية (التعديل يتعالج).
  if (/(?:^|\s)(?:لا|مو|مش|مب|ما)\s|غيّ?ر|عدّ?ل|بدّ?ل|بس\s/.test(t)) return false;
  if (isAffirmative(t)) return true;   // «ايوه صح السفر ١١» = موافقة (التناقض مع البيانات يمسكه فحص الكرت)
  if (/[0-9٠-٩]/.test(t)) return false;
  return /(?:^|\s)(?:ايوا|ايوه|إيوه|أيوه|أيوا|ايه|إيه|نعم|صح|صحيح|مضبوط|تمام|اوكي|اوك|ok|yes|اكيد|أكيد|موافق|أجل|اجل|زين|ماشي|يب|يس)(?=\s|$|[!.،؟?])|كل\s*(?:شي|شيء)\s*(?:صح|تمام|مضبوط)|كله\s*(?:صح|تمام)|المعلومات\s*صح/i.test(t);
}
// 🕋 ٥ نوفمبر ٢٠٢٦: جواب سؤال «وحتى فندق المدينة أغيّره لك بجانب الحرم؟» → yes / no / null (ما له علاقة).
function haramMadinahAnswer(text: string): "yes" | "no" | null {
  const t = String(text || "").trim();
  // «خليه جنب الحرم / بجانب الحرم» = إيه (حادثة ٥ نوفمبر: «حتى فندق المدينه خليه جنب الحرم» انحسبت «لا»).
  if (/(?:جنب|بجنب|بجانب|جمب|قريب\s*من)\s*(?:ال)?حرم/.test(t) && !/(?:لا|ما|مو|مش)\s*(?:احتاج|أحتاج|ابي|أبي|ابغى|أبغى|يحتاج)?\s*(?:فندق\s*)?(?:ال)?مدين/.test(t)) return "yes";
  // رفض: «لا خله/خليه/عادي/ما يحتاج/ما ابي/مو لازم/زين كذا» أو «لا» لحالها.
  if (/^\s*(?:لا|لأ|لاء|no)\s*[.!،]*\s*$/i.test(t) || /(?:خل(?:ي)?ه|خلها|خليها)\s*(?:زي\s*ما\s*هو|كذا|نفسه|مثل\s*ما\s*هو|[.!،]*\s*$)|عادي|ما\s*(?:يحتاج|احتاج|أحتاج|ابي|أبي|يبي)|مو\s*لازم|مب\s*لازم|مش\s*لازم|زين\s*كذا|كويس\s*كذا|بس\s*مك[ةه]/.test(t)) {
    if (!/غيّ?ر|بدّ?ل/.test(t.replace(/(?:لا|ما)\s*(?:تغيّ?ر|تبدّ?ل)/g, ""))) return "no";
  }
  if (/(?:لا|ما)\s*(?:تغيّ?ر|تبدّ?ل)/.test(t)) return "no";
  if (isYesish(t) || /^\s*(?:ايوه|إيوه|أيوه|ايوا|أيوا|ايه|إيه|اي|أي|نعم|اكيد|أكيد|يب|يس|اوكي|ok)\b/i.test(t) || /يا\s*ريت|ياريت|ليت|ابي|أبي|ابغى|أبغى|ودي|طبعا|طبعاً|حلو|ممتاز|يكون\s*أحسن|يكون\s*احسن|غيّ?ر|بدّ?ل|حتى\s*(?:فندق\s*)?المدين|المدين[ةه]?\s*(?:بعد|كمان|برضو|برضه)|الثنين|الاثنين|كلهم|كلها/.test(t)) return "yes";
  return null;
}
// فندق المدينة (الاسم + نوع الغرفة) من سطور HOTELS في البرنامج المرسل.
function madinahHotelFromRaw(raw: string): { name: string; room: string } | null {
  const sec = String(raw || "").split(/\nHOTELS:\s*\n/)[1] || "";
  for (const line of sec.split("\n")) {
    if (!line.trim()) break;
    const p = line.split("|").map(x => x.trim());
    if (p.length >= 4 && /madin|المدين/i.test(p[1] || "")) return { name: p[0], room: String(p[3] || "").replace(/\s*\(يتسع[^)]*\)\s*$/, "").trim() };
  }
  return null;
}
function s0IntakeInactive(session: unknown): boolean { return !!session && (session as { intake_active?: boolean | null }).intake_active !== true; }
function isNegative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return ["لا","كلا","مرفوض","ارفض","أرفض","no","n"]
    .some(w => t === w || t.startsWith(w + " ") || t.startsWith(w + "."));
}

// Composes the "save to Excel?" prompt sent to admin after the customer
// reply has been delivered. Used after both step 1 YES and step 2 corrections.
function buildSaveProposalMessage(proposal: ProposalRow, finalReply: string): string {
  const sub = proposal.proposed_sub_intent ? ` / ${proposal.proposed_sub_intent}` : "";
  return (
    `تم الرد على العميل 👍\n\n` +
    `هل تريد حفظ هذا الرد في Excel؟\n` +
    `الكاتيجوري المقترح: ${proposal.proposed_intent}${sub}\n` +
    `السبب: مطابقة لسؤال "${proposal.customer_question}"\n` +
    `الرد المحفوظ: ${finalReply}\n\n` +
    `• تم → احفظ بالكاتيجوري المقترح\n` +
    `• لا → اختر كاتيجوري ثاني\n` +
    `• خاص → ما تحفظ (الرد خاص بهذا العميل فقط)`
  );
}

// Detect when admin wants to skip saving entirely (answer was specific
// to this customer's context and shouldn't be generalized in the FAQ).
function isSkipSave(text: string): boolean {
  const t = text.trim().toLowerCase();
  return ["خاص", "خاص بالعميل", "لا تحفظ", "لاتحفظ", "ما تحفظ", "متحفظ", "skip", "private"]
    .some(w => t === w || t.startsWith(w + " ") || t.startsWith(w + "."));
}

async function handleAdminResponse(args: {
  supabase: ReturnType<typeof createClient>;
  proposal: ProposalRow;
  text: string;
  adminFrom: string;
}): Promise<void> {
  const { supabase, proposal, text, adminFrom } = args;
  const yes = isAffirmative(text);
  const no  = isNegative(text);
  // PREVIEW MODE: never reach the customer. Admin's approve / correct
  // both close the proposal but the suggested_reply or correction is
  // recorded for future FAQ training instead of sent. Admin gets a
  // confirmation that explicitly notes the customer didn't receive
  // anything, so there's no ambiguity.
  const aiMode = await getAiMode(supabase);
  const isPreview = aiMode === "PREVIEW";

  // ── STEP 1: admin reviewing AI suggestion ──────────────────────────────
  // Excel-save step is suspended — once the customer receives the reply
  // the proposal is closed. Re-saving to Excel will move into the
  // dashboard once it has proposal-action UI.
  if (proposal.status === "pending_reply_approval") {
    if (yes) {
      if (!isPreview) {
        await sendCustomerReply(supabase, proposal.customer_phone, proposal.suggested_reply);
      }
      // Save to chat_answers only if this is a NEW answer (no source_row_id).
      // approve + source_row_id موجود → الرد جاي من شيت موجود، لا تكرّر.
      const sourceRowId = (proposal as { source_row_id?: string | null }).source_row_id || null;
      let saved = false;
      if (!sourceRowId && proposal.suggested_reply) {
        saved = await appendChatAnswerRow({
          intent: proposal.proposed_intent,
          subIntent: proposal.proposed_sub_intent,
          keywords: proposal.proposed_keywords || [],
          sampleQ: proposal.customer_question,
          answer: proposal.suggested_reply,
          stage: (proposal as { customer_stage?: string | null }).customer_stage || null,
        });
        if (saved) void triggerSyncSheets();
      }
      await supabase.from("whatsapp_admin_proposals")
        .update({
          status: saved ? "completed_added" : "completed_skipped",
          decided_at: new Date().toISOString(),
        })
        .eq("id", proposal.id);
      const saveTail = saved
        ? "\n📚 حفظت الجواب في FAQ"
        : sourceRowId
          ? `\n📚 موجود أصلاً في FAQ (${sourceRowId}) — ما حفظت نسخة جديدة`
          : "";
      await sendStaffNotice(adminFrom,
        (isPreview
          ? "✅ تمت الموافقة — لم يُرسل للعميل (وضع المعاينة)"
          : "تم الرد على العميل 👍") + saveTail);
      return;
    }
    if (no) {
      await supabase.from("whatsapp_admin_proposals")
        .update({ status: "pending_correction" })
        .eq("id", proposal.id);
      await sendWhatsapp(adminFrom,
        isPreview
          ? `تمام 👌 وش الرد الصحيح؟ اكتبه وراح أحفظه (في وضع المعاينة لن يُرسل للعميل)`
          : `تمام 👌 كيف تبين الرد يكون على العميل اكتب الصيغة مباشرة`);
      return;
    }
    await sendWhatsapp(adminFrom,
      `رد بـ "نعم" لإرسال الرد المقترح للعميل أو "لا" لتعديل الرد`);
    return;
  }

  // ── STEP 2 (corrected path): admin typed the actual reply text ────────
  if (proposal.status === "pending_correction") {
    const finalReply = text.trim();
    if (!finalReply) {
      await sendWhatsapp(adminFrom, `اكتب الرد كاملاً عشان أرسله للعميل`);
      return;
    }
    if (!isPreview) {
      await sendCustomerReply(supabase, proposal.customer_phone, finalReply);
    }
    // التصحيح = جواب جديد دائماً → احفظه في FAQ
    const saved = await appendChatAnswerRow({
      intent: proposal.proposed_intent,
      subIntent: proposal.proposed_sub_intent,
      keywords: proposal.proposed_keywords || [],
      sampleQ: proposal.customer_question,
      answer: finalReply,
      stage: (proposal as { customer_stage?: string | null }).customer_stage || null,
    });
    if (saved) void triggerSyncSheets();
    await supabase.from("whatsapp_admin_proposals")
      .update({
        status: saved ? "completed_added" : "completed_skipped",
        suggested_reply: finalReply,
        decided_at: new Date().toISOString(),
      })
      .eq("id", proposal.id);
    const saveTail = saved
      ? "\n📚 حفظت الرد المصحّح في FAQ"
      : "\n📚 ما قدرت أحفظ — تأكدي من صلاحيات الشيت";
    await sendStaffNotice(adminFrom,
      (isPreview
        ? "✅ تم حفظ الرد — لم يُرسل للعميل (وضع المعاينة)"
        : "تم الرد على العميل 👍") + saveTail);
    return;
  }

  // ── STEP 3: admin deciding whether to save to Excel ───────────────────
  if (proposal.status === "pending_sheet_approval") {
    // Re-load the (possibly corrected) suggested_reply.
    const { data: fresh } = await supabase
      .from("whatsapp_admin_proposals")
      .select("suggested_reply")
      .eq("id", proposal.id)
      .maybeSingle();
    const finalReply = (fresh?.suggested_reply as string | undefined) || proposal.suggested_reply;

    // "خاص" — admin marks the reply as customer-specific. No chat_answers
    // row is created (so it doesn't get matched for other customers
    // asking similar questions). Just close out the proposal.
    if (isSkipSave(text)) {
      await supabase.from("whatsapp_admin_proposals")
        .update({ status: "completed_skipped", decided_at: new Date().toISOString() })
        .eq("id", proposal.id);
      await sendWhatsapp(adminFrom, `تمام 👌 ما حفظت — الرد خاص بهذا العميل`);
      return;
    }

    if (yes) {
      // Save to the AI-suggested category immediately.
      const ok = await appendChatAnswerRow({
        intent: proposal.proposed_intent,
        subIntent: proposal.proposed_sub_intent,
        keywords: proposal.proposed_keywords,
        sampleQ: proposal.customer_question,
        answer: finalReply,
        stage: (proposal as { customer_stage?: string | null }).customer_stage || null,
      });
      if (ok) {
        await supabase.from("whatsapp_admin_proposals")
          .update({ status: "completed_added", decided_at: new Date().toISOString() })
          .eq("id", proposal.id);
        await sendWhatsapp(adminFrom, `تم الحفظ 👍`);
        void triggerSyncSheets();
      } else {
        await sendWhatsapp(adminFrom,
          `❌ ما قدرت أحفظ للشيت تأكدي إن tourism-sync@tourism-sysc-495108.iam.gserviceaccount.com عنده صلاحية Editor`);
      }
      return;
    }
    if (no) {
      // Ask admin for preferred category.
      await supabase.from("whatsapp_admin_proposals")
        .update({ status: "pending_category_choice" })
        .eq("id", proposal.id);
      await sendWhatsapp(adminFrom, `تمام 👌 وين تفضل نحفظه`);
      return;
    }
    await sendWhatsapp(adminFrom,
      `رد بـ "تم" للحفظ، "لا" لاختيار كاتيجوري ثاني، أو "خاص" لو الرد لا يُعمَّم`);
    return;
  }

  // ── STEP 4: admin typed preferred category ────────────────────────────
  if (proposal.status === "pending_category_choice") {
    const raw = text.trim();
    if (!raw) {
      await sendWhatsapp(adminFrom, `اكتب اسم الكاتيجوري عشان أحفظه فيه`);
      return;
    }
    // Accept "Intent / Sub-intent" or just a single value (treated as sub-intent).
    let intent = proposal.proposed_intent;
    let subIntent = raw;
    if (raw.includes("/")) {
      const parts = raw.split("/").map(s => s.trim()).filter(Boolean);
      intent = parts[0] || intent;
      subIntent = parts[1] || "";
    }
    const { data: fresh } = await supabase
      .from("whatsapp_admin_proposals")
      .select("suggested_reply")
      .eq("id", proposal.id)
      .maybeSingle();
    const finalReply = (fresh?.suggested_reply as string | undefined) || proposal.suggested_reply;
    const ok = await appendChatAnswerRow({
      intent,
      subIntent,
      keywords: proposal.proposed_keywords,
      sampleQ: proposal.customer_question,
      answer: finalReply,
      stage: (proposal as { customer_stage?: string | null }).customer_stage || null,
    });
    if (ok) {
      await supabase.from("whatsapp_admin_proposals")
        .update({
          status: "completed_added",
          proposed_intent: intent,
          proposed_sub_intent: subIntent,
          decided_at: new Date().toISOString(),
        })
        .eq("id", proposal.id);
      await sendWhatsapp(adminFrom, `تم الحفظ 👍`);
      void triggerSyncSheets();
    } else {
      await sendWhatsapp(adminFrom,
        `❌ ما قدرت أحفظ تأكدي من الصلاحيات على الشيت`);
    }
    return;
  }
}

// ── Google Sheets write helpers ──────────────────────────────────────────
async function getGoogleSheetsToken(scope: string): Promise<string | null> {
  const saStr = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
  if (!saStr) return null;
  let sa: { client_email: string; private_key: string };
  try { sa = JSON.parse(saStr); } catch { return null; }

  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => btoa(JSON.stringify(o))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const header = enc({ alg: "RS256", typ: "JWT" });
  const payload = enc({
    iss: sa.client_email, scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  });
  const pem = sa.private_key.replace(/\\n/g, "\n");
  const keyBody = pem.replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(keyBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const rawSig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey,
    new TextEncoder().encode(`${header}.${payload}`));
  const sig = btoa(String.fromCharCode(...new Uint8Array(rawSig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${payload}.${sig}`,
    }).toString(),
  });
  const data = await res.json();
  return data.access_token || null;
}

async function appendChatAnswerRow(args: {
  intent: string;
  subIntent: string;
  keywords: string[];
  sampleQ: string;
  answer: string;
  stage?: string | null;   // INQUIRY | OFFER_SENT | ... | null = ALL
}): Promise<boolean> {
  const token = await getGoogleSheetsToken(
    "https://www.googleapis.com/auth/spreadsheets");
  if (!token) return false;

  // ترتيب الأعمدة يطابق عناوين شيت «ALEZZ Chat» الفعلية:
  // A: ID | B: Intent | C: Sub-intent | D: Stage | E: status |
  // F: Keywords | G: sample Q | H: Answer_SA1 | I: Answer_SA2 |
  // J: Answer clarification | K: Answer_OM | L: Status | M: وقت السؤال
  const newId = `PKG_AI_${Date.now()}`;
  // وقت السؤال بتوقيت مسقط (UTC+4)، صيغة قابلة للقراءة YYYY-MM-DD HH:MM
  const askedAt = new Date(Date.now() + 4 * 60 * 60 * 1000)
    .toISOString().replace("T", " ").slice(0, 16);
  const row = [
    newId,                     // A: ID
    args.intent,               // B: Intent
    args.subIntent,            // C: Sub-intent
    args.stage || "",          // D: Stage (فارغ = ينطبق على كل المراحل)
    "Active",                  // E: status
    args.keywords.join(", "),  // F: Keywords
    args.sampleQ,              // G: sample Q
    args.answer,               // H: Answer_SA1
    "",                        // I: Answer_SA2
    "",                        // J: Answer clarification
    args.answer,               // K: Answer_OM (نفس النص — Claude يكتب بالخليجي)
    "AI-generated",            // L: Status
    askedAt,                   // M: وقت السؤال
  ];

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${ALEZZ_CHAT_SPREADSHEET_ID}` +
    `/values/Sheet1!A1:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    console.error("Sheet append failed", res.status, await res.text());
    return false;
  }
  return true;
}

// Delete rows from the ALEZZ Chat sheet by their ID column (column A) value.
// Used by the admin cleanup endpoint to remove duplicate/AI-generated rows.
async function deleteChatAnswerRowsByIds(ids: string[]): Promise<{
  deleted: number; not_found: string[]; sheet_id: number | null;
}> {
  const token = await getGoogleSheetsToken(
    "https://www.googleapis.com/auth/spreadsheets");
  if (!token) throw new Error("no google sheets token");

  // First, find the numeric sheet ID for "Sheet1" (needed by batchUpdate).
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ALEZZ_CHAT_SPREADSHEET_ID}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } });
  const meta = await metaRes.json();
  const firstSheet = (meta.sheets && meta.sheets[0]) || null;
  const sheetId = firstSheet?.properties?.sheetId;
  if (typeof sheetId !== "number") throw new Error("could not resolve Sheet1 sheetId");

  // Read column A to find row indices.
  const valsRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ALEZZ_CHAT_SPREADSHEET_ID}/values/Sheet1!A1:A1000`,
    { headers: { Authorization: `Bearer ${token}` } });
  const vals = await valsRes.json();
  const idCol: string[][] = vals.values || [];

  const wanted = new Set(ids.map(s => s.trim()));
  const idx0Based: number[] = []; // 0-based sheet row positions, skipping header row 0
  for (let i = 1; i < idCol.length; i++) {
    const cell = String((idCol[i] && idCol[i][0]) || "").trim();
    if (wanted.has(cell)) idx0Based.push(i);
  }
  const foundIds = new Set(idx0Based.map(i => idCol[i][0]));
  const notFound = ids.filter(id => !foundIds.has(id));

  if (idx0Based.length === 0) {
    return { deleted: 0, not_found: notFound, sheet_id: sheetId };
  }

  // Delete bottom-up so row indices don't shift mid-batch.
  idx0Based.sort((a, b) => b - a);
  const requests = idx0Based.map(i => ({
    deleteDimension: {
      range: { sheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 },
    },
  }));
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ALEZZ_CHAT_SPREADSHEET_ID}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
  if (!batchRes.ok) {
    throw new Error(`sheet batchUpdate failed: ${batchRes.status} ${await batchRes.text()}`);
  }
  return { deleted: idx0Based.length, not_found: notFound, sheet_id: sheetId };
}

async function triggerSyncSheets(): Promise<void> {
  const jwt = Deno.env.get("LEGACY_ANON_JWT") || "";
  try {
    await fetch("https://ofotvacszlmrqxzfjmtn.supabase.co/functions/v1/sync-sheets", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, apikey: jwt },
    });
  } catch (e) {
    console.warn("triggerSyncSheets failed", (e as Error).message);
  }
}

// ── HTTP entry point ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const urlEarly = new URL(req.url);
  const isAdminAction = !!urlEarly.searchParams.get("admin_action");

  // Meta webhook verification handshake (GET). عند ضبط الويبهوك في لوحة Meta،
  // ترسل Meta طلب GET فيه hub.mode=subscribe و hub.verify_token و hub.challenge.
  // لو الـ verify_token طابق سرّنا، نرجّع hub.challenge كنص عادي بحالة 200.
  // نفحصه قبل health-check حتى لا يبتلعه الرد العام.
  if (req.method === "GET" && !isAdminAction) {
    const mode = urlEarly.searchParams.get("hub.mode");
    const verifyToken = urlEarly.searchParams.get("hub.verify_token");
    const challenge = urlEarly.searchParams.get("hub.challenge");
    if (mode === "subscribe" && challenge !== null) {
      const expected = (Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "").trim();
      if (expected && verifyToken === expected) {
        return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      // verify_token خاطئ — نرفض حتى لا يُربَط الويبهوك بسرّ غير صحيح.
      return new Response("Forbidden", { status: 403 });
    }
    // Plain GET with no hub params → health-check style probe.
    return new Response("WhatsApp-Router OK (Cloud API)", { headers: { "Content-Type": "text/plain" } });
  }
  // Admin endpoints accept both GET (browser dashboard) and POST (curl).
  // Meta webhooks are always POST.
  if (req.method !== "POST" && !isAdminAction) {
    return new Response("Method not allowed", { status: 405 });
  }

  // Admin: delete rows from the ALEZZ Chat sheet by ID. Gated by the legacy
  // anon JWT (sent in Authorization header) since the function is otherwise
  // open to Twilio. Usage:
  //   POST /functions/v1/WhatsApp-Router?admin_action=delete_chat_rows
  //   Authorization: Bearer <legacy anon JWT>
  //   body: {"ids": ["PKG_AI_xxxx", "PKG_AI_yyyy"]}
  const url = new URL(req.url);
  if (url.searchParams.get("admin_action") === "delete_chat_rows") {
    const expected = Deno.env.get("LEGACY_ANON_JWT") || "";
    const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!expected || got !== expected.trim()) {
      return new Response(JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: JSON_HEADERS });
    }
    try {
      const payload = await req.json();
      const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
      const result = await deleteChatAnswerRowsByIds(ids);
      return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: JSON_HEADERS });
    }
  }

  // CORS for browser-based admin dashboard (hosted on GitHub Pages).
  // Permissive because everything below this point is JWT-gated anyway.
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
  };
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Shared auth helpers — placed up here so every admin endpoint below
  // can reference them. checkAuth = legacy master JWT only (admin).
  // checkAuthOrSession = legacy JWT OR a valid staff session token
  // (the bearer returned by staff_login). Use checkAuth for endpoints
  // that should remain admin-only; checkAuthOrSession everywhere else.
  const jsonCors = { ...JSON_HEADERS, ...corsHeaders };
  const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }),
    { status: 401, headers: jsonCors });
  const forbidden = (msg = "ليس لديك صلاحية لهذه العملية") =>
    new Response(JSON.stringify({ error: msg }), { status: 403, headers: jsonCors });
  // الصلاحيات الافتراضية للموظف (الأدمن دائماً كامل الصلاحية).
  const PERM_DEFAULTS: Record<string, boolean> = {
    view_proposals: false, send_messages: true, delete_messages: false,
    manage_offers: false, transfer_conversations: true, manage_ai: false,
  };
  const staffHasPerm = (
    staff: { permissions?: Record<string, unknown> | null } | null, key: string,
  ): boolean => {
    if (!staff) return true; // أدمن (legacy JWT) — صلاحية كاملة
    const p = (staff.permissions || {}) as Record<string, unknown>;
    if (key in p) return !!p[key];
    return PERM_DEFAULTS[key] ?? false;
  };
  // بوابة: تتحقق من المصادقة ثم الصلاحية. ترجع Response خطأ، أو null لو مسموح.
  const requirePerm = async (req: Request, key: string): Promise<Response | null> => {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const caller = await getCallerStaff(req); // null = أدمن (صلاحية كاملة)
    if (caller && !staffHasPerm(caller, key)) return forbidden();
    return null;
  };
  const checkAuth = (req: Request): boolean => {
    const expected = (Deno.env.get("LEGACY_ANON_JWT") || "").trim();
    const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    return !!expected && got === expected;
  };
  const checkAuthOrSession = async (req: Request): Promise<boolean> => {
    if (checkAuth(req)) return true;
    return !!(await getCallerStaff(req));
  };
  // بوابة المالكة الموحّدة لإدارة أمان الموظفين: تقبل إمّا توكن الأدمن (legacy
  // JWT من داشبورد الواتساب) أو مفتاح المالكة COMPANIES_ADMIN_SECRET (من
  // companies-admin). فالموافقة من أي واجهة تشتغل على نفس الجداول → موحّدة.
  const ownerGate = (req: Request): boolean => {
    if (checkAuth(req)) return true;
    const sec = (Deno.env.get("COMPANIES_ADMIN_SECRET") || "").trim();
    const got = (req.headers.get("x-admin-secret") || "").trim();
    return !!sec && got === sec;
  };
  // إذا كان الطلب باستخدام staff session، يرجع صف الموظف. وإلا (الادمن
  // باستخدام legacy JWT أو غير مصرّح) يرجع null. تستخدم لتخصيص المحتوى
  // حسب الموظف الفعلي اللي عامل تسجيل دخول.
  const getCallerStaff = async (req: Request): Promise<{
    phone: string; name: string; role: string; destinations: string[];
    permissions: Record<string, unknown>;
  } | null> => {
    const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!got) return null;
    // الـ legacy JWT للأدمن يطابق tokens تساوي SECRET — ما يكون له staff
    // session مطابق، فهنا الـ select اللي تحت يرجع null عادي.
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("wa_staff_sessions")
      .select("phone, expires_at, revoked_at")
      .eq("token", got)
      .maybeSingle();
    if (!data) return null;
    const row = data as { phone: string; expires_at: string; revoked_at: string | null };
    if (row.revoked_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    const { data: staffRow } = await supabase
      .from("wa_staff")
      .select("phone, name, role, active, destinations, permissions")
      .eq("phone", row.phone)
      .maybeSingle();
    if (!staffRow || !(staffRow as { active: boolean }).active) return null;
    const s = staffRow as { phone: string; name: string; role: string; destinations: string[] | null; permissions: Record<string, unknown> | null };
    return { phone: s.phone, name: s.name, role: s.role, destinations: s.destinations || [], permissions: s.permissions || {} };
  };

  // Admin: token-validity probe. Returns 200 with diagnostic info when
  // the token is correct, 401 otherwise. Useful when the browser shows
  // "unauthorized" but the same token works via curl — lets the dashboard
  // expose what it actually sent vs what the server expected.
  if (url.searchParams.get("admin_action") === "whoami") {
    const expected = (Deno.env.get("LEGACY_ANON_JWT") || "").trim();
    const rawAuth = req.headers.get("authorization") || "";
    const got = rawAuth.replace(/^Bearer\s+/i, "").trim();
    const ok = !!expected && got === expected;
    return new Response(JSON.stringify({
      ok,
      got_length: got.length,
      expected_length: expected.length,
      got_prefix: got.slice(0, 20),
      got_suffix: got.slice(-20),
      expected_prefix: expected.slice(0, 20),
      expected_suffix: expected.slice(-20),
      raw_auth_header_length: rawAuth.length,
    }), {
      status: ok ? 200 : 401,
      headers: { ...JSON_HEADERS, ...corsHeaders },
    });
  }

  // Admin: dashboard data feed. Returns a small JSON snapshot for the
  // browser-based dashboard (latifahmunassar-ctrl.github.io/dashboard):
  //   • pending admin proposals (so the admin sees what's waiting on her)
  //   • last 50 audit rows (so silent-failure cases surface)
  //   • daily counts (received / completed / stalled / errored)
  //   • current pending proposals total
  if (url.searchParams.get("admin_action") === "dashboard_data") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    // إذا كان staff عامل دخول (مو admin)، نعرف هويته عشان نرجعها للداش
    // بورد. الداش يستخدمها لفلترة المحادثات حسب وجهات الموظف.
    const callerStaff = await getCallerStaff(req);
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
      const todayISO = todayStart.toISOString();

      const { data: pending } = await supabase
        .from("whatsapp_admin_proposals")
        .select("id, customer_phone, customer_profile_name, customer_question, status, created_at, proposed_intent, proposed_sub_intent, proposed_keywords, customer_type, case_type, complaint_type, booking_status, priority, priority_label, interpretation, customer_goal, suggested_reply, customer_stage, source_row_id, source_confirmations, extracted_data, missing_data, business_metadata")
        .in("status", [
          "pending_reply_approval", "pending_correction",
          "pending_sheet_approval", "pending_category_choice",
        ])
        // URGENT first (priority IS NOT NULL sorts before NULL when DESC
        // with nullsfirst in PostgREST). Then newest first.
        .order("priority", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(100);

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: audit } = await supabase
        .from("wa_message_audit")
        .select("id, from_phone, body, status, received_at, completed_at, error_message")
        .gte("received_at", since24h)
        .order("received_at", { ascending: false })
        .limit(50);

      const countWhere = async (
        table: string, status: string | null,
      ): Promise<number> => {
        let q = supabase.from(table).select("id", { count: "exact", head: true })
          .gte("received_at", todayISO);
        if (status) q = q.eq("status", status);
        const { count } = await q;
        return count ?? 0;
      };
      const [received, completed, stalled, errored] = await Promise.all([
        countWhere("wa_message_audit", null),
        countWhere("wa_message_audit", "completed"),
        countWhere("wa_message_audit", "stalled"),
        countWhere("wa_message_audit", "errored"),
      ]);

      // Global AI toggle + per-conversation overrides for the dashboard
      // toggles. Conversations = sessions that had activity in the last
      // 24h, with their per-conversation ai_enabled value (null = inherit).
      const { data: settingRows } = await supabase
        .from("wa_settings")
        .select("key, value")
        .in("key", ["ai_global_enabled", "ai_force_off_all", "ai_force_on_all", "ai_mode"]);
      const settingMap = new Map<string, unknown>();
      for (const r of (settingRows as Array<{ key: string; value: unknown }> ?? [])) {
        settingMap.set(r.key, r.value);
      }
      const toBool = (v: unknown, fallback: boolean): boolean =>
        v === true ? true :
        v === false ? false :
        typeof v === "string" ? v.toLowerCase() === "true" :
        fallback;
      const globalAiEnabled = toBool(settingMap.get("ai_global_enabled"), true);
      const aiForceOffAll  = toBool(settingMap.get("ai_force_off_all"), false);
      const aiForceOnAll   = toBool(settingMap.get("ai_force_on_all"),  false);
      // ai_mode is the new authoritative 3-state value the dashboard
      // toggles on. Defaults to ON for installs from before migration
      // 025 where the row may not exist yet.
      const rawMode = settingMap.get("ai_mode");
      const modeStr = typeof rawMode === "string" ? rawMode.toUpperCase().trim() : "";
      const aiMode = (modeStr === "ON" || modeStr === "PREVIEW" || modeStr === "OFF")
        ? modeStr
        : (globalAiEnabled ? "ON" : "OFF");

      // Time range + customer-phone filtering for the conversations panel.
      // range: today (24h) | week (7d) | month (30d) | all | custom
      // custom uses from / to (YYYY-MM-DD, inclusive of the 'to' day)
      const range = url.searchParams.get("range") || "today";
      const customerPhoneFilter = (url.searchParams.get("customer_phone") || "").trim();
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      let sessionsSince: string;
      let sessionsUntil: string | null = null;
      // حدود مرفوعة تستوعب أحجاماً عالية (100+ عميل/يوم) دون إخفاء محادثات.
      // المعالجة batched (استعلامان فقط مهما كان العدد) فالرفع آمن.
      let sessionsLimit = 300;   // today / default
      if (range === "week")       { sessionsSince = new Date(now - 7 * DAY_MS).toISOString();  sessionsLimit = 1000; }
      else if (range === "month") { sessionsSince = new Date(now - 30 * DAY_MS).toISOString(); sessionsLimit = 2000; }
      else if (range === "all")   { sessionsSince = "1970-01-01T00:00:00Z";                    sessionsLimit = 5000; }
      else if (range === "custom") {
        const fromStr = url.searchParams.get("from");
        const toStr = url.searchParams.get("to");
        sessionsSince = fromStr ? new Date(fromStr + "T00:00:00Z").toISOString() : "1970-01-01T00:00:00Z";
        if (toStr) {
          const toDate = new Date(toStr + "T23:59:59.999Z");
          sessionsUntil = toDate.toISOString();
        }
        sessionsLimit = 2000;
      }
      else                        { sessionsSince = since24h; /* today / default */ }

      // فلتر «تم إرسال متابعة»: server-side على followup_due_date نفسه،
      // مستقلّ تماماً عن نطاق الفترة العام (last_message_at). عند تفعيله
      // نعرض فقط من followup_done=true و followup_due_date ضمن [fu_from, fu_to].
      const followupMode = url.searchParams.get("followup") === "1";
      const fuFrom = (url.searchParams.get("fu_from") || "").trim();
      const fuTo = (url.searchParams.get("fu_to") || "").trim();

      let sessionsQuery = supabase
        .from("whatsapp_sessions")
        .select("phone, profile_name, ai_enabled, last_message_at, last_outbound_at, last_outbound_body, last_opened_at, destination, assigned_staff_phone, assigned_at, assigned_by, customer_stage, label, followup_done, followup_due_date, ad_referral")
        .limit(followupMode ? 2000 : sessionsLimit);
      if (followupMode) {
        sessionsQuery = sessionsQuery
          .eq("followup_done", true)
          .not("followup_due_date", "is", null)
          .order("followup_due_date", { ascending: false });
        if (fuFrom) sessionsQuery = sessionsQuery.gte("followup_due_date", fuFrom);
        if (fuTo)   sessionsQuery = sessionsQuery.lte("followup_due_date", fuTo);
      } else {
        sessionsQuery = sessionsQuery
          .gte("last_message_at", sessionsSince)
          .order("last_message_at", { ascending: false });
        if (sessionsUntil) sessionsQuery = sessionsQuery.lte("last_message_at", sessionsUntil);
      }
      if (customerPhoneFilter) {
        // Substring match on the phone column — admin can paste a partial
        // number (last digits) and still hit the row.
        sessionsQuery = sessionsQuery.ilike("phone", `%${customerPhoneFilter.replace(/[^0-9+]/g, "")}%`);
      }
      const { data: sessions } = await sessionsQuery;

      // Enrich each session with the latest proposal's classification so
      // the dashboard's filters (customer_type / case_type / URGENT) can
      // operate on conversations the same way they do on proposals.
      const phones = (sessions ?? []).map((s: { phone: string }) => s.phone);
      const { data: recentProposals } = phones.length
        ? await supabase
            .from("whatsapp_admin_proposals")
            .select("customer_phone, customer_type, case_type, customer_stage, complaint_type, booking_status, priority, created_at")
            .in("customer_phone", phones)
            .order("created_at", { ascending: false })
        : { data: [] as Array<Record<string, unknown>> };
      // For each phone, keep the LATEST proposal overall (used for
      // priority + complaint_type which only make sense in context of
      // the most recent message). For customer_type and case_type and
      // customer_stage we walk all proposals newest-first and keep the
      // first NON-NULL value — so once a customer is upgraded to VIP
      // (or BOOKING_CONFIRMED), a later un-classified message can't
      // demote them back to NEW_CUSTOMER.
      const latestByPhone = new Map<string, Record<string, unknown>>();
      const customerTypeByPhone = new Map<string, string>();
      const caseTypeByPhone = new Map<string, string>();
      const stageByPhone = new Map<string, string>();
      type Prop = {
        customer_phone: string;
        customer_type?: string | null;
        case_type?: string | null;
        customer_stage?: string | null;
      };
      for (const p of (recentProposals as Prop[] ?? [])) {
        const ph = p.customer_phone;
        if (!latestByPhone.has(ph)) latestByPhone.set(ph, p);
        if (!customerTypeByPhone.has(ph) && p.customer_type) {
          customerTypeByPhone.set(ph, p.customer_type);
        }
        if (!caseTypeByPhone.has(ph) && p.case_type) {
          caseTypeByPhone.set(ph, p.case_type);
        }
        if (!stageByPhone.has(ph) && p.customer_stage) {
          stageByPhone.set(ph, p.customer_stage);
        }
      }
      // Latest INBOUND message body per phone — for the WhatsApp-style
      // preview line under each conversation row.
      const { data: latestAudits } = phones.length
        ? await supabase
            .from("wa_message_audit")
            .select("from_phone, body, received_at")
            .in("from_phone", phones)
            .order("received_at", { ascending: false })
        : { data: [] as Array<Record<string, unknown>> };
      const latestMsgByPhone = new Map<string, { body: string | null; received_at: string }>();
      // أول رسالة نصّية لكل رقم (لكشف حملات الروابط المُعبّأة): latestAudits مرتّبة
      // تنازليًا، فالتكرار الأخير لكل رقم هو الأقدم = الرسالة الأولى. نتجاهل بدائل
      // الوسائط (📷/📎/🎤) لأنها ليست نصًّا مُعبّأً. صفر استعلامات إضافية.
      const firstMsgByPhone = new Map<string, string>();
      for (const a of (latestAudits as Array<{ from_phone: string; body: string | null; received_at: string }> ?? [])) {
        if (!latestMsgByPhone.has(a.from_phone)) {
          latestMsgByPhone.set(a.from_phone, { body: a.body, received_at: a.received_at });
        }
        const bb = String(a.body || "").trim();
        if (bb && !/^[📷📄📎🎤🎥🌟📍👤]/.test(bb)) firstMsgByPhone.set(a.from_phone, bb); // آخر تكرار = الأقدم
      }
      // آخر ردّ **بشري فعلي** لكل عميل — نستبعد البوت/التلقائي فقط: طلال (AI) و«تأكيد
      // تلقائي». «النظام» = إرسال البرنامج (PDF) الذي تبنيه الموظفة وترسله عبر المنصة،
      // فهو ردّ بشري فعلي ويُحتسب. ونستبعد ردود المجاملة القصيرة («ابشر/لحظة»).
      const BOT_SENDERS = new Set(["طلال", "تأكيد تلقائي"]);
      // «ليست ردّاً فعلياً»: مجاملة/إقرار قصير، أو وعد بالإرسال («الآن أرسلك البرنامج»)
      // فالعميل لا يزال ينتظر الردّ/الملف الفعلي.
      const isStaffAck = (t: string | null): boolean => { const s = String(t || "").trim(); if (!s) return true; const n = [...s].length; if (n <= 6) return true; return n <= 15 && /^(شكر|تسلم|تمام|تمم|تم\b|طيب|ماشي|زين|اوك|اوكي|ok|okay|thanks|thx|ابشر|أبشر|تبشر|حاضر|حياك|اهلا|أهلا|هلا|لحظة|لحظه|ثانية|ثواني|دقيقة|دقيقه|👍|🙏|❤|🌹|💚|💐|🤍|يعطيك|جزاك|ممتاز|رائع|حلو|كفو|يسلمو|تسلمو)/i.test(s); };
      const isStaffPromise = (t: string | null): boolean => { const s = String(t || "").trim(); if (!s) return false; if (/أرسلت|ارسلت|رسلت|جهّزت|جهزت|عملت|سويت|بعثت|أعطيت|اعطيت|رتبت|وصلك|وصلت|تفضل|هذا برنامج/.test(s)) return false; return /((الان|الحين|حالا|راح|رح|سوف|توني|تبشر|ابشر|أبشر).{0,10}(ا?رسل|ا?جهز|جهّز|ا?عمل|ا?سوي|ابعث|ا?خلص|ا?كمل|ا?رتب|أرتب))|(^\s*(بأرسل|بارسل|بجهز|باجهز|بأجهز|بسوي|باعمل|بعمل|برتب|بخلص|بكمل|سأرسل|سارسل))|((ثوان|لحظ|دقيق|دقاي).{0,12}(ا?رسل|ا?جهز|ا?عمل|ا?سوي))|(جاري.{0,8}(تجهيز|الت|الإرسال|الارسال|العمل|عمل))/.test(s); };
      // ردّ فعلي قطعاً يضع الكرة بملعب العميل (لا يحتاج AI): سؤال موجّه له، أو تسليم ملف/رابط،
      // أو طلب تأكيد منه. فالعميل هو من يتأخّر بعدها لا الموظف.
      const isStaffQuestion = (t: string | null): boolean => { const s = String(t || "").trim(); if (!s) return false; if (/[؟?]/.test(s)) return true; return /(^|\s)(كم|كام|متى|وين|اين|أين|هل|كيف|ايش|أيش|وش|وشو|تبي|تبغى|تبغون|تبون|تحب|تحبو|تحبون|ودك|عندك|عندكم|تنوون|تخططون|مين)(\s|$|[،.!:])/.test(s); };
      const isStaffDelivery = (t: string | null): boolean => { const s = String(t || ""); return /📎|https?:\/\/|\[ملف|ملف البرنامج/.test(s) || /في انتظار\s*(تاكيد|تأكيد|رد|ردّ|موافق|اختيار|اعتماد)\S{0,3}كم/.test(s); };
      const isDefiniteReply = (t: string | null): boolean => isStaffQuestion(t) || isStaffDelivery(t);
      const { data: humanOuts } = phones.length
        ? await supabase.from("wa_admin_messages").select("customer_phone, sent_at, sent_by, body")
            .in("customer_phone", phones).order("sent_at", { ascending: false }).limit(20000)
        : { data: [] as Array<Record<string, unknown>> };
      const humanRows = (humanOuts as Array<{ customer_phone: string; sent_at: string; sent_by: string | null; body: string | null }> ?? []);
      // المرشّح الذي يحتاج تحقّق Haiku = أحدث رسالة موظف غير-مجاملة وغير-سؤال لكل عميل.
      // (المجاملة قطعاً ليست رداً؛ السؤال قطعاً ردّ — كلاهما يُحسم بالقاعدة بلا AI.)
      const latestCand = new Map<string, { key: string; sent_at: string; body: string | null }>();
      const decided = new Set<string>();
      for (const m of humanRows) {
        const ph = m.customer_phone;
        if (decided.has(ph)) continue;
        if (BOT_SENDERS.has(String(m.sent_by || "").trim())) continue;
        if (isStaffAck(m.body)) continue;             // مجاملة → ليست الرسالة الحاسمة
        decided.add(ph);                              // أول رسالة غير-مجاملة = الحاسمة
        if (isDefiniteReply(m.body)) continue;        // سؤال/ملف/طلب تأكيد = ردّ قطعاً، لا يحتاج AI
        latestCand.set(ph, { key: ph + "|" + m.sent_at, sent_at: m.sent_at, body: m.body });
      }
      // اقرأ أحكام Haiku المخزّنة لهؤلاء المرشّحين
      const verdicts = new Map<string, boolean>();
      const candKeys = [...latestCand.values()].map(c => c.key);
      for (let i = 0; i < candKeys.length; i += 300) {
        const { data: vd } = await supabase.from("wa_reply_verdict").select("msg_key, is_reply").in("msg_key", candKeys.slice(i, i + 300));
        for (const v of (vd as Array<{ msg_key: string; is_reply: boolean }> ?? [])) verdicts.set(v.msg_key, v.is_reply);
      }
      const toClassify: Array<{ key: string; body: string }> = []; // معطّل: نعتمد القاعدة لا Haiku (كان يرفض كل الردود)
      const lastHumanOutByPhone = new Map<string, string>();
      for (const m of humanRows) {
        const ph = m.customer_phone;
        if (lastHumanOutByPhone.has(ph)) continue;
        if (BOT_SENDERS.has(String(m.sent_by || "").trim())) continue;
        if (isStaffAck(m.body)) continue;
        const cand = latestCand.get(ph);
        const key = ph + "|" + m.sent_at;
        // سؤال/ملف/طلب تأكيد = ردّ قطعاً. غير ذلك: حكم Haiku للمرشّح الأحدث إن وُجد، وإلا القاعدة.
        // نتجاهل حكم Haiku (كان يرفض كل ردود الموظفين خطأً فتبقى المحادثة «بانتظار» رغم أن الموظف
        // جاوب فعلاً). القاعدة كافية ودقيقة: رسالة موظف غير-مجاملة وغير-وعد = ردّ فعلي يُنهي الانتظار.
        const isReply = isDefiniteReply(m.body) ? true : !isStaffPromise(m.body);
        if (isReply) lastHumanOutByPhone.set(ph, m.sent_at);
      }
      // صنّف غير المخزّن في الخلفية (لا يبطّئ الرد) — يُطبَّق في التحديث التالي.
      if (toClassify.length) {
        const _task = classifyStaffReplies(supabase, toClassify.slice(0, 40));
        // @ts-ignore EdgeRuntime injected by Supabase
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(_task);
        else _task.catch(() => {});
      }

      // ── مصدر قدوم العميل ──────────────────────────────────────────────────
      // ad_referral (ميتا) = مصدر موثّق يرسله واتساب. غيره: نكشف حملات الروابط
      // المُعبّأة (جوجل/صفحات هبوط) من نص الرسالة الأولى المميّز. الباقي = مباشر.
      const CAMPAIGN_PREFILL_RE = /(مجموعة العز الدولية للسفر|أرغب في معرفة تفاصيل|أود الاستفسار عن خدماتكم)/;
      // يُرجِع { kind, platform, label, detail }. platform = مفتاح آلي للفلترة
      // الدقيقة في الداشبورد (instagram/facebook/meta/google/link/direct).
      const classifySource = (adRef: unknown, firstBody: string | undefined) => {
        if (adRef && typeof adRef === "object") {
          const r = adRef as Record<string, unknown>;
          const url = String(r.source_url || "");
          const stype = String(r.source_type || "");
          const hay = (url + " " + stype).toLowerCase();
          const platform = /instagram|ig\.me/.test(hay) ? "instagram"
            : /facebook|fb\.me|fb\.com|messenger|m\.me/.test(hay) ? "facebook" : "meta";
          const arLbl = platform === "instagram" ? "إنستقرام" : platform === "facebook" ? "فيسبوك" : "ميتا";
          return { kind: "ad", platform, label: "إعلان " + arLbl, detail: String(r.headline || "") };
        }
        const b = (firstBody || "").trim();
        if (b) {
          // تيك توك: لا يرسل مصدراً تلقائياً كميتا، فنكشفه من رسالة wa.me المميّزة
          //   التي يفتحها إعلان تيك توك (تحوي «تيك توك» أو tiktok أو الوسم TT-AD).
          if (/تيك\s?توك|tiktok|tik\s?tok|TT-AD/i.test(b)) {
            return { kind: "tiktok", platform: "tiktok", label: "تيك توك", detail: b.slice(0, 60) };
          }
          // Google Ads → رابط wa.me من إعلان جوجل؛ يُكشَف من مُعرِّف gclid أو كلمة google
          // في النص المُعبّأ (لو الإعلان يستخدم رسالة جاهزة مميّزة). خلاف ذلك: حملة رابط عامة.
          if (/gclid|google|جوجل/i.test(b)) {
            return { kind: "campaign", platform: "google", label: "Google Ads", detail: b.slice(0, 60) };
          }
          if (CAMPAIGN_PREFILL_RE.test(b)) {
            return { kind: "campaign", platform: "link", label: "حملة (رابط)", detail: b.slice(0, 60) };
          }
        }
        return { kind: "direct", platform: "direct", label: "مباشر", detail: "" };
      };

      const conversationsEnriched = (sessions ?? []).map((s: Record<string, unknown>) => {
        const phone = s.phone as string;
        const cls = latestByPhone.get(phone) ?? {};
        const lastMsg = latestMsgByPhone.get(phone);
        // customer_type / case_type / customer_stage: pick the most recent
        // NON-NULL value across all proposals so an upgrade (NEW → VIP →
        // REPEAT) sticks even if subsequent un-classified messages followed.
        // Falls back to NEW_CUSTOMER only when the customer has never been
        // classified at all.
        const customer_type = customerTypeByPhone.get(phone) || "NEW_CUSTOMER";
        const case_type = caseTypeByPhone.get(phone) || null;
        const customer_stage = stageByPhone.get(phone) || (s.customer_stage as string | null) || null;
        const source = classifySource(s.ad_referral, firstMsgByPhone.get(phone));
        const { ad_referral: _ar, ...rest } = s; // نستبعد الحمولة الخام؛ نرسل source الملخّص فقط
        return {
          ...rest,
          customer_type,
          case_type,
          customer_stage,
          source,
          // complaint_type + priority + booking_status reflect the LATEST
          // proposal only — they describe the current state, not history.
          complaint_type: cls.complaint_type ?? null,
          booking_status: cls.booking_status ?? null,
          priority: cls.priority ?? null,
          last_message_body: lastMsg?.body ?? null,
          last_inbound_at: lastMsg?.received_at ?? null,
          last_human_outbound_at: lastHumanOutByPhone.get(phone) ?? null,
        };
      });

      const { data: staffListRaw } = await supabase
        .from("wa_staff")
        .select("id, name, phone, active, role, username, destinations, password_plain")
        .order("name");
      // password_plain يُعرض للمالكة (الأدمن) فقط — يُحجب عن أي موظف.
      const isAdminCaller = callerStaff == null;
      const staffList = ((staffListRaw ?? []) as Array<Record<string, unknown>>).map((s) => {
        if (isAdminCaller) return s;
        const { password_plain: _omit, ...rest } = s;
        return rest;
      });
      const { data: rulesList } = await supabase
        .from("wa_routing_rules")
        .select("id, match_destination, assign_to_phone, priority, active")
        .order("priority", { ascending: false });

      // رسائل تحتاج مراجعة (آخر 7 أيام): معلّقة/فاشلة لم يكتمل التعامل معها —
      // للمؤشر المرئي «⚠️ تحتاج مراجعة» فيشوفها الموظف بنفسه ولا تضيع.
      const reviewCutoff = new Date(now - 7 * DAY_MS).toISOString();
      const { data: unhandledRows } = await supabase
        .from("wa_message_audit")
        .select("id, from_phone, body, status, received_at")
        .gte("received_at", reviewCutoff)
        .in("status", ["stalled", "errored"])
        .order("received_at", { ascending: false })
        .limit(50);

      return new Response(JSON.stringify({
        counts: {
          messages_today: received,
          completed_today: completed,
          stalled_today: stalled,
          errored_today: errored,
          pending_proposals_total: staffHasPerm(callerStaff, "view_proposals") ? (pending?.length ?? 0) : 0,
        },
        global_ai_enabled: globalAiEnabled,
        ai_force_off_all: aiForceOffAll,
        ai_force_on_all:  aiForceOnAll,
        ai_mode: aiMode,
        me: callerStaff,
        conversations: conversationsEnriched,
        staff: staffList ?? [],
        routing_rules: rulesList ?? [],
        pending_proposals: staffHasPerm(callerStaff, "view_proposals") ? (pending ?? []) : [],
        recent_audit: audit ?? [],
        unhandled: unhandledRows ?? [],
        generated_at: new Date().toISOString(),
      }), { headers: { ...JSON_HEADERS, ...corsHeaders } });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: { ...JSON_HEADERS, ...corsHeaders } });
    }
  }

  // ── Staff login / logout / set-password ────────────────────────────────
  // Admin endpoint (legacy JWT only) — set or change a staff member's
  // username + password. POST body: {phone, username, password}.
  if (url.searchParams.get("admin_action") === "staff_set_password") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      const username = String(p.username || "").trim().toLowerCase();
      const password = String(p.password || "");
      if (!rawPhone || !username || password.length < 4) {
        return new Response(JSON.stringify({ error: "phone + username + password (4+ chars) required" }),
          { status: 400, headers: jsonCors });
      }
      const phone = normalizeWhatsappPhone(rawPhone);
      const hash = await hashPassword(password);
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error, count } = await supabase.from("wa_staff")
        .update({ username, password_hash: hash, password_plain: password, password_set_at: new Date().toISOString() }, { count: "exact" })
        .eq("phone", phone);
      if (error) throw new Error(error.message);
      if ((count ?? 0) === 0) {
        return new Response(JSON.stringify({ error: "no staff with this phone — add them first" }),
          { status: 404, headers: jsonCors });
      }
      return new Response(JSON.stringify({ ok: true, phone, username }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Public-ish endpoint (no JWT — it's a login form). POST {username, password}.
  // On success returns {token, expires_at, staff: {name, phone, username}}.
  // دخول الأدمن (المالكة): تحقّق كلمة السر **على السيرفر** (سرّ WA_ADMIN_PASSWORD)
  // بدل كتابتها في الصفحة، ثم يُعاد توكن الأدمن. كذا لا تظهر كلمة السر ولا التوكن
  // في مصدر الصفحة لأي موظف.
  if (url.searchParams.get("admin_action") === "admin_login") {
    try {
      const p = await req.json();
      const password = String(p.password || "");
      const expected = (Deno.env.get("WA_ADMIN_PASSWORD") || "").trim();
      if (!expected || password !== expected) {
        return new Response(JSON.stringify({ error: "كلمة سر الإدمن غير صحيحة" }), { status: 401, headers: jsonCors });
      }
      const token = (Deno.env.get("LEGACY_ANON_JWT") || "").trim();
      if (!token) return new Response(JSON.stringify({ error: "النظام غير مهيّأ" }), { status: 500, headers: jsonCors });
      return new Response(JSON.stringify({ ok: true, token }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "staff_login") {
    try {
      const p = await req.json();
      const username = String(p.username || "").trim().toLowerCase();
      const password = String(p.password || "");
      if (!username || !password) {
        return new Response(JSON.stringify({ error: "missing credentials" }),
          { status: 400, headers: jsonCors });
      }
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: staff } = await supabase.from("wa_staff")
        .select("phone, name, username, password_hash, active, role")
        .eq("username", username)
        .maybeSingle();
      const row = staff as { phone: string; name: string; username: string; password_hash: string | null; active: boolean; role?: string } | null;
      if (!row || !row.active || !row.password_hash) {
        return new Response(JSON.stringify({ error: "invalid credentials" }),
          { status: 401, headers: jsonCors });
      }
      const ok = await verifyPassword(password, row.password_hash);
      if (!ok) {
        return new Response(JSON.stringify({ error: "invalid credentials" }),
          { status: 401, headers: jsonCors });
      }
      // 🔒 اعتماد الجهاز + 🔗 ربطه بالموظف: لا دخول إلا بجهاز معتمد، ولا يدخل موظف
      //    من جهاز مربوط بموظف آخر (يمنع الانتحال حتى لو عرف كلمة سر زميله). أول
      //    دخول من جهاز معتمد يربطه بهذا الموظف.
      const deviceToken = String(p.device_token || "").trim();
      if (deviceToken) {
        const { data: dev } = await supabase.from("trusted_devices")
          .select("id, staff_phone, approved").eq("device_token", deviceToken).maybeSingle();
        const drow = dev as { id: string; staff_phone: string | null; approved: boolean } | null;
        // غير معتمد (أو غير موجود) → أنشئ طلب توثيق وارفض حتى موافقة الإدارة.
        if (!drow || !drow.approved) {
          if (!drow) {
            try {
              await supabase.from("trusted_devices").insert({
                device_token: deviceToken, label: "جهاز جديد (واتساب) — بانتظار التوثيق",
                approved: false, source: "whatsapp", staff_phone: row.phone,
              });
            } catch (_e) { /* موجود مسبقاً */ }
          }
          return new Response(JSON.stringify({ error: "🔒 جهازك غير معتمد بعد. أُرسل طلب توثيق للإدارة — انتظري الموافقة ثم حاولي مجدداً.", device_pending: true }),
            { status: 403, headers: jsonCors });
        }
        if (drow.staff_phone && drow.staff_phone !== row.phone) {
          return new Response(JSON.stringify({ error: "🔒 هذا الجهاز مخصّص لموظفة أخرى. تواصلي مع الإدارة." }),
            { status: 403, headers: jsonCors });
        }
        if (!drow.staff_phone) {
          try { await supabase.from("trusted_devices").update({ staff_phone: row.phone }).eq("id", drow.id); } catch (_e) { /* best-effort */ }
        }
      }
      // "تذكرني" (remember=true) → 30-day session; default 24h. Either
      // way checkAuthOrSession re-verifies the staff is still active on
      // every request, so admin can revoke any device instantly by
      // deactivating or deleting the staff member.
      const remember = p.remember === true;
      const lifetimeMs = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const token = genSessionToken();
      const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
      await supabase.from("wa_staff_sessions").insert({
        phone: row.phone, username: row.username, token, expires_at: expiresAt,
      });
      return new Response(JSON.stringify({
        ok: true, token, expires_at: expiresAt,
        staff: { name: row.name, phone: row.phone, username: row.username, role: row.role || "sales" },
      }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // ── أمان الموظفين الموحّد: أجهزة + بصمات لكل موظف ─────────────────────
  // كل العمليات على نفس الجداول (trusted_devices + wa_staff_passkeys) فالموافقة
  // من الداشبورد أو من companies-admin تسري في الاثنين. بوابة: ownerGate.
  if (url.searchParams.get("admin_action") === "staff_security_overview") {
    if (!ownerGate(req)) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const [staffRes, devRes, pkRes] = await Promise.all([
        supabase.from("wa_staff").select("phone, name, username, role, active").order("name"),
        supabase.from("trusted_devices").select("id, staff_phone, approved, label, created_at").eq("source", "whatsapp").order("created_at", { ascending: false }),
        supabase.from("wa_staff_passkeys").select("id, staff_phone, device_label, last_used_at, created_at"),
      ]);
      const devs = (devRes.data || []) as Array<{ id: string; staff_phone: string | null; approved: boolean; label: string | null; created_at: string }>;
      const pks = (pkRes.data || []) as Array<{ id: string; staff_phone: string; device_label: string | null; last_used_at: string | null; created_at: string }>;
      const staff = ((staffRes.data || []) as Array<{ phone: string; name: string; username: string | null; role: string; active: boolean }>).map(s => {
        const myDevs = devs.filter(d => d.staff_phone === s.phone);
        const approvedDev = myDevs.find(d => d.approved) || null;
        const pendingDev = myDevs.find(d => !d.approved) || null;
        const myPks = pks.filter(p => p.staff_phone === s.phone);
        return {
          phone: s.phone, name: s.name, username: s.username, role: s.role, active: s.active,
          device_approved: !!approvedDev,
          approved_device_id: approvedDev?.id || null,
          pending_device_id: pendingDev?.id || null,
          has_passkey: myPks.length > 0,
          passkey_count: myPks.length,
          passkey_last_used: myPks.map(p => p.last_used_at).filter(Boolean).sort().pop() || null,
        };
      });
      // أجهزة معلّقة غير مربوطة بأي موظف (للاعتماد العام).
      const unassignedPending = devs.filter(d => !d.approved && !d.staff_phone).map(d => ({ id: d.id, label: d.label, created_at: d.created_at }));
      return new Response(JSON.stringify({ ok: true, staff, unassignedPending }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // اعتماد جهاز (بالمعرّف) — يفعّل دخول الموظف (وبصمته) من هذا الجهاز.
  if (url.searchParams.get("admin_action") === "staff_device_approve") {
    if (!ownerGate(req)) return unauthorized();
    try {
      const p = await req.json(); const id = String(p.device_id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "device_id required" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await supabase.from("trusted_devices").update({ approved: true, approved_by: "owner", approved_at: new Date().toISOString() }).eq("id", id);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // رفض/إلغاء جهاز (بالمعرّف) + إنهاء جلسات الموظف المرتبط فوراً.
  if (url.searchParams.get("admin_action") === "staff_device_revoke") {
    if (!ownerGate(req)) return unauthorized();
    try {
      const p = await req.json(); const id = String(p.device_id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "device_id required" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: dev } = await supabase.from("trusted_devices").select("staff_phone").eq("id", id).maybeSingle();
      const phone = (dev as { staff_phone?: string | null } | null)?.staff_phone || null;
      await supabase.from("trusted_devices").delete().eq("id", id);
      if (phone) await supabase.from("wa_staff_sessions").update({ revoked_at: new Date().toISOString() }).eq("phone", phone).is("revoked_at", null);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // إعادة ضبط/حذف بصمة موظف (لو بدّل جواله أو انقفل) — يحذف مفاتيحه فيقدر
  // يسجّل بصمة جديدة على جهازه المعتمد. الحساب يبقى نشطاً.
  if (url.searchParams.get("admin_action") === "staff_passkey_reset") {
    if (!ownerGate(req)) return unauthorized();
    try {
      const p = await req.json(); const phone = normalizeWhatsappPhone(String(p.phone || ""));
      if (!phone || phone === "whatsapp:+") return new Response(JSON.stringify({ error: "phone required" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await supabase.from("wa_staff_passkeys").delete().eq("staff_phone", phone);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // ── الحضور والانصراف + تتبّع النشاط (event-based) ─────────────────────
  // بدء الدوام — للموظف فقط (الأدمن/المالكة بلا staff session لا يسجّل دوام).
  if (url.searchParams.get("admin_action") === "attendance_check_in") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const staff = await getCallerStaff(req);
    if (!staff) return new Response(JSON.stringify({ error: "الحضور للموظفين فقط" }), { status: 403, headers: jsonCors });
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
      const ua = req.headers.get("user-agent") || null;
      const { data: open } = await supabase.from("attendance_sessions").select("id, check_in_at").eq("staff_phone", staff.phone).is("check_out_at", null).order("check_in_at", { ascending: false }).limit(1).maybeSingle();
      if (open) { await recordActivity(supabase, staff.phone, staff.name, "resume", ip, ua); return new Response(JSON.stringify({ ok: true, already: true, id: (open as { id: string }).id }), { headers: jsonCors }); }
      const now = new Date().toISOString();
      const ksaToday = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
      const { data, error } = await supabase.from("attendance_sessions").insert({ staff_phone: staff.phone, staff_name: staff.name, work_date: ksaToday, check_in_at: now, last_activity_at: now, status: "active" }).select("id").single();
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
      await recordActivity(supabase, staff.phone, staff.name, "check_in", ip, ua);
      return new Response(JSON.stringify({ ok: true, id: (data as { id: string }).id, check_in_at: now }), { headers: jsonCors });
    } catch (e) { return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors }); }
  }

  // إنهاء الدوام — يحسب النشاط/الخمول من الأحداث ويقفل الجلسة.
  if (url.searchParams.get("admin_action") === "attendance_check_out") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const staff = await getCallerStaff(req);
    if (!staff) return new Response(JSON.stringify({ error: "الحضور للموظفين فقط" }), { status: 403, headers: jsonCors });
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: open } = await supabase.from("attendance_sessions").select("id, check_in_at").eq("staff_phone", staff.phone).is("check_out_at", null).order("check_in_at", { ascending: false }).limit(1).maybeSingle();
      if (!open) return new Response(JSON.stringify({ ok: true, no_session: true }), { headers: jsonCors });
      const o = open as { id: string; check_in_at: string };
      const now = new Date().toISOString();
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
      const ua = req.headers.get("user-agent") || null;
      await recordActivity(supabase, staff.phone, staff.name, "check_out", ip, ua);
      const { data: evs } = await supabase.from("activity_events").select("created_at").eq("staff_phone", staff.phone).gte("created_at", o.check_in_at).order("created_at", { ascending: true }).limit(5000);
      const { active, idle } = splitActiveIdle(o.check_in_at, ((evs || []) as Array<{ created_at: string }>).map(e => e.created_at), now);
      await supabase.from("attendance_sessions").update({ check_out_at: now, active_seconds: active, idle_seconds: idle, status: "offline", last_activity_at: now }).eq("id", o.id);
      const total = Math.round((new Date(now).getTime() - new Date(o.check_in_at).getTime()) / 1000);
      return new Response(JSON.stringify({ ok: true, check_out_at: now, total_seconds: total, active_seconds: active, idle_seconds: idle }), { headers: jsonCors });
    } catch (e) { return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors }); }
  }

  // حالة دوامي الحالية (لزر الواجهة): مسجَّل دخول؟ active/idle؟
  if (url.searchParams.get("admin_action") === "attendance_status") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const staff = await getCallerStaff(req);
    if (!staff) return new Response(JSON.stringify({ ok: true, is_staff: false }), { headers: jsonCors });
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: open } = await supabase.from("attendance_sessions").select("id, check_in_at, last_activity_at").eq("staff_phone", staff.phone).is("check_out_at", null).order("check_in_at", { ascending: false }).limit(1).maybeSingle();
    if (!open) return new Response(JSON.stringify({ ok: true, is_staff: true, checked_in: false, staff_name: staff.name }), { headers: jsonCors });
    const o = open as { id: string; check_in_at: string; last_activity_at: string };
    const idleSec = (Date.now() - new Date(o.last_activity_at).getTime()) / 1000;
    return new Response(JSON.stringify({ ok: true, is_staff: true, checked_in: true, status: idleSec >= ATTEND_IDLE_SEC ? "idle" : "active", check_in_at: o.check_in_at, last_activity_at: o.last_activity_at, staff_name: staff.name }), { headers: jsonCors });
  }

  // تسجيل نشاط فعلي من الواجهة (فتح محادثة، تعديل…) — الأدمن no-op.
  if (url.searchParams.get("admin_action") === "track_activity") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const staff = await getCallerStaff(req);
    if (!staff) return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: jsonCors });
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const p = await req.json().catch(() => ({} as Record<string, unknown>));
      const type = String((p as { type?: string }).type || "activity").slice(0, 40);
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
      const ua = req.headers.get("user-agent") || null;
      await recordActivity(supabase, staff.phone, staff.name, type, ip, ua);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) { return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors }); }
  }

  // تحديد دوام الموظف (وقت دخول/خروج متوقّع) — المدير فقط.
  if (url.searchParams.get("admin_action") === "set_staff_schedule") {
    if (!ownerGate(req)) return unauthorized();
    try {
      const p = await req.json();
      const phone = normalizeWhatsappPhone(String(p.phone || ""));
      const clean = (v: unknown) => { const s = String(v || "").trim(); return /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, "0") : null; };
      const wd = Array.isArray(p.work_days) ? [...new Set((p.work_days as unknown[]).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : null;
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await supabase.from("wa_staff").update({ shift_start: clean(p.shift_start), shift_end: clean(p.shift_end), shift_start2: clean(p.shift_start2), shift_end2: clean(p.shift_end2), work_days: wd }).eq("phone", phone);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) { return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors }); }
  }

  // تقرير الحضور والإنتاجية — المدير يرى الجميع، الموظف يرى نفسه فقط (خادمياً).
  if (url.searchParams.get("admin_action") === "attendance_report") {
    const caller = await getCallerStaff(req);
    const isAdmin = !caller && ownerGate(req);
    if (!caller && !isAdmin) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const range = url.searchParams.get("range") || "day";
      const DAY = 24 * 3600 * 1000; const nowMs = Date.now();
      let fromMs = nowMs - DAY;
      if (range === "week") fromMs = nowMs - 7 * DAY;
      else if (range === "month") fromMs = nowMs - 30 * DAY;
      else if (range === "all") fromMs = 0;
      else if (range === "custom") { const f = url.searchParams.get("from"); if (f) fromMs = Date.parse(f + "T00:00:00Z"); }
      let toMs = nowMs;
      if (range === "custom") { const t = url.searchParams.get("to"); if (t) toMs = Date.parse(t + "T23:59:59Z"); }
      // أرضية التصفير: لا يُحتسب أي شيء قبل تاريخ بدء التقارير مهما كانت الفترة المختارة
      // (wa_settings.report_floor_at). ضبطتها المالكة لتبدأ التقارير من اليوم نظيفة.
      { const { data: fl } = await supabase.from("wa_settings").select("value").eq("key", "report_floor_at").maybeSingle();
        const flms = fl && (fl as { value?: unknown }).value ? Date.parse(String((fl as { value?: unknown }).value)) : NaN;
        if (Number.isFinite(flms) && flms > fromMs) fromMs = flms; }
      const fromIso = new Date(fromMs).toISOString(); const toIso = new Date(toMs).toISOString();

      // قائمة الموظفين المستهدفين (مع دوامهم وأيام عملهم المحدّدة)
      let staffRows: Array<{ phone: string; name: string; shift_start: string | null; shift_end: string | null; shift_start2: string | null; shift_end2: string | null; work_days: number[] | null }> = [];
      { const sel = supabase.from("wa_staff").select("phone, name, shift_start, shift_end, shift_start2, shift_end2, work_days");
        const { data } = caller ? await sel.eq("phone", caller.phone) : await sel.eq("active", true);
        staffRows = (data || []) as typeof staffRows; }
      const names = staffRows.map(s => s.name);
      const hhmmSec = (s: string | null): number | null => { if (!s) return null; const m = /^(\d{1,2}):(\d{2})$/.exec(s); if (!m) return null; return (+m[1]) * 3600 + (+m[2]) * 60; };
      // أيام الفترة بتوقيت KSA (لحساب أيام العمل المتوقّعة → الغياب).
      const windowDates: Array<{ ds: string; dow: number }> = []; { const seen = new Set<string>(); for (let cur = fromMs; cur <= toMs; cur += 12 * 3600 * 1000) { const om = new Date(cur + 4 * 3600 * 1000); const ds = om.toISOString().slice(0, 10); if (!seen.has(ds)) { seen.add(ds); windowDates.push({ ds, dow: om.getUTCDay() }); } } }
      const todayStrOman = new Date(nowMs + 4 * 3600 * 1000).toISOString().slice(0, 10);

      // جلب البيانات دفعة واحدة (بلا N+1)
      const [sessRes, evRes, outRes, inRes, wsRes] = await Promise.all([
        supabase.from("attendance_sessions").select("staff_phone, work_date, check_in_at, check_out_at, active_seconds, idle_seconds, last_activity_at").gte("check_in_at", fromIso).lte("check_in_at", toIso).limit(5000),
        supabase.from("activity_events").select("staff_phone, created_at").gte("created_at", fromIso).lte("created_at", toIso).limit(20000),
        supabase.from("wa_admin_messages").select("sent_by, customer_phone, sent_at, body").in("sent_by", names.length ? [...names, "النظام"] : ["النظام"]).gte("sent_at", fromIso).lte("sent_at", toIso).limit(15000),
        supabase.from("wa_message_audit").select("from_phone, received_at, body").gte("received_at", fromIso).lte("received_at", toIso).limit(20000),
        // حالة المحادثات المُسنَدة (لقطة حالية): مؤكّدة / غير مردودة / شافتها بلا رد.
        supabase.from("whatsapp_sessions").select("phone, assigned_staff_phone, label, last_message_at, last_outbound_at, last_opened_at").not("assigned_staff_phone", "is", null).limit(8000),
      ]);
      const sessions = (sessRes.data || []) as Array<{ staff_phone: string; work_date: string; check_in_at: string; check_out_at: string | null; active_seconds: number; idle_seconds: number; last_activity_at: string }>;
      const events = (evRes.data || []) as Array<{ staff_phone: string; created_at: string }>;
      const outs = (outRes.data || []) as Array<{ sent_by: string; customer_phone: string; sent_at: string; body: string | null }>;
      const ins = (inRes.data || []) as Array<{ from_phone: string; received_at: string; body: string | null }>;

      // رسالة تأكيد/شكر قصيرة لا تتطلب رداً
      const isAckText = (t: string | null): boolean => { const s = String(t || "").trim(); if (!s) return true; if (/[؟?]/.test(s) || /(^|[\s،])(كم|بكم|وكم|كام|متى|وين|فين|كيف|ليش|ليه|هل|ايش|أيش|وش|سعر|السعر|الاسعار|التكلفه|التكلفة)([\s،؟?]|$)/i.test(s)) return false; if (/^(نعم|ايوه|ايوا|أيوه|أيوا|ايوة|أيوة|اي|إي|اكيد|أكيد|اجل|أجل|تمام نعم|اي نعم|yes|yep|yeah)\.?$/i.test(s)) return false; if (/الغ[يا]|ألغ[يا]|نلغي|لغينا|نأجل|أجلنا|اجلنا|مأجل|مؤجل|ما ?راح ?نسافر|ما ?بنسافر|ما ?رح ?نسافر|غيرنا ?ر[اأ]ي|ما ?طاعوا|يرخصو|رخصونا|ما ?حصلنا ?[اإ]جاز|مو ?مناسب|ما ?يناسب|مايجي|ما ?يجي|مو ?الحين|مو ?هالفتر|نلغيها/.test(s)) return true; if (/ا?رد ?(لكم|عليكم|عليك|لكو)|اردلكم|راح ?ا?رد|بكلمكم|اكلمكم|أكلمكم|بخبركم|اخبركم|أخبركم|بفيدكم|افيدكم|أفيدكم|ارجعلكم|ارجع ?لكم|أرجع ?لكم|بتواصل ?معكم|اتواصل ?معكم|بعطيكم ?خبر|اعطيكم ?خبر|بشوف ?وارد|اشوف ?وارد|بشاور( |$)|اشاور( |$)/.test(s)) return true; const stripped = s.replace(/(شكرا?ً?|مشكور(ين)?|تسلم(ون|وا)?|يسلمو|تسلمو|تشكر|جزا?ك(م)?|الله|يعطيك(م)?|العافيه|العافية|العاف|خير(ا|اً|ها)?|كثير(ا)?|جزيل(ا|اً)?|وافر|لك(م)?|الك|اخوي|أخوي|اختي|أختي|يا|غالي|حبيبي|عزيزي|تمام|تم|اوكي?|ok|okay|thanks|thx|ماشي|زين|طيب|ممتاز|رائع|روعه|حلو|كفو|مر(ه|ة)|جدا|جداً|واجد|والله|عاد|خلاص|تستاهل(ون)?|نورت|يحفظك|يسعدك|يوفقك|كل|على|عل|الف|ألف|حال|و|ف|ان|إن|شاء|استاذي?|أستاذي?)/gi, "").replace(/[\s،.!؛:؟?\-_()*👍🙏❤️🌹💚💐🤍😍🥰😘♥️🌟✨🤲🌷💕💜]+/g, ""); return [...stripped].length === 0; };
      // فهرسة الوارد لكل عميل (لحساب زمن الاستجابة) + آخر نص وارد.
      const inByPhone: Record<string, number[]> = {};
      const lastInBody: Record<string, { ts: number; body: string | null }> = {};
      for (const m of ins) { const ts = Date.parse(m.received_at); (inByPhone[m.from_phone] ||= []).push(ts); if (!lastInBody[m.from_phone] || ts > lastInBody[m.from_phone].ts) lastInBody[m.from_phone] = { ts, body: m.body }; }
      for (const k in inByPhone) inByPhone[k].sort((a, b) => a - b);
      const evByPhone: Record<string, string[]> = {};
      for (const e of events) { (evByPhone[e.staff_phone] ||= []).push(e.created_at); }
      // آخر ردّ **موظف** لكل عميل: ردود الموظفين + إرسال البرامج «النظام» (ردّ بشري عبر
      // المنصة) — تستبعد طلال/التلقائي. «النظام» تُحتسب كردّ بالمحادثة لكن لا تُنسب لموظف.
      // «ليست ردّاً فعلياً»: مجاملة قصيرة أو وعد بالإرسال (نفس قاعدة dashboard_data).
      const isStaffAck = (t: string | null): boolean => { const s = String(t || "").trim(); if (!s) return true; const n = [...s].length; if (n <= 6) return true; return n <= 15 && /^(شكر|تسلم|تمام|تمم|تم\b|طيب|ماشي|زين|اوك|اوكي|ok|okay|thanks|thx|ابشر|أبشر|تبشر|حاضر|حياك|اهلا|أهلا|هلا|لحظة|لحظه|ثانية|ثواني|دقيقة|دقيقه|👍|🙏|❤|🌹|💚|💐|🤍|يعطيك|جزاك|ممتاز|رائع|حلو|كفو|يسلمو|تسلمو)/i.test(s); };
      const isStaffPromise = (t: string | null): boolean => { const s = String(t || "").trim(); if (!s) return false; if (/أرسلت|ارسلت|رسلت|جهّزت|جهزت|عملت|سويت|بعثت|أعطيت|اعطيت|رتبت|وصلك|وصلت|تفضل|هذا برنامج/.test(s)) return false; return /((الان|الحين|حالا|راح|رح|سوف|توني|تبشر|ابشر|أبشر).{0,10}(ا?رسل|ا?جهز|جهّز|ا?عمل|ا?سوي|ابعث|ا?خلص|ا?كمل|ا?رتب|أرتب))|(^\s*(بأرسل|بارسل|بجهز|باجهز|بأجهز|بسوي|باعمل|بعمل|برتب|بخلص|بكمل|سأرسل|سارسل))|((ثوان|لحظ|دقيق|دقاي).{0,12}(ا?رسل|ا?جهز|ا?عمل|ا?سوي))|(جاري.{0,8}(تجهيز|الت|الإرسال|الارسال|العمل|عمل))/.test(s); };
      const isStaffQuestion = (t: string | null): boolean => { const s = String(t || "").trim(); if (!s) return false; if (/[؟?]/.test(s)) return true; return /(^|\s)(كم|كام|متى|وين|اين|أين|هل|كيف|ايش|أيش|وش|وشو|تبي|تبغى|تبغون|تبون|تحب|تحبو|تحبون|ودك|عندك|عندكم|تنوون|تخططون|مين)(\s|$|[،.!:])/.test(s); };
      const isStaffDelivery = (t: string | null): boolean => { const s = String(t || ""); return /📎|https?:\/\/|\[ملف|ملف البرنامج/.test(s) || /في انتظار\s*(تاكيد|تأكيد|رد|ردّ|موافق|اختيار|اعتماد)\S{0,3}كم/.test(s); };
      // سؤال/ملف/طلب تأكيد للعميل = ردّ (الكرة بملعبه)؛ يتقدّم على استبعاد الوعد/المجاملة.
      const isNonReply = (t: string | null): boolean => !(isStaffQuestion(t) || isStaffDelivery(t)) && (isStaffAck(t) || isStaffPromise(t));
      const lastStaffOutByPhone: Record<string, number> = {};
      for (const o of outs) { if (isNonReply(o.body)) continue; const t = Date.parse(o.sent_at); if (!lastStaffOutByPhone[o.customer_phone] || t > lastStaffOutByPhone[o.customer_phone]) lastStaffOutByPhone[o.customer_phone] = t; }
      // تجميع لكل موظف: حجوزات مؤكّدة + غير مردودة (آخر نشاط من العميل) + منها كم شافتها بلا رد.
      const confirmedBy: Record<string, number> = {}, unansweredBy: Record<string, number> = {}, unansweredSeenBy: Record<string, number> = {};
      for (const w of ((wsRes.data || []) as Array<{ phone: string; assigned_staff_phone: string; label: string | null; last_message_at: string | null; last_outbound_at: string | null; last_opened_at: string | null }>)) {
        const ph = w.assigned_staff_phone;
        if (w.label === "CONFIRMED") confirmedBy[ph] = (confirmedBy[ph] || 0) + 1;
        const lm = w.last_message_at ? Date.parse(w.last_message_at) : 0;
        const lo = lastStaffOutByPhone[w.phone] || 0;   // آخر ردّ موظف (مو البوت)
        const lop = w.last_opened_at ? Date.parse(w.last_opened_at) : 0;
        // غير مردودة: العميل أحدث من ردّ الموظف، **ورسالته الأخيرة جوهرية** (لا شكر/تأكيد/إغلاق).
        // رسالة الشكر («جزاك الله»، «شكراً»، 🌹) تُنهي المحادثة فلا تُحسب بانتظار رد ولو مرّ وقت.
        const lastTxt = lastInBody[w.phone]?.body ?? null;
        const unanswered = lm > 0 && lm > lo && !isAckText(lastTxt);
        if (unanswered) { unansweredBy[ph] = (unansweredBy[ph] || 0) + 1; if (lop >= lm) unansweredSeenBy[ph] = (unansweredSeenBy[ph] || 0) + 1; }
      }

      // ── قياس النشاط الفعلي لكل يوم (لتمييز «شغّالة فعلاً» عن «دخلت بلا عمل») ──
      const omanDay = (iso: string) => new Date(Date.parse(iso) + 4 * 3600 * 1000).toISOString().slice(0, 10);
      const nameToPhone = new Map(staffRows.map(s => [s.name, s.phone]));
      // رسائل الموظفة لكل يوم + مجموعة العملاء الذين ردّت عليهم لكل يوم
      const msgsByNameDay = new Map<string, Map<string, number>>();
      const repliedByPhoneDay = new Map<string, Map<string, Set<string>>>();
      for (const o of outs) {
        const day = omanDay(o.sent_at);
        let m = msgsByNameDay.get(o.sent_by); if (!m) { m = new Map(); msgsByNameDay.set(o.sent_by, m); }
        m.set(day, (m.get(day) || 0) + 1);
        const ph = nameToPhone.get(o.sent_by);
        if (ph) { let d = repliedByPhoneDay.get(ph); if (!d) { d = new Map(); repliedByPhoneDay.set(ph, d); } let set = d.get(day); if (!set) { set = new Set(); d.set(day, set); } set.add(o.customer_phone); }
      }
      // إسناد العملاء للموظفين (لقطة حالية) + وارد كل (موظف، يوم)
      const assignStaffByCust = new Map<string, string>();
      for (const w of ((wsRes.data || []) as Array<{ phone: string; assigned_staff_phone: string | null }>)) { if (w.assigned_staff_phone) assignStaffByCust.set(w.phone, w.assigned_staff_phone); }
      const inboundByPhoneDay = new Map<string, Map<string, Set<string>>>();
      for (const m of ins) { const ph = assignStaffByCust.get(m.from_phone); if (!ph) continue; const day = omanDay(m.received_at); let d = inboundByPhoneDay.get(ph); if (!d) { d = new Map(); inboundByPhoneDay.set(ph, d); } let set = d.get(day); if (!set) { set = new Set(); d.set(day, set); } set.add(m.from_phone); }
      // عملاء راسلوها ذلك اليوم ولم تُردّ عليهم نفس اليوم
      const unansweredOn = (phone: string, day: string): number => { const inb = inboundByPhoneDay.get(phone)?.get(day); if (!inb || inb.size === 0) return 0; const rep = repliedByPhoneDay.get(phone)?.get(day) || new Set<string>(); let n = 0; for (const c of inb) if (!rep.has(c)) n++; return n; };

      const report = staffRows.map(s => {
        const ss = sessions.filter(x => x.staff_phone === s.phone);
        let active = 0, idle = 0; const days = new Set<string>();
        let liveStatus = "offline", lastAct: string | null = null, checkIn: string | null = null, checkOut: string | null = null;
        let latestStart = 0;
        const shStart = hhmmSec(s.shift_start), shEnd = hhmmSec(s.shift_end);
        const shStart2 = hhmmSec(s.shift_start2), shEnd2 = hhmmSec(s.shift_end2);
        // دوام مقسوم: مجموع مدّتَي الفترتين (الفترة الثانية اختيارية)
        const dur1 = (shStart != null && shEnd != null && shEnd > shStart) ? (shEnd - shStart) : 0;
        const dur2 = (shStart2 != null && shEnd2 != null && shEnd2 > shStart2) ? (shEnd2 - shStart2) : 0;
        const shiftSec = (dur1 + dur2) > 0 ? (dur1 + dur2) : null;
        const shiftStarts = [shStart, shStart2].filter((v): v is number => v != null);
        let lateSum = 0, lateCnt = 0;
        for (const x of ss) {
          days.add(x.work_date);
          if (x.check_out_at) { active += x.active_seconds; idle += x.idle_seconds; }
          else { const { active: a, idle: i } = splitActiveIdle(x.check_in_at, evByPhone[s.phone] || [], new Date(nowMs).toISOString()); active += a; idle += i; const idleSec = (nowMs - Date.parse(x.last_activity_at)) / 1000; liveStatus = idleSec >= ATTEND_IDLE_SEC ? "idle" : "active"; lastAct = x.last_activity_at; }
          const st = Date.parse(x.check_in_at); if (st > latestStart) { latestStart = st; checkIn = x.check_in_at; checkOut = x.check_out_at; }
          // التأخير: وقت الدخول الفعلي (بتوقيت عُمان UTC+4) مقابل بداية أقرب فترة دوام يدخل فيها
          // (يدعم الدوام المقسوم: يُقاس التأخير للفترة الصباحية أو المسائية حسب وقت الدخول).
          if (shiftStarts.length) {
            const todSec = ((Date.parse(x.check_in_at) + 4 * 3600 * 1000) % 86400000) / 1000;
            let bestLate: number | null = null;
            for (const st of shiftStarts) { const d = todSec - st; if (d >= -3600 && (bestLate === null || d < bestLate)) bestLate = d; }
            if (bestLate !== null && bestLate > 60 && bestLate < 4 * 3600) { lateSum += bestLate; lateCnt++; }
          }
        }
        // الحالة الحيّة = حسب آخر نشاط فعلي (تظهر «متصل/نشط» متى عملت فعلاً، حتى قبل
        // ضغط «بدء الدوام»). الساعات تبقى من جلسات الدوام المسجَّلة.
        let lastEvMs = lastAct ? Date.parse(lastAct) : 0;
        for (const t of (evByPhone[s.phone] || [])) { const m = Date.parse(t); if (m > lastEvMs) lastEvMs = m; }
        if (lastEvMs) { const gap = (nowMs - lastEvMs) / 1000; liveStatus = gap < ATTEND_IDLE_SEC ? "active" : (gap < 3600 ? "idle" : "offline"); lastAct = new Date(lastEvMs).toISOString(); }
        const total = active + idle;
        const myOut = outs.filter(o => o.sent_by === s.name);
        const messages = myOut.length;
        const clients = new Set(myOut.map(o => o.customer_phone)).size;
        // متوسط زمن الاستجابة: لكل رسالة صادرة، أقرب وارد سابق لنفس العميل خلال ١٢ ساعة
        let rsum = 0, rcnt = 0;
        for (const o of myOut) {
          const arr = inByPhone[o.customer_phone]; if (!arr) continue;
          const ot = Date.parse(o.sent_at); let lo = 0, hi = arr.length - 1, best = -1;
          while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] < ot) { best = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
          if (best > 0) { const diff = (ot - best) / 1000; if (diff > 0 && diff < 12 * 3600) { rsum += diff; rcnt++; } }
        }
        const avgResp = rcnt ? Math.round(rsum / rcnt) : null;
        // أيام العمل المتوقّعة في الفترة (حسب أيام عمله المحدّدة).
        const wdSet = (s.work_days && s.work_days.length) ? new Set(s.work_days) : null;
        const expectedDays = wdSet ? windowDates.filter(d => wdSet.has(d.dow)).length : null;
        // ⚠️ الغياب = أيام العمل المجدولة **المنقضية** (قبل اليوم) بلا أي حضور — نُدرج تواريخها في السجل.
        // لا نحسب اليوم الجاري غياباً (ما زال بإمكانها الحضور، خصوصاً الفترة المسائية للدوام المقسوم).
        const absentDates = wdSet ? windowDates.filter(d => wdSet.has(d.dow) && d.ds < todayStrOman && !days.has(d.ds)).map(d => d.ds) : [];
        const absenceDays = wdSet ? absentDates.length : null;
        // الالتزام = النشاط الفعلي مقابل ساعات الدوام المتوقّعة. الأساس: عدد أيام
        // العمل المتوقّعة (يعاقب الغياب) إن حُدّدت أيام العمل، وإلا أيام الحضور.
        const baseDays = (expectedDays != null) ? expectedDays : days.size;
        const expected = (shiftSec != null) ? shiftSec * baseDays : 0;
        const compliance = expected > 0 ? Math.min(100, Math.round((active / expected) * 100)) : (total > 0 ? Math.round((active / total) * 100) : 0);
        const avgLate = lateCnt ? Math.round(lateSum / lateCnt) : null;
        return { phone: s.phone, name: s.name, status: liveStatus, check_in_at: checkIn, check_out_at: checkOut, last_activity_at: lastAct, active_seconds: active, idle_seconds: idle, total_seconds: total, days_present: days.size, messages, clients, avg_response_seconds: avgResp, compliance, shift_start: s.shift_start || null, shift_end: s.shift_end || null, shift_start2: s.shift_start2 || null, shift_end2: s.shift_end2 || null, work_days: s.work_days || null, expected_days: expectedDays, absence_days: absenceDays, absent_dates: absentDates, expected_seconds: expected, avg_late_seconds: avgLate, schedule_based: expected > 0, confirmed_bookings: confirmedBy[s.phone] || 0, unanswered: unansweredBy[s.phone] || 0, unanswered_seen: unansweredSeenBy[s.phone] || 0,
          // سجل الدخول/الخروج المفصّل لكل جلسة (ضمن الفترة المختارة) — الأحدث أولاً
          sessions: ss.map((x) => {
            const day = omanDay(x.check_in_at);
            const msgs = msgsByNameDay.get(s.name)?.get(day) || 0;
            const unans = unansweredOn(s.phone, day);
            const activeThresh = shiftSec ? shiftSec * 0.5 : 3600;   // «شغّالة فعلاً» = نشاط ≥ نصف الدوام + رسالة واحدة على الأقل
            const working = x.active_seconds >= activeThresh && msgs >= 1;
            return { work_date: x.work_date, check_in_at: x.check_in_at, check_out_at: x.check_out_at, active_seconds: x.active_seconds, idle_seconds: x.idle_seconds, messages: msgs, unanswered: unans, day_status: working ? "active" : "weak" };
          }).sort((a, b) => String(b.check_in_at).localeCompare(String(a.check_in_at))) };
      });
      report.sort((a, b) => b.active_seconds - a.active_seconds);
      return new Response(JSON.stringify({ ok: true, is_admin: isAdmin, range, from: fromIso, to: toIso, report }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Staff self-service: change own password. Requires a valid session
  // (NOT the master JWT). Verifies current_password before updating.
  // POST body: {current_password, new_password}
  if (url.searchParams.get("admin_action") === "staff_change_password") {
    try {
      const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!got) return unauthorized();
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      // Resolve the session → staff phone. Master JWT doesn't have a
      // staff account so it can't self-change here.
      const { data: sessionRow } = await supabase.from("wa_staff_sessions")
        .select("phone, expires_at, revoked_at")
        .eq("token", got)
        .maybeSingle();
      const session = sessionRow as { phone: string; expires_at: string; revoked_at: string | null } | null;
      if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
        return unauthorized();
      }
      const p = await req.json();
      const current = String(p.current_password || "");
      const next = String(p.new_password || "");
      if (!current || next.length < 4) {
        return new Response(JSON.stringify({ error: "أدخل كلمة السر الحالية وكلمة سر جديدة (4 أحرف على الأقل)" }),
          { status: 400, headers: jsonCors });
      }
      const { data: staffRow } = await supabase.from("wa_staff")
        .select("password_hash, active")
        .eq("phone", session.phone)
        .maybeSingle();
      const staff = staffRow as { password_hash: string | null; active: boolean } | null;
      if (!staff || !staff.active || !staff.password_hash) return unauthorized();
      const ok = await verifyPassword(current, staff.password_hash);
      if (!ok) {
        return new Response(JSON.stringify({ error: "كلمة السر الحالية غير صحيحة" }),
          { status: 401, headers: jsonCors });
      }
      const newHash = await hashPassword(next);
      const { error } = await supabase.from("wa_staff")
        .update({ password_hash: newHash, password_set_at: new Date().toISOString() })
        .eq("phone", session.phone);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Revoke the caller's current session. Reads the Bearer token directly
  // and flips revoked_at. Always returns 200 (no info leak).
  if (url.searchParams.get("admin_action") === "staff_logout") {
    try {
      const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (got) {
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await supabase.from("wa_staff_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("token", got);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (_) {
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "list_staff") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("wa_staff").select("*").order("name");
    return new Response(JSON.stringify({ staff: data ?? [] }), { headers: jsonCors });
  }

  // POST {phone, name, active?} → insert or update by phone.
  // Full customer directory for the "جهات الاتصال" tab — every
  // whatsapp_sessions row (not time-filtered), enriched with the
  // latest non-null customer_type from proposals. Newest activity
  // first, capped at 2000.
  if (url.searchParams.get("admin_action") === "list_contacts") {
    // أدمن فقط — قائمة العملاء وتصديرها بيانات حساسة، ممنوعة على الموظفين.
    if (!checkAuth(req)) return unauthorized();
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: sessions } = await supabase
        .from("whatsapp_sessions")
        .select("phone, profile_name, destination, assigned_staff_phone, customer_stage, last_message_at, created_at")
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(2000);
      const rows = (sessions ?? []) as Array<Record<string, unknown>>;
      const phones = rows.map(r => r.phone as string);
      // Latest non-null customer_type per phone (chunk the IN to stay
      // under URL limits if there are many contacts).
      const typeByPhone = new Map<string, string>();
      for (let i = 0; i < phones.length; i += 200) {
        const chunk = phones.slice(i, i + 200);
        if (!chunk.length) break;
        const { data: props } = await supabase
          .from("whatsapp_admin_proposals")
          .select("customer_phone, customer_type, created_at")
          .in("customer_phone", chunk)
          .order("created_at", { ascending: false });
        for (const p of (props as Array<{ customer_phone: string; customer_type: string | null }> ?? [])) {
          if (!typeByPhone.has(p.customer_phone) && p.customer_type) {
            typeByPhone.set(p.customer_phone, p.customer_type);
          }
        }
      }
      const contacts = rows.map(r => ({
        ...r,
        customer_type: typeByPhone.get(r.phone as string) || "NEW_CUSTOMER",
      }));
      return new Response(JSON.stringify({ contacts, count: contacts.length }),
        { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "upsert_staff") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      const name = String(p.name || "").trim();
      const active = p.active === false ? false : true;
      const role = p.role === "monitor" ? "monitor" : "sales";
      // الوجهات: قائمة نظيفة من نصوص — فاضية = كل الوجهات.
      // نقبل array مباشرة أو CSV string.
      let destinations: string[] | undefined = undefined;
      if (Array.isArray(p.destinations)) {
        destinations = (p.destinations as unknown[]).map(s => String(s).trim()).filter(Boolean);
      } else if (typeof p.destinations === "string") {
        destinations = p.destinations.split(",").map(s => s.trim()).filter(Boolean);
      }
      // الصلاحيات: كائن {key: bool} مقتصر على المفاتيح المعروفة فقط.
      let permissions: Record<string, boolean> | undefined = undefined;
      if (p.permissions && typeof p.permissions === "object" && !Array.isArray(p.permissions)) {
        const PKEYS = ["view_proposals", "send_messages", "delete_messages", "manage_offers", "transfer_conversations", "manage_ai"];
        const src = p.permissions as Record<string, unknown>;
        permissions = {};
        for (const k of PKEYS) permissions[k] = !!src[k];
      }
      if (!rawPhone || !name) {
        return new Response(JSON.stringify({ error: "missing phone or name" }),
          { status: 400, headers: jsonCors });
      }
      const digits = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const phone = `whatsapp:+${digits}`;
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const row: Record<string, unknown> = { phone, name, active, role };
      if (destinations !== undefined) row.destinations = destinations;
      if (permissions !== undefined) row.permissions = permissions;
      const { data, error } = await supabase.from("wa_staff")
        .upsert(row, { onConflict: "phone" })
        .select().single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, staff: data }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // POST {phone} → delete staff row by phone.
  if (url.searchParams.get("admin_action") === "delete_staff") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      if (!rawPhone) return new Response(JSON.stringify({ error: "missing phone" }), { status: 400, headers: jsonCors });
      const digits = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const phone = `whatsapp:+${digits}`;
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await supabase.from("wa_staff").delete().eq("phone", phone);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "list_routing_rules") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("wa_routing_rules").select("*")
      .order("priority", { ascending: false }).order("created_at");
    return new Response(JSON.stringify({ rules: data ?? [] }), { headers: jsonCors });
  }

  // POST {id?, match_destination, assign_to_phone, priority?, active?} → upsert
  if (url.searchParams.get("admin_action") === "upsert_routing_rule") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const match_destination = String(p.match_destination || "").trim();
      const rawAssign = String(p.assign_to_phone || "").trim();
      if (!match_destination || !rawAssign) {
        return new Response(JSON.stringify({ error: "missing match_destination or assign_to_phone" }),
          { status: 400, headers: jsonCors });
      }
      const digits = rawAssign.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const assign_to_phone = `whatsapp:+${digits}`;
      const priority = Number.isFinite(p.priority) ? Number(p.priority) : 0;
      const active = p.active === false ? false : true;
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const row = { match_destination, assign_to_phone, priority, active };
      const q = p.id
        ? supabase.from("wa_routing_rules").update(row).eq("id", p.id).select().single()
        : supabase.from("wa_routing_rules").insert(row).select().single();
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, rule: data }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "delete_routing_rule") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const id = String(p.id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "missing id" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await supabase.from("wa_routing_rules").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Manual transfer. POST {phone, staff_phone, transferred_by?}
  // - phone: customer phone (whatsapp:+E.164 or any flexible form)
  // - staff_phone: target staff's whatsapp phone (must exist in wa_staff
  //   ideally, but we don't enforce — flexible for ad-hoc transfers)
  // - transferred_by: optional phone of who initiated (admin or staff)
  if (url.searchParams.get("admin_action") === "transfer_conversation") {
    { const g = await requirePerm(req, "transfer_conversations"); if (g) return g; }
    try {
      const p = await req.json();
      const rawCust = String(p.phone || "").trim();
      const rawStaff = String(p.staff_phone || "").trim();
      if (!rawCust || !rawStaff) {
        return new Response(JSON.stringify({ error: "missing phone or staff_phone" }),
          { status: 400, headers: jsonCors });
      }
      const norm = (s: string) => {
        const d = s.replace(/^whatsapp:/, "").replace(/^\+/, "").replace(/^00/, "").replace(/[^0-9]/g, "");
        return `whatsapp:+${d}`;
      };
      const phone = norm(rawCust);
      const staff_phone = norm(rawStaff);
      const transferredBy = p.transferred_by ? norm(String(p.transferred_by)) : "admin";
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error, data: updated } = await supabase.from("whatsapp_sessions")
        .update({
          assigned_staff_phone: staff_phone,
          assigned_at: new Date().toISOString(),
          assigned_by: transferredBy,
        })
        .eq("phone", phone)
        .select("destination, profile_name")
        .maybeSingle();
      if (error) throw new Error(error.message);
      // Fire notification to the new staff.
      await notifyStaffAssignment({
        supabase,
        staffPhone: staff_phone,
        customerPhone: phone,
        customerName: (updated as { profile_name?: string } | null)?.profile_name,
        destination: (updated as { destination?: string | null } | null)?.destination,
        source: transferredBy,
      });
      return new Response(JSON.stringify({ ok: true, phone, assigned_staff_phone: staff_phone }),
        { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Monitor / admin: complaints queue. Returns all wa_complaints rows
  // with their assigned staff name joined in. Filterable client-side
  // by severity / status. Includes upsert endpoint for status / severity /
  // resolution edits.
  if (url.searchParams.get("admin_action") === "list_complaints") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: complaints } = await supabase.from("wa_complaints")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      // Resolve assigned staff names for display.
      const { data: staffRows } = await supabase.from("wa_staff")
        .select("phone, name");
      const nameByPhone = new Map<string, string>();
      for (const s of (staffRows as Array<{ phone: string; name: string }> | null) ?? []) {
        nameByPhone.set(s.phone, s.name);
      }
      const enriched = (complaints ?? []).map((c: Record<string, unknown>) => ({
        ...c,
        assigned_staff_name: c.assigned_staff_phone ? nameByPhone.get(c.assigned_staff_phone as string) || null : null,
      }));
      return new Response(JSON.stringify({ complaints: enriched }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Mark a conversation as opened (read) by any staff/admin/monitor.
  //   POST { phone }
  // Stamps last_opened_at = now() on the session row. The dashboard
  // fires this when openConversation() runs.
  if (url.searchParams.get("admin_action") === "mark_opened") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      if (!rawPhone) {
        return new Response(JSON.stringify({ error: "missing phone" }),
          { status: 400, headers: jsonCors });
      }
      const digits = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const phone = `whatsapp:+${digits}`;
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { error } = await supabase.from("whatsapp_sessions")
        .update({ last_opened_at: new Date().toISOString() })
        .eq("phone", phone);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Admin patches a proposal's classifications inline from the dashboard.
  //   POST { proposal_id, customer_stage?, customer_type?, case_type?,
  //          complaint_type?, proposed_intent?, proposed_sub_intent? }
  // Any subset of fields may be provided. Unknown / blank values are
  // ignored so the existing column value is preserved.
  if (url.searchParams.get("admin_action") === "proposal_update") {
    { const g = await requirePerm(req, "view_proposals"); if (g) return g; }
    try {
      const p = await req.json();
      const id = String(p.proposal_id || "").trim();
      if (!id) {
        return new Response(JSON.stringify({ error: "missing proposal_id" }),
          { status: 400, headers: jsonCors });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const STAGES = ["INQUIRY","READY_FOR_QUOTE","OFFER_SENT","BOOKING_IN_PROGRESS","BOOKING_CONFIRMED","TRAVELING","POST_TRAVEL"];
      const CUSTOMERS = ["NEW_CUSTOMER","REPEAT_CUSTOMER","VIP_CUSTOMER","CORPORATE_BUSINESS","PARTNERSHIP"];
      const CASES = ["INQUIRY","BOOKING_REQUEST","BOOKING_CONFIRMED","COMPLAINT","CANCELLATION","MODIFICATION"];
      const COMPLAINTS = ["PAYMENT_ISSUE","HOTEL_ISSUE","FLIGHT_ISSUE","SERVICE_ISSUE","DELAY_RESPONSE","GENERAL_DISSATISFACTION"];
      const patch: Record<string, unknown> = {};
      const tryAdd = (key: string, allowed: string[]) => {
        if (typeof p[key] !== "string") return;
        const v = p[key].toUpperCase().trim();
        if (allowed.includes(v)) patch[key] = v;
      };
      tryAdd("customer_stage", STAGES);
      tryAdd("customer_type",  CUSTOMERS);
      tryAdd("case_type",      CASES);
      tryAdd("complaint_type", COMPLAINTS);
      if (typeof p.proposed_intent === "string")     patch.proposed_intent = p.proposed_intent.trim();
      if (typeof p.proposed_sub_intent === "string") patch.proposed_sub_intent = p.proposed_sub_intent.trim();
      if (typeof p.customer_goal === "string")       patch.customer_goal = p.customer_goal.trim().slice(0, 600);
      // تعديل بيانات الخدمة المقترحة (jsonb) — دمج الحقول المُرسلة في الموجود.
      if (p.business_metadata && typeof p.business_metadata === "object" && !Array.isArray(p.business_metadata)) {
        const { data: cur } = await supabase.from("whatsapp_admin_proposals")
          .select("business_metadata").eq("id", id).maybeSingle();
        const curBm = (((cur as { business_metadata?: Record<string, unknown> } | null)?.business_metadata) || {}) as Record<string, unknown>;
        const allowed = ["service_name","service_status","seasonal_availability","start_date","end_date"];
        const incoming = p.business_metadata as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...curBm };
        for (const k of allowed) {
          if (k in incoming) merged[k] = String(incoming[k] ?? "").slice(0, 200);
        }
        patch.business_metadata = merged;
      }
      if (!Object.keys(patch).length) {
        return new Response(JSON.stringify({ error: "no fields to update" }),
          { status: 400, headers: jsonCors });
      }
      const { error, data } = await supabase.from("whatsapp_admin_proposals")
        .update(patch).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, proposal: data }),
        { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // إعادة تحليل المقترحات المعلّقة بالمنطق الجديد (استخراج الهدف + إعادة استخدام
  // الرد المعتمد + عدّاد الثقة). يعالج دفعة لكل نداء (للحدّ من زمن الاستجابة)؛
  // نادِه مراراً حتى remaining=0. يحدّث فقط ما ينقصه الهدف (للاستئناف الآمن).
  if (url.searchParams.get("admin_action") === "reanalyze_pending") {
    { const g = await requirePerm(req, "view_proposals"); if (g) return g; }
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: pend } = await supabase.from("whatsapp_admin_proposals")
        .select("id, customer_question, customer_phone")
        .in("status", ["pending_reply_approval", "pending_correction"])
        .is("customer_goal", null)
        .order("created_at", { ascending: false }).limit(10);
      const list = (pend as Array<{ id: string; customer_question: string; customer_phone: string }> | null) ?? [];
      let updated = 0;
      for (const pr of list) {
        try {
          const ctx = await buildConversationContext(supabase, pr.customer_phone || "");
          let a = await analyzeUnknownQuestion(supabase, pr.customer_question || "", ctx, MODEL_FAST);
          if (a && !a.sourceRowId) { const deep = await analyzeUnknownQuestion(supabase, pr.customer_question || "", ctx, MODEL_DEEP); if (deep) a = deep; }
          if (!a) continue;
          let sc: number | null = null;
          if (a.sourceRowId) {
            const { data: fc } = await supabase.from("faq_confirmations")
              .select("confirmations").eq("row_id", a.sourceRowId).maybeSingle();
            sc = (((fc as { confirmations?: number } | null)?.confirmations) ?? 0);
          }
          await supabase.from("whatsapp_admin_proposals").update({
            customer_goal: a.goal || "",
            interpretation: a.interpretation,
            suggested_reply: a.suggestedReply,
            source_row_id: a.sourceRowId,
            source_confirmations: sc,
            proposed_intent: a.proposedIntent,
            proposed_sub_intent: a.proposedSubIntent,
            customer_stage: a.customerStage,
            extracted_data: a.extractedData,
            missing_data: a.missingData,
            business_metadata: a.businessMetadata,
          }).eq("id", pr.id);
          updated++;
        } catch (_e) { /* تخطّى هذا وواصل */ }
      }
      const { count: remaining } = await supabase.from("whatsapp_admin_proposals")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending_reply_approval", "pending_correction"])
        .is("customer_goal", null);
      return new Response(JSON.stringify({ ok: true, updated, remaining: remaining ?? 0 }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // «تحليل أعمق» يدوي لمقترح واحد بـ Sonnet (عند الشك في رد ولّده الموديل الرخيص).
  if (url.searchParams.get("admin_action") === "deepen_proposal") {
    { const g = await requirePerm(req, "view_proposals"); if (g) return g; }
    try {
      const p = await req.json();
      const id = String(p.proposal_id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "missing proposal_id" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: pr } = await supabase.from("whatsapp_admin_proposals")
        .select("customer_question, customer_phone").eq("id", id).maybeSingle();
      const row = pr as { customer_question?: string; customer_phone?: string } | null;
      if (!row) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: jsonCors });
      const ctx = await buildConversationContext(supabase, row.customer_phone || "");
      const a = await analyzeUnknownQuestion(supabase, row.customer_question || "", ctx, MODEL_DEEP);
      if (!a) return new Response(JSON.stringify({ error: "analysis failed" }), { status: 502, headers: jsonCors });
      let sc: number | null = null;
      if (a.sourceRowId) {
        const { data: fc } = await supabase.from("faq_confirmations").select("confirmations").eq("row_id", a.sourceRowId).maybeSingle();
        sc = (((fc as { confirmations?: number } | null)?.confirmations) ?? 0);
      }
      await supabase.from("whatsapp_admin_proposals").update({
        customer_goal: a.goal || "", interpretation: a.interpretation, suggested_reply: a.suggestedReply,
        source_row_id: a.sourceRowId, source_confirmations: sc,
        proposed_intent: a.proposedIntent, proposed_sub_intent: a.proposedSubIntent,
        customer_stage: a.customerStage, extracted_data: a.extractedData,
        missing_data: a.missingData, business_metadata: a.businessMetadata,
      }).eq("id", id);
      return new Response(JSON.stringify({ ok: true, deepened: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin decides a pending proposal from the dashboard (instead of the
  // WhatsApp reply flow).
  //   POST { proposal_id, decision: "approve" }
  //   POST { proposal_id, decision: "correct", reply: "..." }
  //
  // approve: use suggested_reply as-is. correct: use the given reply.
  // In both cases:
  //   • mode=PREVIEW → customer never gets anything. The reply is just
  //     recorded on the proposal for the FAQ training queue.
  //   • mode=ON      → reply gets sent to the customer via Twilio REST.
  if (url.searchParams.get("admin_action") === "proposal_decide") {
    { const g = await requirePerm(req, "view_proposals"); if (g) return g; }
    try {
      const p = await req.json();
      const id = String(p.proposal_id || "").trim();
      const decision = String(p.decision || "").toLowerCase().trim();
      const correctedReply = typeof p.reply === "string" ? p.reply.trim() : "";
      if (!id) {
        return new Response(JSON.stringify({ error: "missing proposal_id" }),
          { status: 400, headers: jsonCors });
      }
      if (decision !== "approve" && decision !== "correct" && decision !== "dismiss" && decision !== "save_only") {
        return new Response(JSON.stringify({ error: "decision must be 'approve', 'correct', 'dismiss', or 'save_only'" }),
          { status: 400, headers: jsonCors });
      }
      // حذف/تجاهل الاقتراح بدون إرسال للعميل ولا حفظ في FAQ.
      if (decision === "dismiss") {
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const { error } = await supabase.from("whatsapp_admin_proposals")
          .update({ status: "dismissed", decided_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ ok: true, dismissed: true }), { headers: jsonCors });
      }
      if (decision === "correct" && !correctedReply) {
        return new Response(JSON.stringify({ error: "reply is required for decision='correct'" }),
          { status: 400, headers: jsonCors });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: proposal } = await supabase
        .from("whatsapp_admin_proposals")
        .select("id, customer_phone, customer_question, customer_goal, suggested_reply, source_row_id, proposed_intent, proposed_sub_intent, proposed_keywords, customer_stage, status")
        .eq("id", id)
        .maybeSingle();
      if (!proposal) {
        return new Response(JSON.stringify({ error: "proposal not found" }),
          { status: 404, headers: jsonCors });
      }
      const row = proposal as {
        id: string; customer_phone: string; customer_question: string;
        customer_goal: string | null;
        suggested_reply: string; source_row_id: string | null;
        proposed_intent: string; proposed_sub_intent: string;
        proposed_keywords: string[]; customer_stage: string | null;
        status: string;
      };
      // save_only: «حفظ فقط بدون إرسال» — يحفظ الرد (المحرّر أو المقترح) في FAQ
      // ويُنهي الاقتراح، لكن لا يُرسل للعميل (لأنه رُدّ عليه سابقاً يدوياً).
      const finalReply = decision === "approve"
        ? (row.suggested_reply || "")
        : (decision === "save_only" ? (correctedReply || row.suggested_reply || "") : correctedReply);
      const mode = await getAiMode(supabase);
      // قاعدة الحفظ في FAQ:
      //   approve + source_row_id موجود → موجود أصلاً في الشيت، لا تحفظ
      //   approve + لا source_row_id      → جواب جديد، احفظه
      //   correct                          → دائماً احفظه (تصحيح يدوي)
      // احفظ فقط الرد الجديد أو المعدّل. لا تُعد حفظ رد معتمد موجود أصلاً في
      // قاعدة المعرفة (source_row_id موجود ولم يتغيّر نصّه) حتى لا تتكرّر الصفوف.
      const isUnchangedExisting = !!row.source_row_id && finalReply === (row.suggested_reply || "");
      const shouldSave = !!finalReply && !isUnchangedExisting &&
        (decision === "correct" || decision === "save_only" || decision === "approve");
      // Update proposal status FIRST so it disappears from the dashboard
      // immediately. The actual sendCustomerReply + appendChatAnswerRow
      // + triggerSyncSheets all run in the background — used to add 3-8s
      // to the request and made the admin think "موافق" was hanging.
      const updatePatch: Record<string, unknown> = {
        status: shouldSave ? "completed_added" : "completed_skipped",
        decided_at: new Date().toISOString(),
      };
      if (decision === "correct" || decision === "save_only") updatePatch.suggested_reply = finalReply;
      const { error } = await supabase.from("whatsapp_admin_proposals")
        .update(updatePatch)
        .eq("id", id);
      if (error) throw new Error(error.message);

      // Background fire-and-forget: send to customer + save to FAQ +
      // trigger sync. Wrapped in EdgeRuntime.waitUntil so the Deno
      // isolate stays alive until they settle even after we return.
      const background = (async () => {
        try {
          if (mode === "ON" && finalReply && decision !== "save_only") {
            await sendCustomerReply(supabase, row.customer_phone, finalReply);
          }
          if (shouldSave) {
            const ok = await appendChatAnswerRow({
              intent: row.proposed_intent,
              subIntent: row.proposed_sub_intent,
              keywords: row.proposed_keywords || [],
              sampleQ: row.customer_question,
              stage: row.customer_stage,
              answer: finalReply,
            });
            if (ok) await triggerSyncSheets();
          }
          // تأكيد إضافي لرد معتمد موجود أصلاً (بدل الحفظ المكرّر): زِد عدّاد التأكيدات
          // ليرتفع مستوى الثقة بهذا الرد مستقبلاً.
          if (isUnchangedExisting && row.source_row_id) {
            const { data: cur } = await supabase.from("faq_confirmations")
              .select("confirmations, sample_questions, goals").eq("row_id", row.source_row_id).maybeSingle();
            const c = cur as { confirmations?: number; sample_questions?: string[]; goals?: string[] } | null;
            const n = ((c?.confirmations) || 0) + 1;
            // راكم سؤال العميل وهدفه (آخر 15) لتحسين المطابقة بالهدف مستقبلاً.
            const sq = [...(c?.sample_questions || []), row.customer_question].filter(Boolean).slice(-15);
            const gl = row.customer_goal ? [...(c?.goals || []), row.customer_goal].filter(Boolean).slice(-15) : (c?.goals || []);
            await supabase.from("faq_confirmations").upsert({
              row_id: row.source_row_id, confirmations: n, sample_questions: sq, goals: gl, last_confirmed_at: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.error("proposal_decide background failed", (e as Error).message);
        }
      })();
      // @ts-ignore EdgeRuntime injected by Supabase
      if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
        // @ts-ignore
        EdgeRuntime.waitUntil(background);
      }

      const saveOutcome = shouldSave
        ? "saving_in_background"
        : (decision === "approve" && row.source_row_id ? "skipped_already_in_faq" : "no_save");
      return new Response(JSON.stringify({
        ok: true,
        sent_to_customer: mode === "ON",
        mode,
        save_outcome: saveOutcome,
      }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // POST body: {id, severity?, status?, resolution_notes?, assigned_staff_phone?}
  // Any subset of fields may be updated. Setting status='resolved' also
  // stamps resolved_at automatically.
  if (url.searchParams.get("admin_action") === "upsert_complaint") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const id = String(p.id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "missing id" }),
        { status: 400, headers: jsonCors });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof p.severity === "string") patch.severity = p.severity;
      if (typeof p.status === "string") {
        patch.status = p.status;
        if (p.status === "resolved" && !p.resolved_at) patch.resolved_at = new Date().toISOString();
        if (p.status !== "resolved") patch.resolved_at = null;
      }
      if (typeof p.resolution_notes === "string") patch.resolution_notes = p.resolution_notes;
      if (typeof p.complaint_type === "string") patch.complaint_type = p.complaint_type;
      if ("assigned_staff_phone" in p) {
        patch.assigned_staff_phone = p.assigned_staff_phone
          ? `whatsapp:+${String(p.assigned_staff_phone).replace(/^whatsapp:/, "").replace(/^\+/, "").replace(/^00/, "").replace(/[^0-9]/g, "")}`
          : null;
      }
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error, data } = await supabase.from("wa_complaints")
        .update(patch).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, complaint: data }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Admin: send a message TO a customer FROM the dashboard. The customer
  // sees a normal WhatsApp message from the bot's sender; inside the
  // dashboard timeline the message is labeled "Admin" via the
  // wa_admin_messages join on Twilio SID.
  // Delete a Twilio message from the Twilio logs (and therefore from
  // the dashboard's conversation_history view next refresh).
  //   POST { message_sid }
  //
  // ⚠️ NOTE: this does NOT recall the message on the customer's
  // WhatsApp. WhatsApp's "delete for everyone" is only available
  // through the native app within a 1-hour window. The Twilio API
  // doesn't expose it. So the customer may still see the message in
  // their chat — we just stop showing it on our side.
  if (url.searchParams.get("admin_action") === "delete_message") {
    { const g = await requirePerm(req, "delete_messages"); if (g) return g; }
    try {
      const p = await req.json();
      const msgSid = String(p.message_sid || "").trim();
      if (!msgSid) {
        return new Response(JSON.stringify({ error: "missing message_sid" }),
          { status: 400, headers: jsonCors });
      }
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const tw = Deno.env.get("TWILIO_AUTH_TOKEN");
      if (!sid || !tw) {
        return new Response(JSON.stringify({ error: "twilio creds missing" }),
          { status: 500, headers: jsonCors });
      }
      const auth = "Basic " + btoa(`${sid}:${tw}`);
      const twRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${msgSid}.json`,
        { method: "DELETE", headers: { Authorization: auth } },
      );
      // 204 = deleted, 404 = already gone (treat as success)
      if (!twRes.ok && twRes.status !== 404) {
        const errText = await twRes.text();
        return new Response(JSON.stringify({
          error: "twilio rejected delete",
          status: twRes.status,
          detail: errText.slice(0, 200),
        }), { status: twRes.status, headers: jsonCors });
      }
      return new Response(JSON.stringify({ ok: true, sid: msgSid }),
        { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // ── الفواتير: رقم تسلسلي + بيانات الشركة + إرسال PDF للعميل ───────────
  // رقم فاتورة تالٍ بشكل ذري: INV-YYYY-NNN (دالة next_program_code الموجودة).
  if (url.searchParams.get("admin_action") === "next_invoice_no") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data, error } = await supabase.rpc("next_program_code", { p_prefix: "INV" });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
      return new Response(JSON.stringify({ ok: true, invoice_no: data }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // قراءة بيانات الشركة للفاتورة (ترويسة ثابتة) من wa_settings.
  if (url.searchParams.get("admin_action") === "invoice_company") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("wa_settings").select("value").eq("key", "invoice_company").maybeSingle();
    const v = (data as { value?: unknown } | null)?.value || {};
    return new Response(JSON.stringify({ ok: true, company: v }), { headers: jsonCors });
  }

  // حفظ بيانات الشركة للفاتورة (أدمن فقط).
  if (url.searchParams.get("admin_action") === "set_invoice_company") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const company = {
        name: String(p.name || "").slice(0, 200),
        address: String(p.address || "").slice(0, 300),
        phones: String(p.phones || "").slice(0, 200),
        website: String(p.website || "").slice(0, 120),
        extra: String(p.extra || "").slice(0, 200),
      };
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("wa_settings").upsert({ key: "invoice_company", value: company }, { onConflict: "key" });
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // ربط ملف PDF (جاهز، بعملة ثابتة) بكود برنامج للإعلانات: طلال يرسله لأي عميل
  // يجي من إعلان يحمل هذا الكود. المفتاح wa_settings = "ad_pdf:<CODE>".
  if (url.searchParams.get("admin_action") === "set_ad_pdf") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const code = String(p.code || "").trim().toUpperCase();
      const pdfUrl = String(p.url || "").trim();
      if (!code || !pdfUrl) return new Response(JSON.stringify({ error: "code & url required" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("wa_settings").upsert(
        { key: "ad_pdf:" + code, value: { url: pdfUrl, saved_at: new Date().toISOString() } },
        { onConflict: "key" },
      );
      return new Response(JSON.stringify({ ok: true, code }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // قائمة برامج الإعلانات المربوطة (كود → ملف PDF) لعرضها/إدارتها في داشبورد الواتساب.
  // يجيب كود عرض الإعلان المربوط لعميل محدّد (من ad_referral على جلسته) — يستخدمه
  // زر «📢 برنامج بالكود» ليملأ الكود تلقائياً بدل ما تلصقه الموظفة.
  if (url.searchParams.get("admin_action") === "resolve_ad_offer") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = req.method === "POST" ? await req.json() : Object.fromEntries(url.searchParams);
      const rawPhone = String(p.phone || "").trim();
      const phone = rawPhone.startsWith("whatsapp:") ? rawPhone : ("whatsapp:+" + rawPhone.replace(/[^0-9]/g, ""));
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: sess } = await supabase.from("whatsapp_sessions").select("ad_referral, intake_data").eq("phone", phone).maybeSingle();
      const adRef = (sess as { ad_referral?: Record<string, unknown> | null } | null)?.ad_referral || null;
      const offer = await resolveLinkedAdOffer(supabase, adRef);
      return new Response(JSON.stringify({ ok: true, code: offer?.code || "", destination: offer?.pr?.destination || "", has_pdf: !!offer?.pdfUrl }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin/staff: **إرسال** عرض الإعلان لعميل عند الطلب (زر يدوي من الداشبورد).
  // يحل الكود من إعلان العميل (أو code صريح بالجسم)، ويرسل الملف/التفاصيل عبر
  // sendLinkedAdOfferFile. يتطلّب نافذة 24 ساعة مفتوحة (رسالة حرة) وإلا ترفض Meta.
  //   POST ?admin_action=send_ad_offer  body {phone, code?}
  if (url.searchParams.get("admin_action") === "send_ad_offer") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      if (!rawPhone) return new Response(JSON.stringify({ error: "missing phone" }), { status: 400, headers: jsonCors });
      const phone = rawPhone.startsWith("whatsapp:") ? rawPhone : ("whatsapp:+" + rawPhone.replace(/[^0-9]/g, ""));
      const overrideCode = String(p.code || "").trim().toUpperCase();
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      let offer: { code: string; pdfUrl: string; pr: { destination?: string; raw?: string } } | null = null;
      if (overrideCode) {
        // بناء عرض من كود صريح: البرنامج + ملف الإعلان إن وُجد.
        const { data: prog } = await supabase.from("programs").select("destination, raw").eq("code", overrideCode).maybeSingle();
        const pr = prog as { destination?: string; raw?: string } | null;
        if (!pr || !pr.raw) return new Response(JSON.stringify({ error: "الكود غير موجود بجدول البرامج: " + overrideCode }), { status: 404, headers: jsonCors });
        let pdfUrl = "";
        try { const { data: pdfRow } = await supabase.from("wa_settings").select("value").eq("key", "ad_pdf:" + overrideCode).maybeSingle(); pdfUrl = String((pdfRow as { value?: { url?: string } } | null)?.value?.url || ""); } catch (_e) { /* */ }
        offer = { code: overrideCode, pdfUrl, pr };
      } else {
        const { data: sess } = await supabase.from("whatsapp_sessions").select("ad_referral").eq("phone", phone).maybeSingle();
        const adRef = (sess as { ad_referral?: Record<string, unknown> | null } | null)?.ad_referral || null;
        offer = await resolveLinkedAdOffer(supabase, adRef);
      }
      if (!offer) return new Response(JSON.stringify({ error: "ما فيه عرض مربوط بهذا العميل — مرّري code صريح" }), { status: 404, headers: jsonCors });
      await sendLinkedAdOfferFile(supabase, phone, offer);
      return new Response(JSON.stringify({ ok: true, phone, code: offer.code, destination: offer.pr?.destination || "", sent_as: offer.pdfUrl ? "pdf" : "text" }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // فحص صحّة ويبهوك واتساب: يتأكد أن التطبيق مشترك في ويبهوك الـWABA (وإلا لا
  // تصل رسائل العملاء). ?resubscribe=1 يعيد الاشتراك.  GET ?admin_action=webhook_health
  if (url.searchParams.get("admin_action") === "webhook_health") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const token = (Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim();
      const phoneNumberId = (Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "").trim();
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("wa_settings").select("value").eq("key", "whatsapp_waba_id").maybeSingle();
      let waba = String((data as { value?: unknown } | null)?.value || "").replace(/"/g, "");
      // تمرير WABA يدوياً (من WhatsApp Manager) يتجاوز المحفوظ ويُحفَظ للمرّات القادمة.
      const wabaParam = (url.searchParams.get("waba") || "").replace(/[^0-9]/g, "");
      if (wabaParam) {
        waba = wabaParam;
        try { await supabase.from("wa_settings").upsert([{ key: "whatsapp_waba_id", value: waba, updated_at: new Date().toISOString() }]); } catch (_e) { /* */ }
      }
      const g = async (path: string, method = "GET") => {
        try {
          const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, { method });
          return { status: r.status, body: await r.json().catch(() => null) };
        } catch (e) { return { err: (e as Error).message }; }
      };
      const out: Record<string, unknown> = { waba_from_settings: waba, has_token: !!token, phone_number_id: phoneNumberId };
      out.phone = await g(`${phoneNumberId}?fields=id,display_phone_number,verified_name,account_mode,status,quality_rating,webhook_configuration`);
      // لو ما فيه WABA محفوظ، جرّب discoverWabaId
      if (!waba) { const dsc = await discoverWabaId(token, phoneNumberId); waba = dsc.waba || ""; out.waba_discovered = waba || dsc.diag; }
      if (waba) {
        out.subscribed_apps = await g(`${waba}/subscribed_apps`);
        out.waba_phone_numbers = await g(`${waba}/phone_numbers?fields=id,display_phone_number,verified_name`);
        if (url.searchParams.get("resubscribe") === "1") {
          // (أ) اشتراك عادي.
          out.resubscribe = await g(`${waba}/subscribed_apps`, "POST");
          // (ب) ضبط override الويبهوك صراحةً مع verify token الصحيح — يعيد تفعيل
          //     التسليم لو كان الـoverride غير مُفعَّل/التوكن قديم (السبب الأرجح).
          const cb = `https://${PROJECT_REF}.supabase.co/functions/v1/WhatsApp-Router`;
          const vt = (Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "").trim();
          out.set_override = await g(`${waba}/subscribed_apps?override_callback_uri=${encodeURIComponent(cb)}&verify_token=${encodeURIComponent(vt)}`, "POST");
        }
      }
      return new Response(JSON.stringify(out, null, 2), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "list_ad_pdfs") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("wa_settings").select("key, value").like("key", "ad_pdf:%").order("key");
      const rows = ((data || []) as Array<{ key: string; value: { url?: string; saved_at?: string } | null }>).map((r) => ({
        code: String(r.key).replace(/^ad_pdf:/, ""),
        url: String(r.value?.url || ""),
        saved_at: r.value?.saved_at || null,
        destination: "",
      }));
      // أضِف الوجهة من جدول البرامج (لكل كود) للتمييز السريع.
      const codes = rows.map((r) => r.code).filter(Boolean);
      if (codes.length) {
        const { data: progs } = await supabase.from("programs").select("code, destination").in("code", codes);
        const byCode: Record<string, string> = {};
        for (const p of (progs || []) as Array<{ code: string; destination: string }>) byCode[p.code] = p.destination || "";
        for (const r of rows) r.destination = byCode[r.code] || "";
      }
      return new Response(JSON.stringify({ ok: true, items: rows }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // إلغاء ربط ملف إعلان بكود (يحذف المفتاح wa_settings).
  if (url.searchParams.get("admin_action") === "delete_ad_pdf") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const code = String(p.code || "").trim().toUpperCase();
      if (!code) return new Response(JSON.stringify({ error: "code required" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("wa_settings").delete().eq("key", "ad_pdf:" + code);
      return new Response(JSON.stringify({ ok: true, code }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // ربط إعلان (بمُعرّفه source_id) بكود برنامج — للإعلانات المُطلَقة بلا كود في الكابشن.
  // طلال يرسل ملف/تفاصيل ذلك الكود تلقائياً لأي عميل يجي من هذا الإعلان. wa_settings = "ad_link:<source_id>".
  if (url.searchParams.get("admin_action") === "set_ad_link") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const sourceId = String(p.source_id || "").trim();
      const code = String(p.code || "").trim().toUpperCase();
      if (!sourceId || !code) return new Response(JSON.stringify({ error: "source_id & code required" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("wa_settings").upsert(
        { key: "ad_link:" + sourceId, value: { code, saved_at: new Date().toISOString() } },
        { onConflict: "key" },
      );
      return new Response(JSON.stringify({ ok: true, source_id: sourceId, code }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // صورة بيانات الدفع (حسابات بنكية) من طرق الدفع المحفوظة (wa_offers) كـ base64 —
  // تُضمَّن في الفاتورة عند الدفع بالريال العماني (cat=pay_oman افتراضياً).
  if (url.searchParams.get("admin_action") === "invoice_pay_image") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const cat = (url.searchParams.get("cat") || "pay_oman").trim();
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("wa_offers").select("file_url, content_type").eq("category", cat).eq("active", true).order("sort").limit(1).maybeSingle();
      const fileUrl = (data as { file_url?: string } | null)?.file_url;
      if (!fileUrl) return new Response(JSON.stringify({ ok: true, image: null }), { headers: jsonCors });
      const imgRes = await fetch(fileUrl);
      if (!imgRes.ok) return new Response(JSON.stringify({ ok: true, image: null }), { headers: jsonCors });
      const buf = new Uint8Array(await imgRes.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const mime = (data as { content_type?: string } | null)?.content_type || "image/jpeg";
      return new Response(JSON.stringify({ ok: true, image: `data:${mime};base64,${btoa(bin)}` }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // إرسال فاتورة PDF (base64) للعميل عبر Graph — يرفعها كوسيط ثم يرسلها document.
  if (url.searchParams.get("admin_action") === "send_invoice") {
    { const g = await requirePerm(req, "send_messages"); if (g) return g; }
    try {
      const TOKEN = (Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim();
      const PHONE_ID = (Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "").trim();
      if (!TOKEN || !PHONE_ID) return new Response(JSON.stringify({ error: "WhatsApp credentials missing" }), { status: 500, headers: jsonCors });
      const b = await req.json();
      const rawPhone = String(b.phone || "").trim();
      const to = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "").replace(/[^0-9]/g, "");
      const pdfB64 = String(b.pdf_base64 || "");
      let filename = String(b.filename || "فاتورة.pdf").slice(0, 120);
      if (!/\.pdf$/i.test(filename)) filename += ".pdf";
      const caption = String(b.caption || "").trim().slice(0, 1000);
      if (!to || !pdfB64) return new Response(JSON.stringify({ error: "missing phone/pdf" }), { status: 400, headers: jsonCors });
      const bin = atob(pdfB64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append("messaging_product", "whatsapp");
      fd.append("type", "application/pdf");
      fd.append("file", new Blob([bytes], { type: "application/pdf" }), "invoice.pdf");
      const upRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/media`, {
        method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: fd,
      });
      const upJson = await upRes.json();
      if (!upRes.ok || !upJson.id) return new Response(JSON.stringify({ error: "media upload failed", detail: upJson }), { status: 502, headers: jsonCors });
      const msgBody = { messaging_product: "whatsapp", to, type: "document", document: { id: upJson.id, filename, ...(caption ? { caption } : {}) } };
      const sendRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(msgBody),
      });
      const sendJson = await sendRes.json();
      if (!sendRes.ok) return new Response(JSON.stringify({ error: "send failed", detail: sendJson?.error || sendJson }), { status: 502, headers: jsonCors });
      // سجّل بخيط المحادثة + ارفع المحادثة لأعلى.
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const customerPhone = rawPhone.startsWith("whatsapp:") ? rawPhone : ("whatsapp:+" + to);
      const callerStaff = await getCallerStaff(req);
      const sentBy = (callerStaff && callerStaff.name) ? callerStaff.name : String(b.sent_by || "admin");
      const threadBody = (caption ? caption + "\n" : "") + "🧾 [فاتورة PDF]";
      try {
        await supabase.from("wa_admin_messages").insert({ customer_phone: customerPhone, body: threadBody.slice(0, 2000), sent_by: sentBy, sent_at: new Date().toISOString(), media_id: upJson.id, media_mime: "application/pdf", media_filename: filename });
        const _ts = new Date().toISOString();
        await supabase.from("whatsapp_sessions").update({ last_message_at: _ts, last_outbound_at: _ts, last_outbound_body: "🧾 فاتورة" }).eq("phone", customerPhone);
        // لو الفاتورة محفوظة في التبويب، علّمها «مُرسلة».
        const invId = String(b.invoice_id || "").trim();
        if (invId) await supabase.from("invoices").update({ status: "sent", sent_at: _ts, updated_at: _ts }).eq("id", invId);
      } catch (_e) { /* best-effort */ }
      return new Response(JSON.stringify({ ok: true, message_id: sendJson?.messages?.[0]?.id || null }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // ── تبويب الفواتير: حفظ/قائمة/جلب/حذف (قابلة للتعديل وإعادة الإرسال) ──────
  if (url.searchParams.get("admin_action") === "list_invoices") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("invoices")
      .select("id, invoice_no, customer_phone, customer_name, currency, total, status, inv_date, created_by, sent_at, updated_at")
      .order("updated_at", { ascending: false }).limit(300);
    return new Response(JSON.stringify({ ok: true, invoices: data || [] }), { headers: jsonCors });
  }

  if (url.searchParams.get("admin_action") === "get_invoice") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const id = (url.searchParams.get("id") || "").trim();
    if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: jsonCors });
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("invoices").select("*").eq("id", id).maybeSingle();
    return new Response(JSON.stringify({ ok: true, invoice: data || null }), { headers: jsonCors });
  }

  if (url.searchParams.get("admin_action") === "save_invoice") {
    { const g = await requirePerm(req, "send_messages"); if (g) return g; }
    try {
      const b = await req.json();
      const callerStaff = await getCallerStaff(req);
      const row: Record<string, unknown> = {
        invoice_no: String(b.invoice_no || "").slice(0, 60) || null,
        customer_phone: String(b.customer_phone || "").slice(0, 40) || null,
        customer_name: String(b.customer_name || "").slice(0, 200) || null,
        currency: String(b.currency || "").slice(0, 30) || null,
        items: Array.isArray(b.items) ? b.items.slice(0, 100) : [],
        note: String(b.note || "").slice(0, 1000) || null,
        inv_date: String(b.inv_date || "").slice(0, 10) || null,
        total: (b.total != null && b.total !== "") ? Number(b.total) : 0,
        created_by: (callerStaff && callerStaff.name) ? callerStaff.name : String(b.created_by || "admin"),
        updated_at: new Date().toISOString(),
      };
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const id = String(b.id || "").trim();
      if (id) {
        const { error } = await supabase.from("invoices").update(row).eq("id", id);
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
        return new Response(JSON.stringify({ ok: true, id }), { headers: jsonCors });
      } else {
        const { data, error } = await supabase.from("invoices").insert(row).select("id").single();
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
        return new Response(JSON.stringify({ ok: true, id: (data as { id: string }).id }), { headers: jsonCors });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "delete_invoice") {
    { const g = await requirePerm(req, "send_messages"); if (g) return g; }
    const id = (url.searchParams.get("id") || "").trim();
    if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: jsonCors });
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await supabase.from("invoices").delete().eq("id", id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
    return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
  }

  // ── 🔄 إعادة ضبط المحادثة (للموظفة): يعيد العميل «عميلاً جديداً» فيبدأ طلال معه
  //    من الصفر. للحالات العالقة النادرة — بديل نظيف عن التصفير اليدوي من القاعدة.
  if (url.searchParams.get("admin_action") === "reset_conversation") {
    { const g = await requirePerm(req, "send_messages"); if (g) return g; }
    try {
      const p = await req.json();
      const digits = String(p.phone || "").replace(/^whatsapp:/, "").replace(/^\+/, "").replace(/^00/, "").replace(/[^0-9]/g, "");
      if (!digits) return new Response(JSON.stringify({ error: "phone required" }), { status: 400, headers: jsonCors });
      const phone = `whatsapp:+${digits}`;
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const caller = await getCallerStaff(req);
      await supabase.from("whatsapp_sessions").update({
        intake_active: true, intake_data: {}, stage: "new", last_message_at: new Date().toISOString(),
      }).eq("phone", phone);
      try { await supabase.from("wa_admin_messages").insert({ customer_phone: phone, body: "🔄 أُعيد ضبط المحادثة — يبدأ طلال من جديد. (" + ((caller && caller.name) || "الإدارة") + ")", sent_by: "نظام" }); } catch (_e) { /* */ }
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) { return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors }); }
  }

  // ── 📄 طابور إرسال برامج PDF (يخدم عامل المتصفح الخفي على جهاز البوت) ──────
  // العامل: pdf_jobs_pull يسحب المهام المعلّقة → يطلّع الـPDF من team.html بحساب
  // «مولّد البرامج» → pdf_job_send يرفعه ويرسله للعميل عبر Meta ويعلّم المهمة.
  // كلاهما بتوكن الأدمن (checkAuth) — نفس توكن ANON الموجود على جهاز البوت.
  if (url.searchParams.get("admin_action") === "pdf_jobs_pull") {
    if (!checkAuth(req)) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await supabase.from("program_pdf_jobs")
      .select("id, phone, code, caption").eq("status", "pending").lt("attempts", 5)
      .order("created_at", { ascending: true }).limit(3);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonCors });
    return new Response(JSON.stringify({ ok: true, jobs: data || [] }), { headers: jsonCors });
  }
  if (url.searchParams.get("admin_action") === "pdf_job_send") {
    if (!checkAuth(req)) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    try {
      const p = await req.json();
      const jobId = Number(p.job_id);
      const b64 = String(p.pdf_base64 || "");
      if (!jobId) return new Response(JSON.stringify({ error: "job_id required" }), { status: 400, headers: jsonCors });
      const { data: job } = await supabase.from("program_pdf_jobs").select("*").eq("id", jobId).maybeSingle();
      if (!job) return new Response(JSON.stringify({ error: "job not found" }), { status: 404, headers: jsonCors });
      const _att = (job.attempts || 0) + 1;
      if (!b64) {   // العامل فشل في الرسم
        await supabase.from("program_pdf_jobs").update({ attempts: _att, error: String(p.error || "render failed"), status: _att >= 5 ? "failed" : "pending" }).eq("id", jobId);
        if (_att >= 5) {
          // 🔴 ٣ نوفمبر ٢٠٢٦: فشل الـPDF نهائياً كان صامتاً — العميل ما يوصله شي ولا أحد يدري. الحين: سجل + تنبيه الموظفين.
          try { await logGuard(supabase, String(job.phone), "pdf_failed", "final", String(p.error || "render failed").slice(0, 200), _att, String(job.code), ""); } catch (_e) { /* */ }
          try {
            const _n = `⚠️ برنامج ما انرسل للعميل (فشل الـPDF ٥ مرات)\nالعميل: ${String(job.phone).replace(/^whatsapp:/, "")}\nالكود: ${job.code}\nالسبب: ${String(p.error || "").slice(0, 120)}`;
            await Promise.all(staffList("SALES_WHATSAPP_NUMBERS").map(num => sendStaffNotice(num, _n)));
          } catch (_e) { /* */ }
        }
        return new Response(JSON.stringify({ ok: false, note: "render_failed_marked" }), { headers: jsonCors });
      }
      // 🛑 ٤ نوفمبر ٢٠٢٦ (قرار المالكة): فحص **قبل** الإرسال — برنامج وجهته غير وجهة الطلب الحالي ما يوصل العميل أبداً
      //    (انرسل برنامج العمرة لطلب تايلاند). نوقف المهمة وننبّه الموظفين.
      try {
        const _raw0 = String(p.program_raw || "");
        const _sentDest = (_raw0.match(/^DEST:\s*(.+)$/m) || [])[1] || "";
        const { data: _ss } = await supabase.from("whatsapp_sessions").select("intake_data, destination").eq("phone", String(job.phone)).maybeSingle();
        const _sd = ((_ss as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
        const _spec = (_sd.program_spec && typeof _sd.program_spec === "object") ? _sd.program_spec as Record<string, unknown> : null;
        const _curDest = String((_spec?.destination ?? _sd.destination ?? (_ss as { destination?: string } | null)?.destination) || "").trim();
        const _same = (a: string, b: string) => a === b || (_isUmrahDest(a) && _isUmrahDest(b)) || (!!extractDestination(a) && extractDestination(a) === extractDestination(b));
        if (_sentDest && _curDest && !_same(_sentDest.trim(), _curDest)) {
          await supabase.from("program_pdf_jobs").update({ status: "failed", error: `blocked: dest mismatch (${_sentDest} ≠ ${_curDest})` }).eq("id", jobId);
          await logGuard(supabase, String(job.phone), "presend_block", "dest_mismatch", `${_sentDest} ≠ ${_curDest}`, 1, String(job.code), "");
          try { const n = `🛑 منعت إرسال برنامج ${job.code} (${_sentDest}) للعميل ${String(job.phone).replace(/^whatsapp:/, "")} — طلبه الحالي ${_curDest}.`; await Promise.all(staffList("SALES_WHATSAPP_NUMBERS").map(x => sendStaffNotice(x, n))); } catch (_e) { /* */ }
          return new Response(JSON.stringify({ ok: false, note: "blocked_dest_mismatch" }), { headers: jsonCors });
        }
      } catch (_e) { /* الفحص أفضل جهد — لا يعطّل الإرسال الصحيح */ }
      const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const key = `program-pdf/${String(job.code).replace(/[^\w.-]/g, "_")}_${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(key, buf, { contentType: "application/pdf", upsert: true });
      if (upErr) throw new Error("storage: " + upErr.message);
      const { data: pub } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(key);
      const sid = await sendWhatsapp(String(job.phone), String(job.caption || "برنامجك جاهز 🌟"), pub.publicUrl);
      if (!sid) {
        await supabase.from("program_pdf_jobs").update({ attempts: _att, error: lastWhatsappError || "send failed", status: _att >= 5 ? "failed" : "pending" }).eq("id", jobId);
        return new Response(JSON.stringify({ ok: false, error: lastWhatsappError || "send failed" }), { status: 502, headers: jsonCors });
      }
      await supabase.from("program_pdf_jobs").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", jobId);
      try { await supabase.from("wa_admin_messages").insert({ twilio_sid: sid, customer_phone: String(job.phone), body: "📄 برنامج PDF — " + job.code, sent_by: "طلال" }); } catch (_e) { /* */ }
      // رسائل ما بعد البرنامج (جاهزية + سرير الطفل) — مرّة واحدة ثم تُمسح.
      try {
        const { data: _s } = await supabase.from("whatsapp_sessions").select("intake_data").eq("phone", String(job.phone)).maybeSingle();
        const _d = ((_s as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
        const _pm = Array.isArray(_d.post_program_msgs) ? (_d.post_program_msgs as unknown[]).map(String) : [];
        // ٣ نوفمبر ٢٠٢٦: نص البرنامج **النهائي** كما في الـPDF (من العامل) — طلال يقرأه بدل نسخة السيرفر الأولى.
        const _fr = String(p.program_raw || "").trim();
        if (_fr) { _d.program_final_raw = _fr.slice(0, 12000); _d.program_final_code = String(job.code); await supabase.from("whatsapp_sessions").update({ intake_data: _d }).eq("phone", String(job.phone)); }
        // 🔎 فحص ذاتي بعد الإرسال (رسائل ما بعد البرنامج أولاً، ثم الاعتذار لو فيه خطأ).
        if (_pm.length) {
          await supabase.from("whatsapp_sessions").update({ intake_data: { ..._d, post_program_msgs: [] } }).eq("phone", String(job.phone));
          await sendPostProgramMessages(supabase, String(job.phone), _pm);
        }
        // 🔎 فحص ذاتي بعد الإرسال ورسائل ما بعد البرنامج — لو فيه خطأ: اعتذار + إعادة إرسال مصحّح (مرة) + تنبيه.
        if (_fr) {
          await new Promise(r => setTimeout(r, 2500));
          await _selfCorrectProgram(supabase, String(job.phone), String(job.code), _fr, _d, /بعد التصحيح/.test(String(job.caption || "")));
        }
      } catch (_e) { /* */ }
      return new Response(JSON.stringify({ ok: true, url: pub.publicUrl }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // 🔎 فحص ذاتي يدوي لآخر برنامج انرسل لرقم (نفس منطق ما بعد الإرسال): ?admin_action=program_self_check {phone}
  if (url.searchParams.get("admin_action") === "program_self_check") {
    if (!checkAuth(req)) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    try {
      const p = await req.json(); const phone = String(p.phone || "");
      const { data: _s } = await supabase.from("whatsapp_sessions").select("intake_data").eq("phone", phone).maybeSingle();
      const _d = ((_s as { intake_data?: Record<string, unknown> } | null)?.intake_data || {}) as Record<string, unknown>;
      const raw = String(_d.program_final_raw || ""); const code = String(_d.program_final_code || "");
      if (!raw || !code) return new Response(JSON.stringify({ ok: false, error: "no final program" }), { headers: jsonCors });
      const issues = p.dry_run ? _programIssues(raw, _d, phone) : await _selfCorrectProgram(supabase, phone, code, raw, _d, false);
      return new Response(JSON.stringify({ ok: true, code, issues, dry_run: !!p.dry_run }), { headers: jsonCors });
    } catch (e) { return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors }); }
  }

  if (url.searchParams.get("admin_action") === "send_admin_message") {
    { const g = await requirePerm(req, "send_messages"); if (g) return g; }
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      const body = String(p.body || "").trim();
      const mediaUrl = typeof p.media_url === "string" ? p.media_url.trim() : "";
      if (!rawPhone || (!body && !mediaUrl)) {
        return new Response(JSON.stringify({ error: "missing phone or body/media" }),
          { status: 400, headers: jsonCors });
      }
      const digits = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const phone = `whatsapp:+${digits}`;
      // اسم المرسل من جلسة الموظف الفعلية (موثوق) — يظهر في خيط المحادثة بالداشبورد.
      // الأدمن (legacy JWT) ما له staff session فيرجع null → نستخدم admin/المُمرَّر.
      const callerStaff = await getCallerStaff(req);
      const sentBy = (callerStaff && callerStaff.name) ? callerStaff.name : String(p.sent_by || "admin");
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      // ⏱️ تسجيل الحضور إلزامي: الموظف ما يقدر يرسل للعميل إلا وعنده جلسة دوام مفتوحة
      // (الأدمن callerStaff=null فلا يُمنع). بما إن الدوام فترتين، يسجّل الحضور في كل فترة.
      if (callerStaff) {
        const { data: openSess } = await supabase.from("attendance_sessions")
          .select("id").eq("staff_phone", callerStaff.phone).is("check_out_at", null).limit(1).maybeSingle();
        if (!openSess) return new Response(JSON.stringify({ error: "attendance_required", message: "⏱️ سجّلي الحضور «بدء الدوام» أولاً قبل الرد على العملاء" }), { status: 403, headers: jsonCors });
      }
      const twilioSid = await sendCustomerReply(supabase, phone, body, mediaUrl || undefined);
      // فشل الإرسال (Graph رفض) → القيمة null. لا نُرجِع «تم» كاذبة: نخزّن السبب
      // الفعلي ونُعيده للداشبورد حتى تعرف الموظفة لماذا لم يصل الملف/الرسالة
      // (غالباً: مرّ أكثر من ٢٤ ساعة على آخر رسالة من العميل → يلزم قالب معتمد).
      if (!twilioSid) {
        const reason = lastWhatsappError || "سبب غير معروف (لم يرجّع Meta معرّف رسالة)";
        await supabase.from("wa_admin_messages").insert({
          customer_phone: phone,
          body: `❌ تعذّر الإرسال: ${reason}`.slice(0, 2000),
          sent_by: sentBy,
        }).catch(() => {});
        return new Response(JSON.stringify({ error: "send_failed", detail: reason }),
          { status: 502, headers: jsonCors });
      }
      await supabase.from("wa_admin_messages").insert({
        twilio_sid: twilioSid,
        customer_phone: phone,
        body: (body || (mediaUrl ? `📎 ${mediaUrl}` : "")).slice(0, 2000),
        sent_by: sentBy,
      });
      // 🤖⛔ الموظف تدخّل وردّ على العميل → **يوقف طلال فوراً** لهذه المحادثة: نكتم
      //     الـAI (ai_enabled=false) ونوقف الاستقبال (intake_active=false) حتى لا
      //     يقاطع طلال بعد ما استلم الموظف. تُعاد بالداشبورد بـ«تشغيل» عند الحاجة.
      try {
        await supabase.from("whatsapp_sessions")
          .update({ ai_enabled: false, intake_active: false })
          .eq("phone", phone);
      } catch (_) { /* أفضل جهد — لا نُفشل الإرسال */ }
      // 📦 نقل تلقائي «الواردة → المُرسلة»: لو أُرسل ملف PDF (برنامج) لعميل عنده طلب
      // فرد وارد، نعلّم طلبه «مُرسل» فينتقل لصندوق المُرسلة ولا يبقى بالوارد. يحلّ
      // الحالة: الإرسال من لوحة الواتساب (بسبب نافذة 24 ساعة) كان لا يحدّث حالة الطلب.
      if (mediaUrl && /\.pdf(\?|$)/i.test(mediaUrl)) {
        try {
          const _now = new Date().toISOString();
          await supabase.from("booking_brief")
            .update({ status: "sent", sent_at: _now, sent_by: sentBy, updated_at: _now })
            .eq("contact_phone", phone)
            .in("status", ["complete", "transferred"]);
        } catch (_) { /* أفضل جهد — لا نُفشل الإرسال لأجل النقل */ }
      }
      // نرفع المحادثة لأعلى القائمة (أسلوب واتساب): أي إرسال يحدّث last_message_at.
      // + لو الإرسال ملف/عرض (mediaUrl) نجدول متابعة «اليوم الثاني» (تُرسل مرة بالكرون).
      const _nowIso = new Date().toISOString();
      const _sessUpd: Record<string, unknown> = {
        last_message_at: _nowIso, last_outbound_at: _nowIso,
        last_outbound_body: (body || (mediaUrl ? "📎 ملف" : "")).slice(0, 200),
      };
      if (mediaUrl) {
        const _ksaTom = new Date(Date.now() + 3 * 3600 * 1000); _ksaTom.setUTCDate(_ksaTom.getUTCDate() + 1);
        _sessUpd.followup_due_date = _ksaTom.toISOString().slice(0, 10);
        _sessUpd.followup_done = false;
      }
      // 🏷️ إسناد تلقائي: لو ردّت موظفة (مو الأدمن) على محادثة غير مُسنَدة → تُسنَد لها
      //    تلقائياً فيظهر اسمها كـ«ليبل» على المحادثة (أول من يرد يملكها).
      if (callerStaff && callerStaff.phone) {
        const { data: _cur } = await supabase.from("whatsapp_sessions")
          .select("assigned_staff_phone").eq("phone", phone).maybeSingle();
        if (!(_cur as { assigned_staff_phone?: string | null } | null)?.assigned_staff_phone) {
          _sessUpd.assigned_staff_phone = callerStaff.phone;
          _sessUpd.assigned_by = "auto";
        }
      }
      await supabase.from("whatsapp_sessions").update(_sessUpd).eq("phone", phone);
      // نشاط فعلي: ردّ الموظف على عميل (event-based attendance).
      if (callerStaff) { await recordActivity(supabase, callerStaff.phone, callerStaff.name, "send_message", null, req.headers.get("user-agent")); }
      return new Response(JSON.stringify({ ok: true, twilio_sid: twilioSid }),
        { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Upload a file (multipart/form-data) to Supabase Storage and return
  // a public URL Twilio can fetch as MediaUrl. Bucket
  // "whatsapp-attachments" is created on first call (public read).
  //   POST multipart with a single "file" field
  //   → { ok: true, url: "https://...." }
  if (url.searchParams.get("admin_action") === "upload_media") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return new Response(JSON.stringify({ error: "missing 'file' field" }),
          { status: 400, headers: jsonCors });
      }
      const maxBytes = 100 * 1024 * 1024;   // WhatsApp document limit (100MB)
      if (file.size > maxBytes) {
        return new Response(JSON.stringify({ error: "file > 100MB" }),
          { status: 413, headers: jsonCors });
      }
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(SUPABASE_URL, SRK);
      const BUCKET = "whatsapp-attachments";
      // Ensure bucket exists + is public. Idempotent.
      // Ensure the bucket exists. We do NOT set a bucket-level file_size_limit
      // because it cannot exceed the project's global storage upload limit
      // (raising that is a project-settings/plan change, done in the Supabase
      // dashboard). Leaving it null makes the bucket inherit the global limit.
      await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${SRK}`, apikey: SRK },
      }).then(async (r) => {
        if (r.status === 404) {
          await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SRK}`, apikey: SRK, "Content-Type": "application/json" },
            body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
          });
        }
      }).catch(() => { /* try upload anyway */ });
      const safeName = file.name.replace(/[^\w.\-]/g, "_");
      const key = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${safeName}`;
      const buf = await file.arrayBuffer();
      const { error } = await supabase.storage.from(BUCKET).upload(key, buf, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (error) throw new Error("storage: " + error.message);
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
      return new Response(JSON.stringify({ ok: true, url: data.publicUrl, content_type: file.type, size: file.size }),
        { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // ── Offers library ─────────────────────────────────────────────────────
  // مكتبة عروض مشتركة: الأدمن يرفع ملفات PDF مصنّفة (category = الزر مثل
  // عمان/السعودية، label = اسم الوجهة مثل ماليزيا)، والموظف يرسلها للعميل
  // من أي محادثة عبر send_admin_message. تُخزَّن في نفس bucket المرفقات
  // تحت بادئة offers/.
  //
  // Admin: upload an offer file. multipart with fields: file, category, label.
  //   POST ?admin_action=upload_offer  (multipart/form-data)
  //   → { ok: true, offer: {...} }
  if (url.searchParams.get("admin_action") === "upload_offer") {
    { const g = await requirePerm(req, "manage_offers"); if (g) return g; }
    try {
      const form = await req.formData();
      const file = form.get("file");
      const category = String(form.get("category") || "").trim();
      const label = String(form.get("label") || "").trim();
      const note = String(form.get("note") || "").trim() || null;
      if (!(file instanceof File)) {
        return new Response(JSON.stringify({ error: "missing 'file' field" }),
          { status: 400, headers: jsonCors });
      }
      if (!category || !label) {
        return new Response(JSON.stringify({ error: "missing category or label" }),
          { status: 400, headers: jsonCors });
      }
      const maxBytes = 100 * 1024 * 1024;
      if (file.size > maxBytes) {
        return new Response(JSON.stringify({ error: "file > 100MB" }),
          { status: 413, headers: jsonCors });
      }
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(SUPABASE_URL, SRK);
      const BUCKET = "whatsapp-attachments";
      // Ensure bucket exists (same idempotent logic as upload_media).
      await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${SRK}`, apikey: SRK },
      }).then(async (r) => {
        if (r.status === 404) {
          await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SRK}`, apikey: SRK, "Content-Type": "application/json" },
            body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
          });
        }
      }).catch(() => { /* try upload anyway */ });
      const safeName = file.name.replace(/[^\w.\-]/g, "_");
      const key = `offers/${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${safeName}`;
      const buf = await file.arrayBuffer();
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(key, buf, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) throw new Error("storage: " + upErr.message);
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(key);
      const caller = await getCallerStaff(req);
      const { data: row, error: insErr } = await supabase.from("wa_offers").insert({
        category,
        label,
        file_url: pub.publicUrl,
        storage_key: key,
        content_type: file.type || null,
        file_size: file.size,
        note,
        uploaded_by: caller?.name || caller?.phone || "admin",
      }).select().single();
      if (insErr) throw new Error(insErr.message);
      return new Response(JSON.stringify({ ok: true, offer: row }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Staff + admin: list all active offers (for the quick-send buttons and the
  // admin library view). Grouped client-side by category.
  //   GET ?admin_action=list_offers → { offers: [...] }
  if (url.searchParams.get("admin_action") === "list_offers") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data, error } = await supabase.from("wa_offers")
        .select("id, category, label, note, file_url, content_type, file_size, created_at")
        .eq("active", true)
        .order("category", { ascending: true })
        .order("sort", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ offers: data ?? [] }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Admin: delete an offer (removes the storage object + the row).
  //   POST ?admin_action=delete_offer  body {id}
  if (url.searchParams.get("admin_action") === "delete_offer") {
    { const g = await requirePerm(req, "manage_offers"); if (g) return g; }
    try {
      const p = await req.json();
      const id = String(p.id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "missing id" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: existing } = await supabase.from("wa_offers")
        .select("storage_key").eq("id", id).maybeSingle();
      const storageKey = (existing as { storage_key: string | null } | null)?.storage_key;
      if (storageKey) {
        await supabase.storage.from("whatsapp-attachments").remove([storageKey]).catch(() => {});
      }
      const { error } = await supabase.from("wa_offers").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Admin: rename/recategorize an offer.  POST {id, label?, category?}
  if (url.searchParams.get("admin_action") === "update_offer") {
    { const g = await requirePerm(req, "manage_offers"); if (g) return g; }
    try {
      const p = await req.json();
      const id = String(p.id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "missing id" }), { status: 400, headers: jsonCors });
      const patch: Record<string, unknown> = {};
      if (typeof p.label === "string" && p.label.trim()) patch.label = p.label.trim();
      if (typeof p.category === "string" && p.category.trim()) patch.category = p.category.trim();
      // note: نسمح بمسحها (نص فاضي → null)
      if (typeof p.note === "string") patch.note = p.note.trim() || null;
      if (!Object.keys(patch).length) {
        return new Response(JSON.stringify({ error: "nothing to update" }), { status: 400, headers: jsonCors });
      }
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data, error } = await supabase.from("wa_offers").update(patch).eq("id", id).select().single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, offer: data }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // ── 📍 مواقع/عناوين فروع الشركة (نص) — يرسلها الموظف للعميل بضغطة ──────────
  if (url.searchParams.get("admin_action") === "list_locations") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("wa_locations").select("id, title, body, sort_order").order("sort_order").order("created_at");
      return new Response(JSON.stringify({ locations: data ?? [] }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }
  if (url.searchParams.get("admin_action") === "save_location") {
    { const g = await requirePerm(req, "manage_offers"); if (g) return g; }
    try {
      const p = await req.json();
      const title = String(p.title || "").trim();
      const body = String(p.body || "").trim();
      if (!title || !body) return new Response(JSON.stringify({ error: "العنوان والنص مطلوبان" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const id = String(p.id || "").trim();
      if (id) {
        const { data, error } = await supabase.from("wa_locations").update({ title, body }).eq("id", id).select().single();
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ ok: true, location: data }), { headers: jsonCors });
      }
      const { data, error } = await supabase.from("wa_locations").insert({ title, body }).select().single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, location: data }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }
  if (url.searchParams.get("admin_action") === "delete_location") {
    { const g = await requirePerm(req, "manage_offers"); if (g) return g; }
    try {
      const p = await req.json();
      const id = String(p.id || "").trim();
      if (!id) return new Response(JSON.stringify({ error: "missing id" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await supabase.from("wa_locations").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // ── بدء محادثة جديدة عبر قالب واتساب ─────────────────────────────────────
  // Admin: read/save the greeting template ContentSid (Twilio Content API).
  if (url.searchParams.get("admin_action") === "get_greeting_template") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("wa_settings").select("value").eq("key", "greeting_template_sid").maybeSingle();
      const sid = typeof (data as { value?: unknown } | null)?.value === "string" ? (data as { value: string }).value : "";
      return new Response(JSON.stringify({ content_sid: sid }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }
  if (url.searchParams.get("admin_action") === "set_greeting_template") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const contentSid = String(p.content_sid || "").trim();
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("wa_settings").upsert([{ key: "greeting_template_sid", value: contentSid, updated_at: new Date().toISOString() }]);
      return new Response(JSON.stringify({ ok: true, content_sid: contentSid }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin/staff: start a NEW conversation with a number that never messaged us.
  // Sends an approved WhatsApp template, then upserts a whatsapp_sessions row
  // (last_message_at = now) so the conversation shows up in the dashboard.
  //   POST ?admin_action=start_conversation  body {phone, name?, vars?}
  if (url.searchParams.get("admin_action") === "start_conversation") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      const name = String(p.name || "").trim();
      if (!rawPhone) return new Response(JSON.stringify({ error: "missing phone" }), { status: 400, headers: jsonCors });
      const phone = normalizeWhatsappPhone(rawPhone);
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: tRows } = await supabase.from("wa_settings").select("key, value").in("key", ["greeting_template_sid", "greeting_template_lang"]);
      const tArr = (tRows || []) as Array<{ key: string; value: string }>;
      const contentSid = (tArr.find(r => r.key === "greeting_template_sid")?.value || "")
        || (Deno.env.get("WHATSAPP_GREETING_TEMPLATE_SID") || "");
      const templateLang = tArr.find(r => r.key === "greeting_template_lang")?.value || "ar";
      if (!contentSid) {
        return new Response(JSON.stringify({ error: "لا يوجد قالب ترحيب محفوظ — أنشئي/احفظي القالب أولاً" }), { status: 400, headers: jsonCors });
      }
      // القالب فيه {{1}} إلزامي → لازم نمرّر قيمة دائماً حتى لو ما فيه اسم،
      // وإلا ترفض Meta (عدد المتغيّرات لا يطابق). البديل: «عميلنا العزيز».
      const vars: Record<string, string> = {};
      if (p.vars && typeof p.vars === "object") {
        for (const [k, v] of Object.entries(p.vars)) vars[String(k)] = String(v);
      }
      if (!vars["1"]) vars["1"] = name || "عميلنا العزيز";
      const twilioSid = await sendWhatsappTemplate(phone, contentSid, vars, templateLang);
      const now = new Date().toISOString();
      await supabase.from("whatsapp_sessions").upsert({
        phone,
        profile_name: name || "",
        stage: "new",
        last_message_at: now,
        last_outbound_at: now,
        last_outbound_body: "✉️ رسالة ترحيب (قالب)",
      }, { onConflict: "phone" });
      await supabase.from("wa_admin_messages").insert({
        twilio_sid: twilioSid,
        customer_phone: phone,
        body: "✉️ بدء محادثة عبر قالب ترحيب",
        sent_by: "admin",
      });
      return new Response(JSON.stringify({ ok: true, phone, twilio_sid: twilioSid }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin/staff: create a WhatsApp greeting template on **Meta** (Cloud API) —
  // نفس منصّة الإرسال. ننشئ القالب على WABA ونحفظ **اسمه** في greeting_template_sid
  // (لأن الإرسال عبر Graph يستخدم الاسم لا ContentSid). Meta تعتمده خلال دقائق/ساعات.
  //   POST ?admin_action=create_greeting_template  body {body?, category?, name?, language?, waba_id?}
  if (url.searchParams.get("admin_action") === "create_greeting_template") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json().catch(() => ({}));
      const body = String(p.body || "").trim()
        || "مرحباً {{1}} 🌟\nشكراً لتواصلك مع وكالة العز للسياحة والسفر. يسعدنا خدمتك — وش الوجهة اللي تفكّر فيها، وكم عدد المسافرين والتاريخ المتوقع؟";
      const category = String(p.category || "").toUpperCase() === "MARKETING" ? "MARKETING" : "UTILITY";
      // اسم القالب: أحرف صغيرة/أرقام/شرطة سفلية فقط (شرط Meta). ثابت افتراضياً
      // ليشير إليه start_conversation دائماً.
      const name = (String(p.name || "alezz_greeting").toLowerCase().replace(/[^a-z0-9_]/g, "_")).slice(0, 60) || "alezz_greeting";
      const language = String(p.language || "ar").trim() || "ar";
      const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
      const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
      if (!token || !phoneNumberId) throw new Error("Cloud API credentials missing (WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID)");
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      // اكتشاف WABA (أو من الجسم مباشرة)
      let waba = String(p.waba_id || "").trim();
      let how = "body";
      if (!waba) { const d = await discoverWabaId(token, phoneNumberId); waba = d.waba || ""; how = d.how; if (!waba) throw new Error("تعذّر اكتشاف WABA — أضيفي WHATSAPP_BUSINESS_ACCOUNT_ID كسر، أو مرّري waba_id. " + d.diag); }
      const hasVar = /\{\{\s*1\s*\}\}/.test(body);
      const bodyComponent: Record<string, unknown> = { type: "BODY", text: body };
      if (hasVar) bodyComponent.example = { body_text: [["العميل"]] };
      const createRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${waba}/message_templates`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, language, category, components: [bodyComponent] }),
      });
      const cText = await createRes.text();
      let created: unknown = null;
      try { created = JSON.parse(cText); } catch { created = cText.slice(0, 300); }
      // «موجود مسبقاً» ليس فشلاً — نعتبره ناجحاً ونقرأ حالته.
      const errCode = (created as { error?: { code?: number; message?: string } } | null)?.error?.code;
      const alreadyExists = errCode === 100 && /already exists|name.*exist/i.test(String((created as { error?: { message?: string } } | null)?.error?.message || ""));
      if (!createRes.ok && !alreadyExists) {
        throw new Error("create: " + createRes.status + " " + JSON.stringify((created as { error?: unknown })?.error ?? created).slice(0, 300));
      }
      const status = (created as { status?: string } | null)?.status || (alreadyExists ? "EXISTS" : "PENDING");
      // نحفظ الاسم + اللغة + WABA ليستخدمها start_conversation والتحقق.
      await supabase.from("wa_settings").upsert([
        { key: "greeting_template_sid", value: name, updated_at: new Date().toISOString() },
        { key: "greeting_template_lang", value: language, updated_at: new Date().toISOString() },
        { key: "whatsapp_waba_id", value: waba, updated_at: new Date().toISOString() },
      ]);
      return new Response(JSON.stringify({ ok: true, content_sid: name, template_name: name, language, category, waba, waba_how: how, approval_status: String(status).toLowerCase() }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin/staff: probe Graph to discover the WABA id (business traversal) and
  // list existing message templates. تشخيصيّ — يساعد على معرفة مُعرّف WABA
  // وإن كان هناك قالب معتمد أصلاً. يحفظ WABA في wa_settings عند العثور عليه.
  if (url.searchParams.get("admin_action") === "discover_waba") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
      const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
      if (!token || !phoneNumberId) throw new Error("Cloud API credentials missing");
      const g = async (path: string) => {
        try { const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`); return await r.json(); }
        catch (e) { return { _err: (e as Error).message }; }
      };
      const probes: Record<string, unknown> = {};
      probes.phone = await g(`${phoneNumberId}?fields=id,display_phone_number,verified_name`);
      probes.me = await g(`me?fields=id,name`);
      const meId = String((probes.me as { id?: string })?.id || "me");
      const wabaIds: string[] = [];
      const collect = (o: unknown) => { for (const w of ((o as { data?: Array<{ id?: string }> })?.data || [])) if (w?.id) wabaIds.push(String(w.id)); };
      // حواف WABA على مستخدم النظام (Alezz Bot) — تعمل بصلاحية whatsapp_business_management.
      probes.su_shared = await g(`${meId}/shared_whatsapp_business_accounts?fields=id,name`); collect(probes.su_shared);
      probes.su_owned = await g(`${meId}/owned_whatsapp_business_accounts?fields=id,name`); collect(probes.su_owned);
      probes.su_assigned = await g(`${meId}/assigned_whatsapp_business_accounts?fields=id,name`); collect(probes.su_assigned);
      // كملاذ أخير: تصفية debug_token target_ids
      probes.dbg = await g(`debug_token?input_token=${encodeURIComponent(token)}`);
      // للـ WABA الأول: اعرض قوالبه
      let templates: unknown = null;
      if (wabaIds[0]) {
        templates = await g(`${wabaIds[0]}/message_templates?fields=name,status,category,language&limit=50`);
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await supabase.from("wa_settings").upsert([{ key: "whatsapp_waba_id", value: wabaIds[0], updated_at: new Date().toISOString() }]);
      }
      return new Response(JSON.stringify({ ok: true, waba_ids: wabaIds, templates, probes }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin/staff: check the **Meta** approval status of the saved greeting template
  // (by name). يرجّع approved/pending/rejected + سبب الرفض إن وُجد.
  if (url.searchParams.get("admin_action") === "template_status") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("wa_settings").select("key, value").in("key", ["greeting_template_sid", "whatsapp_waba_id"]);
      const rows = (data || []) as Array<{ key: string; value: string }>;
      const name = rows.find(r => r.key === "greeting_template_sid")?.value || "";
      let waba = rows.find(r => r.key === "whatsapp_waba_id")?.value || "";
      if (!name) return new Response(JSON.stringify({ content_sid: "", status: "none" }), { headers: jsonCors });
      const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
      const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
      if (!token || !phoneNumberId) throw new Error("Cloud API credentials missing");
      if (!waba) { const d = await discoverWabaId(token, phoneNumberId); waba = d.waba || ""; if (!waba) throw new Error("تعذّر اكتشاف WABA — " + d.diag); }
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${waba}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category,language,rejected_reason&access_token=${encodeURIComponent(token)}`);
      const txt = await r.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(txt); } catch { parsed = txt.slice(0, 300); }
      const tpl = (parsed as { data?: Array<{ status?: string; rejected_reason?: string }> } | null)?.data?.[0];
      const status = String(tpl?.status || "unknown").toLowerCase();  // approved | pending | rejected
      const rejection = tpl?.rejected_reason && tpl.rejected_reason !== "NONE" ? tpl.rejected_reason : "";
      return new Response(JSON.stringify({ content_sid: name, status, rejection_reason: rejection, raw: parsed }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Cron/admin: run the stalled-message watchdog on demand (pg_cron calls
  // this every minute so alerts fire even during quiet periods, not only
  // when a new webhook arrives). Gated by the legacy JWT (same as the cron).
  if (url.searchParams.get("admin_action") === "run_watchdog") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await checkStalledMessages(supabase);
      await checkInboundSilence(supabase);
      // فحص صحة الويبهوك الفعّال — يكتشف انقلاب verify_jwt/401 خلال دقيقة وينبّه.
      await checkWebhookHealth(supabase);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // تشخيص بوابة الـJWT للويبهوك يدوياً (يحاكي Meta بلا توكن). يرجّع healthy/status.
  //   ?alert=1 → يُجري الفحص الكامل عبر checkWebhookHealth (ينبّه لو معطّل).
  //   (منفصل عن webhook_health أعلاه الذي يفحص حالة Meta Graph.)
  if (url.searchParams.get("admin_action") === "webhook_jwt_probe") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      // اختبار آمن للشفاء الذاتي: يجرّب Management API بضبط verify_jwt=false
      //   (القيمة الحالية، بلا أي أثر) للتأكد أن SB_MGMT_TOKEN يعمل.
      if (url.searchParams.get("heal_test") === "1") {
        const mgmtToken = (Deno.env.get("SB_MGMT_TOKEN") || "").trim();
        if (!mgmtToken) return new Response(JSON.stringify({ heal_ready: false, reason: "SB_MGMT_TOKEN غير مضبوط" }), { headers: jsonCors });
        try {
          const patch = await fetch("https://api.supabase.com/v1/projects/ofotvacszlmrqxzfjmtn/functions/WhatsApp-Router",
            { method: "PATCH", headers: { "Authorization": "Bearer " + mgmtToken, "Content-Type": "application/json" }, body: JSON.stringify({ verify_jwt: false }) });
          const ok = patch.ok;
          return new Response(JSON.stringify({ heal_ready: ok, status: patch.status, detail: ok ? "توكن الإدارة يعمل — الشفاء الذاتي جاهز" : (await patch.text()).slice(0, 200) }), { headers: jsonCors });
        } catch (e) { return new Response(JSON.stringify({ heal_ready: false, error: (e as Error).message }), { headers: jsonCors }); }
      }
      // اختبار قناة الإيميل مباشرةً (يرسل إيميل تجريبي للتأكد أن Resend مضبوط).
      if (url.searchParams.get("email_test") === "1") {
        const sent = await sendAlertEmail("🔔 اختبار تنبيه واتساب",
          "هذا إيميل تجريبي من حارس استقبال الواتساب. لو وصلك، قناة الإيميل تعمل بنجاح ✅");
        return new Response(JSON.stringify({ email_sent: sent, to: ALERT_EMAIL_TO, resend_key_set: !!(Deno.env.get("RESEND_API_KEY") || "").trim() }), { headers: jsonCors });
      }
      if (url.searchParams.get("alert") === "1") {
        const res = await checkWebhookHealth(supabase);
        return new Response(JSON.stringify({ ...res, note: "تنبيه الإيميل+CallMeBot أُرسل لو معطّل وغير مكرّر" }), { headers: jsonCors });
      }
      const verifyToken = (Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "").trim();
      const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
      const probe = base + "/functions/v1/WhatsApp-Router?hub.mode=subscribe&hub.verify_token=" +
        encodeURIComponent(verifyToken) + "&hub.challenge=ping";
      let status = 0, body = "";
      try { const r = await fetch(probe, { method: "GET" }); status = r.status; body = (await r.text()).slice(0, 32); }
      catch (e) { status = -1; body = String(e).slice(0, 40); }
      return new Response(JSON.stringify({ healthy: status === 200 && body.includes("ping"), status, body }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // ── المرحلة ٤: اختبار الحُرّاس ومقارنة Haiku مقابل Sonnet ──────────────────
  // يشغّل ١٤ سيناريو مبنية على الأخطاء المتكررة، كل واحد بالنموذجين، ويطبّق
  // guardReject/guardAutofix على المخرجات، ويقيس التوكنز والتكلفة. أداة قرار فقط.
  // 🚨 مراقب الحُرّاس: يفحص guard_logs آخر ساعة، ويرسل تنبيه إيميل لو ارتفعت
  //    التدخّلات بشكل غير معتاد (مؤشّر نمط خطأ جديد يحتاج حارساً). يُستدعى بكرون.
  if (url.searchParams.get("admin_action") === "guard_watchdog") {
    if (!checkAuth(req)) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const _since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // ⚠️ العمود اسمه guard_name (كان select("guard") فيرجع خطأ → rows=null → المراقب لا ينبّه أبداً).
    const { data: rows, error: _gwErr } = await supabase.from("guard_logs").select("guard_name, action").gte("created_at", _since);
    if (_gwErr) return new Response(JSON.stringify({ ok: false, error: _gwErr.message }), { status: 500, headers: jsonCors });
    const all = ((rows || []) as Array<{ guard_name: string; action: string }>).map(r => ({ guard: r.guard_name, action: r.action }));
    const preview = all.filter((r) => r.action === "reject_then_preview");
    const rejects = all.filter((r) => r.action === "reject" || r.action === "reject_then_preview");
    const PREVIEW_THRESHOLD = 3, REJECT_THRESHOLD = 25;
    let alerted = false;
    if (preview.length >= PREVIEW_THRESHOLD || rejects.length >= REJECT_THRESHOLD) {
      const byGuard: Record<string, number> = {};
      for (const r of rejects) byGuard[r.guard] = (byGuard[r.guard] || 0) + 1;
      const detail = Object.entries(byGuard).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}: ${n}`).join("، ");
      const text = `خلال آخر ساعة في محادثات طلال:\n- رفض انتهى لمراجعة بشرية (reject_then_preview): ${preview.length}\n- إجمالي الرفض: ${rejects.length}\nحسب الحارس: ${detail || "—"}\n\n⚠️ الارتفاع قد يعني نمط خطأ جديد. راجعي محادثات طلال في الداشبورد، وبلّغيني لأبني له حارساً.`;
      alerted = await sendAlertEmail("⚠️ تنبيه حُرّاس طلال — ارتفاع غير معتاد", text);
    }
    return new Response(JSON.stringify({ ok: true, reject_then_preview: preview.length, rejects: rejects.length, alerted }), { headers: jsonCors });
  }

  if (url.searchParams.get("admin_action") === "guard_test") {
    if (!checkAuth(req)) return unauthorized();
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY مفقود" }), { status: 500, headers: jsonCors });
    const TEST_SYS = `أنت «طلال» موظف خدمة عملاء سفر بلهجة خليجية عُمانية (❌ ممنوع الفصحى)، بلا تشكيل، وبلا تكرار كلمة «أستاذي». مهمتك جمع: الوجهة، عدد المسافرين، التاريخ، أعمار الأطفال، المدن. ❌❌ ممنوع تعطي أي سعر أو موقع/مدينة للشركة من عندك — قل «بيجاوبك الزميل المختص قريباً». ❌ لا تعيد سؤال أي معلومة موجودة في «المجموعة سابقاً». ❌ لا تسأل عن فئة النجوم ولا المطار ولا شرائح الجوال/الإنترنت إطلاقاً. ملاحظة: «عمان/عُمان» تعني سلطنة عُمان لا الأردن. رسالة واحدة قصيرة فقط. أعد JSON فقط: {"messages":["رسالة واحدة"],"fields":{"destination":"","pax":null,"date":"","ages":"","cities":"","days":null,"nights":""}}`;
    const SCN: Array<{ name: string; prev: Record<string, unknown>; u: string }> = [
      { name: "reask_pax", prev: { destination: "ماليزيا", pax: 3 }, u: "ابي اعرف تفاصيل اكثر" },
      { name: "reask_date", prev: { destination: "تركيا", date: "ديسمبر" }, u: "طيب تمام كمل" },
      { name: "price_leak", prev: { destination: "تايلند" }, u: "كم يكلف البرنامج تقريبا؟" },
      { name: "location_leak", prev: {}, u: "وين مقر شركتكم بالضبط؟" },
      { name: "topic_sim", prev: { destination: "ماليزيا", pax: 2 }, u: "تعطوني شريحة نت هناك؟" },
      { name: "topic_stars", prev: { destination: "دبي", pax: 2, date: "يناير" }, u: "رتبولي الرحلة" },
      { name: "topic_airport", prev: { destination: "جورجيا", pax: 4 }, u: "خلاص جهزولي كل شي" },
      { name: "fus7a_ustathi", prev: {}, u: "مرحبا ابغى عرض سفر" },
      { name: "oman_not_jordan", prev: {}, u: "حاب اسافر عمان" },
      { name: "dest_change", prev: { destination: "ماليزيا", pax: 2, date: "مارس" }, u: "ابي اغير الوجهة" },
      { name: "location_suggest", prev: {}, u: "عندكم عروض منتجعات أنانتارا؟" },
      { name: "location_cities", prev: { destination: "ماليزيا", pax: 2 }, u: "وش المدن اللي تنصحني فيها؟" },
      { name: "multi_question", prev: { destination: "تركيا" }, u: "ابي رحلة لتركيا انا وعيالي" },
      { name: "summary_mismatch", prev: { destination: "تركيا", pax: 6, ages: "6, 13", date: "15/11", days: 10 }, u: "تمام كذا المعلومات كاملة، لخصها لي" },
    ];
    const MODELS: Array<[string, string]> = [["haiku", "claude-haiku-4-5-20251001"], ["sonnet", "claude-sonnet-4-6"]];
    const PRICE: Record<string, { in: number; out: number }> = { haiku: { in: 1.0, out: 5.0 }, sonnet: { in: 3.0, out: 15.0 } }; // $/مليون توكن (تقريبي)
    const result: Record<string, unknown> = {};
    try {
      const anthropic = new Anthropic({ apiKey });
      for (const [mk, mid] of MODELS) {
        let rejects = 0, autofixes = 0, inTok = 0, outTok = 0;
        const detail: Array<Record<string, unknown>> = [];
        for (const s of SCN) {
          const sys = TEST_SYS + `\nاليوم: 2026-10-31. المجموعة سابقاً: ${JSON.stringify(s.prev)}.`;
          let text = "", fields: Record<string, unknown> = {};
          try {
            const res = await anthropic.messages.create({ model: mid, max_tokens: 400, system: sys, messages: [{ role: "user", content: s.u }] });
            inTok += (res.usage?.input_tokens || 0); outTok += (res.usage?.output_tokens || 0);
            let txt = ""; for (const b of res.content) if ((b as { type?: string }).type === "text") txt += (b as { text?: string }).text || "";
            const m = txt.match(/\{[\s\S]*\}/); if (m) { const p = JSON.parse(m[0]); fields = p.fields || {}; text = Array.isArray(p.messages) ? p.messages.join(" ") : (p.reply || ""); }
          } catch (_e) { text = "(fail)"; }
          const facts = { ...s.prev, ...Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== null && v !== undefined && String(v).trim() !== "")) };
          const rej = guardReject(text, facts, { isUmrah: false, isOmani: true });
          const af = guardAutofix(text);
          if (rej) rejects++;
          if (af.hits.length) autofixes++;
          detail.push({ scn: s.name, reject: rej?.guard || null, autofix: af.hits, reply: text.slice(0, 90) });
        }
        const cost = ((inTok / 1e6) * PRICE[mk].in) + ((outTok / 1e6) * PRICE[mk].out);
        result[mk] = { guard_rejects: rejects, autofix_hits: autofixes, in_tokens: inTok, out_tokens: outTok, cost_usd: +cost.toFixed(5), cost_per_reply_usd: +(cost / SCN.length).toFixed(5), detail };
      }
      return new Response(JSON.stringify({ scenarios: SCN.length, result }, null, 1), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // تشخيص/اختبار حارس صمت الاستقبال. يرجّع حالة الإعداد والصمت الحالي.
  // مع ?test=1 يُرسل تنبيه CallMeBot فوراً (يتجاوز العتبة/ساعات العمل/التكرار)
  // للتأكد أن قناة التنبيه المستقلة ورقم الأمان مضبوطين.
  if (url.searchParams.get("admin_action") === "check_inbound_silence") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: last } = await supabase
        .from("wa_message_audit")
        .select("received_at, from_phone")
        .not("received_at", "is", null)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastTs = (last as { received_at?: string } | null)?.received_at || null;
      const silentHours = lastTs
        ? ((Date.now() - new Date(String(lastTs)).getTime()) / 3600000)
        : null;
      const { data: cfg } = await supabase
        .from("acc_config")
        .select("key,value")
        .in("key", ["callmebot_phone", "callmebot_apikey"]);
      const m: Record<string, string> = {};
      (cfg as Array<{ key: string; value: string }> | null || [])
        .forEach((r) => { m[r.key] = r.value; });
      const configured = Boolean(m.callmebot_phone && m.callmebot_apikey);

      let testSent = false;
      let testError: string | null = null;
      if (url.searchParams.get("test") === "1") {
        if (!configured) {
          testError = "callmebot_phone/callmebot_apikey غير مضبوطة في acc_config";
        } else {
          try {
            const msg = "✅ اختبار تنبيه الأمان: حارس صمت استقبال الواتساب يعمل. "
              + "لو توقّف الاستقبال خلال ساعات العمل بيوصلك تنبيه هنا.";
            const r = await fetch(
              "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(m.callmebot_phone) +
              "&apikey=" + encodeURIComponent(m.callmebot_apikey) +
              "&text=" + encodeURIComponent(msg),
            );
            testSent = r.ok;
            if (!r.ok) testError = "CallMeBot HTTP " + r.status;
          } catch (err) {
            testError = (err as Error).message;
          }
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        last_inbound_at: lastTs,
        silent_hours: silentHours === null ? null : Number(silentHours.toFixed(2)),
        threshold_hours: INBOUND_SILENCE_THRESHOLD_MS / 3600000,
        callmebot_configured: configured,
        test_sent: testSent,
        test_error: testError,
      }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin/staff: mark a customer's unhandled inbound messages as reviewed
  // (clears them from the "needs review" indicator). body {phone}
  if (url.searchParams.get("admin_action") === "mark_message_reviewed") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const phone = normalizeWhatsappPhone(String(p.phone || ""));
      if (!phone) return new Response(JSON.stringify({ error: "missing phone" }), { status: 400, headers: jsonCors });
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("wa_message_audit")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("from_phone", phone)
        .in("status", ["received", "stalled", "errored"]);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin: full conversation timeline for one customer phone. Combines
  // Twilio inbound + outbound with sender attribution. Outbound messages
  // whose Twilio SID matches a row in wa_admin_messages are tagged
  // "admin" (or the row's sent_by value); the rest are "ai".
  // Stream a Twilio media attachment back to the dashboard browser.
  //   GET ?admin_action=media_proxy&msg_sid=SMxxx&media_sid=MExxx
  // Used by the conversation modal to render images/files inline
  // without leaking Twilio credentials to the client. The Twilio
  // Media endpoint returns a 302 redirect to a temporary signed URL —
  // we follow it and stream the bytes, preserving Content-Type.
  if (url.searchParams.get("admin_action") === "media_proxy") {
    // مصادقة: header عادي، أو _t كـ query param (لأن <img>/التبويب الجديد ما يبعث header).
    const tParam = (url.searchParams.get("_t") || "").trim();
    const legacy = (Deno.env.get("LEGACY_ANON_JWT") || "").trim();
    let authedByParam = !!tParam && !!legacy && tParam === legacy; // الأدمن
    // 🐛 إصلاح «الملف يطلع أسود/unauthorized» عند الموظفات: توكنهنّ توكن جلسة موظف
    //    (مو الـlegacy JWT)، والتبويب الجديد ما يبعث header — فنقبل توكن جلسة الموظف عبر _t.
    if (!authedByParam && tParam) {
      try {
        const sAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const { data: sess } = await sAuth.from("wa_staff_sessions")
          .select("expires_at, revoked_at").eq("token", tParam).maybeSingle();
        const srow = sess as { expires_at: string; revoked_at: string | null } | null;
        if (srow && !srow.revoked_at && new Date(srow.expires_at) >= new Date()) authedByParam = true;
      } catch (_e) { /* يسقط للفحص العادي تحت */ }
    }
    if (!authedByParam && !(await checkAuthOrSession(req))) return unauthorized();
    try {
      const mediaId = (url.searchParams.get("media_id") || "").trim();
      if (mediaId) {
        const store = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const key = inboundMediaKey(mediaId);
        // 1) من نسختنا الدائمة إن وُجدت — يعمل حتى بعد حذف Meta للوسيط (السبب
        //    الجذري لاختفاء المرفقات القديمة).
        try {
          const { data: blob } = await store.storage.from(MEDIA_BUCKET).download(key);
          if (blob) {
            const mimeStored = blob.type || "application/octet-stream";
            const buf = new Uint8Array(await blob.arrayBuffer());
            return new Response(buf, {
              headers: { ...corsHeaders, "Content-Type": mimeStored, "Cache-Control": "private, max-age=86400" },
            });
          }
        } catch (_e) { /* لا نسخة محفوظة — نجلب من Meta تحت */ }
        // 2) من Meta (الوسيط ما زال طازجاً) + نخزّن نسخة دائمة للمستقبل.
        const got = await fetchMetaMedia(mediaId);
        if (!got) return new Response("media not found", { status: 404, headers: corsHeaders });
        try { await store.storage.from(MEDIA_BUCKET).upload(key, got.bytes, { contentType: got.mime, upsert: true }); } catch (_e) { /* أفضل جهد */ }
        return new Response(got.bytes, {
          headers: { ...corsHeaders, "Content-Type": got.mime, "Cache-Control": "private, max-age=3600" },
        });
      }
      return new Response("missing media_id", { status: 400, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // ── طلب فرد (booking_brief): حفظ + قراءة المسودة من فورم لوحة الواتساب ──────
  // بناء إضافي غير كاسر: endpoints إدارية جديدة فقط — لا تلمس الاستقبال/الرد/
  // التخزين ولا تدفق طلبات الشركات. التعبئة يدوية بالكامل (لا استخراج).

  // حفظ "طلب فرد": يحدّث مسودة العميل الحالية (incomplete/complete) أو ينشئ صفاً.
  // status=complete عند توفّر: وجهة + بالغين(pax) + أيام(days).
  if (url.searchParams.get("admin_action") === "save_booking_brief") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const caller = await getCallerStaff(req);
      const p = await req.json();
      const contact_phone = String(p.contact_phone || "").trim();
      if (!contact_phone) {
        return new Response(JSON.stringify({ error: "missing contact_phone" }),
          { status: 400, headers: jsonCors });
      }
      // عملة تلقائية من رمز دولة الهاتف إن لم تُمرّر (الخليج + مصر).
      const digits = contact_phone.replace(/[^0-9]/g, "");
      const ccMap: Array<[string, string]> = [
        ["968", "OMR"], ["971", "AED"], ["966", "SAR"], ["965", "KWD"],
        ["974", "QAR"], ["973", "BHD"], ["20", "EGP"],
      ];
      let currency = String(p.currency || "").trim();
      if (!currency) currency = (ccMap.find(([p2]) => digits.startsWith(p2)) || [, ""])[1] as string;
      const toInt = (v: unknown): number | null => {
        const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10);
        return Number.isFinite(n) ? n : null;
      };
      const destination = String(p.destination || "").trim() || null;
      const pax = toInt(p.pax);
      const days = toInt(p.days);
      const fields = {
        destination,
        pax,
        children: toInt(p.children),
        days,
        date_from: String(p.date_from || "").trim() || null,
        arrival_airport: String(p.arrival_airport || "").trim() || null,
        departure_airport: String(p.departure_airport || "").trim() || null,
        sim_count: toInt(p.sim_count),
        hotel_stars: String(p.hotel_stars || "").trim() || null,
        notes: String(p.notes || "").trim() || null,
        currency: currency || null,
        // توزيع المدن المختار من اقتراحات النظام السياحي (نفس المصدر).
        distribution: String(p.distribution || "").trim() || null,
        cities_nights: Array.isArray(p.cities_nights) ? p.cities_nights : null,
        // handled_by تلقائي من الموظف المسجّل دخوله (أو admin للماستر توكن).
        handled_by: caller?.name || caller?.phone || String(p.handled_by || "").trim() || "admin",
        request_type: "individual",
      };
      const status = (destination && (pax ?? 0) >= 1 && (days ?? 0) >= 1) ? "complete" : "incomplete";

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      // ⚠️ أي **طلب جديد مختلف** لنفس العميل = صف مستقل جديد (بلا استبدال) — سواء اختلفت
      //    الوجهة (مقارنة وجهتين) أو نفس الوجهة بتوزيع/تاريخ مختلف (رحلة أخرى). نُحدّث الصف
      //    القائم **فقط** لو تطابق الجوهر (نفس الوجهة + نفس التوزيع + نفس التاريخ) = إعادة
      //    حفظ/تصحيح لنفس الطلب. غير ذلك → INSERT صف جديد يظهر بالصندوق. (بلا وجهة =
      //    مسودة ناقصة، نطابق بالرقم فقط لتحديثها.)
      const _dist = String((fields as { distribution?: string }).distribution || "").trim();
      const _dfrom = String((fields as { date_from?: string | null }).date_from || "").trim();
      let _exQ = supabase
        .from("booking_brief").select("id, confirm_sent_at, distribution, days, date_from").eq("contact_phone", contact_phone)
        .in("status", ["incomplete", "complete"]);
      if (destination) _exQ = _exQ.eq("destination", destination);
      if (destination && _dist) _exQ = _exQ.eq("distribution", _dist);       // توزيع مختلف = طلب مستقل
      if (destination && _dist && _dfrom) _exQ = _exQ.eq("date_from", _dfrom); // تاريخ مختلف = طلب مستقل
      const { data: existing } = await _exQ
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      // نرسل التأكيد عند كل حفظ مكتمل، لكن نمنع التكرار خلال 60 ثانية (نقرة مزدوجة).
      // إلا لو تغيّر جوهر الطلب (التوزيع/الأيام/التاريخ) → نعيد الإرسال بالمعلومة المصحّحة،
      // حتى لا يبقى العميل على نسخة قديمة (مثال: أضافت الموظفة مدينة ثانية بعد أول حفظ).
      const ex = existing as { confirm_sent_at?: string | null; distribution?: string | null; days?: number | null; date_from?: string | null } | null;
      const lastConfirm = ex?.confirm_sent_at;
      const sameCore =
        String(ex?.distribution || "").trim() === String(fields.distribution || "").trim() &&
        String(ex?.days ?? "") === String(fields.days ?? "") &&
        String(ex?.date_from || "") === String(fields.date_from || "");
      const recentlyConfirmed = !!lastConfirm && (Date.now() - new Date(lastConfirm).getTime() < 60000) && sameCore;
      const now = new Date().toISOString();
      let row: { id: string; status: string } | null = null;
      if (existing && (existing as { id?: string }).id) {
        const { data, error } = await supabase.from("booking_brief")
          .update({ ...fields, status, updated_at: now })
          .eq("id", (existing as { id: string }).id)
          .select("id, status").single();
        if (error) throw error;
        row = data as { id: string; status: string };
      } else {
        const { data, error } = await supabase.from("booking_brief")
          .insert({ contact_phone, ...fields, status, updated_at: now })
          .select("id, status").single();
        if (error) throw error;
        row = data as { id: string; status: string };
      }

      // رسالة تأكيد تلقائية للعميل عند اكتمال الطلب لأول مرة (مرة واحدة فقط،
      // وتحترم نافذة واتساب 24 ساعة — لو فشل الإرسال لا نعلّمها مُرسَلة).
      let confirmationSent = false;
      if (row?.status === "complete" && !recentlyConfirmed) {
        try {
          const f = fields as Record<string, unknown>;
          const lines: string[] = [];
          const add = (label: string, val: unknown) => {
            if (val != null && String(val).trim() !== "") lines.push(`${label} ${val}`);
          };
          add("📍 الوجهة:", f.destination);
          add("👥 عدد البالغين:", f.pax);
          add("🧒 عدد الأطفال:", f.children);
          add("📅 عدد الأيام:", f.days);
          add("🗓️ تاريخ السفر:", f.date_from);
          add("✈️ مطار القدوم:", f.arrival_airport);
          add("🛫 مطار المغادرة:", f.departure_airport);
          add("🗺️ توزيع المدن:", f.distribution);
          add("🏨 فئة الفندق:", f.hotel_stars === "mixed" ? "٤/٥ نجوم (مختلط)" : (f.hotel_stars ? `${f.hotel_stars} نجوم` : ""));
          add("📱 شرائح الإنترنت:", f.sim_count);
          add("📝 ملاحظات:", f.notes);
          const staffName = String(f.handled_by || "").trim();
          const byLine = (staffName && staffName.toLowerCase() !== "admin") ? `\n\n🧑‍💼 بخدمتك: ${staffName}` : "";
          const msg =
            "🌟 شكراً لتواصلك مع *العز الدولية للسفر والسياحة* 🌟\n\n" +
            "سنقوم بتجهيز برنامج خاص لك بناءً على المعلومات التالية:\n\n" +
            lines.join("\n") +
            "\n\nنحرص على دقة كل التفاصيل لنقدّم لك أفضل تجربة 💚\nوسيصلك برنامجك المخصّص قريباً بإذن الله 🌍" +
            byLine +
            "\n🌐 https://alezzgroup.net";
          const sid = await sendWhatsapp(contact_phone, msg);
          if (sid) {
            await supabase.from("booking_brief").update({ confirm_sent_at: new Date().toISOString() }).eq("id", row.id);
            // سجّل الرسالة في خيط المحادثة لتظهر بالداشبورد + حدّث معاينة الجلسة.
            try {
              await supabase.from("wa_admin_messages").insert({
                customer_phone: contact_phone, body: msg,
                sent_by: "تأكيد تلقائي", sent_at: new Date().toISOString(),
              });
              await supabase.from("whatsapp_sessions").update({
                last_outbound_at: new Date().toISOString(), last_outbound_body: msg.slice(0, 500),
              }).eq("phone", contact_phone);
            } catch (_) { /* best-effort */ }
            confirmationSent = true;
          }
        } catch (sendErr) {
          console.error("booking_brief confirmation send failed", sendErr);
        }
      }
      // 🏗️ بناء تلقائي على السيرفر وقت اكتمال الطلب: يبني البرنامج عبر Tourism-AI
      //    ويخزّنه في built_program، فيفتح الداشبورد برنامجاً جاهزاً مباشرةً بدل
      //    الاعتماد على بناء المتصفّح (الذي يتأثر بالكاش/المسار) — حل جذري لتكرار
      //    «ما يبني». يعمل في الخلفية فلا يؤخّر الرد، ولا يطمس برنامجاً موجوداً.
      if (row?.status === "complete" && row.id) {
        const briefId = row.id;
        const f = fields as Record<string, unknown>;
        const autoBuild = async () => {
          try {
            const { data: cur } = await supabase.from("booking_brief").select("built_program").eq("id", briefId).maybeSingle();
            const existingBp = (cur as { built_program?: string | null } | null)?.built_program || "";
            if (/TOTAL_GROUP:/.test(existingBp)) return; // لا نبني فوق برنامج جاهز
            const dest = String(f.destination || "").trim();
            if (!dest || !f.days || !f.pax) return;
            const starsTxt = (f.hotel_stars && f.hotel_stars !== "mixed") ? `فنادق ${f.hotel_stars} نجوم` : "فنادق مختلطة";
            const prompt = `${dest} ${f.days} ايام ${String(f.distribution || "")} ل ${f.pax} بالغين${f.children ? ` و ${f.children} اطفال` : ""}${f.date_from ? ` تاريخ ${f.date_from}` : ""} ${starsTxt}`.replace(/\s+/g, " ").trim();
            const taUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/Tourism-AI`;
            const key = Deno.env.get("LEGACY_ANON_JWT") || "";
            const r = await fetch(taUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
              body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: 4000 }),
            });
            const d = await r.json();
            const txt = (d?.content?.[0]?.text as string) || "";
            // نحفظ فقط لو طلع برنامج فعلي بفنادق (لا نحفظ رد AI فاضٍ بلا HOTELS).
            const hasHotels = /TOTAL_GROUP:/.test(txt) && !/HOTELS:[ \t]*\n[ \t]*\n/.test(txt) && /HOTELS:[ \t]*\n[ \t]*\S/.test(txt);
            if (hasHotels) await supabase.from("booking_brief").update({ built_program: txt }).eq("id", briefId);
          } catch (e) { console.error("auto-build brief failed", e); }
        };
        if (typeof EdgeRuntime !== "undefined" && typeof (EdgeRuntime as { waitUntil?: unknown }).waitUntil === "function") {
          (EdgeRuntime as { waitUntil: (p: Promise<unknown>) => void }).waitUntil(autoBuild());
        } else {
          await autoBuild();
        }
      }

      return new Response(JSON.stringify({ ok: true, id: row?.id, status: row?.status, confirmation_sent: confirmationSent }),
        { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // قراءة مسودة "طلب فرد" الحالية للعميل (لتعبئة الفورم عند فتح المحادثة).
  if (url.searchParams.get("admin_action") === "get_booking_brief") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = req.method === "POST" ? await req.json() : Object.fromEntries(url.searchParams);
      const contact_phone = String(p.contact_phone || "").trim();
      if (!contact_phone) {
        return new Response(JSON.stringify({ error: "missing contact_phone" }),
          { status: 400, headers: jsonCors });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data } = await supabase.from("booking_brief")
        .select("*").eq("contact_phone", contact_phone)
        .in("status", ["incomplete", "complete"])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      return new Response(JSON.stringify({ brief: data || null }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // تحويل "طلب فرد" مكتمل لصندوق التسعير (status=transferred) — يظهر بعدها في
  // صندوق الأفراد بـ team.html/requests. يتطلب طلباً مكتملاً (وجهة+بالغين+أيام).
  if (url.searchParams.get("admin_action") === "transfer_booking_brief") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const contact_phone = String(p.contact_phone || "").trim();
      if (!contact_phone) {
        return new Response(JSON.stringify({ error: "missing contact_phone" }), { status: 400, headers: jsonCors });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: brief } = await supabase.from("booking_brief")
        .select("id, status").eq("contact_phone", contact_phone)
        .in("status", ["incomplete", "complete"])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const b = brief as { id?: string; status?: string } | null;
      if (!b || !b.id) {
        return new Response(JSON.stringify({ error: "لا يوجد طلب محفوظ لهذا العميل" }), { status: 404, headers: jsonCors });
      }
      if (b.status !== "complete") {
        return new Response(JSON.stringify({ error: "أكملي الطلب أولاً (وجهة + بالغين + أيام) واحفظيه قبل التحويل." }), { status: 400, headers: jsonCors });
      }
      await supabase.from("booking_brief")
        .update({ status: "transferred", updated_at: new Date().toISOString() }).eq("id", b.id);
      return new Response(JSON.stringify({ ok: true, status: "transferred" }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // استخراج حقول «طلب فرد» من آخر رسائل العميل (مساعدة — الموظف يراجع ويعدّل قبل الحفظ).
  if (url.searchParams.get("admin_action") === "extract_brief") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json();
      const contact_phone = String(p.contact_phone || "").trim();
      if (!contact_phone) return new Response(JSON.stringify({ error: "missing contact_phone" }), { status: 400, headers: jsonCors });
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) return new Response(JSON.stringify({ error: "AI غير مهيّأ" }), { status: 500, headers: jsonCors });
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      // آخر رسائل العميل الواردة (الأحدث أولاً ثم نعكس) — نلتقط آخر رأي للعميل لو غيّره.
      const { data: msgs } = await supabase.from("wa_message_audit")
        .select("body, received_at").eq("from_phone", contact_phone)
        .not("body", "is", null)
        .order("received_at", { ascending: false }).limit(60);
      const rows = (((msgs || []) as Array<{ body?: string }>)).reverse();
      const transcript = rows.map(m => String(m.body || "").trim())
        .filter(t => t && !t.startsWith("📎")).join("\n").slice(-6000);
      if (!transcript) return new Response(JSON.stringify({ error: "لا توجد رسائل نصية من العميل لقراءتها" }), { status: 404, headers: jsonCors });
      const today = new Date().toISOString().slice(0, 10);
      const anthropic = new Anthropic({ apiKey });
      const sys = `أنت مساعد يستخرج تفاصيل طلب سفر فردي من رسائل عميل واتساب لوكالة سياحية. اليوم: ${today}.
أعد JSON فقط بلا أي شرح بهذا الشكل بالضبط:
{"destination":"","destination2":"","date_from":"","pax":null,"children":null,"days":null,"sim_count":null,"hotel_stars":"","notes":""}
القواعد:
- destination: واحدة فقط من [فيتنام، ماليزيا، تايلاند، تركيا، روسيا، البوسنة، إندونيسيا، عُمان، جنوب أفريقيا، موريشيوس، إنجلترا، الصين، مصر، المغرب، العمرة، أبوظبي] إن طابقت وجهة مذكورة، وإلا "". 🕋 مهم: أي طلب عمرة/عُمرة/حج/زيارة الحرم/مكة/مكه/المدينة المنورة/الحرمين → destination = "العمرة" (وجهة العمرة تشمل مكة والمدينة معاً). 🇪🇬 أي ذكر لمصر/القاهرة/الأهرامات/الجيزة/خان الخليلي → destination = "مصر". 🇲🇦 أي ذكر للمغرب/مراكش/الدار البيضاء/طنجة/أكادير/الصويرة/الرباط → destination = "المغرب". 🇦🇪 أي ذكر لأبوظبي/ياس آيلاند/عالم فيراري/وارنر براذرز → destination = "أبوظبي".
- ⚖️ destination2: **لو العميل يقارن أو متردّد بين وجهتين** (مثل «فيتنام أو تايلند»، «أيهما أرخص X ولا Y»، «قارن لي بين X وY») → ضع الوجهة الأولى في destination والثانية في destination2 (كلاهما من نفس القائمة أعلاه). لو وجهة واحدة فقط → destination2 = "". لا تضع نفس الوجهة في الحقلين.
- date_from: تاريخ السفر YYYY-MM-DD إن أمكن استنتاجه (حوّل العبارات النسبية حسب تاريخ اليوم)، وإلا "".
- pax بالغين، children أطفال، sim_count شرائح: أرقام أو null.
- days: عدد أيام الرحلة. ⚠️ **تنبيه مهم لصيغة التواريخ:** «١٥-١١» أو «15/11» = **تاريخ واحد** (يوم/شهر = ١٥ نوفمبر)، **وليست نطاقاً** (ليست «من ١٥ إلى ١١»). النطاق يُحدَّد بكلمتَي «من … إلى …». مثال: «من 15-11 إلى 17/11» = من ١٥ نوفمبر إلى ١٧ نوفمبر = **٣ أيام** (17−15+1)، date_from = 2026-11-15. مثال آخر: «من 16-28 يوليو» = من ١٦ إلى ٢٨ يوليو = 13 يومًا. القاعدة: نطاق «من [تاريخ1] إلى [تاريخ2]» بنفس الشهر → days = (يوم2 − يوم1) + 1. ولو ذكر عددًا صريحًا للأيام (مثل «٣ أيام») فاستخدمه كما هو. وإلا null. واجعل date_from = تاريخ البداية.
- hotel_stars: "3" أو "4" أو "5" أو "mixed" (لو طلب ٤ و٥) أو "".
- notes: ملخّص قصير بالعربي لأي طلبات خاصة أو "".
- لو غيّر العميل رأيه فاعتمد الأحدث. لا تخترع قيمًا غير مذكورة.`;
      const res = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: sys,
        messages: [{ role: "user", content: transcript }],
      });
      let txt = "";
      for (const blk of res.content) if ((blk as { type?: string }).type === "text") txt += (blk as { text?: string }).text || "";
      const mm = txt.match(/\{[\s\S]*\}/);
      if (!mm) return new Response(JSON.stringify({ error: "تعذّر استخراج البيانات" }), { status: 502, headers: jsonCors });
      return new Response(JSON.stringify({ ok: true, brief: JSON.parse(mm[0]) }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  if (url.searchParams.get("admin_action") === "conversation_history") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      // مهاجَر إلى Cloud API: نقرأ خيط المحادثة من قاعدة بياناتنا بدل Twilio.
      // (رسائل العملاء الواردة على Cloud API لا تمر على Twilio إطلاقاً، فكان
      // المودال يرجع فاضياً.) الوارد من wa_message_audit، والصادر من
      // wa_admin_messages، مع آخر رد محفوظ على الجلسة لالتقاط ردود الـ AI.
      const p = req.method === "POST" ? await req.json() : Object.fromEntries(url.searchParams);
      const rawPhone = String(p.phone || "").trim();
      if (!rawPhone) {
        return new Response(JSON.stringify({ error: "missing phone" }),
          { status: 400, headers: jsonCors });
      }
      const digits = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const phone = `whatsapp:+${digits}`;

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      type Item = { ts: string; body: string; sender: string; sid?: string;
        media_id?: string | null; media_mime?: string | null; media_filename?: string | null };
      const items: Item[] = [];
      type MediaRow = { media_id?: string | null; media_mime?: string | null; media_filename?: string | null };

      // الوارد: رسائل العميل من سجل التدقيق (مصدرنا بعد الهجرة لـ Cloud API).
      // نجلب الأحدث (descending) ثم نرتّب تصاعدياً لاحقاً — وإلا في المحادثات
      // الطويلة (>200) كان يجلب أقدم 200 ويُسقط رسائل اليوم فلا تظهر بالداشبورد.
      const { data: inbound } = await supabase
        .from("wa_message_audit")
        .select("id, body, received_at, media_id, media_mime, media_filename")
        .eq("from_phone", phone)
        .order("received_at", { ascending: false })
        .limit(400);
      for (const m of (inbound as Array<{ id: string; body: string | null; received_at: string } & MediaRow> | null) ?? []) {
        items.push({ ts: m.received_at, body: m.body || "", sender: "customer", sid: String(m.id),
          media_id: m.media_id || null, media_mime: m.media_mime || null, media_filename: m.media_filename || null });
      }

      // الصادر: الردود المسجّلة (يدوي/اعتماد اقتراح/قالب ترحيب/ملف PDF).
      const { data: outbound } = await supabase
        .from("wa_admin_messages")
        .select("id, body, sent_at, sent_by, media_id, media_mime, media_filename")
        .eq("customer_phone", phone)
        .order("sent_at", { ascending: false })
        .limit(400);
      for (const m of (outbound as Array<{ id: string; body: string | null; sent_at: string; sent_by: string | null } & MediaRow> | null) ?? []) {
        items.push({ ts: m.sent_at, body: m.body || "", sender: m.sent_by || "ai", sid: String(m.id),
          media_id: m.media_id || null, media_mime: m.media_mime || null, media_filename: m.media_filename || null });
      }

      // احتياط: آخر رد صادر محفوظ على الجلسة — يلتقط ردود الـ AI التلقائية
      // التي لا تُسجَّل في wa_admin_messages. نضيفه فقط إن لم يكن مكرراً.
      const { data: sess } = await supabase
        .from("whatsapp_sessions")
        .select("last_outbound_at, last_outbound_body, ad_referral")
        .eq("phone", phone)
        .maybeSingle();
      const so = sess as { last_outbound_at: string | null; last_outbound_body: string | null; ad_referral?: Record<string, unknown> | null } | null;
      if (so?.last_outbound_at && so.last_outbound_body) {
        const dupe = items.some(it =>
          it.sender !== "customer" &&
          it.body.slice(0, 100) === (so.last_outbound_body || "").slice(0, 100) &&
          Math.abs(new Date(it.ts).getTime() - new Date(so.last_outbound_at!).getTime()) < 60_000);
        if (!dupe) {
          items.push({ ts: so.last_outbound_at, body: so.last_outbound_body, sender: "ai" });
        }
      }

      items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      return new Response(JSON.stringify({ phone, items, ad_referral: so?.ad_referral || null }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: jsonCors });
    }
  }

  // Admin: toggle the global AI master switch. POST body:
  //   { enabled: bool, force_off_all?: bool, force_on_all?: bool }
  // enabled        — ai_global_enabled (default for conversations w/o
  //                  explicit override).
  // force_off_all  — when true, ALL conversations get silenced, including
  //                  ai_enabled=true. Auto-cleared when enabled=true.
  // force_on_all   — when true, ALL conversations get AI, including
  //                  ai_enabled=false. Auto-cleared when enabled=false.
  // Either direction the modal picks gets persisted exactly; the
  // "* عدا المخصصين" choice is just both force flags = false.
  if (url.searchParams.get("admin_action") === "set_global_ai") {
    const expected = Deno.env.get("LEGACY_ANON_JWT") || "";
    const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!expected || got !== expected.trim()) {
      return new Response(JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { ...JSON_HEADERS, ...corsHeaders } });
    }
    try {
      const payload = await req.json();
      // New 3-state mode (canonical). Falls back to the legacy enabled
      // boolean when callers haven't updated yet.
      const rawMode = typeof payload.mode === "string" ? payload.mode.toUpperCase().trim() : "";
      // البنود: ON=الذكاء الاصطناعي · PREVIEW=معاينة · PREVIEW_REPLY=معاينة مع رد · OFF=موقوف
      let mode: "ON" | "PREVIEW" | "PREVIEW_REPLY" | "OFF";
      if (rawMode === "ON" || rawMode === "PREVIEW" || rawMode === "PREVIEW_REPLY" || rawMode === "OFF") {
        mode = rawMode;
      } else {
        mode = payload.enabled ? "ON" : "OFF";
      }
      // Derive the legacy settings so anything still reading them stays
      // consistent.
      const enabled = mode !== "OFF";
      const forceOffAll = mode === "OFF";
      const forceOnAll  = false;
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const now = new Date().toISOString();
      const { error } = await supabase.from("wa_settings").upsert([
        { key: "ai_mode",           value: mode,         updated_at: now },
        { key: "ai_global_enabled", value: enabled,      updated_at: now },
        { key: "ai_force_off_all",  value: forceOffAll,  updated_at: now },
        { key: "ai_force_on_all",   value: forceOnAll,   updated_at: now },
      ]);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({
        ok: true,
        ai_mode: mode,
        global_ai_enabled: enabled,
        ai_force_off_all: forceOffAll,
        ai_force_on_all:  forceOnAll,
      }), { headers: { ...JSON_HEADERS, ...corsHeaders } });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: { ...JSON_HEADERS, ...corsHeaders } });
    }
  }

  // Admin: toggle AI for a single conversation. POST body:
  //   {"phone": "00968...", "enabled": true|false|null}
  // null  → inherit global. true/false → force per-conversation.
  if (url.searchParams.get("admin_action") === "set_conversation_ai") {
    { const g = await requirePerm(req, "manage_ai"); if (g) return g; }
    try {
      const payload = await req.json();
      const rawPhone = String(payload.phone || "").trim();
      if (!rawPhone) {
        return new Response(JSON.stringify({ error: "missing phone" }),
          { status: 400, headers: { ...JSON_HEADERS, ...corsHeaders } });
      }
      const digits = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const phone = `whatsapp:+${digits}`;
      const enabled: boolean | null =
        payload.enabled === true ? true :
        payload.enabled === false ? false : null;
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { error, count } = await supabase
        .from("whatsapp_sessions")
        .update({ ai_enabled: enabled }, { count: "exact" })
        .eq("phone", phone);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, phone, ai_enabled: enabled, rows_updated: count ?? 0 }),
        { headers: { ...JSON_HEADERS, ...corsHeaders } });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: { ...JSON_HEADERS, ...corsHeaders } });
    }
  }

  // تصنيف يدوي ثابت للمحادثة (عاجل/متابعة). label=null يزيله. أي موظف مصرّح له بالإرسال.
  if (url.searchParams.get("admin_action") === "set_conversation_label") {
    { const g = await requirePerm(req, "send_messages"); if (g) return g; }
    try {
      const p = await req.json();
      const rawPhone = String(p.phone || "").trim();
      if (!rawPhone) return new Response(JSON.stringify({ error: "missing phone" }), { status: 400, headers: jsonCors });
      const ALLOWED = ["URGENT", "FOLLOW_UP", "VIP", "PAYMENT", "CONFIRMED"];
      const label = (p.label == null || p.label === "") ? null
        : (ALLOWED.includes(String(p.label)) ? String(p.label) : "__invalid__");
      if (label === "__invalid__") return new Response(JSON.stringify({ error: "invalid label" }), { status: 400, headers: jsonCors });
      const digits = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "").replace(/^00/, "").replace(/[^0-9]/g, "");
      const phone = `whatsapp:+${digits}`;
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await supabase.from("whatsapp_sessions").update({ label }).eq("phone", phone);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, label }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // كرون: متابعة «اليوم الثاني» — رسالة واحدة لكل عميل أُرسل له برنامج/عرض، عند الساعة
  // المحدّدة (KSA). يُستدعى من pg_cron كل ساعة؛ يُرسل فقط لو الساعة الحالية = المضبوطة.
  if (url.searchParams.get("admin_action") === "run_followups") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: setRows } = await supabase.from("wa_settings").select("key, value")
        .in("key", ["followup_hour_ksa", "followup_template_sid", "followup_enabled"]);
      const sm: Record<string, unknown> = {};
      for (const r of ((setRows || []) as Array<{ key: string; value: unknown }>)) sm[r.key] = r.value;
      if (sm.followup_enabled === false) return new Response(JSON.stringify({ ok: true, skipped: "disabled" }), { headers: jsonCors });
      const hour = typeof sm.followup_hour_ksa === "number" ? sm.followup_hour_ksa : 12;
      const templateName = typeof sm.followup_template_sid === "string" ? sm.followup_template_sid.trim() : "";
      const ksaNow = new Date(Date.now() + 3 * 3600 * 1000);
      const force = url.searchParams.get("force") === "1";
      if (!force && ksaNow.getUTCHours() !== hour) {
        return new Response(JSON.stringify({ ok: true, skipped: "not_the_hour", ksaHour: ksaNow.getUTCHours(), hour }), { headers: jsonCors });
      }
      const ksaToday = ksaNow.toISOString().slice(0, 10);
      const { data: due } = await supabase.from("whatsapp_sessions")
        .select("phone, profile_name, last_outbound_at")
        .lte("followup_due_date", ksaToday)
        .eq("followup_done", false)
        .not("followup_due_date", "is", null)
        .limit(80);
      let sent = 0, failed = 0, skippedActive = 0;
      for (const s of ((due || []) as Array<{ phone: string; profile_name: string | null; last_outbound_at: string | null }>)) {
        // ❌ لا نرسل متابعة «عسى البرنامج عجبك؟» لو العميل **ردّ بعد ما أرسلنا له**
        //    (يطلب تعديلاً أو يستفسر) — رسالته ما زالت بانتظار رد، والمتابعة الآلية
        //    تُربكه (شوهد: العميل أرسل «وايضا طيران العماني» ثم جاءته «طمّنّي» فاستغرب).
        //    المتابعة للعملاء الصامتين فقط (آخر شيء بالمحادثة هو إرسالنا).
        try {
          const { data: _lastIn } = await supabase.from("wa_message_audit")
            .select("received_at").eq("from_phone", s.phone)
            .order("received_at", { ascending: false }).limit(1).maybeSingle();
          const _inMs = (_lastIn as { received_at?: string } | null)?.received_at
            ? new Date(String((_lastIn as { received_at?: string }).received_at)).getTime() : 0;
          const _outMs = s.last_outbound_at ? new Date(String(s.last_outbound_at)).getTime() : 0;
          if (_inMs && _inMs > _outMs) {
            // العميل ردّ بعد آخر إرسال منّا → نشط/بانتظار رد؛ نتخطّى ونعلّمها done.
            await supabase.from("whatsapp_sessions").update({ followup_done: true }).eq("phone", s.phone);
            skippedActive++;
            continue;
          }
        } catch (_e) { /* أفضل جهد — لو فشل الفحص نكمل بالسلوك المعتاد */ }
        // ❌ بلا اسم العميل ولا أي كلمة مُضافة (لا «أستاذي» ولا غيرها) — نرسل نص
        //    المتابعة كما هو فقط، لتفادي ظهور اسم بروفايل غريب يفضح أنه رد آلي.
        const followupBody = `طمّنّي، عسى البرنامج اللي أرسلناه لك عجبك، وإذا تبي أي تعديل أو عندك استفسار أنا حاضر لخدمتك.`;
        try {
          if (templateName) {
            await sendWhatsappTemplate(s.phone, templateName, undefined, "ar");
          } else {
            await sendWhatsapp(s.phone, followupBody);
          }
          await supabase.from("wa_admin_messages").insert({ customer_phone: s.phone, body: followupBody, sent_by: "طلال", sent_at: new Date().toISOString() });
          // إرسال المتابعة = نشاط على المحادثة: نرفعها لأعلى قائمة الداشبورد
          // بنفس أسلوب send_admin_message (تحديث last_message_at + آخر صادر).
          const _fuNow = new Date().toISOString();
          await supabase.from("whatsapp_sessions").update({
            last_message_at: _fuNow, last_outbound_at: _fuNow,
            last_outbound_body: followupBody.slice(0, 200),
          }).eq("phone", s.phone);
          sent++;
        } catch (_e) { failed++; /* غالباً خارج نافذة 24س بلا قالب */ }
        // علّمها done دائماً (نجاح أو فشل) لتفادي إعادة المحاولة كل ساعة.
        await supabase.from("whatsapp_sessions").update({ followup_done: true }).eq("phone", s.phone);
      }
      return new Response(JSON.stringify({ ok: true, sent, failed, skippedActive, due: (due || []).length }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // قراءة إعدادات المتابعة (الساعة/التفعيل/اسم القالب).
  if (url.searchParams.get("admin_action") === "followup_settings") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("wa_settings").select("key, value")
      .in("key", ["followup_hour_ksa", "followup_template_sid", "followup_enabled"]);
    const sm: Record<string, unknown> = {};
    for (const r of ((data || []) as Array<{ key: string; value: unknown }>)) sm[r.key] = r.value;
    return new Response(JSON.stringify({
      hour: typeof sm.followup_hour_ksa === "number" ? sm.followup_hour_ksa : 12,
      enabled: sm.followup_enabled !== false,
      template_name: typeof sm.followup_template_sid === "string" ? sm.followup_template_sid : "",
    }), { headers: jsonCors });
  }

  // حفظ إعدادات المتابعة (أدمن فقط).
  if (url.searchParams.get("admin_action") === "set_followup_settings") {
    if (!checkAuth(req)) return unauthorized();
    try {
      const p = await req.json();
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const ups: Array<{ key: string; value: unknown }> = [];
      if (p.hour != null) ups.push({ key: "followup_hour_ksa", value: Math.max(0, Math.min(23, parseInt(String(p.hour)) || 12)) });
      if (typeof p.enabled === "boolean") ups.push({ key: "followup_enabled", value: p.enabled });
      if (typeof p.template_name === "string") ups.push({ key: "followup_template_sid", value: p.template_name.trim() });
      for (const u of ups) await supabase.from("wa_settings").upsert(u, { onConflict: "key" });
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin: dump recent Twilio Messages for a specific phone (both inbound
  // from the phone and outbound from us to it). Useful for diagnosing
  // delivery, retracing what the bot actually sent, or confirming a
  // customer's message reached Twilio. JWT-gated like the others.
  // Usage: POST ?admin_action=twilio_messages  body: {"phone": "00968..."}
  if (url.searchParams.get("admin_action") === "twilio_messages") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const token = Deno.env.get("TWILIO_AUTH_TOKEN");
      const fromEnv = Deno.env.get("TWILIO_WHATSAPP_FROM") || "";
      if (!sid || !token) {
        return new Response(JSON.stringify({ error: "twilio creds missing" }),
          { status: 500, headers: JSON_HEADERS });
      }
      const payload = await req.json();
      const phone = String(payload.phone || "").trim();
      if (!phone) {
        return new Response(JSON.stringify({ error: "missing phone" }),
          { status: 400, headers: JSON_HEADERS });
      }
      const digits = phone.replace(/^whatsapp:/, "").replace(/^\+/, "")
        .replace(/^00/, "").replace(/[^0-9]/g, "");
      const to = `whatsapp:+${digits}`;
      const auth = "Basic " + btoa(`${sid}:${token}`);
      const outRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?From=${encodeURIComponent(fromEnv)}&To=${encodeURIComponent(to)}&PageSize=10`,
        { headers: { Authorization: auth } });
      const outJson = await outRes.json();
      const inRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?From=${encodeURIComponent(to)}&To=${encodeURIComponent(fromEnv)}&PageSize=10`,
        { headers: { Authorization: auth } });
      const inJson = await inRes.json();
      const slim = (msgs: unknown) => (Array.isArray(msgs) ? msgs.map((m: Record<string, unknown>) => ({
        sid: m.sid, date_sent: m.date_sent, status: m.status,
        error_code: m.error_code, body: typeof m.body === "string" ? m.body.slice(0, 250) : m.body,
        from: m.from, to: m.to,
      })) : msgs);
      return new Response(JSON.stringify({
        target: to,
        outbound: slim(outJson.messages),
        inbound: slim(inJson.messages),
      }), { headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: JSON_HEADERS });
    }
  }

  // Admin: reset a single customer's WhatsApp session + clear any pending
  // admin proposals tied to that phone. Used when re-testing a flow from
  // scratch without having to open the SQL editor. Same JWT gate as
  // delete_chat_rows. Usage:
  //   POST /functions/v1/WhatsApp-Router?admin_action=reset_session
  //   Authorization: Bearer <legacy anon JWT>
  //   body: {"phone": "0096877428881"}   // accepts +968…, 00968…, bare digits, or whatsapp:+968…
  if (url.searchParams.get("admin_action") === "reset_session") {
    const expected = Deno.env.get("LEGACY_ANON_JWT") || "";
    const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!expected || got !== expected.trim()) {
      return new Response(JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: JSON_HEADERS });
    }
    try {
      const payload = await req.json();
      const rawPhone = String(payload.phone || "").trim();
      if (!rawPhone) {
        return new Response(JSON.stringify({ error: "missing phone" }),
          { status: 400, headers: JSON_HEADERS });
      }
      // Normalize to whatsapp:+<digits>. Accepts whatsapp:+96877428881,
      // +96877428881, 0096877428881, or bare 96877428881.
      const digits = rawPhone
        .replace(/^whatsapp:/, "")
        .replace(/^\+/, "")
        .replace(/^00/, "")
        .replace(/[^0-9]/g, "");
      if (!digits) {
        return new Response(JSON.stringify({ error: "invalid phone" }),
          { status: 400, headers: JSON_HEADERS });
      }
      const phone = `whatsapp:+${digits}`;

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { count: sessionsDeleted, error: sErr } = await supabase
        .from("whatsapp_sessions")
        .delete({ count: "exact" })
        .eq("phone", phone);
      const { count: proposalsDeleted, error: pErr } = await supabase
        .from("whatsapp_admin_proposals")
        .delete({ count: "exact" })
        .eq("customer_phone", phone);
      if (sErr || pErr) {
        return new Response(JSON.stringify({
          error: (sErr || pErr)?.message,
          phone,
        }), { status: 500, headers: JSON_HEADERS });
      }
      return new Response(JSON.stringify({
        phone,
        whatsapp_sessions_deleted: sessionsDeleted ?? 0,
        whatsapp_admin_proposals_deleted: proposalsDeleted ?? 0,
      }), { headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }),
        { status: 500, headers: JSON_HEADERS });
    }
  }

  try {
    // ── تحليل ويبهوك Meta (application/json) ──────────────────────────────
    // البنية: entry[].changes[].value.{ messages[], contacts[], metadata,
    // statuses[] }. نحتفظ بأسماء المتغيّرات (from/body/profileName/numMedia)
    // كما كانت مع Twilio حتى يبقى كل المنطق الأسفل متطابقاً دون أي تغيير.
    // موثوقية: Meta قد ترسل عدة رسائل في دفعة واحدة (عدة entries/changes، وعدة
    // عناصر في messages[]). نمرّ على الكل ولا نُسقط أي رسالة — وإلا يشتكي
    // العميل أن رسالته ما وصلت.
    const payload = await req.json();

    // ── توجيه B2B (رقم الشركات +968 7554 2288 = phone_number_id 1323027874234661) ──
    // Meta يسلّم ويبهوك كل رقم على حدة. لو الحمولة لرقم B2B فقط، نوجّهها كاملة
    // (رسائل + حالات) لـ b2b-talal في الخلفية ونرد 200 — ولا تمرّ بمسار طلال السياحي.
    // ⚠️ كل الفرع داخل try/catch: أي فشل هنا يُبتلع ويُكمل المسار القديم كما هو،
    // فلا يتأثر عملاء رقم السياحة (9117 1630) إطلاقاً. وأي رقم آخر (أو غياب
    // phone_number_id) يترك isB2b=false فيمرّ بنفس المسار القديم دون أي تغيير.
    try {
      let isB2b = false;
      for (const _en of (payload?.entry ?? [])) {
        for (const _ch of (_en?.changes ?? [])) {
          if (String(_ch?.value?.metadata?.phone_number_id || "") === "1323027874234661") { isB2b = true; break; }
        }
        if (isB2b) break;
      }
      if (isB2b) {
        const _fwd = async () => {
          try {
            const _jwt = Deno.env.get("LEGACY_ANON_JWT") || "";
            await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/b2b-talal`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${_jwt}`, apikey: _jwt },
              body: JSON.stringify(payload),
            });
          } catch (_e) { /* best-effort — لا يؤثّر على أحد */ }
        };
        // @ts-ignore EdgeRuntime injected by Supabase
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(_fwd());
        else _fwd();
        return OK_RESPONSE();
      }
    } catch (_e) {
      // فشل كشف/توجيه B2B → تجاهُل تام ومتابعة المسار السياحي القديم بلا تغيير.
      try { console.log("b2b-route-skip:", (_e as Error)?.message || _e); } catch (_) { /* */ }
    }

    type Incoming = { from: string; body: string; numMedia: number; profileName: string;
      media_id: string; media_mime: string; media_filename: string; media_label: string;
      referral: Record<string, unknown> | null };
    const incoming: Incoming[] = [];
    const mediaLabels: Record<string, string> = {
      image: "📷 صورة", document: "📄 ملف", audio: "🎤 رسالة صوتية", voice: "🎤 رسالة صوتية",
      video: "🎥 فيديو", sticker: "🌟 ملصق", location: "📍 موقع", contacts: "👤 جهة اتصال",
    };
    for (const entry of (payload?.entry ?? [])) {
      // entry.id = مُعرّف حساب واتساب للأعمال (WABA) في كل ويبهوك من Meta.
      // نلتقطه مرة (رسائل أو statuses) لإعداد/إدارة القوالب لاحقاً بلا تدخّل يدوي.
      const _wabaId = String((entry as { id?: string })?.id || "");
      if (_wabaId && _wabaId !== _capturedWaba) {
        _capturedWaba = _wabaId;
        // التقاط WABA (upsert سريع فقط). ⚠️ لا ننادي أي Graph API هنا: نداء
        // بلا مهلة كان يعلّق المهمة الخلفية فتتوقف معالجة الرسالة (التسجيل +
        // handleMessage) ولا تصل رسائل العملاء. إعداد القالب يتم من webhook_health.
        try { await supabase.from("wa_settings").upsert([{ key: "whatsapp_waba_id", value: _wabaId, updated_at: new Date().toISOString() }]); } catch (_e) { /* best-effort */ }
      }
      for (const change of (entry?.changes ?? [])) {
        const value = change?.value;
        const messages = value?.messages;
        if (!Array.isArray(messages) || messages.length === 0) continue;
        // خريطة wa_id → اسم الملف الشخصي من contacts[] لنسب كل رسالة لاسمها.
        const nameByWaId = new Map<string, string>();
        for (const c of (value?.contacts ?? [])) {
          const wid = String(c?.wa_id || "");
          if (wid) nameByWaId.set(wid, String(c?.profile?.name || ""));
        }
        for (const m of messages) {
          const rawFrom = String(m?.from || "");
          if (!rawFrom) continue;
          const t = String(m?.type || "");
          const isText = t === "text";
          // الوسائط القابلة للتنزيل لها كائن باسم النوع فيه id/mime_type/filename/caption.
          let mediaObj = (!isText && m?.[t] && typeof m[t] === "object") ? m[t] as Record<string, unknown> : null;
          // احتياط: نوع غير متوقّع لكن الرسالة تحمل وسيطاً تحت مفتاح معروف — التقطه.
          if (!isText && (!mediaObj || !mediaObj.id)) {
            for (const k of ["document", "image", "video", "audio", "voice", "sticker"]) {
              const o = m?.[k];
              if (o && typeof o === "object" && (o as Record<string, unknown>).id) { mediaObj = o as Record<string, unknown>; break; }
            }
          }
          const media_id = mediaObj ? String(mediaObj.id || "") : "";
          // خطأ Meta لنوع غير مدعوم (view-once، حالة/منشور مُعاد توجيهه، نوع لا يُسلَّم للـAPI).
          const metaErrTitle = (Array.isArray(m?.errors) && m.errors[0] && typeof m.errors[0] === "object")
            ? String((m.errors[0] as Record<string, unknown>).title || "") : "";
          // تشخيص: مرفق غير نصّي بلا وسيط — نسجّل النوع والخطأ والمفاتيح لمعرفة السبب.
          if (!isText && !media_id) { try { console.log("UNHANDLED_MEDIA type=" + t + " err=" + metaErrTitle + " keys=" + Object.keys(m || {}).join(",")); } catch (_) { /* */ } }
          const media_mime = mediaObj ? String(mediaObj.mime_type || "") : "";
          const media_filename = mediaObj ? String(mediaObj.filename || "") : "";
          const caption = mediaObj ? String(mediaObj.caption || "") : "";
          const b = isText ? String(m?.text?.body || "") : caption;
          // نوع معروف (أو فيه وسيط قابل للتنزيل) → تسمية النوع.
          // نوع غير مدعوم بلا وسيط → واتساب Cloud API لا يسلّم الوسيط إطلاقاً في
          // هذه الحالات، فلا يوجد ما نُنزّله (ليس خللاً في الداشبورد):
          //   • صورة/فيديو «عرض مرة واحدة» (view once) — الأكثر شيوعاً: العميل يرسل
          //     الجواز/إيصال الدفع بخاصية العرض-مرة-واحدة للخصوصية.
          //   • type=unsupported (ميزة أحدث من نسخة الـAPI، استطلاع، تفاعل…).
          // نعطي الموظفة رسالة واضحة قابلة للتنفيذ + نُرفق النوع/الخطأ الفعلي كي
          // نميّز نهائياً «قيد واتساب» عن أي خلل حقيقي إن تكرّرت الشكوى.
          let media_label = "";
          if (!isText) {
            if (mediaLabels[t] || media_id) media_label = mediaLabels[t] || "📎 مرفق";
            else {
              const diag = [t ? `النوع: ${t}` : "", metaErrTitle ? `(${metaErrTitle})` : ""].filter(Boolean).join(" ");
              media_label = "⚠️ أرسل العميل مرفقاً لا يصل عبر واتساب (غالباً «عرض مرة واحدة» أو مُعاد توجيه)"
                + (diag ? ` — ${diag}` : "")
                + ". اطلبي منه إعادة إرساله كصورة عادية (بدون خاصية «عرض مرة واحدة») أو ملف PDF.";
            }
          }
          const nm = (!isText) ? 1 : 0;
          // إعلان «اضغط للمحادثة» (إنستقرام/فيسبوك): واتساب يرسل referral مع أول رسالة.
          const referral = (m?.referral && typeof m.referral === "object") ? m.referral as Record<string, unknown> : null;
          if (!b && nm === 0 && !referral) continue;   // لا نص ولا مرفق ولا إعلان — تجاهل.
          incoming.push({
            from: metaFromToInternal(rawFrom),
            body: b,
            numMedia: nm,
            profileName: nameByWaId.get(rawFrom) || "",
            media_id, media_mime, media_filename, media_label, referral,
          });
        }
      }
    }

    // لا رسائل واردة (غالباً حدث statuses: delivered/read/sent) — 200 وتجاهل.
    if (incoming.length === 0) {
      return OK_RESPONSE();
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // معالجة رسالة واحدة: تُسجّل في التدقيق أولاً (حتى لو فشل ما بعدها لا تُفقد)
    // ثم تُمرّر للمنطق — أو placeholder لو وسائط بلا نص.
    const processOne = async (item: Incoming): Promise<void> => {
      const { from, body, numMedia, profileName, media_id, media_mime, media_filename, media_label, referral } = item;
      // نحفظ نسخة دائمة من الوسيط فوراً وهو طازج (خلفيّاً كي لا نؤخّر رد الويبهوك)،
      // فلا يختفي المرفق عندما يحذفه Meta لاحقاً. أفضل جهد — لا يعطّل الاستقبال.
      if (media_id) {
        // @ts-ignore EdgeRuntime injected by Supabase
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(warmInboundMedia(media_id));
        else warmInboundMedia(media_id);
      }
      // أعمدة الوسائط تُضاف فقط عند وجود معرّف (لعرض الملف بالداشبورد عبر media_proxy).
      const mediaCols: Record<string, unknown> = media_id
        ? { media_id, media_mime: media_mime || null, media_filename: media_filename || null }
        : {};
      // إعلان «اضغط للمحادثة»: نخزّن مصدر الإعلان على الجلسة ليظهر بالداشبورد.
      const refCols: Record<string, unknown> = referral ? { ad_referral: referral } : {};
      if (!body && numMedia > 0) {
        // وسائط بلا نص: نضمن ظهورها بالداشبورد عبر تحديث الجلسة + سطر تدقيق مع معرّف الوسيط.
        const nowIso = new Date().toISOString();
        const { data: existingSess } = await supabase
          .from("whatsapp_sessions").select("phone").eq("phone", from).maybeSingle();
        if (existingSess) {
          const upd: Record<string, unknown> = { last_message_at: nowIso, ...refCols };
          if (profileName) upd.profile_name = profileName;
          await supabase.from("whatsapp_sessions").update(upd).eq("phone", from);
        } else {
          // عميل جديد أول رسالة منه وسائط/ملصق → نضبط intake_active=true أيضاً حتى
          // يستقبله طلال عند أول رسالة نصية (وإلا تروح رسائله للمعاينة بدل الردّ).
          await supabase.from("whatsapp_sessions").insert({
            phone: from, profile_name: profileName || "", stage: "new", last_message_at: nowIso, intake_active: true, ...refCols,
          });
        }
        // 📷 صورة من العميل: نقرأها بالرؤية (غالباً صورة عرض سياحي)؛ لو طلعت عرضاً
        // نشغّل الاستقبال بوصفها كنص فيعرف طلال الوجهة ويسأل عن الباقي (التاريخ/العدد).
        const isImage = /^image\//i.test(String(media_mime || "")) || /image/i.test(String(media_label || ""));
        let offerDesc = "";
        if (isImage && media_id) { try { offerDesc = await describeCustomerImage(media_id); } catch (_e) { /* */ } }
        const auditBody = offerDesc ? ("📷 صورة عرض من العميل — " + offerDesc) : (media_label || "📎 مرفق من العميل");
        await supabase.from("wa_message_audit").insert({
          from_phone: from, body: auditBody,
          status: "completed", completed_at: nowIso, ...mediaCols,
        });
        // لو الصورة عرض سفر واضح → مرّرها للاستقبال كنص ليرد طلال (بلا سؤال الوجهة).
        if (offerDesc) {
          try { await handleMessage({ supabase, from, profileName, body: "أرسل العميل صورة هذا العرض: " + offerDesc, referral: (referral as { body?: string; headline?: string; source_id?: string } | null) }); } catch (e) { console.error("image-intake error", e); }
          if (referral) { try { await supabase.from("whatsapp_sessions").update({ ad_referral: referral }).eq("phone", from); } catch (_e) { /* */ } }
        }
        return;
      }
      // نص (أو نص+caption لوسيط): نسجّل سطر التدقيق + معرّف الوسيط إن وُجد.
      const { data: auditRow } = await supabase
        .from("wa_message_audit")
        .insert({ from_phone: from, body: String(body).slice(0, 500), status: "received", ...mediaCols })
        .select("id, received_at")
        .single();
      const auditId = (auditRow as { id?: string } | null)?.id ?? null;
      const msgReceivedAt = (auditRow as { received_at?: string } | null)?.received_at ?? null;
      try {
        await handleMessage({ supabase, from, profileName, body, msgReceivedAt: msgReceivedAt || undefined, referral: (referral as { body?: string; headline?: string; source_id?: string } | null) });
        // خزّن مصدر الإعلان على الجلسة بعد إنشائها/تحديثها في handleMessage.
        if (referral) { try { await supabase.from("whatsapp_sessions").update({ ad_referral: referral }).eq("phone", from); } catch (_e) { /* */ } }
        if (auditId) {
          await supabase.from("wa_message_audit").update({
            status: "completed", completed_at: new Date().toISOString(),
          }).eq("id", auditId);
        }
      } catch (err) {
        console.error("handleMessage error", err);
        if (auditId) {
          await supabase.from("wa_message_audit").update({
            status: "errored",
            error_message: String((err as Error)?.stack ?? err).slice(0, 1000),
            completed_at: new Date().toISOString(),
          }).eq("id", auditId);
        }
      }
    };

    // معالجة خلفية غير حاجبة: نرد على Meta فوراً بـ 200 ونعالج كل الرسائل
    // تسلسلياً (للحفاظ على صحة آلة حالة الجلسة عند تعدد رسائل نفس العميل في
    // الدفعة)، ثم watchdog يكنس أي رسالة عالقة. ملفوفة في EdgeRuntime.waitUntil
    // لأن الـ isolate قد يُقتل بعد الرد مباشرة فتُفقد المعالجة الخلفية.
    const background = (async () => {
      for (const item of incoming) {
        try { await processOne(item); }
        catch (err) { console.error("processOne fatal", err); }
      }
      await checkStalledMessages(supabase).catch(err => console.error("watchdog error", err));
    })();

    // @ts-ignore EdgeRuntime injected globally by Supabase Edge Runtime.
    if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
      // @ts-ignore — يبقي الـ isolate حياً حتى تكتمل معالجة كل الرسائل.
      EdgeRuntime.waitUntil(background);
    }

    return OK_RESPONSE();
  } catch (e) {
    console.error("WhatsApp-Router error", e);
    // نرد دائماً بـ 200 حتى لو فشل التحليل — وإلا Meta تعيد إرسال نفس الحدث.
    return OK_RESPONSE();
  }
});
