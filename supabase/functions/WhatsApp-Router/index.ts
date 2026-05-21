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
  /أبي|ابي|بدي|أريد|اريد|أحتاج|احتاج/i,
  /حجز|احجز|أحجز/i,
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
    return { category: "package", confidence: packageHits >= 2 ? 0.9 : 0.6, via: "keywords" };
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
function extractPersons(text: string): number | null {
  // أرقام عربية أو لاتينية: "4 أشخاص" / "اثنين" / "ثلاثة"
  const m = text.match(/(\d+)\s*(?:شخص|أشخاص|اشخاص|راكب|مسافر)?/);
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
  // dd/mm أو dd-mm أو dd/mm/yyyy
  const m = text.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
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

// ── FAQ lookup ────────────────────────────────────────────────────────────
async function findFaqAnswer(
  supabase: ReturnType<typeof createClient>,
  text: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("faqs")
    .select("question_keywords, answer, priority")
    .eq("active", true);
  if (error || !data) return null;

  let best: { answer: string; score: number; priority: number } | null = null;
  for (const row of data as Array<{ question_keywords: string[]; answer: string; priority: number }>) {
    let score = 0;
    for (const kw of row.question_keywords) if (text.includes(kw)) score++;
    if (score === 0) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && row.priority > best.priority)
    ) {
      best = { answer: row.answer, score, priority: row.priority };
    }
  }
  return best?.answer ?? null;
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
async function sendWhatsapp(to: string, body: string): Promise<void> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_WHATSAPP_FROM") || "whatsapp:+96891171630";
  if (!sid || !token) {
    console.warn("Twilio credentials missing — would have sent to", to, ":", body);
    return;
  }
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

  // 2) إذا العميل في محادثة Tourism-AI نشطة، مرّر الرد لـ Tourism-AI
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
  // general — reply only when we have an FAQ match; stay silent otherwise
  // so the conversation feels like a real agent, not a bot fallback.
  const answer = await findFaqAnswer(supabase, text);
  if (answer) await sendWhatsapp(from, answer);
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

async function startPackageFlow(args: {
  supabase: ReturnType<typeof createClient>;
  session: { destination: string | null; persons: number | null; travel_date: string | null } | null;
  from: string;
  text: string;
}): Promise<void> {
  const { supabase, from, text } = args;
  // محاولة استخراج أي حقول من الرسالة الأولى
  const destination = extractDestination(text);
  const persons = extractPersons(text);
  const date = extractDate(text);

  const nextStage = !destination
    ? "awaiting_destination"
    : !persons
    ? "awaiting_persons"
    : !date
    ? "awaiting_date"
    : "ready";

  await supabase
    .from("whatsapp_sessions")
    .update({
      stage: nextStage,
      destination,
      persons,
      travel_date: date,
      last_message_at: new Date().toISOString(),
    })
    .eq("phone", from);

  if (nextStage === "ready") {
    await finalizePackage({ supabase, from });
    return;
  }
  await sendWhatsapp(from, promptForStage(nextStage));
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
  const updates: Record<string, unknown> = { last_message_at: new Date().toISOString() };

  if (session.stage === "awaiting_destination") {
    const d = extractDestination(text) || text.slice(0, 80);
    updates.destination = d;
  } else if (session.stage === "awaiting_persons") {
    const n = extractPersons(text);
    if (!n) {
      await sendWhatsapp(from, "ما فهمت العدد. اكتب رقم (مثلاً 4) أو كلمة (أربعة).");
      return;
    }
    updates.persons = n;
  } else if (session.stage === "awaiting_date") {
    const d = extractDate(text);
    if (!d) {
      await sendWhatsapp(from, "ما فهمت التاريخ. اكتبه بصيغة dd/mm/yyyy أو اذكر الشهر (مثلاً يوليو).");
      return;
    }
    updates.travel_date = d;
  }

  // حدّد الخطوة التالية بناءً على ما يتوفر بعد التحديث
  const merged = {
    destination: (updates.destination ?? session.destination) as string | null,
    persons: (updates.persons ?? session.persons) as number | null,
    travel_date: (updates.travel_date ?? session.travel_date) as string | null,
  };
  const nextStage = !merged.destination
    ? "awaiting_destination"
    : !merged.persons
    ? "awaiting_persons"
    : !merged.travel_date
    ? "awaiting_date"
    : "ready";
  updates.stage = nextStage;

  await supabase.from("whatsapp_sessions").update(updates).eq("phone", from);

  if (nextStage === "ready") {
    await finalizePackage({ supabase, from });
  } else {
    await sendWhatsapp(from, promptForStage(nextStage));
  }
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

  // 1) أبلغ العميل أننا نعمل عليه
  await sendWhatsapp(
    from,
    `تمام! نجهّز لك عرض ${s.destination} لـ ${s.persons} أشخاص بتاريخ ${s.travel_date}.\nلحظات...`,
  );

  // 2) استدعِ Tourism-AI ببداية محادثة جديدة
  const seedPrompt = `أبي برنامج سياحي إلى ${s.destination} لـ ${s.persons} أشخاص بتاريخ ${s.travel_date}`;
  const conversation: TaiTurn[] = [{ role: "user", content: seedPrompt }];
  const result = await callTourismAI(conversation);

  if (!result) {
    await sendWhatsapp(from, "تم تسجيل طلبك. سيتواصل معك أحد موظفي المبيعات قريباً.");
    await supabase
      .from("whatsapp_sessions")
      .update({ stage: "done", last_message_at: new Date().toISOString() })
      .eq("phone", from);
    return;
  }

  conversation.push({ role: "assistant", content: result.raw });
  await sendWhatsapp(from, result.formatted);

  // إذا الـ Tourism-AI رد ببرنامج كامل (فيه SUMMARY:) خلّص الحالة done،
  // وإلا خل العميل في حالة tourism_ai_active لإكمال المحادثة معه.
  const nextStage = result.isProgram ? "done" : "tourism_ai_active";

  // نبّه موظفي المبيعات في الحالتين — للحالة المفتوحة نخبرهم الطلب وصل وفي محادثة جارية
  const sales = staffList("SALES_WHATSAPP_NUMBERS");
  const noticeHeader = result.isProgram ? "📨 برنامج جاهز للمراجعة" : "📨 طلب باقة جديد (Tourism-AI نشط)";
  const notice =
    `${noticeHeader}\n` +
    `العميل: ${s.profile_name} (${from.replace(/^whatsapp:/, "")})\n` +
    `الوجهة: ${s.destination}\n` +
    `الأشخاص: ${s.persons}\n` +
    `التاريخ: ${s.travel_date}`;
  await Promise.all(sales.map(num => sendWhatsapp(num, notice)));

  await supabase
    .from("whatsapp_sessions")
    .update({
      stage: nextStage,
      conversation,
      last_message_at: new Date().toISOString(),
    })
    .eq("phone", from);
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
  await sendWhatsapp(from, result.formatted);

  const nextStage = result.isProgram ? "done" : "tourism_ai_active";
  await supabase
    .from("whatsapp_sessions")
    .update({
      stage: nextStage,
      conversation,
      last_message_at: new Date().toISOString(),
    })
    .eq("phone", from);

  // لو البرنامج صار جاهز (فيه SUMMARY)، نبه المبيعات بالناتج
  if (result.isProgram) {
    const sales = staffList("SALES_WHATSAPP_NUMBERS");
    const phoneDigits = from.replace(/^whatsapp:/, "");
    const dest = data?.destination ?? "";
    const persons = data?.persons ?? "";
    const date = data?.travel_date ?? "";
    const notice =
      `✅ برنامج جاهز للمراجعة\n` +
      `العميل: ${profileName} (${phoneDigits})\n` +
      `${dest} · ${persons} أشخاص · ${date}\n\n` +
      result.formatted.slice(0, 1100);
    await Promise.all(sales.map(num => sendWhatsapp(num, notice)));
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
