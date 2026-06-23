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

const JSON_HEADERS = { "Content-Type": "application/json" };

// نرد على ويبهوك Meta بـ 200 سريع (الرسائل الصادرة نرسلها عبر Graph REST
// بأنفسنا في الخلفية عبر EdgeRuntime.waitUntil حتى نرسل لعدّة أرقام موظفين).
const OK_RESPONSE = () => new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });

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
const DESTINATION_HINTS: Array<[RegExp, string]> = [
  [/فيتنام|hanoi|هانوي|halong|sapa|danang|phuquoc/i, "فيتنام"],
  [/ماليزيا|مليزيا|malaysia|كوالا|langkawi|penang/i, "ماليزيا"],
  [/إندونيسيا|اندونيسيا|indonesia|بالي|جاكرتا/i, "إندونيسيا"],
  [/تركيا|turkey|اسطنبول|طرابزون|بورصة/i, "تركيا"],
  [/تايلاند|تايلند|thailand|بانكوك|بوكيت|باتايا/i, "تايلاند"],
  [/البوسنة|البوسنه|bosnia|سراييفو/i, "البوسنة"],
  [/روسيا|russia|موسكو|سوتشي/i, "روسيا"],
];

function extractDestination(text: string): string | null {
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
async function sendCustomerReply(
  supabase: ReturnType<typeof createClient>,
  to: string,
  body: string,
  mediaUrl?: string,
): Promise<string | null> {
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

// Twilio WhatsApp body limit = 1600 chars. Long admin messages (e.g.
// detailed tour programs) used to fail silently. Split on natural
// boundaries: paragraph → newline → sentence → space → hard cut.
function splitForWhatsApp(text: string, maxLen = 1500): string[] {
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

async function sendWhatsapp(to: string, body: string, mediaUrl?: string): Promise<string | null> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    console.warn("Cloud API credentials missing — would have sent to", to, ":", body);
    return null;
  }
  // ترجمة الحدّ الصادر: التمثيل الداخلي "whatsapp:+968…" → "968…" لـ Graph.
  const graphTo = internalToGraph(to);
  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  // TODO(media): الوسائط الصادرة معطّلة في نسخة Cloud API. Twilio كان يقبل
  // MediaUrl كرابط مباشر؛ Graph يحتاج type:"image"/"document" مع link أو
  // media id مرفوع مسبقاً. حتى نهاجر المرفقات، نتجاهل mediaUrl ونرسل النص فقط.
  if (mediaUrl) {
    console.warn("TODO(media): outbound media not yet supported on Cloud API — sending text only to", to);
  }

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
      return null;
    }
    try {
      const data = await res.json();
      const id = data?.messages?.[0]?.id;
      return typeof id === "string" ? id : null;
    } catch { return null; }
  };

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
  return "ON"; // legacy default
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

// ── استقبال العملاء الجدد (طلال) ─────────────────────────────────────────
// يجمع المعلومات الأساسية بمحادثة طبيعية (وجهة/عدد/تاريخ/أعمار/مدينة الوصول
// والمغادرة) ويرد تلقائياً، ثم يتوقّف عند الاكتمال ليتسلّمها الموظف. يخص
// المحادثات الجديدة فقط (intake_active). يفهم النص والأرقام والكلام المجزّأ.
async function handleNewLeadIntake(args: {
  supabase: ReturnType<typeof createClient>; from: string; body: string;
  returning?: boolean;
}): Promise<void> {
  const { supabase, from } = args;
  const returning = args.returning === true;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const [inboundRes, outboundRes, sessRes] = await Promise.all([
    supabase.from("wa_message_audit").select("body, received_at").eq("from_phone", from)
      .not("body", "is", null).order("received_at", { ascending: false }).limit(30),
    supabase.from("wa_admin_messages").select("body, sent_at").eq("customer_phone", from)
      .order("sent_at", { ascending: false }).limit(30),
    supabase.from("whatsapp_sessions").select("intake_data").eq("phone", from).maybeSingle(),
  ]);
  type Row = { body?: string | null; received_at?: string; sent_at?: string };
  const msgs: Array<{ ts: string; who: string; body: string }> = [];
  for (const m of ((inboundRes.data || []) as Row[])) if (m.body && !String(m.body).startsWith("📎")) msgs.push({ ts: m.received_at || "", who: "العميل", body: String(m.body) });
  for (const m of ((outboundRes.data || []) as Row[])) if (m.body) msgs.push({ ts: m.sent_at || "", who: "طلال", body: String(m.body) });
  msgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const transcript = msgs.slice(-24).map(m => m.who + ": " + m.body).join("\n").slice(-4000);
  const prev = (sessRes.data as { intake_data?: unknown } | null)?.intake_data || {};
  const today = new Date().toISOString().slice(0, 10);

  if (!apiKey) {
    await supabase.from("whatsapp_sessions").update({ last_message_at: new Date().toISOString() }).eq("phone", from);
    return;
  }
  const sys = `أنت «طلال»، موظف خدمة عملاء لوكالة سفر، تتكلم بلهجة خليجية ودودة ومختصرة (لا فصحى).
⚠️ الاحترام أساسي: تكلّم بلباقة واحترام دائماً. ابدأ أسئلتك بعبارة مؤدبة مثل «حاضر» أو «أبشر» أو «حياك الله» ثم اطرح السؤال بلطف. ممنوع الأسلوب الجاف أو المختصر بطريقة غير لائقة.
- مثال صحيح: «أبشر، وين حابين تسافرون؟» / «حاضر، أي وجهة في بالكم؟»
- مثال خاطئ (ممنوع): «وين بتروح؟» / «وش تبي؟» / «كم عددكم؟» بدون مقدمة مؤدبة.
مهمتك جمع ٥ معلومات أساسية من العميل:
1) وجهة السفر  2) عدد المسافرين  3) تاريخ السفر  4) أعمار الأطفال فقط (إن وُجد أطفال)  5) المدن التي يحبون زيارتها (أو ترك الترتيب للوكالة).
قواعد:
${returning
  ? `- هذا عميل **سبق تعامل معنا وعاد بطلب وجهة جديدة**. ابدأ أول رد بترحيب بعودته بطريقة تُشعره أنك تعرفه (لا كأنها أول مرة): "حياك الله من جديد 🌟 سعدنا برجوعك! معك طلال" (كرسالة قصيرة لحالها) ثم اسأل عن أول معلومة ناقصة للرحلة الجديدة برسالة ثانية قصيرة.\n- ⚠️ تجاهل تفاصيل أي رحلة قديمة في السياق؛ هذا طلب رحلة جديدة — اجمع معلوماتها من جديد.`
  : `- أول رد ابدأه بالترحيب: "حياك الله 🌟 معك طلال من خدمة العملاء" (كرسالة قصيرة لحالها) ثم اسأل عن أول معلومة ناقصة برسالة ثانية قصيرة.`}
- ⚠️ ممنوع منعاً باتاً تمدح أو تعلّق على اختيار العميل أو وجهته. لا تقل نهائياً: «حلو / ممتاز / جميل / رائع / اختيار موفق / تمام تمام / حلو الاختيار». كن مباشراً ومحترفاً.
- ردودك قصيرة جداً: سؤال واحد مختصر، بلا ملخصات ولا علامات ✓ ولا كلام زائد.
- مثال صحيح: «كم عدد المسافرين؟» — مثال خاطئ (ممنوع): «تايلند اختيار حلو! كم عدد المسافرين؟».
- اسأل عن معلومة ناقصة واحدة فقط في كل رد (الأهم أولاً: الوجهة ثم العدد ثم التاريخ ثم الأعمار ثم مدينة الوصول/المغادرة).
- ⚠️ قاعدة الأعمار الصارمة:
  • لو ذكر العميل **أطفال/عيال/رضيع** → اسأل عن **أعمار الأطفال فقط فوراً وقبل أي سؤال آخر** (مثل: كم أعمار الأطفال؟) لأن السعر يعتمد على عمر الطفل. خزّن أعمار الأطفال في ages.
  • لو كان المسافرون **كبار فقط بلا أطفال** → لا تسأل عن الأعمار **إطلاقاً**، تجاوز الموضوع تماماً وانتقل لباقي المعلومات.
  • ❌ ممنوع منعاً باتاً تسأل عن عمر أي بالغ/كبير (لا الزوج ولا الزوجة/المدام ولا أي شخص بالغ) — سؤال غير لائق. الكبار يُحسبون عدداً فقط.
- افهم النص والأرقام المكتوبة بالحروف والكلام المجزّأ على عدة رسائل. لا تكرر سؤالاً أُجيب عنه.
- لو نسي العميل معلومة ذكّره بها تحديداً بلطف.
- بدل سؤال المطار: اسأل عن المدن هكذا: "أي مدن تحبون تزورونها؟ أو نرتّب لكم البرنامج بطريقتنا؟" — لو حدّد مدنًا معيّنة خزّنها في cities، ولو قال «رتّبوا لنا/بطريقتكم/أي مدن/ما أدري» خزّن في cities عبارة «حسب ترتيب الوكالة» وكمّل بلا إلحاح. لا تسأل عن المطار إطلاقاً.
- لو كان كلام العميل شكوى أو سؤال عام (مو حجز)، لا تضغط بأسئلة الاستقبال — ردّ بلطف إن زميلنا بيتواصل معه، واجعل complete=true.
- لمّا تكتمل المعلومات الـ٥: اشكره بالضبط "شكراً 🌟 معلوماتك وصلت، زميلنا بيجهّز لك أفضل عرض ويتواصل معك قريباً" واجعل complete=true.
اليوم: ${today}. المعلومات المجموعة سابقاً: ${JSON.stringify(prev)}.
أعد JSON فقط: {"messages":["رسالة قصيرة","رسالة قصيرة ثانية اختيارية"],"fields":{"destination":"","pax":null,"date":"","ages":"","cities":""},"complete":false}
حيث messages مصفوفة من رسالة إلى رسالتين قصيرتين منفصلتين (لا تجمع كل شيء في رسالة واحدة طويلة).`;
  let out: { reply?: string; messages?: unknown; fields?: Record<string, unknown>; complete?: boolean } | null = null;
  try {
    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 500, system: sys,
      messages: [{ role: "user", content: transcript || "(أول رسالة من العميل)" }],
    });
    let txt = ""; for (const b of res.content) if ((b as { type?: string }).type === "text") txt += (b as { text?: string }).text || "";
    const m = txt.match(/\{[\s\S]*\}/); if (m) out = JSON.parse(m[0]);
  } catch (_e) { /* فشل AI — لا نرد، الرسالة محفوظة للموظف */ }
  if (!out) {
    await supabase.from("whatsapp_sessions").update({ last_message_at: new Date().toISOString() }).eq("phone", from);
    return;
  }
  // رسائل قصيرة منفصلة (تُرسل بالتتابع للحفاظ على الترتيب) — تدعم messages مصفوفة أو reply نصّي.
  let outMsgs: string[] = [];
  if (Array.isArray(out.messages)) outMsgs = (out.messages as unknown[]).map(x => String(x || "").trim()).filter(Boolean);
  else if (out.reply) outMsgs = [String(out.reply).trim()];
  for (const msg of outMsgs.slice(0, 3)) {
    await sendCustomerReply(supabase, from, msg);
    // نسجّل كل رسالة من طلال لتظهر منفصلة في خيط المحادثة بالداشبورد.
    try { await supabase.from("wa_admin_messages").insert({ customer_phone: from, body: msg, sent_by: "طلال", sent_at: new Date().toISOString() }); } catch (_e) { /* best-effort */ }
  }
  const upd: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  if (out.fields && typeof out.fields === "object") upd.intake_data = { ...(prev as Record<string, unknown>), ...out.fields };
  if (out.complete === true) upd.intake_active = false;
  await supabase.from("whatsapp_sessions").update(upd).eq("phone", from);
}

async function handleMessage(args: {
  supabase: ReturnType<typeof createClient>;
  from: string;
  profileName: string;
  body: string;
}): Promise<void> {
  const { supabase, from, profileName, body } = args;
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
  const detectedDest = extractDestination(text);
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
    await handleNewLeadIntake({ supabase, from, body: text });
    return;
  }

  // عميل قديم (سبق رددنا عليه أو اكتمل استقباله) عاد بطلب **وجهة جديدة** (مختلفة عن
  // وجهته السابقة) → نعيد تفعيل طلال بترحيب «بعودتك» وجمع معلومات الرحلة الجديدة من جديد.
  if (s?.intake_active !== true && detectedDest && detectedDest !== hadDest) {
    await supabase.from("whatsapp_sessions")
      .update({ intake_active: true, intake_data: null, destination: detectedDest })
      .eq("phone", from);
    await handleNewLeadIntake({ supabase, from, body: text, returning: true });
    return;
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
    await sendCustomerReply(supabase, from, "لحظات استاذي واكون معك");
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
      "تمام أخوي وصلني طلبك راح يجهز لك موظف من المبيعات وارسلك التفاصيل بعد لحظات 🌹");
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
  const t = text.trim().toLowerCase();
  // "تم" is the new affirmative token used by step 4 ("save to suggested
  // category") in the admin correction flow — also keep all the old yeses.
  return ["نعم","تم","ايوه","أيوه","ايوا","أيوا","موافق","تمام","صح","اي","yes","y","ok","اوكي","اوك"]
    .some(w => t === w || t.startsWith(w + " ") || t.startsWith(w + "."));
}
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

      let sessionsQuery = supabase
        .from("whatsapp_sessions")
        .select("phone, profile_name, ai_enabled, last_message_at, last_outbound_at, last_outbound_body, last_opened_at, destination, assigned_staff_phone, assigned_at, assigned_by, customer_stage, label")
        .gte("last_message_at", sessionsSince)
        .order("last_message_at", { ascending: false })
        .limit(sessionsLimit);
      if (sessionsUntil) sessionsQuery = sessionsQuery.lte("last_message_at", sessionsUntil);
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
      for (const a of (latestAudits as Array<{ from_phone: string; body: string | null; received_at: string }> ?? [])) {
        if (!latestMsgByPhone.has(a.from_phone)) {
          latestMsgByPhone.set(a.from_phone, { body: a.body, received_at: a.received_at });
        }
      }

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
        return {
          ...s,
          customer_type,
          case_type,
          customer_stage,
          // complaint_type + priority + booking_status reflect the LATEST
          // proposal only — they describe the current state, not history.
          complaint_type: cls.complaint_type ?? null,
          booking_status: cls.booking_status ?? null,
          priority: cls.priority ?? null,
          last_message_body: lastMsg?.body ?? null,
          last_inbound_at: lastMsg?.received_at ?? null,
        };
      });

      const { data: staffList } = await supabase
        .from("wa_staff")
        .select("id, name, phone, active, role, username, destinations")
        .order("name");
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
        .update({ username, password_hash: hash, password_set_at: new Date().toISOString() }, { count: "exact" })
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
    if (!(await checkAuthOrSession(req))) return unauthorized();
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
      const twilioSid = await sendCustomerReply(supabase, phone, body, mediaUrl || undefined);
      await supabase.from("wa_admin_messages").insert({
        twilio_sid: twilioSid,
        customer_phone: phone,
        body: (body || (mediaUrl ? `📎 ${mediaUrl}` : "")).slice(0, 2000),
        sent_by: sentBy,
      });
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
      const { data: tRow } = await supabase.from("wa_settings").select("value").eq("key", "greeting_template_sid").maybeSingle();
      const contentSid = (typeof (tRow as { value?: unknown } | null)?.value === "string" ? (tRow as { value: string }).value : "")
        || (Deno.env.get("WHATSAPP_GREETING_TEMPLATE_SID") || "");
      if (!contentSid) {
        return new Response(JSON.stringify({ error: "لا يوجد قالب ترحيب محفوظ — احفظي ContentSid أولاً" }), { status: 400, headers: jsonCors });
      }
      const vars: Record<string, string> = {};
      if (p.vars && typeof p.vars === "object") {
        for (const [k, v] of Object.entries(p.vars)) vars[String(k)] = String(v);
      } else if (name) {
        vars["1"] = name;
      }
      const twilioSid = await sendWhatsappTemplate(phone, contentSid, vars);
      const now = new Date().toISOString();
      await supabase.from("whatsapp_sessions").upsert({
        phone,
        profile_name: name || null,
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

  // Admin/staff: create a WhatsApp greeting template via Twilio Content API,
  // submit it for WhatsApp approval, and save its ContentSid to wa_settings.
  //   POST ?admin_action=create_greeting_template  body {body?, category?}
  if (url.searchParams.get("admin_action") === "create_greeting_template") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const p = await req.json().catch(() => ({}));
      const body = String(p.body || "").trim()
        || "مرحباً {{1}} 🌟\nشكراً لتواصلك مع وكالة العز للسياحة والسفر. يسعدنا خدمتك — وش الوجهة اللي تفكّر فيها، وكم عدد المسافرين والتاريخ المتوقع؟";
      const category = String(p.category || "").toUpperCase() === "MARKETING" ? "MARKETING" : "UTILITY";
      const tSid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const tTok = Deno.env.get("TWILIO_AUTH_TOKEN");
      if (!tSid || !tTok) throw new Error("Twilio credentials missing");
      const auth = "Basic " + btoa(`${tSid}:${tTok}`);
      const friendly = "alezz_greeting_" + Date.now();
      const hasVar = /\{\{\s*1\s*\}\}/.test(body);
      const createBody: Record<string, unknown> = {
        friendly_name: friendly,
        language: "ar",
        types: { "twilio/text": { body } },
      };
      if (hasVar) createBody.variables = { "1": "العميل" };
      const cRes = await fetch("https://content.twilio.com/v1/Content", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
      const cText = await cRes.text();
      if (!cRes.ok) throw new Error("create: " + cRes.status + " " + cText.slice(0, 300));
      const created = JSON.parse(cText);
      const contentSid = String(created.sid || "");
      // Submit for WhatsApp approval.
      const aRes = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests/whatsapp`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: friendly.toLowerCase(), category }),
      });
      const aText = await aRes.text();
      let approval: unknown = null;
      try { approval = JSON.parse(aText); } catch { approval = aText.slice(0, 300); }
      const approvalStatus = (approval as { whatsapp?: { status?: string }; status?: string } | null)?.whatsapp?.status
        || (approval as { status?: string } | null)?.status
        || (aRes.ok ? "received" : "submit_failed");
      // Save the ContentSid so start_conversation can use it immediately.
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("wa_settings").upsert([{ key: "greeting_template_sid", value: contentSid, updated_at: new Date().toISOString() }]);
      return new Response(JSON.stringify({ ok: true, content_sid: contentSid, category, approval_status: approvalStatus, approval }), { headers: jsonCors });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: jsonCors });
    }
  }

  // Admin/staff: check WhatsApp approval status of the saved greeting template.
  if (url.searchParams.get("admin_action") === "template_status") {
    if (!(await checkAuthOrSession(req))) return unauthorized();
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supabase.from("wa_settings").select("value").eq("key", "greeting_template_sid").maybeSingle();
      const contentSid = typeof (data as { value?: unknown } | null)?.value === "string" ? (data as { value: string }).value : "";
      if (!contentSid) return new Response(JSON.stringify({ content_sid: "", status: "none" }), { headers: jsonCors });
      const tSid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const tTok = Deno.env.get("TWILIO_AUTH_TOKEN");
      const auth = "Basic " + btoa(`${tSid}:${tTok}`);
      const r = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, {
        headers: { Authorization: auth },
      });
      const txt = await r.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(txt); } catch { parsed = txt.slice(0, 300); }
      const status = (parsed as { whatsapp?: { status?: string } } | null)?.whatsapp?.status || "unknown";
      const rejection = (parsed as { whatsapp?: { rejection_reason?: string } } | null)?.whatsapp?.rejection_reason || "";
      return new Response(JSON.stringify({ content_sid: contentSid, status, rejection_reason: rejection, raw: parsed }), { headers: jsonCors });
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
      return new Response(JSON.stringify({ ok: true }), { headers: jsonCors });
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
    // مصادقة: header عادي، أو _t كـ query param (لأن <img> ما يقدر يبعث header).
    const tParam = (url.searchParams.get("_t") || "").trim();
    const legacy = (Deno.env.get("LEGACY_ANON_JWT") || "").trim();
    const authedByParam = !!tParam && !!legacy && tParam === legacy;
    if (!authedByParam && !(await checkAuthOrSession(req))) return unauthorized();
    try {
      const mediaId = (url.searchParams.get("media_id") || "").trim();
      if (mediaId) {
        // Cloud API: media id → رابط مؤقت من Graph → تنزيل بالتوكن وتمريره.
        const TOKEN = (Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim();
        if (!TOKEN) return new Response("no token", { status: 500, headers: corsHeaders });
        const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        if (!metaRes.ok) return new Response("media not found", { status: metaRes.status, headers: corsHeaders });
        const metaJson = await metaRes.json();
        const fileUrl = metaJson?.url;
        const mime = metaJson?.mime_type || "application/octet-stream";
        if (!fileUrl) return new Response("no url", { status: 404, headers: corsHeaders });
        const fileRes = await fetch(fileUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!fileRes.ok || !fileRes.body) return new Response("download failed", { status: fileRes.status, headers: corsHeaders });
        return new Response(fileRes.body, {
          headers: { ...corsHeaders, "Content-Type": mime, "Cache-Control": "private, max-age=3600" },
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
      const { data: existing } = await supabase
        .from("booking_brief").select("id, confirm_sent_at").eq("contact_phone", contact_phone)
        .in("status", ["incomplete", "complete"])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      // نرسل التأكيد عند كل حفظ مكتمل، لكن نمنع التكرار خلال 60 ثانية (نقرة مزدوجة).
      const lastConfirm = (existing as { confirm_sent_at?: string | null } | null)?.confirm_sent_at;
      const recentlyConfirmed = !!lastConfirm && (Date.now() - new Date(lastConfirm).getTime() < 60000);
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
{"destination":"","date_from":"","pax":null,"children":null,"days":null,"sim_count":null,"hotel_stars":"","notes":""}
القواعد:
- destination: واحدة فقط من [فيتنام، ماليزيا، تايلاند، تركيا، روسيا، البوسنة، إندونيسيا، عُمان] إن طابقت وجهة مذكورة، وإلا "".
- date_from: تاريخ السفر YYYY-MM-DD إن أمكن استنتاجه (حوّل العبارات النسبية حسب تاريخ اليوم)، وإلا "".
- pax بالغين، children أطفال، sim_count شرائح: أرقام أو null.
- days: عدد أيام الرحلة. لو ذكر العميل نطاق تواريخ (مثل 16-28 يوليو) فاحسبها شاملةً للطرفين = (يوم النهاية − يوم البداية) + 1 (مثال: 16→28 = 13 يومًا لا 12). ولو ذكر عددًا صريحًا للأيام فاستخدمه كما هو. وإلا null. واجعل date_from = تاريخ البداية للنطاق.
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
      const { data: inbound } = await supabase
        .from("wa_message_audit")
        .select("id, body, received_at, media_id, media_mime, media_filename")
        .eq("from_phone", phone)
        .order("received_at", { ascending: true })
        .limit(200);
      for (const m of (inbound as Array<{ id: string; body: string | null; received_at: string } & MediaRow> | null) ?? []) {
        items.push({ ts: m.received_at, body: m.body || "", sender: "customer", sid: String(m.id),
          media_id: m.media_id || null, media_mime: m.media_mime || null, media_filename: m.media_filename || null });
      }

      // الصادر: الردود المسجّلة (يدوي/اعتماد اقتراح/قالب ترحيب/ملف PDF).
      const { data: outbound } = await supabase
        .from("wa_admin_messages")
        .select("id, body, sent_at, sent_by, media_id, media_mime, media_filename")
        .eq("customer_phone", phone)
        .order("sent_at", { ascending: true })
        .limit(200);
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
      let mode: "ON" | "PREVIEW" | "OFF";
      if (rawMode === "ON" || rawMode === "PREVIEW" || rawMode === "OFF") {
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

    type Incoming = { from: string; body: string; numMedia: number; profileName: string;
      media_id: string; media_mime: string; media_filename: string; media_label: string;
      referral: Record<string, unknown> | null };
    const incoming: Incoming[] = [];
    const mediaLabels: Record<string, string> = {
      image: "📷 صورة", document: "📄 ملف", audio: "🎤 رسالة صوتية", voice: "🎤 رسالة صوتية",
      video: "🎥 فيديو", sticker: "🌟 ملصق", location: "📍 موقع", contacts: "👤 جهة اتصال",
    };
    for (const entry of (payload?.entry ?? [])) {
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
          // تشخيص: مرفق غير نصّي بلا وسيط — نسجّل النوع والمفاتيح لمعرفة السبب.
          if (!isText && !media_id) { try { console.log("UNHANDLED_MEDIA type=" + t + " keys=" + Object.keys(m || {}).join(",")); } catch (_) { /* */ } }
          const media_mime = mediaObj ? String(mediaObj.mime_type || "") : "";
          const media_filename = mediaObj ? String(mediaObj.filename || "") : "";
          const caption = mediaObj ? String(mediaObj.caption || "") : "";
          const b = isText ? String(m?.text?.body || "") : caption;
          const media_label = (!isText) ? (mediaLabels[t] || "📎 مرفق") : "";
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
            phone: from, profile_name: profileName || null, stage: "new", last_message_at: nowIso, intake_active: true, ...refCols,
          });
        }
        await supabase.from("wa_message_audit").insert({
          from_phone: from, body: media_label || "📎 مرفق من العميل",
          status: "completed", completed_at: nowIso, ...mediaCols,
        });
        return;
      }
      // نص (أو نص+caption لوسيط): نسجّل سطر التدقيق + معرّف الوسيط إن وُجد.
      const { data: auditRow } = await supabase
        .from("wa_message_audit")
        .insert({ from_phone: from, body: String(body).slice(0, 500), status: "received", ...mediaCols })
        .select("id")
        .single();
      const auditId = (auditRow as { id?: string } | null)?.id ?? null;
      try {
        await handleMessage({ supabase, from, profileName, body });
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
