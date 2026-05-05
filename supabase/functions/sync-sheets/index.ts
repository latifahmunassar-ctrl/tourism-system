/**
 * sync-sheets — تزامن بيانات Google Sheets مع Supabase
 *
 * يقرأ من التبويبات: روسيا | البوسنه | تركيا | فيتنام | اندونيسيا
 *
 * تنسيق الفنادق المتوقع في كل تبويبة:
 *   Hotel | City | Stars(1-5) | Room type | [Note] | From | To | Rate | Include | Currency
 *
 * تنسيق الجولات — ثلاثة أشكال تُكتشف تلقائياً:
 *   تركيا  : header "may month | june month | currency" → col0=اسم | col1=سعر | col3=عملة
 *   فيتنام : header "pax 1-3"                           → col0=اسم | col2=سعر
 *   اندونيسيا: header "tour fees | 1-4 pax"             → col2=اسم | col3=سعر | col6=عملة
 *
 * Supabase Secrets المطلوبة:
 *   GOOGLE_SERVICE_ACCOUNT   → ملف JSON لحساب الخدمة
 *   GOOGLE_SPREADSHEET_ID    → معرّف جدول البيانات
 *   SYNC_SECRET              → (اختياري) لحماية الـ endpoint
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

const DESTINATION_TABS = ["russia", "Bosnia", "Turky", "vietnam", "indonesia"];

const HOTEL_HEADER_KEYWORDS = [
  "hotel", "city", "star", "room", "rate", "include",
  "currency", "from", "to", "note", "no_header", "sr",
  "country", "packages", "tour", "برنامج", "عرض",
];

// ── Google Service Account JWT ─────────────────────────────────────────────
async function getGoogleAccessToken(serviceAccount: {
  client_email: string;
  private_key: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const header  = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iss:   serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now,
  });

  const signingInput = `${header}.${payload}`;

  const pem = serviceAccount.private_key.replace(/\\n/g, "\n");
  const keyBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryKey = Uint8Array.from(atob(keyBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const rawSig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(rawSig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${sig}`,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`فشل تسجيل الدخول إلى Google: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

// ── قراءة نطاق من Google Sheets ───────────────────────────────────────────
async function readSheetRange(
  token: string,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.error) throw new Error(`Sheets API [${range}]: ${data.error.message}`);
  return data.values || [];
}

// ── تنظيف نص العملة ───────────────────────────────────────────────────────
function cleanCurrency(raw: string): string {
  const cleaned = (raw || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3);
  return cleaned || "SAR";
}

// ── تنظيف رقم السعر ───────────────────────────────────────────────────────
function parsePrice(raw: string): number {
  return parseFloat((raw || "").replace(/,/g, "").replace(/[^\d.]/g, ""));
}

// ── استخراج الفنادق من صفوف التبويبة ─────────────────────────────────────
//
// نعتمد على *أسماء الأعمدة* في صف الـ header، لا على مواقعها — لأن ترتيب
// الأعمدة يختلف بين تبويبات الوجهات (تركيا، روسيا، إندونيسيا...).
// نبحث عن أوّل صف يحتوي على "hotel" + "city" + "star" كخلايا مفردة،
// ثم نبني خريطة { name → colIndex } للحقول التي نحتاجها.

const HEADER_ALIASES: Record<string, RegExp> = {
  name:       /^(hotel|hotels|hotel\s*name|الفندق|اسم\s*الفندق)$/i,
  city:       /^(city|المدينة|المدينه)$/i,
  stars:      /^(star|stars|rating|نجوم|تصنيف)$/i,
  room:       /^(room|room\s*type|الغرفة|نوع\s*الغرفة)$/i,
  rate:       /^(rate|price|nightly|night\s*rate|سعر|السعر|تكلفة|التكلفة)$/i,
  currency:   /^(currency|عملة|العملة)$/i,
  occupancy:  /^(occupancy|capacity|pax|اشغال|الإشغال|اشخاص|الأشخاص|استيعاب)$/i,
  include:    /^(include|includes|breakfast|meals|شامل|يشمل|الإفطار)$/i,
};

function findHotelHeader(rows: string[][]): { rowIdx: number; cols: Record<string, number> } | null {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(x => (x || "").trim());
    const map: Record<string, number> = {};
    for (let j = 0; j < cells.length; j++) {
      const cell = cells[j];
      if (!cell) continue;
      for (const [field, pattern] of Object.entries(HEADER_ALIASES)) {
        if (map[field] === undefined && pattern.test(cell)) {
          map[field] = j;
        }
      }
    }
    // Header row must have at least name + city + stars + rate
    if (map.name !== undefined && map.city !== undefined && map.stars !== undefined && map.rate !== undefined) {
      return { rowIdx: i, cols: map };
    }
  }
  return null;
}

function extractHotels(rows: string[][], destination: string, debug?: { rejects: string[] }): object[] {
  const hotels: object[] = [];
  const reject = (i: number, reason: string, row: string[]) =>
    debug?.rejects.push(`[${destination} row ${i}] ${reason} | raw: ${JSON.stringify(row.slice(0, 15))}`);

  const header = findHotelHeader(rows);
  if (!header) {
    debug?.rejects.push(`[${destination}] no hotel header found (need cells: hotel + city + star + rate)`);
    return hotels;
  }
  debug?.rejects.push(`[${destination}] header at row ${header.rowIdx}, columns: ${JSON.stringify(header.cols)}`);

  const get = (row: string[], field: string): string => {
    const idx = header.cols[field];
    if (idx === undefined) return "";
    const val = row[idx];
    return (val ?? "").toString().trim();
  };

  for (let i = header.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i].map(x => (x || "").trim());

    const hotelName  = get(row, "name");
    const city       = get(row, "city");
    const starsRaw   = get(row, "stars");
    const roomType   = get(row, "room");
    const priceStr   = get(row, "rate");
    const includeStr = get(row, "include");
    const currencyStr = get(row, "currency");
    const occupancyStr = get(row, "occupancy");

    if (!hotelName || !city) { reject(i, `missing name or city`, row); continue; }
    // تجاهل صفوف الرأس المتكرّرة (نفس كلمات الـ header)
    if (HEADER_ALIASES.name.test(hotelName)) { reject(i, `header row repeat`, row); continue; }
    if (/^\d+$/.test(hotelName)) { reject(i, `name is just a number`, row); continue; }

    const stars = parseInt(starsRaw);
    if (isNaN(stars) || stars < 1 || stars > 5) { reject(i, `invalid stars '${starsRaw}'`, row); continue; }

    const price = parsePrice(priceStr);
    if (isNaN(price) || price <= 0) { reject(i, `invalid price '${priceStr}'`, row); continue; }

    hotels.push({
      name:               hotelName,
      stars,
      location:           `${city} - ${destination}`,
      price_per_night:    price,
      room_type:          roomType || "",
      includes_breakfast: /breakfast|إفطار/i.test(includeStr),
      currency:           cleanCurrency(currencyStr || "SAR"),
      occupancy:          occupancyStr,
      last_synced_at:     new Date().toISOString(),
    });
  }

  return hotels;
}

// ── استخراج الجولات من صفوف التبويبة ─────────────────────────────────────
//
// منطق header-based: نبحث عن صف يحتوي على عناوين أعمدة سعر مثل
// "1-3 Pax", "4-9 Pax", "may month", "june month", "pax 1-3"...
// عمود الاسم هو أيسر عمود سعر (أو يسبقه)، وعمود العملة إن وُجد بعدها.
// كل صف بيانات يُنتج tour واحدة فيها variants متعدّدة.

const PRICE_TIER_RE = /(\d+\s*-\s*\d+\s*pax|pax\s*\d+(\s*-\s*\d+)?|(jan|feb|mar|apr|may|jun(e)?|jul(y)?|aug|sep|oct|nov|dec)\w*\s*month|month|tour\s*fees?)/i;
const CURRENCY_RE   = /^(currency|عملة|العملة)$/i;

interface TourHeader {
  rowIdx:    number;
  nameCol:   number;
  priceCols: { col: number; label: string }[];
  currencyCol?: number;
}

function findTourHeader(rows: string[][]): TourHeader | null {
  // ابحث في أوّل 5 صفوف. اختر الصف صاحب أكبر عدد أعمدة أسعار
  // (يفضّل صفوف pax tiers مثل "1-3 Pax" و"4-9 Pax" على عناوين عامّة مثل "Tour Fees").
  const candidates: { i: number; priceCols: { col: number; label: string }[]; currencyCol?: number }[] = [];
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const cells = rows[i].map(x => (x || "").trim());
    const priceCols: { col: number; label: string }[] = [];
    let currencyCol: number | undefined;
    for (let j = 0; j < cells.length; j++) {
      const cell = cells[j];
      if (!cell) continue;
      if (CURRENCY_RE.test(cell) && currencyCol === undefined) {
        currencyCol = j;
      } else if (PRICE_TIER_RE.test(cell)) {
        priceCols.push({ col: j, label: cell });
      }
    }
    if (priceCols.length >= 1) candidates.push({ i, priceCols, currencyCol });
  }
  // رتّب: الأكثر أعمدة أسعار أولاً
  candidates.sort((a, b) => b.priceCols.length - a.priceCols.length);

  for (const cand of candidates) {
    const { i, priceCols, currencyCol } = cand;
    {
      const firstPriceCol = priceCols[0].col;
      // عمود الاسم: لكل عمود < firstPriceCol، احسب كم صف يحوي نصّاً غير رقمي.
      // العمود الأكثر "نصّاً عربي/أحرف" هو عمود الاسم.
      // (يتجاوز عناوين زائدة مثل "per pax" وأعمدة الأسعار الإضافية مثل "100").
      const sample = Math.min(rows.length - i - 1, 25);
      let bestCol = 0, bestScore = -1;
      for (let c = 0; c < firstPriceCol; c++) {
        let textCount = 0;
        for (let r = i + 1; r < i + 1 + sample; r++) {
          const v = (rows[r]?.[c] || "").trim();
          if (!v) continue;
          // نصّ غير رقمي = يحوي حرفاً عربياً أو لاتينياً (وليس رقماً فقط)
          if (/[؀-ۿa-zA-Z]/.test(v)) textCount++;
        }
        if (textCount > bestScore) { bestScore = textCount; bestCol = c; }
      }
      return { rowIdx: i, nameCol: bestCol, priceCols, currencyCol };
    }
  }
  return null;
}

function extractTours(rows: string[][], destination: string, debug?: { rejects: string[] }): object[] {
  const tours: object[] = [];
  const seen = new Set<string>();

  const header = findTourHeader(rows);
  if (!header) {
    debug?.rejects.push(`[${destination}] no tour header found`);
    return tours;
  }
  debug?.rejects.push(
    `[${destination}] tour header at row ${header.rowIdx}: name=col${header.nameCol}, ` +
    `prices=[${header.priceCols.map(p => `col${p.col}('${p.label}')`).join(",")}], ` +
    `currency=${header.currencyCol ?? "default"}`
  );

  for (let i = header.rowIdx + 1; i < rows.length; i++) {
    const row  = rows[i].map(x => (x || "").trim());
    const name = row[header.nameCol] || "";
    if (!name) continue;
    // تخطّي صفوف تبدو كرؤوس أقسام أخرى
    if (/^hotel(s)?$/i.test(name)) break; // وصلنا قسم الفنادق
    if (PRICE_TIER_RE.test(name)) continue; // header آخر متكرّر

    const variants = header.priceCols
      .map(({ col, label }) => {
        const p = parsePrice(row[col] || "");
        if (isNaN(p) || p <= 0) return null;
        return { label, price: p };
      })
      .filter((v): v is { label: string; price: number } => v !== null);

    if (variants.length === 0) continue;

    const currency = cleanCurrency(
      (header.currencyCol !== undefined ? row[header.currencyCol] : "") || "SAR"
    );

    // تجنّب التكرار: إذا نفس الاسم وُجد بنفس variants
    const key = `${name}|${variants.map(v => `${v.label}:${v.price}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    tours.push({
      name,
      type:           destination,
      price:          variants[0].price, // legacy: أوّل سعر كافتراضي
      currency,
      description:    name,
      variants:       variants.map(v => ({ ...v, currency })),
      last_synced_at: new Date().toISOString(),
    });
  }

  return tours;
}

// ── استخراج الطيران من صفوف التبويبة ──────────────────────────────────────
//
// نبحث عن header يحتوي عمودين متجاورين بعنوان "from"/"to" (مع كلمة flight)
// + عمود قريب لسعر الشخص (price per pax / price/pax / per pax).
// السعر دائماً للشخص الواحد ويُضرب في عدد الأشخاص لاحقاً في Tourism-AI.
function extractFlights(rows: string[][], destination: string, debug?: { rejects: string[] }): object[] {
  const flights: object[] = [];

  // Find a row containing flight column labels.
  // قد تظهر "From"/"To" مرّتين في نفس الصف (مرّة لتواريخ الفنادق ومرّة للطيران)،
  // لذلك نجمع كل المرشّحين ثم نختار الثلاثيّة المتقاربة بالأعمدة.
  const FROM_RE  = /^(flight\s*)?from$|^من$/i;
  const TO_RE    = /^(flight\s*)?to$|^الى$|^إلى$/i;
  const PRICE_RE = /(^|\s)(price\s*)?per\s*pax|^pax\s*price$|سعر\s*الشخص|سعر\s*للشخص/i;

  let header: { fromCol: number; toCol: number; priceCol: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(x => (x || "").trim().toLowerCase());
    const froms: number[]  = [];
    const tos: number[]    = [];
    const prices: number[] = [];
    for (let j = 0; j < cells.length; j++) {
      if (!cells[j]) continue;
      if (FROM_RE.test(cells[j]))  froms.push(j);
      if (TO_RE.test(cells[j]))    tos.push(j);
      if (PRICE_RE.test(cells[j])) prices.push(j);
    }
    // اختر ثلاثيّة (from, to, price) كلّها متقاربة (within 4 cols)
    for (const f of froms) {
      for (const t of tos) {
        if (t <= f || t - f > 2) continue;
        for (const p of prices) {
          if (p <= t || p - t > 3) continue;
          header = { fromCol: f, toCol: t, priceCol: p };
          break;
        }
        if (header) break;
      }
      if (header) break;
    }
    if (header) {
      debug?.rejects.push(`[${destination}] flight header at row ${i}: from=col${header.fromCol}, to=col${header.toCol}, price=col${header.priceCol}`);
      break;
    }
  }
  if (!header) {
    debug?.rejects.push(`[${destination}] no flight header found`);
    return flights;
  }

  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const from = (row[header.fromCol] || "").trim();
    const to   = (row[header.toCol]   || "").trim();
    const priceStr = (row[header.priceCol] || "").trim();
    if (!from || !to || !priceStr) continue;
    if (/^flight/i.test(from) || /^flight/i.test(to)) continue; // skip header repeats

    const price = parsePrice(priceStr);
    if (isNaN(price) || price <= 0) continue;

    const key = `${from}|${to}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    flights.push({
      from_city:      from,
      to_city:        to,
      price_per_pax:  price,
      currency:       "SAR",
      destination,
      last_synced_at: new Date().toISOString(),
    });
  }
  return flights;
}

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

  // التحقق من الـ secret
  const syncSecret = Deno.env.get("SYNC_SECRET");
  if (syncSecret) {
    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${syncSecret}`) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: CORS_HEADERS }
      );
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const startTime = Date.now();
  const details: Record<string, { hotels: number; tours: number; error?: string }> = {};
  const debugInfo = new URL(req.url).searchParams.get("debug") === "1"
    ? { rejects: [] as string[] }
    : undefined;
  const dumpTab = new URL(req.url).searchParams.get("dump");

  try {
    const serviceAccount = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT")!);
    const spreadsheetId  = Deno.env.get("GOOGLE_SPREADSHEET_ID")!;
    const token          = await getGoogleAccessToken(serviceAccount);

    let totalHotels  = 0;
    let totalTours   = 0;
    let totalFlights = 0;

    for (const tab of DESTINATION_TABS) {
      try {
        const rows = await readSheetRange(token, spreadsheetId, `${tab}!A1:Z500`);

        // Optional dump for diagnostic
        if (dumpTab && tab.toLowerCase() === dumpTab.toLowerCase() && debugInfo) {
          rows.forEach((r, i) => {
            const nonEmpty = r.some(c => (c || '').trim());
            if (nonEmpty) debugInfo.rejects.push(`[${tab} DUMP row ${i}] ${JSON.stringify(r.slice(0, 26))}`);
          });
        }

        const hotels  = extractHotels(rows, tab, debugInfo);
        const tours   = extractTours(rows, tab, debugInfo);
        const flights = extractFlights(rows, tab, debugInfo);

        if (flights.length > 0) {
          const dedup = Array.from(
            new Map(flights.map((f: any) => [`${f.from_city}|${f.to_city}`, f])).values()
          );
          const { error } = await supabase.from("flights").upsert(dedup, { onConflict: "from_city,to_city,destination" });
          if (error) throw new Error(`طيران: ${error.message}`);
        }

        if (hotels.length > 0) {
          // إزالة التكرارات داخل نفس الـ batch (Postgres يرفض ON CONFLICT لنفس المفتاح مرّتين)
          const dedupedMap = new Map<string, object>();
          for (const h of hotels as Array<{ name: string; room_type: string; occupancy: string }>) {
            const key = `${h.name}|${h.room_type}|${h.occupancy}`;
            dedupedMap.set(key, h); // الأخير يفوز
          }
          const dedupedHotels = Array.from(dedupedMap.values());

          const { error } = await supabase
            .from("hotels")
            .upsert(dedupedHotels, { onConflict: "name,room_type,occupancy" });
          if (error) throw new Error(`فنادق: ${error.message}`);
        }

        if (tours.length > 0) {
          const { error } = await supabase
            .from("tours")
            .upsert(tours, { onConflict: "name,type" });
          if (error) throw new Error(`جولات: ${error.message}`);
        }

        details[tab] = { hotels: hotels.length, tours: tours.length, flights: flights.length };
        totalHotels  += hotels.length;
        totalTours   += tours.length;
        totalFlights += flights.length;

      } catch (tabError) {
        details[tab] = { hotels: 0, tours: 0, flights: 0, error: tabError.message };
      }
    }

    const duration = Date.now() - startTime;

    await supabase.from("sync_logs").insert({
      status:        "success",
      hotels_synced: totalHotels,
      tours_synced:  totalTours,
      duration_ms:   duration,
    });

    return new Response(
      JSON.stringify({ success: true, hotels: totalHotels, tours: totalTours, flights: totalFlights, details, duration_ms: duration, debug: debugInfo?.rejects }),
      { headers: CORS_HEADERS }
    );

  } catch (error) {
    const duration = Date.now() - startTime;

    await supabase.from("sync_logs").insert({
      status:        "error",
      hotels_synced: 0,
      tours_synced:  0,
      duration_ms:   duration,
      error_message: error.message,
    }).catch(() => {});

    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
});
