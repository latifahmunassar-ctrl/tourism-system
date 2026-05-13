// ─────────────────────────────────────────────────────────────────────────
// Local Parser — extracts a structured trip request from the chat history.
// No AI involved. Single source of truth for what the employee actually
// asked for. Used by the deterministic program builder + validators.
// ─────────────────────────────────────────────────────────────────────────

export type CityStay = { city: string; nights: number };

/**
 * A follow-up modification to a built program's tour list.
 *   - `remove`: drop the matching tour, leave a free day
 *   - `swap`:   replace `from` with `to` (both resolved against the catalog)
 *   - `add`:    pin a specific tour for a city (for "free day → tour" requests)
 * Multiple modifications in one message are NOT supported in v1 — only the
 * latest/most-specific match wins.
 */
export type TourModification =
  | { kind: "remove"; name: string }
  | { kind: "swap"; from: string; to: string }
  | { kind: "add"; name: string; cityHint: string | null };

/**
 * Which stay of a city the swap targets when the city appears multiple times
 * in the trip (e.g., "Hanoi → Sapa → Hanoi"). "all" means apply to every
 * stay of that city (the default when the user gave no qualifier); "first"
 * / "last" are the common ordinal qualifiers; a number is the 1-based index
 * ("الثاني" → 2). The builder asks for disambiguation when the city has
 * multiple stays AND the hint is "all".
 */
export type HotelStayHint = "all" | "first" | "last" | number;

/**
 * A follow-up modification to a built program's hotel selection.
 *   - `nextCheaper`: replace the hotel in `cityHint` with the next-cheapest
 *     unused option (matching occupancy + stars). The builder reads previous
 *     programs in the conversation to figure out which hotels have already
 *     been tried, so successive "غير فندق سابا" calls walk down the ladder.
 *   - `targetOccupancy`: optional override for occupancy on THIS swap only,
 *     e.g. "غير فندق هانوي لـ 4 أشخاص" — the rest of the trip keeps using
 *     `request.adults`.
 */
export type HotelModification =
  | { kind: "nextCheaper"; cityHint: string; stayHint: HotelStayHint; targetOccupancy: number | null };

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
  /**
   * Follow-up edits to the previously built program's tour list. Parsed from
   * the LATEST user message only (so a removal from a prior turn doesn't
   * re-fire on every rebuild). Names are raw fragments — the builder resolves
   * them against the catalog using fuzzy keyword matching.
   */
  tourModifications: TourModification[];
  /**
   * Follow-up edits to the previously built program's hotel selection. Same
   * "latest message only" rule as tourModifications.
   */
  hotelModifications: HotelModification[];
};

export type CityDef = { canonical: string; pattern: RegExp };

/** Convert Arabic-Indic digits to ASCII so /\d+/ patterns work uniformly. */
function arabicDigitsToLatin(s: string): string {
  return s
    .replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/[۰-۹]/g, c => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)));
}

/**
 * Convert spelled-out night counts to digit form so the existing per-city
 * regex catches them. Saudi/colloquial Arabic frequently writes:
 *   "هانوي ليلتين"          (dual: 2 nights)
 *   "ثلاث ليال هانوي"        (number-word + plural noun)
 *   "هانوي ثلاث ليالي"
 * We normalize all of these to "<digit> ليال" before the night-counter
 * regex runs. Affects validateNightsDistribution, parseNightsByCity, and
 * parseCityStaysOrdered uniformly.
 */
function normalizeNightWords(s: string): string {
  let t = s;
  // Dual forms: ليلتين / ليلتان → "2 ليال"
  t = t.replace(/ليلت(?:ين|ان)/gu, "2 ليال");
  // <numword> + nightWord → "<digit> ليال"
  // Order matters — longer words first so "عشر" doesn't eat into "عشرة".
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

/** Glue all messages into one searchable blob. */
function joinMessages(messages: Array<{ role: string; content: unknown }>): string {
  // Find the LATEST user message that contains a full trip request
  // (mentions days OR a date range), then append any follow-up user
  // messages that came AFTER it. This way:
  //   - cities/days/adults are read from the most recent full request
  //     (a re-send with one digit changed isn't double-counted)
  //   - small follow-ups ("غير السيارة لخاصة" / "اضف شريحه" / "+ سرير
  //     في هانوي") still influence the parsed result, so the engine
  //     can rebuild with the updated transport / SIM / bed scope.
  const texts = messages
    .filter(m => m.role === "user")
    .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  const hasTripSignal = (t: string) =>
    /(\d{1,2})\s*(?:يوم|أيام|ايام|days?)/i.test(t) ||
    /من\s+(?:تاريخ\s+|يوم\s+)?\d{1,2}\s+[؀-ۿ]+\s+(?:إلى|الى|إلي|الي|ل)\s+(?:تاريخ\s+|يوم\s+)?\d{1,2}\s+[؀-ۿ]+/iu.test(t);
  let baseIdx = -1;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (hasTripSignal(texts[i])) { baseIdx = i; break; }
  }
  if (baseIdx < 0) return texts[texts.length - 1] || "";
  // Base + any messages after it (follow-up edits).
  return [texts[baseIdx], ...texts.slice(baseIdx + 1)].join("\n");
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
    [/روسيا|russia|موسكو|moscow|سان?ت?\s+(?:بطرس|برغ)|بطرس(?:بور[جك]|برغ)|saint\s*petersburg|سوتشي|sochi/i, "russia"],
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
  // Direct: "11 يوم" / "12 أيام" / "10 days"
  const m = t.match(/(\d{1,2})\s*(?:يوم|أيام|ايام|days?)/i);
  if (m) return parseInt(m[1], 10);
  // Date range: "من 11 يوليو إلى 22 يوليو" → 12 days (inclusive of both ends)
  const rangeMonth: Record<string, number> = {
    "يناير":1,"فبراير":2,"مارس":3,"أبريل":4,"ابريل":4,"مايو":5,"يونيو":6,
    "يوليو":7,"أغسطس":8,"اغسطس":8,"سبتمبر":9,"أكتوبر":10,"اكتوبر":10,
    "نوفمبر":11,"ديسمبر":12,
  };
  // Allow optional "تاريخ" / "يوم" filler before each date — common phrasing
  // is "من تاريخ 11 يوليو إلى تاريخ 22 يوليو" or "من يوم 11 الى 22 يوليو".
  const r = t.match(/من\s+(?:تاريخ\s+|يوم\s+)?(\d{1,2})\s+([؀-ۿ]+)\s+(?:إلى|الى|إلي|الي|ل)\s+(?:تاريخ\s+|يوم\s+)?(\d{1,2})\s+([؀-ۿ]+)/iu);
  if (r) {
    const d1 = parseInt(r[1], 10), d2 = parseInt(r[3], 10);
    const m1 = rangeMonth[r[2]] || 0, m2 = rangeMonth[r[4]] || 0;
    if (m1 && m2) {
      const y = new Date().getFullYear();
      const start = new Date(y, m1 - 1, d1);
      // Cross-year range (e.g., "25 ديسمبر إلى 8 يناير") — when the end
      // month is numerically before the start month, the trip crosses the
      // calendar boundary, so bump the end year by 1.
      const endYear = m2 < m1 ? y + 1 : y;
      const end = new Date(endYear, m2 - 1, d2);
      const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
      if (days > 0 && days <= 60) return days;
    }
  }
  return null;
}

function parseAdults(text: string): number | null {
  // Strip per-hotel occupancy overrides ("غير فندق هانوي لـ 4 أشخاص") before
  // scanning — otherwise the override's "4" gets read as the trip's adult
  // count and overrides the base request's "لثلاث افراد".
  const cleaned = text.replace(
    /(?:بد[ّ]?ل[يىه]?|غي[ّ]?ر[يى]?|اغير|استبدل|change|swap)\s+(?:لي\s+)?(?:ال)?فندق[^\n]*?(?:ل[ـ]?|لـ)\s*\d{1,2}\s*(?:شخص|أشخاص|اشخاص|بالغ|بالغين|[أا]فراد|كبار)/giu,
    " ",
  );
  const t = arabicDigitsToLatin(cleaned);
  // Dual forms (no number)
  if (/زوجين|زوجان|couple/i.test(t)) return 2;
  if (/شخصين|شخصان|شخصاً|شخصا|بالغين|بالغان|فردين|فردان|شخصاين/.test(t)) return 2;
  // "6 أشخاص" / "2 شخص" / "3 كبار" / "ل شخصين" / "4 افراد" / "4 أفراد"
  const personNoun = "(?:شخص|أشخاص|اشخاص|كبار|بالغ|[أا]فراد|[أا]فرد|adults?|persons?|pax)";
  const m = t.match(new RegExp(`(\\d{1,2})\\s*${personNoun}`, "i"));
  if (m) return parseInt(m[1], 10);
  // Word numbers: "أربع افراد" / "خمسة أشخاص" / "ست افراد"
  const wordNum: Array<[string, number]> = [
    ["عشر[ةه]?", 10], ["تسع[ةه]?", 9], ["ثمان(?:ية|يه)?", 8],
    ["سبع[ةه]?", 7], ["ست[ةه]?", 6], ["خمس[ةه]?", 5],
    ["[أا]ربع[ةه]?", 4], ["ثلاث[ةه]?|تلات[ةه]?", 3],
    ["[إا]ثن[يا][نه]", 2], ["واحد[ةه]?|وحد[ةه]?", 1],
  ];
  for (const [w, n] of wordNum) {
    const re = new RegExp(`(?:^|\\s|ل)(?:${w})\\s+${personNoun}`, "iu");
    if (re.test(t)) return n;
  }
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
  // Score each mention so a "negated" form ("بدون مشتركة" / "ليس مشتركة")
  // contributes the OPPOSITE intent. Then the highest-positioned mention
  // (latest in text) wins, so a follow-up override beats the base request.
  // Without this, "خاصة وليس مشتركة" would resolve to shared (last word
  // "مشتركة"), the wrong intent.
  const NEG = /(?:بدون|ليس|مو|ليست|ما\s+ابي|ما\s+اريد|لا)\s*$/u;
  const privReg = /خاصة|خاص|private/giu;
  const sharReg = /مشتركة|مشترك|shared|ليموزين/giu;
  let lastPriv = -1, lastShar = -1;
  for (const m of text.matchAll(privReg)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    // "بدون خاصة" → counts as "shared"; otherwise as "private"
    if (NEG.test(before)) lastShar = Math.max(lastShar, m.index ?? -1);
    else                  lastPriv = Math.max(lastPriv, m.index ?? -1);
  }
  for (const m of text.matchAll(sharReg)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (NEG.test(before)) lastPriv = Math.max(lastPriv, m.index ?? -1);
    else                  lastShar = Math.max(lastShar, m.index ?? -1);
  }
  if (lastPriv < 0 && lastShar < 0) return null;
  return lastPriv > lastShar ? "private" : "shared";
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
  // "السفر 14 مايو" / "ابدأ من 1 يونيو 2026" / "من تاريخ 25 ديسمبر إلى 8 يناير"
  // The month capture uses a non-whitespace class instead of \w because \w
  // is ASCII-only in JS — Arabic month names like "ديسمبر" would otherwise
  // fail to capture and the start date would silently fall back to next month.
  const m = t.match(/(?:السفر|ابدأ|ابدا|من|تاريخ|date)\s*(?:يوم\s*)?(\d{1,2})[\s/-]*(?:شهر\s*)?([^\s/\-،,]+)?\s*(\d{4})?/i);
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
  const t = normalizeNightWords(arabicDigitsToLatin(text));
  // Build a single combined regex matching either "N city" or "city N",
  // capturing the city name + number. Use named-group alternation by
  // running per-city regex and merging results sorted by position.
  type Hit = { city: string; nights: number; pos: number };
  const hits: Hit[] = [];
  for (const { canonical, pattern } of cityDefs) {
    const cityPat = pattern.source;
    // "city N" REQUIRES a trailing nights-word; otherwise a header like
    // "سانت بطرس 10 ايام" would credit the trip-day count as nights.
    const re = new RegExp(
      `(?:(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتهى]?|ليلتين|ليه|نايت|night)?\\s*(?:${cityPat}))` +
      `|(?:(?:${cityPat})\\s*(?:=|:|-|بـ|في|عن|لمدة|ل)?\\s*(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتهى]?|ليلتين|ليه|نايت|night))`,
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
  const t = normalizeNightWords(arabicDigitsToLatin(text));
  const result: Record<string, number> = {};
  for (const { canonical, pattern } of cityDefs) {
    const cityPat = pattern.source;
    // Global flag — sums ALL occurrences of "N city" / "city N" in the text.
    // This way "هانوي 2 + ... + هانوي 2" correctly totals as 4 for Hanoi.
    // "city N" REQUIRES a trailing nights-word; otherwise a header like
    // "سانت بطرس 10 ايام" would credit the trip-day count as nights.
    const re = new RegExp(
      `(?:(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتهى]?|ليلتين|ليه|نايت|night)?\\s*(?:${cityPat}))` +
      `|(?:(?:${cityPat})\\s*(?:=|:|-|بـ|في|عن|لمدة|ل)?\\s*(\\d{1,2})\\s*(?:ليال[يى]?|ليل[ةتهى]?|ليلتين|ليه|نايت|night))`,
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
/**
 * Parse tour-modification follow-ups from the LATEST user message only.
 *
 * Recognized intents:
 *   - "غير/بدّل/استبدل جولة X بجولة Y"   → swap
 *   - "غير/بدّل جولة X بيوم حر"           → remove (day becomes free)
 *   - "احذف/شيل/ألغ جولة X"               → remove
 *
 * Returns an empty array if no modification is detected. The X/Y values are
 * RAW fragments — the builder resolves them via fuzzy keyword matching
 * against the catalog (handles "المنجروف" → "المانجروف", etc.).
 */
function parseTourModifications(lastUserMsg: string): TourModification[] {
  // Collapse repeated alifs ("االحر" → "الحر") and trim — handles common
  // Saudi-dialect typos where a letter gets duplicated.
  const text = lastUserMsg.replace(/ا{2,}/g, "ا").trim();
  if (!text) return [];

  // Verbs that can introduce a swap or a free-day replacement
  const SWAP_VERB = "(?:بد[ّ]?ل[يىه]?|غي[ّ]?ر[يى]?|اغير|استبدل|حول|change|swap|replace)";
  // Verbs that introduce a pure removal (free day, no replacement)
  const REMOVE_VERB = "(?:احذف|شيل|ألغ[يى]?|الغ[يى]?|[أا]زل|remove|delete|cancel)";
  // The X/Y separator between "جولة X" and the replacement.
  // Includes Saudi-dialect variants like "الي" / "إلي" (yaa without dots).
  const TO_PREP = "(?:ب[ـ]?|ل[ـ]?|إلى|الى|إلي|الي|مع)";
  // Free-day target phrases (Y side of a swap-with-free-day)
  const FREE_DAY = "(?:يوم\\s*حر|يوم\\s*راح[ةه]|يوم\\s*استرخاء|بدون\\s*جول[ةه]|فاضي)";

  // (1) Swap to free day: "غير جولة X بيوم حر"
  const freeDaySwapRe = new RegExp(
    `${SWAP_VERB}\\s+(?:ال)?جول[ةه]\\s+(.+?)\\s+${TO_PREP}\\s*${FREE_DAY}`,
    "iu",
  );
  const fdSwap = text.match(freeDaySwapRe);
  if (fdSwap) return [{ kind: "remove", name: fdSwap[1].trim() }];

  // (1b) Free day → tour: "غير يوم الحر في X الي جولة Y" / "اضف جولة Y في X"
  // Anchors on "يوم حر" so it can't collide with tour-swap (which anchors
  // on "جولة X"). cityHint is the segment after "في" if present.
  const freeDayToTourRe = new RegExp(
    `${SWAP_VERB}\\s+(?:ال)?يوم\\s*(?:ال)?حر(?:\\s+في\\s+(.+?))?\\s+${TO_PREP}\\s*(?:ال)?جول[ةه]\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const fdToTour = text.match(freeDayToTourRe);
  if (fdToTour) {
    return [{ kind: "add", name: fdToTour[2].trim(), cityHint: fdToTour[1]?.trim() || null }];
  }
  // (1c) Bare add: "اضف/ضيف جولة Y في X"
  const ADD_VERB = "(?:اضف|أضف|ضيف|زود|add)";
  const addRe = new RegExp(
    `${ADD_VERB}\\s+(?:ال)?جول[ةه]\\s+(.+?)(?:\\s+في\\s+(.+?))?(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const add = text.match(addRe);
  if (add) {
    return [{ kind: "add", name: add[1].trim(), cityHint: add[2]?.trim() || null }];
  }

  // (2) Swap to another tour: "غير جولة X بجولة Y"
  // Second "جولة" is required to anchor where Y begins — otherwise we'd
  // accidentally swallow "ب" + city/word into the Y fragment.
  const tourSwapRe = new RegExp(
    `${SWAP_VERB}\\s+(?:ال)?جول[ةه]\\s+(.+?)\\s+${TO_PREP}\\s*(?:ال)?جول[ةه]\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const sw = text.match(tourSwapRe);
  if (sw) return [{ kind: "swap", from: sw[1].trim(), to: sw[2].trim() }];

  // (3) Pure removal: "احذف جولة X"
  const removeRe = new RegExp(
    `${REMOVE_VERB}\\s+(?:ال)?جول[ةه]\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const rm = text.match(removeRe);
  if (rm) return [{ kind: "remove", name: rm[1].trim() }];

  return [];
}

/**
 * Parse hotel-modification follow-ups from the LATEST user message.
 *
 * Recognized intents:
 *   - "غير فندق سابا"               → nextCheaper, cityHint="سابا"
 *   - "غير لي فندق في سابا"         → same
 *   - "بدّل الفندق في سابا"         → same
 *   - "اعطني فندق ثاني في سابا"     → same
 *
 * cityHint is a raw fragment — the builder resolves it against cityDefs.
 * If the user omits the city ("غير الفندق"), no modification is returned
 * (ambiguous) and the rebuild proceeds normally.
 */
function parseHotelModifications(lastUserMsg: string): HotelModification[] {
  const text = lastUserMsg.replace(/ا{2,}/g, "ا").trim();
  if (!text) return [];

  const VERBS = "(?:بد[ّ]?ل[يىه]?|غي[ّ]?ر[يى]?|اغير|استبدل|change|swap|اعطن[يى]?|أعطن[يى]?)";

  // Match the verb + "فندق" + free-form remainder (city + optional ordinal).
  // Note: we do NOT inline an "alternative" keyword like ثاني/اخر here,
  // since "ثاني" can ALSO be the stay-ordinal ("هانوي الثاني") — letting
  // it through this regex caused the city capture to drop it. We extract
  // the stay-ordinal in a second pass below.
  const re = new RegExp(
    `${VERBS}\\s+(?:لي\\s+)?(?:ال)?فندق\\s+(?:في\\s+)?(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const m = text.match(re);
  if (!m) return [];
  let remainder = (m[1] || "").trim();
  if (!remainder) return [];

  // Pull out an explicit occupancy override ("لـ 4 أشخاص" / "يتسع 4 افراد").
  // Strip it from the remainder so the ordinal scan + city resolution don't
  // see digits left over from the occupancy hint.
  let targetOccupancy: number | null = null;
  const occMatch = remainder.match(
    /(?:\s+(?:ب\s*)?(?:ال)?فندق)?\s*(?:يتسع\s+)?(?:ل[ـ]?|لـ)\s*(\d{1,2})\s+(?:شخص|أشخاص|اشخاص|بالغ|بالغين|[أا]فراد|كبار|انفس|اشخاص)/iu,
  );
  if (occMatch && occMatch.index !== undefined) {
    const n = parseInt(occMatch[1], 10);
    if (n >= 1 && n <= 10) {
      targetOccupancy = n;
      remainder = remainder.slice(0, occMatch.index).trim();
    }
  }
  if (!remainder) return [];

  // Pull out a stay-ordinal qualifier from the remainder using a token scan
  // (Arabic doesn't play nice with \b — letters are non-word in JS regex).
  // Normalizes hamza/ya/ta-marbuta first so "الأول"/"الاولى" all match.
  const stripPrefix = (t: string) => t.replace(/^ال/, "");
  const norm = (t: string) => t
    .replace(/[إأآ]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/[يى]/g, "ي")
    .trim();
  let stayHint: HotelStayHint = "all";
  const tokens = remainder.split(/\s+/);
  // Scan right-to-left so "هانوي الاول" picks up "الاول" before "هانوي".
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = norm(stripPrefix(norm(tokens[i])));
    if (!t) continue;
    if (/^(اول|اولي|اوله)$/u.test(t)) { stayHint = "first"; tokens.splice(i, 1); break; }
    if (/^(اخير|اخيره|اخر|اخره)$/u.test(t)) { stayHint = "last"; tokens.splice(i, 1); break; }
    if (/^ثاني[ه]?$/u.test(t))   { stayHint = 2; tokens.splice(i, 1); break; }
    if (/^ثالث[ه]?$/u.test(t))   { stayHint = 3; tokens.splice(i, 1); break; }
    if (/^رابع[ه]?$/u.test(t))   { stayHint = 4; tokens.splice(i, 1); break; }
    // Multi-word: "...اول الجدول" / "...اول الرحلة" — peek backward
    if (i > 0 && /^(الجدول|الرحله|البدايه)$/u.test(t)) {
      const prev = norm(stripPrefix(norm(tokens[i - 1])));
      if (/^(اول|في|البدايه)$/u.test(prev)) {
        stayHint = "first"; tokens.splice(i - 1, 2); break;
      }
    }
    if (i > 0 && /^(الجدول|الرحله|النهايه)$/u.test(t)) {
      const prev = norm(stripPrefix(norm(tokens[i - 1])));
      if (/^(اخر|اخير|في|النهايه)$/u.test(prev)) {
        stayHint = "last"; tokens.splice(i - 1, 2); break;
      }
    }
  }
  const cityHint = tokens.join(" ").trim();
  if (!cityHint) return [];
  return [{ kind: "nextCheaper", cityHint, stayHint, targetOccupancy }];
}

/** Latest user message in the conversation, or "" if none. */
function getLastUserMessage(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    }
  }
  return "";
}

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

  // When the employee gives a per-city distribution but never says "N يوم"
  // or a date range, infer the total from the night sum (days = nights + 1).
  // Without this, canBuildLocally rejects perfectly-valid requests like
  // "تاريخ 5 مايو، 1 ليله هانوي + 3 سابا + 2 هانوي" with the lite question.
  const sumNights = Object.values(nightsByCity).reduce((s, n) => s + n, 0);
  const explicitDays = parseDays(text);
  const daysTotal = explicitDays ?? (sumNights > 0 ? sumNights + 1 : null);

  return {
    destination: dest,
    cities,
    cityStaysOrdered: stays,
    daysTotal,
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
    tourModifications: parseTourModifications(getLastUserMessage(messages)),
    hotelModifications: parseHotelModifications(getLastUserMessage(messages)),
  };
}
