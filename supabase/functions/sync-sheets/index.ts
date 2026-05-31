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

const DESTINATION_TABS = ["russia", "Bosnia", "Turky", "vietnam", "indonesia", "thailand", "Malaysia"];

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

// ── ALEZZ Chat sheet sync (separate spreadsheet) ──────────────────────────
// Reads the FAQ-style answer sheet and upserts into chat_answers. Used by
// WhatsApp-Router for general inquiries. Keys: ID, Intent, Sub-intent,
// Keywords, sample Q, Answer_SA1, Answer_SA2, Answer clarification,
// Answer_OM, Status.
// deno-lint-ignore no-explicit-any
async function syncChatAnswers(supabase: any, token: string): Promise<{ upserted: number; deleted: number }> {
  const chatSheetId = Deno.env.get("ALEZZ_CHAT_SPREADSHEET_ID")
    || "1wBbUNMyZvYMFzxhw9CSVWZvnolMX_yzr13bUVfUxmYQ";

  // Single timestamp for the whole sync — rows we upsert get this stamped on
  // updated_at, so we can identify chat_answers rows that *weren't* refreshed
  // (i.e. were deleted from the sheet) and prune them.
  const syncTimestamp = new Date().toISOString();

  const rows = await readSheetRange(token, chatSheetId, "Sheet1!A1:K500");
  if (rows.length < 2) return { upserted: 0, deleted: 0 };

  const header = rows[0].map(h => String(h || "").trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name.toLowerCase());
  const cols = {
    id: idx("id"),
    intent: idx("intent"),
    sub: idx("sub-intent"),
    keywords: idx("keywords"),
    sample: idx("sample q"),
    sa1: idx("answer_sa1"),
    sa2: idx("answer_sa2"),
    clar: idx("answer clarification"),
    om: idx("answer_om"),
    status: idx("status"),
    stage: idx("stage"),   // NEW: customer-journey stage column
  };
  if (cols.id < 0) throw new Error("ALEZZ Chat: missing 'ID' column");

  const upserts: Array<Record<string, unknown>> = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id = String(row[cols.id] || "").trim();
    if (!id) continue;
    // Tokenise keywords. The sheet mixes separators — some cells use commas,
    // others list everything space-separated. Split on commas/newlines/slashes
    // first to preserve any deliberate multi-word phrases, then ALSO split
    // those phrases into individual words so short tokens (سعر, تكلفه) match
    // independently. Word-boundary matching in the router makes single-word
    // tokens safe from false positives.
    // Honour author intent for keyword cells:
    //   • If the cell contains commas/slashes/newlines, treat each piece
    //     between them as an intentional phrase — don't tokenise further.
    //     Multi-word phrases ("عندكم عروض") then match only when both words
    //     appear together, avoiding false positives.
    //   • If the cell has only whitespace separators (e.g. PKG0011's
    //     "دفع طريقه الدفع تحويل ..."), the author likely meant a word list —
    //     tokenise into individual words.
    const kwRaw = String(row[cols.keywords] || "").trim();
    const allTokens = new Set<string>();
    if (kwRaw) {
      const hasSeparators = /[,،\n\/]/.test(kwRaw);
      if (hasSeparators) {
        for (const p of kwRaw.split(/[,،\n\/]+/)) {
          const t = p.trim();
          if (t.length >= 3) allTokens.add(t);
        }
      } else {
        for (const w of kwRaw.split(/\s+/)) {
          const t = w.trim();
          if (t.length >= 3) allTokens.add(t);
        }
      }
    }
    const keywords = Array.from(allTokens);
    const rawStage = cols.stage >= 0 ? String(row[cols.stage] || "").trim().toUpperCase() : "";
    const STAGES = new Set(["INQUIRY","OFFER_SENT","BOOKING_IN_PROGRESS","BOOKING_CONFIRMED","TRAVELING","POST_TRAVEL"]);
    upserts.push({
      id,
      intent: String(row[cols.intent] || "").trim(),
      sub_intent: String(row[cols.sub] || "").trim(),
      keywords,
      sample_q: String(row[cols.sample] || "").trim(),
      answer_sa1: String(row[cols.sa1] || "").trim(),
      answer_sa2: String(row[cols.sa2] || "").trim(),
      answer_clarification: String(row[cols.clar] || "").trim(),
      answer_om: String(row[cols.om] || "").trim(),
      status: String(row[cols.status] || "").trim(),
      stage: STAGES.has(rawStage) ? rawStage : null,   // null = applies to ALL stages
      updated_at: syncTimestamp,
    });
  }

  if (upserts.length === 0) return { upserted: 0, deleted: 0 };
  // Composite key (id, sub_intent) because PKG001 has two sub-intents:
  // "General" and "Specific _Destination".
  const { error } = await supabase
    .from("chat_answers")
    .upsert(upserts, { onConflict: "id,sub_intent" });
  if (error) throw new Error(`chat_answers upsert: ${error.message}`);

  // Purge rows that exist in chat_answers but no longer in the sheet — they
  // weren't part of this sync's upsert, so their updated_at is still older
  // than syncTimestamp. This makes chat_answers a true mirror of the sheet
  // (an admin-deleted sheet row disappears from chat_answers on next sync).
  const { error: delErr, count: deleted } = await supabase
    .from("chat_answers")
    .delete({ count: "exact" })
    .lt("updated_at", syncTimestamp);
  if (delErr) throw new Error(`chat_answers prune: ${delErr.message}`);

  return { upserted: upserts.length, deleted: deleted ?? 0 };
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
  occupancy:  /^(occupancy|capacity|pax|اشغال|الإشغال|اشخاص|الأشخاص|استيعاب|تتسع|يتسع|سعة|تسع)$/i,
  include:    /^(include|includes|breakfast|meals|شامل|يشمل|الإفطار)$/i,
};

function findHotelHeader(rows: string[][]): { rowIdx: number; cols: Record<string, number> } | null {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(x => (x || "").trim());
    // Step 1: find the Hotel name column first.
    let nameCol = -1;
    for (let j = 0; j < cells.length; j++) {
      if (cells[j] && HEADER_ALIASES.name.test(cells[j])) {
        nameCol = j;
        break;
      }
    }
    if (nameCol < 0) continue;

    // Step 2: find every other field starting AT or AFTER nameCol — this prevents
    // tour-side columns (e.g. col 1 "المدينة" for tour city) from being mistaken
    // for the hotel block fields when the same alias appears twice in the row.
    const map: Record<string, number> = { name: nameCol };
    for (let j = nameCol; j < cells.length; j++) {
      const cell = cells[j];
      if (!cell) continue;
      for (const [field, pattern] of Object.entries(HEADER_ALIASES)) {
        if (field === "name") continue;
        if (map[field] === undefined && pattern.test(cell)) {
          map[field] = j;
        }
      }
    }
    // Header row must have at least name + city + stars + rate
    if (map.city !== undefined && map.stars !== undefined && map.rate !== undefined) {
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
    let city         = get(row, "city");
    const starsRaw   = get(row, "stars");
    const roomType   = get(row, "room");
    const priceStr   = get(row, "rate");
    let includeStr = get(row, "include");
    const currencyStr = get(row, "currency");
    let occupancyStr = get(row, "occupancy");
    // Fallback: many sheets accidentally put the "N adults + M child" value
    // in the `Include` column instead of the `تتسع`/occupancy one. If the
    // occupancy cell is blank but Include looks like an occupancy string
    // ("2 adults", "4 adults + 2 child"), promote it and clear the include
    // so meal info isn't polluted by it.
    if (!occupancyStr && /\d+\s*adults?/i.test(includeStr)) {
      occupancyStr = includeStr;
      includeStr = "";
    }

    if (!hotelName) { reject(i, `missing name`, row); continue; }

    // Fallback: if city empty, try to infer from hotel name (e.g. "Lady Hill Sapa Resort" → "Sapa")
    if (!city) {
      const KNOWN_CITIES = [
        "Sapa","Hanoi","Ha Noi","Halong","Ha Long","Da Nang","Danang","Hue","Hoi An",
        "Phu Quoc","Ho Chi Minh","Saigon","Nha Trang",
        "Bali","Jakarta","Bandung","Puncak","Ubud","Kuta","Seminyak","Jimbaran","Nusa Dua",
        "Istanbul","Trabzon","Uzungol","Bursa","Riza","Ayder","Şişli","Taksim","Sisli",
        "Moscow","St Petersburg","Saint Petersburg","Sochi",
        "Sarajevo","Mostar","Bihać","Bihac",
        "Bangkok","Krabi","Phuket","Chiang Mai","ChiangMai","Pattaya","Koh Samui","KohSamui","Samui",
        "Kuala Lumpur","KualaLumpur","KL","Langkawi","Penang","Cameron Highlands","Cameron","Highlands","Selangor",
      ];
      for (const c of KNOWN_CITIES) {
        if (new RegExp(`\\b${c}\\b`, "i").test(hotelName)) {
          city = c;
          break;
        }
      }
    }
    if (!city) { reject(i, `missing city (couldn't infer from name '${hotelName}')`, row); continue; }
    // تجاهل صفوف الرأس المتكرّرة (نفس كلمات الـ header)
    if (HEADER_ALIASES.name.test(hotelName)) { reject(i, `header row repeat`, row); continue; }
    if (/^\d+$/.test(hotelName)) { reject(i, `name is just a number`, row); continue; }

    const stars = parseInt(starsRaw);
    if (isNaN(stars) || stars < 1 || stars > 5) { reject(i, `invalid stars '${starsRaw}'`, row); continue; }

    const price = parsePrice(priceStr);
    if (isNaN(price) || price <= 0) { reject(i, `invalid price '${priceStr}'`, row); continue; }

    // ترجمة النص الإنجليزي لما يشمل الفندق إلى وصف عربي مختصر
    const mealsRaw = (includeStr || "").trim();
    const ml = mealsRaw.toLowerCase();
    let mealsAr = "";
    if (!mealsRaw) mealsAr = "";
    else if (/all\s*inclusive|all\s*meals|full\s*board|جميع\s*الوجبات/i.test(mealsRaw)) mealsAr = "جميع الوجبات (شامل)";
    else if (/half\s*board|نصف\s*إقامة/i.test(mealsRaw)) mealsAr = "إفطار + عشاء (نصف إقامة)";
    else if (/(break\s*fast|breakfast|إفطار).*(lunch|غداء)|(lunch|غداء).*(break\s*fast|breakfast|إفطار)/i.test(mealsRaw)) mealsAr = "إفطار + غداء";
    else if (/(break\s*fast|breakfast|إفطار).*(dinner|عشاء)|(dinner|عشاء).*(break\s*fast|breakfast|إفطار)/i.test(mealsRaw)) mealsAr = "إفطار + عشاء";
    else if (/no\s*break\s*fast|no\s*breakfast|بدون\s*إفطار/i.test(mealsRaw)) mealsAr = "بدون وجبات";
    else if (/break\s*fast|breakfast|إفطار/i.test(mealsRaw)) mealsAr = "إفطار مشمول";
    else mealsAr = mealsRaw; // fallback to raw text

    hotels.push({
      name:               hotelName,
      stars,
      location:           `${city} - ${destination}`,
      price_per_night:    price,
      room_type:          roomType || "",
      includes_breakfast: /break\s*fast|breakfast|إفطار/i.test(mealsRaw) && !/no\s*break\s*fast|no\s*breakfast|بدون\s*إفطار/i.test(mealsRaw),
      meals:              mealsAr,
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

const PRICE_TIER_RE = /(\d+\s*-\s*\d+\s*pax|pax\s*\d+(\s*-\s*\d+)?|per\s*pax|(jan|feb|mar|apr|may|jun(e)?|jul(y)?|aug|sep|oct|nov|dec)\w*\s*month|month|tour\s*fees?)/i;
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
    let { i, priceCols, currencyCol } = cand;
    // قصّر priceCols على المتقاربة (نطاق 7 أعمدة من أوّل عمود سعر)
    // لتجنّب التقاط أعمدة أخرى مثل "Price per pax" للطيران (تكون بعد ~20 عمود).
    const firstPriceCol0 = priceCols[0].col;
    priceCols = priceCols.filter(p => p.col - firstPriceCol0 <= 7);
    if (currencyCol !== undefined && (currencyCol - firstPriceCol0 > 10 || currencyCol < firstPriceCol0)) {
      currencyCol = undefined;
    }
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

    // العمود "sharing car per pax" يحوي رقم اليوم (1،2،3...) للسطور العاديّة،
    // ويحوي السعر الفعلي للشخص فقط للسطور المشتركة. لذا نتجاهله إلا إذا
    // اسم السطر فيه كلمة مشتركة/shared/ليموزين.
    const isSharedRow = /مشترك|shared|ليموزين/i.test(name);

    const variants = header.priceCols
      .map(({ col, label }) => {
        const isPerPaxLabel = /per\s*pax/i.test(label);
        if (isPerPaxLabel && !isSharedRow) return null; // skip per-pax for non-shared rows
        const raw = (row[col] || "").trim();
        if (!raw) return null;
        const p = parsePrice(raw);
        if (isNaN(p) || p < 0) return null;  // accept 0 (free tours/days)
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

// ── استخراج القطار من صفوف التبويبة ───────────────────────────────────────
// يبحث عن صف عنوان يحتوي كلمة مفتاحية (قطار / train / railway / …) ثم أعمدة
// From / To + سعر للشخص — نفس منطق الطيران لكن منفصل حتى لا يختلط بلوك الطيران.
const TRAIN_HEADER_HINT = /قطار|train|railway|\brail\b|سابسان|sapsan|bullet\s*train|قطارات/i;

function extractTrains(rows: string[][], destination: string, debug?: { rejects: string[] }): object[] {
  const trains: object[] = [];
  const FROM_RE = /^(flight\s*)?from$|^train\s*from$|^قطار\s*من$|^من$/i;
  const TO_RE = /^(flight\s*)?to$|^train\s*to$|^قطار\s*(?:الى|إلى)$|^الى$|^إلى$/i;
  const PRICE_RE = /(^|\s)(price\s*)?per\s*pax|^pax\s*price$|سعر\s*الشخص|سعر\s*للشخص/i;

  let header: { rowIdx: number; fromCol: number; toCol: number; priceCol: number } | null = null;

  for (let i = 0; i < rows.length; i++) {
    const rawCells = rows[i].map(x => (x ?? "").toString().trim());
    if (!TRAIN_HEADER_HINT.test(rawCells.join(" | "))) continue;

    const cells = rawCells.map(x => x.toLowerCase());
    const froms: number[] = [];
    const tos: number[] = [];
    const prices: number[] = [];
    for (let j = 0; j < cells.length; j++) {
      if (!cells[j]) continue;
      if (FROM_RE.test(cells[j])) froms.push(j);
      if (TO_RE.test(cells[j])) tos.push(j);
      if (PRICE_RE.test(cells[j])) prices.push(j);
    }
    for (const f of froms) {
      for (const t of tos) {
        if (t <= f || t - f > 2) continue;
        for (const p of prices) {
          if (p <= t || p - t > 3) continue;
          header = { rowIdx: i, fromCol: f, toCol: t, priceCol: p };
          break;
        }
        if (header) break;
      }
      if (header) break;
    }
    if (header) {
      debug?.rejects.push(
        `[${destination}] train header at row ${header.rowIdx}: from=col${header.fromCol}, to=col${header.toCol}, price=col${header.priceCol}`,
      );
      break;
    }
  }

  if (!header) {
    debug?.rejects.push(`[${destination}] no train header found`);
    return trains;
  }

  const seen = new Set<string>();
  for (let i = header.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const from = (row[header.fromCol] || "").trim();
    const to = (row[header.toCol] || "").trim();
    const priceStr = (row[header.priceCol] || "").trim();
    if (!from || !to || !priceStr) continue;
    if (/^flight|^train|^قطار/i.test(from) || /^flight|^train|^قطار/i.test(to)) continue;

    const price = parsePrice(priceStr);
    if (isNaN(price) || price <= 0) continue;

    const key = `${from}|${to}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    trains.push({
      from_city: from,
      to_city: to,
      price_per_pax: price,
      currency: "SAR",
      destination,
      last_synced_at: new Date().toISOString(),
    });
  }

  return trains;
}

// ── Package suggestions ────────────────────────────────────────────────────
// One free-form column per destination ("اقتراحات توزيع مدن") holding a
// stack of:
//   1. scope line     "اذا الوصول مطار X والمغدره مطار Y"
//   2. day header     "N أيام (label):"   ← optional label in parens
//   3. distribution   "2 هانوي + 3 سابا + ..."
// Pairs 2/3 alternate under whichever scope (1) was last seen. Returns rows
// ready for upsert into package_suggestions.
function extractSuggestions(
  rows: string[][],
  destination: string,
): Array<{
  destination: string;
  arrival_airport: string;
  departure_airport: string;
  days: number;
  label: string | null;
  distribution: string;
}> {
  // 1. Locate the column by header text. The header is on the same row as
  //    the hotels header (Vietnam: row 0). We search every row's cells for
  //    a header matching "اقتراحات".
  let colIdx = -1;
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    for (let j = 0; j < (rows[i] || []).length; j++) {
      const cell = (rows[i][j] || "").trim();
      if (/اقتراحات/.test(cell) && /(?:توزيع|مدن)/.test(cell)) {
        colIdx = j;
        headerRow = i;
        break;
      }
    }
    if (colIdx >= 0) break;
  }
  if (colIdx < 0) return [];

  // 2. Canonical airport from a free-form Arabic word. Just a small lookup
  //    table per destination — we only need the airports the agency actually
  //    flies into/out of, so a Vietnam-only map is fine.
  // Per-destination airport map. Each agency's authors spell airport names
  // differently in Arabic — we centralise the lookup so all destinations
  // get the same canonical English city names downstream.
  const AIRPORT_MAPS: Record<string, Record<string, string>> = {
    vietnam: {
      "هانوي": "Ha Noi", "هوتشي": "Ho Chi Minh",
      "دانانج": "Da Nang", "دانانغ": "Da Nang", "فوكوك": "Phu Quoc",
    },
    thailand: {
      "بانكوك": "Bangkok", "بانكوك ": "Bangkok",
      "بوكيت": "Phuket", "بوكت": "Phuket",
      "كرابي": "Krabi", "كوسوموي": "Koh Samui", "كوساموي": "Koh Samui",
    },
    Malaysia: {
      "كوالا": "Kuala Lumpur", "كوالالمبور": "Kuala Lumpur", "كوالامبور": "Kuala Lumpur",
      "بينانج": "Penang", "بينانغ": "Penang", "لانكاوي": "Langkawi",
      "سيلانجور": "Selangor", "كاميرون": "Cameron Highlands",
    },
  };
  const airportMap = AIRPORT_MAPS[destination] || {};
  const resolveAirport = (raw: string): string => {
    const t = raw.trim();
    for (const [ar, canonical] of Object.entries(airportMap)) {
      if (t.includes(ar.trim())) return canonical;
    }
    return t;
  };

  // Convert Arabic-Indic digits to ASCII so the digit-class in the regexes
  // below matches both '٧ ايام' and '7 ايام'. Authors mix the two freely.
  const toLatinDigits = (s: string) => s.replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));

  // 3. Walk down the column, maintaining current scope; pair each day-header
  //    with the next non-empty cell as the distribution.
  let arrival = "", departure = "";
  const out: Array<{ destination: string; arrival_airport: string; departure_airport: string; days: number; label: string | null; distribution: string }> = [];
  const SCOPE_RE = /الوصول\s+(?:مطار\s+)?(\S+)[\s\S]*?(?:المغدر[هةى]|المغادر[هةى])\s+(?:مطار\s+)?(\S+)/u;
  // Day header — three real-world shapes the agency uses:
  //   Vietnam style: "N أيام (label):"           ← colon-terminated, label in parens
  //   Thailand A:    "تايلاند.5.أيام."            ← dots between tokens, no colon
  //   Thailand B:    "٧ ايام تايلاند"             ← country name suffix, no colon
  // Match either "<N> ايام/يوم" OR "ايام/يوم <N>", strip the country word
  // and any non-paren cruft (dots, dashes) from the label. Dots between the
  // digit and 'ايام' are absorbed by the \s*[.\s]* allowance.
  const COUNTRY_WORDS = /(?:تايلاند|تيلاند|فيتنام|ماليزيا|البوسنه|البوسنة|تركيا|اندونيسيا|روسيا|ع[ُّ]?مان|دبي|الإمارات|الامارات)/u;
  const DAY_RE_DIGIT_FIRST = /(\d{1,2})[\s.]*(?:[أا]يام|يوم)([^:]*)(?::|$)/u;
  const DAY_RE_DIGIT_LAST  = /(?:[أا]يام|يوم)[\s.]*(\d{1,2})([^:]*)(?::|$)/u;
  let pendingDay: { days: number; label: string | null } | null = null;
  // Many sheets omit the scope line for single-airport destinations
  // (Thailand can be entered/left from any major hub). Use the per-
  // destination preferred hub as a sensible default when the scope is
  // implicit, so the suggestion still gets stored.
  const DEFAULT_AIRPORT: Record<string, string> = {
    vietnam:  "Ha Noi",
    thailand: "Bangkok",
    Malaysia: "Kuala Lumpur",
    Bosnia:   "Sarajevo",
    russia:   "Moscow",
    Turky:    "Istanbul",
    indonesia: "Jakarta",
  };
  for (let i = headerRow + 1; i < rows.length; i++) {
    const rawCell = (rows[i][colIdx] || "").trim();
    if (!rawCell) continue;
    const cell = toLatinDigits(rawCell);
    const scope = cell.match(SCOPE_RE);
    if (scope) {
      arrival   = resolveAirport(scope[1]);
      departure = resolveAirport(scope[2]);
      pendingDay = null;
      continue;
    }
    // Try digit-first then digit-last day-header shapes.
    let day = cell.match(DAY_RE_DIGIT_FIRST);
    if (!day) day = cell.match(DAY_RE_DIGIT_LAST);
    if (day) {
      // Clean the label: extract any parens groups; otherwise drop the
      // country name and structural punctuation (dots, dashes) and use what
      // remains as a free-form label. Multiple paren groups join with a
      // comma so the chat output reads naturally instead of " (a)( b)".
      let label: string | null = null;
      const raw = (day[2] || "").trim();
      if (raw) {
        const parts: string[] = [];
        const re2 = /\(([^)]*)\)/g;
        let m: RegExpExecArray | null;
        while ((m = re2.exec(raw)) !== null) {
          const piece = m[1].trim();
          if (piece) parts.push(piece);
        }
        if (parts.length > 0) {
          label = parts.join("، ");
        } else {
          const cleaned = raw
            .replace(COUNTRY_WORDS, "")
            .replace(/[.\-–—_]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          label = cleaned || null;
        }
      }
      pendingDay = { days: parseInt(day[1], 10), label };
      continue;
    }
    // Treat any other non-empty cell as the distribution for the pending day.
    // Fall back to the destination's preferred hub for both airports when no
    // scope line preceded the day-header — many sheets omit the line when
    // arrival and departure are the same single airport.
    if (pendingDay) {
      const hub = DEFAULT_AIRPORT[destination] || "";
      const arr = arrival || hub;
      const dep = departure || hub;
      if (arr && dep) {
        out.push({
          destination,
          arrival_airport: arr,
          departure_airport: dep,
          days: pendingDay.days,
          label: pendingDay.label,
          distribution: rawCell, // preserve original Arabic-Indic digits and separators
        });
      }
      pendingDay = null;
    }
  }
  return out;
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

  // ?dump_tours=DEST → return all tours for that destination as JSON (debug only)
  const dumpToursDest = new URL(req.url).searchParams.get("dump_tours");
  if (dumpToursDest) {
    const { data } = await supabase.from("tours").select("name,price,variants").eq("type", dumpToursDest);
    return new Response(JSON.stringify(data, null, 2), { headers: CORS_HEADERS });
  }

  // ?dump_suggestions=TAB → dump the raw "اقتراحات توزيع مدن" column for that
  // tab so we can see why extraction returned 0 rows. Reports the detected
  // header position + every non-empty cell below it.
  const dumpSuggTab = new URL(req.url).searchParams.get("dump_suggestions");
  if (dumpSuggTab) {
    try {
      const sa = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT")!);
      const ssid = Deno.env.get("GOOGLE_SPREADSHEET_ID")!;
      const tk = await getGoogleAccessToken(sa);
      const quotedTab = /[\s'"]/.test(dumpSuggTab) ? `'${dumpSuggTab.replace(/'/g, "''")}'` : dumpSuggTab;
      const rows = await readSheetRange(tk, ssid, `${quotedTab}!A1:AZ500`);
      let colIdx = -1, headerRow = -1, headerText = "";
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        for (let j = 0; j < (rows[i] || []).length; j++) {
          const cell = (rows[i][j] || "").trim();
          if (/اقتراحات/.test(cell) && /(?:توزيع|مدن)/.test(cell)) {
            colIdx = j; headerRow = i; headerText = cell;
            break;
          }
        }
        if (colIdx >= 0) break;
      }
      // Also dump column AL (index 37) regardless of header detection
      const colALCells: Array<{ row: number; text: string }> = [];
      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        const cell = (rows[i]?.[37] || "").trim();
        if (cell) colALCells.push({ row: i, text: cell });
      }
      // And column BA (index 52) — user said the Malaysia data is here
      const colBACells: Array<{ row: number; text: string }> = [];
      for (let i = 0; i < Math.min(rows.length, 30); i++) {
        const cell = (rows[i]?.[52] || "").trim();
        if (cell) colBACells.push({ row: i, text: cell });
      }
      // Dump the LAST few populated columns so we can see where the data
      // actually lives even when the user can't identify the right letter.
      const tailColumns: Record<string, Array<{ row: number; text: string }>> = {};
      const colsToDump = [44, 45, 46, 47, 48, 49, 50, 51, 52, 53];
      for (const c of colsToDump) {
        const arr: Array<{ row: number; text: string }> = [];
        for (let i = 0; i < rows.length; i++) {
          const cell = (rows[i]?.[c] || "").trim();
          if (cell) arr.push({ row: i, text: cell.slice(0, 200) });
        }
        if (arr.length > 0) tailColumns[`col_${c}`] = arr;
      }
      // And dump headers in row 0 to see all column labels
      const row0Headers: Array<{ col: number; text: string }> = [];
      for (let j = 0; j < (rows[0] || []).length; j++) {
        const cell = (rows[0][j] || "").trim();
        if (cell) row0Headers.push({ col: j, text: cell });
      }
      // Scan ALL rows × all columns for any cell containing "اقتراحات"
      const matchesAnywhere: Array<{ row: number; col: number; text: string }> = [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < (rows[i] || []).length; j++) {
          const cell = (rows[i][j] || "").trim();
          if (/اقتراحات/.test(cell)) {
            matchesAnywhere.push({ row: i, col: j, text: cell.slice(0, 120) });
          }
        }
      }
      // Also: total non-empty cells per column to find where data actually lives
      const colCounts = new Map<number, number>();
      let maxCol = 0;
      for (const row of rows) {
        if (!row) continue;
        if (row.length > maxCol) maxCol = row.length;
        for (let j = 0; j < row.length; j++) {
          if ((row[j] || "").trim()) colCounts.set(j, (colCounts.get(j) || 0) + 1);
        }
      }
      const colSummary: Array<{ col: number; count: number }> = [];
      for (const [c, n] of colCounts) colSummary.push({ col: c, count: n });
      colSummary.sort((a, b) => a.col - b.col);
      const totalRows = rows.length;
      const cells: Array<{ row: number; text: string }> = [];
      if (colIdx >= 0) {
        for (let i = headerRow + 1; i < rows.length; i++) {
          const cell = (rows[i][colIdx] || "").trim();
          if (cell) cells.push({ row: i, text: cell });
        }
      }
      return new Response(JSON.stringify({
        tab: dumpSuggTab, headerRow, colIdx, headerText, cellCount: cells.length, cells,
        extracted: colIdx >= 0 ? extractSuggestions(rows, dumpSuggTab) : [],
        colAL_first20: colALCells,
        colBA_first30: colBACells,
        row0Headers,
        matchesAnywhere,
        totalRowsRead: totalRows,
        nonEmptyColumns: colSummary,
        tailColumns,
      }, null, 2), { headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: CORS_HEADERS });
    }
  }

  // ?seed_malaysia=1 → seed Malaysia package_suggestions directly (bypass sheet)
  // Used as a one-shot when the employee can't get the suggestions column to
  // sync via Google Sheets (hidden columns, mode issues, etc.). Replaces all
  // Malaysia rows with the hard-coded set below. KL ↔ KL airport scope for all.
  if (new URL(req.url).searchParams.get("seed_malaysia") === "1") {
    const malaysia: Array<{ days: number; label: string | null; distribution: string }> = [
      { days: 6,  label: null,        distribution: "5 كوالالمبور" },
      { days: 7,  label: null,        distribution: "2 سيلانجور + 2 لانكاوي + 2 كوالالمبور" },
      { days: 8,  label: null,        distribution: "2 سيلانجور + 3 لانكاوي + 2 كوالالمبور" },
      { days: 9,  label: null,        distribution: "2 سيلانجور + 2 لانكاوي + 2 بينانج + 2 كوالالمبور" },
      { days: 10, label: null,        distribution: "2 سيلانجور + 3 لانكاوي + 2 بينانج + 2 كوالالمبور" },
      { days: 10, label: "الأرخص",    distribution: "2 سيلانجور + 3 لانكاوي + 4 كوالالمبور" },
      { days: 11, label: null,        distribution: "2 سيلانجور + 3 لانكاوي + 2 بينانج + 3 كوالالمبور" },
      { days: 12, label: null,        distribution: "2 سيلانجور + 3 لانكاوي + 3 بينانج + 3 كوالالمبور" },
      { days: 13, label: null,        distribution: "2 سيلانجور + 3 لانكاوي + 3 بينانج + 4 كوالالمبور" },
      { days: 14, label: null,        distribution: "2 سيلانجور + 4 لانكاوي + 3 بينانج + 4 كوالالمبور" },
      { days: 15, label: null,        distribution: "2 سيلانجور + 4 لانكاوي + 4 بينانج + 4 كوالالمبور" },
      { days: 15, label: "مع كاميرون هايلاند", distribution: "2 سيلانجور + 3 لانكاوي + 3 بينانج + 2 كاميرون هايلاند + 4 كوالالمبور" },
      { days: 16, label: null,        distribution: "2 سيلانجور + 4 لانكاوي + 3 بينانج + 2 كاميرون هايلاند + 4 كوالالمبور" },
    ];
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    await supabaseAdmin.from("package_suggestions").delete().eq("destination", "Malaysia");
    const rows = malaysia.map(s => ({
      destination: "Malaysia",
      arrival_airport: "Kuala Lumpur",
      departure_airport: "Kuala Lumpur",
      days: s.days,
      label: s.label,
      distribution: s.distribution,
    }));
    const { error } = await supabaseAdmin.from("package_suggestions").insert(rows);
    return new Response(JSON.stringify({
      ok: !error, error: error?.message || null, inserted: rows.length,
    }, null, 2), { headers: CORS_HEADERS });
  }

  // ?which_sheet=1 → report which spreadsheet ID the function is reading from
  if (new URL(req.url).searchParams.get("which_sheet") === "1") {
    let serviceAccountEmail: string | null = null;
    try {
      const sa = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT") || "{}");
      serviceAccountEmail = sa.client_email || null;
    } catch { /* ignore */ }
    return new Response(JSON.stringify({
      spreadsheetId: Deno.env.get("GOOGLE_SPREADSHEET_ID") || null,
      chatSpreadsheetId: Deno.env.get("ALEZZ_CHAT_SPREADSHEET_ID")
        || "1wBbUNMyZvYMFzxhw9CSVWZvnolMX_yzr13bUVfUxmYQ",
      serviceAccountEmail,
    }, null, 2), { headers: CORS_HEADERS });
  }

  // ?list_tabs=1 → return all tab names in the Google Spreadsheet (debug)
  if (new URL(req.url).searchParams.get("list_tabs") === "1") {
    try {
      const sa = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT")!);
      const ssid = Deno.env.get("GOOGLE_SPREADSHEET_ID")!;
      const tk = await getGoogleAccessToken(sa);
      const meta = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${ssid}?fields=sheets.properties`,
        { headers: { Authorization: `Bearer ${tk}` } }
      ).then(r => r.json());
      const tabs = (meta.sheets || []).map((s: { properties: { title: string; sheetId: number } }) => ({
        title: s.properties.title,
        gid: s.properties.sheetId,
      }));
      return new Response(JSON.stringify({ tabs, count: tabs.length }, null, 2), { headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: CORS_HEADERS });
    }
  }

  const startTime = Date.now();
  const details: Record<string, { hotels: number; tours: number; flights: number; trains: number; error?: string }> = {};
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
    let totalTrains  = 0;

    for (const tabRaw of DESTINATION_TABS) {
      // Tab in sheet may have trailing/leading whitespace (e.g. "thailand "),
      // but we want clean identifiers in DB ("thailand"). Use tabRaw to read
      // the sheet, tab (trimmed) for storage and grouping.
      const tab = tabRaw.trim();
      try {
        // Google Sheets requires single-quotes around tab names that contain
        // spaces or other special chars (e.g. 'Malaysia '!A1:Z500).
        const quotedTab = /[\s'"]/.test(tabRaw) ? `'${tabRaw.replace(/'/g, "''")}'` : tabRaw;
        const rows = await readSheetRange(token, spreadsheetId, `${quotedTab}!A1:AZ500`);

        // Optional dump for diagnostic — show ALL columns so we can see flight cols if present
        if (dumpTab && tab.toLowerCase() === dumpTab.toLowerCase() && debugInfo) {
          rows.forEach((r, i) => {
            const nonEmpty = r.some(c => (c || '').trim());
            if (nonEmpty) debugInfo.rejects.push(`[${tab} DUMP row ${i}] ${JSON.stringify(r)}`);
          });
        }

        const hotels  = extractHotels(rows, tab, debugInfo);
        const tours   = extractTours(rows, tab, debugInfo);
        const flights = extractFlights(rows, tab, debugInfo);
        const trains  = extractTrains(rows, tab, debugInfo);

        if (flights.length > 0) {
          const dedup = Array.from(
            new Map(flights.map((f: any) => [`${f.from_city}|${f.to_city}`, f])).values()
          );
          const { error } = await supabase.from("flights").upsert(dedup, { onConflict: "from_city,to_city,destination" });
          if (error) throw new Error(`طيران: ${error.message}`);
        }

        if (trains.length > 0) {
          const dedupT = Array.from(
            new Map(trains.map((t: any) => [`${t.from_city}|${t.to_city}`, t])).values()
          );
          const { error: trainErr } = await supabase
            .from("trains")
            .upsert(dedupT, { onConflict: "from_city,to_city,destination" });
          if (trainErr) throw new Error(`قطار: ${trainErr.message}`);
        }

        // dedup داخل batch + full-replace per destination (يحذف القديم ويُعيد المحدّث)
        const dedupedMap = new Map<string, object>();
        for (const h of hotels as Array<{ name: string; room_type: string; occupancy: string; location: string }>) {
          const key = `${h.name}|${h.room_type}|${h.occupancy}`;
          dedupedMap.set(key, h);
        }
        const dedupedHotels = Array.from(dedupedMap.values());

        // full-replace: delete by destination suffix in location field
        await supabase.from("hotels").delete().like("location", `% - ${tab}`);
        if (dedupedHotels.length > 0) {
          const { error } = await supabase.from("hotels").insert(dedupedHotels);
          if (error) throw new Error(`فنادق: ${error.message}`);
        }

        // dedup by (name, type) — last wins
        const dedupMap = new Map<string, object>();
        for (const t of tours as Array<{ name: string; type: string }>) {
          dedupMap.set(`${t.name}|${t.type}`, t);
        }
        const dedupedTours = Array.from(dedupMap.values());

        // FULL REPLACE: delete all tours for this destination first,
        // then insert fresh ones. This way removed/changed rows in
        // the sheet are reflected (no stale variants).
        await supabase.from("tours").delete().eq("type", tab);
        if (dedupedTours.length > 0) {
          const { error } = await supabase
            .from("tours")
            .insert(dedupedTours);
          if (error) throw new Error(`جولات: ${error.message}`);
        }

        // Package suggestions (column "اقتراحات توزيع مدن") — free-form
        // pre-canned distributions grouped by arrival/departure airport.
        const suggestions = extractSuggestions(rows, tab);
        await supabase.from("package_suggestions").delete().eq("destination", tab);
        if (suggestions.length > 0) {
          const { error } = await supabase.from("package_suggestions").insert(suggestions);
          if (error) debugInfo?.rejects.push(`[${tab}] suggestions insert: ${error.message}`);
        }

        details[tab] = { hotels: hotels.length, tours: tours.length, flights: flights.length, trains: trains.length, suggestions: suggestions.length };
        totalHotels  += hotels.length;
        totalTours   += tours.length;
        totalFlights += flights.length;
        totalTrains  += trains.length;

      } catch (tabError) {
        details[tab] = { hotels: 0, tours: 0, flights: 0, trains: 0, error: tabError.message };
      }
    }

    // ── ALEZZ Chat sheet → chat_answers (FAQ for WhatsApp-Router) ─────────
    // مزامنة منفصلة لأن ورقة الدردشة في spreadsheet آخر. تفشل بصمت لو
    // ALEZZ_CHAT_SPREADSHEET_ID مو مظبوط أو الورقة مو مشاركه مع service account.
    let chatAnswersSynced = 0;
    let chatAnswersDeleted = 0;
    let chatAnswersError: string | null = null;
    try {
      const r = await syncChatAnswers(supabase, token);
      chatAnswersSynced = r.upserted;
      chatAnswersDeleted = r.deleted;
    } catch (e) {
      chatAnswersError = (e as Error).message;
    }

    const duration = Date.now() - startTime;

    await supabase.from("sync_logs").insert({
      status:        "success",
      hotels_synced: totalHotels,
      tours_synced:  totalTours,
      duration_ms:   duration,
    });

    return new Response(
      JSON.stringify({
        success: true,
        hotels: totalHotels,
        tours: totalTours,
        flights: totalFlights,
        trains: totalTrains,
        chat_answers: chatAnswersSynced,
        chat_answers_pruned: chatAnswersDeleted,
        chat_answers_error: chatAnswersError,
        details,
        duration_ms: duration,
        debug: debugInfo?.rejects,
      }),
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
