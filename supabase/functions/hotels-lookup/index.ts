/**
 * hotels-lookup — إرجاع حقل Occupancy من جدول الفنادق (المزامَن من Google Sheets)
 * لمطابقة أسطر HOTELS في برنامج الموظّف مع نفس السعر/الفندق في قاعدة البيانات.
 *
 * POST /functions/v1/hotels-lookup
 * Body: { destination: string (نص DEST أو اسم الوجهة), hotels: [{ index, name, city, stars, roomType, nightly }] }
 *
 * يتطلب SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};

type HotelRow = {
  name: string;
  stars: number;
  location: string;
  price_per_night: number | string;
  room_type: string;
  occupancy: string;
};

function inferDestinationSheetKey(destLine: string): string | null {
  const d = String(destLine || "").trim();
  if (/روسيا|russia|русс/i.test(d)) return "russia";
  if (/فيتنام|vietnam/i.test(d)) return "vietnam";
  if (/تركيا|turkey|turky|t[uü]rkiye/i.test(d)) return "Turky";
  if (/البوسنة|bosnia|بوسن/i.test(d)) return "Bosnia";
  if (/اندونيسيا|إندونيسيا|indonesia/i.test(d)) return "indonesia";
  if (/ماليزيا|malaysia/i.test(d)) return "Malaysia";
  if (/تايلند|thailand/i.test(d)) return "thailand";
  return null;
}

const ARDIG: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

function latinDigits(s: string): string {
  return String(s || "").replace(/[٠-٩]/g, (ch) => ARDIG[ch] || ch);
}

function norm(s: string): string {
  return latinDigits(String(s || "")).toLowerCase().replace(/\s+/g, " ").trim();
}

function tabFromLocation(location: string): string {
  const parts = String(location || "").split(/\s*-\s*/);
  return (parts.pop() || "").trim();
}

function cityFromLocation(location: string): string {
  const parts = String(location || "").split(/\s*-\s*/);
  parts.pop();
  return parts.join(" - ").trim();
}

function locationMatchesTab(location: string, tab: string): boolean {
  return norm(tabFromLocation(location)) === norm(tab);
}

function numPrice(v: number | string): number {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

type ReqHotel = {
  index: number;
  name: string;
  city: string;
  stars: number;
  roomType: string;
  nightly: number;
};

function scoreMatch(h: HotelRow, r: ReqHotel): number {
  let s = 0;
  const hc = cityFromLocation(h.location);
  const rc = norm(r.city);
  const hcn = norm(hc);
  if (hcn && rc && hcn === rc) s += 100;
  else if (hcn && rc && (hcn.includes(rc) || rc.includes(hcn))) s += 72;

  const hn = norm(h.name);
  const rn = norm(r.name);
  if (hn && rn && hn === rn) s += 100;
  else if (hn && rn && (hn.includes(rn) || rn.includes(hn))) s += 74;

  const hs = Number(h.stars) || 0;
  const rs = Number(r.stars) || 0;
  if (rs > 0 && hs === rs) s += 36;
  else if (rs > 0 && Math.abs(hs - rs) === 1) s += 18;

  const hp = Math.round(numPrice(h.price_per_night));
  const rp = Math.round(Number(r.nightly) || 0);
  if (rp > 0 && hp > 0) {
    const diff = Math.abs(hp - rp);
    if (diff === 0) s += 62;
    else if (diff <= 2) s += 50;
    else if (diff <= 8 || diff / Math.max(hp, 1) <= 0.04) s += 34;
  }

  const rt = norm(h.room_type);
  const rr = norm(r.roomType);
  if (rt && rr && (rt === rr || rt.includes(rr) || rr.includes(rt))) s += 48;
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const destination = String(body.destination || "").trim();
    const tab = inferDestinationSheetKey(destination);
    const list = Array.isArray(body.hotels) ? body.hotels as ReqHotel[] : [];

    if (!tab) {
      return new Response(
        JSON.stringify({ ok: false, error: "destination_not_mapped", results: [] }),
        { status: 200, headers: CORS_HEADERS },
      );
    }

    if (!list.length) {
      return new Response(JSON.stringify({ ok: true, tab, results: [] }), { status: 200, headers: CORS_HEADERS });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: rows, error } = await supabase
      .from("hotels")
      .select("name,stars,location,price_per_night,room_type,occupancy");

    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }

    const pool = (rows || []).filter((h) =>
      locationMatchesTab(String(h.location), tab)
    ) as HotelRow[];

    const MIN_SCORE = 140;
    const results: Array<{ index: number; occupancy: string | null; score: number }> = [];

    for (const r of list) {
      let best = { occupancy: null as string | null, score: 0 };
      for (const h of pool) {
        const sc = scoreMatch(h, r);
        if (sc > best.score) {
          best = { occupancy: String(h.occupancy || "").trim() || null, score: sc };
        }
      }
      if (best.score < MIN_SCORE) best = { occupancy: null, score: best.score };
      results.push({ index: r.index, occupancy: best.occupancy, score: best.score });
    }

    results.sort((a, b) => a.index - b.index);
    return new Response(JSON.stringify({ ok: true, tab, results }), { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }),
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
