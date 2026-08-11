/**
 * companies-discovery — اكتشاف شركات السفر والسياحة عبر Google Places API (New).
 *
 * منفصل تماماً عن نظام الشركات الحالي (client_companies / client-intake). يكتب فقط
 * في جدولين جديدين: discovered_companies و discovery_jobs.
 *
 * لا scraping لجوجل/خرائط جوجل — فقط Places API الرسمي (places:searchText).
 * مفتاح Google في السر GOOGLE_PLACES_API_KEY (لا يظهر في الصفحة أبداً).
 *
 * الأفعال (?action=…):
 *   start   POST {country,scope,cities,destination,target,keywords,activity}
 *              → ينشئ مهمة، يبني قائمة (مدينة × كلمة)، يشغّل أول دفعة بالخلفية، يرجّع {job_id}
 *   resume  POST {job}   → يشغّل دفعة أخرى بالخلفية (يُستدعى تلقائياً إذا توقفت المهمة)
 *   status  GET  ?job=   → تقدّم المهمة (found/inserted/duplicates/cursor/queue_len/label/status)
 *   results GET  ?job=&only_dest=1  → صفوف الشركات (الأحدث أولاً، confirmed ثم likely)
 *   stop    POST {job}   → إيقاف المهمة
 *
 * البوابة: إذا ضُبِط السر DISCOVERY_KEY يُطلب في ترويسة x-admin-secret، وإلا مفتوح
 * (مثل companies-admin المفتوح حالياً).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── إعدادات ثابتة ────────────────────────────────────────────────────────────
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = "places.id,places.displayName,places.websiteUri,places.internationalPhoneNumber,places.formattedAddress,nextPageToken";
const MAX_PAGES = 3;                 // 3 صفحات × 20 = 60 نتيجة كحد أقصى لكل استعلام
const WEBSITE_TIMEOUT_MS = 8000;
const WEBSITE_CONCURRENCY = 5;
const MAX_PAGES_PER_SITE = 4;        // الرئيسية + 3 روابط (اتصل بنا/عروض/وجهات)
const BATCH_MS = 90_000;             // سقف زمن الدفعة الخلفية الواحدة (قابل للاستئناف)
const BATCH_QUERIES = 6;             // أو هذا العدد من الاستعلامات، أيهما أسبق

const DEFAULT_KEYWORDS = ["شركة سياحة وسفر", "وكالة سفر", "مكتب حج وعمرة", "travel agency"];

// قوائم مدن جاهزة لكل دولة (نطاق «جميع المدن»).
const COUNTRY_CITIES: Record<string, string[]> = {
  SA: ["الرياض","جدة","مكة","المدينة","الدمام","الخبر","الطائف","تبوك","بريدة","حائل","أبها","خميس مشيط","نجران","جازان","الأحساء","ينبع","الجبيل"],
  OM: ["مسقط","صلالة","صحار","نزوى","صور","البريمي","عبري","الرستاق","بركاء","السيب","إبراء"],
  AE: ["دبي","أبوظبي","الشارقة","العين","عجمان","رأس الخيمة","الفجيرة","أم القيوين"],
  KW: ["مدينة الكويت","حولي","الفروانية","الأحمدي","الجهراء","السالمية","الفحيحيل"],
  QA: ["الدوحة","الوكرة","الريان","الخور","مسيعيد","أم صلال"],
  BH: ["المنامة","المحرق","الرفاع","مدينة عيسى","مدينة حمد","سترة"],
};
const COUNTRY_NAME: Record<string, string> = { SA:"السعودية", OM:"عُمان", AE:"الإمارات", KW:"الكويت", QA:"قطر", BH:"البحرين" };

// تصنيف الهاتف حسب الدولة (رمز الدولة + بادئات الجوال/الأرضي على أول رقم وطني).
const PHONE_RULES: Record<string, { cc: string; mobile: string[]; landline: string[] }> = {
  SA: { cc:"966", mobile:["5"], landline:["1","2"] },
  OM: { cc:"968", mobile:["7","9"], landline:["2"] },
  AE: { cc:"971", mobile:["5"], landline:["2","3","4","6","7","9"] },
  KW: { cc:"965", mobile:["5","6","9"], landline:["2"] },
  QA: { cc:"974", mobile:["3","5","6","7"], landline:["4"] },
  BH: { cc:"973", mobile:["3"], landline:["1"] },
};

// كلمات الوجهة (اختياري): مفتاح عربي مبسّط → قائمة كلمات (عربي + إنجليزي).
const DEST_KEYWORDS: Record<string, string[]> = {
  "تايلاند": ["تايلاند","تايلند","بانكوك","بوكيت","باتايا","كرابي","شيانغ ماي","Thailand","Bangkok","Phuket","Pattaya","Krabi","Samui","Chiang"],
  "ماليزيا": ["ماليزيا","كوالالمبور","لنكاوي","بينانج","Malaysia","Kuala Lumpur","Langkawi","Penang"],
  "تركيا": ["تركيا","اسطنبول","إسطنبول","طرابزون","انطاليا","أنطاليا","بورصة","Turkey","Istanbul","Trabzon","Antalya","Bursa"],
  "اندونيسيا": ["اندونيسيا","إندونيسيا","بالي","جاكرتا","باندونق","Indonesia","Bali","Jakarta","Bandung"],
  "فيتنام": ["فيتنام","هانوي","هوشي منه","دانانغ","Vietnam","Hanoi","Da Nang","Ho Chi Minh"],
  "المالديف": ["المالديف","المالديف","مالديف","Maldives","Male"],
  "جورجيا": ["جورجيا","تبليسي","باتومي","Georgia","Tbilisi","Batumi"],
  "اذربيجان": ["اذربيجان","أذربيجان","باكو","Azerbaijan","Baku"],
  "البوسنة": ["البوسنة","سراييفو","موستار","Bosnia","Sarajevo","Mostar"],
  "مصر": ["مصر","القاهرة","شرم الشيخ","الغردقة","Egypt","Cairo","Sharm","Hurghada"],
  "دبي": ["دبي","الامارات","الإمارات","أبوظبي","Dubai","UAE","Abu Dhabi"],
};
function destKeywordsFor(dest: string): string[] {
  const d = String(dest || "").trim();
  if (!d) return [];
  if (DEST_KEYWORDS[d]) return DEST_KEYWORDS[d];
  // مطابقة تقريبية على المفاتيح، وإلا استخدم الكلمة نفسها.
  for (const k of Object.keys(DEST_KEYWORDS)) if (d.includes(k) || k.includes(d)) return DEST_KEYWORDS[k];
  return [d];
}

// ── أدوات نصية ───────────────────────────────────────────────────────────────
const RESERVED_IG = new Set(["p","reel","reels","explore","accounts","stories","tv","about","legal","directory","developer","directory"]);

function validIgHandle(h: string): boolean {
  if (!h) return false;
  const low = h.toLowerCase();
  if (RESERVED_IG.has(low)) return false;
  if (/\.(php|html?|js|css|png|jpe?g|gif|svg|ico|json)$/i.test(h)) return false; // ملفات (مثل rsrc.php)
  if (low === "rsrc" || low.startsWith("rsrc")) return false;
  return true;
}
function extractInstagram(html: string): string | null {
  const re = /instagram\.com\/([A-Za-z0-9._]{2,30})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const h = m[1].replace(/\.$/, "");
    if (validIgHandle(h)) return h;
  }
  return null;
}
// المعرّف من رابط إنستقرام مباشرة (حين يكون «موقع» الشركة رابط إنستقرام).
function igFromUrl(u: string): string | null {
  try {
    const p = new URL(u);
    if (!/(^|\.)instagram\.com$/i.test(p.hostname.replace(/^www\./, ""))) return null;
    const seg = (p.pathname.split("/").filter(Boolean)[0] || "").replace(/\.$/, "");
    return validIgHandle(seg) ? seg : null;
  } catch { return null; }
}

function digitsOnly(s: string): string { return String(s || "").replace(/[^\d]/g, ""); }

// استخراج رقم واتساب من روابط الموقع: wa.me / api.whatsapp.com / whatsapp://send
function extractWhatsapp(html: string): string | null {
  const pats = [
    /(?:wa\.me|api\.whatsapp\.com\/send|whatsapp:\/\/send)[^\d+]*(?:phone=)?\+?(\d{8,15})/gi,
    /wa\.me\/\+?(\d{8,15})/gi,
  ];
  for (const re of pats) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const d = m[1];
      if (d && d.length >= 9 && d.length <= 15) return "+" + d;
    }
  }
  return null;
}

// تطبيع الاسم لكشف التكرار: حذف شركة/مؤسسة/ال/للسفر والسياحة والترقيم والرموز.
function normName(name: string): string {
  let s = String(name || "").toLowerCase();
  s = s.replace(/[ـ]/g, "");                       // تطويل
  s = s.replace(/[إأآا]/g, "ا").replace(/[ىي]/g, "ي").replace(/ة/g, "ه");
  s = s.replace(/\b(شركة|مؤسسة|مكتب|وكالة|for|travel|tourism|agency|co|company|est)\b/gi, " ");
  s = s.replace(/(للسفر|والسياحة|السياحة|السفر|للسياحة|والسفر)/g, " ");
  s = s.replace(/[^a-z0-9؀-ۿ]+/g, "");        // حذف رموز/مسافات/أرقام لاتينية وعربية غير الحروف
  s = s.replace(/[0-9٠-٩]/g, "");             // أرقام
  return s.trim();
}
function last9(phone: string): string { const d = digitsOnly(phone); return d.slice(-9); }

function domainOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

// تصنيف هاتف Places: mobile/landline/unknown + صيغة E.164.
function classifyPhone(intl: string, country: string): { type: string; e164: string } {
  const d = digitsOnly(intl);
  if (!d) return { type: "none", e164: "" };
  const e164 = "+" + d;
  const rule = PHONE_RULES[country];
  if (!rule || !d.startsWith(rule.cc)) return { type: "unknown", e164 };
  const nat = d.slice(rule.cc.length);
  const first = nat[0] || "";
  if (rule.landline.includes(first)) return { type: "landline", e164 };
  if (rule.mobile.includes(first)) return { type: "mobile", e164 };
  return { type: "unknown", e164 };
}

// ── جلب صفحات المواقع ────────────────────────────────────────────────────────
async function fetchText(url: string): Promise<{ url: string; html: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WEBSITE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AlezzDiscovery/1.0)", "Accept": "text/html,*/*" },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return null;
    const html = await res.text();
    return { url: res.url || url, html: html.slice(0, 600_000) };
  } catch { return null; } finally { clearTimeout(t); }
}

function absLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try {
      const u = new URL(href, base).toString();
      if (!/^https?:/i.test(u)) continue;
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    } catch { /* ignore */ }
  }
  return out;
}

// إثراء موقع شركة واحدة: إنستقرام + واتساب من الموقع + فلتر الوجهة (حد 4 صفحات).
async function enrichSite(websiteUri: string, destKw: string[]): Promise<{
  instagram: string | null; whatsappSite: string | null; destMatch: boolean; destEvidence: string | null;
}> {
  const res = { instagram: null as string | null, whatsappSite: null as string | null, destMatch: false, destEvidence: null as string | null };
  if (!websiteUri) return res;
  // إذا كان «الموقع» رابط إنستقرام/فيسبوك: خذ المعرّف من الرابط ولا تجلب الصفحة (تعطي رموزاً لا معرّفات).
  const whost = (domainOf(websiteUri) || "");
  if (/(^|\.)instagram\.com$/i.test(whost) || /(^|\.)facebook\.com$/i.test(whost)) {
    res.instagram = igFromUrl(websiteUri);
    return res;
  }
  const home = await fetchText(websiteUri);
  if (!home) return res;
  let text = home.html;
  res.instagram = extractInstagram(home.html);
  res.whatsappSite = extractWhatsapp(home.html);

  const links = absLinks(home.html, home.url);
  const homeHost = domainOf(home.url);
  const sameHost = (u: string) => domainOf(u) === homeHost;               // ابقَ داخل الموقع
  const contact = links.find((l) => sameHost(l) && /اتصل|تواصل|contact|call-?us/i.test(l));
  const offers = destKw.length
    ? links.filter((l) => sameHost(l) && /عروض|باقات|وجهات|رحلات|packages?|offers?|deals?|destinations?|tours?/i.test(l))
    : [];
  const extra: string[] = [];
  if (contact) extra.push(contact);
  extra.push(...offers);
  const uniqExtra = Array.from(new Set(extra)).filter((u) => u !== home.url).slice(0, MAX_PAGES_PER_SITE - 1);

  for (const u of uniqExtra) {
    const p = await fetchText(u);
    if (!p) continue;
    if (!res.instagram) res.instagram = extractInstagram(p.html);
    if (!res.whatsappSite) res.whatsappSite = extractWhatsapp(p.html);
    text += "\n" + p.html;
  }
  if (destKw.length) {
    const hit = destKw.find((k) => text.toLowerCase().includes(k.toLowerCase()));
    if (hit) { res.destMatch = true; res.destEvidence = hit; }
  }
  return res;
}

// تشغيل دفعة بتزامن محدود.
async function pool<T>(items: T[], size: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// ── Google Places (New) — صفحة واحدة ─────────────────────────────────────────
async function placesPage(apiKey: string, textQuery: string, regionCode: string, pageToken?: string): Promise<{ places: any[]; nextPageToken: string | null }> {
  const body: any = { textQuery, languageCode: "ar", regionCode, pageSize: 20 };
  if (pageToken) body.pageToken = pageToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify(body),
    });
    if (res.ok) { const j = await res.json(); return { places: j.places || [], nextPageToken: j.nextPageToken || null }; }
    // pageToken أحياناً يحتاج لحظة قبل أن يصبح صالحاً.
    if (res.status === 400 && pageToken && attempt === 0) { await sleep(1600); continue; }
    const errTxt = await res.text();
    throw new Error(`Places ${res.status}: ${errTxt.slice(0, 300)}`);
  }
  return { places: [], nextPageToken: null };
}

// ── معالجة استعلام واحد (مدينة × كلمة) ───────────────────────────────────────
async function runQuery(
  supabase: any, apiKey: string, job: any, city: string, keyword: string,
  seen: { names: Set<string>; domains: Set<string>; insta: Set<string> }, remaining: number,
): Promise<{ found: number; inserted: number; duplicates: number }> {
  const country: string = job.params.country;
  const destKw: string[] = job.params.destination ? destKeywordsFor(job.params.destination) : [];
  const textQuery = `${keyword} ${city}`;
  const label = `${city} × ${keyword}`;

  // 1) اجمع نتائج Places (حتى 60)، وتوقّف مبكراً عند بلوغ المتبقّي من الهدف.
  let raw: any[] = [];
  let token: string | undefined = undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { places, nextPageToken } = await placesPage(apiKey, textQuery, country, token);
    raw.push(...places);
    if (!nextPageToken) break;
    if (remaining > 0 && raw.length >= remaining) break; // لا تجلب صفحات زائدة عن الحاجة
    token = nextPageToken;
  }
  // احترم العدد المطلوب بدقّة (يقلّل استهلاك الـAPI وإثراء المواقع).
  if (remaining > 0 && raw.length > remaining) raw = raw.slice(0, remaining);

  // 2) أثرِ المواقع بتزامن 5.
  const enriched = new Array(raw.length);
  await pool(raw, WEBSITE_CONCURRENCY, async (pl, idx) => {
    const web = pl.websiteUri || "";
    enriched[idx] = web ? await enrichSite(web, destKw) : { instagram: null, whatsappSite: null, destMatch: false, destEvidence: null };
  });

  // 3) ابنِ الصفوف + أزل التكرار (اسم مطبّع+آخر9 / نطاق / إنستقرام).
  const rows: any[] = [];
  let dupInMem = 0;
  for (let i = 0; i < raw.length; i++) {
    const pl = raw[i]; const e = enriched[i];
    const name = pl.displayName?.text || "";
    const website = pl.websiteUri || null;
    const domain = website ? domainOf(website) : null;
    const cls = classifyPhone(pl.internationalPhoneNumber || "", country);

    let whatsapp_number: string | null = null, whatsapp_confidence: string | null = null, whatsapp_source: string | null = null, phone_landline: string | null = null;
    if (e.whatsappSite) { whatsapp_number = e.whatsappSite; whatsapp_confidence = "confirmed"; whatsapp_source = "website"; }
    else if (cls.type === "mobile") { whatsapp_number = cls.e164; whatsapp_confidence = "likely"; whatsapp_source = "places_mobile"; }
    else if (cls.type === "landline" || cls.type === "unknown") { phone_landline = cls.e164; }
    // ملاحظة: «unknown» = رقم داخل دولة معروفة لكنه ليس بادئة جوال (أرضي/موحّد 9200/800) → يُستبعَد من الواتساب.

    const nn = normName(name);
    const l9 = last9(whatsapp_number || phone_landline || "");
    const nameKey = nn ? `${nn}|${l9}` : "";
    const igKey = e.instagram ? e.instagram.toLowerCase() : "";

    // كشف التكرار داخل هذه المهمة.
    if ((nameKey && seen.names.has(nameKey)) || (domain && seen.domains.has(domain)) || (igKey && seen.insta.has(igKey))) { dupInMem++; continue; }
    if (nameKey) seen.names.add(nameKey);
    if (domain) seen.domains.add(domain);
    if (igKey) seen.insta.add(igKey);

    rows.push({
      job_id: job.id, place_id: pl.id, name, name_normalized: nn,
      website, domain, whatsapp_number, whatsapp_confidence, whatsapp_source, phone_landline,
      instagram_handle: e.instagram, city, country,
      destination_match: e.destMatch, destination_evidence: e.destEvidence,
      source_query: label, status: "new",
    });
  }

  // 4) أدخل (place_id فريد → تجاهل المكرر عبر الدفعات السابقة).
  let insertedCount = 0;
  if (rows.length) {
    const { data, error } = await supabase.from("discovered_companies")
      .upsert(rows, { onConflict: "place_id", ignoreDuplicates: true }).select("place_id");
    if (error) throw new Error("insert: " + error.message);
    insertedCount = (data || []).length;
  }
  const duplicates = dupInMem + (rows.length - insertedCount);
  return { found: raw.length, inserted: insertedCount, duplicates };
}

// تكمِلة ذاتية: تستدعي resume على نفس الدالة (الذي يجدول دفعة جديدة ويرجع فوراً)،
// فتتسلسل الدفعات تلقائياً بلا تداخل وبلا حاجة لمُستأنِف خارجي.
async function scheduleResume(jobId: string): Promise<void> {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const url = `${base}/functions/v1/companies-discovery?action=resume`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = (Deno.env.get("DISCOVERY_KEY") || "").trim();
  if (key) headers["x-admin-secret"] = key;
  try { await fetch(url, { method: "POST", headers, body: JSON.stringify({ job: jobId }) }); } catch (_) { /* الواجهة تستأنف احتياطياً */ }
}

// ── دفعة خلفية قابلة للاستئناف ────────────────────────────────────────────────
async function runBatch(supabase: any, apiKey: string, jobId: string): Promise<void> {
  const t0 = Date.now();
  let processed = 0;
  try {
    while (true) {
      const { data: job } = await supabase.from("discovery_jobs").select("*").eq("id", jobId).single();
      if (!job || job.status !== "running") return;
      const queue: any[] = job.queue || [];
      if (job.cursor >= queue.length) { await supabase.from("discovery_jobs").update({ status: "done", current_label: "اكتمل", updated_at: new Date().toISOString() }).eq("id", jobId); return; }
      if (job.inserted >= job.target) { await supabase.from("discovery_jobs").update({ status: "done", current_label: `اكتمل — بلغ الهدف ${job.target}`, updated_at: new Date().toISOString() }).eq("id", jobId); return; }
      if (processed >= BATCH_QUERIES || (Date.now() - t0) > BATCH_MS) { await scheduleResume(jobId); return; } // انتهت الدفعة — تُكمِل نفسها

      const { city, keyword } = queue[job.cursor];
      await supabase.from("discovery_jobs").update({ current_label: `${city} × ${keyword}`, updated_at: new Date().toISOString() }).eq("id", jobId);

      // حمّل مفاتيح التكرار الحالية لهذه المهمة.
      const seen = { names: new Set<string>(), domains: new Set<string>(), insta: new Set<string>() };
      const { data: existing } = await supabase.from("discovered_companies")
        .select("name_normalized,whatsapp_number,phone_landline,domain,instagram_handle").eq("job_id", jobId);
      for (const r of existing || []) {
        const nk = r.name_normalized ? `${r.name_normalized}|${last9(r.whatsapp_number || r.phone_landline || "")}` : "";
        if (nk) seen.names.add(nk);
        if (r.domain) seen.domains.add(r.domain);
        if (r.instagram_handle) seen.insta.add(r.instagram_handle.toLowerCase());
      }

      let res = { found: 0, inserted: 0, duplicates: 0 };
      const remaining = Math.max(0, job.target - job.inserted);
      try { res = await runQuery(supabase, apiKey, job, city, keyword, seen, remaining); }
      catch (e) { await supabase.from("discovery_jobs").update({ error: `${city}×${keyword}: ${String(e).slice(0, 200)}`, updated_at: new Date().toISOString() }).eq("id", jobId); }

      // تقدّم ذرّي: قدّم المؤشر واجمع العدادات (شرط بقاء المؤشر كما هو لتفادي التسابق).
      await supabase.from("discovery_jobs").update({
        cursor: job.cursor + 1,
        found: job.found + res.found,
        inserted: job.inserted + res.inserted,
        duplicates: job.duplicates + res.duplicates,
        updated_at: new Date().toISOString(),
      }).eq("id", jobId).eq("cursor", job.cursor);
      processed++;
    }
  } catch (e) {
    await supabase.from("discovery_jobs").update({ status: "error", error: String(e).slice(0, 300), updated_at: new Date().toISOString() }).eq("id", jobId);
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // بوابة اختيارية.
  const gate = (Deno.env.get("DISCOVERY_KEY") || "").trim();
  if (gate) {
    const given = (req.headers.get("x-admin-secret") || "").trim();
    if (given !== gate) return json({ ok: false, error: "unauthorized" }, 401);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const apiKey = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  try {
    if (action === "start") {
      if (!apiKey) return json({ ok: false, error: "مفتاح Google Places غير مضبوط (GOOGLE_PLACES_API_KEY)" }, 400);
      const b = await req.json().catch(() => ({}));
      const country = String(b.country || "SA").toUpperCase();
      if (!COUNTRY_CITIES[country]) return json({ ok: false, error: "دولة غير مدعومة" }, 400);
      const keywords: string[] = Array.isArray(b.keywords) && b.keywords.length ? b.keywords : DEFAULT_KEYWORDS;
      let cities: string[];
      if (b.scope === "specific" && Array.isArray(b.cities) && b.cities.length) cities = b.cities.map((c: string) => String(c).trim()).filter(Boolean);
      else cities = COUNTRY_CITIES[country];
      const target = Math.max(1, Math.min(5000, parseInt(b.target) || 500));
      const destination = String(b.destination || "").trim();

      const queue: any[] = [];
      for (const city of cities) for (const keyword of keywords) queue.push({ city, keyword });

      const { data: job, error } = await supabase.from("discovery_jobs").insert({
        params: { country, activity: b.activity || "travel", scope: b.scope || "all", cities, destination, target, keywords },
        queue, target, status: "running", current_label: "يبدأ…",
      }).select("id").single();
      if (error) return json({ ok: false, error: error.message }, 500);

      // شغّل أول دفعة بالخلفية وارجع فوراً.
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(runBatch(supabase, apiKey, job.id));
      return json({ ok: true, job_id: job.id, queue_len: queue.length });
    }

    if (action === "resume") {
      if (!apiKey) return json({ ok: false, error: "مفتاح Google Places غير مضبوط" }, 400);
      const b = await req.json().catch(() => ({}));
      const jobId = b.job || url.searchParams.get("job");
      if (!jobId) return json({ ok: false, error: "job مطلوب" }, 400);
      const { data: job } = await supabase.from("discovery_jobs").select("id,status").eq("id", jobId).single();
      if (!job) return json({ ok: false, error: "المهمة غير موجودة" }, 404);
      if (job.status !== "running") return json({ ok: true, note: "not running", status: job.status });
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(runBatch(supabase, apiKey, jobId));
      return json({ ok: true, resumed: true });
    }

    if (action === "status") {
      const jobId = url.searchParams.get("job");
      if (!jobId) return json({ ok: false, error: "job مطلوب" }, 400);
      const { data: job } = await supabase.from("discovery_jobs").select("*").eq("id", jobId).single();
      if (!job) return json({ ok: false, error: "المهمة غير موجودة" }, 404);
      const queueLen = (job.queue || []).length;
      return json({ ok: true, status: job.status, cursor: job.cursor, queue_len: queueLen,
        found: job.found, inserted: job.inserted, duplicates: job.duplicates, target: job.target,
        current_label: job.current_label, error: job.error, updated_at: job.updated_at });
    }

    if (action === "results") {
      const jobId = url.searchParams.get("job");
      const onlyDest = url.searchParams.get("only_dest") === "1";
      let q = supabase.from("discovered_companies").select("*");
      if (jobId) q = q.eq("job_id", jobId);
      if (onlyDest) q = q.eq("destination_match", true);
      // confirmed قبل likely، ثم الأحدث.
      q = q.order("whatsapp_confidence", { ascending: true }).order("created_at", { ascending: false }).limit(2000);
      const { data, error } = await q;
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, rows: data || [] });
    }

    if (action === "stop") {
      const b = await req.json().catch(() => ({}));
      const jobId = b.job || url.searchParams.get("job");
      if (!jobId) return json({ ok: false, error: "job مطلوب" }, 400);
      await supabase.from("discovery_jobs").update({ status: "stopped", updated_at: new Date().toISOString() }).eq("id", jobId);
      return json({ ok: true });
    }

    if (action === "reset") {
      // يمسح كل نتائج/مهام الاكتشاف (بيانات عامة قابلة لإعادة التوليد — لا يمسّ أي جدول آخر).
      await supabase.from("discovered_companies").delete().gte("id", 0);
      await supabase.from("discovery_jobs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      return json({ ok: true, reset: true });
    }

    if (action === "active") {
      // آخر مهمة قيد التشغيل (لاستئناف تلقائي عند فتح الصفحة).
      const { data } = await supabase.from("discovery_jobs").select("id,status,updated_at").eq("status", "running").order("created_at", { ascending: false }).limit(1);
      return json({ ok: true, job: (data && data[0]) || null });
    }

    return json({ ok: false, error: "action غير معروف" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 300) }, 500);
  }
});
