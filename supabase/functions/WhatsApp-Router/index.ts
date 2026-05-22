/**
 * WhatsApp-Router — موجّه رسائل واتساب القادمة من Twilio
 *
 * يستقبل webhook من Twilio (application/x-www-form-urlencoded)، يصنّف الرسالة
 * إلى: general / package / complaint، يجمع بيانات الباقة عبر عدّة رسائل،
 * يستدعي Tourism-AI، يرسل تنبيهات للموظفين، ويحفظ العميل في HubSpot.
 *
 * Supabase Secrets المطلوبة:
 *   ANTHROPIC_API_KEY          → fallback للتصنيف عند ضعف ثقة الكلمات المفتاحية
 *   TWILIO_ACCOUNT_SID         → لإرسال رسائل واتساب صادرة
 *   TWILIO_AUTH_TOKEN          → ↑
 *   TWILIO_WHATSAPP_FROM       → whatsapp:+96891171630
 *   SALES_WHATSAPP_NUMBERS     → CSV: whatsapp:+9665XXX,whatsapp:+9665YYY
 *   COMPLAINTS_WHATSAPP_NUMBERS→ CSV نفس الصيغة
 *   HUBSPOT_API_KEY            → Private App token (Bearer)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → تُحقن تلقائياً
 *
 * Twilio webhook URL (POST):
 *   https://ofotvacszlmrqxzfjmtn.supabase.co/functions/v1/WhatsApp-Router
 */

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── ثوابت ─────────────────────────────────────────────────────────────────
const PROJECT_REF = "ofotvacszlmrqxzfjmtn";
const TOURISM_AI_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/Tourism-AI`;

const TWIML_HEADERS = { "Content-Type": "text/xml; charset=utf-8" };
const JSON_HEADERS = { "Content-Type": "application/json" };

// نرد على Twilio بـ TwiML فارغ (الرسائل الصادرة نرسلها عبر REST API بأنفسنا
// حتى نرسل لعدّة أرقام موظفين بنفس الـ webhook دون قيد TwiML على رسالة واحدة).
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

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
): Promise<string | null> {
  const { data, error } = await supabase
    .from("chat_answers")
    .select("id, sub_intent, keywords, answer_sa1, answer_om, answer_clarification");
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

  // Score rows by *length-weighted* keyword matches so a long phrase like
  // "السفر مع الحيوانات" beats short generic keywords like "سفر" that
  // appear in many rows. Each matched keyword contributes its char length
  // (capped at 20) to the row's score; a row needs ≥1 keyword to be in the
  // running.
  let best: { score: number; matchCount: number; row: typeof data[number] } | null = null;
  for (const row of data as Array<{
    id: string; sub_intent: string; keywords: string[];
    answer_sa1: string; answer_om: string; answer_clarification: string;
  }>) {
    let score = 0;
    let matchCount = 0;
    for (const kwRaw of row.keywords) {
      const kw = normalizeArabic(kwRaw);
      if (matchesAsWord(kw)) {
        matchCount++;
        score += Math.min(kw.length, 20);
      }
    }
    if (matchCount === 0) continue;
    if (!best || score > best.score) best = { score, matchCount, row };
  }
  if (!best) return null;

  const r = best.row;
  return (r.answer_om && r.answer_om.trim())
      || (r.answer_sa1 && r.answer_sa1.trim())
      || (r.answer_clarification && r.answer_clarification.trim())
      || null;
}

// ── HubSpot CRM ───────────────────────────────────────────────────────────
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

// Human-feeling typing delay based on message length. Ranges:
//   short  (≤50 chars)   → 2s
//   medium (51-150)      → 3-4s
//   long   (>150)        → 5-7s
// Randomised within bands so consecutive replies don't fire on identical timing.
function humanTypingDelayMs(text: string): number {
  const n = (text || "").length;
  if (n <= 50)  return 2000;
  if (n <= 150) return 3000 + Math.floor(Math.random() * 1000);
  return 5000 + Math.floor(Math.random() * 2000);
}

async function sendWhatsapp(to: string, body: string): Promise<void> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_WHATSAPP_FROM") || "whatsapp:+96891171630";
  if (!sid || !token) {
    console.warn("Twilio credentials missing — would have sent to", to, ":", body);
    return;
  }

  // Sleep to mimic a human composing the reply. The native WhatsApp "..."
  // typing dots aren't exposed on Twilio's standard Messages API for a
  // self-served WhatsApp sender, but the delay alone is what creates the
  // not-an-instant-bot feel users notice.
  await new Promise(r => setTimeout(r, humanTypingDelayMs(body)));

  const form = new URLSearchParams({ From: from, To: to, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${token}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!res.ok) console.error("Twilio send failed", to, await res.text());
}

function staffList(envVar: string): string[] {
  return (Deno.env.get(envVar) || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.startsWith("whatsapp:") ? s : `whatsapp:${s}`);
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
async function handleMessage(args: {
  supabase: ReturnType<typeof createClient>;
  from: string;
  profileName: string;
  body: string;
}): Promise<void> {
  const { supabase, from, profileName, body } = args;
  const text = body.trim();

  // 0) Admin response interception. If this message comes from a staff
  //    number AND there's a pending AI proposal awaiting decision, treat
  //    the message as admin's answer (نعم / لا), regardless of the admin's
  //    own session state. This must run BEFORE the welcome/isNew check so
  //    admin's "نعم" doesn't trigger a new-customer welcome.
  if (isAdminPhone(from)) {
    const proposal = await getOldestPendingProposal(supabase);
    if (proposal) {
      // Only treat as admin response when the message LOOKS like one
      // (clear yes/no token). A longer message means admin is acting as a
      // customer — let it fall through to the normal flow; the proposal
      // stays pending until they explicitly answer it later.
      if (isAffirmative(text) || isNegative(text)) {
        await handleAdminResponse({ supabase, proposal, text, adminFrom: from });
        return;
      }
    } else {
      // No pending proposal — but a bare confirmation word would otherwise
      // be misinterpreted as a customer question by the general handler.
      if (isAffirmative(text) || isNegative(text)) {
        await sendWhatsapp(from, "ما في طلب معلّق حالياً 👍");
        return;
      }
    }
  }

  // 1) اجلب أو أنشئ الجلسة
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
  } | null;

  if (isNew) {
    const contactId = await upsertHubspotContact({ phone: from, name: profileName });
    const seed = {
      phone: from,
      profile_name: profileName,
      stage: "new",
      hubspot_contact_id: contactId,
      last_message_at: new Date().toISOString(),
    };
    await supabase.from("whatsapp_sessions").insert(seed);
    session = { ...seed, destination: null, persons: null, travel_date: null } as typeof session;
    // رسالة ترحيب — تُرسل مرّة واحدة
    await sendWhatsapp(
      from,
      "حياك الله … معك طلال من خدمة العملاء كيف اقدر اخدمك",
    );
  }

  // 2) برنامج جاهز ينتظر مراجعة الموظف — رد ودود بدون استدعاء Tourism-AI ولا
  //    تصنيف. الموظف هو اللي بيرسل البرنامج لما يجهز.
  if (session && session.stage === "pending_review") {
    await sendWhatsapp(from, "سيتم إرسال برنامجك قريباً إن شاء الله 🌍 نعتذر عن الانتظار");
    await supabase
      .from("whatsapp_sessions")
      .update({ last_message_at: new Date().toISOString() })
      .eq("phone", from);
    return;
  }

  // 3) إذا العميل في محادثة Tourism-AI نشطة، مرّر الرد لـ Tourism-AI
  //    مع تاريخ المحادثة بدل ما يعيد التصنيف من جديد
  if (session && session.stage === "tourism_ai_active") {
    await continueTourismAIConversation({ supabase, from, text, profileName: session.profile_name });
    return;
  }

  // 3) لو الجلسة في وسط جمع بيانات الباقة (destination/persons/date)، أكمل الجمع
  if (session && session.stage !== "new" && session.stage !== "done") {
    await continuePackageFlow({ supabase, session, text, from });
    return;
  }

  // 3) صنّف الرسالة
  const { category } = await classify(text);

  if (category === "complaint") {
    await handleComplaint({ supabase, session, from, profileName, text });
    return;
  }
  if (category === "package") {
    await startPackageFlow({ supabase, session, from, text });
    return;
  }
  // general — try the FAQ first. If a chat_answers row matches, reply
  // immediately. If not, ask Claude to draft something and surface the
  // proposal to admin via createProposalAndNotifyAdmin (the customer
  // hears nothing yet — admin approves before any reply is sent).
  const answer = await findFaqAnswer(supabase, text);
  if (answer) {
    await sendWhatsapp(from, answer);
  } else if (!isSmallTalk(text)) {
    // Don't pay Claude on greetings, thanks, single-word acknowledgements.
    // The welcome message (if isNew) is response enough; otherwise stay silent.
    await createProposalAndNotifyAdmin({
      supabase,
      customerPhone: from,
      profileName,
      question: text,
    });
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

  // تنبيه موظفي الشكاوى
  const staff = staffList("COMPLAINTS_WHATSAPP_NUMBERS");
  const notice = `⚠️ شكوى جديدة\nمن: ${profileName} (${from.replace(/^whatsapp:/, "")})\nالرسالة:\n${text}`;
  await Promise.all(staff.map(num => sendWhatsapp(num, notice)));

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

Your goal:
Convert conversations into qualified travel leads and generate structured data + a customer reply.

You must behave like a senior travel sales consultant, not a chatbot.

TODAY DATE: {{TODAY}}

OUTPUT FORMAT: Return VALID JSON ONLY.
{
  "data": {
    "destination": null,
    "travel_dates": { "start_date": null, "end_date": null, "flexible": false },
    "passengers": { "adults": null, "children": null, "infants": null },
    "trip_duration_days": null,
    "budget": { "min": null, "max": null, "currency": "SAR" },
    "notes": null
  },
  "intent": "request_quote | book_now | visa_inquiry | compare | support | unknown | warm_lead",
  "action": "ask_question | suggest_destinations | send_offer | support",
  "message": "...",
  "lead_score": 0,
  "lead_type": "hot | warm | cold",
  "confidence": 0.0
}

EXTRACT DATA:
- destination (normalized English names: فيتنام→Vietnam, تركيا→Turkey, تايلند→Thailand, جورجيا→Georgia, ماليزيا→Malaysia, اندونيسيا→Indonesia, بالي→Bali, المالديف→Maldives)
- travel_dates (YYYY-MM-DD; interpret relative dates from TODAY; if vague → null + flexible=true)
- passengers (أنا وزوجتي=2 adults; عائلة=2 adults + children unknown)
- trip_duration_days, budget (currency SAR), notes

CORE SALES RULES:
1. ONE QUESTION RULE: never ask more than one question per message.
2. DESTINATION FIRST: if destination missing → action=ask_question, message asks for destination only.
3. NO OVER-ASKING: only ONE missing critical field at a time.
4. NO EARLY BOOKING: do not action=send_offer unless destination + travel_dates.start_date + passengers.adults all exist.
5. DO NOT RE-ASK DATA: never ask again for fields already provided in earlier turns or in CURRENT SESSION STATE below.
6. UNCLEAR REQUEST: if vague → action=suggest_destinations, propose Turkey/Vietnam/Thailand/Georgia.

STATE-AWARE HANDLING:
A) If the latest user message is a greeting or general phrase (مرحبا، هلا، لو سمحت):
   reply in Gulf Arabic friendly tone like "هلا أخوي 👋 أمرني كيف أقدر أساعدك" — do NOT mention previous request or status.
B) If the user asks about an old request (وش صار، جاهز العرض، وين الطلب):
   ONLY give status update like "جارٍ تجهيز أفضل العروض لك حالياً ✈️ وبإذن الله خلال دقائق يكون عندك" — no questions.
C) NEW REQUEST: focus only on it.

DATE RULES: convert all to YYYY-MM-DD. Understand 15 مايو, 15/5, next week, بعد أسبوع, after Eid, بعد شهرين. Unclear → null + flexible=true.

LEAD SCORING: +30 destination, +20 dates, +20 passengers, +10 budget, +20 urgency.
0-40 cold, 41-70 warm, 71-100 hot.

ROUTING LOGIC:
- destination missing → action=ask_question
- destination exists but key data missing → action=ask_question (ONE field)
- destination + date + passengers exist → intent=request_quote, action=send_offer
- general inquiry about pricing/visa/policies/hotels → action=support
- unclear → action=suggest_destinations

RESPONSE STYLE:
- Never explain reasoning, never output text outside JSON.
- Gulf Arabic natural warm tone — "اكيد ابشر", "حياك الله", "تمام أخوي".
- Short and human-like. Never sound like a robot question.
- Maximum one question per message.
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
    await Promise.all(sales.map(num => sendWhatsapp(num, notice)));
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
  await Promise.all(sales.map(num => sendWhatsapp(num, notice)));

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

type ClaudeAnalysis = {
  interpretation: string;
  suggestedReply: string;
  proposedIntent: string;
  proposedSubIntent: string;
  proposedKeywords: string[];
};

async function analyzeUnknownQuestion(
  supabase: ReturnType<typeof createClient>,
  question: string,
): Promise<ClaudeAnalysis | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const { data: existing } = await supabase
    .from("chat_answers")
    .select("intent, sub_intent");
  const categories = (existing || [])
    .map((r: { intent: string; sub_intent: string }) =>
      `${r.intent}${r.sub_intent ? " / " + r.sub_intent : ""}`)
    .join(", ");

  const sys =
    `أنت مساعد لوكالة سياحية تعمل في عُمان والسعودية (ALEZZ Tourism). ` +
    `يصلك سؤال عميل ما طابق أي إجابة في قاعدة الـ FAQ. مهمتك:\n` +
    `1) اشرح بإيجاز (جملة واحدة) ماذا يقصد العميل\n` +
    `2) اقترح رداً مناسباً باللهجة الخليجية بدون علامات ترقيم\n` +
    `3) اقترح فئة (intent + sub_intent) — يفضل من الفئات الموجودة، أو فئة جديدة لو لزم\n` +
    `4) اقترح 10-18 كلمة مفتاحية للمطابقة مستقبلاً\n\n` +
    `قواعد مهمة جداً للكلمات المفتاحية — المطابقة عبر substring مع حدود ` +
    `كلمات وقبول البادئات (ال، بال، ب، ل، ف، و، ك). يعني:\n` +
    `• ضع جذور الكلمات (ـ3 لـ ـ6 حروف) عشان تطابق أكبر عدد من المتغيرات.\n` +
    `• ضع متغيرات الجمع والملكية لكل مفهوم — مثلاً قطه، قطط، قطتي، قطته.\n` +
    `• تجنب الكلمات العامة الشائعة في عدة فئات: سفر، كيف، ابي، اريد، عندكم، ` +
    `وش، متى، الى، من، رحلة، برنامج، باكج.\n` +
    `• اعطِ تركيبات قصيرة (2-3 كلمات) فقط إذا كانت مميزة وفريدة لهذا المفهوم.\n` +
    `• لا تستخدم علامات ترقيم داخل الكلمات.\n\n` +
    `مثال جيد لسؤال عن السفر مع الحيوانات الأليفة:\n` +
    `["قطه","قطط","قطتي","كلب","كلاب","كلبي","حيوان","حيوانات","اليف","اليفه","حيوان اليف","نقل الحيوان","شحن حيوانات"]\n\n` +
    `الفئات الموجودة: ${categories}\n\n` +
    `أعد JSON فقط بدون أي نص آخر بهذا الشكل:\n` +
    `{"interpretation":"...","suggested_reply":"...","proposed_intent":"...","proposed_sub_intent":"...","proposed_keywords":["...","..."]}`;

  try {
    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system: sys,
      messages: [{ role: "user", content: question }],
    });
    const out = res.content?.[0];
    if (!out || out.type !== "text") return null;
    const m = out.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      interpretation: String(parsed.interpretation || "").trim(),
      suggestedReply: String(parsed.suggested_reply || "").trim(),
      proposedIntent: String(parsed.proposed_intent || "").trim(),
      proposedSubIntent: String(parsed.proposed_sub_intent || "").trim(),
      proposedKeywords: Array.isArray(parsed.proposed_keywords)
        ? parsed.proposed_keywords.map(String).map(s => s.trim()).filter(Boolean)
        : [],
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
  const analysis = await analyzeUnknownQuestion(supabase, question);
  if (!analysis) return;

  const { error } = await supabase.from("whatsapp_admin_proposals").insert({
    customer_phone: customerPhone,
    customer_profile_name: profileName,
    customer_question: question,
    interpretation: analysis.interpretation,
    suggested_reply: analysis.suggestedReply,
    proposed_intent: analysis.proposedIntent,
    proposed_sub_intent: analysis.proposedSubIntent,
    proposed_keywords: analysis.proposedKeywords,
    status: "pending_reply_approval",
  });
  if (error) { console.error("Proposal insert failed", error.message); return; }

  const phoneDigits = customerPhone.replace(/^whatsapp:/, "");
  const notice =
    `💡 سؤال جديد من عميل ينتظر موافقتك\n\n` +
    `العميل: ${profileName} (${phoneDigits})\n` +
    `السؤال: ${question}\n\n` +
    `أنا أفهم إنه يقصد: ${analysis.interpretation}\n\n` +
    `الرد المقترح:\n${analysis.suggestedReply}\n\n` +
    `هل أرد بهذا؟  نعم / لا`;
  const admins = staffList("SALES_WHATSAPP_NUMBERS");
  await Promise.all(admins.map(num => sendWhatsapp(num, notice)));
}

function isAdminPhone(from: string): boolean {
  return staffList("SALES_WHATSAPP_NUMBERS").includes(from);
}

async function getOldestPendingProposal(
  supabase: ReturnType<typeof createClient>,
): Promise<ProposalRow | null> {
  const { data } = await supabase
    .from("whatsapp_admin_proposals")
    .select("*")
    .in("status", ["pending_reply_approval", "pending_sheet_approval"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as ProposalRow | null) || null;
}

function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return ["نعم","ايوه","أيوه","ايوا","أيوا","موافق","تمام","صح","اي","yes","y","ok","اوكي","اوك"]
    .some(w => t === w || t.startsWith(w + " ") || t.startsWith(w + "."));
}
function isNegative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return ["لا","كلا","مرفوض","ارفض","أرفض","no","n"]
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

  if (!yes && !no) {
    await sendWhatsapp(adminFrom, proposal.status === "pending_reply_approval"
      ? `رد بـ "نعم" لإرسال الرد للعميل أو "لا" للإلغاء`
      : `رد بـ "نعم" لإضافة السؤال للشيت أو "لا" لتركه`);
    return;
  }

  if (proposal.status === "pending_reply_approval") {
    if (no) {
      await supabase.from("whatsapp_admin_proposals")
        .update({ status: "rejected", decided_at: new Date().toISOString() })
        .eq("id", proposal.id);
      await sendWhatsapp(adminFrom, "تم الإلغاء. ما رح يوصل أي رد للعميل");
      return;
    }
    // Send the suggested reply to the original customer
    await sendWhatsapp(proposal.customer_phone, proposal.suggested_reply);
    await supabase.from("whatsapp_admin_proposals")
      .update({ status: "pending_sheet_approval" })
      .eq("id", proposal.id);

    const kwStr = (proposal.proposed_keywords || []).join(" / ");
    const subStr = proposal.proposed_sub_intent ? ` / ${proposal.proposed_sub_intent}` : "";
    await sendWhatsapp(adminFrom,
      `✅ تم إرسال الرد للعميل\n\n` +
      `هل أضيف هذا السؤال للشيت؟\n` +
      `الكاتيجوري: ${proposal.proposed_intent}${subStr}\n` +
      `الكلمات المفتاحية: ${kwStr}\n` +
      `الجواب: ${proposal.suggested_reply}\n\n` +
      `نعم / لا`);
    return;
  }

  if (proposal.status === "pending_sheet_approval") {
    if (no) {
      await supabase.from("whatsapp_admin_proposals")
        .update({ status: "completed_no_add", decided_at: new Date().toISOString() })
        .eq("id", proposal.id);
      await sendWhatsapp(adminFrom, "تمام. ما رح يضاف للشيت");
      return;
    }
    const ok = await appendChatAnswerRow({
      intent: proposal.proposed_intent,
      subIntent: proposal.proposed_sub_intent,
      keywords: proposal.proposed_keywords,
      sampleQ: proposal.customer_question,
      answer: proposal.suggested_reply,
    });
    if (ok) {
      await supabase.from("whatsapp_admin_proposals")
        .update({ status: "completed_added", decided_at: new Date().toISOString() })
        .eq("id", proposal.id);
      await sendWhatsapp(adminFrom,
        `✅ تم إضافة السؤال للشيت بنجاح\n` +
        `في المرة القادمة لما يجي نفس السؤال راح يرد البوت تلقائياً 🎯`);
      void triggerSyncSheets();
    } else {
      await sendWhatsapp(adminFrom,
        `❌ ما قدرت أضيف للشيت. تأكدي إن tourism-sync@tourism-sysc-495108.iam.gserviceaccount.com عنده صلاحية Editor على الشيت`);
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
}): Promise<boolean> {
  const token = await getGoogleSheetsToken(
    "https://www.googleapis.com/auth/spreadsheets");
  if (!token) return false;

  // Sheet column order:
  // ID | Intent | Sub-intent | Keywords | sample Q | Answer_SA1 | Answer_SA2 | Answer clarification | Answer_OM | Status
  const newId = `PKG_AI_${Date.now()}`;
  const row = [
    newId,
    args.intent,
    args.subIntent,
    args.keywords.join(", "),
    args.sampleQ,
    args.answer,       // SA1
    "",                // SA2
    "",                // clarification
    args.answer,       // OM (same — Claude already wrote in Khaleeji)
    "AI-generated",
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
  if (req.method === "GET") {
    return new Response("WhatsApp-Router OK", { headers: { "Content-Type": "text/plain" } });
  }
  if (req.method !== "POST") {
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
    const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!expected || got !== expected) {
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

  try {
    const ct = req.headers.get("content-type") || "";
    let from = ""; let body = ""; let profileName = "";

    if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      from = String(form.get("From") || "");
      body = String(form.get("Body") || "");
      profileName = String(form.get("ProfileName") || "");
    } else {
      // JSON fallback (للاختبار اليدوي)
      const j = await req.json();
      from = j.From || j.from || "";
      body = j.Body || j.body || "";
      profileName = j.ProfileName || j.profileName || "";
    }

    if (!from || !body) {
      return new Response(EMPTY_TWIML, { headers: TWIML_HEADERS });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // معالجة الرسالة بشكل غير حاجب — نرد على Twilio فوراً TwiML فارغ،
    // ونرسل الردود الفعلية عبر Twilio REST. هذا يمنع timeout من Twilio.
    handleMessage({ supabase, from, profileName, body }).catch(err => {
      console.error("handleMessage error", err);
    });

    return new Response(EMPTY_TWIML, { headers: TWIML_HEADERS });
  } catch (e) {
    console.error("WhatsApp-Router error", e);
    return new Response(EMPTY_TWIML, { headers: TWIML_HEADERS });
  }
});
