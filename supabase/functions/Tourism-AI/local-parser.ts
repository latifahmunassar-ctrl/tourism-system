// ─────────────────────────────────────────────────────────────────────────
// Local Parser — extracts a structured trip request from the chat history.
// No AI involved. Single source of truth for what the employee actually
// asked for. Used by the deterministic program builder + validators.
// ─────────────────────────────────────────────────────────────────────────

export type CityStay = {
  city: string;
  nights: number;
  /** Sub-area within the city (e.g. Bali → "Kuta"/"Seminyak"/"Ubud"/...). */
  area?: string;
};

/**
 * A follow-up modification to a built program's tour list.
 *   - `remove`: drop the matching tour, leave a free day
 *   - `swap`:   replace `from` with `to` (both resolved against the catalog)
 *   - `add`:    pin a specific tour for a city (for "free day → tour" requests)
 * Multiple modifications in one message are NOT supported in v1 — only the
 * latest/most-specific match wins.
 */
export type TourModification =
  | { kind: "remove"; name: string; dayNumber?: number | null }
  | { kind: "swap"; from: string; to: string; dayNumber?: number | null }
  | { kind: "add"; name: string; cityHint: string | null; dayNumber?: number | null };

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
  | { kind: "nextCheaper"; cityHint: string; stayHint: HotelStayHint; targetOccupancy: number | null; targetStars: number | null; fullText: string };

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
  /**
   * Extra flight/train tickets to bill on top of the trip's adult count.
   * Used for "أضف تذكرة طيران شخص إضافي" — accommodation/tours/transfers
   * stay sized for `adults`, but FLIGHTS lines (planes AND trains) are
   * billed at `adults + extraTickets`. Default 0.
   */
  extraTickets: number;
  /** Extra-bed scope. "none" = not requested. "all" = every hotel. [city] = specific cities */
  extraBed: { scope: "none" | "all" | string[] };
  /** Inter-city transport preference */
  transport: "private" | "shared" | null;
  /**
   * "transport-only" mode: when the employee asks for a program with only
   * transfers + tours (no hotels, no flights). Set when the request contains
   * "برنامج مواصلات" / "مواصلات فقط" / "بدون فنادق" etc. Builder skips the
   * HOTELS and FLIGHTS blocks and prices nothing for accommodation.
   */
  transportOnly: boolean;
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
    [/فيتنام|ڤيتنام|فيتنامي|vietnam|hanoi|هانوي|halong|هالونج|danang|دانانج|sapa|سابا|phu\s*quoc|فوكوك|nha\s*trang|نها\s*تران|dalat|da\s*lat|دالا[تط]/i, "vietnam"],
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

// Shared verb list for hotel modifications. Used by parseAdults/parseStars to
// scrub per-hotel override fragments before they pollute trip-level counts,
// AND by parseHotelModifications to detect the request itself. Keep the three
// uses in sync — adding a verb here automatically extends all three.
const HOTEL_MOD_VERBS =
  "(?:بد[ّ]?ل[يىه]?|غي[ّ]?ر[يى]?|اغير|استبدل|change|swap|اعطن[يى]?|أعطن[يى]?|خل[يى]|اجعل[يى]?|[أا]جعل[يى]?|حو[ّ]?ل[يى]?|ا[بپ]غ[يى]|[أا]ب[يى]|[أا]ريد|اريد|need|want|make)";

function parseAdults(text: string): number | null {
  // Strip per-hotel occupancy overrides ("غير فندق هانوي لـ 4 أشخاص") AND
  // extra-ticket fragments ("أضف تذكرة لشخصين") before scanning — otherwise
  // their numeric pax mentions leak into the trip's adult counter.
  const cleaned = text
    .replace(
      new RegExp(`${HOTEL_MOD_VERBS}\\s+(?:لي\\s+)?(?:ال)?فندق[^\\n]*?(?:ل[ـ]?|لـ)\\s*\\d{1,2}\\s*(?:شخص|أشخاص|اشخاص|بالغ|بالغين|[أا]فراد|كبار)`, "giu"),
      " ",
    )
    .replace(
      /(?:اضف|أضف|ضيف|زود|أضيف|اضيف|احتاج|أحتاج|اريد|أريد)\s+(?:عدد\s+)?(?:\d+\s*)?(?:تذكر[ةه]|تذاكر|تذكرت[يا]ن|طيران|قطار)[^\n،.]*/giu,
      " ",
    );
  const t = arabicDigitsToLatin(cleaned);
  // Digit-prefixed counts FIRST — "3 بالغين"/"5 أشخاص" must parse as 3/5,
  // not as the dual form "2". Otherwise the dual-form check below catches
  // "بالغين" inside "3 بالغين" and short-circuits to 2.
  // "6 أشخاص" / "2 شخص" / "3 كبار" / "ل شخصين" / "4 افراد" / "4 أفراد"
  const personNoun = "(?:شخص|أشخاص|اشخاص|كبار|بالغ(?:ين|ان|ون)?|[أا]فراد|[أا]فرد|adults?|persons?|pax)";
  const m = t.match(new RegExp(`(\\d{1,2})\\s*${personNoun}`, "i"));
  if (m) return parseInt(m[1], 10);
  // Dual forms (no number)
  if (/زوجين|زوجان|couple/i.test(t)) return 2;
  if (/شخصين|شخصان|شخصاً|شخصا|بالغين|بالغان|فردين|فردان|شخصاين/.test(t)) return 2;
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
  // "3 أطفال" / "2 طفل" / "1 child" / "kids 4"
  const childNoun = "(?:طفل[ةه]?|أطفال|اطفال|child(?:ren)?|kids?)";
  const m = t.match(new RegExp(`(\\d{1,2})\\s*${childNoun}`, "iu"));
  if (m) return parseInt(m[1], 10);
  // Dual form: "طفلين" / "طفلان" → 2
  if (/طفل[يا]ن/.test(t)) return 2;
  // Bare "وطفل" / "+ طفل" / "ل طفل" / "و طفلة" — implicit 1
  if (/(?:^|\s|و|\+|،|,|ل)\s*طفل[ةه]?(?:\s|$|،|,|\.|!)/u.test(t)) return 1;
  return null;
}

function parseStars(text: string): number[] | null {
  // Strip per-hotel star-rating overrides before scanning — the override is
  // for ONE hotel, not the trip. Two forms covered:
  //   1. "غير فندق هانوي الى 5 نجوم" — verb + فندق + city + stars
  //   2. "غير Bayview Hotel Langkawi الى فندق 5 نجوم" — verb + hotel-name +
  //      الى + فندق + stars
  // Both must be scrubbed; otherwise the "5 نجوم" leaks into trip-level
  // parseStars and every hotel gets upgraded. Convert Arabic-Indic digits
  // FIRST so the scrubbers' `\d` actually matches "٥" / "5" alike.
  const normalized = arabicDigitsToLatin(text);
  const cleaned = normalized
    .replace(
      new RegExp(`${HOTEL_MOD_VERBS}\\s+(?:لي\\s+)?(?:ال)?فندق[^\\n]*?\\d\\s*(?:نجوم|نجمة|stars?)`, "giu"),
      " ",
    )
    .replace(
      new RegExp(`${HOTEL_MOD_VERBS}\\s+(?:لي\\s+)?[^\\n]*?(?:الى|إلى|الي|ل[ـ]?|لـ)\\s+(?:ال)?فندق[^\\n]*?\\d\\s*(?:نجوم|نجمة|stars?)`, "giu"),
      " ",
    );
  // Convert Arabic word cardinals (واحد..خمس) to digits so phrases like
  // "اربع نجوم" / "خمس نجوم" match the digit-based patterns below. Without
  // this, parseStars returns null and the trip falls back to ANY stars,
  // which usually surfaces the cheapest available rating (often 5★) — the
  // opposite of what the employee asked for when they wrote "اربع نجوم".
  const WORD_TO_DIGIT: Array<[RegExp, string]> = [
    [/خمس(?:[ةه])?(?=\s+نجوم|\s+نجمة)/giu, "5"],
    [/[أا]ربع(?:[ةه])?(?=\s+نجوم|\s+نجمة)/giu, "4"],
    [/ثلاث(?:[ةه])?(?=\s+نجوم|\s+نجمة)/giu, "3"],
    [/(?:اثن(?:ان|ين)|نجمتين)(?=\s+نجوم|\s+نجمة|$)/giu, "2"],
    [/واحد(?:[ةه])?(?=\s+نجوم|\s+نجمة)/giu, "1"],
  ];
  let t = arabicDigitsToLatin(cleaned);
  for (const [pat, digit] of WORD_TO_DIGIT) t = t.replace(pat, digit);
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

/**
 * Parse extra-ticket count for flights/trains. Accommodation, tours, and
 * transfers stay sized for the trip's adults; only the FLIGHTS section is
 * billed at adults + extraTickets. Recognized phrasings:
 *   - "أضف تذكرة شخص إضافي" / "ضيف تذكرة طيران" / "زود تذكرة قطار"  → 1
 *   - "أضف تذكرتين" / "ضيف تذكرتين قطار"                             → 2
 *   - "أضف ٣ تذاكر" / "زود 4 تذاكر طيران"                            → N
 *   - "تذكرة طيران/قطار لشخص اضافي"                                  → 1
 */
function parseExtraTickets(text: string): number {
  const t = arabicDigitsToLatin(text);
  const ADD = "(?:اضف|أضف|ضيف|زود|أضيف|اضيف|احتاج|أحتاج|بدي|ابغى|أبغى|اريد|أريد|اضافه|إضافة)";
  const SUBJECT = "(?:تذكر[ةه]|تذاكر|تذكرت[يا]ن|طيران|قطار|tickets?)";
  // Pattern A: "VERB <subject> [filler-word]? ل[ـ]? N شخص/أشخاص/افراد"
  //   Catches "اضف طيران ل 2 شخص", "اريد طيران اضافي ل 3 اشخاص" (filler
  //   "اضافي" between subject and "ل"), "ضيف تذكرة لشخصين" (dual via word).
  const dualWord = /(?:شخصين|شخصان|فردين|فردان|اثنين)/iu;
  if (new RegExp(`${ADD}\\s+(?:عدد\\s+)?${SUBJECT}\\s+(?:\\S+\\s+)?ل[ـ]?\\s*${dualWord.source}`, "iu").test(t)) return 2;
  const mNa = t.match(new RegExp(`${ADD}\\s+(?:عدد\\s+)?${SUBJECT}\\s+(?:\\S+\\s+)?ل[ـ]?\\s*(\\d+)\\s*(?:شخص|أشخاص|اشخاص|بالغ|[أا]فراد|كبار)?`, "iu"));
  if (mNa) {
    const n = parseInt(mNa[1], 10);
    if (n >= 1 && n <= 20) return n;
  }
  // Pattern B (dual ticket noun): "ضيف تذكرتين"
  if (new RegExp(`${ADD}\\s+(?:عدد\\s+)?تذكرت[يا]ن`, "iu").test(t)) return 2;
  // Pattern C: "أضف (عدد)? N <subject>" — number BEFORE the subject
  //   ("اضف 3 تذاكر", "اضف عدد 2 طيران").
  const m = t.match(new RegExp(`${ADD}\\s+(?:عدد\\s+)?(\\d+)\\s*${SUBJECT}`, "iu"));
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 20) return n;
  }
  // Pattern C2: "VERB <subject> [filler]* عدد N" — number AFTER the subject
  //   ("ضيف طيران داخلي اضافي عدد 2"). The fillers between subject and "عدد"
  //   are accepted up to a few tokens. Stops at digit/punct so we don't
  //   accidentally swallow another sentence.
  const mC2 = t.match(new RegExp(`${ADD}\\s+${SUBJECT}\\s+(?:[^\\d،.\\n]+\\s+)?عدد\\s+(\\d+)`, "iu"));
  if (mC2) {
    const n = parseInt(mC2[1], 10);
    if (n >= 1 && n <= 20) return n;
  }
  // Pattern D: bare "أضف تذكرة/طيران/قطار" — treat as 1 (single extra)
  if (new RegExp(`${ADD}\\s+(?:عدد\\s+)?(?:تذكر[ةه]|طيران|قطار)`, "iu").test(t)) return 1;
  // Pattern E: no verb — "تذكرة طيران اضافية" / "طيران لشخص اضافي"
  if (/تذكر[ةه]\s+(?:طيران|قطار|للشخص|لشخص|اضافي|إضافي|اضافيه|إضافية)/iu.test(t)) return 1;
  return 0;
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
    // Restrict city detection to the LINE(S) that mention the bed keyword —
    // otherwise the joined-history text drags in trip-wide cities (Selangor,
    // Langkawi) when the user only requested a bed in KL, and a later
    // unrelated mod (e.g. adding a flight) silently expands the scope.
    const bedLines = t
      .split(/\n+/)
      .filter(line => isBedKeyword.test(line));
    const bedText = bedLines.length > 0 ? bedLines.join("\n") : t;
    const cities: string[] = [];
    for (const { canonical, pattern } of cityDefs) {
      if (pattern.test(bedText)) cities.push(canonical);
    }
    // If "كل / جميع / للكل / كافة" → ALL
    if (/كل\s*الفنادق|جميع\s*الفنادق|للكل|كافة\s*الفنادق|all\s*hotels|in\s*all/i.test(bedText) || cities.length === 0) {
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
  const m = t.match(/(?:السفر|سفر|ابدأ|ابدا|من|تاريخ|date)\s*(?:يوم\s*)?(\d{1,2})[\s/-]*(?:شهر\s*)?([^\s/\-،,]+)?\s*(\d{4})?/i);
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
// Bali sub-areas: hotels in DB are tagged by location like "Bali-Kuta",
// "Bali-Seminyak", etc. When the employee mentions an area (with or without
// "بالي"), we attach it to that specific stay so the builder can filter by
// area within the city.
const BALI_AREAS: Array<{ pat: RegExp; name: string }> = [
  { pat: /كوتا|kuta/iu, name: "Kuta" },
  { pat: /سيمنياك|سمينياك|seminyak/iu, name: "Seminyak" },
  { pat: /[أا]وبود|ubud/iu, name: "Ubud" },
  { pat: /جيمبران|جيمباران|jimbaran/iu, name: "Jimbaran" },
  { pat: /نوسا\s*دوا|nusa\s*dua/iu, name: "Nusa Dua" },
];

function parseCityStaysOrdered(text: string, cityDefs: CityDef[]): CityStay[] {
  const t = normalizeNightWords(arabicDigitsToLatin(text));
  // Build a single combined regex matching either "N city" or "city N",
  // capturing the city name + number. Use named-group alternation by
  // running per-city regex and merging results sorted by position.
  type Hit = { city: string; nights: number; pos: number; area?: string };
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

  // Attach Bali sub-area hints to nearby Bali stays. We collect all area
  // mentions in the text, then for each Bali hit pick the closest UNUSED
  // area mention within a small window (so the employee writing "4 بالي
  // كوتا + 2 سيمنياك" gets two Bali stays tagged "Kuta" and "Seminyak"
  // in that order).
  const baliHits = hits.filter(h => h.city === "Bali");
  if (baliHits.length > 0) {
    const areaMentions: Array<{ name: string; pos: number; used: boolean }> = [];
    for (const area of BALI_AREAS) {
      const re = new RegExp(area.pat.source, "giu");
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) !== null) {
        areaMentions.push({ name: area.name, pos: m.index, used: false });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    // Sort by position and greedily match each Bali hit to its nearest
    // unused area mention within 40 chars (covers "4 ليالي بالي كوتا").
    areaMentions.sort((a, b) => a.pos - b.pos);
    for (const baliHit of baliHits) {
      let best: { idx: number; dist: number } | null = null;
      for (let i = 0; i < areaMentions.length; i++) {
        if (areaMentions[i].used) continue;
        const dist = Math.abs(areaMentions[i].pos - baliHit.pos);
        if (dist > 40) continue;
        if (best === null || dist < best.dist) best = { idx: i, dist };
      }
      if (best !== null) {
        baliHit.area = areaMentions[best.idx].name;
        areaMentions[best.idx].used = true;
      }
    }
  }

  return hits.map(h => h.area
    ? { city: h.city, nights: h.nights, area: h.area }
    : { city: h.city, nights: h.nights });
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
  // Also fold Arabic-Indic digits so "اليوم ٤" matches "اليوم 4" below.
  const text = lastUserMsg
    .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/ا{2,}/g, "ا")
    .trim();
  if (!text) return [];

  // Pull a "في اليوم N" / "باليوم N" / "اليوم N" marker out of the message so
  // it doesn't bleed into the source/target name fragments. The day number
  // travels with the mod and lets the builder pin the swap to a specific
  // day even when the source-tour name is ambiguous (or just "يوم حر" which
  // appears multiple times in the same city). Accepts both Latin/Arabic
  // digits AND Arabic word ordinals ("الثامن", "السادس عشر").
  const ORD_WORDS: Array<[RegExp, number]> = [
    [/[أا]ول[ىيه]?/u, 1], [/ثاني[هة]?/u, 2], [/ثالث[هة]?/u, 3],
    [/رابع[هة]?/u, 4], [/خامس[هة]?/u, 5], [/سادس[هة]?/u, 6],
    [/سابع[هة]?/u, 7], [/ثامن[هة]?/u, 8], [/تاسع[هة]?/u, 9],
    [/عاشر[هة]?/u, 10], [/حادي\s*عشر/u, 11], [/ثاني\s*عشر/u, 12],
    [/ثالث\s*عشر/u, 13], [/رابع\s*عشر/u, 14],
  ];
  let dayNumber: number | null = null;
  let textNoDay = text;
  // Try digit form first ("اليوم 8") then word ordinal ("اليوم الثامن").
  const digitMatch = text.match(/(?:في\s+|ب)?(?:ال)?يوم\s*(?:ال)?(?:رقم\s*)?(\d{1,2})\b/iu);
  if (digitMatch && digitMatch.index !== undefined) {
    dayNumber = parseInt(digitMatch[1], 10);
    textNoDay = (text.slice(0, digitMatch.index) + " " + text.slice(digitMatch.index + digitMatch[0].length)).replace(/\s+/g, " ").trim();
  } else {
    for (const [pat, val] of ORD_WORDS) {
      // JS \b doesn't work for Arabic letters, so anchor with a lookahead
      // that requires whitespace / punctuation / end-of-string after the
      // ordinal. Otherwise "ثامن" might absorb the next Arabic word.
      const re = new RegExp(`(?:في\\s+|ب)?(?:ال)?يوم\\s+(?:ال)?(?:${pat.source})(?=\\s|$|،|,|\\.|!|\\?)`, pat.flags);
      const m = text.match(re);
      if (m && m.index !== undefined) {
        dayNumber = val;
        textNoDay = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
        break;
      }
    }
  }
  // After this point the swap/remove/add regexes work on textNoDay so the
  // day-marker doesn't get captured into cityHint or the tour name.
  const baseText = text;
  void baseText;

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
  const fdSwap = textNoDay.match(freeDaySwapRe);
  if (fdSwap) return [{ kind: "remove", name: fdSwap[1].trim(), dayNumber }];

  // (1b) Free day → tour: "غير يوم الحر في X الي جولة Y" / "اضف جولة Y في X"
  // Anchors on "يوم حر" so it can't collide with tour-swap (which anchors
  // on "جولة X"). cityHint is the segment after "في" if present.
  const freeDayToTourRe = new RegExp(
    `${SWAP_VERB}\\s+(?:ال)?يوم\\s*(?:ال)?حر(?:\\s+في\\s+(.+?))?\\s+${TO_PREP}\\s*(?:ال)?جول[ةه]\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const fdToTour = textNoDay.match(freeDayToTourRe);
  if (fdToTour) {
    return [{ kind: "add", name: fdToTour[2].trim(), cityHint: fdToTour[1]?.trim() || null, dayNumber }];
  }
  // (1c) Bare add: "اضف/ضيف جولة Y في X" — supports repetition. If the
  // employee writes the same add twice ("اضف جولة X. اضف جولة X") we emit
  // two add mods so the builder pins the tour twice and fills a deficit
  // day with a duplicate. The numbered-list reply rewriter in index.ts
  // relies on this behavior to honor "نفذ الأولى" / "كرر الجولة الأولى".
  const ADD_VERB = "(?:اضف|أضف|ضيف|زود|add)";
  const addRe = new RegExp(
    `${ADD_VERB}\\s+(?:ال)?جول[ةه]\\s+(.+?)(?:\\s+في\\s+(.+?))?(?=\\s*(?:$|[\\.,،\\n]))`,
    "giu",
  );
  const adds = [...textNoDay.matchAll(addRe)];
  if (adds.length > 0) {
    return adds.map(m => ({ kind: "add" as const, name: m[1].trim(), cityHint: m[2]?.trim() || null, dayNumber }));
  }

  // (2) Swap to another tour: "غير جولة X بجولة Y"
  // Second "جولة" is required to anchor where Y begins — otherwise we'd
  // accidentally swallow "ب" + city/word into the Y fragment.
  const tourSwapRe = new RegExp(
    `${SWAP_VERB}\\s+(?:ال)?جول[ةه]\\s+(.+?)\\s+${TO_PREP}\\s*(?:ال)?جول[ةه]\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const sw = textNoDay.match(tourSwapRe);
  if (sw) return [{ kind: "swap", from: sw[1].trim(), to: sw[2].trim(), dayNumber }];

  // (3) Pure removal: "احذف جولة X"
  const removeRe = new RegExp(
    `${REMOVE_VERB}\\s+(?:ال)?جول[ةه]\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  const rm = textNoDay.match(removeRe);
  if (rm) return [{ kind: "remove", name: rm[1].trim(), dayNumber }];

  // (4) Day-only swap (no "جولة" anchor on the source): when the user names
  // the source by day alone, e.g. "غير اليوم 4 الى جولة معالم هانوي" or
  // "غير اليوم 4 الى يوم حر". Requires we extracted dayNumber up top.
  if (dayNumber !== null) {
    const toTour = textNoDay.match(new RegExp(
      `${SWAP_VERB}\\s*${TO_PREP}?\\s*(?:ال)?جول[ةه]\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`, "iu",
    ));
    if (toTour) return [{ kind: "add", name: toTour[1].trim(), cityHint: null, dayNumber }];
    const toFree = textNoDay.match(new RegExp(
      `${SWAP_VERB}\\s*${TO_PREP}?\\s*${FREE_DAY}`, "iu",
    ));
    if (toFree) return [{ kind: "remove", name: "", dayNumber }];
  }

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
  // Normalize Arabic-Indic digits FIRST so the occupancy regex's `\d{1,2}`
  // can pick up "٤ اشخاص" (saudi-dialect digit form). Also collapse repeated
  // alifs like everywhere else in the parser.
  const text = lastUserMsg
    .replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/ا{2,}/g, "ا")
    .trim();
  if (!text) return [];

  const VERBS = HOTEL_MOD_VERBS;

  // Match the verb + "فندق" + free-form remainder (city + optional ordinal).
  // Note: we do NOT inline an "alternative" keyword like ثاني/اخر here,
  // since "ثاني" can ALSO be the stay-ordinal ("هانوي الثاني") — letting
  // it through this regex caused the city capture to drop it. We extract
  // the stay-ordinal in a second pass below.
  const re = new RegExp(
    `${VERBS}\\s+(?:لي\\s+)?(?:ال)?فندق\\s+(?:في\\s+)?(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
    "iu",
  );
  let m = text.match(re);
  // Fallback: "غير <hotel name> الى فندق N نجوم" — verb + free-form hotel
  // name + connector + فندق + remainder. Without this, an explicit name
  // swap like "غير Bayview Hotel Langkawi الى فندق 5 نجوم" falls through
  // and parseStars sees the "5 نجوم" un-scrubbed → upgrades the whole trip.
  if (!m) {
    const altRe = new RegExp(
      `${VERBS}\\s+(?:لي\\s+)?(.+?)\\s+(?:الى|إلى|الي|ل[ـ]?|لـ)\\s+(?:ال)?فندق\\s+(.+?)(?=\\s*(?:$|[\\.,،\\n]))`,
      "iu",
    );
    const altM = text.match(altRe);
    if (altM) {
      // Synthesize an `m` whose remainder is "<hotel name> + target hints",
      // so the existing occupancy/stars/area extractors all keep working.
      m = [altM[0], `${altM[1]} ${altM[2]}`] as RegExpMatchArray;
    }
  }
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
  // Pull out an explicit star-rating override ("الى 5 نجوم" / "ل ٤ نجوم" /
  // "بفندق 5 نجوم"). Strip from remainder so trip-level parseStars doesn't
  // pick up the digit and apply it to every hotel.
  let targetStars: number | null = null;
  const arDigits = remainder.replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
  const starsMatch = arDigits.match(
    /(?:\s+(?:ب\s*)?(?:ال)?فندق)?\s*(?:الى|إلى|ل[ـ]?|لـ|ب)?\s*(\d)\s+(?:نجوم|نجمة|stars?)/iu,
  );
  if (starsMatch && starsMatch.index !== undefined) {
    const n = parseInt(starsMatch[1], 10);
    if (n >= 1 && n <= 5) {
      targetStars = n;
      remainder = remainder.slice(0, starsMatch.index).trim();
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
  // Carry the full normalized message too — the builder uses it for hotel-name
  // fallback when the employee wrote "<hotel name> غير الفندق هذا ...", which
  // leaves the actual name OUTSIDE the verb-anchored capture group.
  return [{ kind: "nextCheaper", cityHint, stayHint, targetOccupancy, targetStars, fullText: text }];
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

/**
 * Walk every user turn from oldest to newest and collect ALL tour
 * modifications. The builder applies them in order, so an "اضف جولة X في
 * اليوم 3" from turn 2 and "اضف جولة Y في اليوم 5" from turn 4 both end up
 * on the final program — without this, only the latest turn's mods would
 * apply and earlier edits would be lost on every rebuild.
 *
 * The initial-build message (the one that describes the trip distribution)
 * normally produces no tour mods because it lacks the swap/add/remove
 * verbs, so it contributes nothing here.
 */
function collectTourModifications(messages: Array<{ role: string; content: unknown }>): TourModification[] {
  const all: TourModification[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const mods = parseTourModifications(text);
    if (mods.length > 0) all.push(...mods);
  }
  return all;
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
    extraTickets: parseExtraTickets(text),
    extraBed: parseExtraBed(text, cityDefs),
    transport: parseTransport(text),
    transportOnly: /برنامج\s*مواصلات|مواصلات\s*فقط|نقل\s*وجولات\s*فقط|بدون\s*فنادق|بدون\s*طيران|بدون\s*فندق|نقل\s*فقط|فقط\s*مواصلات|فقط\s*نقل/iu.test(text),
    month: monthInfo.month,
    year: monthInfo.year,
    startDate: parseStartDate(text),
    // Accumulate tour modifications from EVERY user turn — not just the
    // latest — so multi-step edits stack. When the employee changes a day
    // in Penang and then a day in KL, the KL turn needs to remember the
    // Penang change or the builder rebuilds from scratch and drops it.
    tourModifications: collectTourModifications(messages),
    hotelModifications: parseHotelModifications(getLastUserMessage(messages)),
  };
}
