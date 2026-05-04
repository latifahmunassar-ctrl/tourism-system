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
function extractHotels(rows: string[][], destination: string): object[] {
  const hotels: object[] = [];

  for (const row of rows) {
    if (row.length < 7) continue;

    const c = row.map(x => (x || "").trim());
    const hotelName = c[0];
    const city      = c[1];
    const starsRaw  = c[2];
    const roomType  = c[3];

    if (!hotelName || !city) continue;

    // تجاهل صفوف الرأس وصفوف المعلومات
    const nameLower = hotelName.toLowerCase();
    if (HOTEL_HEADER_KEYWORDS.some(k => nameLower.includes(k))) continue;
    if (/^\d+$/.test(hotelName)) continue; // رقم تسلسلي فقط

    const stars = parseInt(starsRaw);
    if (isNaN(stars) || stars < 1 || stars > 5) continue;

    // اكتشاف وجود عمود Note:
    // إذا c[4] يبدو تاريخاً (dd-mm-yyyy أو mm/dd/yyyy) → لا يوجد Note
    // وإلا → يوجد Note في c[4]
    const col4 = c[4] || "";
    const isDate = /^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(col4);
    const isNumber = !isNaN(parseFloat(col4)) && col4 !== "";
    const hasNote = col4 !== "" && !isDate && !isNumber;

    let priceStr: string;
    let includeStr: string;
    let currencyStr: string;

    if (hasNote) {
      // [0]Hotel [1]City [2]Stars [3]Room [4]Note [5]From [6]To [7]Rate [8]Include [9]Currency
      priceStr   = c[7] || "";
      includeStr = c[8] || "";
      currencyStr = c[9] || "SAR";
    } else {
      // [0]Hotel [1]City [2]Stars [3]Room [4]From [5]To [6]Rate [7]Include [8]Currency
      priceStr   = c[6] || "";
      includeStr = c[7] || "";
      currencyStr = c[8] || "SAR";
    }

    const price = parsePrice(priceStr);
    if (isNaN(price) || price <= 0) continue;

    hotels.push({
      name:               hotelName,
      stars,
      location:           `${city} - ${destination}`,
      price_per_night:    price,
      room_type:          roomType || "",
      includes_breakfast: /breakfast|إفطار/i.test(includeStr),
      currency:           cleanCurrency(currencyStr),
      last_synced_at:     new Date().toISOString(),
    });
  }

  return hotels;
}

// ── استخراج الجولات من صفوف التبويبة ─────────────────────────────────────
type TourSection = "Turky" | "vietnam" | "indonesia" | null;

function extractTours(rows: string[][], destination: string): object[] {
  const tours: object[] = [];
  let section: TourSection = null;
  const seen = new Set<string>(); // تجنب التكرار داخل نفس التبويبة

  for (const row of rows) {
    const c   = row.map(x => (x || "").trim());
    const txt = c.join(" ").toLowerCase();

    // ── اكتشاف بداية قسم الجولات ──────────────────────────────────────
    if (/may\s*month|june\s*month/.test(txt)) {
      section = "Turky";
      continue;
    }
    if (/pax\s*1-3|1-3\s*pax/.test(txt)) {
      section = "vietnam";
      continue;
    }
    if (/tour\s*fees|1-4\s*pax|pax\s*1-4/.test(txt)) {
      section = "indonesia";
      continue;
    }

    // إعادة الضبط عند رأس قسم الفنادق
    if (/^hotel$/i.test(c[0])) {
      section = null;
      continue;
    }

    if (!section) continue;

    let name     = "";
    let price    = 0;
    let currency = "SAR";

    if (section === "Turky") {
      // col0=اسم | col1=سعر مايو | col2=سعر يونيو | col3=عملة
      name     = c[0];
      price    = parsePrice(c[1]);
      currency = cleanCurrency(c[3]);

    } else if (section === "vietnam") {
      // col0=اسم النشاط | col1=رقم اليوم | col2=سعر للفرد
      name     = c[0];
      price    = parsePrice(c[2]);
      currency = "SAR";

    } else if (section === "indonesia") {
      // col0=اسم مختصر | col1=فارغ | col2=اسم كامل | col3=سعر 1-4 | col6=عملة
      name     = c[2] || c[0];
      price    = parsePrice(c[3]);
      currency = cleanCurrency(c[6]);
    }

    if (!name || isNaN(price) || price <= 0) continue;

    const key = `${name}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    tours.push({
      name,
      type:           destination,
      price,
      currency,
      description:    name,
      last_synced_at: new Date().toISOString(),
    });
  }

  return tours;
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

  try {
    const serviceAccount = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT")!);
    const spreadsheetId  = Deno.env.get("GOOGLE_SPREADSHEET_ID")!;
    const token          = await getGoogleAccessToken(serviceAccount);

    let totalHotels = 0;
    let totalTours  = 0;

    for (const tab of DESTINATION_TABS) {
      try {
        const rows = await readSheetRange(token, spreadsheetId, `${tab}!A1:M500`);

        const hotels = extractHotels(rows, tab);
        const tours  = extractTours(rows, tab);

        if (hotels.length > 0) {
          const { error } = await supabase
            .from("hotels")
            .upsert(hotels, { onConflict: "name,room_type" });
          if (error) throw new Error(`فنادق: ${error.message}`);
        }

        if (tours.length > 0) {
          const { error } = await supabase
            .from("tours")
            .upsert(tours, { onConflict: "name,type" });
          if (error) throw new Error(`جولات: ${error.message}`);
        }

        details[tab] = { hotels: hotels.length, tours: tours.length };
        totalHotels += hotels.length;
        totalTours  += tours.length;

      } catch (tabError) {
        details[tab] = { hotels: 0, tours: 0, error: tabError.message };
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
      JSON.stringify({ success: true, hotels: totalHotels, tours: totalTours, details, duration_ms: duration }),
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
