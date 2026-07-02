/**
 * client-intake — B2B intake form backend.
 *
 * PUBLIC submit (POST, no auth): a company sends its trip request from
 * request.html. We auto-build the program with Tourism-AI, store the FULL
 * internal program (with pricing) for staff review, derive a SANITIZED client
 * view (no internal pricing, single group total), notify sales on WhatsApp, and
 * return ONLY { ok, ref_no } to the company. No program, no price leaves here.
 *
 * ADMIN actions (?admin_action=…, gated by CLIENT_ADMIN_SECRET header) power the
 * internal inbox: list / get (full internal program) / update_program (after a
 * staff edit) / approve (sanitize current program → status 'sent' → company can
 * open the proposal link).
 *
 * The company-facing client view is produced HERE, server-side, by copying only
 * non-price fields out of the program — prices physically never enter it.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROJECT_REF = "ofotvacszlmrqxzfjmtn";
const TOURISM_AI_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/Tourism-AI`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Content-Type": "application/json",
  // امنع كاش المتصفح: قوائم/طلبات الأفراد والشركات لازم تطلع آخر حالة دائماً،
  // وإلا يعرض برنامجاً قديماً بعد أي تعديل على السجل (عدد أشخاص/طيران قديم).
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

// ── helpers ────────────────────────────────────────────────────────────────
const MONTHS_AR = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

// Arabic form destination → package_suggestions.destination key (sheet tab name).
const DEST_KEY: Record<string, string> = {
  "فيتنام": "vietnam", "ماليزيا": "Malaysia", "تايلاند": "thailand",
  "تركيا": "Turky", "روسيا": "russia", "البوسنة": "Bosnia", "إندونيسيا": "indonesia",
  "عُمان": "Oman", "عمان": "Oman", "سلطنة عمان": "Oman",
};

function randToken(len = 24): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(36).padStart(2, "0")).join("").slice(0, len);
}

// ── company account auth helpers ────────────────────────────────────────────
// Passwords are stored as sha-256(salt + password). Low-stakes B2B (trip
// requests, no payments); salted SHA-256 is acceptable here.
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256Hex(salt + ":" + password);
}
// normalize a phone for matching: keep digits, drop leading 00/0, ensure no spaces.
function normPhone(raw: string): string {
  let p = String(raw || "").replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  return p;
}
// upload a base64 data-URL logo to the public company-logos bucket, return URL.
async function uploadLogo(supabase: any, dataUrl: string, phone: string): Promise<string | null> {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  const [, mime, b64] = m;
  const ext = mime.split("/")[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "png";
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (bytes.length > 2_000_000) return null; // 2MB cap
  const path = `${normPhone(phone).replace(/\D/g, "")}-${randToken(6)}.${ext}`;
  const { error } = await supabase.storage.from("company-logos").upload(path, bytes, { contentType: mime, upsert: true });
  if (error) { console.error("logo upload failed", error.message); return null; }
  const { data } = supabase.storage.from("company-logos").getPublicUrl(path);
  return data?.publicUrl || null;
}

// upload a base64 data-URL company document (PDF or image) to storage, return URL.
async function uploadDoc(supabase: any, dataUrl: string, phone: string): Promise<string | null> {
  const m = String(dataUrl || "").match(/^data:([a-zA-Z0-9.+\/-]+);base64,(.+)$/);
  if (!m) return null;
  const [, mime, b64] = m;
  const ext = (mime.split("/")[1] || "bin").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "bin";
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (bytes.length > 8_000_000) return null; // 8MB cap
  const path = `doc-${normPhone(phone).replace(/\D/g, "")}-${randToken(6)}.${ext}`;
  const { error } = await supabase.storage.from("company-logos").upload(path, bytes, { contentType: mime, upsert: true });
  if (error) { console.error("doc upload failed", error.message); return null; }
  const { data } = supabase.storage.from("company-logos").getPublicUrl(path);
  return data?.publicUrl || null;
}
// company stats: total / answered (sent) / pending (everything else)
async function companyStats(supabase: any, companyId: string) {
  const { data } = await supabase.from("client_requests").select("status").eq("company_id", companyId);
  const rows = (data || []) as Array<{ status: string }>;
  const total = rows.length;
  const done = rows.filter(r => r.status === "sent").length;
  return { total, done, pending: total - done };
}
// shape a company row for the company-facing side (never leak hash/salt).
function publicCompany(c: any) {
  return {
    id: c.id, company_name: c.company_name, contact_name: c.contact_name,
    contact_role: c.contact_role || null, country: c.country || null,
    contact_phone: c.contact_phone, contact_email: c.contact_email,
    logo_url: c.logo_url, document_url: c.document_url || null,
    website: c.website, status: c.status, currency: c.currency || "SAR",
    whatsapp_group_link: c.status === "approved" ? c.whatsapp_group_link : null,
    pending_edit: c.pending_edit || null,
  };
}

// look up a company by its own login_token OR the owner's impersonate_token,
// so "view as company" works without ending the company's real session.
async function companyByToken(supabase: any, token: string): Promise<any | null> {
  if (!token) return null;
  let { data } = await supabase.from("client_companies").select("*").eq("login_token", token).maybeSingle();
  if (!data) ({ data } = await supabase.from("client_companies").select("*").eq("impersonate_token", token).maybeSingle());
  return data || null;
}

// "2026-08-20" → "20 أغسطس 2026" (Tourism-AI parses Arabic dates). Pass through
// any other free-form date string unchanged.
function formatDate(raw: string): string {
  const m = (raw || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw || "";
  const [, y, mo, d] = m;
  return `${parseInt(d, 10)} ${MONTHS_AR[parseInt(mo, 10) - 1] || ""} ${y}`;
}

// Compose the natural-language request Tourism-AI already understands from the
// structured form input.
function buildRequestText(r: Record<string, any>): string {
  // A chosen ready-made suggestion sends its raw distribution string ("2 سيلانجور
  // + 2 لانكاوي + …"), which Tourism-AI parses natively — prefer it over the
  // manual city rows.
  const cities = String(r.distribution || "").trim()
    ? String(r.distribution).trim()
    : (Array.isArray(r.cities_nights)
        ? r.cities_nights.filter((c: any) => c && c.city && c.nights)
            .map((c: any) => `${c.nights} ${c.city}`).join(" + ")
        : "");
  const parts = [
    String(r.destination || "").trim(),
    r.days ? `${r.days} ايام` : "",
    cities,
    r.pax ? `ل ${r.pax} بالغين${r.children && Number(r.children) > 0 ? ` و ${r.children} اطفال` : ""}` : "",
    String(r.stars) === "4" ? "فنادق 4 نجوم" : String(r.stars) === "5" ? "فنادق 5 نجوم" : "فنادق مختلطة",
    r.date_from ? `تاريخ ${formatDate(String(r.date_from))}` : "",
    String(r.transport || "") === "shared" ? "النقل مشتركة" : "",
    r.sim_count && Number(r.sim_count) > 0 ? `${r.sim_count} شرائح` : "",
    String(r.extra_bed || "").trim() ? `سرير اضافي ${r.extra_bed}` : "",
    String(r.notes || "").trim(),
  ].filter(Boolean);
  return parts.join(" ");
}

async function callTourismAI(text: string): Promise<string | null> {
  const jwt = Deno.env.get("LEGACY_ANON_JWT") || "";
  const res = await fetch(TOURISM_AI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: jwt },
    body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) { console.error("Tourism-AI failed", res.status, (await res.text()).slice(0, 300)); return null; }
  const data = await res.json();
  const block = Array.isArray(data?.content) ? data.content[0] : null;
  return block?.type === "text" ? String(block.text || "") : null;
}

async function notifySales(text: string): Promise<void> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_WHATSAPP_FROM") || "whatsapp:+96891171630";
  const nums = (Deno.env.get("SALES_WHATSAPP_NUMBERS") || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!sid || !token || nums.length === 0) { console.warn("notifySales skipped (missing twilio/numbers)"); return; }
  for (const to of nums) {
    try {
      const form = new URLSearchParams({ From: from, To: to, Body: text });
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (e) { console.error("notifySales send error", (e as Error).message); }
  }
}

// ── OTP via Twilio Verify (WhatsApp channel) ────────────────────────────────
// Requires TWILIO_VERIFY_SERVICE_SID (a Verify Service with the WhatsApp channel
// enabled in the Twilio console). When the secret is absent, OTP is skipped.
function verifyConfigured(): boolean {
  return !!(Deno.env.get("TWILIO_ACCOUNT_SID") && Deno.env.get("TWILIO_AUTH_TOKEN") && Deno.env.get("TWILIO_VERIFY_SERVICE_SID"));
}
async function verifyStart(phone: string): Promise<{ ok: boolean; error?: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!, token = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const vsid = Deno.env.get("TWILIO_VERIFY_SERVICE_SID")!;
  try {
    const form = new URLSearchParams({ To: phone, Channel: "whatsapp" });
    const res = await fetch(`https://verify.twilio.com/v2/Services/${vsid}/Verifications`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (res.ok) return { ok: true };
    const t = await res.text(); console.error("verifyStart failed", res.status, t.slice(0, 300));
    return { ok: false, error: "تعذّر إرسال كود التحقق — تأكدي أن الرقم على واتساب" };
  } catch (e) { console.error("verifyStart error", (e as Error).message); return { ok: false, error: "تعذّر إرسال كود التحقق" }; }
}
async function verifyCheck(phone: string, code: string): Promise<boolean> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!, token = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const vsid = Deno.env.get("TWILIO_VERIFY_SERVICE_SID")!;
  try {
    const form = new URLSearchParams({ To: phone, Code: code });
    const res = await fetch(`https://verify.twilio.com/v2/Services/${vsid}/VerificationCheck`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) return false;
    const d = await res.json().catch(() => ({}));
    return d?.status === "approved";
  } catch (e) { console.error("verifyCheck error", (e as Error).message); return false; }
}

// ── SANITIZER (security boundary) ───────────────────────────────────────────
// Build the company-facing view by copying ONLY non-price fields out of the
// internal program text. Prices are in fields we never read; a defensive
// stripPrice() also scrubs any "<n> ريال" remnant from each emitted string.
function stripPrice(s: string): string {
  return (s || "")
    .replace(/[\d.,]+\s*ريال\s*\/?\s*(?:ليلة|شخص|للشخص)?/gu, "")
    .replace(/\|\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface ClientView {
  destination: string; meta: string; dateFrom: string; dateTo: string; pax: number; children: number;
  hotels: Array<{ name: string; city: string; stars: string; room: string; nights: string; meals: string; rooms?: number; add_rooms?: Array<{ room: string; occ: string }> }>;
  timeline: Array<{ day: number; items: Array<{ kind: string; text: string }> }>;
  extra_car_days: number[];
  groupTotal: number | null; currency: string;
}

function toClientView(raw: string): { view: ClientView; groupTotal: number | null } {
  const lines = (raw || "").split("\n");
  const get = (re: RegExp) => { const l = lines.find(x => re.test(x)); return l ? l.replace(re, "").trim() : ""; };

  const section = (name: string): string[] => {
    const start = lines.findIndex(l => l.trim() === `${name}:`);
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^[A-Z_]+:/.test(l.trim()) || l.trim() === "") {
        if (/^[A-Z_]+:/.test(l.trim())) break;
        else continue;
      }
      out.push(l);
    }
    return out;
  };

  const hotels: ClientView["hotels"] = [];
  for (const l of section("HOTELS")) {
    const p = l.split("|").map(s => s.trim());
    if (p.length < 4) continue;
    // name | city | stars | room | PRICE/ليلة | nights (dates) | ما يشمل: … | ADDROOM:… | …
    // الغرف الإضافية (ADDROOM) المضافة في شاشة التسعيرة لازم تظهر في ملف الشركة
    // أيضاً (النوع + السعة فقط، بلا سعر — ملف الشركة بلا تكاليف داخلية).
    const add_rooms: Array<{ room: string; occ: string }> = [];
    const arRe = /ADDROOM:([^|]+)/g; let am: RegExpExecArray | null;
    while ((am = arRe.exec(l)) !== null) {
      const a = am[1].split("~");
      const room = (a[0] || "").trim();
      if (room) add_rooms.push({ room, occ: (a[2] || "").trim() });
    }
    hotels.push({
      name: p[0] || "", city: p[1] || "", stars: p[2] || "", room: p[3] || "",
      nights: stripPrice(p[5] || ""), meals: (p[6] || "").replace(/^ما يشمل:\s*/u, "").trim(),
      add_rooms,
    });
  }
  // عدد الغرف لكل فندق (سطر "HOTEL_ROOMS: 2,1,3" بترتيب الفنادق) — يظهر في PDF الشركة
  const roomsCounts = ((raw.match(/^HOTEL_ROOMS:\s*(.+)$/mu)?.[1]) || "").split(",").map(x => parseInt(x.trim(), 10));
  hotels.forEach((h, i) => { const n = roomsCounts[i]; h.rooms = (n >= 1 && n <= 10) ? n : 1; });

  const timelineMap = new Map<number, Array<{ kind: string; text: string }>>();
  const addDay = (day: number, kind: string, text: string) => {
    const t = stripPrice(text);
    if (!t) return;
    if (!timelineMap.has(day)) timelineMap.set(day, []);
    timelineMap.get(day)!.push({ kind, text: t });
  };
  const dayOf = (cell: string): number | null => {
    const m = cell.match(/اليوم\s*(\d+)/u);
    return m ? parseInt(m[1], 10) : null;
  };

  const extraCarDays = new Set<number>();   // أيام بسيارة إضافية → تنبيه في ملف الشركة
  for (const l of section("TRANSFERS")) {
    const p = l.split("|").map(s => s.trim());
    const d = dayOf(p[0] || ""); if (d === null) continue;
    if (/نقل إضافي/.test(p[1] || "")) { extraCarDays.add(d); continue; }   // لا يظهر كنقطة خام
    addDay(d, "transfer", p[1] || "");
  }
  for (const l of section("TOURS")) {
    const p = l.split("|").map(s => s.trim());
    const d = dayOf(p[0] || ""); if (d === null) continue;
    if (/نقل إضافي/.test(p[1] || "")) { extraCarDays.add(d); continue; }
    addDay(d, "tour", p[1] || "");
  }
  for (const l of section("FLIGHTS")) {
    // "اليوم 6: Istanbol - Trabozon | داخلي | …"
    const head = (l.split("|")[0] || "").trim();
    const m = head.match(/اليوم\s*(\d+)\s*:?\s*(.+)/u);
    if (!m) continue;
    addDay(parseInt(m[1], 10), "flight", `رحلة داخلية: ${m[2].trim()}`);
  }

  const timeline = Array.from(timelineMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([day, items]) => ({ day, items }));

  // Single group total from SUMMARY's TOTAL_GROUP line.
  let groupTotal: number | null = null;
  const tg = lines.find(l => /^TOTAL_GROUP:/.test(l.trim()));
  if (tg) {
    const m = tg.match(/TOTAL_GROUP:\s*([\d.,]+)/);
    if (m) groupTotal = parseFloat(m[1].replace(/,/g, "")) || null;
  }
  const metaStr = get(/^META:/) || "";
  const metaPax = metaStr.match(/(\d+)\s*(?:أشخاص|اشخاص|شخص|بالغ)/u);
  const metaKids = metaStr.match(/(\d+)\s*(?:أطفال|اطفال|طفل)/u);

  const view: ClientView = {
    destination: get(/^DEST:/),
    meta: metaStr,
    dateFrom: get(/^DATE_FROM:/),
    dateTo: get(/^DATE_TO:/),
    pax: metaPax ? parseInt(metaPax[1], 10) : 0,
    children: metaKids ? parseInt(metaKids[1], 10) : 0,
    hotels, timeline,
    extra_car_days: Array.from(extraCarDays).sort((a, b) => a - b),
    groupTotal, currency: "ريال",
  };
  return { view, groupTotal };
}

// ── handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const url = new URL(req.url);

  // ── public: ready-made city-distribution suggestions for a destination ────
  // Safe to expose — these are just the agency's offered city splits grouped by
  // arrival/departure airport (no pricing). Powers the form's "ready" mode.
  const sugDestAr = url.searchParams.get("suggestions");
  if (sugDestAr) {
    const key = DEST_KEY[sugDestAr.trim()] || sugDestAr.trim();
    const { data, error } = await supabase
      .from("package_suggestions")
      .select("days, label, arrival_airport, departure_airport, distribution")
      .eq("destination", key)
      .order("arrival_airport").order("days");
    if (error) return json({ error: error.message }, 500);
    let suggestions = (data || []) as Array<Record<string, unknown>>;
    // إندونيسيا: عمود المطار في الشيت موحّد (Jakarta للكل) فيخلط برامج بالي ببرامج
    // جاكرتا. نشتق مطار القدوم/المغادرة فعلياً من مدن التوزيع: مناطق بالي → Bali،
    // مدن جاوة (جاكرتا/بونشاك/باندونغ) → Jakarta — فتنفصل اقتراحات كل مطار.
    if (key === "indonesia") {
      const airportOfCity = (c: string): string | null => {
        const t = c.toLowerCase();
        if (/بالي|جيمباران|[أا]بود|كوتا|نوسا\s*دوا|سيمينياك|اولو|أولو|دينباسار|denpasar|bali|ubud|kuta|seminyak|jimbaran|nusa/u.test(t)) return "Bali";
        if (/جاكرتا|جكارتا|بونشاك|بونتشاك|باندون[غج]|بو[غق]ور|jakarta|puncak|bandung|bogor/u.test(t)) return "Jakarta";
        return null;
      };
      const citiesOf = (dist: string): string[] =>
        String(dist || "").split(/[+\-]/).map(s =>
          s.replace(/\([^)]*\)/g, " ")               // أزل المناطق بين الأقواس
           .replace(/[٠-٩\d]+/g, " ")                 // أزل الأرقام
           .replace(/ليالي|ليلة|ليال|أيام|يوم/g, " ") // أزل وحدات الليالي
           .trim(),
        ).filter(Boolean);
      suggestions = suggestions.map(s => {
        const cs = citiesOf(String(s.distribution || ""));
        if (!cs.length) return s;
        const arr = airportOfCity(cs[0]);
        const dep = airportOfCity(cs[cs.length - 1]);
        return {
          ...s,
          arrival_airport: arr || s.arrival_airport,
          departure_airport: dep || s.departure_airport,
        };
      });
    }
    return json({ suggestions });
  }

  // ── public: company account actions (register / login) ────────────────────
  const companyAction = url.searchParams.get("company_action");
  if (companyAction) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await req.json().catch(() => ({} as Record<string, any>));

    if (companyAction === "register") {
      const name = String(body.company_name || "").trim();
      const phone = normPhone(body.contact_phone);
      const password = String(body.password || "");
      const email = String(body.contact_email || "").trim();
      const website = String(body.website || "").trim();
      const contactName = String(body.contact_name || "").trim();
      const contactRole = String(body.contact_role || "").trim();
      const country = String(body.country || "").trim();
      if (!name || !phone || password.length < 4) {
        return json({ error: "الاسم، رقم الجوال، وكلمة المرور (4 خانات على الأقل) مطلوبة" }, 400);
      }
      if (!contactName) {
        return json({ error: "اسم المسؤول مطلوب" }, 400);
      }
      if (!country) {
        return json({ error: "بلد الشركة مطلوب" }, 400);
      }
      if (!contactRole) {
        return json({ error: "منصب المسؤول (موقعه من الشركة) مطلوب" }, 400);
      }
      // require full international format with country code (E.164): +<country><number>
      if (!/^\+[1-9]\d{9,14}$/.test(phone)) {
        return json({ error: "رقم الجوال غير صحيح — أدخلي الرقم بصيغة دولية مع رمز الدولة، مثال: +9665XXXXXXXX" }, 400);
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return json({ error: "البريد الإلكتروني مطلوب وبصيغة صحيحة" }, 400);
      }
      const okWeb = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/\S*)?$/i.test(website) || /^@[\w.]{2,}$/.test(website);
      if (!website || !okWeb) {
        return json({ error: "الموقع أو الانستقرام مطلوب وبصيغة صحيحة (مثال: example.com أو @handle)" }, 400);
      }
      // reject duplicate phone
      const { data: existing } = await supabase.from("client_companies").select("id, status").eq("contact_phone", phone).maybeSingle();
      if (existing) return json({ error: "رقم الجوال مسجّل مسبقاً. سجّلي الدخول بدله." }, 409);
      // reject duplicate company NAME *within the same country* — different
      // countries may legitimately share a name, so we scope the check by country.
      const { data: dupName } = await supabase.from("client_companies").select("id").ilike("company_name", name).ilike("country", country).limit(1);
      if (dupName && dupName.length) return json({ error: "هذه الشركة مسجّلة مسبقاً في نفس البلد. سجّلي الدخول، أو تواصلي معنا لو تحتاجين مساعدة." }, 409);
      // reject duplicate email
      const { data: dupEmail } = await supabase.from("client_companies").select("id").ilike("contact_email", email).limit(1);
      if (dupEmail && dupEmail.length) return json({ error: "هذا البريد الإلكتروني مسجّل مسبقاً." }, 409);

      // OTP verification via WhatsApp (Twilio Verify). Skipped when not configured.
      if (verifyConfigured()) {
        const code = String(body.otp_code || "").trim();
        if (!code) {
          const sent = await verifyStart(phone);
          if (!sent.ok) return json({ error: sent.error || "تعذّر إرسال كود التحقق" }, 400);
          return json({ otp_sent: true });
        }
        const okCode = await verifyCheck(phone, code);
        if (!okCode) return json({ error: "كود التحقق غير صحيح أو منتهي — تأكدي من الكود المرسل على واتساب" }, 400);
      }

      const salt = randToken(16);
      const password_hash = await hashPassword(password, salt);
      let logo_url: string | null = null;
      if (body.logo_base64) logo_url = await uploadLogo(supabase, body.logo_base64, phone);
      let document_url: string | null = null;
      if (body.document_base64) document_url = await uploadDoc(supabase, body.document_base64, phone);

      const { data, error } = await supabase.from("client_companies").insert({
        company_name: name,
        contact_name: contactName,
        contact_role: String(body.contact_role || "").trim() || null,
        country,
        contact_phone: phone,
        contact_email: email,
        password_hash, password_salt: salt,
        logo_url,
        document_url,
        website,
        currency: ["SAR","AED","USD","OMR"].includes(String(body.currency)) ? String(body.currency) : "SAR",
        status: "pending",
      }).select("id").single();
      if (error) { console.error("company register failed", error.message); return json({ error: "تعذّر التسجيل" }, 500); }

      await notifySales(`🏢 طلب حساب شركة جديد\nالشركة: ${name}\nالمسؤول: ${String(body.contact_name || "-")}\nالجوال: ${phone}\nبانتظار موافقتك في لوحة الموظفين.`);
      return json({ ok: true, id: data.id, status: "pending" });
    }

    if (companyAction === "login") {
      const phone = normPhone(body.contact_phone);
      const password = String(body.password || "");
      if (!phone || !password) return json({ error: "أدخلي رقم الجوال وكلمة المرور" }, 400);
      const { data: c } = await supabase.from("client_companies").select("*").eq("contact_phone", phone).maybeSingle();
      if (!c) return json({ error: "لا يوجد حساب بهذا الرقم" }, 404);
      const hash = await hashPassword(password, c.password_salt);
      if (hash !== c.password_hash) return json({ error: "كلمة المرور غير صحيحة" }, 401);
      if (c.status === "pending")  return json({ error: "حسابك قيد المراجعة. ننبّهك عند التفعيل." }, 403);
      if (c.status === "rejected") return json({ error: "تعذّر تفعيل الحساب. تواصلي مع ALEZZ." }, 403);
      if (c.status === "suspended")return json({ error: "الحساب موقوف مؤقتاً. تواصلي مع ALEZZ." }, 403);
      // issue a rotating session token + سجّل دخولاً للشركة (عدّاد + آخر دخول)
      const token = randToken(28);
      await supabase.from("client_companies").update({
        login_token: token,
        login_count: (Number(c.login_count) || 0) + 1,
        last_login_at: new Date().toISOString(),
      }).eq("id", c.id);
      return json({ ok: true, token, company: publicCompany(c) });
    }

    if (companyAction === "me") {
      const token = String(body.token || "");
      if (!token) return json({ error: "no token" }, 401);
      const c = await companyByToken(supabase, token);
      if (!c || c.status !== "approved") return json({ error: "انتهت الجلسة، سجّلي الدخول من جديد" }, 401);
      return json({ ok: true, company: publicCompany(c) });
    }

    // company sees its own requests; view_token exposed only when the offer was sent
    if (companyAction === "my_requests") {
      const token = String(body.token || "");
      if (!token) return json({ error: "no token" }, 401);
      const c = await companyByToken(supabase, token);
      if (!c || c.status !== "approved") return json({ error: "انتهت الجلسة، سجّلي الدخول من جديد" }, 401);
      const { data: reqs } = await supabase.from("client_requests")
        .select("ref_no, destination, days, pax, status, created_at, sent_at, view_token, company_price, customer_name, requested_by, sent_by, is_reoffer, group_ref")
        .eq("company_id", c.id).order("created_at", { ascending: false }).limit(100);
      // عروض «عرض آخر» تظهر للشركة فقط بعد الإرسال (المسوّدات تبقى مخفية عند الموظف)
      const requests = (reqs || []).filter((r: any) => !(r.is_reoffer && r.status !== "sent")).map((r: any) => ({
        ref_no: r.ref_no, destination: r.destination, days: r.days, pax: r.pax,
        status: r.status === "sent" ? "sent" : "working",
        created_at: r.created_at,
        sent_at: r.sent_at || null,
        group_ref: r.group_ref || r.ref_no,
        customer_name: r.customer_name || null,
        requested_by: r.requested_by || null,
        is_reoffer: !!r.is_reoffer,
        view_token: r.status === "sent" ? r.view_token : null,
        company_price: r.status === "sent" ? r.company_price : null,
        sent_by: r.status === "sent" ? (r.sent_by || null) : null,
      }));
      return json({ ok: true, requests, currency: c.currency || "SAR" });
    }

    // Company proposes a profile edit (contact name / phone / logo). Stored in
    // pending_edit awaiting owner approval — live fields don't change until then.
    if (companyAction === "update_profile") {
      const token = String(body.token || "");
      if (!token) return json({ error: "انتهت الجلسة، سجّلي الدخول من جديد" }, 401);
      const c = await companyByToken(supabase, token);
      if (!c || c.status !== "approved") return json({ error: "انتهت الجلسة، سجّلي الدخول من جديد" }, 401);
      const edit: Record<string, any> = {};
      const name = String(body.contact_name ?? "").trim();
      if (name && name !== (c.contact_name || "")) edit.contact_name = name;
      if (body.contact_role != null) {
        const role = String(body.contact_role).trim();
        if (role !== (c.contact_role || "")) edit.contact_role = role;
      }
      if (body.contact_phone != null) {
        const phone = normPhone(body.contact_phone);
        if (phone && phone !== c.contact_phone) {
          const { data: dup } = await supabase.from("client_companies").select("id").eq("contact_phone", phone).neq("id", c.id).maybeSingle();
          if (dup) return json({ error: "رقم الجوال مستخدم من شركة أخرى" }, 409);
          edit.contact_phone = phone;
        }
      }
      if (body.logo_base64) { const url = await uploadLogo(supabase, body.logo_base64, c.contact_phone); if (url) edit.logo_url = url; }
      if (!Object.keys(edit).length) return json({ error: "ما فيه تغييرات للحفظ" }, 400);
      await supabase.from("client_companies").update({ pending_edit: edit, pending_edit_at: new Date().toISOString() }).eq("id", c.id);
      await notifySales(`✏️ طلب تعديل بيانات\nالشركة: ${c.company_name}\nبانتظار موافقتك في داشبورد الشركات.`);
      return json({ ok: true });
    }

    // ── company-managed staff names (for the «اسم الموظف الطالب» dropdown) ──
    if (companyAction === "staff_list") {
      const c = await companyByToken(supabase, String(body.token || ""));
      if (!c || c.status !== "approved") return json({ error: "انتهت الجلسة، سجّلي الدخول من جديد" }, 401);
      const { data } = await supabase.from("company_staff").select("id, name").eq("company_id", c.id).eq("active", true).order("name");
      return json({ ok: true, staff: data || [] });
    }
    if (companyAction === "staff_add") {
      const c = await companyByToken(supabase, String(body.token || ""));
      if (!c || c.status !== "approved") return json({ error: "انتهت الجلسة، سجّلي الدخول من جديد" }, 401);
      const nm = String(body.name || "").trim();
      if (!nm) return json({ error: "الاسم مطلوب" }, 400);
      const { data: dup } = await supabase.from("company_staff").select("id").eq("company_id", c.id).eq("active", true).ilike("name", nm).limit(1);
      if (dup && dup.length) return json({ error: "الاسم موجود مسبقاً" }, 409);
      const { error } = await supabase.from("company_staff").insert({ company_id: c.id, name: nm });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (companyAction === "staff_remove") {
      const c = await companyByToken(supabase, String(body.token || ""));
      if (!c || c.status !== "approved") return json({ error: "انتهت الجلسة، سجّلي الدخول من جديد" }, 401);
      const sid = String(body.id || "");
      if (!sid) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("company_staff").update({ active: false }).eq("id", sid).eq("company_id", c.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown company_action" }, 400);
  }

  const adminAction = url.searchParams.get("admin_action");

  // ── admin actions ─────────────────────────────────────────────────────────
  if (adminAction) {
    // Company-account management is OWNER-only (separate private dashboard) and
    // uses COMPANIES_ADMIN_SECRET. The staff request inbox keeps CLIENT_ADMIN_SECRET.
    const ownerOnly = ["companies", "company_get", "company_update", "company_edit", "impersonate", "staff_add", "staff_remove", "staff_report", "sec_overview", "sec_country_add", "sec_country_remove", "sec_enforce_set", "sec_device_trust", "sec_device_approve", "sec_device_remove", "sec_user_approve", "sec_user_suspend", "sec_user_remove", "sec_user_reset", "sec_user_device_approve"].includes(adminAction);
    // صندوق طلبات الشركات (عرض/بناء/إرسال) — محمي بكلمة الشركات (AA2026) أو مفتاح المالكة فقط،
    // لا يُفتح بمفتاح موظفي الأفراد العام، فيبقى مخفيًّا عن من يشتغل على الأفراد.
    const companyInbox = ["list", "get", "approve", "update_program", "duplicate"].includes(adminAction);
    const expected = (Deno.env.get(ownerOnly ? "COMPANIES_ADMIN_SECRET" : "CLIENT_ADMIN_SECRET") || "").trim();
    const got = (req.headers.get("x-admin-secret") || "").trim();

    // staff_list: readable by either dashboard (owner manages, staff picks name)
    if (adminAction === "staff_list") {
      const staffSec = (Deno.env.get("CLIENT_ADMIN_SECRET") || "").trim();
      const ownerSec = (Deno.env.get("COMPANIES_ADMIN_SECRET") || "").trim();
      const reqSec = (Deno.env.get("REQUESTS_STAFF_SECRET") || "").trim();
      if (!got || (got !== staffSec && got !== ownerSec && !(reqSec && got === reqSec))) return json({ error: "unauthorized" }, 401);
      const { data } = await supabase.from("staff_members").select("id, name").eq("active", true).order("name");
      return json({ staff: data || [] });
    }

    // توحيد الباسوورد: للصندوق العام (غير owner-only) نقبل أيضاً **كلمة بوابة الأمان
    // المشتركة** (APP_PASSWORD) إضافةً إلى CLIENT_ADMIN_SECRET — فيكفي الموظفَ دخولُه
    // بكلمة واحدة بدل مفتاح إداري منفصل. (المالكة بمفتاحها القديم تبقى تعمل.)
    const gatePass = (Deno.env.get("APP_PASSWORD") || "").trim();
    const ownerSec = (Deno.env.get("COMPANIES_ADMIN_SECRET") || "").trim();
    // كلمة صندوق الشركات (AA2026) — تفتح الشركات (+ الأفراد) لكنها ليست مفتاح المالكة.
    const companyPass = (Deno.env.get("REQUESTS_STAFF_SECRET") || "").trim();
    let okSecret: boolean;
    if (ownerOnly) {
      okSecret = !!got && got === expected;                          // إدارة/أمان: المالكة فقط
    } else if (companyInbox) {
      okSecret = !!got && (got === ownerSec || (!!companyPass && got === companyPass)); // شركات: المالكة أو AA2026
    } else {
      // الأفراد + العام: مفتاح الموظف العام أو البوابة أو المالكة أو كلمة الشركات
      okSecret = !!got && (got === expected || got === ownerSec || (!!gatePass && got === gatePass) || (!!companyPass && got === companyPass));
    }
    if (!okSecret) return json({ error: "unauthorized" }, 401);

    // ── طلبات الأفراد (booking_brief) — نفس صندوق الطلبات، تبويب منفصل ──────────
    // قراءة فقط: تُعرض طلبات الواتساب الفردية بجانب طلبات الشركات دون أي خلط.
    if (adminAction === "list_individuals") {
      // تنظيف ذاتي عند كل فتح للصندوق: انقل للمُرسلة أي طلب في الوارد لعميل سبق أُرسل له برنامج
      // بنفس الوجهة — يعالج المكرّرات التي تُنشأ حين يراسل العميل من جديد بعد استلام برنامجه.
      try { await supabase.rpc("dedup_sent_individual_briefs"); } catch (_) { /* أفضل جهد */ }
      // أي طلب مكتمل يظهر فورًا (complete) + المحوّل (transferred) + المُرسل (sent).
      // المسودّات الناقصة (incomplete) فقط تبقى خاصّة في لوحة الواتساب.
      const { data: briefs } = await supabase.from("booking_brief")
        .select("id, contact_phone, destination, pax, children, days, distribution, handled_by, currency, status, updated_at, created_at, sent_at, sent_by, sent_price, sent_currency")
        .eq("request_type", "individual")
        .in("status", ["complete", "transferred", "sent"])
        .order("updated_at", { ascending: false }).limit(500);
      const rows = (briefs || []) as Array<Record<string, any>>;
      const phones = [...new Set(rows.map(r => r.contact_phone).filter(Boolean))];
      const nameByPhone: Record<string, string> = {};
      if (phones.length) {
        const { data: sess } = await supabase.from("whatsapp_sessions")
          .select("phone, profile_name").in("phone", phones);
        for (const s of (sess || []) as Array<any>) if (s.profile_name) nameByPhone[s.phone] = s.profile_name;
      }
      const out = rows.map(r => ({ ...r, customer_name: nameByPhone[r.contact_phone] || null }));
      return json({ requests: out });
    }
    if (adminAction === "get_individual") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { data } = await supabase.from("booking_brief").select("*").eq("id", id).maybeSingle();
      if (!data) return json({ error: "غير موجود" }, 404);
      let customer_name: string | null = null;
      if ((data as any).contact_phone) {
        const { data: s } = await supabase.from("whatsapp_sessions")
          .select("profile_name").eq("phone", (data as any).contact_phone).maybeSingle();
        customer_name = (s as any)?.profile_name || null;
      }
      return json({ request: { ...data, customer_name } });
    }

    // إرسال عرض الفرد: يرفع الـ PDF لـ Graph ثم يرسله كملف document لرقم العميل،
    // مع ملاحظة الموظف كـ caption. ثم يعلّم الطلب «مُرسل». قيد واتساب: نافذة 24 ساعة.
    if (adminAction === "send_individual") {
      const TOKEN = (Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim();
      const PHONE_ID = (Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "").trim();
      if (!TOKEN || !PHONE_ID) return json({ error: "WhatsApp credentials missing" }, 500);
      const b = await req.json().catch(() => ({} as Record<string, any>));
      const id = String(b.id || "").trim();
      const rawPhone = String(b.phone || "").trim();
      const to = rawPhone.replace(/^whatsapp:/, "").replace(/^\+/, "").replace(/[^0-9]/g, "");
      const pdfB64 = String(b.pdf_base64 || "");
      // الاسم المعروض للعميل (يدعم العربي عبر document.filename — JSON بترميز UTF-8).
      let filename = String(b.filename || "عرض سفر.pdf").slice(0, 120);
      if (!/\.pdf$/i.test(filename)) filename += ".pdf";
      // ⚠️ خطوة رفع الوسيط (multipart) تُتلف الأسماء غير اللاتينية → نرفع باسم لاتيني
      // ثابت، والاسم العربي يُعرض من document.filename أدناه (هذا ما يراه العميل).
      const uploadName = "program.pdf";
      const note = String(b.note || "").trim().slice(0, 1000);
      if (!id || !to || !pdfB64) return json({ error: "missing id/phone/pdf" }, 400);
      try {
        // base64 → bytes
        const bin = atob(pdfB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // 1) رفع الملف كوسيط
        const fd = new FormData();
        fd.append("messaging_product", "whatsapp");
        fd.append("type", "application/pdf");
        fd.append("file", new Blob([bytes], { type: "application/pdf" }), uploadName);
        const upRes = await fetch(`https://graph.facebook.com/v22.0/${PHONE_ID}/media`, {
          method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: fd,
        });
        const upJson = await upRes.json();
        if (!upRes.ok || !upJson.id) return json({ error: "media upload failed", detail: upJson }, 502);
        // 2) إرسال الملف للعميل (الملاحظة كـ caption)
        const msgBody: Record<string, any> = {
          messaging_product: "whatsapp", to, type: "document",
          document: { id: upJson.id, filename, ...(note ? { caption: note } : {}) },
        };
        const sendRes = await fetch(`https://graph.facebook.com/v22.0/${PHONE_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(msgBody),
        });
        const sendJson = await sendRes.json();
        if (!sendRes.ok) return json({ error: "send failed", detail: sendJson?.error || sendJson }, 502);
        // 3) علّم الطلب «مُرسل» (نخزّن البرنامج والسعر والملاحظة)
        await supabase.from("booking_brief").update({
          status: "sent",
          sent_at: new Date().toISOString(),
          sent_by: String(b.sent_by || "").trim() || null,
          built_program: String(b.program || "").slice(0, 100000) || null,
          sent_price: (b.price != null && b.price !== "") ? Number(b.price) : null,
          sent_currency: String(b.currency || "").trim() || null,
          send_note: note || null,
          updated_at: new Date().toISOString(),
        }).eq("id", id);
        // سجّل الإرسال في خيط المحادثة ليظهر الملف (والملاحظة) بالداشبورد.
        const customerPhone = rawPhone.startsWith("whatsapp:") ? rawPhone : ("whatsapp:+" + to);
        // نظّف مكرّرات نفس العميل: المحادثة تُنشئ عدة طلبات (booking_brief) لنفس
        // الجوال؛ بعد إرسال البرنامج نعلّمها كلها «مُرسلة» حتى لا تبقى نسخ بالواردة.
        try {
          await supabase.from("booking_brief")
            .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("contact_phone", customerPhone)
            .in("status", ["complete", "transferred"]);
        } catch (_) { /* أفضل جهد */ }
        const threadBody = (note ? note + "\n" : "") + "📎 [ملف البرنامج PDF]";
        try {
          await supabase.from("wa_admin_messages").insert({
            customer_phone: customerPhone, body: threadBody,
            sent_by: String(b.sent_by || "").trim() || "النظام", sent_at: new Date().toISOString(),
            media_id: upJson.id, media_mime: "application/pdf", media_filename: filename,
          });
          // last_message_at كذلك → ترتفع المحادثة لأعلى قائمة داشبورد الواتساب (أسلوب واتساب).
          // + جدولة متابعة «اليوم الثاني» (تاريخ السعودية + 1 يوم) — تُرسل مرة واحدة بالكرون.
          const _ts = new Date().toISOString();
          const _ksaTom = new Date(Date.now() + 3 * 3600 * 1000); _ksaTom.setUTCDate(_ksaTom.getUTCDate() + 1);
          await supabase.from("whatsapp_sessions").update({
            last_message_at: _ts, last_outbound_at: _ts, last_outbound_body: "📎 ملف البرنامج (PDF)",
            followup_due_date: _ksaTom.toISOString().slice(0, 10), followup_done: false,
          }).eq("phone", customerPhone);
        } catch (_) { /* best-effort */ }
        return json({ ok: true, message_id: sendJson?.messages?.[0]?.id || null });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    // «حفظ فقط» (بدون إرسال): يخزّن البرنامج والسعر ويعلّم الطلب مُنجَزاً، بلا
    // إرسال PDF للعميل — للحالات التي أُرسل فيها العرض للعميل سابقاً يدوياً.
    if (adminAction === "save_individual") {
      const b = await req.json().catch(() => ({} as Record<string, any>));
      const id = String(b.id || "").trim();
      if (!id) return json({ error: "missing id" }, 400);
      const note = String(b.note || "").trim().slice(0, 500);
      const { error } = await supabase.from("booking_brief").update({
        status: "sent",
        sent_at: new Date().toISOString(),
        sent_by: String(b.sent_by || "").trim() || null,
        built_program: String(b.program || "").slice(0, 100000) || null,
        sent_price: (b.price != null && b.price !== "") ? Number(b.price) : null,
        sent_currency: String(b.currency || "").trim() || null,
        send_note: "💾 حفظ بدون إرسال" + (note ? (" — " + note) : ""),
        updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // نقل طلب فرد للمُرسلة بنقرة واحدة — بدون إعادة بناء/تسعير/إرسال. لِما يكون
    // الموظف أرسل البرنامج للعميل بطريقة أخرى (لوحة الواتساب) فيبقى عالقاً بالوارد.
    if (adminAction === "mark_individual_sent") {
      const b = await req.json().catch(() => ({} as Record<string, any>));
      const id = String(b.id || "").trim();
      if (!id) return json({ error: "missing id" }, 400);
      const { error } = await supabase.from("booking_brief").update({
        status: "sent",
        sent_at: new Date().toISOString(),
        sent_by: String(b.sent_by || "").trim() || null,
        send_note: "✅ نُقل يدوياً للمُرسلة (أُرسل للعميل سابقاً)",
        updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // «إرسال عرض آخر»: ينسخ طلب الفرد كطلب جديد وارد (يُعاد بناؤه وإرساله).
    if (adminAction === "duplicate_individual") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { data: src } = await supabase.from("booking_brief").select("*").eq("id", id).maybeSingle();
      if (!src) return json({ error: "غير موجود" }, 404);
      const s = src as Record<string, any>;
      const { data: ins, error } = await supabase.from("booking_brief").insert({
        contact_phone: s.contact_phone, destination: s.destination, pax: s.pax, children: s.children,
        days: s.days, date_from: s.date_from, arrival_airport: s.arrival_airport,
        departure_airport: s.departure_airport, sim_count: s.sim_count, hotel_stars: s.hotel_stars,
        notes: s.notes, handled_by: s.handled_by, currency: s.currency,
        distribution: s.distribution, cities_nights: s.cities_nights,
        request_type: "individual", status: "complete", updated_at: new Date().toISOString(),
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: (ins as any).id });
    }

    // الموظفة (بعد تسجيل الدخول) تطلب توثيق جهازها الحالي → pending بانتظار موافقة المالكة
    if (adminAction === "device_request") {
      const b = await req.json().catch(() => ({} as Record<string, any>));
      const token = String(b.device_token || "").trim();
      const label = String(b.label || "").trim().slice(0, 80) || "جهاز بدون اسم";
      const uaStr = String(b.user_agent || req.headers.get("user-agent") || "").slice(0, 300);
      // مصدر الطلب: tourism (افتراضي) أو whatsapp — للموافقة المنفصلة المُعلَّمة.
      const source = (["tourism", "whatsapp"].includes(String(b.source))) ? String(b.source) : "tourism";
      if (token.length < 16) return json({ error: "رمز الجهاز غير صالح" }, 400);
      const { data: existing } = await supabase.from("trusted_devices").select("id, approved, label").eq("device_token", token).maybeSingle();
      if (existing) {
        // طلب لم يُعتمد بعد + وصل تعريف (اسم/رقم) → حدّث التسمية ليعرفها صاحب اللوحة.
        if (!existing.approved && label && label !== "جهاز بدون اسم") {
          try { await supabase.from("trusted_devices").update({ label }).eq("id", existing.id); } catch (_e) { /* */ }
        }
        return json({ ok: true, status: existing.approved ? "approved" : "pending" });
      }
      const { error } = await supabase.from("trusted_devices").insert({ device_token: token, label, user_agent: uaStr, approved: false, source });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, status: "pending" });
    }

    // owner: manage staff names (used in the «إرسال للشركة» dropdown)
    if (adminAction === "staff_add") {
      const body = await req.json().catch(() => ({} as Record<string, any>));
      const nm = String(body.name || "").trim();
      if (!nm) return json({ error: "الاسم مطلوب" }, 400);
      const { data: dup } = await supabase.from("staff_members").select("id").eq("name", nm).eq("active", true).maybeSingle();
      if (dup) return json({ error: "الاسم موجود مسبقاً" }, 409);
      const { error } = await supabase.from("staff_members").insert({ name: nm });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "staff_remove") {
      const sid = url.searchParams.get("id") || "";
      if (!sid) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("staff_members").update({ active: false }).eq("id", sid);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // per-employee performance: packages sent + average send speed in a period
    if (adminAction === "staff_report") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      let q = supabase.from("client_requests").select("sent_by, sent_at, created_at").eq("status", "sent").not("sent_by", "is", null);
      if (from) q = q.gte("sent_at", from);
      if (to) q = q.lte("sent_at", to);
      const { data } = await q.limit(5000);
      const map: Record<string, any> = {};
      for (const r of (data || []) as Array<any>) {
        const k = String(r.sent_by || "").trim(); if (!k) continue;
        const m = map[k] || (map[k] = { name: k, count: 0, totalMs: 0, speedN: 0 });
        m.count++;
        if (r.sent_at && r.created_at) {
          const ms = new Date(r.sent_at).getTime() - new Date(r.created_at).getTime();
          if (ms >= 0) { m.totalMs += ms; m.speedN++; }
        }
      }
      const { data: staff } = await supabase.from("staff_members").select("name").eq("active", true);
      for (const s of (staff || []) as Array<any>) { const k = String(s.name).trim(); if (k && !map[k]) map[k] = { name: k, count: 0, totalMs: 0, speedN: 0 }; }
      const report = Object.values(map).map((m: any) => ({ name: m.name, count: m.count, avg_speed_ms: m.speedN ? Math.round(m.totalMs / m.speedN) : null }))
        .sort((a: any, b: any) => b.count - a.count);
      return json({ report });
    }

    // owner "view as company": mint a separate impersonation token + return it,
    // so the owner can open the company portal without its password.
    if (adminAction === "impersonate") {
      const cid = url.searchParams.get("id") || "";
      const { data: c } = await supabase.from("client_companies").select("id, status").eq("id", cid).maybeSingle();
      if (!c) return json({ error: "الشركة غير موجودة" }, 404);
      if (c.status !== "approved") return json({ error: "الحساب غير مفعّل بعد" }, 400);
      const itoken = randToken(28);
      const { error } = await supabase.from("client_companies").update({ impersonate_token: itoken }).eq("id", cid);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, token: itoken });
    }

    // ── أمان داشبورد البرامج: سجل الدخول + الدول المسموحة + تفعيل الحظر ──
    if (adminAction === "sec_overview") {
      const [settingsRes, countriesRes, logRes, devicesRes] = await Promise.all([
        supabase.from("security_settings").select("enforce_country, fail_open_geo").eq("id", 1).single(),
        supabase.from("security_allowed_countries").select("code, name_ar").order("name_ar"),
        supabase.from("auth_log").select("created_at, event, ip, country, country_allowed, success, detail").order("created_at", { ascending: false }).limit(100),
        supabase.from("trusted_devices").select("id, label, approved, source, last_country, last_ip, last_seen, created_at, user_agent").order("created_at", { ascending: false }).limit(100),
      ]);
      // حسابات الموظفات + عدد مفاتيح كل واحدة
      const { data: usersRaw } = await supabase.from("app_users").select("id, name, phone, status, created_at, last_login_at").order("created_at", { ascending: false }).limit(200);
      const { data: pkRows } = await supabase.from("user_passkeys").select("user_id, approved, device_label");
      const pkMap: Record<string, { count: number; pending: boolean; approved: number; label: string | null }> = {};
      for (const p of (pkRows || []) as Array<{ user_id: number; approved: boolean; device_label: string | null }>) {
        const e = pkMap[p.user_id] || { count: 0, pending: false, approved: 0, label: null };
        e.count++; if (p.approved) e.approved++; else e.pending = true;
        if (!e.label && p.device_label) e.label = p.device_label;
        pkMap[p.user_id] = e;
      }
      const users = (usersRaw || []).map((u: any) => ({
        ...u,
        passkeys: pkMap[u.id]?.count || 0,
        device_approved: (pkMap[u.id]?.approved || 0) > 0,
        device_pending: pkMap[u.id]?.pending || false,
        device_label: pkMap[u.id]?.label || null,
      }));
      return json({
        settings: settingsRes.data || { enforce_country: false, fail_open_geo: true },
        countries: countriesRes.data || [],
        log: logRes.data || [],
        devices: devicesRes.data || [],
        users,
      });
    }
    if (adminAction === "sec_user_approve") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("app_users").update({ status: "active", approved_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "sec_user_suspend") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("app_users").update({ status: "suspended" }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "sec_user_remove") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("app_users").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // اعتماد جهاز الموظفة: تفعيل بصمتها (approved=true) فتقدر تدخل. لا تشتغل
    // البصمة قبل موافقة المالكة على الجهاز.
    if (adminAction === "sec_user_device_approve") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("user_passkeys").update({ approved: true }).eq("user_id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // إعادة ضبط جهاز الموظفة: نحذف بصماتها فتقدر تسجّل بصمة على جهاز جديد (قفل
    // الجهاز الواحد يمنعها من إضافة جهاز ثانٍ إلا بعد هذا). الحساب يبقى نشطاً.
    if (adminAction === "sec_user_reset") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("user_passkeys").delete().eq("user_id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // المالكة توثّق جهازها الحالي فوراً (approved=true)
    if (adminAction === "sec_device_trust") {
      const b = await req.json().catch(() => ({} as Record<string, any>));
      const token = String(b.device_token || "").trim();
      const label = String(b.label || "").trim().slice(0, 80) || "جهاز المالكة";
      const uaStr = String(b.user_agent || req.headers.get("user-agent") || "").slice(0, 300);
      if (token.length < 16) return json({ error: "رمز الجهاز غير صالح" }, 400);
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("trusted_devices")
        .upsert({ device_token: token, label, user_agent: uaStr, approved: true, approved_by: "owner", approved_at: nowIso }, { onConflict: "device_token" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "sec_device_approve") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("trusted_devices").update({ approved: true, approved_by: "owner", approved_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "sec_device_remove") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await supabase.from("trusted_devices").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "sec_country_add") {
      const body = await req.json().catch(() => ({} as Record<string, any>));
      const code = String(body.code || "").trim().toUpperCase();
      const name_ar = String(body.name_ar || "").trim();
      if (!/^[A-Z]{2}$/.test(code)) return json({ error: "رمز الدولة لازم حرفين (ISO-2) مثل SA" }, 400);
      if (!name_ar) return json({ error: "اسم الدولة مطلوب" }, 400);
      const { error } = await supabase.from("security_allowed_countries").upsert({ code, name_ar }, { onConflict: "code" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "sec_country_remove") {
      const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
      if (!code) return json({ error: "code required" }, 400);
      const { error } = await supabase.from("security_allowed_countries").delete().eq("code", code);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (adminAction === "sec_enforce_set") {
      const body = await req.json().catch(() => ({} as Record<string, any>));
      const enforce = !!body.enforce;
      const { error } = await supabase.from("security_settings").update({ enforce_country: enforce, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, enforce_country: enforce });
    }

    // ── company-account management ──
    if (adminAction === "companies") {
      const { data, error } = await supabase.from("client_companies")
        .select("id, company_name, contact_name, contact_phone, contact_email, logo_url, website, whatsapp_group_link, status, created_at, approved_at, pending_edit, currency, login_count, last_login_at")
        .order("created_at", { ascending: false }).limit(300);
      if (error) return json({ error: error.message }, 500);
      // attach request stats per company
      const { data: reqs } = await supabase.from("client_requests").select("company_id, status").not("company_id", "is", null);
      const stat: Record<string, { total: number; done: number; pending: number }> = {};
      for (const r of (reqs || []) as Array<{ company_id: string; status: string }>) {
        const s = stat[r.company_id] || (stat[r.company_id] = { total: 0, done: 0, pending: 0 });
        s.total++; if (r.status === "sent") s.done++; else s.pending++;
      }
      const companies = (data || []).map((c: any) => ({ ...c, pending_edit: undefined, has_pending_edit: !!c.pending_edit, stats: stat[c.id] || { total: 0, done: 0, pending: 0 } }));
      return json({ companies });
    }

    if (adminAction === "company_get") {
      const cid = url.searchParams.get("id") || "";
      const { data: c, error } = await supabase.from("client_companies")
        .select("id, company_name, contact_name, contact_role, country, contact_phone, contact_email, logo_url, website, whatsapp_group_link, status, notes, created_at, approved_at, approved_by, pending_edit, pending_edit_at, currency, document_url")
        .eq("id", cid).single();
      if (error) return json({ error: error.message }, 404);
      const stats = await companyStats(supabase, cid);
      const { data: requests } = await supabase.from("client_requests")
        .select("id, ref_no, destination, days, pax, status, group_total, created_at")
        .eq("company_id", cid).order("created_at", { ascending: false }).limit(100);
      return json({ company: c, stats, requests: requests || [] });
    }

    if (adminAction === "company_update" && req.method === "POST") {
      const cid = url.searchParams.get("id") || "";
      const body = await req.json().catch(() => ({} as Record<string, any>));
      const patch: Record<string, any> = {};
      if (body.status && ["pending", "approved", "rejected", "suspended"].includes(body.status)) {
        patch.status = body.status;
        if (body.status === "approved") { patch.approved_at = new Date().toISOString(); patch.approved_by = String(body.by || "staff"); }
      }
      if (typeof body.whatsapp_group_link === "string") patch.whatsapp_group_link = body.whatsapp_group_link.trim();
      if (typeof body.notes === "string") patch.notes = body.notes;
      if (!Object.keys(patch).length) return json({ error: "لا تغييرات" }, 400);
      const { error } = await supabase.from("client_companies").update(patch).eq("id", cid);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // owner approves/rejects a pending profile edit
    if (adminAction === "company_edit" && req.method === "POST") {
      const cid = url.searchParams.get("id") || "";
      const body = await req.json().catch(() => ({} as Record<string, any>));
      const { data: c } = await supabase.from("client_companies").select("pending_edit").eq("id", cid).single();
      if (!c || !c.pending_edit) return json({ error: "لا يوجد تعديل معلّق" }, 400);
      if (body.decision === "approve") {
        // re-check phone uniqueness at approval time
        if (c.pending_edit.contact_phone) {
          const { data: dup } = await supabase.from("client_companies").select("id").eq("contact_phone", c.pending_edit.contact_phone).neq("id", cid).maybeSingle();
          if (dup) return json({ error: "رقم الجوال صار مستخدماً من شركة أخرى" }, 409);
        }
        const { error } = await supabase.from("client_companies").update({ ...c.pending_edit, pending_edit: null, pending_edit_at: null }).eq("id", cid);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, applied: c.pending_edit });
      }
      if (body.decision === "reject") {
        await supabase.from("client_companies").update({ pending_edit: null, pending_edit_at: null }).eq("id", cid);
        return json({ ok: true });
      }
      return json({ error: "decision required (approve|reject)" }, 400);
    }

    if (adminAction === "list") {
      const { data, error } = await supabase
        .from("client_requests")
        .select("id, ref_no, company_name, customer_name, requested_by, destination, pax, days, status, group_total, created_at, sent_at, sent_by, company_id, group_ref, is_reoffer")
        .order("created_at", { ascending: false }).limit(200);
      if (error) return json({ error: error.message }, 500);
      // attach each company's pricing currency
      const compIds = [...new Set((data || []).map((r: any) => r.company_id).filter(Boolean))];
      const curMap: Record<string, string> = {};
      if (compIds.length) {
        const { data: comps } = await supabase.from("client_companies").select("id, currency").in("id", compIds);
        for (const c of (comps || []) as Array<{ id: string; currency: string }>) curMap[c.id] = c.currency || "SAR";
      }
      const requests = (data || []).map((r: any) => ({ ...r, company_currency: r.company_id ? (curMap[r.company_id] || "SAR") : null }));
      return json({ requests });
    }

    const id = url.searchParams.get("id") || "";
    if (adminAction === "get") {
      const { data, error } = await supabase.from("client_requests").select("*").eq("id", id).single();
      if (error) return json({ error: error.message }, 404);
      let company_currency = "SAR";
      if (data.company_id) {
        const { data: comp } = await supabase.from("client_companies").select("currency").eq("id", data.company_id).maybeSingle();
        company_currency = comp?.currency || "SAR";
      }
      return json({ request: { ...data, company_currency } });
    }

    if (adminAction === "update_program" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const built = String(body.built_program || "");
      const { view, groupTotal } = toClientView(built);
      const { error } = await supabase.from("client_requests")
        .update({ built_program: built, client_program: view, group_total: groupTotal, status: "pending_review" })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, group_total: groupTotal });
    }

    if (adminAction === "approve" && req.method === "POST") {
      const body = await req.json().catch(() => ({} as Record<string, any>));
      const sentBy = String(body.by || "").trim() || null;
      const cp = (body.company_price != null && String(body.company_price).trim() !== "") ? Number(body.company_price) : null;
      const { data: row, error: e1 } = await supabase.from("client_requests").select("built_program").eq("id", id).single();
      if (e1 || !row) return json({ error: "not found" }, 404);
      const { view, groupTotal } = toClientView(row.built_program || "");
      const { error } = await supabase.from("client_requests")
        .update({ client_program: view, group_total: groupTotal, status: "sent", sent_at: new Date().toISOString(), sent_by: sentBy, company_price: (cp != null && !isNaN(cp)) ? cp : null })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // staff: «إرسال عرض آخر» — انسخ طلباً مُرسلاً إلى طلب جديد (لنفس الشركة) ليبني الموظف عرضاً بديلاً
    if (adminAction === "duplicate" && req.method === "POST") {
      const { data: o, error: ge } = await supabase.from("client_requests").select("*").eq("id", id).single();
      if (ge || !o) return json({ error: "not found" }, 404);
      const year = (String(o.ref_no || "").match(/\d{4}/) || ["2026"])[0];
      const newRef = `REQ-${year}-${randToken(4).toUpperCase()}`;
      const newToken = randToken(28);
      const { data: ins, error } = await supabase.from("client_requests").insert({
        ref_no: newRef, view_token: newToken,
        company_id: o.company_id, company_name: o.company_name,
        contact_name: o.contact_name, contact_email: o.contact_email, contact_phone: o.contact_phone,
        destination: o.destination, customer_name: o.customer_name, requested_by: o.requested_by,
        cities_nights: o.cities_nights, sel_distribution: o.sel_distribution, sel_pair: o.sel_pair,
        stars: o.stars, pax: o.pax, children: o.children, days: o.days,
        date_from: o.date_from, transport: o.transport, extra_bed: o.extra_bed, sim_count: o.sim_count,
        notes: o.notes, built_program: o.built_program, client_program: o.client_program,
        group_total: o.group_total, status: "pending_review", is_reoffer: true,
        group_ref: o.group_ref || o.ref_no,   // كل عروض نفس العميل تتشارك مرجع المجموعة
      }).select("id, ref_no, view_token").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: ins.id, ref_no: ins.ref_no, view_token: ins.view_token });
    }

    return json({ error: "unknown admin_action" }, 400);
  }

  // ── public submit ────────────────────────────────────────────────────────
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "bad json" }, 400);

  // If a company is logged in, resolve it from its session token and use its
  // stored profile (the company doesn't re-type its details).
  let companyRow: any = null;
  if (body.company_token) {
    const data = await companyByToken(supabase, String(body.company_token));
    if (data && data.status === "approved") companyRow = data;
  }

  // minimal validation
  const company = companyRow ? String(companyRow.company_name) : String(body.company_name || "").trim();
  const destination = String(body.destination || "").trim();
  const pax = parseInt(String(body.pax || "0"), 10);
  const days = parseInt(String(body.days || "0"), 10);
  if (!company || !destination || !pax || !days) {
    return json({ error: "الحقول الأساسية ناقصة (الشركة، الوجهة، عدد الأشخاص، عدد الأيام)" }, 400);
  }

  // ref + token
  const year = formatDate(String(body.date_from || "")).match(/\d{4}/)?.[0] || "2026";
  const ref_no = `REQ-${year}-${randToken(4).toUpperCase()}`;
  const view_token = randToken(28);

  // auto-build
  const requestText = buildRequestText(body);
  const raw = await callTourismAI(requestText);
  const isProgram = !!raw && /^SUMMARY:/m.test(raw);
  let built_program = "", client_program: ClientView | null = null, group_total: number | null = null, build_message = "", status = "build_failed";
  if (isProgram) {
    built_program = raw!;
    const s = toClientView(raw!);
    client_program = s.view; group_total = s.groupTotal;
    status = "pending_review";
  } else {
    // No SUMMARY → engine asked for more info or hit a data gap. Keep the CHAT
    // line so staff can finish it manually; company still just sees "received".
    build_message = (raw || "").replace(/^CHAT:/m, "").trim().slice(0, 800);
  }

  const { error } = await supabase.from("client_requests").insert({
    ref_no, view_token,
    company_id: companyRow ? companyRow.id : null,
    company_name: company,
    contact_name: companyRow ? String(companyRow.contact_name || "") : String(body.contact_name || "").trim(),
    contact_email: companyRow ? String(companyRow.contact_email || "") : String(body.contact_email || "").trim(),
    contact_phone: companyRow ? String(companyRow.contact_phone || "") : String(body.contact_phone || "").trim(),
    destination,
    customer_name: String(body.customer_name || "").trim() || null,
    requested_by: String(body.requested_by || "").trim() || null,
    cities_nights: Array.isArray(body.cities_nights) ? body.cities_nights : [],
    sel_distribution: body.selected_distribution ? String(body.selected_distribution) : null,
    sel_pair: body.selected_pair ? String(body.selected_pair) : null,
    stars: ["4", "5", "mixed"].includes(String(body.stars)) ? String(body.stars) : "mixed",
    pax, children: parseInt(String(body.children || "0"), 10) || 0, days,
    date_from: String(body.date_from || "").trim(),
    transport: String(body.transport || "private"),
    extra_bed: String(body.extra_bed || "").trim(),
    sim_count: parseInt(String(body.sim_count || "0"), 10) || 0,
    notes: String(body.notes || "").trim(),
    status, built_program, client_program, group_total, build_message,
  });
  if (error) { console.error("insert failed", error.message); return json({ error: "تعذّر حفظ الطلب" }, 500); }

  // notify sales (best-effort, non-blocking failure)
  const statusAr = status === "pending_review" ? "جاهز للمراجعة" : "يحتاج إكمال يدوي";
  await notifySales(
    `📥 طلب جديد ${ref_no}\nالشركة: ${company}\nالوجهة: ${destination} | ${days} أيام | ${pax} أشخاص\nالحالة: ${statusAr}`,
  );

  return json({ ok: true, ref_no });
});
