// ─────────────────────────────────────────────────────────────────────────
// Local Parser — extracts a structured trip request from the chat history.
// No AI involved. Single source of truth for what the employee actually
// asked for. Used by the deterministic program builder + validators.
// ─────────────────────────────────────────────────────────────────────────

export type CityStay = { city: string; nights: number };

export type TripRequest = {
  /** "vietnam" / "Malaysia" / etc. — same canonical names as DEST_CITIES keys */
  destination: string | null;
  /** Canonical city names mentioned by the employee (deduped) */
  cities: string[];
  /**
   * ORDERED stays — preserves the order the employee gave AND keeps duplicates
   * (e.g. "2 هانوي + 2 هالونج + 2 هانوي" produces 3 entries with Hanoi twice).
   * Used by the Day Arranger to schedule the actual route.
   */
  cityStaysOrdered: CityStay[];
  /** Total days from "N يوم" / "N أيام" */
  daysTotal: number | null;
  /** Per-city nights TOTAL across all stays (sum of cityStaysOrdered) */
  nightsByCity: Record<string, number>;
  /** Number of adults (defaults to 2 if not given) */
  adults: number | null;
  /** Number of children mentioned (under-5 not counted toward occupancy) */
  children: number | null;
  /** Star ratings the employee accepts. null = any. [4] = strict 4*. [4,5] = either */
  stars: number[] | null;
  /** Free-form keywords from message that should match against room_type */
  roomFeatures: string[];
  /** null = not asked yet. 0 = explicit "no". N = asked for N SIMs */
  sim: number | null;
  /** Extra-bed scope. "none" = not requested. "all" = every hotel. [city] = specific cities */
  extraBed: { scope: "none" | "all" | string[] };
  /** Inter-city transport preference */
  transport: "private" | "shared" | null;
  /** Travel month in Arabic ("يونيو") or numeric "6" */
  month: string | null;
  /** Travel year */
  year: number | null;
  /** ISO date YYYY-MM-DD if a specific start date was given */
  startDate: string | null;
};

export type CityDef = { canonical: string; pattern: RegExp };

/** Convert Arabic-Indic digits to ASCII so /\d+/ patterns work uniformly. */
function arabicDigitsToLatin(s: string): string {
  return s
    .replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/[۰-۹]/g, c => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)));
}

/** Glue all messages into one searchable blob. */
function joinMessages(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    .join("\n");
}

const ARABIC_MONTHS: Record<string, number> = {
  "يناير": 1, "كانون الثاني": 1,
  "فبراير": 2, "شباط": 2,
  "مارس": 3, "آذار": 3, "اذار": 3,
  "أبريل": 4, "ابريل": 4, "نيسان": 4,
  "مايو": 5, "أيار": 5, "ايار": 5,
  "يونيو": 6, "حزيران": 6,
  "يوليو": 7, "تموز": 7,
  "أغسطس": 8, "اغسطس": 8, "آب": 8, "اب": 8,
  "سبتمبر": 9, "أيلول": 9, "ايلول": 9,
  "أكتوبر": 10, "اكتوبر": 10, "تشرين الأول": 10,
  "نوفمبر": 11, "تشرين الثاني": 11,
  "ديسمبر": 12, "كانون الأول": 12,
};

function parseDestination(text: string): string | null {
  // Keep this in sync with index.ts:detectDestination — both must accept the
  // same Saudi/colloquial spellings, otherwise canBuildLocally fails for
  // requests that the outer router accepted (the outer one knows the dest,
  // but the parser doesn't, so request.destination is null and the engine
  // falls back to asking the lite question).
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

function parseCities(text: string, cityDefs: CityDef[]): string[] {
  const found: string[] = [];
  for (const { canonical, pattern } of cityDefs) {
    if (pattern.test(text) && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}

function parseDays(text: string): number | null {
  const t = arabicDigitsToLatin(text);
  const m = t.match(/(\d{1,2})\s*(?:يوم|أيام|ايام|days?)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseAdults(text: string): number | null {
  const t = arabicDigitsToLatin(text);
  // Dual forms (no number)
  if (/زوجين|زوجان|couple/i.test(t)) return 2;
  if (/شخصين|شخصان|شخصاً|شخصا|بالغين|بالغان/.test(t)) return 2;
  // "6 أشخاص" / "2 شخص" / "3 كبار" / "ل شخصين"
  const m = t.match(/(\d{1,2})\s*(?:شخص|أشخاص|اشخاص|كبار|بالغ|adults?|persons?|pax)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function parseChildren(text: string): number | null {
  const t = arabicDigitsToLatin(text);
  const m = t.match(/(\d{1,2})\s*(?:طفل|أطفال|اطفال|child|children|kids?)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseStars(text: string): number[] | null {
  const t = arabicDigitsToLatin(text);
  // "4 أو 5 نجوم" / "4 و 5 نجوم"
  const range = t.match(/(\d)\s*(?:أو|او|و|or)\s*(\d)\s*(?:نجوم|نجمة|stars?|★)/i);
  if (range) {
    const a = parseInt(range[1], 10);
    const b = parseInt(range[2], 10);
    return [a, b].filter(x => x >= 1 && x <= 5).sort();
  }
  // "5 نجوم" / "4 نجوم" / "3 نجوم"
  const single = t.match(/(\d)\s*(?:نجوم|نجمة|stars?|★)/i);
  if (single) {
    const n = parseInt(single[1], 10);
    if (n >= 1 && n <= 5) return [n];
  }
  return null;
}

const ROOM_FEATURE_KEYWORDS: Array<[RegExp, string]> = [
  [/إطلالة\s*بحرية|اطلالة\s*بحرية|sea\s*view|seaview|ocean\s*view|beach\s*view/i, "sea view"],
  [/إطلالة\s*جبلية|اطلالة\s*جبلية|mountain\s*view|hill\s*view/i, "mountain view"],
  [/فيلا|villa/i, "villa"],
  [/عائلية|عائلي|family/i, "family"],
  [/سرير\s*كنغ|king\s*bed/i, "king"],
  [/سريرين|twin|two\s*single/i, "twin"],
  [/مع\s*مسبح|بمسبح|pool|with\s*pool/i, "pool"],
  [/غير\s*مدخن|non[\s-]?smoking|nonsmoking/i, "non smoking"],
  [/تنفيذي|executive/i, "executive"],
  [/سويت|suite/i, "suite"],
  [/جناح/i, "suite"],
  [/ديلوكس|deluxe/i, "deluxe"],
  [/برمير|بريمير|premier/i, "premier"],
  [/شاطئ|beach/i, "beach"],
];

function parseRoomFeatures(text: string): string[] {
  const found: string[] = [];
  for (const [re, label] of ROOM_FEATURE_KEYWORDS) {
    if (re.test(text) && !found.includes(label)) found.push(label);
  }
  return found;
}

function parseSim(text: string): number | null {
  const t = arabicDigitsToLatin(text);
  // "بدون شرائح" / "ما أبغى شرائح"
  if (/بدون\s*شرا[ئي]ح|بدون\s*شريحة|بدون\s*sim|no\s*sim|ما\s*أبغى\s*شرا|ما\s*ابغى\s*شرا|بدون\s*هاتف/i.test(t)) return 0;
  // "4 شرائح" / "ضيف 3 شرائح" / "SIM:5"
  const m = t.match(/(\d{1,2})\s*(?:شرا[ئي]ح|شريحة|سيم|sim)/i)
        || t.match(/SIM\s*[:=]\s*(\d{1,2})/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 50) return n;
  }
  return null;
}

function parseExtraBed(text: string, cityDefs: CityDef[]): TripRequest["extraBed"] {
  const t = arabicDigitsToLatin(text);
  // Negative first
  if (/بدون\s*سرير|بدون\s*أسرّة|بدون\s*اسرة|no\s*extra\s*bed/i.test(t)) return { scope: "none" };

  const isBedKeyword = /(?:سرير|اسرّ?ة|أسرّة|أسرة|سراير|سرايا|سرير(?:ين|ان)?|extra\s*-?\s*bed|sofa\s*-?\s*bed)/iu;
  const hasExtraIntent = /(?:اضافي|إضافي|اضاف|زيادة|زياده|extra)/iu;
  const addVerb = /(?:ضيف|أضيف|اضف|أضف|زود|أزود|اضيف|أحتاج|احتاج|بدي|ابغى|أبغى|أبي|ابي|أريد|اريد|need|want|add|put|include)/iu;

  if ((addVerb.test(t) && isBedKeyword.test(t)) || (isBedKeyword.test(t) && hasExtraIntent.test(t))) {
    // Try to find specific cities mentioned alongside the bed request
    const cities: string[] = [];
    for (const { canonical, pattern } of cityDefs) {
      if (pattern.test(t)) cities.push(canonical);
    }
    // If "كل / جميع / للكل / كافة" → ALL
    if (/كل\s*الفنادق|جميع\s*الفنادق|للكل|كافة\s*الفنادق|all\s*hotels|in\s*all/i.test(t) || cities.length === 0) {
      return { scope: "all" };
    }
    return { scope: cities };
  }
  return { scope: "none" };
}

function parseTransport(text: string): "private" | "shared" | null {
  if (/خاصة|خاص|بسيارة\s*خاصة|private/i.test(text)) return "private";
  if (/مشتركة|مشترك|shared|ليموزين/i.test(text)) return "shared";
  return null;
}

function parseMonth(text: string): { month: string | null; year: number | null } {
  const t = arabicDigitsToLatin(text);
  // Look for a month name + optional year
  for (const [name, num] of Object.entries(ARABIC_MONTHS)) {
    if (new RegExp(name, "i").test(t)) {
      const yearMatch = t.match(new RegExp(name + "\\s+(\\d{4})"));
      const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
      return { month: name, year };
    }
  }
  // English month
  const en = t.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{4})?/i);
  if (en) return { month: en[1], year: en[2] ? parseInt(en[2], 10) : null };
  return { month: null, year: null };
}

function parseStartDate(text: string): string | null {
  const t = arabicDigitsToLatin(text);
  // "السفر 14 مايو" / "ابدأ من 1 يونيو 2026"
  const m = t.match(/(?:السفر|ابدأ|ابدا|من|تاريخ|date)\s*(?:يوم\s*)?(\d{1,2})[\s/-]*(?:شهر\s*)?(\w+)?\s*(\d{4})?/i);
  if (m) {
    const day = parseInt(m[1], 10);
    let monthNum: number | null = null;
    if (m[2]) {
      const monthLower = m[2].toLowerCase();
      // Try Arabic month
      for (const [name, num] of Object.entries(ARABIC_MONTHS)) {
        if (monthLower.includes(name)) { monthNum = num; break; }
      }
      // Try numeric "5/14"
      if (!monthNum && /^\d+$/.test(m[2])) monthNum = parseInt(m[2], 10);
    }
    if (day >= 1 && day <= 31 && monthNum && monthNum >= 1 && monthNum <= 12) {
      const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
      return `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * Parse per-city night distribution from text like:
 *   "هانوي 3 + سابا 2 + هالونج 1"
 *   "Hanoi=4، Penang=3"
 *   "كوالالمبور 4 وبينانج 3"
 */
/**
 * Parse ordered city stays from text. Scans the text linearly for "N city"
 * pairs where the digit appears immediately before (or after) a city name —
 * NOT bare digits like "6 اشخاص" or "15 يوم" elsewhere in the message.
 * Preserves the ORDER the employee wrote, INCLUDING duplicates.
 */
function parseCityStaysOrdered(text: string, cityDefs: CityDef[]): CityStay[] {
  const t = arabicDigitsToLatin(text);
  // Build a single combined regex matching either "N city" or "city N",
  // capturing the city name + number. Use named-group alternation by
  // running per-city regex and merging results sorted by position.
  type Hit = { city: string; nights: number; pos: number };
  const hits: Hit[] = [];
  for (const { canonical, pattern } of cityDefs) {
    const cityPat = pattern.source;
    const re = new RegExp(
      `(?:(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتى]?|ليلتين|نايت|night)?\\s*(?:${cityPat}))` +
      `|(?:(?:${cityPat})\\s*(?:=|:|-|بـ|في|عن|لمدة|ل)?\\s*(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتى]?|ليلتين|نايت|night)?)`,
      "igu"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const n = parseInt(m[1] || m[2] || "0", 10);
      if (n > 0 && n <= 30) {
        hits.push({ city: canonical, nights: n, pos: m.index });
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  // Sort by position so we get the order the employee wrote them
  hits.sort((a, b) => a.pos - b.pos);
  return hits.map(h => ({ city: h.city, nights: h.nights }));
}

function parseNightsByCity(text: string, cityDefs: CityDef[]): Record<string, number> {
  const t = arabicDigitsToLatin(text);
  const result: Record<string, number> = {};
  for (const { canonical, pattern } of cityDefs) {
    const cityPat = pattern.source;
    // Global flag — sums ALL occurrences of "N city" / "city N" in the text.
    // This way "هانوي 2 + ... + هانوي 2" correctly totals as 4 for Hanoi.
    const re = new RegExp(
      `(?:(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتى]?|ليلتين|نايت|night)?\\s*(?:${cityPat}))` +
      `|(?:(?:${cityPat})\\s*(?:=|:|-|بـ|في|عن|لمدة|ل)?\\s*(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتى]?|ليلتين|نايت|night)?)`,
      "igu"
    );
    let total = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const n = parseInt(m[1] || m[2] || "0", 10);
      if (n > 0 && n <= 30) total += n;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (total > 0) result[canonical] = total;
  }
  return result;
}

/**
 * Master parser. Walks through all messages and extracts the trip request.
 * Caller passes the cityDefs table for the detected destination.
 */
export function parseTripRequest(
  messages: Array<{ role: string; content: unknown }>,
  cityDefs: CityDef[],
): TripRequest {
  const text = joinMessages(messages);
  const dest = parseDestination(text);
  const cities = parseCities(text, cityDefs);
  const monthInfo = parseMonth(text);

  const stays = parseCityStaysOrdered(text, cityDefs);
  // If we have ordered stays, derive nightsByCity from them (sums duplicates).
  // Else fall back to the legacy per-city scanner.
  const nightsByCity = stays.length > 0
    ? stays.reduce<Record<string, number>>((acc, s) => {
        acc[s.city] = (acc[s.city] || 0) + s.nights;
        return acc;
      }, {})
    : parseNightsByCity(text, cityDefs);

  return {
    destination: dest,
    cities,
    cityStaysOrdered: stays,
    daysTotal: parseDays(text),
    nightsByCity,
    adults: parseAdults(text),
    children: parseChildren(text),
    stars: parseStars(text),
    roomFeatures: parseRoomFeatures(text),
    sim: parseSim(text),
    extraBed: parseExtraBed(text, cityDefs),
    transport: parseTransport(text),
    month: monthInfo.month,
    year: monthInfo.year,
    startDate: parseStartDate(text),
  };
}
