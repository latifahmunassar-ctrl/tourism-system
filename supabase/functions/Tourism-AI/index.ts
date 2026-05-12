/**
 * Tourism-AI — بناء البرامج السياحية باستخدام Claude AI
 * البيانات تُجلب من Supabase DB (المُزامَنة من Google Sheets)
 *
 * البيئة المطلوبة (Supabase Secrets):
 *   ANTHROPIC_API_KEY → مفتاح Claude API
 */

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import { parseTripRequest } from "./local-parser.ts";
import {
  buildLocalProgram,
  canBuildLocally,
  type HotelRow,
  type TourRow,
  type FlightRow,
} from "./local-builder.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};

// ── بناء سياق البيانات من قاعدة البيانات ──────────────────────────────────
// Detect destination from messages so we only ship that destination's data
// to the model (cuts input tokens dramatically). If we can't tell, ship all.
function detectDestination(messages: Array<{ role: string; content: unknown }>): string | null {
  const text = messages
    .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    .join(" ")
    .toLowerCase();
  // Each pattern is broad on purpose — Saudi/colloquial spelling often drops
  // the trailing alif ("مليزيا" / "ماليزى") or uses a city as the only proper
  // noun. Listing major cities + dialect variants prevents false negatives
  // that would route the request to Claude unnecessarily.
  const map: Array<[RegExp, string]> = [
    [/فيتنام|ڤيتنام|فيتنامي|vietnam|hanoi|هانوي|halong|هالونج|danang|دانانج|sapa|سابا|phu\s*quoc|فوكوك/i, "vietnam"],
    [/ماليزيا|مليزيا|ماليزى|malaysia|kuala\s*lumpur|كوالا|كوالالمبور|langkawi|لانكاوي|penang|بينانج|cameron|كاميرون|selangor|سيلانجور|sunway/i, "Malaysia"],
    [/إندونيسيا|اندونيسيا|اندونيسي|indonesia|بالي|bali|جاكرتا|jakarta|باندونغ|bandung|puncak|بونشاك/i, "indonesia"],
    [/تركيا|تركى|turky|turkey|اسطنبول|istanbul|طرابزون|trabzon|أوزنجول|اوزنجول|uzungol|بورصة|bursa|ايدر|ayder|سابانجا|sapanca/i, "Turky"],
    [/روسيا|russia|موسكو|moscow|سانت\s*بطرسبرغ|saint\s*petersburg|سوتشي|sochi/i, "russia"],
    [/البوسنة|البوسنه|bosnia|سراييفو|sarajevo|موستار|mostar|بيهاتش|bihać|bihac/i, "Bosnia"],
    [/تايلاند|تايلند|thailand|بانكوك|bangkok|بوكيت|بوكت|phuket|كرابي|krabi|شيانغ|chiang|باتايا|بتايا|pattaya|ساموي|samui/i, "thailand"],
  ];
  for (const [re, dest] of map) if (re.test(text)) return dest;
  return null;
}

// City-name → canonical-city-tag table per destination. Used by both the city
// detector (does the employee already say which cities?) and the lite-mode
// renderer (list-of-cities only response). Canonical names are the same ones
// stored in hotels.location ("Hanoi - vietnam" etc.).
// City regex patterns are deliberately wide to absorb dialectal/typo variants.
// Common rules used throughout:
//   • ج/غ interchangeable (جاكرتا = جاكرتا, دانانج = دانانغ, موستار same)
//   • Trailing endings often dropped (سانت بطرسبرغ → سانت بطرس → بطرسبرغ)
//   • ا often dropped/added (ماليزيا/ملزيا, لانكاوي/لنكاوي, كوالا/كولا)
//   • ة/ه/ـة all accepted (بورصة/بورصه)
//   • Latin alts always allowed (with optional spacing/hyphenation)
const DEST_CITIES: Record<string, Array<{ canonical: string; pattern: RegExp }>> = {
  vietnam: [
    { canonical: "Ha Noi",      pattern: /هانوي|hanoi|ha\s*noi/i },
    { canonical: "Sapa",        pattern: /سابا|sapa|كات\s*كات|لاو\s*تشاي|تا\s*فان|فانسيبان/i },
    { canonical: "Ha Long",     pattern: /هالون[جغ]|halong|ha\s*long/i },
    { canonical: "Da Nang",     pattern: /دانان[جغ]|danang|da\s*nang|ba\s*na|ماي\s*خي/i },
    { canonical: "Phu Quoc",    pattern: /فوكوك|phu\s*quoc|phuquoc/i },
    { canonical: "Ho Chi Minh", pattern: /هوتشي|هو\s*تشي|ho\s*chi|hochi|saigon|سايغون|سايجون/i },
  ],
  Malaysia: [
    { canonical: "Kuala Lumpur",     pattern: /كوالا\s*ل?مبور|كولا\s*ل?مبور|kuala\s*lumpur|\bKL\b/i },
    { canonical: "Selangor",         pattern: /سيلان[جغ]ور|سلان[جغ]ور|selangor|sunway|مدينة\s*ال[أا]لعاب/i },
    { canonical: "Langkawi",         pattern: /لان?كاوي|langkawi/i },
    { canonical: "Penang",           pattern: /بينان[جغ]|بنان[جغ]|penang/i },
    { canonical: "Cameron Highlands",pattern: /كام?يرون|cameron|هايلاند|مرتفعات\s*الكام?ي?رون/i },
  ],
  thailand: [
    { canonical: "Bangkok",      pattern: /بان[كق]وك|bangkok/i },
    { canonical: "Phuket",       pattern: /بوكي?ت|phuket/i },
    { canonical: "Krabi",        pattern: /كرابي|krabi/i },
    { canonical: "Chiang Mai",   pattern: /شيان[جغ]?\s*ماي|شانغماي|chiang\s*mai|chiangmai/i },
    { canonical: "Pattaya",      pattern: /با?تايا|pattaya/i },
    { canonical: "Koh Samui",    pattern: /كو(?:ه|سم?)\s*ساموي|koh\s*samui|samui/i },
  ],
  Turky: [
    { canonical: "Istanbul",   pattern: /اسطنبول|إسطنبول|إستانبول|istanbul|آيا\s*صوفيا|البازار|تقسيم/i },
    { canonical: "Trabzon",    pattern: /طرابزون|طربزون|trabzon|سلطان\s*مراد|حيدر\s*نبي|هامسيكوي|بيشك\s*دوزو/i },
    // Saudi spelling alternates و↔ز order: اوزنجول vs ازونجول
    { canonical: "Uzungol",    pattern: /[أا]وزن[جغ]ول|[أا]زون[جغ]ول|uzungol/i },
    { canonical: "Ayder",      pattern: /[أا]يدر|ayder/i },
    { canonical: "Rize",       pattern: /ريزا|ريزه|rize/i },
    { canonical: "Bursa",      pattern: /بورص[ةه]|bursa/i },
    { canonical: "Sapanca",    pattern: /سابان[جغ]ا|sapanca|معشوقية/i },
  ],
  russia: [
    { canonical: "Moscow",         pattern: /موسكو|موسكوا|moscow|moskva/i },
    // Saudi often shortens to "سانت بطرس", "بطرسبرغ"/"بطرسبورج", or even
    // "سانت برغ" (drops the "بطرس" entirely). Match strategy:
    //   - The suffix بطرسبرغ/بطرسبور[جك] is enough on its own.
    //   - "سان/سانت + برغ" (no بطرس) — used in the sheet's transfer rows.
    //   - "سان/سانت + بطرس" — common shortened spelling.
    //   - Latin variants always allowed.
    { canonical: "St Petersburg",  pattern: /(?:سان?ت?\s*)?بطرس(?:بور[جك]|برغ|بور)|سان?ت?\s+(?:بطرس|برغ)|saint\s*petersburg|st\.?\s*petersburg/i },
    { canonical: "Sochi",          pattern: /سوتشي|سوشي|sochi/i },
  ],
  Bosnia: [
    { canonical: "Sarajevo", pattern: /سرايي?فو|sarajevo/i },
    { canonical: "Mostar",   pattern: /موستار|mostar/i },
    { canonical: "Bihać",    pattern: /بيهاتش|bihać|bihac/i },
  ],
  indonesia: [
    // Bali aliases: kuta/seminyak/ubud/jimbaran/nusa dua are all Bali areas.
    // Saudi spelling has both سمينياك (سم-ين-ياك) and سيمنياك (سي-من-ياك).
    { canonical: "Bali",     pattern: /بالي|bali|كوتا|kuta|[أا]وبود|ubud|سمينياك|سيمنياك|seminyak|جيمباران|jimbaran|نوسا\s*دوا/i },
    // Jakarta: also accept "جاكرت" without trailing ا (very common shorthand)
    // and "جاكزتا" (ز instead of ر, sheet typo).
    { canonical: "Jakarta",  pattern: /جا?ك[رز]تا?|jakarta/i },
    // Bandung sheet variant: "باندونق" with ق (Egyptian dialect spelling)
    { canonical: "Bandung",  pattern: /باندون[جغق]|bandung/i },
    { canonical: "Puncak",   pattern: /بونشاك|puncak/i },
  ],
};

/**
 * Detect which cities of `destination` are explicitly mentioned across all
 * messages. Returns the canonical-name list (deduped, in mention order).
 * Empty list = employee hasn't picked cities yet → caller should ship lite
 * context and ask for the night distribution.
 */
function detectCitiesFromMessage(
  messages: Array<{ role: string; content: unknown }>,
  destination: string,
): string[] {
  const cities = DEST_CITIES[destination];
  if (!cities) return [];
  const text = messages
    .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    .join(" ");
  const found: string[] = [];
  for (const { canonical, pattern } of cities) {
    if (pattern.test(text) && !found.includes(canonical)) {
      found.push(canonical);
    }
  }
  return found;
}

/**
 * Validate that the night distribution the employee wrote sums to (days - 1).
 * Looks for tokens like "هانوي 2" / "سابا 3" near city names. Returns
 * { ok: true } when valid or when no distribution was given yet, otherwise
 * { ok: false, message: "..." } with a short Arabic error to send back in CHAT.
 */
/** Convert Arabic-Indic and Eastern-Arabic-Indic digits to ASCII 0-9. */
function normalizeNightWords(s: string): string {
  let t = s;
  t = t.replace(/ليلت(?:ين|ان)/gu, "2 ليال");
  const map: Array<[string, number]> = [
    ["عشر[ةه]?", 10], ["تسع[ةه]?", 9], ["ثمان(?:ية|يه)?", 8],
    ["سبع[ةه]?", 7], ["ست[ةه]?", 6], ["خمس[ةه]?", 5],
    ["[أا]ربع[ةه]?", 4], ["ثلاث[ةه]?|تلات[ةه]?", 3],
    ["[إا]ثن[يا][نه]", 2], ["واحد[ةه]?|وحد[ةه]?", 1],
  ];
  for (const [w, n] of map) {
    const re = new RegExp(`(${w})\\s+(?:ليال[يى]?|ليل[ةتهى]?|night)`, "giu");
    t = t.replace(re, `${n} ليال`);
  }
  return t;
}

function arabicDigitsToLatin(s: string): string {
  return s
    .replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/[۰-۹]/g, c => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)));
}

function validateNightsDistribution(
  messages: Array<{ role: string; content: unknown }>,
  destination: string,
  cities: string[],
): { ok: true } | { ok: false; message: string } {
  if (cities.length === 0) return { ok: true };
  // Use ONLY the LAST user message that looks like a full trip request
  // (mentions days OR a date range). Re-sends with even one digit changed
  // ("إلى 22" → "إلى 21") would otherwise BOTH count and double-credit
  // every per-city number. The very first request is usually self-contained;
  // any later "fix" is a complete replacement, not an addition.
  const userMessages = messages
    .filter(m => m.role === "user")
    .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  // Walk backward to find the most recent message that contains a trip-length
  // signal (يوم/أيام/days OR "من X إلى Y"). Fall back to the last message
  // if none qualifies — short follow-ups like "اضف شريحه" are still scanned.
  const hasTripSignal = (t: string) =>
    /(\d{1,2})\s*(?:يوم|أيام|ايام|days?)/i.test(t) ||
    /من\s+(?:تاريخ\s+|يوم\s+)?\d{1,2}\s+[؀-ۿ]+\s+(?:إلى|الى|إلي|الي|ل)\s+(?:تاريخ\s+|يوم\s+)?\d{1,2}\s+[؀-ۿ]+/iu.test(t);
  let userText = "";
  for (let i = userMessages.length - 1; i >= 0; i--) {
    if (hasTripSignal(userMessages[i])) { userText = userMessages[i]; break; }
  }
  if (!userText) userText = userMessages[userMessages.length - 1] || "";
  const text = normalizeNightWords(arabicDigitsToLatin(userText));

  // Extract target nights from any "N يوم/أيام" mention OR a date range
  // ("من تاريخ 11 يوليو إلى 22 يوليو" → 12 days = 11 nights).
  let targetNights = 0;
  const daysMatch = text.match(/(\d{1,2})\s*(?:يوم|أيام|ايام|days?)/i);
  if (daysMatch) {
    targetNights = parseInt(daysMatch[1], 10) - 1;
  } else {
    const rangeMonth: Record<string, number> = {
      "يناير":1,"فبراير":2,"مارس":3,"أبريل":4,"ابريل":4,"مايو":5,"يونيو":6,
      "يوليو":7,"أغسطس":8,"اغسطس":8,"سبتمبر":9,"أكتوبر":10,"اكتوبر":10,
      "نوفمبر":11,"ديسمبر":12,
    };
    const r = text.match(/من\s+(?:تاريخ\s+|يوم\s+)?(\d{1,2})\s+([؀-ۿ]+)\s+(?:إلى|الى|إلي|الي|ل)\s+(?:تاريخ\s+|يوم\s+)?(\d{1,2})\s+([؀-ۿ]+)/iu);
    if (r) {
      const d1 = parseInt(r[1], 10), d2 = parseInt(r[3], 10);
      const m1 = rangeMonth[r[2]] || 0, m2 = rangeMonth[r[4]] || 0;
      if (m1 && m2) {
        const y = new Date().getFullYear();
        const start = new Date(y, m1 - 1, d1);
        const end = new Date(y, m2 - 1, d2);
        const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
        if (days > 0 && days <= 60) targetNights = days - 1;
      }
    }
  }
  if (!(targetNights > 0)) return { ok: true };

  // For each detected city, sum ALL occurrences of "N <city>" or "<city> N"
  // — same city can appear twice (e.g. Hanoi at start AND end of itinerary).
  let sumNights = 0;
  let foundAny = false;
  const cityDefs = DEST_CITIES[destination] || [];
  for (const canonical of cities) {
    const def = cityDefs.find(c => c.canonical === canonical);
    if (!def) continue;
    const cityPat = def.pattern.source;
    // Global match — collect every "N city" or "city N" pair.
    // The "city N" form REQUIRES a nights-word suffix; otherwise a header
    // like "سانت بطرس 10 ايام" would credit 10 nights to the city instead
    // of recognizing 10 as the trip-day count.
    const re = new RegExp(
      `(?:(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتهى]?|ليلتين|ليه|نايت|night)?\\s*(?:${cityPat}))` +
      `|(?:(?:${cityPat})\\s*(?:=|:|-|بـ|في|عن|لمدة|ل)?\\s*(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتهى]?|نايت|night))`,
      "ig"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1] || m[2] || "0", 10);
      if (n > 0 && n <= 30) {
        sumNights += n;
        foundAny = true;
      }
      // Safety: prevent infinite loops on zero-width matches
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  if (!foundAny) return { ok: true }; // no per-city numbers yet → don't block
  if (sumNights === targetNights) return { ok: true };

  return {
    ok: false,
    message:
      `التوزيع الذي أعطيتني = ${sumNights} ليالي، لكن البرنامج ${targetNights + 1} أيام يحتاج ${targetNights} ليالي. ` +
      `راجع توزيع الليالي وأعد الإرسال.`,
  };
}

/**
 * Build a TINY data context (just the city names) for the first conversation
 * turn. Used when destination is known but the employee hasn't yet picked
 * which cities to visit. Saves ~20K tokens per turn.
 */
function buildLiteCitiesContext(destination: string): string {
  const cities = DEST_CITIES[destination] || [];
  if (cities.length === 0) return "البيانات المتاحة في النظام: (لا توجد مدن مُعرَّفة لهذه الوجهة)\n";
  let s = `البيانات المتاحة في النظام (وضع مختصر):\n\n📍 المدن المتاحة في ${destination}:\n`;
  for (const { canonical } of cities) s += `  - ${canonical}\n`;
  s += `\n⚠️ التفاصيل الكاملة (الفنادق + الجولات + الطيران) لم تُرسَل بعد لتوفير التكلفة. لمّا الموظف يحدّد المدن وعدد الليالي لكل مدينة، نُرسل لك بيانات تلك المدن فقط ثم تبني البرنامج.\n`;
  return s;
}

/**
 * Find the most recent assistant message that contains a built program
 * (i.e. a "DEST:" header). Returns the raw text or null if none yet.
 */
function findLastBuiltProgram(messages: Array<{ role: string; content: unknown }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const txt = typeof m.content === "string" ? m.content : (() => {
      if (Array.isArray(m.content)) {
        for (const part of m.content as Array<{ type?: string; text?: string }>) {
          if (part?.type === "text" && typeof part.text === "string") return part.text;
        }
      }
      return "";
    })();
    if (typeof txt === "string" && /^DEST:/m.test(txt)) return txt;
  }
  return null;
}

/**
 * Try to apply a simple structural edit (extra-bed / SIM count) to the previous
 * program text. Returns the patched program or null if the message doesn't
 * match a known local-edit pattern (so the handler falls back to Claude).
 *
 * Saves ~$0.04 per edit because Claude doesn't get called at all.
 */
function tryLocalEdit(userMsg: string, prevProgram: string): string | null {
  const msg = userMsg.trim();
  if (msg.length === 0) return null;

  // Helper: insert a new line right before the FLIGHTS section (or before
  // SUMMARY if FLIGHTS is missing). Replaces an existing same-key line if any.
  const upsertSectionLine = (text: string, key: string, value: string): string => {
    const newLine = `${key}:${value}`;
    const re = new RegExp(`^${key}:.*$`, "m");
    if (re.test(text)) {
      return text.replace(re, newLine);
    }
    // Insert before FLIGHTS, then before TRANSFERS, then before SUMMARY
    for (const anchor of ["FLIGHTS:", "TRANSFERS:", "TOURS:", "SUMMARY:"]) {
      const idx = text.indexOf(`\n${anchor}`);
      if (idx >= 0) return text.slice(0, idx) + `\n${newLine}` + text.slice(idx);
    }
    // Fallback: append at end before CHAT
    const chatIdx = text.indexOf("\nCHAT:");
    if (chatIdx >= 0) return text.slice(0, chatIdx) + `\n${newLine}` + text.slice(chatIdx);
    return text + `\n${newLine}`;
  };

  const removeSectionLine = (text: string, key: string): string => {
    return text.replace(new RegExp(`^${key}:.*$\\n?`, "m"), "");
  };

  const noteHeader = "CHAT:تم تطبيق التعديل محلياً (بدون تكلفة API).";
  const replaceChat = (text: string, newChat: string): string => {
    if (/^CHAT:.*$/m.test(text)) return text.replace(/^CHAT:.*$/m, newChat);
    return text.trimEnd() + `\n\n${newChat}`;
  };

  // Recompute SUMMARY block after a structural edit (SIM count or extra-bed).
  // The frontend recomputes the displayed total dynamically, but the program
  // text itself (used for PDF export, DB save, chat display) needs to be in
  // sync — otherwise employees see "TOTAL_GROUP:21,425" while the side panel
  // shows 21,575. This rewrites just the lines that depend on SIM/extra-bed
  // and leaves any unknown summary lines untouched.
  const recomputeSummary = (text: string): string => {
    const fmtNum = (n: number) => n.toLocaleString("en-US");
    // First number only — hotel cells like "2 ليالي (من 1 يونيو 2026 إلى 3 يونيو 2026)"
    // would otherwise concatenate to "212026320265" if we stripped all non-digits.
    const firstInt = (s: string): number => {
      const m = String(s || "").match(/(\d[\d,]*)/);
      return m ? parseInt(m[1].replace(/,/g, ""), 10) || 0 : 0;
    };
    // For SUMMARY rows like "12,240 ريال" the first run captures the whole money.
    const parseMoney = firstInt;

    // Adults from META: "META:N أيام | M ليالي | ... | A أشخاص"
    const metaPaxMatch = text.match(/META:[^\n]*?\|\s*(\d+)\s*(?:شخص|أشخاص|بالغين|بالغ)/);
    const adults = metaPaxMatch ? parseInt(metaPaxMatch[1], 10) : 1;

    // SIM count → SIM cost
    const simMatch = text.match(/^SIM:\s*(\d+)/m);
    const simCount = simMatch ? parseInt(simMatch[1], 10) : 0;
    const simTotal = simCount * 50;

    // EXTRA_BED_CITIES → which cities (or ALL) get a bed
    const ebMatch = text.match(/^EXTRA_BED_CITIES:(.+)$/m);
    const ebLine = ebMatch ? ebMatch[1].trim() : "";
    const isAllBed = /\bALL\s*=/i.test(ebLine);
    const ebCityKeys = new Set<string>();
    if (!isAllBed && ebLine) {
      for (const part of ebLine.split(/[,،;]/)) {
        const eq = part.indexOf("=");
        const name = (eq >= 0 ? part.slice(0, eq) : part).trim().toLowerCase();
        if (name) ebCityKeys.add(name);
      }
    }

    // Walk HOTELS lines: extract city/stars/price/nights to compute base
    // hotels total + extra-bed cost. Format:
    //   "Hotel Name | City | N نجوم | RoomType | PRICE ريال/ليلة | N ليالي (...) | meals"
    const hotelsBlock = text.match(/HOTELS:\s*\n([\s\S]*?)(?=\n[A-Z_]+:|$)/);
    let baseHotels = 0;
    let extraBedTotal = 0;
    if (hotelsBlock) {
      for (const line of hotelsBlock[1].split("\n")) {
        const cols = line.split("|").map(s => s.trim());
        if (cols.length < 6) continue;
        const cityKey = cols[1].toLowerCase();
        const stars = firstInt(cols[2]);
        const price = firstInt(cols[4]);
        const nights = firstInt(cols[5]);
        if (price === 0 || nights === 0) continue;
        baseHotels += price * nights;
        if (stars >= 4 && stars <= 5) {
          const cityHasBed = isAllBed || ebCityKeys.has(cityKey);
          if (cityHasBed) {
            const bedNightly = stars >= 5 ? 120 : 100;
            extraBedTotal += bedNightly * nights;
          }
        }
      }
    }
    const hotelsWithBed = baseHotels + extraBedTotal;

    // Read existing SUMMARY block (it has the unchanged flights/transfers/
    // tours subtotals — we trust those since this edit didn't touch them).
    const sumMatch = text.match(/(SUMMARY:\s*\n)([\s\S]*?)(?=\nCHAT:|$)/);
    if (!sumMatch) return text;
    let lines = sumMatch[2].split("\n").map(l => l.trim()).filter(Boolean);

    const findVal = (labelRe: RegExp) => {
      for (const l of lines) {
        const p = l.split("|").map(x => x.trim());
        if (labelRe.test(p[0] || "")) return firstInt(p[1] || "");
      }
      return 0;
    };
    const flightsTotal = findVal(/طيران/);
    const transfersTotal = findVal(/انتقال/);
    const toursTotal = findVal(/جولات/);

    const newGroup = hotelsWithBed + flightsTotal + transfersTotal + toursTotal + simTotal;
    const perPerson = adults > 0 ? Math.round(newGroup / adults) : newGroup;

    // Upsert specific lines, preserve any unknown extras
    const upsert = (labelRe: RegExp, newLine: string) => {
      let found = false;
      lines = lines.map(l => (labelRe.test(l) && !found) ? (found = true, newLine) : l);
      if (!found) {
        const idx = lines.findIndex(l => /^TOTAL_/.test(l));
        if (idx >= 0) lines.splice(idx, 0, newLine); else lines.push(newLine);
      }
    };
    upsert(/^الفنادق/, `الفنادق | ${fmtNum(hotelsWithBed)} ريال`);
    if (simTotal > 0) {
      upsert(/^شرائح\s*الاتصال/, `شرائح الاتصال | ${fmtNum(simTotal)} ريال`);
    } else {
      lines = lines.filter(l => !/^شرائح\s*الاتصال/.test(l));
    }
    upsert(/^TOTAL_PER_PERSON/, `TOTAL_PER_PERSON:${fmtNum(perPerson)}`);
    // Match local-builder pluralization (lines 522/598): 1 or 2 → "شخص", else "أشخاص"
    const groupSuffix = `${adults} ${(adults === 1 || adults === 2) ? "شخص" : "أشخاص"}`;
    upsert(/^TOTAL_GROUP/, `TOTAL_GROUP:${fmtNum(newGroup)} | ${groupSuffix}`);

    return text.replace(/(SUMMARY:\s*\n)([\s\S]*?)(?=\nCHAT:|$)/,
      sumMatch[1] + lines.join("\n") + "\n");
  };

  // Helper: is this an "extra bed" mention? (covers many spellings)
  // Saudi/colloquial Arabic frequently uses ه instead of ة, ا instead of أ/إ,
  // and ى instead of ي — so every Arabic class is widened to accept both.
  // - سرير / سريرين / أسرة / اسره / سراير / سرايا / extra/sofa bed
  const isBedKeyword = /(?:سرير(?:ين|ان)?|[أا]سرّ?[هة]|سراير|سرايا|extra\s*-?\s*bed|sofa\s*-?\s*bed|rollaway|extra\s*mattress)/iu;
  // "اضافي/إضافي/اضافه/إضافية/زيادة/زياده/extra"
  const hasExtraIntent = /(?:[إأا]?ضاف[يىه]?[هة]?|زياد[هة]|extra)/iu;

  // Helper: find every canonical city mentioned in `text` (no early break,
  // so multi-city requests like "احذف السرير في هانوي ودانانج" both register).
  const allCityDefs: Array<{ canonical: string; pattern: RegExp }> = [];
  for (const dest of Object.keys(DEST_CITIES)) {
    for (const c of DEST_CITIES[dest]) allCityDefs.push({ canonical: c.canonical, pattern: c.pattern });
  }
  const detectCitiesInText = (text: string): string[] => {
    const found: string[] = [];
    for (const c of allCityDefs) {
      if (new RegExp(c.pattern.source, "i").test(text) && !found.includes(c.canonical)) {
        found.push(c.canonical);
      }
    }
    return found;
  };

  // Helper: parse the existing EXTRA_BED_CITIES line into a structured scope.
  type BedScope = { mode: "all" | "list" | "none"; cities: string[] };
  const readBedScope = (text: string): BedScope => {
    const m = text.match(/^EXTRA_BED_CITIES:(.+)$/m);
    if (!m) return { mode: "none", cities: [] };
    const value = m[1].trim();
    if (/\bALL\s*=/i.test(value)) return { mode: "all", cities: [] };
    const cities: string[] = [];
    for (const part of value.split(/[,،;]/)) {
      const p = part.trim();
      if (!p) continue;
      const eqIdx = p.indexOf("=");
      const name = (eqIdx >= 0 ? p.slice(0, eqIdx) : p).trim();
      if (name) cities.push(name);
    }
    return { mode: "list", cities };
  };

  // Helper: list all canonical cities that actually appear in the program's
  // HOTELS section (used when expanding ALL=1 before subtracting a city).
  const getProgramCities = (text: string): string[] => {
    const startIdx = text.indexOf("HOTELS:");
    if (startIdx < 0) return [];
    const rest = text.slice(startIdx + "HOTELS:".length);
    const nextSection = rest.match(/\n[A-Z_]+:/);
    const endIdx = nextSection ? startIdx + "HOTELS:".length + nextSection.index! : text.length;
    return detectCitiesInText(text.slice(startIdx, endIdx));
  };

  // Map canonical English city names to their Arabic display form. The
  // HOTELS section in built programs uses Arabic city names, so the
  // frontend's extra-bed cost calculator can't match a canonical English
  // entry against a Hotel-section city without help. We emit BOTH names
  // in EXTRA_BED_CITIES so whichever side runs the lookup, it matches.
  const CITY_AR: Record<string, string> = {
    "Ha Noi": "هانوي", "Sapa": "سابا", "Ha Long": "هالونج",
    "Da Nang": "دانانج", "Phu Quoc": "فوكوك", "Ho Chi Minh": "هوتشي مينه",
    "Kuala Lumpur": "كوالالمبور", "Selangor": "سيلانجور",
    "Langkawi": "لانكاوي", "Penang": "بينانج", "Cameron Highlands": "كاميرون هايلاند",
    "Bangkok": "بانكوك", "Phuket": "بوكيت", "Krabi": "كرابي",
    "Chiang Mai": "شيانغ ماي", "Pattaya": "باتايا", "Koh Samui": "كوه ساموي",
    "Istanbul": "اسطنبول", "Trabzon": "طرابزون", "Uzungol": "أوزنجول",
    "Ayder": "ايدر", "Rize": "ريزا", "Bursa": "بورصة", "Sapanca": "سابانجا",
    "Moscow": "موسكو", "St Petersburg": "سانت بطرسبرغ", "Sochi": "سوتشي",
    "Sarajevo": "سراييفو", "Mostar": "موستار", "Bihać": "بيهاتش",
    "Bali": "بالي", "Jakarta": "جاكرتا", "Bandung": "باندونغ", "Puncak": "بونشاك",
  };
  const formatBedScope = (cities: string[]): string => cities.flatMap(c => {
    const ar = CITY_AR[c];
    return ar && ar !== c ? [`${c}=1`, `${ar}=1`] : [`${c}=1`];
  }).join(", ");

  // ── Pattern 1: REMOVE extra bed ──────────────────────────────────────
  // "احذف السرير الإضافي" → wipe all
  // "احذف السرير في هانوي" → subtract just Hanoi (expanding ALL=1 first
  // to the cities present in HOTELS so the rest are preserved)
  const removeVerb = /(?:^|\s)(احذف|شيل|ألغ[يى]?|الغ[يى]?|بدون|من\s*غير|بد[ييى]?\s*بدون|remove|cancel|no)/iu;
  const removeBedHit = (removeVerb.test(msg) && isBedKeyword.test(msg))
    || /no\s*extra\s*bed|cancel\s*extra\s*bed/i.test(msg);
  if (removeBedHit) {
    const requestedCities = detectCitiesInText(msg);
    const existing = readBedScope(prevProgram);
    let patched: string;
    if (requestedCities.length === 0 || existing.mode === "none") {
      // No city named OR nothing to subtract from → remove the whole line
      patched = removeSectionLine(prevProgram, "EXTRA_BED_CITIES");
      patched = replaceChat(patched, noteHeader.replace("التعديل", "حذف السرير الإضافي من جميع الفنادق"));
      return recomputeSummary(patched);
    }
    // City-scoped removal: expand ALL=1 to actual hotel cities, then subtract.
    const baseCities = existing.mode === "all" ? getProgramCities(prevProgram) : existing.cities;
    const remaining = baseCities.filter(c => !requestedCities.includes(c));
    if (remaining.length === 0) {
      patched = removeSectionLine(prevProgram, "EXTRA_BED_CITIES");
    } else {
      patched = upsertSectionLine(prevProgram, "EXTRA_BED_CITIES", formatBedScope(remaining));
    }
    patched = replaceChat(patched, noteHeader.replace("التعديل",
      `حذف السرير الإضافي من ${requestedCities.join("، ")}`));
    return recomputeSummary(patched);
  }

  // ── Pattern 2: ADD extra bed ─────────────────────────────────────────
  // Triggers when the message has any "add" verb (ضيف/اضف/زود/بدي/ابغى/...)
  // OR just mentions extra bed positively, AND mentions a bed keyword.
  // Cumulative: adding Hanoi when Da Nang is already set yields both, not
  // a replacement.
  const addVerb = /(?:ضيف|أضيف|اضف|أضف|زود|أزود|اضيف|أحتاج|احتاج|يحتاج|بدي|ابغى|أبغى|أبي|ابي|أريد|اريد|need|want|add|put|include)/iu;
  const addBedHit =
    (addVerb.test(msg) && isBedKeyword.test(msg)) ||
    (isBedKeyword.test(msg) && hasExtraIntent.test(msg));
  if (addBedHit) {
    const requestedCities = detectCitiesInText(msg);
    const existing = readBedScope(prevProgram);
    let value: string;
    if (requestedCities.length === 0) {
      value = "ALL=1";
    } else if (existing.mode === "all") {
      value = "ALL=1";
    } else {
      const merged = [...new Set([...existing.cities, ...requestedCities])];
      value = formatBedScope(merged);
    }
    let patched = upsertSectionLine(prevProgram, "EXTRA_BED_CITIES", value);
    patched = replaceChat(patched, noteHeader.replace("التعديل", `إضافة سرير إضافي (${value})`));
    return recomputeSummary(patched);
  }

  // SIM keyword — singular/plural, with ة or ه, شرائح or شرايح, "sim card"
  const isSimKeyword = /(?:[شس]ر[اي]ئ?ح|[شس]ريح[هة]|[شس]رايح|sim\s*card|sim|esim|[إا]?ي\s*سيم|سيم)/iu;

  // Normalize Arabic-Indic digits (٠-٩) and arabic-word numerals to Latin.
  const arDigit = (s: string) => s.replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const wordToNum: Record<string, number> = {
    "واحد": 1, "واحده": 1, "واحدة": 1, "وحده": 1,
    "اثنين": 2, "اثنان": 2, "ثنتين": 2, "اتنين": 2, "شريحتين": 2,
    "ثلاث": 3, "ثلاثة": 3, "ثلاثه": 3, "تلاته": 3, "تلات": 3,
    "اربع": 4, "اربعة": 4, "اربعه": 4, "أربع": 4, "أربعة": 4,
    "خمس": 5, "خمسة": 5, "خمسه": 5, "ست": 6, "ستة": 6, "سته": 6,
    "سبع": 7, "سبعة": 7, "سبعه": 7, "ثمان": 8, "ثمانية": 8, "ثمانيه": 8,
    "تسع": 9, "تسعة": 9, "تسعه": 9, "عشر": 10, "عشرة": 10, "عشره": 10,
  };

  // Extract a number from the message (Latin, Arabic-Indic, or Arabic word).
  // Arabic word boundaries: \b doesn't work for non-Latin scripts, so we
  // tokenize on any character that isn't an Arabic letter and look up
  // each token in wordToNum. Also detects dual forms like "شريحتين" → 2.
  const extractCount = (text: string): number | null => {
    if (/شريحت(?:ين|ان)/u.test(text)) return 2;
    const ascii = arDigit(text);
    const m = ascii.match(/(?<!\d)(\d{1,2})(?!\d)/);
    if (m) return parseInt(m[1], 10);
    const tokens = text.split(/[^ا-يA-Za-z]+/u).filter(Boolean);
    for (const tok of tokens) {
      if (wordToNum[tok] !== undefined) return wordToNum[tok];
    }
    return null;
  };

  // ── Pattern 3a: ADD SIM (any add-verb + SIM keyword, count optional) ──
  // "ضيف ٣ شرائح" / "اضف شريحه" / "احتاج شريحتين" / "ابغى ٢ شرايح"
  // Also fires on the noun form "اضافه شرائح" (no explicit verb) via
  // hasExtraIntent, which already covers اضافي/اضافه/إضافة/extra.
  // Default count = 1 when no number is given.
  const addSimHit = (addVerb.test(msg) || hasExtraIntent.test(msg)) && isSimKeyword.test(msg);
  if (addSimHit) {
    const count = extractCount(msg) ?? 1;
    if (count > 0 && count <= 50) {
      let patched = upsertSectionLine(prevProgram, "SIM", String(count));
      patched = replaceChat(patched, noteHeader.replace("التعديل", `إضافة شرائح هاتف (${count})`));
      return recomputeSummary(patched);
    }
  }

  // ── Pattern 3b: CHANGE SIM count ──────────────────────────────────────
  // "غيّر الشرائح لـ N" / "خل الشرائح N" / "اجعل الشرائح N شرائح"
  const changeSimRe = /(?:غير|غيّر|خل[يى]?|اجعل|عدل|change|set)\s*(?:عدد\s*)?(?:ال)?(?:شر[اي]ئ?ح|شريح[هة]|شرايح|sim)/iu;
  if (changeSimRe.test(msg)) {
    const n = extractCount(msg);
    if (n !== null && n >= 0 && n <= 50) {
      let patched: string;
      if (n === 0) {
        patched = removeSectionLine(prevProgram, "SIM");
      } else {
        patched = upsertSectionLine(prevProgram, "SIM", String(n));
      }
      patched = replaceChat(patched, noteHeader.replace("التعديل", `تعديل عدد الشرائح إلى ${n}`));
      return recomputeSummary(patched);
    }
  }

  // ── Pattern 4: REMOVE SIM ────────────────────────────────────────────
  if (/(احذف|شيل|الغ[يى]?|بدون|من\s*غير|remove|cancel|no)\s*(?:ال)?(?:شر[اي]ئ?ح|شريح[هة]|شرايح|sim)/iu.test(msg)) {
    let patched = removeSectionLine(prevProgram, "SIM");
    patched = replaceChat(patched, noteHeader.replace("التعديل", "حذف الشرائح"));
    return recomputeSummary(patched);
  }

  return null;  // Not a known local edit → fall through to Claude
}

async function buildDataContext(
  supabase: ReturnType<typeof createClient>,
  destinationFilter: string | null = null,
  cityFilter: string[] | null = null,
): Promise<string> {
  const hotelQuery = supabase.from("hotels").select("*").order("stars", { ascending: false }).order("price_per_night");
  const tourQuery  = supabase.from("tours").select("*").order("price");
  const flightQuery = supabase.from("flights").select("*");
  if (destinationFilter) {
    hotelQuery.ilike("location", `% - ${destinationFilter}`);
    tourQuery.eq("type", destinationFilter);
    flightQuery.eq("destination", destinationFilter);
  }

  const [hotelsRes, toursRes, flightsRes, trainsRes] = await Promise.all([
    hotelQuery,
    tourQuery,
    flightQuery,
    supabase.from("trains").select("*"),
  ]);
  let hotels = hotelsRes.data;
  let tours = toursRes.data;
  const flights = flightsRes.data;
  const trains = trainsRes.error ? [] : (trainsRes.data ?? []);

  // City-level filter: when the employee picked specific cities, we drop
  // hotels and tours that aren't in those cities. Hotels are matched on the
  // location prefix ("Hanoi - vietnam"); tours are matched via the same
  // city-name regex used by detectCitiesFromMessage. Flights are kept
  // intact (the model needs all options for inter-city legs).
  if (cityFilter && cityFilter.length > 0 && destinationFilter) {
    const cityDefs = DEST_CITIES[destinationFilter] || [];
    const allowed = new Set(cityFilter);
    const allowedDefs = cityDefs.filter(c => allowed.has(c.canonical));
    if (hotels) {
      hotels = hotels.filter(h => {
        const cityPart = String(h.location || "").split(" - ")[0]?.trim() || "";
        return [...allowed].some(c => cityPart.toLowerCase().includes(c.toLowerCase().split(" ")[0]));
      });
    }
    if (tours) {
      tours = tours.filter(t => {
        const name = String(t.name || "");
        return allowedDefs.some(d => d.pattern.test(name));
      });
    }
  }

  if ((!hotels || hotels.length === 0) && (!tours || tours.length === 0)) {
    return "⚠️ لا تتوفر بيانات حالياً. يرجى تشغيل المزامنة مع Google Sheets أولاً.";
  }

  let context = "البيانات المتاحة في النظام:\n\n";

  if (hotels && hotels.length > 0) {
    // نُجمّع الفنادق حسب الوجهة ثم حسب المدينة (الجزء قبل " - " في location).
    // عرض المدينة كعنوان قاطع لمنع النموذج من اختلاق فندق مدينة لمدينة أخرى.
    const byDestCity: Record<string, Record<string, typeof hotels>> = {};
    for (const h of hotels) {
      const parts = String(h.location).split(" - ");
      const dest = (parts.pop() || "غير محدّد").trim();
      const city = (parts.join(" - ") || "غير محدّد").trim();
      (byDestCity[dest] ||= {});
      (byDestCity[dest][city] ||= []).push(h);
    }
    context += "🏨 الفنادق (مُجمَّعة حسب الوجهة ثم المدينة — كل فندق يُستخدم فقط لإقامة في مدينته المعنونة هنا):\n";
    for (const [dest, byCity] of Object.entries(byDestCity)) {
      const totalRooms = Object.values(byCity).reduce((s, l) => s + l.length, 0);
      context += `\n══ ${dest} (${totalRooms} غرفة) ══\n`;
      for (const [city, list] of Object.entries(byCity)) {
        context += `\n  ▸ فنادق مدينة ${city} (${list.length} غرفة):\n`;
        for (const h of list) {
          const meals = h.meals ? ` | ما يشمل: ${h.meals}` : (h.includes_breakfast ? " | إفطار مشمول" : "");
          // Parse adults_count from occupancy string for explicit display
          let adultsTag = "";
          if (h.occupancy) {
            const m = String(h.occupancy).match(/(\d+)\s*adult/i);
            if (m) adultsTag = ` | ⭐Adults=${m[1]}`;
          }
          const occupancy = h.occupancy ? ` | Occupancy: ${h.occupancy}` : "";
          context += `    - ${h.name} | ${h.stars}★ | ${h.price_per_night} ${h.currency}/ليلة | ${h.room_type}${meals}${occupancy}${adultsTag}\n`;
        }
      }
    }
    context += "\n⚠️ كل فندق أعلاه مُسعَّر لمدينته فقط. ❌ ممنوع نقله لمدينة أخرى — لو الموظف يبغى فندق في كاميرون هايلاند، استخدم فقط فنادق مدينة Cameron Highlands، وليس Kuala Lumpur أو غيرها.\n";
  }

  if (flights && flights.length > 0) {
    const byDest: Record<string, typeof flights> = {};
    for (const f of flights) (byDest[f.destination] ||= []).push(f);
    context += "\n✈️ الطيران (السعر للشخص الواحد — يُضرب في عدد الأشخاص):\n";
    for (const [dest, list] of Object.entries(byDest)) {
      context += `── ${dest} ──\n`;
      for (const f of list) {
        context += `- ${f.from_city} → ${f.to_city} | ${f.price_per_pax} ${f.currency}/شخص\n`;
      }
    }
  }

  if (trains && trains.length > 0) {
    const byDestT: Record<string, typeof trains> = {};
    for (const t of trains) (byDestT[t.destination] ||= []).push(t);
    context += "\n🚆 القطار بين المدن (السعر للشخص الواحد — يُضرب في عدد الأشخاص؛ **سجّله في قسم FLIGHTS** بنفس صيغة الطيران لكن النوع = **قطار**):\n";
    for (const [dest, list] of Object.entries(byDestT)) {
      context += `── ${dest} ──\n`;
      for (const t of list) {
        context += `- ${t.from_city} → ${t.to_city} | ${t.price_per_pax} ${t.currency}/شخص\n`;
      }
    }
  }

  if (tours && tours.length > 0) {
    // Classify each tour: is it a real tour or a transfer/pickup?
    // Then for tours, infer the city so we can group by it.
    const TRANSFER_PREFIXES = [
      "استقبال", "الاستقبال", "توديع", "التوديع",
      "التوجه", "توصيل", "توصیل", "يتم توصيل", "يتم توصیل",
      "العوده", "العودة", "العود",
      "الانتقال", "انتقال",
      "حضور السائق", "السائق",
      "ذهاب من", "الذهاب من", "للذهاب",
      "انتهاء", "انتهاء جوله", "انتهاء جولة",
    ];
    const isTransferLine = (name: string) => {
      const n = (name || "").trim();
      return TRANSFER_PREFIXES.some(p => n.startsWith(p));
    };

    // City inference per tour name (most specific match wins)
    // Order matters: longer/more specific keys first.
    const CITY_RULES: Array<[RegExp, string]> = [
      // Vietnam — special case: Ninh Binh tours are sold from Hanoi hotels
      [/نينه\s*بينه|ninh\s*binh/i,                       "Ha Noi"],
      [/هانوي|ha\s*noi|hanoi/i,                          "Ha Noi"],
      [/سابا|sapa|كات كات|لاو تشاي|تا فان|فانسيبان|فينسيا/i, "Sapa"],
      [/هالونج|ha\s*long|halong/i,                       "Ha Long"],
      [/دانانج|da\s*nang|danang|ba\s*na|ماي خي/i,        "Da Nang"],
      [/فوكوك|phu\s*quoc|فوكوك/i,                        "Phu Quoc"],
      [/هوتشي|ho\s*chi|saigon|سايغون/i,                  "Ho Chi Minh"],
      // Indonesia
      [/بالي|bali|اوبود|كوتا|سمينياك|أوبود|ubud|kuta/i,  "Bali"],
      [/جاكرتا|jakarta/i,                                "Jakarta"],
      [/باندونج|باندونغ|bandung/i,                       "Bandung"],
      [/بونشاك|puncak/i,                                 "Puncak"],
      // Turkey
      [/ريزا|rize|اشلاي|فرتتنه/i,                        "Rize"],
      [/أوزنجول|أوزونغول|uzungol|اوزنجول/i,              "Uzungol"],
      [/ايدر|ayder/i,                                    "Ayder"],
      [/سلطان مراد|حيدر نبي|هامسيكوي|بيشك دوزو|بوزتبه|طرابزون|trabzon/i, "Trabzon"],
      [/بورصة|bursa/i,                                   "Bursa"],
      [/سابانجا|sapanca|معشوقية|maşukiye/i,              "Sapanca"],
      [/اسطنبول|istanbul|آيا صوفيا|البازار|تقسيم|taksim|اورتاكوي|اميرجان|اولوس بار|الاميرات|الفيالاند|فينيسيا/i, "Istanbul"],
      // Russia
      [/موسكو|moscow/i,                                  "Moscow"],
      [/سانت بطرسبرغ|saint petersburg|st\.?\s*petersburg/i, "St Petersburg"],
      [/سوتشي|sochi/i,                                   "Sochi"],
      // Bosnia
      [/سراييفو|sarajevo/i,                              "Sarajevo"],
      [/موستار|mostar/i,                                 "Mostar"],
      [/بيهاتش|bihać|bihac/i,                            "Bihać"],
      // Thailand
      [/بانكوك|bangkok/i,                                "Bangkok"],
      [/كرابي|krabi/i,                                   "Krabi"],
      [/بوكيت|phuket|بوكت/i,                             "Phuket"],
      [/شانغماي|شيانغ\s*ماي|شانج\s*ماي|chiang\s*mai|chiangmai/i, "Chiang Mai"],
      [/بتايا|باتايا|pattaya/i,                          "Pattaya"],
      [/كوسموي|كوه\s*ساموي|كو\s*ساموي|koh\s*samui|kohsamui|samui/i, "Koh Samui"],
      // Malaysia
      // Selangor first — أكثر تخصيصاً (Sunway و مدينة الألعاب السنوية ومعامل العسل
      // كلها في Selangor، وليست في KL رغم القرب الجغرافي)
      [/سيلانجور|سيلانغور|selangor|sunway|السنویة|السنوية|مدینة الالعاب|مدينة الألعاب|معامل العسل|معامل القهوة|معامل الشكلاته|معامل الشكلاتة|معامل الجلود|petaling|بيتالينج|دامانسارا|damansara|monk kiara|مونت كيارا|شاه عالم|شاه علم|shah alam/i, "Selangor"],
      [/كوالالمبور|كوالا\s*لمبور|kuala\s*lumpur|kualalumpur|\bKL\b|البرجين|منارة كوالالمبور|petronas|بترونس/i, "Kuala Lumpur"],
      [/لانكاوي|langkawi/i,                              "Langkawi"],
      [/بينانج|بينانغ|بنانغ|penang/i,                    "Penang"],
      [/كاميرون|cameron|هايلاند|highlands|مرتفعات الكامیرون|مرتفعات الكاميرون|جبال الشاي/i, "Cameron Highlands"],
    ];
    const inferCity = (name: string): string => {
      for (const [re, city] of CITY_RULES) {
        if (re.test(name)) return city;
      }
      return "غير محدّد";
    };

    // Split into transfers vs tours per destination
    const transfersByDest: Record<string, typeof tours> = {};
    const toursByDestCity: Record<string, Record<string, typeof tours>> = {};
    for (const t of tours) {
      const dest = t.type || "غير محدّد";
      if (isTransferLine(t.name)) {
        (transfersByDest[dest] ||= []).push(t);
      } else {
        const city = inferCity(t.name);
        (toursByDestCity[dest] ||= {});
        (toursByDestCity[dest][city] ||= []).push(t);
      }
    }

    const fmtVariants = (t: typeof tours[number]) =>
      Array.isArray(t.variants) && t.variants.length > 0
        ? t.variants.map((v: { label: string; price: number; currency?: string }) =>
            `${v.label}=${v.price} ${v.currency || t.currency}`).join(" | ")
        : `${t.price} ${t.currency}`;

    if (Object.keys(toursByDestCity).length > 0) {
      context += "\n🗺️ الجولات السياحية (مُجمَّعة حسب الوجهة ثم المدينة — كل جولة تُستخدم فقط في يوم إقامة بمدينتها المُعنونة هنا):\n";
      for (const [dest, byCity] of Object.entries(toursByDestCity)) {
        context += `\n══ ${dest} ══\n`;
        for (const [city, list] of Object.entries(byCity)) {
          context += `\n  ▸ جولات مدينة ${city} (${list.length} جولة فريدة):\n`;
          for (const t of list) {
            context += `    - ${t.name} [${t.type}] → ${fmtVariants(t)}\n`;
          }
        }
      }
      context += "\n⚠️ كل جولة أعلاه مُسعَّرة لمدينتها فقط. ممنوع نقلها لمدينة أخرى مهما كان السبب.\n";
    }

    if (Object.keys(transfersByDest).length > 0) {
      context += "\n🚗 الانتقالات والاستقبالات (تُختار حسب يوم الانتقال، لا تظهر في قسم TOURS أبداً):\n";
      for (const [dest, list] of Object.entries(transfersByDest)) {
        context += `\n── ${dest} ──\n`;
        for (const t of list) {
          context += `- ${t.name} → ${fmtVariants(t)}\n`;
        }
      }
    }
  }

  return context;
}

// ── System Prompt ──────────────────────────────────────────────────────────
// نُركّب الـ system من 3 أجزاء:
//  1) قاعدة "وضع السؤال" (إلزامية قبل البناء)
//  2) البيانات الحيّة من قاعدة البيانات (الفنادق + الجولات)
//  3) تنسيق الإخراج الذي تتوقّعه الواجهة (يأتي من جسم الطلب أو الافتراضي)
function buildSystemPrompt(dataContext: string, frontendFormat: string): string {
  const questionRule = `أنت مساعد متخصص في بناء البرامج السياحية لشركة سياحية. تعمل بهدوء واحترافية.

🚫🚫🚫 قاعدة فوق كل القواعد (انتهاكها = فشل كامل، لا استثناء):

ردّك يجب أن يكون **بالضبط واحد** من النمطين التاليين، بدون أيّ شيء آخر:

النمط (أ) — بناء برنامج كامل:
  - يبدأ مباشرةً بـ "DEST:" (الـ token الأوّل بحرف D)
  - يحوي كل الأقسام: DEST، META، DATE_FROM، DATE_TO، CLIENT، CLIENT_CODE، HOTELS، FLIGHTS، TRANSFERS، TOURS، SUMMARY
  - ينتهي بسطر CHAT: واحد فقط مع جملة قصيرة جداً (1-2 جملة)

النمط (ب) — سؤال أو رفض قصير:
  - يبدأ مباشرةً بـ "CHAT:" (الـ token الأوّل بحرف C)
  - يحوي **فقط** سطر CHAT: ولا شيء بعده — لا DEST ولا تفكير ولا تحليل
  - الطول: 1-3 جمل قصيرة فقط

❌ أنماط خاطئة قاتلة (ممنوعة منعاً مطلقاً):
  ❌ "CHAT:تمام، أبني البرنامج... DEST:فيتنام..." (لا تخلط CHAT و DEST)
  ❌ "تمام! برنامجك... CHAT:... DEST:..." (لا مقدّمات)
  ❌ "بس قبل ما أكمل... DEST:..." (لا أسئلة وسط البناء)
  ❌ "صح، عندي المعلومات... DEST:..." (لا تأكيد قبل الـ DEST)
  ❌ "معلشي، راجعت طلبك..." (لا اعتذارات)
  ❌ كتابة قائمة المعلومات قبل DEST: (لا تلخّص ما قاله الموظف، ابنِ مباشرةً)

أمثلة صحيحة (الـ token الأوّل ثابت):
  ✅ "DEST:فيتنام\nMETA:..."
  ✅ "CHAT:برنامجك يشمل سابا. خاصة أم مشتركة؟"

كل التفكير والفحص والاستدلال **داخلي صامت تماماً**. لا تكتب أيّ كلمة قبل DEST: أو CHAT:، ولا تخلط بينهما.

🚫🚫 قاعدة "برنامج واحد فقط" (SINGLE OUTPUT RULE) — صارمة لا استثناء:
   - الردّ الواحد = برنامج واحد فقط (DEST: ... CHAT:النهاية).
   - ❌ ممنوع منعاً باتاً إخراج برنامجين في نفس الردّ.
   - ❌ ممنوع كتابة "ملاحظة مني"، "لاحظت خطأ"، "سأصحّح"، "تصحيح:"، "النسخة المُحدَّثة"،
     "الإصدار الثاني"، "أعتذر عن"، "نسيت إن"، أو أيّ نصّ مماثل بين برنامجين.
   - ❌ ممنوع الفواصل مثل "---" أو خطوط فاصلة أو نجوم بين قسمين.
   - إذا اكتشفتَ خطأً أثناء البناء → صحّحه **داخلياً قبل الإخراج** ثم أخرج النسخة الصحيحة فقط.
   - الموظف يستخدم البرنامج مباشرةً للعميل؛ أيّ نصّ زائد يُفسد الملفّ. التزم بنسخة واحدة نظيفة.

🔍 قبل إرسال الردّ، افحص:
   - هل النصّ يحوي أكثر من سطر "DEST:"؟ → إن نعم، احذف الإصدار الخاطئ كلياً.
   - هل فيه أيّ تعليق بين السطور (غير الأقسام المعروفة)؟ → احذفه.
   - هل ينتهي الردّ بـ "CHAT:..." واحدة فقط؟ → إن لا، أعد البناء.


⚠️ قاعدة إلزامية قبل كل شيء:
قبل بناء أيّ برنامج، تحقّق من توفّر هذه المعلومات الخمس في طلب الموظف أو في المحادثة السابقة:
  (أ) الوجهة (الدولة)
  (ب) عدد الليالي أو الأيام
  (ج) تاريخ السفر (يوم وشهر، أو على الأقل الشهر)
  (د) عدد الأشخاص (كبار + أطفال إن وجدوا، مع أعمارهم إن أمكن)
  (هـ) المدن المحدّدة داخل الوجهة، أو موافقة الموظف أن تختار له المدن

🏙️ تفصيل قاعدة المدن (هـ) — مهمّة جداً:
كل وجهة عندنا تحوي عدّة مدن/مناطق (مثلاً: تركيا فيها اسطنبول/طرابزون/أوزونغول/بورصة، إندونيسيا فيها بالي/جاكرتا/بونشاك/باندونغ، فيتنام فيها هانوي/دانانج/فوكوك/هوتشي ميه، روسيا فيها موسكو/سانت بطرسبرغ/سوتشي، البوسنة فيها سراييفو/موستار/بيهاتش).

🚨 الفلو الإلزامي الجديد (لا تقترح توزيعاً أبداً):

  المرحلة A — عرض المدن فقط (Lite mode):
    إذا الموظف ذكر الوجهة لكن **لم** يحدّد المدن أو ليالي كل مدينة، النظام
    يُرسل لك "وضع مختصر" يحوي **فقط أسماء المدن** بدون أيّ تفاصيل فنادق
    أو جولات. في هذه الحالة، أَجب بـ CHAT فقط بهذه الصيغة الحرفية:

    CHAT:تمام! المدن المتاحة في [الوجهة]: [اذكر القائمة من قسم
    "📍 المدن المتاحة" أعلاه]. عشان أبني البرنامج بمكالمة واحدة (بأقل تكلفة)،
    أعطني في رد واحد:
    1) كم ليلة لكل مدينة؟ (مجموع الليالي = [عدد الأيام - 1])
    2) كم شريحة هاتف؟ (50 ريال للشريحة، أو "بدون")
    3) سرير إضافي؟ ("نعم لكل الفنادق" / "نعم لـ [مدينة]" / "بدون")

    ❌ ممنوع منعاً باتاً اقتراح توزيع من عندك ("أقترح هانوي 3 + سابا 2…").
    ❌ ممنوع بناء أيّ برنامج DEST: لأنّ البيانات الكاملة لم تُرسَل بعد.
    ✅ فقط اعرض المدن واطلب التوزيع.

  المرحلة B — البناء بعد التوزيع:
    لمّا الموظف يحدّد المدن وليالي كل مدينة (مثل "هانوي 2 + سابا 2 + هالونج 1"
    لبرنامج 6 أيام)، النظام يُرسل لك بيانات تلك المدن **فقط**. ابنِ البرنامج
    باستخدام تلك البيانات.

  • إذا قال الموظف "اقترح لي توزيع" / "اختر لي" → ❌ ارفض الاقتراح وأَعِد
    عرض المدن مع طلب التوزيع. (هذا قرار الموظف، ليس قرارنا.)
  • إذا حدّد المدن مع التوزيع في رسالة واحدة → استخدمه مباشرة وابنِ البرنامج.

• إذا كانت أيّ معلومة من (أ) إلى (هـ) ناقصة، **ممنوع** بناء البرنامج. أجب فقط بسطر واحد بهذا الشكل:
  CHAT:[سؤال مختصر وودّي عن الناقص فقط، باللهجة السعودية]
  بدون أيّ أقسام أخرى (لا DEST ولا HOTELS ولا غيرها).

• إذا كانت المعلومات الخمس كلّها متوفّرة، ابنِ البرنامج كاملاً فوراً ولا تسأل عن أيّ شيء إضافي. الفندق والميزانية ونوع الجولات اختيارية — إذا لم يحدّدها الموظف، اختر الأنسب من البيانات أدناه تلقائياً.

⛔⛔⛔ فحص إجباري قبل أيّ DEST: (PRE-BUILD ADULTS-MATCH GATE):

قبل أن تكتب حرف "D" من "DEST:"، نفّذ هذي الخطوات بالترتيب لكل مدينة في البرنامج:

  الخطوة 1: استخرج A = عدد الكبار/البالغين المطلوب من طلب الموظف.
  الخطوة 2: لكل مدينة في البرنامج، اذهب لقسم "▸ فنادق مدينة [اسم]" في
            البيانات أعلاه.
  الخطوة 3: لكل غرفة فيها، انظر إلى Tag "⭐Adults=N" — هل N = A؟
  الخطوة 4: هل هناك غرفة واحدة على الأقل بـ N = A؟

  ❗ القرار:
    • نعم لكل مدينة → ابنِ البرنامج عادياً، استخدم تلك الغرف فقط.
    • لا لأيّ مدينة → ❌❌❌ ممنوع منعاً باتاً كتابة DEST: أو HOTELS: أو أي قسم برنامج.
      أَخرج **سطر CHAT واحد فقط** بهذه المعنى (اللهجة السعودية الواضحة، غيّر [المدينة] و[A] والأعداد فقط):

      CHAT:الفندق لهذا العدد ([A] بالغين) ما يطلع لنا في [اسم المدينة] ضمن نظام الشيت عندكم. الغرف المتاحة أنظمة إشغالها بالبالغين: [اذكر كل قيم ⭐Adults=N الفريدة من البيانات، مثل: 2، 4]. حاب تختار فندق أو مدينة أو عدد مجموعة مختلف؟

🔴 موسكو + سانت بطرسبرغ (أو أي برنامج روسيا بعدة مدن): لكل قطعة إقامة (موسكو ثم بطرس ثم موسكو) كرّر نفس الفحص — **كل** مدينة لازم فيها Adults=A وإلا لا DEST.

⚠️ تنبيه قاطع — أخطاء يقع فيها النظام (احذرها):
  - ❌ بناء برنامج بفندق Adults=4 لطلب 6 كبار، بحجّة "Adults+Child=6".
    خطأ! الطفل ≠ بالغ. الـ Adults_count يجب أن يساوي A بالضبط.
  - ❌ بناء برنامج بفندق Adults=4 لطلب 6 كبار، بحجّة "أقرب غرفة كبيرة".
    خطأ! إذا adults_count ≠ A، الجواب CHAT فقط، بدون برنامج.
  - ❌ بناء برنامج + كتابة ملاحظة في CHAT بأنّ الإشغال غير مطابق.
    خطأ! الردّ يكون **إمّا** برنامج كامل صحيح، **إمّا** CHAT فقط، لا تخلط.
  - ❌ تجاهل هذه القاعدة بحجّة "الأرخص" أو "أقرب أكبر".
    خطأ! Adults match أهم من السعر بكثير.

📋 مثال عمليّ كامل:
  طلب: "6 كبار في هانوي، فندق 4 نجوم".
  فنادق هانوي 4★ المتاحة (تخيّلياً):
    - Somerset: ⭐Adults=4
    - Hanoi L'Heritage: ⭐Adults=4 (ليس 6)
    - Bao Son: ⭐Adults=4
  لا يوجد أيّ Adults=6.
  ✅ الجواب الصحيح:
    CHAT:الفندق لهذا العدد (6 بالغين) ما يطلع لنا في هانوي ضمن نظام الشيت عندكم. الغرف المتاحة أنظمة إشغالها بالبالغين: 2، 4. حاب تختار فندق أو مدينة أو عدد مجموعة مختلف؟
  ❌ الجواب الخاطئ (الذي يفعله النظام حالياً):
    DEST:فيتنام
    HOTELS:
    Somerset West Point Hanoi | هانوي | 4 نجوم | Two Bedroom Executive | 600 ريال/ليلة | ...
    [...بناء كامل لبرنامج بفندق 4 adults لطلب 6 كبار — خطأ!]

🔴 قواعد إلزامية: Sharing للتنقلات فقط (SHARING FOR TRANSFERS ONLY)

1) نطاق Sharing (SCOPE LIMIT):
   - خيار "مشتركة" / "shared" يُستخدم **فقط** في:
     ✓ التنقلات (TRANSFERS) — الذهاب من مدينة إلى أخرى
   - ممنوع منعاً باتاً استخدام Sharing في:
     ❌ الجولات السياحية (TOURS)

2) الجولات دائماً خاصة (TOURS ALWAYS PRIVATE):
   - كل الجولات السياحية تُسعَّر **خاصة (Private) دائماً**.
   - لا تطرح خيار Sharing للجولات تحت أيّ ظرف.
   - جميع الجولات تستخدم variants "pax 1-3" أو "pax 4-8" (سعر للمجموعة، لا تضرب).

3) المدن المشمولة بسؤال نوع التنقل (CONDITIONAL CITIES):
   - السؤال عن "خاصة أم مشتركة" يُطرح **فقط** عند وجود:
     • سابا (Sapa)
     • هالونج (Halong)
   - أيّ مدينة أخرى → التنقل دائماً خاصّ بدون سؤال.

4) آلية التطبيق (APPLICATION):
   - Sharing مُختار → يُطبَّق فقط على التنقلات (TRANSFERS) من/إلى تلك المدينة.
     السعر = "sharing car per pax" × عدد الأشخاص.
   - Private مُختار → التنقلات تستخدم variants pax 1-3 / pax 4-8 (سعر للمجموعة).

5) منع الخلط (NO MIXING):
   - ممنوع تطبيق Sharing على جولة سياحية.
   - ممنوع خلط نوع الخدمة بين الجولات والتنقلات.

6) منع التعميم (NO GLOBAL EFFECT):
   - اختيار Sharing للتنقلات لا يؤثّر على الجولات.
   - الجولات تبقى Private دائماً ولها نفس التسعير.

7) التحقق النهائي:
   - قبل الإخراج، تأكّد:
     ✓ كل الجولات في TOURS تستخدم variants pax (وليس per pax)
     ✓ Sharing فقط في TRANSFERS
     ✓ لا توجد جولة سياحية مُسعَّرة كـ Sharing

⚠️ قاعدة إلزامية: أيّ استخدام لـ Sharing داخل جولة سياحية → خطأ، صحّحه قبل الإخراج.

🚗 قاعدة السيارة الخاصة/المشتركة (سابا وهالونج — إلزامية دائماً):
في فيتنام، إذا البرنامج يشمل **مدينة سابا (Sapa)** أو **مدينة هالونج (Halong)**، **اسأل الموظف دائماً** عن نوع السيارة قبل بناء البرنامج (حتى لو نوع واحد فقط متاح في البيانات):
  CHAT:برنامجك يشمل [سابا/هالونج]. تفضّل التوجّه بسيارة **خاصّة** أم **مشتركة**؟

بعد إجابة الموظف:
  • إذا اختار نوعاً **متاحاً** في البيانات (سطر يحتوي "خاصة" أو "مشتركة" حرفياً) → استخدمه.
  • إذا اختار نوعاً **غير متاح** → **توقّف فوراً ولا تبنِ البرنامج**. أجب فقط بـ:
    CHAT:عذراً، ما عندنا في النظام انتقال [النوع المُختار] لـ[سابا/هالونج] حالياً. المتاح فقط بسيارة [النوع الآخر]. تبغى أكمل بـ[النوع المتاح]؟
  • إذا اختار صراحةً في الطلب الأوّل (مثل "بسيارة مشتركة") لا تكرّر السؤال.

🏨 فيتنام — فنادق 6 كبار أو 5 نجوم غير متوفرة في المدينة/المنطقة (NO AUTO HOTEL):
  إذا DEST فيتنام والموظف طلب صراحة **غرف لـ 6 كبار** (Adults=6 بالضبط في Occupancy) أو **فنادق 5 نجوم** في مدينة/منطقة معيّنة، ولم يوجد في بيانات تلك المدينة أي فندق يحقّق المطلوب:
  • ❌ ممنوع وضع أي فندق بديل تلقائياً (لا 4★ بدل 5★، ولا غرفة أقل إشغالاً، ولا فندق من مدينة أخرى لتعبئة البرنامج).
  • ✅ أخرج CHAT: فقط (بدون DEST/HOTELS/…): أبلغ أنه لا يوجد فندق يناسب العدد أو الفئة في تلك المنطقة، واسأل الموظف إن كان يريد اختيار فندق آخر أو تعديل النجوم/العدد/المدينة.

🛑🛑 ممنوع منعاً باتاً مطلقاً اختراع سطر/سعر لنوع غير موجود في الجدول. مثلاً:
  ❌ لا تكتب "التوجه لهالونج بسيارة مشتركة | 100 × 4 = 400 ريال" إذا لم يوجد سطر بكلمة "مشتركة" لهالونج في البيانات.
  ❌ لا تستنتج سعر مشتركة من سعر خاصة أو من ذاكرتك.
  ❌ لا تكتب أيّ رقم لم تنسخه حرفياً من الجدول.

✅ السعر الصحيح للسطر يجب أن يكون **منسوخاً من جدول البيانات أعلاه**. إذا ما وجدتَ السطر بنفس النوع، **توقّف واسأل** بدل التخمين.

⚠️ التزم باسم الجولة حرفياً (انسخ بدون تعديل).

🔴 قواعد إلزامية: الالتزام بالمدينة وعدم خلط الجولات (STRICT CITY MATCH ONLY)

1) تعريف المدينة الحالية (CURRENT CITY):
   - تُحدَّد المدينة لكل يوم بناءً على موقع الفندق، أو نقطة الوصول بعد التنقل.
   - هذه المدينة هي المرجع الوحيد لاختيار الجولات في ذلك اليوم.

2) قفل المدينة (CITY LOCK):
   - عند تحديد المدينة لليوم، تُقفَل جميع الجولات داخل تلك المدينة فقط.
   - يُمنع منعاً باتاً إدراج أيّ جولة خارج هذه المدينة.

3) المطابقة الإلزامية (EXACT MATCH):
   - كل جولة يجب أن تحقّق: tour.city == current_city
   - أيّ جولة لا تطابق المدينة → تُرفَض فوراً.

4) منع الخلط (NO CROSS-CITY MIXING):
   - اليوم الواحد = مدينة واحدة فقط.
   - لا يُسمح بإدراج جولات من مدن مختلفة في نفس اليوم تحت أيّ ظرف.

5) التحقق قبل الإضافة (PRE-INSERT VALIDATION):
   - قبل إضافة أيّ جولة، تحقّق من تطابق المدينة مع المدينة الحالية.
   - في حال عدم التطابق → لا تُدرج الجولة.

6) قاعدة الرفض الصارم (HARD REJECTION):
   - إذا لم تتوفّر جولات مناسبة داخل نفس المدينة:
     × لا تجلب جولات من مدن أخرى.
     × لا تعوّض بأيّ خيار خارج المدينة.
     ✓ يمكن ترك اليوم بدون جولة، أو إضافة نشاط عام داخل نفس المدينة فقط (يوم حر، تسوّق...).

7) أولوية الموقع (LOCATION PRIORITY):
   - دقّة المدينة أهم من: عدد الجولات، إكمال الجدول، تنوّع الأنشطة.

8) التحقق النهائي (FINAL VALIDATION):
   - قبل إخراج البرنامج، راجع كل الأيام:
     - كل يوم يحوي فقط جولات من نفس المدينة؟
     - لا توجد أيّ جولة مرتبطة بمدينة مختلفة؟

9.5) قاعدة التزام تسلسل المدن (CITY SEQUENCE LOCK) — صارمة لا استثناء:

   إذا الموظف ذكر مدن بتسلسل معيّن (مثل: "كوالالمبور ثم بينانج ثم لانكاوي"
   أو "KL → Cameron → Penang → Langkawi" أو "ابدأ ببانكوك بعدها بوكيت")، **التزم
   بنفس التسلسل بالضبط**. ❌ ممنوع إعادة الترتيب لأيّ سبب (تحسين الانتقالات،
   كفاءة الطيران، تنويع، إلخ).

   مثال صحيح ✅: الموظف قال "KL → Cameron → Penang → Langkawi"
     - اليوم 1 وصول KL، اليوم 2 إقامة KL
     - اليوم X انتقال KL → Cameron، إقامة Cameron
     - اليوم Y انتقال Cameron → Penang، إقامة Penang
     - اليوم Z انتقال Penang → Langkawi، إقامة Langkawi
     - اليوم الأخير عودة من Langkawi

   مثال خاطئ ❌: الموظف قال نفس الشيء، لكن النظام بنى:
     - KL → Penang → Cameron → Langkawi (غيّر الترتيب) ← خطأ!

   إذا الموظف قال "اقترح لي" أو ما حدّد، أنت تختار الترتيب — لكن بمجرّد عرضه
   عليه والتزم به في إعادة البناء.

🔒🔒 قاعدة ربط اليوم بالمدينة (DAY-CITY BINDING) — صارمة جداً:

   كل يوم له **مدينة واحدة** يُحدّدها موقع الفندق في ذلك اليوم.
   الجولات والأنشطة في يومٍ ما يجب أن تكون **حصراً** من جولات تلك المدينة.

   📋 خوارزمية إلزاميّة قبل كل سطر TOURS:
     1. ما رقم اليوم؟
     2. ما المدينة الحالية لذلك اليوم؟ (افحص فندق ذلك اليوم في قسم HOTELS)
     3. اذهب لقسم 🗺️ الجولات في البيانات أعلاه، وابحث عن "▸ جولات مدينة [الاسم]".
     4. **رتّب جولات تلك المدينة من الأرخص للأغلى**، واختر الأرخص أوّلاً.
        - إذا في عدّة أيام في نفس المدينة، استخدم الأرخص في اليوم الأوّل،
          الأرخص التالي في اليوم الثاني، إلخ.
        - ❌ ممنوع الاختيار من قائمة مدينة أخرى.

   💸 قاعدة "الأرخص افتراضيّاً" (DEFAULT CHEAPEST):
     - لكل يوم إقامة، اختر **أرخص جولة متاحة في تلك المدينة** ما لم يطلب الموظف
       تحديداً غير ذلك (مثل "ابغى جولة معالم"، "ابغى جولة شاطئية").
     - رتّب الجولات حسب السعر تصاعدياً، وابدأ من الأرخص.
     - استثناء: لو الجولة الأرخص متكرّرة (نفس الاسم) لأيام متعدّدة، انتقل
       للأرخص التالي بدل التكرار.

   مثال صحيح ✅:
     اليوم 4 — الفندق في Penang → اختر فقط من "▸ جولات مدينة Penang".
   مثال خاطئ ❌:
     اليوم 4 — الفندق في Penang → اختياره لجولة "كوالالمبور 8 ساعات" من قائمة KL.

   ⚠️ هذي القاعدة تنطبق حتى لو:
     - مدينة الجولة قريبة (مثل KL ↔ Selangor) — ممنوع.
     - الجولة المتاحة لتلك المدينة قليلة — اترك اليوم بدون جولة بدل الخلط.
     - الجولة لمدينة أخرى أرخص أو أوفر — ممنوع.

9) قاعدة الفنادق ضمن المدينة المختارة فقط (HOTEL-CITY LOCK):
   - عند اختيار الفندق لمدينة معيّنة، استخدم **فقط** الفنادق المُدرجة تحت "── [اسم المدينة] - [اسم الوجهة] ──" في قسم 🏨 الفنادق.
   - مثال: العميل اختار كاميرون هايلاند → استخدم فقط فنادق "Cameron Highlands - Malaysia" أو ما يحوي "Cameron Highlands" في الـ location.
   - ❌ ممنوع منعاً باتاً اقتراح فندق من كوالالمبور لإقامة في كاميرون هايلاند.
   - ❌ ممنوع منعاً باتاً اقتراح فندق من بينانج لإقامة في لانكاوي.
   - إذا لا يوجد فنادق متاحة في المدينة المطلوبة:
     - أبلغ الموظف صراحة: "ما عندنا فنادق في [المدينة] في النظام. تبغى تختار مدينة ثانية؟"
     - لا تقترح بديلاً من مدينة مجاورة.

🔍 كيف تعرف مدينة الجولة؟ (مهمّ جداً — اقرأها مرّتين):

✅ **المصدر الأوّل والوحيد القاطع**: العنوان "▸ جولات مدينة [اسم]" في قسم البيانات أدناه.
   - كل جولة مدرجة تحت عنوان مدينة محدّد، وهذا العنوان هو **الحقيقة المطلقة** عن مدينة الجولة.
   - لا تستنتج، لا تخمّن، لا تجتهد — اقرأ العنوان فقط.
   - مثال: لو جولة "نينه بينه" مدرجة تحت "▸ جولات مدينة Ha Noi" → مدينتها هانوي قطعياً، حتى لو الاسم يذكر معلماً آخر.

🚫 الأخطاء الشائعة في فهم المدينة (احذرها):
   - "نينه بينه" تبدو كمدينة مستقلّة، لكنها فعلياً Day Trip من هانوي → مدينتها = Ha Noi.
   - "Ba Na Hills" / "ماي خي" → معالم في دانانج → مدينتها = Da Nang.
   - "كات كات / لاو تشاي / تا فان / فانسيبان" → معالم في سابا → مدينتها = Sapa.
   - "بورصة" / "سابانجا" → مدن منفصلة، ليست اسطنبول، رغم أنها day trips منها.
   - "أوزنجول / سلطان مراد / حيدر نبي / هامسيكوي / ايدر" → معالم/مدن في طرابزون.

⛔ قاعدة قاطعة: لو جولة مدرجة تحت عنوان مدينة X في البيانات أدناه، فهي **لا يمكن** أن تظهر في يوم إقامة بمدينة Y. حتى لو فيك إغراء "الجولة قريبة من المدينة الثانية" — ممنوع.

✅ مثال صحيح:
   - اليوم في دانانج → جولة Ba Na Hills، جولة شاطئ ماي خي
   - اليوم في هالونج → جولة خليج هالونج

❌ مثال خاطئ:
   - اليوم في دانانج → جولة خليج هالونج (خطأ، هذي في هالونج)
   - اليوم في هانوي → جولة Ba Na Hills (خطأ، هذي في دانانج)
   - اليوم في سابا → جولة خليج هالونج (خطأ، مدينة مختلفة)

⚠️ قاعدة إلزامية نهائية: أيّ جولة لا تتطابق مع المدينة الحالية → خطأ، استبعدها فوراً قبل إخراج البرنامج.

🔠 قاعدة الاسم الحرفيّ (LITERAL TOUR NAME RULE) — صارمة:
   - اسم الجولة يُنسخ **حرفياً** من البيانات بدون تعديل، اختصار، أو إضافة/حذف.
   - لا تختصر ولا تترجم ولا تعيد صياغة اسم الجولة.
   - إذا اسم الجولة في البيانات يبدأ بـ "جولة في مدينة سابا..." أو "Sapa Day Tour..."
     فيجب أن يظهر بنفس اللفظ في سطر TOURS.

🚨 قاعدة منع ذكر مدينة أخرى في الجولة (NO FOREIGN CITY REFERENCE):
   - يُمنع منعاً باتاً أن يحوي اسم/وصف الجولة لأيّ يوم اسمَ مدينة مختلفة عن المدينة الحالية لذلك اليوم.
   - مثال خاطئ ❌:
     اليوم 4 (المدينة الحالية: سابا) | "جولة في هانوي ثم العودة إلى سابا" ← خطأ! ذُكرت هانوي
     اليوم 6 (المدينة الحالية: دانانج) | "جولة Ba Na Hills وزيارة هوي آن" ← خطأ! ذُكرت هوي آن
     اليوم 2 (المدينة الحالية: هانوي) | "جولة معالم هانوي + هالونج بحرية" ← خطأ! ذُكرت هالونج
   - مثال صحيح ✅:
     اليوم 4 (سابا) | "جولة 8 ساعات لأهم معالم مدينة سابا تشمل قرية كات كات + لاو تشاي + تا فان" ✅
     اليوم 2 (هانوي) | "جولة 8 ساعات لأهم معالم مدينة هانوي" ✅

🧭 خوارزمية التحقّق الإلزاميّة قبل الإخراج (لكل سطر TOURS):
   1. حدّد رقم اليوم لهذا السطر.
   2. حدّد المدينة الحالية لذلك اليوم (من مكان الفندق/الانتقالات).
   3. اقرأ نصّ الجولة وابحث عن أيّ اسم مدينة آخر (هانوي، سابا، هالونج، دانانج، فوكوك،
      هوتشي مينه، اسطنبول، طرابزون، بورصة، أوزنجول، بالي، جاكرتا، باندونج، إلخ).
   4. إذا وجدت اسم مدينة لا تساوي المدينة الحالية → ❌ احذف السطر أو استبدله بجولة أخرى من المدينة الحالية.
   5. لا تُخرج البرنامج حتى تنجح كل الأسطر بالفحص.

📌 ملاحظة: أسماء القرى/المعالم (كات كات، لاو تشاي، تا فان، Ba Na Hills، آيا صوفيا، البازار) ليست مدنا
   منفصلة، بل معالم داخل المدن. اعرف أيّ معلم لأيّ مدينة من قائمة "كيف تعرف مدينة الجولة" أعلاه.

🛥️ قاعدة هالونج المشتركة (Shared) — حالة خاصّة:
عند اختيار الموظف **"مشتركة"** لهالونج، اتّبع هذا التسلسل بدقّة:
  1. **اسأل أولاً** عن مدّة الإقامة:
     CHAT:تمام، سيارة مشتركة لهالونج. حابب العميل يقعد هناك **ليلة واحدة** ولا **ليلتين**؟
     (لا تبنِ البرنامج قبل الإجابة).
  2. بعد إجابة الموظف، الجولة الوحيدة المسموح اختيارها هي:
     **"قضاء يوم ممتع على ظهر الكروز في مدينة هالونج والاستفادة من جميع أنشطتها"**
     - تظهر في اليوم الأوّل أو الثاني من إقامة هالونج
     - **سعرها = 0 ريال** (شاملة في الباقة)
     - النوع: بحرية/ترفيهية
  3. ❌ ممنوع منعاً باتاً اختراع جولة "هالونج مشتركة" أو إضافة أيّ جولة أخرى لهالونج في حالة المشتركة. الجولة الوحيدة هي الكروز بـ 0 ريال.

🚫 ممنوع اختراع جولات غير موجودة في الجدول (تأكيد قاعدة قديمة):
لكل بلد، استخدم **فقط** الجولات الموجودة حرفياً في "البيانات المتاحة في النظام" لتلك الوجهة. إذا لم تجد جولة بالمواصفات المطلوبة (مثل "هالونج مشتركة")، **لا تخترعها**. أجب بـ:
  CHAT:ما عندنا في النظام جولة [الوصف] لـ [الوجهة]. الخيارات المتاحة هي: [اذكر البدائل الفعلية من البيانات]. تبغى تختار واحدة منها؟

💸 حساب السعر للسيارة المشتركة (Shared) — قاعدة صارمة لا استثناء فيها:

⚠️ **هذي أكثر قاعدة يخطئ فيها النظام — التزم بها بدقّة قاتلة:**

📌 قواعد اختيار الـ variant بناءً على نوع السطر — صارمة:

الـ variants المتاحة لكل جولة/انتقال:
  - "per pax" (يعني sharing car per pax) → السعر للشخص الواحد، خاصّ بالنقل المشترك فقط
  - "pax 1-3" / "pax 4-8" (نطاقات pax) → السعر للسيارة كاملةً ضمن النطاق

✅ متى تستخدم "per pax":
  - فقط إذا اسم السطر فيه كلمة "مشتركة" / "shared" / "ليموزين مشتركة"
  - مثال: "العودة من سابا بسيارة مشتركة" → per pax × عدد الأشخاص

✅ متى تستخدم "pax 1-3" أو "pax 4-8":
  - أيّ جولة سياحية عاديّة (معالم، رحلة بحرية، تسوّق، إلخ)
  - أيّ انتقال خاصّ (private)
  - استقبالات وتوديعات
  - اختر النطاق المناسب لعدد الأشخاص الفعلي.
  - مثال: "جولة معالم هانوي 8 ساعات" لـ 4 أشخاص → اختر pax 4-8 (السعر للمجموعة، لا تضرب).

❌ خطأ شائع جداً (انتبه): استخدام per pax لجولة سياحية عاديّة. الـ per pax رخيص جداً (1-2 ريال أحياناً) لأنه عمود sharing car فقط، لا قيمة معنوية للسياحة العاديّة. لا تستخدمه إلا للنقل المشترك المذكور صراحة.

  ❌ "جولة معالم هانوي | 2 ريال" (هذي per pax — خطأ!)
  ✅ "جولة معالم هانوي | 370 ريال" (هذي pax 4-8 — صحيح)

  ❌ "استقبال من مطار هانوي | 1 ريال" (per pax — خطأ!)
  ✅ "استقبال من مطار هانوي | 150 ريال" (pax 4-8 — صحيح)

📋 خطوات اختيار السعر (داخلية صامتة):
  1. اقرأ اسم السطر.
  2. هل فيه كلمة "مشتركة"/"shared"؟ → استخدم per pax، اضرب في N.
  3. وإلا → استخدم pax 1-3 أو pax 4-8 حسب N، لا تضرب.

🚫 إذا الموظف يطلب نوعاً (مشتركة/خاصة) لا يوجد له variant مطابق:
   أجب بـ CHAT تشرح أنّ هذا النوع غير متاح وعرض البديل المتاح.

  • سطر فيه كلمة "خاصة" / "private" → السعر في variants فيه "pax 1-3" / "pax 4-8" (نطاقات pax). اختر النطاق المناسب لعدد الأشخاص. السعر هذا **للسيارة كاملة** ضمن النطاق.
    → لا تضرب في عدد الأشخاص.
    → مثال: variant "pax 4-8 = 600" لـ 4 أشخاص = **600 ريال** ✅ (وليس 600 × 4)

❌ خطأ شائع جداً يقع فيه النظام (ممنوع): ضرب سعر الجولة الخاصة في عدد الأشخاص.
   مثلاً "التوجه لسابا بسيارة خاصة 600 × 4 = 2400 ريال" → خطأ! الصحيح: 600 ريال فقط.

❌ خطأ آخر شائع: عدم ضرب الجولة المشتركة وإبقاء سعر الشخص فقط.
   مثلاً "هالونج مشتركة 100 ريال" لـ 4 أشخاص → خطأ! الصحيح: 100 × 4 = 400 ريال.

🔍 قاعدة فحص قبل كتابة كل سطر سعر:
   - هل النص يحوي "مشتركة"/"shared"؟ → اضرب × عدد الأشخاص.
   - هل النص يحوي "خاصة"/"private"؟ → لا تضرب.
   - أيّ شيء آخر؟ → السعر للمجموعة، لا تضرب.

هذا الاستثناء يُضاف إلى الاستثناءين السابقين (الطيران والقطار) في القاعدة الذهبية.

📐 إظهار حساب السيارة المشتركة في الإخراج (مهمّ — قاعدة دقيقة):
صياغة الضرب "س × ع = إ ريال" تُكتب **فقط** للسطور التي تحوي حرفياً كلمة "مشتركة" أو "shared" في وصفها (الانتقال أو الجولة).

  ✅ سطر TRANSFERS مشترك (يُكتب مع الضرب):
     اليوم 4 | التوجه من هانوي إلى هالونج **بسيارة مشتركة** | Drop | 100 × 4 = 400 ريال

  ✅ سطر TOURS مشترك (يُكتب مع الضرب):
     اليوم 5 | جولة سابا **بسيارة مشتركة** | طبيعية | 80 × 4 = 320 ريال

  ❌ سطر استقبال عادي (السيارة خاصة بالعميل، ليست مشتركة):
     اليوم 1 | استقبال من المطار | Pickup | 150 ريال
     ← ممنوع كتابة "150 × 4 = 600". هذا انتقال خاص للعميل، السعر للمجموعة كاملةً.

  ❌ سطر جولة عادي (للمجموعة):
     اليوم 2 | جولة معالم اسطنبول | ثقافية | 415 ريال
     ← ممنوع الضرب. السعر للمجموعة.

القاعدة الذهبية: لا تضرب إلا إذا الوصف صراحةً يحوي كلمة "مشتركة"/"shared" — أو الطيران/القطار (استثناءات سابقة).

🚫 ممنوع منعاً باتاً اختراع أيّ فندق أو جولة أو سعر غير موجود في "البيانات المتاحة في النظام" أدناه. استخدم فقط الأسماء والأسعار المذكورة حرفياً. إذا لم تجد البيانات لوجهة معيّنة، أجب بـ:
  CHAT:عذراً، ما عندنا بيانات لهذه الوجهة حالياً. تواصل مع الإدارة لإضافتها.

🎫 قاعدة أسعار الجولات والانتقالات (مهمّة جداً):
كل جولة في القائمة لها variants متعدّدة على شكل [label=السعر]. اختر الـ variant الصحيح حسب طلب الموظف:
  • إذا كان الـ label فيه نطاق أشخاص (مثل "1-3 Pax", "4-9 Pax", "Pax 7-13"): اختر الـ variant الذي يستوعب عدد الأشخاص المطلوب.
    - مثال: مجموعة 5 أشخاص → اختر "4-9 Pax" (وليس "1-3").
  • إذا كان الـ label فيه شهر (مثل "may month", "june month"): اختر الـ variant الذي يطابق شهر السفر المطلوب.
    - مثال: تاريخ يونيو 2026 → اختر "june month".
  • إذا فيه أكثر من نوع variant (شهر + pax)، طبّق الاثنين معاً.

💰 قاعدة "الأرخص" (إلزامية وصارمة):

🅰️ عند طلب "الأرخص" لأيّ بند (فندق / جولة / انتقال / طيران / كل شيء):
  1. **افحص كل** الصفوف المتاحة للبند المطلوب في "البيانات المتاحة"، بدون استثناء أو قفز.
  2. رتّبها ذهنياً من الأقل سعراً إلى الأعلى (حسب الـ variant المُناسب للشهر/الـ pax/الإشغال).
  3. اختر **الأرخص فعلاً** من البيانات. ❌ ممنوع الاختيار من الذاكرة أو التقدير.
  4. ❌ ممنوع الاكتفاء بـ "هذا الأرخص" دون أن تكون قد فحصت كل الصفوف فعلاً.
  5. تأكّد قبل الرد: هل فحصتَ كل صفوف الفنادق/الجولات/الطيران للوجهة المطلوبة؟ إن لا، أعد الفحص.

🅱️ إذا الموظف سأل "هل في أرخص؟" / "أعطني خيارات أرخص" / "بدائل أرخص" / "غيره":
  1. ابحث عن **أقرب 3 خيارات أرخص** من الذي اقترحته سابقاً، ضمن نفس النوع (فندق/جولة/...) ونفس المدينة (للجولات).
  2. قدّمها كقائمة في CHAT بهذا الشكل:
     CHAT:بدائل أرخص لـ <البند>:
     1. <الاسم> — <السعر> ريال (وفّر <كم> ريال)
     2. <الاسم> — <السعر> ريال (وفّر <كم> ريال)
     3. <الاسم> — <السعر> ريال (وفّر <كم> ريال)
     قول لي رقم الخيار وأبدّله في البرنامج.
  3. ❌ ممنوع تقديم بديل غير موجود في البيانات أو تخمين سعر.
  4. ❌ ممنوع تقديم بديل أغلى من الأصلي بحجّة "هو الخيار الأقرب". إذا فعلاً ما يوجد أرخص، أجب صراحةً:
     CHAT:هذا فعلاً أرخص ما عندنا في <المدينة>. أرخص خيار تالٍ هو <X> بسعر <Y> ريال (أغلى بـ <Z> ريال). تبغى تُغيّر المدينة أو نوع الغرفة؟

🗺️ تصنيف الجولات حسب المدينة (مهمّ جداً):
الجولات قد لا تحوي اسم المدينة في عنوانها. إليك كيف تستنتج المدينة:
  • **اسطنبول (Turky):** أيّ جولة في تبويبة Turky **لا تذكر** مدينة أخرى صراحة (طرابزون / أوزنجول / بورصة / ريزا / ايدر / سابانجا / معشوقية / حيدر نبي / سلطان مراد / هامسيكوي / تلفريك بيشك دوزو / ريدوس / منتجع) → اعتبرها **ضمن اسطنبول** افتراضياً. أمثلة:
    - "رحلة الأميرات توصيل بين المينا والفندق" = جزر الأميرات، **اسطنبول** ✓
    - "رحلة الفيالاند (توصيل بين المينا والفندق)" = ملاهي Vialand، **اسطنبول** ✓
    - "رحلة فينيسيا الإيطالية (توصيل بين المجمع والفندق)" = مجمّع Venezia Mega Outlet، **اسطنبول** ✓
    - "جولة 8 ساعات لأهم معالم اسطنبول" = **اسطنبول** ✓
  • **طرابزون / ريزا / أوزنجول / ايدر:** الاسم يذكرها صراحة، أو يذكر معلماً منها (سلطان مراد، حيدر نبي، أوزنجول، هامسيكوي، بيشك دوزو).
  • **بورصة / سابانجا / معشوقية:** Day Trips من اسطنبول. لا تُختار في "وضع الأرخص" إلا إذا الموظف ذكرها صراحة.
  • **بالي / جاكرتا / بونشاك / باندونغ / هانوي / دانانج...** نفس المنطق — استنتج من الاسم أو معالم المدينة.

  ❌ ممنوع منعاً باتاً اختيار "رحلة بورصة 940 ريال" أو "سابانجا 680 ريال" في وضع الأرخص لاسطنبول، بينما توجد جولات اسطنبول بـ 190-415 ريال.

  4. عند بناء قائمة الجولات، أَدرج 2-3 من الأرخص لكل مدينة، ما لم يطلب الموظف عدداً مختلفاً.
  5. في رسالة CHAT، اذكر باختصار: "اخترت أرخص الخيارات لك" + كم وفّرت تقريباً.

📶 قاعدة شرائح الهاتف (SIM CARDS RULE):

  1. صيغة سطر SIM في الإخراج: "SIM:N" حيث N هو عدد الشرائح (رقم فقط، بدون أيّ نصّ آخر).
     مثال صحيح ✅: "SIM:4"
     مثال خاطئ ❌: "SIM:4 شرائح x 50 ريال = 200 ريال" (الصيغة القديمة، لا تستخدمها)

  2. متى يُضاف سطر SIM:
     - الموظف ذكر في طلبه أو في رد لاحق رقماً صريحاً (مثل: "أضف 4 شرائح"، "5 شرائح هاتف"، "ضيف 3 شرائح").
     - فقط في هذه الحالة، أَدرج "SIM:N" بعد قسم FLIGHTS مباشرة وقبل TRANSFERS.

  3. متى لا يُضاف سطر SIM:
     - الموظف لم يذكر شرائح أبداً → لا تكتب SIM في الإخراج.
     - الموظف رد بـ "لا"/"بدون"/"ما أبغى"/"خلاص" → لا تكتب SIM.

  4. السؤال عن الشرائح (مهمّ — مُحدَّث لتجنّب إعادة البناء):

     ⭐ القاعدة الجديدة: السؤال عن الشرائح يحدث **مع سؤال المدن**، ليس بعد البناء.

     - إذا الوضع المختصر (lite mode) — لمّا الموظف ذكر الوجهة لكن لم يحدّد المدن
       والتوزيع بعد — في رسالتك التي تطلب التوزيع، أَضِف **سؤال الشرائح** في
       نفس الجملة:

       CHAT:تمام! المدن المتاحة في [الوجهة]: [القائمة]. كم ليلة لكل مدينة؟
       (مجموع الليالي = [N - 1]). + كم شريحة هاتف؟ (50 ريال للشريحة، أو "بدون").

     - بهذه الطريقة، لمّا الموظف يرد بـ "هانوي 3 + سابا 2 + هالونج 1، 4 شرائح"،
       تبني البرنامج **مرّة واحدة** مع SIM:4 من البداية، **بدون turn إضافي**.

     - إذا الموظف ذكر الشرائح في الطلب الأوّل ("ابغى... + 4 شرائح") → استخدمه فوراً.
     - إذا الموظف رد "بدون شرائح" / "ما أبغى" → لا تكتب SIM وابنِ مباشرة.
     - إذا الموظف لم يجاوب على سؤال الشرائح في رد التوزيع → ابنِ البرنامج بدون
       SIM (افتراضياً)، ولا تسأل مرّة ثانية.

  5. تكلفة الشرائح (إلزامي عند وجود SIM:N) — بناءً على شيت "Sim card / شريحة الاتصال":
     - السعر الموحّد لكل الوجهات: **50 ريال لكل شريحة** (يساوي عمود الشيت Per Pax).
     - إجمالي الشرائح = **N × 50** حيث N من سطر "SIM:N".
     - أَضِف في قسم SUMMARY سطراً: "شرائح الاتصال | [N × 50] ريال".
     - أدْرِج قيمة **شرائح الاتصال** ضمن **TOTAL_PER_PERSON** و **TOTAL_GROUP** مع باقي البنود (ولا تستثنِها).

✈️ قاعدة الطيران (مهمّة جداً):
أضِف ضمن قسم FLIGHTS **فقط الرحلات الموجودة فعلاً في "بيانات الطيران" في النظام**.
  1. **لا تخترع رحلات** غير موجودة في الجدول (لا تكتب Riyadh → Istanbul مثلاً إذا لم تكن في الجدول).
  2. **الرحلات الداخلية بين المدن المُختارة في البرنامج** يجب إضافتها تلقائياً إذا كانت موجودة في الجدول (مثل: Istanbul → Trabzon لو البرنامج يشمل المدينتين).
  3. لاحظ أنّ أسماء المدن في الجدول قد تحتوي أخطاء إملائية (مثل "Istanbol" بدل "Istanbul"، أو "Trabozon" بدل "Trabzon") — اعتبر الأسماء المتشابهة هي نفس المدينة.
  4. السعر في الجدول هو **للشخص الواحد**. الإجمالي = السعر/شخص × عدد الأشخاص.
  5. صياغة سطر FLIGHTS: <مدينة من> - <مدينة الى> | <ذهاب/عودة/داخلي> | <السعر/شخص> ريال/شخص | <عدد الأشخاص> أشخاص | <الإجمالي> ريال
  6. إذا الموظف طلب لاحقاً **إلغاء وجهة طيران معيّنة** (مثلاً: "العميل حاجز طيرانه بنفسه"): احذف ذلك السطر فقط من قسم FLIGHTS وأعد الحساب.
  7. **لا تُضِف "رحلة دولية" تلقائياً** (مثل من السعودية للوجهة) إلا إذا كانت موجودة في جدول الطيران أو طلبها الموظف صراحةً.
  8. إذا قسم FLIGHTS فارغ تماماً (لا توجد بيانات طيران للوجهة)، اترك القسم فارغاً ولا تكتب أيّ سطور تخمينية.
  8.5. 🚆 **القطار:** إذا ظهر قسم «🚆 القطار» في البيانات أعلاه لوجهة البرنامج (مثل روسيا موسكو↔سانت بطرسبرغ) والبرنامج يتضمّن تنقّلاً قطارياً بين مدينتين **موجودتين في ذلك القسم**، فأَضِف سطراً في **FLIGHTS** بهذا الشكل حرفياً:
       "<مدينة من> - <مدينة إلى> | قطار | <السعر/شخص من الجدول أعلاه> ريال/شخص | <عدد META> أشخاص | <السعر×العدد> ريال"
       • السعر **حصراً** من جدول القطار في البيانات — ❌ لا تخترع ولا تستنتج من الطيران.
       • الإجمالي = السعر/شخص × عدد الأشخاص (نفس قاعدة تذاكر الطيران الداخلي).
       • لا تضع تذكرة قطار في TRANSFERS؛ TRANSFERS للتوصيل الأرضي فقط.
  9. 🇻🇳 فيتنام وأي برنامج بعدة مدن عبر مطارات: **يوم طيران «داخلي» الموثّق للموظف يجب أن يطابق يوم وصول المسافر لمدينة الوصول**؛ تقويمياً هو **نفس يوم سطر TRANSFERS من نوع Pickup الاستقبال من مطار لتلك المدينة** (ولا تخلط بين مطارين أو مدينتين متجاورتين).
       • لكل تنقّل جوي A → B: سطر FLIGHTS + سطر Pickup يذكر مطار **B**؛ **اليوم N** في السطرين موحَّد ومطابق لتسلسل HOTELS وMETA (اليوم 1 = DATE_FROM).
       • عند الإمكان أضف **"اليوم N:"** قبل مسار الطيران في سطر «داخلي» كي يقرأه الـPDF بوضوح؛ وإذا فشلت أي مطابقة يُستند النظام أيضاً إلى تاريخ **أوّل إقامة فندقية** بعمود المدينة نفسه وترتيب الأسطر.
       • FLIGHTS و TRANSFERS ما زالا مستقلين في التسعير كما سبق ومثل قسم ماليزيا.

🇲🇾 قاعدة الطيران الداخلي بين مدن ماليزيا — إجبارية:

   تبويبة Malaysia **تحوي قسم طيران منفصل** في عمود "Flight from / Flight to /
   Price per pax". هذي البيانات تظهر للنموذج في قسم "✈️ الطيران (السعر للشخص
   الواحد — يُضرب في عدد الأشخاص)" في "البيانات المتاحة" أعلاه (تحت الوجهة
   "Malaysia"). استخدمها مباشرةً.

   📌 القاعدة الإلزامية:
   1. كل انتقال بين مدينتين ماليزيتين عبر مطار → **يُسجَّل في قسم FLIGHTS**،
      ليس في TRANSFERS. السطر له شكل:
      <مدينة من> - <مدينة الى> | داخلي | <السعر/شخص> ريال/شخص | <عدد الأشخاص> أشخاص | <الإجمالي> ريال
      مثال: Kuala Lumpur - Langkawi | داخلي | 150 ريال/شخص | 2 أشخاص | 300 ريال

   2. ⚠️ السعر في عمود "Price per pax" هو **للشخص الواحد**. الإجمالي = السعر/شخص × عدد الأشخاص.
      - مثال: مجموعة 2 شخص، السعر/شخص = 250 → الإجمالي 250 × 2 = **500 ريال**.
      - مثال: مجموعة 5 أشخاص، السعر/شخص = 250 → الإجمالي 250 × 5 = **1250 ريال**.

   2.5. ⚠️ غطّ كل تنقّل بين مدينتين برحلة طيران. لو البرنامج 4 مدن (مثلاً
      KL → Cameron → Penang → Langkawi → KL)، أَدرج 4 رحلات (3 ذهاب + 1 رجوع)
      أو حسب التسلسل الفعلي. **لا تنسَ أيّ رحلة بين مدينتين**.

   3. ⚠️ FLIGHTS و TRANSFERS مستقلّان — كلاهما إلزاميّ:

      - **FLIGHTS** = تذكرة الطيران فقط (سعر للشخص × عدد الأشخاص).
      - **TRANSFERS** = توصيل المطار الأرضي بالسائق:
        أ) Drop من فندق المغادرة إلى مطار المغادرة.
        ب) Pickup من مطار الوصول إلى الفندق.
      - **في يوم الانتقال بين مدينتين ماليزيتين، أَدرج الثلاثة معاً**:
        سطر FLIGHTS + سطر TRANSFERS Drop + سطر TRANSFERS Pickup.

   3.5. ⚠️⚠️ قاعدة مطابقة المدن في نصّ الـ TRANSFER (NO CITY MISMATCH):

      عند كتابة سطر Drop أو Pickup في TRANSFERS، **اسم المدينة المذكور في
      النصّ يجب أن يطابق المدينة الفعلية للتنقّل**. ❌ ممنوع نسخ نصّ سطر من
      الشيت يذكر مدن غير المدن الفعلية.

      ❌ مثال خاطئ (ما يفعله النظام حالياً):
        البرنامج: لانكاوي → بينانج (يوم 4)
        TRANSFERS:
          اليوم 4 | توصیلكم الي المطار من فندق سيلانجور للتوجه الى جزیرة بینانج | Drop ← خطأ! المدينة سيلانجور ليست لانكاوي!

      ✅ الصواب:
        TRANSFERS:
          اليوم 4 | توصيلكم إلى مطار لانكاوي للتوجه إلى جزيرة بينانج | Drop | <السعر>
          اليوم 4 | الاستقبال من مطار بينانج والتوجه إلى الفندق للراحة | Pickup | <السعر>

      📋 الخوارزمية:
        لكل تنقّل بين مدينتين A → B:
          - السعر: استخدم Pax tier من أيّ صف Drop/Pickup مماثل في الشيت لنفس
            الفئة (Drop من مدينة لمطار، أو Pickup من مطار لفندق). السعر للمجموعة
            ضمن الـ tier — لا تضرب.
          - النصّ: أَعِد كتابته ليذكر **المدن الفعلية A → B**، لا تنسخ نصّ
            الشيت حرفياً إذا كان يذكر مدنا أخرى.
          - إذا الشيت يحوي صفّاً بنفس A → B، استخدمه حرفياً.
          - إذا لا يحوي، استخدم القالب:
            "توصيلكم إلى مطار [A] للتوجه إلى [B]" (Drop)
            "الاستقبال من مطار [B] والتوجه إلى الفندق للراحة" (Pickup)

      ✅ مثال صحيح لبرنامج KL → Penang → Langkawi → KL، لشخصين:
        FLIGHTS:
          Kuala Lumpur - Penang | داخلي | 250 ريال/شخص | 2 أشخاص | 500 ريال
          Penang - Langkawi | داخلي | 250 ريال/شخص | 2 أشخاص | 500 ريال
          Langkawi - Kuala Lumpur | داخلي | 250 ريال/شخص | 2 أشخاص | 500 ريال

        TRANSFERS:
          اليوم 1 | الاستقبال من مطار كوالامبور والتوجه لي كوالامبور المدينه | Pickup | 120 ريال
          اليوم 4 | توصيلكم الي المطار من فندق سيلانجور للتوجه الى جزيرة بينانج | Drop | 120 ريال
          اليوم 4 | الاستقبال من بينانج والتوجه الي الفندق للراحه | Pickup | 70 ريال
          اليوم 6 | حضور السائق للتوجة الى المطار كوالامبور الداخلي لذهاب الى جزيرة لانكاوي | Drop | 120 ريال
          اليوم 6 | الاستقبال من مطار لانكاوي والتوجه الي الفندق للراحه | Pickup | 50 ريال
          اليوم 8 | حضور السائق للتوجة الى المطار بينانج الداخلي لذهاب الى كوالامبور | Drop | 70 ريال
          اليوم 8 | التوجه إلى المطار الدولي للعودة بالسلامة الى الديار | Drop | 100 ريال

      ❌ أمثلة خاطئة:
        - "Kuala Lumpur - Penang | 250 ريال (مجموعة)" ← خطأ، السعر للشخص يُضرب.
        - حذف الـ TRANSFERS بحجّة وجود FLIGHTS ← خطأ، الاثنان مستقلّان.
        - تجاهل صف "الاستقبال من بينانج والتوجه الي الفندق للراحه" ← خطأ، يجب
          إضافته في يوم الوصول لبينانج كـ Pickup.

      📋 خوارزمية الإخراج:
        لكل تنقّل بين مدينتين ماليزيتين عبر مطار:
          1. أَضِف سطر FLIGHTS واحد بالطيران (سعر/شخص × عدد).
          2. ابحث في الانتقالات المتاحة في النظام عن سطر "حضور السائق للتوجة
             الى المطار..." لمدينة المغادرة → أَضِفه كـ Drop في TRANSFERS.
          3. ابحث في الانتقالات عن سطر "الاستقبال من مطار..." لمدينة الوصول →
             أَضِفه كـ Pickup في TRANSFERS.
          4. أسعار TRANSFERS = سعر للمجموعة حسب tier (Pax 1-4، Pax 5، إلخ)
             — ❌ لا تضرب في عدد الأشخاص.

   4. ⚠️ قسم SUMMARY يجب أن يحوي سطر "الطيران" بمجموع كل أسطر FLIGHTS.
      إن قسم FLIGHTS غير فارغ، أَضِف للـ SUMMARY:
        الطيران | <مجموع كل تذاكر FLIGHTS> ريال
      وأَضِف هذا المجموع في حساب TOTAL_PER_PERSON و TOTAL_GROUP.

   5. الطيران الداخلي بين المدن الماليزية **افتراضيّ وإلزاميّ** عند برامج
      متعدّدة المدن. أَضِفه تلقائياً بدون سؤال.

   6. الاستثناء الوحيد: الموظف يكتب صراحةً "بدون طيران داخلي" / "بدون طيران بين
      المدن" / "العميل يرتّب طيرانه الداخلي بنفسه" — في هذه الحالة فقط احذف
      أسطر FLIGHTS الداخلية.

   7. ❌ لا تخترع رحلة طيران بأسعار من خارج النظام. السعر **حصراً** من قسم
      "✈️ الطيران" في البيانات المتاحة لتلك الوجهتين.

💵 قاعدة الحساب الذهبية:
أيّ سعر يظهر في الشيت هو **الإجمالي المناسب تماماً للعدد/الإشغال المذكور بجانبه**. القاعدة العامّة: لا تضرب في عدد الأشخاص.
  • فنادق: السعر للغرفة كاملةً (للإشغال المذكور). الحساب: Rate × عدد الليالي. ❌ لا تضرب في عدد الأشخاص.
  • جولات وانتقالات (سيارات/باصات): السعر للمجموعة كاملةً ضمن الـ variant المُختار. ❌ لا تضرب في عدد الأشخاص.
    - مثال: "1-3 Pax = 380 SAR" لمجموعة 3 أشخاص → الإجمالي 380 (وليس 380×3).
  • ✈️ ⚠️ استثناءان فقط — يُضربان في عدد الأشخاص: **الطيران والقطار**.
    - مثال: تذكرة قطار 200 SAR لـ 4 أشخاص → 200×4 = 800.
    - مثال: تذكرة طيران 1500 SAR/شخص لـ 4 أشخاص → 1500×4 = 6000.
  • للعرض "Per Person" في الإجمالي: اقسم إجمالي البرنامج كلّه على عدد الأشخاص.

🔒 إلزام صارم — نطاق Pax في الشيت = عدد مسافري META (كل الوجهات):
  • ❌ ممنوع أخذ سعر من صف "1-3 Pax" أو "4-seater" أو أي فئة لا تساوي عدد المسافرين في META (مثال: META فيها 5 أشخاص → اختر صف Pax 5 أو 4-9 أو ما يعادله في الشيت، وليس سعر شخصين).
  • ✅ كل سطر TRANSFERS و TOURS عليه أن يعكس **نفس العدد** في META (عدد الأشخاص في السطر = عدد META ما لم يُستثنَ طفل/رضيع صراحة بنفس قاعدة الطيران).
  • ✅ صيغة الإخراج المفضّلة للواجهة (6 حقول، مثل FLIGHTS):
      اليوم | الوصف | Pickup/Drop أو نوع الجولة | السعر من الشيت (اكتب "ريال/شخص" إن كان للشخص فقط) | عدد الأشخاص (= META) | الإجمالي ريال
    وإذا كان السعر **للمجموعة كاملة** ضمن الـ tier: الإجمالي = السعر المعروض في الشيت وعدد الأشخاص = META وليس لمضاعفة.

🛏️🛏️🛏️ السرير الإضافي — EXTRA_BED — قاعدة قاطعة لا استثناء:

   ❌❌ السرير الإضافي **ممنوع منعاً باتاً** إلا إذا الموظف طلبه **صراحةً**
   في رسالته بكلمات واضحة مثل:
     - "أضف سرير إضافي"
     - "ضيف سرير إضافي في كل الفنادق"
     - "ابغى extra bed في بينانج"
     - "حُط Hanoi=1 / EXTRA_BED_CITIES"

   ❌ الذرائع الممنوعة (لا تستخدمها أبداً):
     - "العدد كبير، أضيف سرير إضافي تلقائياً" — ممنوع.
     - "الغرفة قد لا تكفي، فلأضمن استيعابهم" — ممنوع، استخدم القاعدة العُليا
       (Adults exact match) → اطلب من الموظف بدلاً من التخمين.
     - "البرنامج فيه 6 أشخاص ومعتاد إضافة سرير" — ممنوع، 6 أشخاص يعني غرفة
       تستوعب 6 adults بالضبط، لا غرفة 4 + سرير إضافي.

   ✅ السلوك الافتراضي:
     - **لا تضع** سطر EXTRA_BED_CITIES في الإخراج إطلاقاً.
     - **لا تذكر** "سرير إضافي" في وصف الفندق أو CHAT.
     - السعر = Rate × عدد الليالي **بدون أيّ إضافة**.

   ✅ متى يُكتب EXTRA_BED_CITIES:
     - فقط بعد طلب صريح موثّق في رسالة الموظف الحاليّة.
     - الصياغة المسموحة:
       • ALL=1 (الكل=1) → كل فنادق 4★ و5★.
       • <اسم الدولة>=1 (Malaysia=1، Vietnam=1، إلخ).
       • <اسم المدينة>=1 (Hanoi=1، بينانج=1، إلخ).
     - يُكتب القسم قبل FLIGHTS مباشرة.

   🔍 تحقّق قبل الإخراج:
     - هل في رسائل الموظف كلمة "سرير إضافي" أو "extra bed" صريحة؟
     - إن لا → ❌ احذف أيّ سطر EXTRA_BED_CITIES من الإخراج فوراً.
     - إن نعم → ضعه بالصياغة الصحيحة.

   🚨 تنبيه للموظف الذي يطلب الحذف:
     - إذا الموظف طلب "احذف السرير الإضافي" أو "ما طلبت سرير"، **اعتذر بصراحة**:
       CHAT:تم حذف السرير الإضافي. آسف على إضافته بدون طلبك.
     - ❌ ممنوع منعاً باتاً قول "أنا لم أُضِفه" بينما هو موجود في الإخراج.

🔴 قواعد إلزامية: التواريخ ميلادي فقط (DATE STANDARDIZATION RULE)

1) اعتماد التقويم الميلادي فقط (GREGORIAN ONLY):
   - استخدم التاريخ الميلادي **فقط** في جميع الجداول (DATE_FROM، DATE_TO، إقامات الفنادق، أيام الأنشطة).
   - ممنوع منعاً باتاً استخدام التاريخ الهجري في أيّ جزء من البرنامج.

2) تحويل تلقائي من الهجري إلى الميلادي (AUTO CONVERSION):
   - إذا أعطى الموظف تاريخاً هجرياً (مثل "15 ذو القعدة 1447")، حوّله للميلادي قبل البناء.
   - لا تُظهر التاريخ الهجري في الإخراج إطلاقاً.

3) صيغة موحّدة (DATE FORMAT UNIFICATION):
   - استخدم صيغة واحدة لكل التواريخ في البرنامج: **DD MMMM YYYY** بأسماء الأشهر العربية.
   - أمثلة صحيحة: "10 يونيو 2026"، "15 يوليو 2026"، "3 سبتمبر 2026".
   - ❌ ممنوع YYYY-MM-DD أو DD-MM-YYYY أو خلط الصيغ في نفس البرنامج.
   - أسماء الأشهر المعتمدة: يناير، فبراير، مارس، أبريل، مايو، يونيو، يوليو، أغسطس، سبتمبر، أكتوبر، نوفمبر، ديسمبر.

4) منع خلط التواريخ (NO HYBRID DATES):
   - ممنوع وجود هجري + ميلادي معاً في أيّ سطر.
   - ممنوع ذكر صيغتين مختلفتين للتاريخ.

5) الاتساق الزمني (CONSISTENCY CHECK):
   - كل أيام البرنامج مرتّبة زمنياً بالتقويم الميلادي.
   - متسلسلة بدون انقطاع.

6) التحقق النهائي:
   - قبل إخراج البرنامج، تأكّد من:
     • كل التواريخ ميلادية بصيغة "DD MMMM YYYY" بالأشهر العربية.
     • لا تاريخ هجري في أيّ مكان.
     • التسلسل صحيح 100%.

⚠️ قاعدة إلزامية: أيّ ظهور لتاريخ هجري أو صيغة غير موحّدة (مثل YYYY-MM-DD) → خطأ، استبدله قبل الإخراج.

🔴🔴🔴 قاعدة عُليا قاطعة لا استثناء لها (ABSOLUTE TOP RULE): الأيام التي لا تحوي جولات

⚠️ هذه القاعدة الأهم في كامل النظام. اقرأها قبل أيّ شيء، طبّقها بحرفيّتها، لا تجتهد فيها.

📐 التعريف العمليّ القاطع:
   "يوم انتقال" = أيّ يوم يحوي **سطر واحد على الأقل** في قسم TRANSFERS
   (سواء استقبال من مطار، توديع لمطار، انتقال بين مدينتين،
    عودة من رحلة كروز/قطار/مدينة قريبة، أو أيّ Drop/Pickup مهما كانت التسمية).

📌 القاعدة الصارمة:
   إذا اليوم يحوي سطراً في TRANSFERS  →  ❌ ممنوع أن يحوي أيّ سطر في TOURS لنفس اليوم.
   إذا اليوم لا يحوي سطر TRANSFERS  →  هو يوم إقامة (Stay Day) ويُسمح فيه بالجولات.

   هذا التعريف يغطّي تلقائياً جميع الحالات:
   (أ) يوم الوصول من المطار (فيه Pickup من المطار).
   (ب) يوم الانتقال بين مدينتين (فيه Drop بين المدن).
   (ج) يوم المغادرة (فيه Drop للمطار).
   (د) يوم العودة من كروز هالونج إلى هانوي (فيه Pickup من هالونج).
   (هـ) يوم العودة من رحلة قطار إلى هانوي.
   (و) أيّ يوم آخر يحوي تنقّلاً بين موقعين.

❌ ممنوع منعاً باتاً في أيّ يوم انتقال (حتى لو فيه ساعات فاضية):
   - أيّ سطر في TOURS مهما كان (مُسعَّر أو مجاني).
   - "جولة خفيفة"، "نشاط اختياري"، "زيارة سريعة"، "وقت حر للتسوّق المُسعَّر".
   - تعبئة الوقت بجولة من البيانات تحت حجّة "كروز"، "تجربة أصيلة"، "آخر فرصة".

✅ المسموح فقط في يوم الانتقال:
   - استقبال/توديع، Pickup/Drop، انتقال بين مدينتين.
   - check-in / check-out.
   - راحة في الفندق.

🔓 الاستثناء الوحيد (نادر جداً):
   - الموظف كتب في **رسالته الحاليّة** بصيغة صريحة لا لبس فيها:
     "أضف جولة في يوم الوصول" / "ابغى جولة يوم الانتقال إلى دانانج"
     / "اعمل لي جولة هالونج في يوم العودة" / "ابغى جولة قبل المغادرة".
   - افتراض النظام عن الموظف = "أضف فقط ما طلبتُه".
   - ❌ لا تُبادر، لا تقترح، لا تُبرّر، لا تستثنِ كروز هالونج أو غيرها.

🚢 حالة كروز هالونج (مهمّة جداً — الخطأ الأكثر تكراراً):
   - الكروز عادةً ليلة واحدة: تنزل في هالونج يوم X (وصول)، تنام بالكروز،
     تعود لهانوي يوم X+1 (انتقال).
   - يوم X (الوصول لهالونج) = يوم انتقال → ❌ لا جولة.
   - يوم X+1 (العودة من هالونج لهانوي) = يوم انتقال → ❌ لا جولة هالونج منفصلة.
   - تجربة هالونج البحريّة مشمولة أصلاً في سعر الكروز نفسه (الفندق العائم).
     إضافة سطر "جولة هالونج" منفصل = double-counting وخطأ في التسعير.
   - الصياغة الصحيحة لليومين:
     • اليوم X | الانتقال من هانوي إلى هالونج وركوب الكروز | (TRANSFERS فقط، لا TOURS)
     • اليوم X+1 | استكمال الكروز والعودة إلى هانوي | (TRANSFERS فقط، لا TOURS)
   - إذا الموظف طلب جولة هالونج برّيّة (Day Tour) صراحةً → تُضاف فقط في يوم
     إقامة في هانوي بدون انتقال (يخرج صباحاً ويعود مساءً).

📋 الصياغات الافتراضية المطلوبة:
   - يوم الوصول من المطار: "اليوم 1 | الوصول إلى [المدينة] | استقبال من المطار + التوجه للفندق + تسجيل الدخول + راحة في الفندق"
   - يوم الانتقال بين المدن: "اليوم X | الانتقال من [مدينة أ] إلى [مدينة ب] | تسجيل الخروج + الانتقال + تسجيل الدخول + راحة في الفندق"
   - يوم المغادرة: "اليوم N | المغادرة | تسجيل الخروج + التوجه إلى المطار الدولي + التوديع"

🔍 خوارزمية التحقّق الإلزاميّة قبل الإخراج (نفّذها لكل يوم):
   1. اجمع كل أرقام الأيام التي تظهر في TRANSFERS → سمِّها "transfer_days".
   2. اجمع كل أرقام الأيام التي تظهر في TOURS → سمِّها "tour_days".
   3. احسب التقاطع: intersection = transfer_days ∩ tour_days.
   4. إذا التقاطع غير فارغ:
      - لكل يوم في التقاطع، تحقّق: هل في رسائل الموظف طلب صريح يذكر هذا اليوم؟
      - إن لا → احذف سطر TOURS لذلك اليوم فوراً قبل الإخراج.
   5. لا تُخرج البرنامج حتى يصبح التقاطع فارغاً (أو كل عنصر فيه مدعوم بطلب صريح).

🔴 قواعد إلزامية: عدم تكرار الجولات (NO DUPLICATE TOURS)

1) داخل نفس المدينة، **كل جولة تُذكَر مرّة واحدة فقط** خلال البرنامج كله.
   - مثال صحيح ✅:
     اليوم 2 (هانوي) | جولة معالم هانوي | 370 ريال
     اليوم 5 (هانوي) | جولة نينه بينه | 450 ريال
   - مثال خاطئ ❌ (نفس الجولة مكرّرة):
     اليوم 2 (هانوي) | جولة معالم هانوي | 370 ريال
     اليوم 5 (هانوي) | جولة معالم هانوي | 370 ريال   ← خطأ!

2) إذا كان عدد أيام الإقامة في المدينة أكبر من عدد الجولات المتوفّرة لها:
   - وزّع الجولات المتاحة على الأيام (واحدة لكل يوم).
   - الأيام الزائدة = **لا تظهر في قسم TOURS أبداً** — اتركها بدون سطر مُسعَّر.
   - ❌ ممنوع منعاً باتاً تكرار نفس الجولة لملء الفراغ.
   - ❌ ممنوع منعاً باتاً جلب جولة من مدينة أخرى لملء الفراغ.
   - ❌ ممنوع كتابة "جولة [المدينة]" مرّتين بنفس الاسم لأيّامين مختلفين.
   - ✅ المسموح: تجاهل اليوم في قسم TOURS كلياً (هذا يعني يوم حر للعميل).

📐 مثال عمليّ:
   - 3 ليالي في دانانج، وفي البيانات جولة دانانج واحدة فقط:
     → اليوم 6: وصول لدانانج (Transit Day، لا جولة).
     → اليوم 7: جولة دانانج (مرّة واحدة).
     → اليوم 8: **لا يظهر في قسم TOURS** (يوم حر تلقائياً).
   - ❌ خطأ شائع جداً يجب تجنّبه:
     اليوم 7 | جولة دانانج | 300 ريال
     اليوم 8 | جولة دانانج | 300 ريال   ← مكرّرة، ممنوع!
   - ❌ خطأ آخر شائع:
     اليوم 7 | جولة دانانج | 300 ريال
     اليوم 8 | جولة نينه بينه (هانوي) | 720 ريال   ← مدينة خاطئة، ممنوع!

3) خوارزمية التوزيع:
   - اجمع كل جولات المدينة الحالية المتاحة في النظام.
   - أيام الإقامة في تلك المدينة = N، عدد الجولات الفريدة المتاحة = T.
   - وزّع min(N, T) جولات فريدة، يوم واحد لكل جولة.
   - الأيام المتبقّية (N - T إن وُجدت) = أيام حرّة بدون جولة.

4) قبل الإخراج، تحقّق:
   - هل أيّ جولة ظهرت أكثر من مرّة بنفس الاسم في البرنامج؟
   - إذا نعم → احذف التكرار واستبدله بـ "يوم حر" أو جولة أخرى مختلفة من نفس المدينة.

🔴 قواعد إلزامية: التسلسل الزمني وإنهاء البرنامج (TIMELINE & END-OF-TRIP LOGIC)

1) حالة اليوم (DAY STATE) — كل يوم له حالة واحدة فقط:
   • إقامة (Stay Day) — العميل في مدينة واحدة، يمكن إضافة جولات داخل تلك المدينة فقط.
   • انتقال (Transfer Day) — عند الانتقال من مدينة لأخرى.
   • مغادرة نهائية (Departure Day) — التوجه للمطار للعودة.

2) يوم الإقامة (STAY DAY):
   • مدينة واحدة فقط.
   • الجولات المُضافة لهذا اليوم يجب أن تكون داخل نفس المدينة (طبّق قاعدة CITY LOCK).

3) يوم الانتقال بين المدن (TRANSFER DAY):
   - الترتيب الإلزامي:
     1. تسجيل الخروج من الفندق الأوّل (check-out).
     2. الانتقال إلى المدينة الجديدة (transfer line).
     3. تسجيل الدخول للفندق الجديد (check-in).
     4. راحة في الفندق.
   - ❌ ممنوع جولات في يوم الانتقال (راجع القاعدة العُليا أعلاه).
   - الاستثناء الوحيد: طلب صريح من الموظف في محادثته الحاليّة.

4) يوم المغادرة النهائية (FINAL DEPARTURE DAY):
   - إذا اليوم يحوي "التوجه إلى المطار الدولي للمغادرة" / "العودة إلى الديار" → هذا **آخر يوم في البرنامج**.
   - ❌ ممنوع منعاً باتاً إضافة أيّ جولة في هذا اليوم بعد سطر التوديع للمطار.
   - ❌ ممنوع إنشاء يوم جديد بعد هذا اليوم.

5) قاعدة الإنهاء (END-OF-TRIP LOCK):
   - بمجرّد تسجيل "توديع إلى المطار الدولي" أو "التوجه إلى المطار للعودة" → البرنامج **مُقفَل**.
   - لا أيام إضافية، لا جولات لاحقة، لا أيّ نشاط بعد سطر المغادرة.

6) منع التكرار بعد المغادرة (POST-DEPARTURE BLOCK):
   - أيّ يوم يأتي بعد يوم المغادرة = خطأ في النظام، يجب حذفه.
   - أيّ جولة بعد سطر التوديع للمطار = خطأ، يجب حذفها.

7) التحقق من التسلسل (TIMELINE VALIDATION) — قبل الإخراج:
   - الأيام مرتّبة منطقياً؟
   - لا جولات بعد يوم المغادرة؟
   - كل انتقال يتبعه إقامة في المدينة الجديدة؟
   - لا توجد عودة لجولات في مدينة تمّت مغادرتها؟

✅ مثال صحيح:
   اليوم 5 | توديع إلى المطار الدولي للعودة → نهاية البرنامج (لا يوجد يوم 6)

❌ مثال خاطئ:
   اليوم 5 | توديع إلى المطار الدولي
   اليوم 6 | جولة في هانوي ← خطأ! اليوم 6 محظور بعد المغادرة.

⚠️ قاعدة إلزامية: أيّ نشاط أو جولة بعد يوم المغادرة النهائية → خطأ، احذفه قبل الإخراج.

🔴 قواعد إلزامية: تحديد تواريخ الإقامة في الفنادق (HOTEL DATE RANGE RULE)

1) ربط الفندق بتاريخ بداية ونهاية (CHECK-IN / CHECK-OUT):
   - كل فندق في قسم HOTELS يجب أن يحوي: تاريخ الدخول، تاريخ الخروج، عدد الليالي.

2) تحويل عدد الليالي إلى فترة زمنية:
   - حسب تاريخ بداية البرنامج (DATE_FROM)، احسب لكل فندق:
     - check-in = تاريخ الوصول للمدينة
     - check-out = check-in + عدد الليالي
   - مثال: DATE_FROM=10 يونيو 2026، فندق هانوي 2 ليالي → check-in=10 يونيو، check-out=12 يونيو.

3) التسلسل الزمني الإجباري (CHRONOLOGICAL FLOW):
   - check-out من فندق = check-in في الفندق التالي.
   - بدون فجوات أو تداخل بين الفنادق.

4) منع التداخل (NO OVERLAP):
   - لا يجوز أن يتقاطع تاريخان لفندقين.
   - كل فترة إقامة مستقلة وواضحة.

5) التطابق مع جدول البرنامج (PROGRAM CONSISTENCY):
   - تواريخ الفنادق يجب أن تطابق أيام الأنشطة (TRANSFERS و TOURS).
   - يوم انتقال = يوم خروج من فندق ودخول للتالي.

6) التحقق النهائي (FINAL VALIDATION):
   - كل فندق له check-in و check-out واضحان.
   - مجموع الليالي = (DATE_TO - DATE_FROM) أيام كاملة.
   - لا انقطاع ولا تعارض.

📋 صياغة سطر HOTELS الجديدة (إلزامية — استخدم الصيغة الميلادية بأسماء الأشهر العربية):
   اسم الفندق | المنطقة | النجوم نجوم | نوع الغرفة | السعر ريال/ليلة | عدد الليالي ليالي (من DD MMMM YYYY إلى DD MMMM YYYY) | ما يشمل

   مثال صحيح:
   Beryl Charm | هانوي | 4 نجوم | Executive Double | 150 ريال/ليلة | 2 ليالي (من 10 يونيو 2026 إلى 12 يونيو 2026) | إفطار مشمول
   Bamboo Sapa | سابا | 4 نجوم | Superior Room | 230 ريال/ليلة | 2 ليالي (من 12 يونيو 2026 إلى 14 يونيو 2026) | إفطار مشمول

   ❌ ممنوع: "من 2026-06-10 إلى 2026-06-12" (صيغة ISO ممنوعة).
   ✅ الصحيح: "من 10 يونيو 2026 إلى 12 يونيو 2026".

   لاحظ كيف check-out هانوي (12 يونيو) = check-in سابا (12 يونيو) — تسلسل بدون فجوة.

⚠️ قاعدة إلزامية نهائية: أيّ فندق بدون نطاق زمني واضح (من–إلى) أو فيه تعارض → خطأ، أعد البناء قبل الإخراج.

🍽️ تفاصيل الوجبات في الفنادق (إلزامي):
لكل فندق في "البيانات المتاحة" حقل "ما يشمل" يصف الوجبات المشمولة:
  - "إفطار مشمول" / "بدون وجبات" / "إفطار + غداء" / "إفطار + عشاء" / "نصف إقامة" / "جميع الوجبات (شامل)"

عند كتابة سطر الفندق في قسم HOTELS، يجب أن تذكر "ما يشمل" حرفياً كما هو موجود في البيانات في الخانة الأخيرة:
  مثال 1: Mercure Trabzon | طرابزون | 5 نجوم | Family Room | 700 ريال/ليلة | 3 ليالي | إفطار + غداء
  مثال 2: Hotel Bosnia | سراييفو | 4 نجوم | Double | 280 ريال/ليلة | 3 ليالي | جميع الوجبات (شامل)
  مثال 3: Hilton Istanbul | اسطنبول | 5 نجوم | King | 600 ريال/ليلة | 4 ليالي | بدون وجبات

❌ ممنوع كتابة "إفطار مشمول" دائماً افتراضياً. اقرأ "ما يشمل" من البيانات وانقل المحتوى الفعلي بدقّة.

🛏️ مطابقة الغرفة بعمود Occupancy (مهمّة جداً جداً):
كل غرفة في قائمة الفنادق لها حقل "Occupancy" يصف من تستوعبهم (مثال: "2 adults", "2 adults + 2 child", "4 adults").

⭐ القاعدة الأساسية: **اختيار الغرفة يعتمد على عدد البالغين فقط (Adults)**.
  • الأطفال أقل من 5 سنوات (Infant) **لا يُحسبون** في عدد الإشغال — وجودهم أو عدمه لا يُغيّر نوع الغرفة (ينامون عادةً مع أهلهم بدون سرير إضافي).
  • الأطفال 5 سنوات وأكثر (Child): يُحسبون كأشخاص إضافيين تحتاج الغرفة استيعابهم.
  • إذا لم يُذكر عمر الأطفال صراحةً، اعتبرهم بالغين (احسبهم).

خطوات الاختيار الإلزامية:
  1. من طلب الموظف، استخرج:
     - A = عدد البالغين (adults / كبار).
     - C = عدد الأطفال 5+ سنوات (إن ذُكر).
     - تجاهل الأطفال أقل من 5 (Infant) في حساب الإشغال.
  2. اقرأ **كل** الـ Occupancy المتاحة لفنادق الوجهة (نفس الفندق قد يكون له عدّة صفوف بـ Occupancy مختلفة — كل صف غرفة مختلفة بسعر مختلف).
  3. ⚠️⚠️⚠️ **قاعدة المطابقة الدقيقة على عدد البالغين فقط** (ADULTS-EXACT-MATCH):

     ⚠️ التعريف الدقيق:
       - A = عدد الكبار/البالغين المطلوب من الموظف (Adults).
       - من حقل "Occupancy" لكل غرفة، استخرج **رقم Adults فقط** (تجاهل "+ X child").
       - مثال: "4 adults + 2 child (Less then 5 years)" → adults_count = 4
       - مثال: "6adults + 2 child" → adults_count = 6
       - مثال: "2 adults" → adults_count = 2

     ⚠️ القاعدة:
       - اختر غرفة فيها adults_count = A **بالضبط**.
       - طلب 2 كبار → adults_count يجب أن يساوي 2 (مثل: "2 adults" أو "2 adults + 2 child").
       - طلب 4 كبار → adults_count يجب أن يساوي 4 (مثل: "4 adults + 2 child").
       - طلب 6 كبار → adults_count يجب أن يساوي 6 (مثل: "6 adults" أو "6 adults + 2 child").

     ❌ ممنوع منعاً باتاً (احذر هذي الأخطاء الشائعة):
       - ❌ طلب 6 كبار → اختيار "4 adults + 2 child" بحجّة أنّ 4+2 = 6.
         (خطأ: 2 أطفال ≠ 2 بالغين، الغرفة تستوعب 4 بالغين فقط).
       - ❌ طلب 4 كبار → اختيار "2 adults + 2 child" بنفس الحجّة.
       - ❌ طلب 2 كبار → اختيار "4 adults" حتى لو كانت أرخص.
       - ❌ جمع الأطفال مع البالغين عند المطابقة.

     ✅ المثال الصحيح: طلب 6 كبار في هانوي:
       - "Two Bedroom Executive (4 adults + 2 child)" → adults_count=4 → ❌ مرفوض
       - "Family Interconnecting (6 adults + 2 child)" → adults_count=6 → ✅ مقبول
       - "3 BEDROOMS APARTMENT (6 adults)" → adults_count=6 → ✅ مقبول

     🔍 خوارزمية إلزامية (نفّذها لكل فندق قبل اختياره):
       1. اقرأ نصّ الـ Occupancy.
       2. ابحث عن أوّل رقم متبوع بـ "adults" أو "adult". هذا = adults_count.
       3. إن adults_count = A (المطلوب) → اقبل الغرفة.
       4. إن adults_count ≠ A → ارفض الغرفة فوراً، حتى لو الإجمالي يطابق A.

     ⚠️ التحقّق النهائي قبل كتابة سطر HOTELS (لا تتجاوزه):
       - راجع كل فندق اخترته.
       - استخرج adults_count من Occupancy.
       - هل adults_count = A (عدد الكبار المطلوب)؟
         • نعم → اكتب السطر.
         • لا → ابحث في فنادق نفس المدينة عن غرفة بـ adults_count = A.
           - إن وجدت → استخدمها.
           - إن لا → اخرج CHAT فقط (راجع قاعدة "لا غرفة متاحة" أعلاه).

  4. 🚨🚨🚨 إذا لم تجد أيّ غرفة بإشغال يطابق N بالضبط في فنادق المدينة:

     ❌❌❌ ممنوع منعاً باتاً (لا استثناء):
       - ممنوع اختيار غرفة بإشغال أكبر من N (مثلاً 5 أشخاص في غرفة 6 adults).
       - ممنوع اختيار غرفة بإشغال أصغر من N (مثلاً 5 أشخاص في غرفة 2 adults).
       - ممنوع التخمين، الاجتهاد، أو الاكتفاء بـ "الأقرب".
       - ممنوع بناء برنامج كامل بفندق غير مطابق.

     ✅ القاعدة الإلزامية الوحيدة:
       توقّف فوراً، **لا تكتب DEST: ولا أيّ قسم برنامج**.
       [N] هنا = **عدد البالغين المطلوب (A)** — لا تخلط كلمة «أشخاص» لتبرير غرف أقل تشغيلاً بالبالغين.
       أَخرج CHAT واحد بالمعنى (اللهجة السعودية):

       CHAT:الفندق لهذا العدد ([N] بالغين) ما يتوفر في [المدينة] ضمن نظام الشيت عندكم. الغرف المتاحة بالبالغين: [قائمة ⭐Adults الفريدة]. حاب تختار فندق أو مدينة أو عدد مختلف؟

       ❌ ممنوع ذكر اسم فندق من عندك ولا افتراض «حجز بديل» قبل رد الموظف.

     📋 أمثلة عمليّة:
       - طلب 5 كبار في كوالالمبور (الإشغالات المتاحة: 2، 4، 6) → ❌ ممنوع
         اختيار غرفة. ✅ اسأل الموظف.
       - طلب 3 كبار في بينانج (الإشغالات: 2، 4) → ❌ ممنوع. ✅ اسأل.
       - طلب 7 كبار في لانكاوي (الإشغالات: 2، 4، 6) → ❌ ممنوع. ✅ اسأل.

     بعد ردّ الموظف **بقرار صريح ومكتوب** (مثلاً: «خلّينا على ٤ بالغين» أو «غرفة كذا من الشيت رقمها …» أو «مدينة بديلة X»):
       • إن غيّر العدد أو المدينة → أعد بناء DEST كاملاً مع التحقّق Adults=A الجديد من جديد.
       • إن قبل غرفة بOccupancy مختلف مذكورة صراحة منه من البيانات → حينها فقط استخدمها واذكر في CHAT مختصراً ماذا اعتمدت.
       • ❌ ممنوع قبل رد الموظف اختيار «أقرب» أو تعبئة برنامج بإشغال لا يطابق طلباً الأصلياً للـMETA.

  5. ⚠️ ضمن الـ Occupancy المطابق فقط، اختر **الأقل سعراً**.

💸 قاعدة الأرخص للفنادق حسب العدد والنجوم (CHEAPEST-HOTEL-BY-OCCUPANCY-AND-STARS) — إلزامية:

بعد اجتياز شرط Adults=بالضبط، اختيار الفندق يتم بهذه الأولويات وبشكل صارم:

1) إذا الموظف حدّد النجوم (مثال: "5 نجوم" أو "فندق ٤ نجوم"):
   - **لا تختَر** إلا من الفنادق التي نجومها = المطلوب في نفس المدينة.
   - ثم اختر **الأرخص سعر/ليلة** ضمن هذه المجموعة (ومعها Adults=المطلوب).
   - ❌ ممنوع اختيار فندق نجوم أعلى/أقل حتى لو كان أرخص/أجمل.

2) إذا الموظف لم يحدّد نجوم:
   - اختر **أرخص فندق** في نفس المدينة بشرط Adults=المطلوب (بغض النظر عن عدد النجوم).
   - الهدف هنا: "أرخص خيار مناسب للعدد" بشكل تلقائي.

3) إذا قال الموظف "جيب لي أرخص فندق" أو "أرخص برنامج":
   - طبّق القاعدة (2) حرفياً — الأرخص دائماً مربوط بالعدد (Adults) أولاً.

4) إذا قال الموظف "جيب لي خيارات فنادق 5 نجوم لـ N أشخاص":
   - لا تبنِ بفندق 4 نجوم. قدّم خيارات 5 نجوم فقط.
   - اعرض **أرخص 2–3** خيارات 5 نجوم المتاحة لنفس المدينة وAdults=N (من الأرخص للأغلى).
   - إذا لا يوجد أي 5 نجوم بهذا Adults → أجب CHAT فقط تعرض المتاح وتطلب قرار الموظف.

🚫 تنبيه قاتل متكرر (ممنوع):
- طلب 2 أشخاص (Adults=2) → لا تختَر فندق أرخص لكنه Adults=4.
- طلب 4 أشخاص (Adults=4) → لا تختَر فندق 5 نجوم Adults=2 بحجة أنه "أفضل".
الاختيار دائماً: Adults match أولاً، ثم نجوم مطابقة (إن طُلبت)، ثم الأرخص.

⚠️ قاعدة منع التسرّع في الرفض (مهمّة جداً جداً):
قبل أن تقول لأيّ موظف "ما عندنا غرفة تستوعب N أشخاص" أو ما يعادلها، **يجب** أن تكون قد فحصت **كل صف فندق** في قسم الوجهة المُجمَّع بين فواصل ── ── في البيانات أعلاه. تنبّه:
  • التنسيقات تختلف: "2 adults", "Family Room", "Triple" (=3), "Quad" (=4), "6 PAX" (=6), "Suite for 5", "4+2 child", إلخ.
  • "Family Room" بدون رقم: غالباً تستوعب 4، اعتبرها مرشّحة لطلبات ≤4.
  • Occupancy بصيغة "X adults + Y child": إجمالي السعة = X + Y.
  • قد يكون عند نفس الفندق عدّة صفوف بـ Occupancies مختلفة — افحص كلّها.

❌ ممنوع الرفض المبني على فحص جزئي أو تخمين.

🔇 قاعدة الصمت في التفكير (مهمّة جداً جداً — صارمة):
أوّل حرف في ردّك يجب أن يكون إمّا حرف D (لـ DEST:) أو حرف C (لـ CHAT:). لا شيء غير ذلك. ممنوع بشكل قاطع:
  - أيّ مقدّمة مثل "أتحقق من" أو "أبحث في" أو "تمام دعني"
  - قول "البرنامج جاهز" قبل الـ DEST
  - أيّ شرح للخطوات أو تفكير قبل الرد
  - القول "تم بناء البرنامج" بدون إخراج DEST/HOTELS وغيرها فعلياً

كل التحليل داخلي صامت تماماً. الإخراج إمّا:
  - برنامج كامل: يبدأ بـ DEST: مباشرةً، يحوي كل الأقسام (DEST/META/DATE_FROM/CLIENT/HOTELS/FLIGHTS/TRANSFERS/TOURS/SUMMARY)، وينتهي بـ CHAT: ورسالة قصيرة جداً.
  - أو سؤال/رفض فقط: سطر واحد يبدأ بـ CHAT: ولا شيء غيره.

🚨 إذا قرّرت بناء البرنامج، اكتمل البناء كاملاً في الرد الواحد. ممنوع القول "جاهز" أو "تم" أو "هذا البرنامج" بدون إخراج الأقسام كلّها فعلياً ضمن نفس الرد. كل CHAT يجب أن يكون جملة أو جملتين فقط.

✅ في حالة الرفض، CHAT يكون مختصراً ويذكر أكبر Occupancy رأيتَه فعلاً (مثل: "أكبر غرفة عندنا في بالي تستوعب 4، تبغى غرفتين أو وجهة بديلة؟").
  7. السعر النهائي = Rate المذكور أمام تلك الـ Occupancy المختارة × عدد الليالي. لا تخلط أسعار من Occupancies أخرى.`;

  return `${questionRule}

${dataContext}

═══════════════════════════════════════════════════════
عند بناء البرنامج، استخدم هذا التنسيق الدقيق فقط:
═══════════════════════════════════════════════════════

${frontendFormat}`;
}

// تنسيق افتراضي يُستخدم إذا لم تُرسل الواجهة system خاصاً بها
const DEFAULT_FORMAT = `DEST:[اسم الوجهة]
META:[عدد الايام] ايام | [عدد الليالي] ليالي | [الشهر] | [عدد الافراد] اشخاص
DATE_FROM:[تاريخ البداية]
DATE_TO:[تاريخ النهاية]
CLIENT:[وصف العميل]
CLIENT_CODE:ALZ-2026-001

HOTELS:
[اسم الفندق] | [المنطقة] | [النجوم] نجوم | [نوع الغرفة] | [السعر] ريال/ليلة | [عدد الليالي] ليالي | [ما يشمل]

TRANSFERS:
اليوم [رقم] | [وصف] | Pickup | [السعر] ريال
اليوم [رقم] | [وصف] | Drop | [السعر] ريال

TOURS:
اليوم [رقم] | [اسم الجولة] | [ثقافية/طبيعية/بحرية] | [السعر] ريال

SUMMARY:
الفنادق | [الاجمالي] ريال
الانتقالات | [الاجمالي] ريال
الجولات السياحية | [الاجمالي] ريال
TOTAL_PER_PERSON:[رقم فقط]
TOTAL_GROUP:[رقم فقط] | [عدد] اشخاص

CHAT:[جملتين ودية للموظف باللهجة السعودية]`;

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

  try {
    const { messages, max_tokens = 1200, system: clientSystem } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages مطلوبة" }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const detectedDest  = detectDestination(messages);
    const detectedCities = detectedDest ? detectCitiesFromMessage(messages, detectedDest) : [];

    // ── Local Edit Engine ────────────────────────────────────────────────
    // If the last user message is a simple structural patch (add/remove
    // extra-bed, change SIM count) AND a built program exists in history,
    // apply it locally and skip Anthropic entirely. Costs $0.
    const lastUserMsg = (messages.length > 0 && messages[messages.length - 1].role === "user")
      ? String(messages[messages.length - 1].content || "")
      : "";
    const lastAssistantProgram = findLastBuiltProgram(messages);
    if (lastAssistantProgram && lastUserMsg) {
      const patched = tryLocalEdit(lastUserMsg, lastAssistantProgram);
      if (patched) {
        return new Response(JSON.stringify({
          id: "local-edit",
          model: "local-edit-engine",
          role: "assistant",
          content: [{ type: "text", text: patched }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }), { headers: CORS_HEADERS });
      }
    }

    // Local validation: if cities AND a per-city night distribution are
    // present but they don't sum to (days - 1), reject right here without
    // calling Anthropic at all. Saves the entire turn cost.
    if (detectedDest && detectedCities.length > 0) {
      const v = validateNightsDistribution(messages, detectedDest, detectedCities);
      if (!v.ok) {
        return new Response(JSON.stringify({
          id: "local-validation",
          model: "local",
          role: "assistant",
          content: [{ type: "text", text: "CHAT:" + v.message }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }), { headers: CORS_HEADERS });
      }
    }

    // Tweak-only follow-up with no built program AND no destination context:
    // intercept locally so a "غير السيارة لخاصة" sent to a fresh chat returns
    // a targeted message instead of being routed to Claude or to the lite
    // "tell me your trip" template.
    {
      const isTweakOnly = /^(?:\s*(?:غير|غيّر|اجعل|خل[يى]?|بدل|حول|ابي|ابغى|اريد|أريد|أبي|أبغى|اعمل|اضف|أضف|ضيف|زود|احذف|الغ[يى]?|شيل|ت?غي[يّ]?ر)\s+)?(?:(?:ال)?(?:سياره|سيارة|سيارات|تنقل|التنقل|نقل|cars?|transport|مشتركه|مشتركة|خاصه|خاصة)|(?:ال)?(?:شر[اي]ئ?ح|شريح[هة]|شرايح|sim|esim|سيم)|(?:سرير|أسر[ةه]|اسر[ةه]|سراير|سرايا|extra\s*-?\s*bed))/iu.test(lastUserMsg.trim());
      if (isTweakOnly && !lastAssistantProgram && !detectedDest) {
        return new Response(JSON.stringify({
          id: "tweak-without-program",
          model: "local",
          role: "assistant",
          content: [{ type: "text", text: "CHAT:محتاج برنامج محفوظ في المحادثة عشان أعدّله. أرسل تفاصيل الرحلة كاملة (الوجهة + الأيام + التوزيع + الأشخاص) أوّلاً، وبعدها قدر أعدّل السيارة/الشرائح/السرير الإضافي." }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }), { headers: CORS_HEADERS });
      }
    }

    // ── Pure Local Engine ─────────────────────────────────────────────
    // If we have ALL required info (destination + cities + nights + adults),
    // build the entire program locally without calling Anthropic. $0 cost.
    // Otherwise, if destination is known but cities/distribution missing,
    // ALSO answer locally (template question) — Turn 1 should never hit
    // Claude either.
    if (detectedDest && DEST_CITIES[detectedDest]) {
      const cityDefs = DEST_CITIES[detectedDest];
      const tripRequest = parseTripRequest(messages, cityDefs);
      const cityArabicNames: Record<string, string> = {
        "Ha Noi": "هانوي", "Sapa": "سابا", "Ha Long": "هالونج",
        "Da Nang": "دانانج", "Phu Quoc": "فوكوك", "Ho Chi Minh": "هوتشي مينه",
        "Kuala Lumpur": "كوالالمبور", "Selangor": "سيلانجور",
        "Langkawi": "لانكاوي", "Penang": "بينانج", "Cameron Highlands": "كاميرون هايلاند",
        "Bangkok": "بانكوك", "Phuket": "بوكيت", "Krabi": "كرابي",
        "Chiang Mai": "شيانغ ماي", "Pattaya": "باتايا", "Koh Samui": "كوه ساموي",
        "Istanbul": "اسطنبول", "Trabzon": "طرابزون", "Uzungol": "أوزنجول",
        "Ayder": "ايدر", "Rize": "ريزا", "Bursa": "بورصة", "Sapanca": "سابانجا",
        "Moscow": "موسكو", "St Petersburg": "سانت بطرسبرغ", "Sochi": "سوتشي",
        "Sarajevo": "سراييفو", "Mostar": "موستار", "Bihać": "بيهاتش",
        "Bali": "بالي", "Jakarta": "جاكرتا", "Bandung": "باندونغ", "Puncak": "بونشاك",
      };
      const destAr: Record<string, string> = {
        vietnam: "فيتنام", Malaysia: "ماليزيا", thailand: "تايلاند",
        Turky: "تركيا", russia: "روسيا", Bosnia: "البوسنة", indonesia: "إندونيسيا",
      };

      // CASE A: distribution missing → ask locally (no Claude, $0)
      if (!canBuildLocally(tripRequest)) {
        // Targeted message when the user is trying to tweak transport/SIM/
        // bed but we have no built program AND insufficient trip details to
        // (re)build. Otherwise the generic "tell me your cities" question
        // is confusing — they're not asking to start over.
        const isTweakOnly = /^(?:\s*(?:غير|غيّر|اجعل|خل[يى]?|بدل|حول|ابي|ابغى|اريد|أريد|أبي|أبغى|اعمل|اضف|أضف|ضيف|زود|احذف|الغ[يى]?|شيل|ت?غي[يّ]?ر)\s+)?(?:(?:ال)?(?:سياره|سيارة|سيارات|تنقل|التنقل|نقل|cars?|transport|مشتركه|مشتركة|خاصه|خاصة)|(?:ال)?(?:شر[اي]ئ?ح|شريح[هة]|شرايح|sim|esim|سيم)|(?:سرير|أسر[ةه]|اسر[ةه]|سراير|سرايا|extra\s*-?\s*bed))/iu.test(lastUserMsg.trim());
        if (isTweakOnly && !lastAssistantProgram) {
          return new Response(JSON.stringify({
            id: "tweak-without-program",
            model: "local-engine",
            role: "assistant",
            content: [{ type: "text", text: "CHAT:محتاج برنامج محفوظ في المحادثة عشان أعدّله. أرسل تفاصيل الرحلة كاملة (الوجهة + الأيام + التوزيع + الأشخاص) أوّلاً، وبعدها قدر أعدّل السيارة/الشرائح/السرير الإضافي." }],
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          }), { headers: CORS_HEADERS });
        }
        const cityList = cityDefs.map(c => cityArabicNames[c.canonical] || c.canonical).join("، ");
        const targetNights = tripRequest.daysTotal ? tripRequest.daysTotal - 1 : "[عدد الليالي]";
        const localQuestion = `CHAT:تمام! المدن المتاحة في ${destAr[detectedDest] || detectedDest}: ${cityList}. ` +
          `عشان أبني البرنامج بمكالمة واحدة (بأقل تكلفة)، أعطني في رد واحد:\n` +
          `1) كم ليلة لكل مدينة؟ (مجموع الليالي = ${targetNights})\n` +
          `2) كم شريحة هاتف؟ (50 ريال للشريحة، أو "بدون")\n` +
          `3) سرير إضافي؟ ("نعم لكل الفنادق" / "نعم لـ [مدينة]" / "بدون")\n` +
          `4) التنقل: خاصة أم مشتركة؟`;
        return new Response(JSON.stringify({
          id: "local-question",
          model: "local-engine",
          role: "assistant",
          content: [{ type: "text", text: localQuestion }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }), { headers: CORS_HEADERS });
      }

      // CASE B: full info present → build program locally
      if (canBuildLocally(tripRequest)) {
        try {
          const result = await buildLocalProgram(
            tripRequest,
            cityDefs,
            async () => {
              const dest = detectedDest;
              const [hRes, tRes, fRes, trRes] = await Promise.all([
                supabase.from("hotels").select("*").ilike("location", `% - ${dest}`),
                supabase.from("tours").select("*").eq("type", dest),
                supabase.from("flights").select("*").eq("destination", dest),
                supabase.from("trains").select("*").eq("destination", dest),
              ]);
              return {
                hotels: (hRes.data || []) as HotelRow[],
                tours: (tRes.data || []) as TourRow[],
                flights: (fRes.data || []) as FlightRow[],
                trains: (trRes.error ? [] : (trRes.data || [])) as FlightRow[],
              };
            },
            cityArabicNames,
          );
          if (result.ok) {
            // If this rebuild was triggered by a transport-only follow-up,
            // overwrite the generic CHAT line with a clear acknowledgement.
            // Without this, the employee sees the program update silently
            // (no message saying "تم التغيير") and assumes nothing happened.
            let programText = result.program;
            const transportTweak = /^(?:\s*(?:غير|غيّر|اجعل|خل[يى]?|بدل|حول|ابي|ابغى|اريد|أريد|أبي|أبغى|اعمل|ت?غي[يّ]?ر)\s+)?(?:(?:ال)?(?:سياره|سيارة|سيارات|تنقل|التنقل|نقل|مشتركه|مشتركة)\s*)?(?:من\s+(?:ال)?(?:سياره|سيارة|مشتركه|مشتركة|خاصه|خاصة)\s+)?(?:ال[يى]|الى|إلى|الى)?\s*(خاصه|خاصة|مشتركه|مشتركة|private|shared)/iu.test(lastUserMsg.trim());
            if (transportTweak && lastAssistantProgram) {
              const newType = tripRequest.transport === "private" ? "خاصة" : "مشتركة";
              const newTotalMatch = result.program.match(/TOTAL_GROUP:([\d,]+)/);
              const newTotal = newTotalMatch ? newTotalMatch[1] : "?";
              const ackChat = `CHAT:تم تغيير السيارة إلى ${newType}. الإجمالي الجديد: ${newTotal} ريال.`;
              programText = result.program.replace(/^CHAT:.*$/m, ackChat);
              if (!/^CHAT:/m.test(programText)) programText += `\n\n${ackChat}`;
            }
            return new Response(JSON.stringify({
              id: "local-build",
              model: "local-engine",
              role: "assistant",
              content: [{ type: "text", text: programText }],
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            }), { headers: CORS_HEADERS });
          }
          // result.ok === false → respond with CHAT message (still local, $0)
          return new Response(JSON.stringify({
            id: "local-build-incomplete",
            model: "local-engine",
            role: "assistant",
            content: [{ type: "text", text: "CHAT:" + result.chatMessage }],
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          }), { headers: CORS_HEADERS });
        } catch (e) {
          // Don't silently fall through to Claude — that would charge the
          // user without them knowing. Instead, surface the error locally so
          // they can fix it (or ask explicitly to use Claude). Logging lets
          // us debug repeat issues from the Supabase function logs.
          const errMsg = (e as Error).message || String(e);
          console.error("[local-engine] crashed for dest=" + detectedDest + ":", errMsg);
          return new Response(JSON.stringify({
            id: "local-engine-error",
            model: "local-engine",
            role: "assistant",
            content: [{ type: "text", text: "CHAT:تعذّر بناء البرنامج محلياً (" + errMsg + "). يرجى المحاولة مرة أخرى أو إعادة صياغة الطلب." }],
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          }), { headers: CORS_HEADERS });
        }
      }
    }

    // Two-mode data context:
    //   - destination known but no cities yet → ship lite (city list only),
    //     ~2K tokens. Prompt rule below tells the AI to ask for the
    //     night distribution before doing anything else.
    //   - cities specified → ship full data filtered to those cities only.
    let dataContext: string;
    if (detectedDest && detectedCities.length === 0) {
      dataContext = buildLiteCitiesContext(detectedDest);
    } else {
      dataContext = await buildDataContext(supabase, detectedDest, detectedCities.length > 0 ? detectedCities : null);
    }

    const formatSection = (typeof clientSystem === "string" && clientSystem.trim().length > 0)
      ? clientSystem
      : DEFAULT_FORMAT;
    const systemPrompt  = buildSystemPrompt(dataContext, formatSection);

    const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

    // Reverted to Sonnet 4.6 after Haiku failed Adults-exact-match
    // (gave 2-pax rooms for a 6-pax request). Sonnet costs ~3× more but
    // strictly follows the 1500+ lines of business rules. Cache + per-
    // destination filter still keep the typical build to ~$0.37.
    const response = await client.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    return new Response(JSON.stringify(response), { headers: CORS_HEADERS });

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
});
