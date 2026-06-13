// ─────────────────────────────────────────────────────────────────────────
// Local Builder — selects hotels/tours/flights/transfers from Postgres,
// arranges the day-by-day plan, and formats the final program text.
// Replaces Claude for standard build requests.
// ─────────────────────────────────────────────────────────────────────────

import type { CityDef, TourModification, TripRequest } from "./local-parser.ts";

type Sb = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => any;
      ilike: (col: string, val: string) => any;
      order: (col: string, opts?: { ascending?: boolean }) => any;
      limit: (n: number) => any;
    };
  };
};

export type HotelRow = {
  id?: number;
  name: string;
  location: string;       // "City - destination"
  stars: number;
  room_type: string;
  price_per_night: number;
  currency: string;
  occupancy: string;
  meals?: string;
  includes_breakfast?: boolean;
  date_from?: string;     // ISO or "1/6/2026"
  date_to?: string;
};

export type TourRow = {
  id?: number;
  name: string;
  type: string;            // destination
  city?: string;           // canonical city from sheet section header ("" if unknown)
  price: number;
  currency: string;
  variants?: Array<{ label: string; price: number; currency?: string }>;
};

export type FlightRow = {
  id?: number;
  from_city: string;
  to_city: string;
  price_per_pax: number;
  currency: string;
  destination: string;
};

// Trains share the same shape as flights — city pair + per-pax price.
// Picked before flights for the same transit when both exist (e.g. Moscow ↔
// St Petersburg by Sapsan), since trains are cheaper and more convenient
// for short city-to-city routes within Russia / Europe.
export type TrainRow = FlightRow;

// ─────────────────────────────────────────────────────────────────────────
// SELECTORS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extract adults_count from "4 adults `+ 2 child" / "2 adults" / "4adults".
 * Returns 0 if can't parse. Used to match against requested adults.
 */
function extractAdultsCount(occupancy: string): number {
  const m = String(occupancy || "").match(/(\d+)\s*adult/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Extract child_count from occupancy strings like "4 adults + 2 child" /
 * "2 adults + 2 child (Less then 5 years)". Returns 0 when the string has
 * no child slot — meaning the room is not flagged as kid-accommodating.
 */
function extractChildrenCount(occupancy: string): number {
  const m = String(occupancy || "").match(/(\d+)\s*child/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Check if hotel's date range covers the requested travel date.
 * Travel date is a YYYY-MM-DD string. Hotel dates can be "1/6/2026" or
 * "01-06-2026" or ISO. Permissive parsing.
 */
function hotelCoversDate(hotel: HotelRow, travelDateISO: string | null): boolean {
  if (!travelDateISO) return true; // no travel date → don't filter
  const travel = parseAnyDate(travelDateISO);
  if (!travel) return true;
  const from = hotel.date_from ? parseAnyDate(hotel.date_from) : null;
  const to = hotel.date_to ? parseAnyDate(hotel.date_to) : null;
  if (from && travel < from) return false;
  if (to && travel > to) return false;
  return true;
}

function parseAnyDate(s: string): Date | null {
  if (!s) return null;
  // ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  // DD/MM/YYYY or D/M/YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  // MM/DD/YYYY (US, fallback)
  return null;
}

function cityFromLocation(location: string): string {
  return String(location || "").split(" - ")[0]?.trim() || "";
}

function destFromLocation(location: string): string {
  return String(location || "").split(" - ").pop()?.trim() || "";
}

/**
 * Match hotel city against a canonical city name. Hotels in the sheet have
 * messy city values like "Phu Quoc Island,ỉ", "ha.noi", "Cameron.Highland".
 * The match logic:
 *   1) normalize both: lowercase, strip diacritics, collapse separators.
 *   2) compare word sets — every word in the target canonical name must
 *      appear in the hotel's city (after normalization). Catches
 *      "Phu Quoc Island" → "Phu Quoc" ✓ but rejects "Halong" → "Ha Noi" ✗.
 */
function hotelCityMatches(hotelLocation: string, canonicalCity: string, cityPattern?: RegExp): boolean {
  const hotelCityRaw = cityFromLocation(hotelLocation);

  // Path 1: regex match — when caller passes the cityDefs pattern, use it.
  // This is the most reliable because the same regex already accepts all
  // dialectal spellings the parser knows (Saint/St Petersburg, Halong/Ha Long,
  // كوالامبور/كوالا لمبور, etc.).
  if (cityPattern) {
    if (cityPattern.test(hotelCityRaw)) return true;
  }

  // Path 2: normalize-and-compare fallback for callers without cityDefs.
  const norm = (s: string) => s
    .toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[\.\-_,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Common English abbreviations that bypass word-set matching otherwise.
  // E.g. canonical "St Petersburg" vs hotel "Saint Petersburg".
  const expandAbbrevs = (s: string) => s
    .replace(/\bsaint\b/g, "st")
    .replace(/\bst\.?/g, "st");
  const hotelCity = expandAbbrevs(norm(hotelCityRaw));
  const target = expandAbbrevs(norm(canonicalCity));
  if (!hotelCity || !target) return false;
  if (hotelCity === target) return true;
  if (hotelCity.replace(/\s+/g, "") === target.replace(/\s+/g, "")) return true;
  // Word-set match: all canonical words appear in hotel city
  // (handles "Phu Quoc Island" matches "Phu Quoc")
  const targetWords = target.split(/\s+/).filter(Boolean);
  if (targetWords.length === 0) return false;
  return targetWords.every(w => hotelCity.includes(w));
}

/**
 * Pick the cheapest hotel matching ALL of:
 *   - city (strict canonical match against location prefix)
 *   - exact adults_count = request.adults (if specified)
 *   - stars in request.stars (if specified)
 *   - travel date inside hotel's date range (if specified)
 *
 * On tie (same price), pick alphabetically first.
 * Returns the chosen HotelRow or null if nothing matches.
 */
/**
 * Extract the Bali sub-area from a hotel location, e.g.
 * "Bali-Jimbaran - indonesia" → "Jimbaran". Returns null for locations that
 * don't follow the "Bali-<area>" shape (other destinations have one area per
 * canonical city, so no sub-area lock is needed).
 */
function extractHotelArea(location: string): string | null {
  const m = String(location || "").match(/bali\s*[-–]\s*(.+?)\s*[-–]\s*[a-z]+\s*$/i);
  return m ? m[1].trim() : null;
}

export function pickCheapestHotel(
  allHotels: HotelRow[],
  city: string,
  request: TripRequest,
  cityPattern?: RegExp,
  options?: { excludeNames?: Set<string>; overrideAdults?: number; areaFilter?: string; overrideStars?: number; feature?: string; lockOccupancyAdults?: number },
): HotelRow | null {
  // overrideAdults is set when the employee explicitly asks for a different
  // occupancy on a single swap ("غير فندق هانوي لـ 4 أشخاص"). In that case
  // we honor it strictly — no upsize fallback — since the choice was deliberate.
  // lockOccupancyAdults is set on a plain hotel swap ("غير فندق هانوي") to KEEP
  // the same room capacity as the hotel being replaced — a swap must never
  // change the occupancy unless the employee asked for it. Also strict (no upsize).
  const adults = options?.overrideAdults ?? options?.lockOccupancyAdults ?? (request.adults || 2);
  const strictOnly = options?.overrideAdults != null || options?.lockOccupancyAdults != null;
  const exclude = options?.excludeNames || new Set<string>();
  const isExcluded = (name: string) => exclude.has((name || "").trim().toLowerCase());
  const dateForCheck = request.startDate
    || (request.year && request.month
        ? `${request.year}-${String(monthNumber(request.month)).padStart(2, "0")}-01`
        : null);
  let activeDate = dateForCheck;   // قد نُلغيه كملاذ أخير لو التاريخ خارج كل المواسم المُسعّرة

  // Build a candidate-filter that's identical except for the occupancy rule —
  // strict on the first pass, "room fits the group" on the fallback. The
  // fallback lets a 3-pax group book a 4-occupancy room when the sheet has
  // no exact-fit 3-occupancy entry (common in Hanoi: only 2/4/6 are listed).
  const effectiveStars = options?.overrideStars
    ? [options.overrideStars]
    : (request.stars || []);
  const baseFilter = (h: HotelRow): boolean => {
    if (!hotelCityMatches(h.location, city, cityPattern)) return false;
    if (isExcluded(h.name)) return false;
    if (effectiveStars.length > 0) {
      if (!effectiveStars.includes(h.stars)) return false;
    }
    if (!hotelCoversDate(h, activeDate)) return false;
    // Sub-area filter: when the employee asked for a specific area within
    // the city ("Bali → Kuta"), require the hotel's location to mention it.
    if (options?.areaFilter) {
      const loc = (h.location || "").toLowerCase();
      if (!loc.includes(options.areaFilter.toLowerCase())) return false;
    }
    // Amenity filter ("بمسبح خاص" / "فيلا"): require the room_type to mention
    // the requested feature. Pool villas/private-pool rooms match "pool".
    if (options?.feature) {
      const rt = (h.room_type || "").toLowerCase();
      if (options.feature === "pool"  && !/pool|مسبح/iu.test(rt)) return false;
      if (options.feature === "villa" && !/villa|فيلا/iu.test(rt)) return false;
      if (options.feature === "suite" && !/suite|سويت|جناح/iu.test(rt)) return false;
    }
    return true;
  };
  // Employee rule: ADULT capacity is the primary constraint, and we ROUND DOWN —
  // pick the room with the exact adult count, else the LARGEST room that does
  // NOT exceed the requested count. So "3 بالغين" with rooms [2,4,6] picks the
  // 2-adult room (الأساس على غرفة أصغر، والموظف يضيف سرير إضافي أو يغيّر الغرفة
  // لاحقاً)، و"5" يختار غرفة 5 إن وُجدت وإلا 4. نقرّب لأعلى فقط كملاذ أخير لو ما
  // فيه ولا غرفة بحجم ≤ العدد (مثلاً طلب 1 والمتاح 2 فقط).
  // Within the chosen adult-tier, when children are requested we PREFER
  // rooms that explicitly mention a child slot (but don't require it —
  // the adult capacity match is the deciding factor).
  const childrenCount = Math.max(0, request.children || 0);
  const findCandidates = (): HotelRow[] => {
    if (strictOnly) {
      return allHotels.filter(h => {
        if (!baseFilter(h)) return false;
        return extractAdultsCount(h.occupancy || "") === adults;
      });
    }
    const adultsByCap = (cap: number) => allHotels.filter(h => {
      if (!baseFilter(h)) return false;
      return extractAdultsCount(h.occupancy || "") === cap;
    });
    const order: number[] = [];
    for (let cap = adults; cap >= 1; cap--) order.push(cap);          // العدد ثم لأسفل
    for (let cap = adults + 1; cap <= adults + 10; cap++) order.push(cap); // لأعلى كملاذ أخير
    for (const cap of order) {
      const atCap = adultsByCap(cap);
      if (atCap.length === 0) continue;
      if (childrenCount > 0) {
        const kidFriendly = atCap.filter(h =>
          extractChildrenCount(h.occupancy || "") >= childrenCount,
        );
        return kidFriendly.length > 0 ? kidFriendly : atCap;
      }
      return atCap;
    }
    return [];
  };
  let candidates = findCandidates();
  // التاريخ خارج كل المواسم المُسعّرة (مثلاً صلالة سبتمبر-ديسمبر غير مُسعّر) →
  // أعد المحاولة بتجاهل التاريخ (أقرب سعر متاح) بدل إرجاع "لا يوجد فندق".
  if (candidates.length === 0 && dateForCheck) {
    activeDate = null;
    candidates = findCandidates();
  }

  if (candidates.length === 0) return null;

  // Sort: price ASC, then prefer smaller occupancy (closer fit) on the
  // fallback path, then name. On the strict path all candidates share the
  // same occupancy so the second key is a no-op.
  candidates.sort((a, b) => {
    if (a.price_per_night !== b.price_per_night) return a.price_per_night - b.price_per_night;
    const ac_a = extractAdultsCount(a.occupancy || "");
    const ac_b = extractAdultsCount(b.occupancy || "");
    if (ac_a !== ac_b) return ac_a - ac_b;
    return a.name.localeCompare(b.name);
  });
  return candidates[0];
}

const ARABIC_MONTH_TO_NUMBER: Record<string, number> = {
  "يناير": 1, "كانون الثاني": 1, "january": 1, "jan": 1,
  "فبراير": 2, "شباط": 2, "february": 2, "feb": 2,
  "مارس": 3, "آذار": 3, "اذار": 3, "march": 3, "mar": 3,
  "أبريل": 4, "ابريل": 4, "نيسان": 4, "april": 4, "apr": 4,
  "مايو": 5, "أيار": 5, "ايار": 5, "may": 5,
  "يونيو": 6, "حزيران": 6, "june": 6, "jun": 6,
  "يوليو": 7, "تموز": 7, "july": 7, "jul": 7,
  "أغسطس": 8, "اغسطس": 8, "آب": 8, "اب": 8, "august": 8, "aug": 8,
  "سبتمبر": 9, "أيلول": 9, "ايلول": 9, "september": 9, "sep": 9,
  "أكتوبر": 10, "اكتوبر": 10, "تشرين الأول": 10, "october": 10, "oct": 10,
  "نوفمبر": 11, "تشرين الثاني": 11, "november": 11, "nov": 11,
  "ديسمبر": 12, "كانون الأول": 12, "december": 12, "dec": 12,
};

function monthNumber(monthName: string): number {
  return ARABIC_MONTH_TO_NUMBER[monthName.toLowerCase()] || 1;
}

/**
 * Canonical city whose DEST_CITIES pattern matches the tour NAME, or null.
 * The most specific signal (e.g. "جولة معالم ايدر" → Ayder).
 */
function tourNameCity(tour: TourRow, cityDefs: CityDef[]): string | null {
  for (const c of cityDefs) {
    if (c.pattern.test(tour.name)) return c.canonical;
  }
  return null;
}

/**
 * Does `tour` belong to `canonicalCity`? The tour NAME is authoritative; the
 * sheet SECTION tag is consulted only for tours that name no city at all.
 */
function tourBelongsToCity(tour: TourRow, cityDefs: CityDef[], canonicalCity: string): boolean {
  // The tour NAME is authoritative: a tour that names a city ("جولة معالم فوكوك"
  // → Phu Quoc) belongs to THAT city only — never to whatever sheet section it
  // was filed under. Most sheets (Vietnam, …) keep a flat tour list with no
  // per-city sections, so the section tag over-propagates; honouring it for a
  // named tour would drop a Phu Quoc tour onto a Hanoi day.
  const nameCity = tourNameCity(tour, cityDefs);
  if (nameCity) return nameCity === canonicalCity;
  // Nameless tours only (Istanbul day-trips الأميرات / فيالاند / فينيسيا that
  // never name a base city) fall back to the sheet section tag. sync stamps the
  // section onto exactly those nameless rows, so the tag is trustworthy here.
  const sectionCity = tour.city && tour.city.trim() ? tour.city.trim() : null;
  return sectionCity === canonicalCity;
}

/**
 * Recognize transfer / pickup / inter-city movement rows. These are stored
 * in the `tours` table but represent driver movements, not sightseeing
 * activities — they must be excluded from tour-selection AND from the
 * tour-modification fuzzy matcher (otherwise "غير جولة سراييفو" can match
 * "الاستقبال من المطار...سراييفو").
 */
const TRANSFER_PREFIXES = [
  "استقبال", "الاستقبال", "آلاستقبال",
  "توديع", "التوديع",
  "التوجه", "التوجة", "توجه", "توجة", "التوصيل", "توصيل", "توصیل", "يتم توصيل", "يتم توصیل",
  "العوده", "العودة", "العود",
  "الانتقال", "انتقال", "النقل",
  "حضور السائق", "السائق",
  "ذهاب من", "الذهاب من", "للذهاب",
  "انتهاء", "انتهاء جوله", "انتهاء جولة",
  "الخروج", "خروج",
];
function isTransferTour(name: string): boolean {
  // Strip a leading list number ("5. " / "1) " / "٢-") so a transfer row
  // written as "5. التوصيل من فندق ... للمطار" is still recognized as a
  // transfer (and excluded from the sightseeing-tour pool), not a tour.
  // طبّع الألف (آ/أ/إ → ا) قبل المطابقة حتى يُلتقط "آستقبال" (شيت عُمان) كاستقبال.
  const n = normalizeArabic((name || "").trim().replace(/^[\d٠-٩]+\s*[.\-)،]\s*/, ""));
  return TRANSFER_PREFIXES.some(p => n.startsWith(normalizeArabic(p)));
}

/**
 * Normalize Arabic text for fuzzy matching: convert Arabic-Indic digits to
 * ASCII (٨ → 8), strip tashkeel, fold alif/ya/ta-marbuta variants, collapse
 * whitespace. Lets us match "المنجروف" → "المانجروف" and "٨" → "8".
 */
function normalizeArabic(s: string): string {
  return (s || "")
    .replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/[۰-۹]/g, c => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/[يى]/g, "ي")
    .replace(/[ؤئ]/g, "ا")
    .replace(/[\s ]+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Recognize a "free day" placeholder tour row. The sheet decorates some with a
 * leading parenthesis or list number ("(يوم حر فيه سرايفوا بدون ساىق )"), so we
 * strip any leading non-Arabic characters before anchoring the match. Without
 * this the row reads as a price-0 sightseeing tour that sorts AHEAD of real
 * tours — stealing a stay-day slot and, on a later edit, displacing the tour
 * that was already scheduled on another day.
 */
function isFreeDayName(name: string): boolean {
  const n = (name || "").trim().replace(/^[^؀-ۿ]+/u, "");
  return /^يوم\s*(?:ال)?حر/u.test(n);
}

/** Arabic stop words that don't help discriminate between tours. */
const ARABIC_STOP_WORDS = new Set([
  "في", "من", "إلى", "الى", "على", "و", "أو", "او", "ال",
  "بـ", "ب", "ل", "لـ", "هي", "هو", "ذا", "هذه", "هذا",
  "the", "a", "an", "in", "of", "to", "and", "or",
]);

/** Jaccard similarity over character bigrams — robust to missing/extra letters. */
function bigramSim(a: string, b: string): number {
  if (!a || !b || a.length < 2 || b.length < 2) return 0;
  const ab = new Set<string>(); for (let i = 0; i < a.length - 1; i++) ab.add(a.slice(i, i + 2));
  const bb = new Set<string>(); for (let i = 0; i < b.length - 1; i++) bb.add(b.slice(i, i + 2));
  let common = 0;
  for (const g of ab) if (bb.has(g)) common++;
  return common / Math.max(ab.size, bb.size);
}

/**
 * Find the best-matching tour by keyword overlap with the user-typed query.
 * - When `cityFilter` is given, only tours in that city are considered.
 * - Per-keyword score: exact substring (q.length) OR bigram similarity ≥ 0.6
 *   against any tour word (q.length × sim). Bigram fallback handles common
 *   misspellings like "المنجروف" ≈ "المانجروف" (missing/extra alif).
 * - Ties broken by cheaper price first.
 */
function findTourByKeywords(
  query: string,
  tours: TourRow[],
  cityFilter?: { cityDefs: CityDef[]; canonicalCity: string },
): TourRow | null {
  const qNorm = normalizeArabic(query);
  const qWords = qNorm.split(/\s+/)
    .filter(w => (w.length >= 2 || /\d/.test(w)) && !ARABIC_STOP_WORDS.has(w));
  if (qWords.length === 0) return null;

  // Transfer/pickup rows live in the tours table too; filter them out so a
  // request to "غير جولة X" never resolves to a driver-movement row.
  const pool = (cityFilter
    ? tours.filter(t => tourBelongsToCity(t, cityFilter.cityDefs, cityFilter.canonicalCity))
    : tours
  ).filter(t => !isTransferTour(t.name));

  const stripAl = (w: string) => w.replace(/^ال/, "");

  let best: { tour: TourRow; score: number } | null = null;
  for (const t of pool) {
    const nNorm = normalizeArabic(t.name);
    const nWords = nNorm.split(/\s+/);
    let score = 0;
    for (const q of qWords) {
      const qBare = stripAl(q);
      // Fast path: exact substring (with or without leading ال)
      if (nNorm.includes(q) || (qBare.length >= 2 && nNorm.includes(qBare))) {
        score += q.length;
        continue;
      }
      // Bigram fallback per word — catches alif/yaa/ta-marbuta typos
      let bestSim = 0;
      for (const nw of nWords) {
        const nwBare = stripAl(nw);
        for (const cand of [q, qBare]) {
          for (const tgt of [nw, nwBare]) {
            const s = bigramSim(cand, tgt);
            if (s > bestSim) bestSim = s;
          }
        }
      }
      if (bestSim >= 0.6) score += q.length * bestSim;
    }
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && (t.price || 0) < (best.tour.price || 0))) {
      best = { tour: t, score };
    }
  }
  return best ? best.tour : null;
}

/**
 * Return the single canonical city this tour belongs to, or null. The name-city
 * is authoritative; only a nameless tour falls back to its sheet section-city
 * (so day-trips like الأميرات / فيالاند still resolve to their base city).
 */
function getTourCity(tour: TourRow, cityDefs: CityDef[]): string | null {
  const nameCity = tourNameCity(tour, cityDefs);
  if (nameCity) return nameCity;
  return tour.city && tour.city.trim() ? tour.city.trim() : null;
}

/**
 * Pick tours for a city: prefer FREE tours (price=0) first, then cheapest paid
 * tours — but evaluate "cheapest" using the variant matching the actual pax
 * count, NOT the default first-variant price. So a 6-pax group sorts tours
 * by their pax-6-8 variant price.
 *
 * Returns up to `nightsInCity` unique tours plus deficit info if not enough
 * tours exist for the city.
 */
export function pickToursForCity(
  allTours: TourRow[],
  cityDefs: CityDef[],
  canonicalCity: string,
  nightsInCity: number,
  paxCount: number,
  options?: {
    /** Tours to pin in front of the auto-selected list (e.g. swap targets) */
    pinnedTours?: TourRow[];
    /** Tour names to exclude entirely (matched case-insensitively, trimmed) */
    excludeNames?: Set<string>;
    /** Number of stay-days to leave EMPTY (free day) — shrinks selected list */
    freeDayCount?: number;
  },
): { selected: TourRow[]; available: number; deficit: number } {
  // Real tours only (not transfer/pickup rows) belonging to this city
  const isTransfer = isTransferTour;

  const exclude = options?.excludeNames || new Set<string>();
  const pinned = options?.pinnedTours || [];
  const freeDayCount = options?.freeDayCount || 0;
  const pinnedNames = new Set(pinned.map(t => t.name.trim().toLowerCase()));
  const isExcluded = (name: string) => exclude.has(name.trim().toLowerCase());

  const cityTours = allTours.filter(t =>
    !isTransfer(t.name)
    && tourBelongsToCity(t, cityDefs, canonicalCity)
    && !isExcluded(t.name)
    && !pinnedNames.has(t.name.trim().toLowerCase()),
  );

  // Sort: paid sightseeing tours BEFORE "يوم حر" rows, then by price asc,
  // then name. A "يوم حر للاستجمام" row is a placeholder for an empty day —
  // it should only fill a slot when there are no paid tours left, not beat
  // a paying tour just because it's free. Without this, KL with 2 stay
  // days and 3 candidates [تسوق=200, جنتنج=200, يوم حر=0] picked
  // [يوم حر, تسوق] and dropped Genting entirely.
  const isFreeDayPlaceholder = (t: TourRow) => isFreeDayName(t.name);
  cityTours.sort((a, b) => {
    const af = isFreeDayPlaceholder(a) ? 1 : 0;
    const bf = isFreeDayPlaceholder(b) ? 1 : 0;
    if (af !== bf) return af - bf;
    const pa = pickTourVariantPrice(a, paxCount, false);
    const pb = pickTourVariantPrice(b, paxCount, false);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  // Reserve slots for pinned tours, leave freeDayCount slots empty, fill rest
  // with cheapest-first auto picks. `available` counts only the auto pool —
  // pinned tours are guaranteed to fit, so they're not part of the deficit.
  const remainingSlots = Math.max(0, nightsInCity - pinned.length - freeDayCount);
  const auto = cityTours.slice(0, remainingSlots);
  const selected = [...pinned, ...auto];
  return {
    selected,
    available: cityTours.length + pinned.length,
    deficit: Math.max(0, remainingSlots - auto.length),
  };
}

/**
 * Pick flights for the inter-city legs.
 * Given an ordered city list (e.g., [Hanoi, Sapa, Ha Long]), returns flights
 * for the legs that cross cities (only when matching rows exist in the DB).
 * Land transfers (no flight available) are handled separately.
 */
export function pickInterCityFlights(
  allFlights: FlightRow[],
  cityOrder: string[],
): FlightRow[] {
  const result: FlightRow[] = [];
  for (let i = 0; i < cityOrder.length - 1; i++) {
    const from = cityOrder[i];
    const to = cityOrder[i + 1];
    // Intra-city moves (Bali Kuta → Bali Seminyak) share the same canonical
    // city — no flight, even if a bogus "Bali → Bali" row exists in the DB.
    if (from === to) continue;
    const match = findFlight(allFlights, from, to);
    if (match) result.push(match);
  }
  return result;
}

// Normalize a city name for flight/train matching: lowercase, drop airport-code
// parentheticals ("Ha Noi (HAN)"), strip diacritics/separators, expand
// "saint" → "st" so canonical "St Petersburg" matches "Saint Petersburg".
function normFlightCity(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s\.\-_,]/g, "")
    .replace(/saint/g, "st");
}

// True when two city names refer to the same place despite sheet spelling
// drift. The flight block is hand-typed and frequently misspells the canonical
// names ("Istanbol"≈"Istanbul", "Trabozon"≈"Trabzon"). Substring match handles
// prefixes/airport codes; a bigram-similarity fallback (≥0.6) absorbs the
// one/two-letter typos that plain includes() can't. Both the from- and to-city
// must match, so the threshold stays safe from cross-city false positives.
function flightCityMatches(a: string, b: string): boolean {
  const x = normFlightCity(a);
  const y = normFlightCity(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return bigramSim(x, y) >= 0.6;
}

// مدن فرعية ليس لها مطار خاص — الوصول إليها يكون عبر مطار مدينة أخرى.
// مثال: أوزنجول/آيدر/ريزه تُخدَم بمطار طرابزون، فالطيران من اسطنبول إليها = اسطنبول→طرابزون.
const AIRPORT_REGION: Array<{ airport: string; pattern: RegExp }> = [
  { airport: "Trabzon", pattern: /uzungol|[أا]وزنجول|[أا]وزونغول|ayder|[أآا]يدر|rize|ريز[ها]?/i },
];
function flightAirportCity(city: string): string {
  const hit = AIRPORT_REGION.find(r => r.pattern.test(city));
  return hit ? hit.airport : city;
}
function findFlight(flights: FlightRow[], from: string, to: string): FlightRow | null {
  // اربط المدن الفرعية بمطارها قبل المطابقة (أوزنجول→طرابزون)
  const f = flightAirportCity(from), t = flightAirportCity(to);
  if (normFlightCity(f) === normFlightCity(t)) return null;   // نفس المطار → لا طيران
  return flights.find(fl =>
    flightCityMatches(fl.from_city, f) && flightCityMatches(fl.to_city, t)
  ) || null;
}

/**
 * Find ground-transfer rows used at airports. We re-use the tours table
 * (those flagged as transfer prefixes) and look for ones mentioning the
 * relevant airport actions (pickup, drop) and city.
 */
/**
 * Match transfer-row name against a canonical city using its DEST_CITIES
 * pattern (the same regex that catches Arabic/Latin spellings).
 */
function tourNameMatchesCity(tourName: string, canonicalCity: string, cityDefs: CityDef[]): boolean {
  const def = cityDefs.find(c => c.canonical === canonicalCity);
  if (!def) return false;
  return def.pattern.test(tourName);
}

export function findArrivalPickup(
  allTours: TourRow[],
  city: string,
  destination: string,
  cityDefs: CityDef[],
  preferType: "airport" | "train" = "airport",
  requestedTransport: "private" | "shared" | null = null,
): TourRow | null {
  // City-specific candidates first. Two filters protect against picking
  // wrong-direction rows:
  //   (a) the row's PRIMARY verb must be a pickup (استقبال/الاستقبال) —
  //       rows like "5. التوصيل من فندق باندونق ... والاستقبال هناك" are
  //       drop+pickup combos where the actual pickup is at the OTHER city
  //       (Bali in that example). Their primary verb is التوصيل, not
  //       استقبال, so they're excluded.
  //   (b) if the row explicitly names a hotel-destination city (e.g.
  //       "والتوصيل للفندق في بونشاك"), THAT must be the query city —
  //       otherwise we'd route a Jakarta query to a Puncak hotel.
  const isPrimaryPickup = (n: string) => {
    // طبّع الألف فيُلتقط "آستقبال" (شيت عُمان) كـ استقبال.
    const firstWord = normalizeArabic(n.replace(/^[\d\.\s]+/, "").trim().split(/\s+/)[0] || "");
    return /^(?:استقبال|الاستقبال)$/u.test(firstWord);
  };
  let candidates = allTours.filter(t => {
    if (t.type !== destination) return false;
    const n = t.name;
    if (!isPrimaryPickup(n)) return false;                                              // (a)
    if (!tourNameMatchesCity(n, city, cityDefs)) return false;
    const hotelCity = extractRowHotelCity(n);
    if (hotelCity && !tourNameMatchesCity(hotelCity, city, cityDefs)) return false;     // (b)
    return true;
  });
  // Fallback: generic pickup rows (no DEST_CITIES city in the name) — used
  // by Turkey ("استقبال من المطار الدولي والتوجه للفندق") and Bosnia for
  // arrivals into cities that don't have a dedicated pickup row.
  if (candidates.length === 0) {
    candidates = allTours.filter(t => {
      if (t.type !== destination) return false;
      const n = t.name;
      if (!/استقبال/.test(normalizeArabic(n))) return false;
      // Reject rows that mention any specific city — those belong elsewhere.
      for (const c of cityDefs) {
        if (c.pattern.test(n)) return false;
      }
      return true;
    });
  }
  if (candidates.length === 0) return null;
  // Prefer the row matching the requested arrival type. Russia's sheet has
  // both "استقبال من مطار موسكو" and "استقبال من قطار موسكو" — picking the
  // wrong one mislabels the transfer (employee sees airport pickup on day 7
  // when they actually arrived from St Petersburg by train).
  const isAirport = (n: string) => /مطار|airport/iu.test(n) && !/قطار|محط[هة]|station|train/iu.test(n);
  const isTrain   = (n: string) => /قطار|محط[هة]|station|train/iu.test(n);
  const preferred = candidates.filter(c => preferType === "airport" ? isAirport(c.name) : isTrain(c.name));
  let pool = preferred.length > 0 ? preferred : candidates;
  const isPriv  = (n: string) => /بسيار[ةه]\s*خاص[ةه]?|سياره\s*خاص[ةه]?|private/iu.test(n);
  const isShare = (n: string) => /مشترك[ةه]?|shared|ليموزين/iu.test(n);
  // Sales rule: ALL transfers default to PRIVATE. Shared (ليموزين/مشتركة)
  // rows are only chosen when the employee explicitly asked for shared.
  // If no private option exists, return null instead of silently auto-
  // picking a shared row — employee will see "no transfer" and can either
  // request shared explicitly or add the row to the sheet.
  const effectiveTransport = requestedTransport ?? "private";
  if (effectiveTransport === "private") {
    const privatePool = pool.filter(c => !isShare(c.name));
    if (privatePool.length === 0) return null;
    pool = privatePool;
  }
  pool.sort((a, b) => {
    const aP = isPriv(a.name) ? 1 : (isShare(a.name) ? -1 : 0);
    const bP = isPriv(b.name) ? 1 : (isShare(b.name) ? -1 : 0);
    if (aP !== bP) return bP - aP;
    return a.price - b.price;
  });
  return pool[0];
}

/**
 * Extract the row's hotel-destination city. Real data has rows like
 * "الاستقبال في مطار جاكرتا والتوصيل للفندق في بونشاك" — the airport is
 * Jakarta but the actual hotel destination is Puncak. Without this, a
 * pickup-for-Jakarta query would falsely select that row. Returns "" if
 * no hotel-destination clause is found (row implicitly drops at the same
 * city as the airport/station mentioned earlier).
 */
function extractRowHotelCity(n: string): string {
  // نتخطّى كلمة «مدينة/مدينه» (و«وسط») حتى نلتقط اسم المدينة الفعلي، لا الكلمة الحشوية:
  // "الفندق في مدينه سوتشي" → "سوتشي" (وليس "مدينه").
  const m = n.match(/(?:للفندق|الى\s*الفندق|والتوصيل\s*للفندق|الى\s*فندق(?:\s+الاقامه)?)\s+في\s+(?:(?:وسط\s+)?مدين[ةه]\s+|وسط\s+)?([^\s.]+(?:\s+[^\s.]+){0,2}?)(?=\s|$|\.|واستلام|لاستلام)/iu);
  return m ? m[1].trim() : "";
}

/**
 * Extract a row's actual departure-place from its name. Used by both
 * findInterCityTransfer and findDepartureDrop so a row like "الخروج من
 * فندق بالي والتوجه الى المطار لذهاب الي جاكزتا" is not falsely matched
 * as a Jakarta departure (the Jakarta mention is the destination half).
 */
function extractRowFromCity(n: string): string {
  // Pattern 1: "(verb) من [filler]? CITY <terminator>"
  //   filler ∈ {(ال)?فندق(_في)?, خليج, مدينه, مدينة} — "ال" prefix is
  //     accepted because the sheet inconsistently uses "من الفندق" vs "من فندق".
  //   terminator ∈ {الى/إلى/الي, والتوصيل, والتوجه, للمطار,
  //                 للمحطة, للقطار, للتوجه, للذهاب}
  const m1 = n.match(/من\s+(?:(?:ال)?فندق(?:\s+في)?\s+|(?:ال)?خليج\s+|(?:ال)?مدينه\s+|(?:ال)?مدينة\s+)?([^\s]+(?:\s+[^\s]+){0,2}?)\s+(?:الى|إلى|الي|والتوصيل|والتوجه|للمطار|للمحط[هة]|للقطار|للتوجه|للذهاب)/iu);
  if (m1) return m1[1];
  // Pattern 2: "(المطار|محط[هة])(_الدولي)? في? CITY <forward action>"
  const m2 = n.match(/(?:المطار|محط[هة])(?:\s+الدولي)?\s*(?:في\s*)?([^\n]+?)\s+(?:للتوجة|للذهاب|للعوده|للعودة|والاستقبال)/iu);
  if (m2) return m2[1];
  // Pattern 3 (fallback): "من [filler]? CITY ..." — captures the first
  // non-whitespace token after the filler with no terminator requirement.
  // Catches rows like "العوده من مدينه هالونج بسياره ليموزين مشتركه الى
  // المطار" where the means-of-transport ("بسياره ليموزين...") sits
  // between the city and the destination-marker.
  const m3 = n.match(/من\s+(?:(?:ال)?فندق(?:\s+في)?\s+|(?:ال)?خليج\s+|(?:ال)?مدينه\s+|(?:ال)?مدينة\s+)?([^\s]+)/iu);
  if (m3) return m3[1];
  return "";
}

export function findDepartureDrop(
  allTours: TourRow[],
  city: string,
  destination: string,
  cityDefs: CityDef[],
  requestedTransport: "private" | "shared" | null = null,
): TourRow | null {
  let candidates = allTours.filter(t => {
    if (t.type !== destination) return false;
    const n = t.name;
    if (/استقبال|الاستقبال|pickup/iu.test(n)) return false;
    if (!/توديع|التوديع|التوجه|التوجة|توج[ةه]|الذهاب|الخروج|توصيل|التوصيل|للعوده|للعودة|العوده|العودة|drop/iu.test(n)) return false;
    const rowFrom = extractRowFromCity(n);
    if (!rowFrom) return false;
    if (!tourNameMatchesCity(rowFrom, city, cityDefs)) return false;
    // Reject rows that are clearly an inter-city transit (their destination
    // is another DEST_CITIES entry, not the airport for going home). For
    // example "التوجه من هانوي الى مدينه هالونج" matches "Hanoi as from"
    // but is a transit to Halong, not a departure to the international
    // airport.
    for (const c of cityDefs) {
      if (c.canonical === city) continue;
      // If the row mentions another canonical city, treat as inter-city.
      // The "ارض الوطن/الديار/للسلامه/للعوده/مطار" markers override —
      // those unambiguously indicate going home (or to an airport, which
      // is the only reason a departure row would name another city like
      // "الى مطار هانوي" when leaving from HaLong).
      const looksLikeGoingHome = /ارض\s*الوطن|الديار|للسلامه|للسلامة|مطار|airport/iu.test(n);
      if (!looksLikeGoingHome && c.pattern.test(n)) return false;
    }
    return true;
  });
  // Fallback: generic departure rows ("توديع الى المطار الدولي" / "الخروج من
  // الفندق للعوده الى ديار الوطن") that don't name any DEST_CITIES city.
  // Used by Turkey + Bosnia where the sheet has one universal departure row.
  if (candidates.length === 0) {
    candidates = allTours.filter(t => {
      if (t.type !== destination) return false;
      const n = t.name;
      if (/استقبال|الاستقبال|pickup/iu.test(n)) return false;
      if (!/توديع|التوديع|الخروج|للعوده|للعودة|drop/iu.test(n)) return false;
      // Must look like an international departure (going home/airport).
      if (!/مطار|airport|ارض\s*الوطن|ديار|للسلامه|للسلامة/iu.test(n)) return false;
      // Generic = mentions no DEST_CITIES city
      for (const c of cityDefs) if (c.pattern.test(n)) return false;
      return true;
    });
  }
  if (candidates.length === 0) return null;
  // Sort priority:
  //   (1) international-departure rows (mention "ارض الوطن"/"الديار"/"الدولي")
  //   (2) PRIVATE rows preferred over shared — default sales preference
  //   (3) cheapest within the same tier
  const isPrivateRow = (n: string) => /بسيار[ةه]\s*خاص[ةه]?|سياره\s*خاص[ةه]?|private/iu.test(n);
  const isSharedRow = (n: string) => /مشترك[ةه]?|shared|ليموزين/iu.test(n);
  // Sales rule (mirrors findArrivalPickup / findInterCityTransfer): default
  // to PRIVATE. Never auto-fall-back to a shared row.
  const effectiveTransport = requestedTransport ?? "private";
  if (effectiveTransport === "private") {
    const privateOnly = candidates.filter(c => !isSharedRow(c.name));
    if (privateOnly.length === 0) return null;
    candidates = privateOnly;
  }
  candidates.sort((a, b) => {
    const aHome = /ارض\s*الوطن|الديار|للسلامه|للسلامة|للعوده|للعودة|الدولي/iu.test(a.name) ? 1 : 0;
    const bHome = /ارض\s*الوطن|الديار|للسلامه|للسلامة|للعوده|للعودة|الدولي/iu.test(b.name) ? 1 : 0;
    if (aHome !== bHome) return bHome - aHome;
    const aPriv = isPrivateRow(a.name) ? 1 : (isSharedRow(a.name) ? -1 : 0);
    const bPriv = isPrivateRow(b.name) ? 1 : (isSharedRow(b.name) ? -1 : 0);
    if (aPriv !== bPriv) return bPriv - aPriv;
    return a.price - b.price;
  });
  return candidates[0];
}

export function findInterCityTransfer(
  allTours: TourRow[],
  fromCity: string,
  toCity: string,
  destination: string,
  cityDefs: CityDef[],
  transitKind: "airport" | "train" = "airport",
  requestedTransport: "private" | "shared" | null = null,
): TourRow | null {
  // Extract the row's *actual* departure-place from its text. The data uses
  // many phrasings — we try the two structural patterns most common in the
  // sheet, and a row that doesn't match either is rejected (don't fall back
  // to "city appears anywhere", that's how wrong-direction rows leak in).
  const rowFromCity = extractRowFromCity;

  // Filter rules:
  //   (a) outbound transfer verb required (توديع/التوجه/الذهاب/التوصيل/drop),
  //   (b) reject pickup rows,
  //   (c) row's actual departure place must match our fromCity,
  //   (d) transit medium must be compatible with transitKind (train transits
  //       can't pick airport-only rows, and vice versa).
  const fromDef = cityDefs.find(c => c.canonical === fromCity);
  if (!fromDef) return null;

  // Two-pass filter: strict first (reject rows mentioning a third city),
  // then a relaxed retry that allows third-city mentions when they're just
  // a flight-destination hint (e.g. "التوجه من فندق دانانج الي المطار
  // لذهاب الى فوكوك" — the airport drop applies to ANY onward flight, but
  // the row text happens to name one specific flight destination).
  const baseFilter = (n: string): boolean => {
    if (/^\s*(?:الاستقبال|استقبال|pickup)(?=\s|$)/iu.test(n)) return false;                  // (b)
    if (!/توديع|التوديع|التوجه|التوجة|توج[ةه]|الذهاب|العوده|العودة|للعوده|للعودة|توصيل|التوصيل|الخروج|النقل|نقل|الانتقال|انتقال|drop/iu.test(n)) return false;
    const isAirportRow = /مطار|airport/iu.test(n) && !/قطار|محط[هة]|station|train/iu.test(n);
    const isTrainRow   = /قطار|محط[هة]|station|train/iu.test(n);
    if (transitKind === "train"   && !isTrainRow) return false;
    if (transitKind === "airport" && isTrainRow && !isAirportRow) return false;
    return true;
  };
  const matchesFromAndType = (tr: TourRow): boolean => {
    if (tr.type !== destination) return false;
    if (!baseFilter(tr.name)) return false;
    const rowFrom = rowFromCity(tr.name);
    if (!rowFrom) return false;
    if (!tourNameMatchesCity(rowFrom, fromCity, cityDefs)) return false;
    return true;
  };
  const isThirdCityClean = (n: string): boolean => {
    for (const c of cityDefs) {
      if (c.canonical === fromCity || c.canonical === toCity) continue;
      if (c.pattern.test(n)) return false;
    }
    return true;
  };
  let fromDrop = allTours.filter(tr => matchesFromAndType(tr) && isThirdCityClean(tr.name));
  // Relaxed retry: when no strict match exists but a "to airport" row from
  // fromCity does (e.g. Da Nang → airport "to Phu Quoc" when transit is
  // Da Nang→Hanoi), prefer it over emitting no transfer at all. Restrict
  // to airport rows so we don't pick a wrong-destination road ride.
  if (fromDrop.length === 0) {
    fromDrop = allTours.filter(tr => {
      if (!matchesFromAndType(tr)) return false;
      // Only accept airport rows in the relaxed branch — a road row to a
      // third city ("Hanoi → HaLong") would land the customer in the wrong
      // city; an airport row's destination is generic (just the airport).
      return /مطار|airport/iu.test(tr.name);
    });
  }
  // Generic airport-drop fallback (mirrors findArrivalPickup's generic-pickup
  // branch). Some agencies model the hotel→airport ride with a single city-less
  // row ("توديع الى المطار الدولي" in Turkey) reused for every city. The strict
  // passes above reject it because it names no origin city, so a domestic-flight
  // leg ended up with an arrival pickup but no departure drop. Accept a generic
  // airport row — one that names NEITHER an origin nor any other canonical city
  // — only for airport transits; the caller already nulls airport rows on road
  // legs, so this can't attach a bogus "go to the airport" line to a car ride.
  if (fromDrop.length === 0 && transitKind === "airport") {
    fromDrop = allTours.filter(tr => {
      if (tr.type !== destination) return false;
      if (!baseFilter(tr.name)) return false;          // outbound verb + airport + type
      if (rowFromCity(tr.name)) return false;          // must be city-less (generic)
      if (!isThirdCityClean(tr.name)) return false;    // names no other canonical city
      return /مطار|airport/iu.test(tr.name);
    });
  }
  // Sales rule (mirrors findArrivalPickup / findDepartureDrop): default
  // to PRIVATE. Never auto-fall-back to a shared (مشتركة/ليموزين) row
  // unless the employee explicitly asked for shared transport.
  {
    const isSharedRowEarly = (n: string) => /مشترك[ةه]?|shared|ليموزين/iu.test(n);
    const effectiveTransportEarly = requestedTransport ?? "private";
    if (effectiveTransportEarly === "private" && fromDrop.length > 0) {
      const privateOnly = fromDrop.filter(tr => !isSharedRowEarly(tr.name));
      if (privateOnly.length === 0) return null;
      fromDrop = privateOnly;
    }
  }
  if (fromDrop.length > 0) {
    // Sort priority:
    //   (1) row explicitly mentions toCity (most precise inter-city match)
    //   (2) row's transport type matches the requested mode (private vs shared) —
    //       a shared trip should pick the "ليموزين مشتركه" row, a private trip
    //       should pick the "بسياره خاصه" row, even when both exist.
    //   (3) row is NOT a "going home" departure
    //   (4) cheapest price
    const toDef = cityDefs.find(c => c.canonical === toCity);
    // "international airport / المطار الدولي" rows are the FINAL departure
    // out of the country — they only make sense for the homeward leg, not
    // for an inter-city transit. Deprioritize them so the sorter prefers
    // any row that mentions the actual toCity (or even a generic "to airport"
    // row) ahead of the international-airport one.
    const isGoingHome = (n: string) => /ارض\s*الوطن|الديار|للسلامه|للسلامة|المطار\s*الدول[يى]|international\s*airport/iu.test(n);
    const isSharedRow = (n: string) => /مشترك[ةه]?|shared|ليموزين/iu.test(n);
    const isPrivateRow = (n: string) => /بسيار[ةه]\s*خاص[ةه]?|سياره\s*خاص[ةه]?|private/iu.test(n);
    // Default Hanoi ↔ Sapa transit in Vietnam to PRIVATE when employee
    // didn't pick one. The shared "ليموزين" row is cheaper so it would
    // otherwise win on price (4), but sales preference for this route is
    // a private car priced for the group.
    // Default ALL inter-city transit to PRIVATE when employee didn't pick
    // one. Sales preference is private cars priced for the group; shared
    // ليموزين rows are cheaper and would win on price alone if we left
    // requestedTransport as null. Employee can still override per-trip with
    // "مشتركة" or per-modification later.
    const effectiveTransport = requestedTransport ?? "private";
    // Detect the row's destination type — "to hotel" (lands at next city's
    // hotel, suitable for a stay) vs "to airport" (drops at airport, suitable
    // for an onward flight or final departure). When the transit is a road
    // ride that ends at a hotel night, the "to hotel" row is the right pick.
    const destType = (n: string): "hotel" | "airport" | "other" => {
      const m = n.match(/(?:الى|إلى)\s+(?:ال)?(فندق|hotel|مطار|airport)/iu);
      if (!m) return "other";
      return /فندق|hotel/i.test(m[1]) ? "hotel" : "airport";
    };
    fromDrop.sort((a, b) => {
      // (1) prefer rows that explicitly mention toCity
      const aHasTo = toDef ? toDef.pattern.test(a.name) : false;
      const bHasTo = toDef ? toDef.pattern.test(b.name) : false;
      if (aHasTo !== bHasTo) return aHasTo ? -1 : 1;
      // (1.5) "to hotel" beats "to airport" when both exist. Reason: this
      // function is called for transit days that END at a hotel stay (the
      // customer sleeps in toCity that night). A "to airport" row only
      // makes sense for the final departure day, which is handled by
      // findDepartureDrop instead.
      const aDest = destType(a.name);
      const bDest = destType(b.name);
      if (aDest !== bDest) {
        if (aDest === "hotel" && bDest === "airport") return -1;
        if (aDest === "airport" && bDest === "hotel") return 1;
      }
      // (2) match the requested transport mode — shared trip picks the
      // "مشتركة" row, private trip picks the "خاصة" row. This is the user-
      // visible difference between "غير لخاصة" and "غير لمشتركة".
      if (effectiveTransport) {
        const aMatches = effectiveTransport === "shared" ? isSharedRow(a.name) : isPrivateRow(a.name);
        const bMatches = effectiveTransport === "shared" ? isSharedRow(b.name) : isPrivateRow(b.name);
        if (aMatches !== bMatches) return aMatches ? -1 : 1;
      }
      // (3) non-final-departure rows preferred for an inter-city transit
      const aHome = isGoingHome(a.name);
      const bHome = isGoingHome(b.name);
      if (aHome !== bHome) return aHome ? 1 : -1;
      // (4) cheapest wins
      return a.price - b.price;
    });
    return fromDrop[0];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// DAY ARRANGER — schedule days (arrival / stay / transit / departure)
// ─────────────────────────────────────────────────────────────────────────

export type Day = {
  number: number;
  type: "arrival" | "stay" | "transit" | "departure";
  city: string;            // city slept in that night (departure has no sleep)
  date: Date;              // date of this day
  fromCity?: string;        // for transit days
  toCity?: string;          // for transit days
};

const ARABIC_MONTHS_OUT = [
  "يناير","فبراير","مارس","أبريل","مايو","يونيو",
  "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر",
];

export function formatArabicDate(d: Date): string {
  return `${d.getDate()} ${ARABIC_MONTHS_OUT[d.getMonth()]} ${d.getFullYear()}`;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d.getTime());
  copy.setDate(copy.getDate() + n);
  return copy;
}

function resolveStartDate(request: TripRequest): Date {
  if (request.startDate) {
    const d = parseAnyDate(request.startDate);
    if (d) return d;
  }
  if (request.year && request.month) {
    return new Date(request.year, monthNumber(request.month) - 1, 1);
  }
  // Fallback: first of next month
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

/**
 * Build the day-by-day arrangement for the program.
 * Uses cityStaysOrdered if available (preserves order + duplicates like
 * "Hanoi at start AND Hanoi at end"). Falls back to deduped cities otherwise.
 */
export function arrangeDays(request: TripRequest): Day[] {
  const days: Day[] = [];
  const startDate = resolveStartDate(request);

  // Prefer the ordered list so repeated cities are kept as separate stays
  const orderedStays: Array<{ city: string; nights: number }> =
    request.cityStaysOrdered && request.cityStaysOrdered.length > 0
      ? request.cityStaysOrdered.filter(s => s.nights > 0)
      : (request.cities.length > 0 ? request.cities : Object.keys(request.nightsByCity))
          .map(c => ({ city: c, nights: request.nightsByCity[c] || 0 }))
          .filter(s => s.nights > 0);

  let dayNum = 1;
  for (let i = 0; i < orderedStays.length; i++) {
    const { city, nights } = orderedStays[i];

    for (let n = 0; n < nights; n++) {
      const date = addDays(startDate, dayNum - 1);
      let type: Day["type"];
      let fromCity: string | undefined;
      const toCity = city;
      if (n === 0 && i === 0) {
        type = "arrival";
      } else if (n === 0) {
        type = "transit";
        fromCity = orderedStays[i - 1].city;
      } else {
        type = "stay";
      }
      days.push({ number: dayNum, type, city, date, fromCity, toCity });
      dayNum++;
    }
  }

  // Final departure day (one extra day, no sleep)
  const lastStay = orderedStays[orderedStays.length - 1];
  if (lastStay) {
    days.push({
      number: dayNum,
      type: "departure",
      city: lastStay.city,
      date: addDays(startDate, dayNum - 1),
    });
  }
  return days;
}

// ─────────────────────────────────────────────────────────────────────────
// OUTPUT FORMATTER — generates the DEST/HOTELS/FLIGHTS/... text block
// ─────────────────────────────────────────────────────────────────────────

export type SelectedHotel = { city: string; rangeFrom: Date; rangeTo: Date; nights: number; hotel: HotelRow };
export type SelectedTour = { day: number; city: string; tour: TourRow };
// kind defaults to "flight" when omitted; "train" routes are rendered with
// the Arabic label "قطار" instead of "داخلي/دولي" in FLIGHTS section.
export type SelectedFlight = { day: number; flight: FlightRow; kind?: "flight" | "train" };
export type SelectedTransfer = { day: number; row: TourRow; kind: "Pickup" | "Drop" };

export type ProgramData = {
  request: TripRequest;
  destinationName: string;
  days: Day[];
  hotels: SelectedHotel[];
  flights: SelectedFlight[];
  tours: SelectedTour[];
  transfers: SelectedTransfer[];
  simCount: number;
  extraBedScope: TripRequest["extraBed"]["scope"];
  cityArabicNames: Record<string, string>;
};

const DESTINATION_AR_NAMES: Record<string, string> = {
  vietnam: "فيتنام",
  Malaysia: "ماليزيا",
  thailand: "تايلاند",
  Turky: "تركيا",
  russia: "روسيا",
  Bosnia: "البوسنة",
  indonesia: "إندونيسيا",
};

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US"); // 1,500 with English digits
}

export function pickTourVariantPrice(tour: TourRow, paxCount: number, isShared: boolean, month = 0): number {
  const variants = tour.variants || [];
  if (variants.length === 0) return tour.price || 0;
  // Month-based variants (e.g. "may month" / "june month" / "شهر يونيو") — pick by
  // the request's month so May ≠ June pricing is honored (Turkey seasonal rows).
  const labelMonth = (label: string): number => {
    const lbl = label.toLowerCase();
    for (const [name, num] of Object.entries(ARABIC_MONTH_TO_NUMBER)) {
      if (name.length >= 3 && lbl.includes(name)) return num;
    }
    return 0;
  };
  const hasPaxRange = variants.some(v => /\d+\s*-\s*\d+/.test(String(v.label || "")) || /per\s*pax/i.test(String(v.label || "")));

  // (1) Pure month-based seasonal rows (no pax ranges): pick by the request's
  // month so May ≠ June pricing is honored (Turkey seasonal tour rows).
  if (!hasPaxRange && variants.some(v => labelMonth(v.label) > 0)) {
    const mv = variants.map(v => ({ v, m: labelMonth(v.label) })).filter(x => x.m > 0).sort((a, b) => a.m - b.m);
    const base = mv.length ? mv[0].v.price : (variants[0].price || tour.price || 0);  // أدنى شهر = السعر الأساسي
    if (!month || !mv.length) return base;
    // موسم الذروة الصيفي يونيو–أغسطس له سعر مختلف؛ باقي السنة بالسعر الأساسي.
    if (month >= 6 && month <= 8) {
      const summer = mv.find(x => x.m >= 6 && x.m <= 8);
      return summer ? summer.v.price : mv[mv.length - 1].v.price;
    }
    return base;
  }

  // (2) Pax-range rows. These MAY also carry seasonal columns: the same pax
  // range repeated, ordered base-season then peak-season (Turkey transfers:
  // col "1-8 pax"=380 عادي ثم "1-8 pax"=415 ذروة). We match the pax bucket
  // first, then disambiguate the season by COLUMN ORDER among the survivors.
  const labelMatches = (label: string): boolean => {
    const lbl = label.toLowerCase();
    if (/per\s*pax/.test(lbl)) return isShared;
    const range = lbl.match(/(\d+)\s*-\s*(\d+)/);
    if (range) {
      const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      return paxCount >= a && paxCount <= b;
    }
    const single = lbl.match(/(?:^|\s|pax\s*)(\d+)\s*$/) || lbl.match(/^(\d+)\s*$/);
    if (single) return paxCount === parseInt(single[1], 10);
    return false;
  };

  // Candidate variants for this pax count (column order preserved).
  let cands = variants.filter(v => labelMatches(v.label));
  if (cands.length === 0) {
    // No exact bucket. If the group is LARGER than every defined range (e.g. 10
    // pax but rows cap at "1-8 pax"), use the BIGGEST vehicle; if smaller than
    // all, the smallest. NEVER fall back to variants[0] (cheapest), which would
    // under-charge a large group. Keep ALL columns of the chosen bucket so the
    // seasonal pick below still applies. Caller adds a capacity warning.
    const ranged = variants
      .map(v => { const m = String(v.label || "").toLowerCase().match(/(\d+)\s*-\s*(\d+)/); return m ? { v, lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) } : null; })
      .filter((x): x is { v: { label: string; price: number }; lo: number; hi: number } => !!x);
    if (ranged.length) {
      const maxHi = Math.max(...ranged.map(r => r.hi));
      if (paxCount > maxHi) cands = ranged.filter(r => r.hi === maxHi).map(r => r.v);   // أكبر سيارة
      else { const minLo = Math.min(...ranged.map(r => r.lo)); cands = ranged.filter(r => r.lo === minLo).map(r => r.v); }
    }
  }
  if (cands.length === 0) return variants[0].price || tour.price || 0;
  if (cands.length === 1) return cands[0].price;
  // Multiple columns share the matched bucket → seasonal: first = base season,
  // last = peak (June–August).
  if (month >= 6 && month <= 8) return cands[cands.length - 1].price;
  return cands[0].price;
}

// أقصى سعة ركاب للصف (من شرائح "pax A-B")؛ 0 إذا ما فيه نطاقات معرّفة.
export function vehicleMaxCapacity(tour: TourRow): number {
  const variants = tour.variants || [];
  let maxHi = 0;
  for (const v of variants) {
    const m = String(v.label || "").toLowerCase().match(/(\d+)\s*-\s*(\d+)/);
    if (m) maxHi = Math.max(maxHi, parseInt(m[2], 10));
  }
  return maxHi;
}

export function formatProgram(data: ProgramData): string {
  const { request, days, hotels, flights, tours, transfers, simCount, destinationName, cityArabicNames } = data;
  const adults = request.adults || 2;
  const childrenCount = Math.max(0, request.children || 0);
  // Surface "طفل" in META / CLIENT / TOTAL_GROUP whenever the trip has kids,
  // so the PDF (and pricing screen) explicitly names them. The frontend still
  // parses adult count from "N أشخاص" — that part stays at the start of the
  // string; the child fragment is appended.
  const childSuffix = childrenCount > 0
    ? ` + ${childrenCount} ${childrenCount === 1 ? "طفل" : "أطفال"}`
    : "";
  const totalDays = days.length;
  const totalNights = totalDays - 1;
  const startDate = days[0]?.date || resolveStartDate(request);
  const endDate = days[days.length - 1]?.date || startDate;
  const reqMonth = startDate ? (startDate.getMonth() + 1) : 0;   // شهر التاريخ للتسعير الموسمي
  // Derive META's month from the resolved start date — when an explicit
  // travel date is provided ("سفر 10 اغسطس"), that's the source of truth.
  // Without this, an unrelated "في شهر يونيو" elsewhere in the message
  // would override and surface "يونيو" in META while DATE_FROM correctly
  // shows August, which reads as a bug to the employee.
  const monthLabel = startDate
    ? `${ARABIC_MONTHS_OUT[startDate.getMonth()]} ${startDate.getFullYear()}`
    : (request.month ? `${request.month}${request.year ? " " + request.year : ""}` : "");

  let out = "";

  // ── DEST / META / DATES / CLIENT ────────────────────────────────────
  out += `DEST:${destinationName}\n`;
  out += `META:${totalDays} أيام | ${totalNights} ليالي | ${monthLabel} | ${adults} ${adults === 1 ? "شخص" : adults === 2 ? "شخص" : "أشخاص"}${childSuffix}\n`;
  out += `DATE_FROM:${formatArabicDate(startDate)}\n`;
  out += `DATE_TO:${formatArabicDate(endDate)}\n`;
  out += `CLIENT:${adults === 2 ? "شخصان بالغان" : `${adults} بالغين`}${childSuffix}\n`;
  out += `CLIENT_CODE:ALZ-2026-001\n\n`;

  // ── HOTELS ───────────────────────────────────────────────────────────
  out += "HOTELS:\n";
  for (const sh of hotels) {
    const meals = sh.hotel.meals
      ? `ما يشمل: ${sh.hotel.meals}`
      : (sh.hotel.includes_breakfast ? "إفطار مشمول" : "بدون وجبات");
    const cityAr = cityArabicNames[sh.city] || sh.city;
    // Append "(يتسع N أشخاص)" to the room_type field whenever the DB row
    // declares an occupancy — makes capacity legible at a glance instead of
    // hiding it inside cryptic room names like "SUITE STANDARD".
    const occN = extractAdultsCount(sh.hotel.occupancy || "");
    const roomTypeWithOcc = occN > 0
      ? `${sh.hotel.room_type} (يتسع ${occN} أشخاص)`
      : sh.hotel.room_type;
    out += `${sh.hotel.name} | ${cityAr} | ${sh.hotel.stars} نجوم | ${roomTypeWithOcc} | ${formatNumber(sh.hotel.price_per_night)} ريال/ليلة | ${sh.nights} ${sh.nights === 1 ? "ليلة" : "ليالي"} (من ${formatArabicDate(sh.rangeFrom)} إلى ${formatArabicDate(sh.rangeTo)}) | ${meals}\n`;
  }
  out += "\n";

  // ── FLIGHTS — sort by day. The pax count reflects EVERYONE the employee
  // declared on the trip: adults + children + extras. Children count for
  // flights/trains even when the hotel was downgraded to a 2-adult room
  // (the kid shares the parents' room; the flight seat is non-negotiable).
  // Extras fold into the same row by bumping the count, so the pricing
  // screen and PDF show one row per route — SUMMARY still itemizes the
  // extras so TOTAL_PER_PERSON correctly excludes them.
  const tripChildren = Math.max(0, request.children || 0);
  const tripPax = adults + tripChildren;  // children fly too
  let flightsBase = 0;       // (adults + children) × per-pax — part of trip
  let extraTicketsTotal = 0; // extras × per-pax (itemized in SUMMARY only)
  const extraTickets = Math.max(0, request.extraTickets || 0);
  const totalPax = tripPax + extraTickets;
  out += "FLIGHTS:\n";
  const sortedFlights = [...flights].sort((a, b) => a.day - b.day);
  for (const sf of sortedFlights) {
    flightsBase += sf.flight.price_per_pax * tripPax;
    extraTicketsTotal += sf.flight.price_per_pax * extraTickets;
    const lineTotal = sf.flight.price_per_pax * totalPax;
    const label = sf.kind === "train" ? "قطار" : "داخلي";
    // Prefix the route with "اليوم N:" so the frontend renders the correct
    // departure date directly — without it, the renderer falls back to
    // guessing dates from hotel check-ins (which gets the wrong stay when
    // a city appears more than once in the trip, e.g. Hanoi at start AND end).
    out += `اليوم ${sf.day}: ${sf.flight.from_city} - ${sf.flight.to_city} | ${label} | ${formatNumber(sf.flight.price_per_pax)} ريال/شخص | ${totalPax} ${totalPax === 1 ? "شخص" : "أشخاص"} | ${formatNumber(lineTotal)} ريال\n`;
  }
  const flightsTotal = flightsBase + extraTicketsTotal;
  out += "\n";

  // ── SIM ──────────────────────────────────────────────────────────────
  if (simCount > 0) {
    out += `SIM:${simCount}\n\n`;
  }

  // ── EXTRA_BED_CITIES ─────────────────────────────────────────────────
  if (data.extraBedScope === "all") {
    out += "EXTRA_BED_CITIES:ALL=1\n\n";
  } else if (Array.isArray(data.extraBedScope) && data.extraBedScope.length > 0) {
    out += "EXTRA_BED_CITIES:" + data.extraBedScope.map(c => `${c}=1`).join(", ") + "\n\n";
  }

  // ── TRANSFERS (sorted by day) ────────────────────────────────────────
  out += "TRANSFERS:\n";
  let transfersTotal = 0;
  const sortedTransfers = [...transfers].sort((a, b) => a.day - b.day);
  for (const t of sortedTransfers) {
    const isShared = request.transport === "shared";
    // Detect whether the chosen row actually has a "sharing per pax" variant.
    // Some rows (e.g. "العوده من سابا الى هانوي بسياره خاصه") are PRIVATE-only —
    // their variants are pax-range buckets (pax 1-3, pax 4-8) priced for the
    // whole group, not per-pax. For those, multiplying by pax over-charges.
    // Apply per-pax multiplication ONLY when the variant is genuinely
    // "sharing per pax" or the row name explicitly says مشتركة/shared.
    const variants = t.row.variants || [];
    const hasPerPaxVariant = variants.some(v => /per\s*pax/i.test(v.label || ""));
    const rowSaysShared = /مشترك[ةه]?|shared|ليموزين/iu.test(t.row.name || "");
    const treatAsShared = isShared && (hasPerPaxVariant || rowSaysShared);
    const price = pickTourVariantPrice(t.row, adults, treatAsShared, reqMonth);
    const lineTotal = treatAsShared ? price * adults : price;
    transfersTotal += lineTotal;
    // سعة السيارة: لو المجموعة أكبر من أقصى شريحة ركاب (سيارة خاصة)، نختار أكبر
    // سيارة ونضيف "(سيارة تتسع N)" حتى تعرض الواجهة تنبيهاً للموظف ليضيف سيارة
    // ثانية عند الحاجة. لا ينطبق على الليموزين المشترك (تسعير بالراكب).
    const cap = treatAsShared ? 0 : vehicleMaxCapacity(t.row);
    const capNote = (cap > 0 && adults > cap) ? ` (سيارة تتسع ${cap})` : "";
    out += `اليوم ${t.day} | ${t.row.name.trim()}${capNote} | ${t.kind} | ${formatNumber(lineTotal)} ريال\n`;
  }
  out += "\n";

  // ── TOURS (sorted by day for clean reading) ──────────────────────────
  // Emits one line per scheduled tour AND an explicit "يوم حر" line for any
  // stay day that has no tour — so the pricing screen never leaves a gap
  // between day numbers. Two kinds of free days surface here:
  //   1) Stay days the builder couldn't fill (real deficit) — synthesized
  //      with name "يوم حر — استرخاء في الفندق", type "حر", 0 ريال.
  //   2) Sheet rows whose name starts with "يوم حر" (e.g. "يوم حر للاستجمام
  //      في جزيرة لانكاوي") — relabeled to type "حر" so the pricing screen
  //      shows the same badge as #1 instead of dressing them as "ثقافية".
  const isFreeDayRow = (name: string) => isFreeDayName(name);
  out += "TOURS:\n";
  let toursTotal = 0;
  const tourDays = new Set(tours.map(t => t.day));
  type TourOrFreeLine = { day: number; text: string };
  const tourLines: TourOrFreeLine[] = tours.map(tt => {
    const price = pickTourVariantPrice(tt.tour, adults, false, reqMonth); // tours always private
    toursTotal += price;
    const tourType = isFreeDayRow(tt.tour.name) ? "حر" : "ثقافية";
    return {
      day: tt.day,
      text: `اليوم ${tt.day} | ${tt.tour.name.replace(/\s*[\r\n]+\s*/g, " ").replace(/\s{2,}/g, " ").trim()} | ${tourType} | ${formatNumber(price)} ريال`,
    };
  });
  // Emit a placeholder line for every day not covered by a tour or transfer.
  // Without this, days the builder couldn't fill (stay-day deficits) AND
  // road-transit days that have no transfer row in the sheet (e.g. Sarajevo→
  // Mostar by car) silently drop out of TOURS. The employee then can't see
  // or edit them in the review screen even though they're real days of the
  // trip. Transit days get a clearer "تنقّل" label so the customer knows
  // it's a road day, not a true rest day.
  const transferDays = new Set(transfers.map(t => t.day));
  for (const d of days) {
    if (tourDays.has(d.number)) continue;
    if (transferDays.has(d.number)) continue;
    let label = "يوم حر — استرخاء في الفندق";
    if (d.type === "transit" && d.fromCity && d.toCity) {
      const from = cityArabicNames[d.fromCity] || d.fromCity;
      const to = cityArabicNames[d.toCity] || d.toCity;
      // نفس المدينة (فندق آخر) ليست تنقّلاً بين مدن — إنما تغيير فندق داخل المدينة
      label = (d.fromCity === d.toCity) ? `يوم حر — تغيير الفندق في ${to}` : `يوم تنقّل من ${from} الى ${to}`;
    }
    tourLines.push({
      day: d.number,
      text: `اليوم ${d.number} | ${label} | حر | 0 ريال`,
    });
  }
  tourLines.sort((a, b) => a.day - b.day);
  for (const l of tourLines) out += `${l.text}\n`;
  out += "\n";

  // ── SUMMARY ──────────────────────────────────────────────────────────
  const hotelsBase = hotels.reduce((s, sh) => s + sh.hotel.price_per_night * sh.nights, 0);
  // Extra-bed cost: 5★ → 120/night, 4★ → 100/night. Apply to every hotel
  // in scope (ALL, country marker, or specific city list).
  const isAllScope = data.extraBedScope === "all";
  const scopeList = Array.isArray(data.extraBedScope) ? data.extraBedScope : [];
  const extraBedTotal = hotels.reduce((s, sh) => {
    if (sh.hotel.stars < 4 || sh.hotel.stars > 5) return s;
    const inScope = isAllScope
      || scopeList.includes(sh.city)
      || scopeList.some(c => sh.city.toLowerCase() === String(c).toLowerCase());
    if (!inScope) return s;
    const nightly = sh.hotel.stars >= 5 ? 120 : 100;
    return s + nightly * sh.nights;
  }, 0);
  const hotelsTotal = hotelsBase + extraBedTotal;
  const simTotal = simCount * 50;
  const grand = hotelsTotal + flightsTotal + transfersTotal + toursTotal + simTotal;

  // TOTAL_PER_PERSON excludes the extra-tickets cost — that cost belongs to
  // the additional traveler, not to the adults whose per-person price the
  // employee quotes the client. extraTicketsTotal is shown as its own line
  // so the breakdown still sums to TOTAL_GROUP.
  const perPersonBase = hotelsTotal + flightsBase + transfersTotal + toursTotal + simTotal;
  out += "SUMMARY:\n";
  // Transport-only mode: no hotel and no flight totals — only transfers
  // and tours show. Without this gate, the hotels line still prints "0 ريال"
  // and confuses the employee about whether anything was billed.
  if (!data.request.transportOnly) out += `الفنادق | ${formatNumber(hotelsTotal)} ريال\n`;
  if (!data.request.transportOnly && flightsBase > 0) out += `الطيران الداخلي | ${formatNumber(flightsBase)} ريال\n`;
  if (extraTicketsTotal > 0) out += `تذاكر إضافية (${extraTickets}) | ${formatNumber(extraTicketsTotal)} ريال\n`;
  if (transfersTotal > 0) out += `الانتقالات | ${formatNumber(transfersTotal)} ريال\n`;
  if (toursTotal > 0) out += `الجولات السياحية | ${formatNumber(toursTotal)} ريال\n`;
  if (simTotal > 0) out += `شرائح الاتصال | ${formatNumber(simTotal)} ريال\n`;
  out += `TOTAL_PER_PERSON:${formatNumber(perPersonBase / adults)}\n`;
  const adultPart = `${adults} ${adults === 2 ? "شخص" : "أشخاص"}`;
  const extraPart = extraTickets > 0 ? ` + ${extraTickets} تذكرة إضافية` : "";
  const groupSuffix = `${adultPart}${childSuffix}${extraPart}`;
  out += `TOTAL_GROUP:${formatNumber(grand)} | ${groupSuffix}\n\n`;

  out += `CHAT:برنامجك جاهز! إجمالي ${totalDays} أيام / ${totalNights} ليالي بمبلغ ${formatNumber(grand)} ريال للمجموعة.`;

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// PIPELINE — high-level builder that selects, arranges, formats
// ─────────────────────────────────────────────────────────────────────────

/** Describes a tour or hotel modification that was actually applied. */
export type AppliedModification =
  | { kind: "remove"; tourName: string; city: string }
  | { kind: "swap"; fromName: string; toName: string; city: string }
  | { kind: "add"; tourName: string; city: string }
  | { kind: "hotelSwap"; city: string; fromName: string | null; toName: string; stayLabel: string | null; targetOccupancy: number | null; targetStars: number | null };

export type BuildResult =
  | { ok: true; program: string; appliedModifications: AppliedModification[] }
  | { ok: false; chatMessage: string };

/** True when the request has all info needed to build a complete program */
export function canBuildLocally(request: TripRequest): boolean {
  if (!request.destination) return false;
  if (request.cities.length === 0) return false;
  if (!request.daysTotal || request.daysTotal <= 0) return false;
  // Need a distribution that sums to days-1
  const sumNights = Object.values(request.nightsByCity).reduce((s, n) => s + n, 0);
  if (sumNights !== request.daysTotal - 1) return false;
  // Need adults
  if (!request.adults) return false;
  return true;
}

export async function buildLocalProgram(
  request: TripRequest,
  cityDefs: CityDef[],
  fetchData: () => Promise<{ hotels: HotelRow[]; tours: TourRow[]; flights: FlightRow[]; trains?: TrainRow[] }>,
  cityArabicNames: Record<string, string>,
  /**
   * Conversation hotel history, keyed by canonical city → array of stays
   * IN ORDER they appear in the program. Each stay's `all` is the union of
   * every hotel previously offered for that specific position; `last` is
   * the hotel currently in the most recent program. Per-stay tracking lets
   * a "Hanoi → Sapa → Hanoi" trip swap just one of the Hanoi hotels.
   */
  hotelHistoryByCity?: Record<string, Array<{ all: Set<string>; last: string | null; lastRoomType?: string | null }>>,
  /**
   * Tours that appear in the immediately-prior program (any day, any city).
   * When the employee swaps to "أخرى/اخرى", the picker must exclude these so
   * it doesn't snatch a tour from a non-modded day, leaving that day empty.
   */
  previouslyScheduledTourNames?: Set<string>,
): Promise<BuildResult> {
  if (!canBuildLocally(request)) {
    return { ok: false, chatMessage: "البيانات ناقصة، لم أستطع البناء محلّياً." };
  }
  const { hotels: allHotels, tours: allTours, flights: allFlights, trains: allTrainsRaw } = await fetchData();
  const allTrains: TrainRow[] = allTrainsRaw || [];
  const appliedHotelSwaps: AppliedModification[] = [];

  // Build the stay order EARLY so we can count stays-per-city when resolving
  // ordinal hints ("اول"/"اخير"/"الثاني"). Same logic as the hotel-picking
  // loop below; we just need the city sequence here.
  const stayOrder = request.cityStaysOrdered && request.cityStaysOrdered.length > 0
    ? request.cityStaysOrdered.filter(s => s.nights > 0)
    : request.cities.map(c => ({ city: c, nights: request.nightsByCity[c] || 0 })).filter(s => s.nights > 0);

  // Resolve hotel modifications. Each one maps to a (city, stayIndex) pair
  // where stayIndex is 0-based within that city's occurrences. If the city
  // appears multiple times AND the hint was "all", ask for disambiguation
  // rather than silently swapping all of them.
  // Exclusion sets are keyed by `${city}#${stayIndex}`. Per-stay occupancy
  // overrides (from "غير فندق هانوي لـ 4 أشخاص") use the same key shape.
  const hotelExcludesByStay: Record<string, Set<string>> = {};
  const hotelOverrideOccupancyByStay: Record<string, number> = {};
  const hotelOverrideStarsByStay: Record<string, number> = {};
  const hotelOverrideFeatureByStay: Record<string, string> = {}; // "pool" | "villa"
  const hotelOverrideAreaByStay: Record<string, string> = {}; // Bali sub-area lock for feature swaps
  for (const mod of request.hotelModifications) {
    let resolvedCity: string | null = null;
    let nameMatchedIndices: number[] | null = null;
    // (1) Area alias FIRST. The Bali cityDef pattern lists area names
    // (سيمنياك/كوتا/...) as aliases, so a bare "سيمنياك" matches "Bali"
    // generically — which would then trigger the multi-stay disambiguation
    // since the trip has more than one Bali stay. Catching the area name
    // here pins us to the specific stay and skips the prompt.
    {
      const hintNorm = normalizeArabic(mod.cityHint);
      const AREA_ALIASES: Array<{ pat: RegExp; name: string }> = [
        { pat: /كوتا|kuta/iu, name: "Kuta" },
        { pat: /سيمنياك|سمينياك|seminyak/iu, name: "Seminyak" },
        { pat: /[أا]وبود|ubud/iu, name: "Ubud" },
        { pat: /جيمبران|جيمباران|jimbaran/iu, name: "Jimbaran" },
        { pat: /نوسا\s*دوا|nusa\s*dua/iu, name: "Nusa Dua" },
      ];
      const matchedArea = AREA_ALIASES.find(a => a.pat.test(hintNorm));
      if (matchedArea) {
        const cityIdxPerCity: Record<string, number> = {};
        for (const stay of stayOrder) {
          const idx = (cityIdxPerCity[stay.city] || 0);
          cityIdxPerCity[stay.city] = idx + 1;
          if (stay.area === matchedArea.name && request.cities.includes(stay.city)) {
            resolvedCity = stay.city;
            (nameMatchedIndices ??= []).push(idx);
          }
        }
      }
    }
    // (2) Plain city match (skip if area already resolved us)
    if (!resolvedCity) {
      for (const def of cityDefs) {
        if (def.pattern.test(mod.cityHint) && request.cities.includes(def.canonical)) {
          resolvedCity = def.canonical;
          break;
        }
      }
    }
    // (2) Fall back to hotel-name lookup. We check both the verb-anchored
    // cityHint AND the full raw message, so the employee can put the hotel
    // name BEFORE the verb too ("Beryl Charm Hotel & Spa غير الفندق هذا ل
    // 4 أشخاص") — the name doesn't have to land inside the cityHint capture.
    if (!resolvedCity && hotelHistoryByCity) {
      const hintNorm = normalizeArabic(mod.cityHint);
      const fullNorm = normalizeArabic(mod.fullText || mod.cityHint);
      for (const [city, stays] of Object.entries(hotelHistoryByCity)) {
        for (let idx = 0; idx < stays.length; idx++) {
          const last = stays[idx]?.last;
          if (!last) continue;
          const lastNorm = normalizeArabic(last);
          if (lastNorm.length >= 4 && (hintNorm.includes(lastNorm) || fullNorm.includes(lastNorm))) {
            resolvedCity = city;
            (nameMatchedIndices ??= []).push(idx);
          }
        }
      }
    }
    if (!resolvedCity) {
      return { ok: false, chatMessage: `ما فهمت أي مدينة أو فندق تقصد بـ "${mod.cityHint}". اذكر اسم مدينة من البرنامج أو انسخ اسم الفندق من البرنامج.` };
    }
    const cityStayCount = stayOrder.filter(s => s.city === resolvedCity).length;
    if (cityStayCount === 0) {
      return { ok: false, chatMessage: `${cityArabicNames[resolvedCity] || resolvedCity} مو ضمن إقامات البرنامج.` };
    }

    // Resolve which specific stay(s) the mod targets. When the hint matched
    // a hotel NAME, the matched indices are unambiguous — use them directly
    // and skip the city-ordinal disambiguation (the name pin is the answer).
    let targetIndices: number[] = [];
    if (nameMatchedIndices) {
      targetIndices = nameMatchedIndices;
    } else if (cityStayCount === 1) {
      targetIndices.push(0); // no ambiguity
    } else if (mod.stayHint === "all") {
      // Multi-stay city + no ordinal → ask the employee to specify which one.
      return {
        ok: false,
        chatMessage: `عندك ${cityStayCount} إقامات في ${cityArabicNames[resolvedCity] || resolvedCity}. حدد أيها تبي تغير: "غير فندق ${cityArabicNames[resolvedCity] || resolvedCity} الاول" أو "... الاخير".`,
      };
    } else if (mod.stayHint === "first") {
      targetIndices.push(0);
    } else if (mod.stayHint === "last") {
      targetIndices.push(cityStayCount - 1);
    } else if (typeof mod.stayHint === "number") {
      const idx = mod.stayHint - 1;
      if (idx < 0 || idx >= cityStayCount) {
        return {
          ok: false,
          chatMessage: `ما عندك إقامة رقم ${mod.stayHint} في ${cityArabicNames[resolvedCity] || resolvedCity} (الموجود ${cityStayCount} إقامات فقط).`,
        };
      }
      targetIndices.push(idx);
    }

    for (const idx of targetIndices) {
      const key = `${resolvedCity}#${idx}`;
      const curName = hotelHistoryByCity?.[resolvedCity]?.[idx]?.last;
      const curHotel = curName ? allHotels.find(h => h.name.trim() === curName) : null;
      // Lock EVERY change to the current hotel's sub-area (Bali: Jimbaran/Ubud/
      // …) so a swap never jumps Jimbaran→Kuta. Non-Bali locations return null,
      // and the canonical-city filter already keeps those in the same city.
      const area = curHotel ? extractHotelArea(curHotel.location) : null;
      if (area) hotelOverrideAreaByStay[key] = area;

      if (mod.targetFeature) {
        // Amenity swap ("بمسبح/بفيلا/سويت"): the goal is the room type, not a
        // different hotel — so don't exclude the current one (its own matching
        // room may be the answer). If nothing in this area has it, we notify.
        hotelOverrideFeatureByStay[key] = mod.targetFeature;
      } else {
        const prev = hotelHistoryByCity?.[resolvedCity]?.[idx]?.all;
        hotelExcludesByStay[key] = new Set(
          Array.from(prev || new Set<string>()).map(n => n.toLowerCase()),
        );
      }
      if (mod.targetOccupancy != null) {
        hotelOverrideOccupancyByStay[key] = mod.targetOccupancy;
      }
      if (mod.targetStars != null) {
        hotelOverrideStarsByStay[key] = mod.targetStars;
      } else if (!mod.targetFeature && curHotel && curHotel.stars) {
        // Plain "غير الفندق": keep the SAME star rating as the current hotel so
        // a 4★ swaps to another 4★ — even when the trip set no star constraint.
        hotelOverrideStarsByStay[key] = curHotel.stars;
      }
    }
  }

  // 1. Pick hotel for each STAY in order (handles repeated cities like
  //    "Hanoi at start, Sapa middle, Hanoi at end" → 2 separate Hanoi stays).
  const days = arrangeDays(request);
  const hotelsList: SelectedHotel[] = [];
  // Per-city note when pickCheapestHotel falls back to a larger-occupancy
  // room (e.g., 3 pax in a 4-occupancy room because no 3-pax room exists).
  // Surfaced to the employee in CHAT so they aren't blindsided by the upsize.
  const occupancyUpsizeNotes: string[] = [];
  // Walk days in order, grouping consecutive same-city days into stays.
  let consumedDays = 0;
  const stayIdxPerCity: Record<string, number> = {};
  // Transport-only mode: employee wants only transfers + tours, no hotels.
  // Skip the entire hotel-pick loop; the rest of the pipeline (transfers,
  // tours, day arrangement) keeps working off the city distribution.
  if (request.transportOnly) {
    // No hotels to pick; jump past the loop by emptying stayOrder iteration.
  } else
  for (const stay of stayOrder) {
    const cityDef = cityDefs.find(c => c.canonical === stay.city);
    const cityPattern = cityDef?.pattern;
    const stayIdx = (stayIdxPerCity[stay.city] || 0);
    stayIdxPerCity[stay.city] = stayIdx + 1;
    const excludeForThisStay = hotelExcludesByStay[`${stay.city}#${stayIdx}`];
    const overrideForThisStay = hotelOverrideOccupancyByStay[`${stay.city}#${stayIdx}`];
    const overrideStarsForThisStay = hotelOverrideStarsByStay[`${stay.city}#${stayIdx}`];
    const featureForThisStay = hotelOverrideFeatureByStay[`${stay.city}#${stayIdx}`];
    const areaForThisStay = hotelOverrideAreaByStay[`${stay.city}#${stayIdx}`];
    // Pin slots NOT modded this turn to the hotel they had in the last
    // program. Without this, a follow-up swap rebuilds from scratch and
    // pickCheapestHotel reverts every untouched slot to the catalog's
    // cheapest — undoing earlier turns' swaps. The `last` name is the
    // hotel that was in the immediately-prior program for this slot.
    const hasModForThisStay =
      !!excludeForThisStay || overrideForThisStay != null || overrideStarsForThisStay != null || !!featureForThisStay;
    const lastForThisStay = hotelHistoryByCity?.[stay.city]?.[stayIdx]?.last || null;
    const lastRoomTypeForThisStay = hotelHistoryByCity?.[stay.city]?.[stayIdx]?.lastRoomType || null;
    let hotel: HotelRow | null = null;
    if (lastForThisStay && !hasModForThisStay) {
      // Match BOTH name and room_type so a hotel with multiple room rows
      // (Deluxe Double for 2 pax vs Two-Bedroom for 4 pax) pins back to
      // the exact row, not just the first row whose name matches.
      if (lastRoomTypeForThisStay) {
        hotel = allHotels.find(h =>
          h.name.trim() === lastForThisStay &&
          (h.room_type || "").trim() === lastRoomTypeForThisStay,
        ) || null;
      }
      if (!hotel) hotel = allHotels.find(h => h.name.trim() === lastForThisStay) || null;
    }
    if (!hotel) {
      // On a plain swap (excluding the current hotel, no explicit occupancy
      // request), lock the new hotel to the SAME room capacity as the one being
      // replaced — so "غير فندق X" never silently jumps 2→4 persons. We read the
      // prior program's room occupancy for this slot; only applies when the
      // employee didn't explicitly override occupancy/feature.
      let lockOccupancyAdults: number | undefined = undefined;
      if (excludeForThisStay && excludeForThisStay.size > 0
          && overrideForThisStay == null && !featureForThisStay) {
        let prevHotel: HotelRow | null = null;
        if (lastForThisStay) {
          if (lastRoomTypeForThisStay) {
            prevHotel = allHotels.find(h =>
              h.name.trim() === lastForThisStay &&
              (h.room_type || "").trim() === lastRoomTypeForThisStay) || null;
          }
          if (!prevHotel) prevHotel = allHotels.find(h => h.name.trim() === lastForThisStay) || null;
        }
        const occ = prevHotel ? extractAdultsCount(prevHotel.occupancy || "") : 0;
        if (occ > 0) lockOccupancyAdults = occ;
      }
      hotel = pickCheapestHotel(allHotels, stay.city, request, cityPattern, {
        excludeNames: excludeForThisStay,
        overrideAdults: overrideForThisStay,
        overrideStars: overrideStarsForThisStay,
        areaFilter: areaForThisStay || stay.area,
        feature: featureForThisStay,
        lockOccupancyAdults,
      });
    }
    if (!hotel) {
      // Feature request (مسبح/فيلا) with no match in the same area → tell the
      // employee plainly instead of silently jumping to another area/room.
      if (featureForThisStay) {
        const featAr = featureForThisStay === "pool" ? "مسبح خاص"
          : featureForThisStay === "villa" ? "فيلا خاصة" : "سويت";
        const where = areaForThisStay || cityArabicNames[stay.city] || stay.city;
        return { ok: false, chatMessage: `ما فيه فندق فيه ${featAr} في ${where} يتسع لـ ${request.adults} أشخاص بالتاريخ المطلوب. جرّب مدينة/منطقة ثانية أو شيل شرط ${featAr}.` };
      }
      // Special case: explicit occupancy override that found no match. Don't
      // dress this up as a "no hotel for the group" diag — name the override.
      if (overrideForThisStay != null) {
        return { ok: false, chatMessage: `ما عندنا فندق يتسع لـ ${overrideForThisStay} أشخاص في ${cityArabicNames[stay.city] || stay.city}. اختر عدد مختلف أو شيل التحديد.` };
      }
      // Explicit star override with no match — most often because no hotel
      // at that rating exists for the trip's adult count or travel date.
      if (overrideStarsForThisStay != null) {
        const where = areaForThisStay || cityArabicNames[stay.city] || stay.city;
        return { ok: false, chatMessage: `ما عندنا فندق ${overrideStarsForThisStay} نجوم متاح في ${where} يتسع لـ ${request.adults} أشخاص بالتاريخ المطلوب. جرّب منطقة/مدينة ثانية أو غيّر التصنيف.` };
      }
      // Special case: the city had hotels but the modification's exclusion
      // set drained them. Distinguish from the generic "no match" so the
      // employee knows they've hit the bottom of the price ladder.
      if (excludeForThisStay && excludeForThisStay.size > 0) {
        const where = areaForThisStay || cityArabicNames[stay.city] || stay.city;
        const fallback = pickCheapestHotel(allHotels, stay.city, request, cityPattern, { areaFilter: areaForThisStay });
        if (fallback) {
          return { ok: false, chatMessage: `وصلت لآخر فندق متاح في ${where} لـ ${request.adults} أشخاص بنفس المعايير. ما عندنا خيار ثاني في نفس المنطقة.` };
        }
      }
      // Diagnose: what IS available in that city? Walk hotels matching just
      // the city (ignoring pax/stars/date) so the employee can see what's
      // close — and decide whether to adjust pax, change dates, or accept
      // a stars filter relaxation.
      const cityHotels = allHotels.filter(h => hotelCityMatches(h.location, stay.city, cityPattern));
      let diag = "";
      if (cityHotels.length === 0) {
        diag = `لا توجد أيّ فنادق في ${stay.city} في قاعدة البيانات.`;
      } else {
        // Available occupancies (sorted, distinct)
        const occs = [...new Set(cityHotels.map(h => extractAdultsCount(h.occupancy || "")).filter(n => n > 0))].sort((a, b) => a - b);
        const stars = [...new Set(cityHotels.map(h => h.stars).filter(s => s > 0))].sort();
        const total = cityHotels.length;
        const missingOccupancy = cityHotels.filter(h => extractAdultsCount(h.occupancy || "") === 0).length;
        // When every (or almost every) hotel in the city has no occupancy data,
        // that's a SHEET problem — the city has the rooms, the column is just
        // blank. Tell the employee to fix the sheet rather than blaming the
        // request.
        if (missingOccupancy >= total) {
          diag = `لكن كل الـ ${total} فندق في الشيت بدون قيمة في عمود occupancy (الإشغال). أضف عدد الأشخاص لكل صف في ${stay.city} ثم أعد المزامنة، عندها أقدر أبني البرنامج.`;
        } else if (occs.length === 0) {
          diag = `لكن قيم الإشغال في الشيت غير قابلة للقراءة لكل الـ ${total} فندق. راجع عمود occupancy في صفحة ${stay.city}.`;
        } else {
          diag = `يوجد ${total} فندق في ${stay.city}، لكن الإشغال المتاح فقط: ${occs.join("/")} أشخاص (نجوم: ${stars.join("/")}). الموظف طلب ${request.adults} أشخاص.`;
        }
      }
      return { ok: false, chatMessage: `ما عندنا فندق يطابق المعايير في ${stay.city} لـ ${request.adults} أشخاص. ${diag}` };
    }
    // Record the swap event if this stay was a hotel-mod target. fromName
    // is the hotel that was in the LAST program for THIS stay position
    // (so a "Hanoi → Sapa → Hanoi" trip can swap just one of the Hanoi
    // hotels and the ack names the right one).
    if (excludeForThisStay && excludeForThisStay.size > 0) {
      const fromName = hotelHistoryByCity?.[stay.city]?.[stayIdx]?.last || null;
      const totalStaysOfCity = stayOrder.filter(s => s.city === stay.city).length;
      appliedHotelSwaps.push({
        kind: "hotelSwap",
        city: stay.city,
        fromName,
        toName: hotel.name.trim(),
        stayLabel: totalStaysOfCity > 1
          ? (stayIdx === 0 ? "الأول" : stayIdx === totalStaysOfCity - 1 ? "الأخير" : `رقم ${stayIdx + 1}`)
          : null,
        targetOccupancy: overrideForThisStay ?? null,
        targetStars: overrideStarsForThisStay ?? null,
      });
    }
    // Detect occupancy upsize so we can tell the employee in CHAT. Only
    // emit once per city even if multiple stays of the same city all upsize.
    // Skip when the override fired — the employee already specified the size.
    const picked = extractAdultsCount(hotel.occupancy || "");
    const reqAdults = request.adults || 2;
    const cityAr = cityArabicNames[stay.city] || stay.city;
    if (overrideForThisStay == null && picked > 0
        && !occupancyUpsizeNotes.some(n => n.includes(stay.city))) {
      if (picked > reqAdults) {
        // كملاذ أخير: ما فيه غرفة ≤ العدد، اخترنا أكبر منه (تكفي المجموعة).
        occupancyUpsizeNotes.push(
          `ما لقينا فندق بإشغال ${reqAdults} أشخاص في ${cityAr}، اخترنا غرفة لـ ${picked} أشخاص (تكفي للمجموعة).`,
        );
      } else if (picked < reqAdults) {
        // التقريب لأسفل: الغرفة أصغر من المجموعة — نبّه الموظف.
        occupancyUpsizeNotes.push(
          `غرفة ${cityAr} تتسع ${picked} أشخاص للمجموعة (${reqAdults}) — أضف سرير إضافي أو غيّر الغرفة لو تبغى سعة أكبر.`,
        );
      }
    }
    // Pull this stay's days out of the days[] array (next N days)
    const stayDays = days.slice(consumedDays, consumedDays + stay.nights);
    consumedDays += stay.nights;
    if (stayDays.length === 0) continue;
    const rangeFrom = stayDays[0].date;
    const rangeTo = addDays(stayDays[stayDays.length - 1].date, 1);
    hotelsList.push({ city: stay.city, hotel, nights: stay.nights, rangeFrom, rangeTo });
  }

  // 2. Resolve follow-up tour modifications (remove / swap) against the
  //    catalog BEFORE picking tours, so the per-city loop can honor them.
  //    Any unresolvable modification (tour not found, city mismatch) aborts
  //    the build with a clear CHAT message — better than silently building
  //    the wrong program.
  type CityMod = {
    pinnedTours: TourRow[];
    excludeNames: Set<string>;
    freeDayCount: number;
  };
  const perCityMods = new Map<string, CityMod>();
  const appliedModifications: AppliedModification[] = [];
  const ensureCityMod = (city: string): CityMod => {
    let m = perCityMods.get(city);
    if (!m) { m = { pinnedTours: [], excludeNames: new Set(), freeDayCount: 0 }; perCityMods.set(city, m); }
    return m;
  };
  // Resolve a free-text city hint ("لانكاوي") to a canonical city in the trip.
  const resolveCityHint = (hint: string): string | null => {
    for (const def of cityDefs) {
      if (def.pattern.test(hint) && request.cities.includes(def.canonical)) return def.canonical;
    }
    return null;
  };

  // Look up the city whose stay covers the given day number. Returns null if
  // the day isn't a stay (arrival/transit/departure) or is out of range.
  const cityForDay = (dayNum: number | null | undefined): string | null => {
    if (!dayNum || dayNum < 1 || dayNum > days.length) return null;
    const d = days[dayNum - 1];
    return d.type === "stay" ? d.city : null;
  };

  // Day-specific overrides — when the employee says "غير اليوم 4 الى جولة X"
  // or "غير يوم حر في اليوم 4 الى جولة X", the assignment must put X on
  // day 4 exactly. Track them here and apply AFTER the regular auto-pick so
  // the override replaces whichever auto tour would've landed on that day.
  // A value of `null` means "make this day a free day" (remove the tour).
  const dayOverrides = new Map<number, TourRow | null>();

  for (const mod of request.tourModifications) {
    if (mod.kind === "add") {
      // Find the city: prefer the explicit day number, then the hint, then
      // fall back to the tour's own city tag. Adding "في اليوم 4" pins the
      // resolution to whichever city the trip is staying in on day 4.
      const dayCity = cityForDay(mod.dayNumber);
      const hintCity = dayCity || (mod.cityHint ? resolveCityHint(mod.cityHint) : null);
      const tour = findTourByKeywords(
        mod.name,
        allTours,
        hintCity ? { cityDefs, canonicalCity: hintCity } : undefined,
      );
      if (!tour) {
        const where = hintCity ? ` في مدينة ${hintCity}` : "";
        return { ok: false, chatMessage: `ما لقيت جولة "${mod.name}"${where}. تأكد من الاسم.` };
      }
      const city = hintCity || getTourCity(tour, cityDefs);
      if (!city || !request.cities.includes(city)) {
        return { ok: false, chatMessage: `الجولة "${tour.name.trim()}" مو في مدينة ضمن البرنامج.` };
      }
      const cm = ensureCityMod(city);
      // The "add" intent comes from "غير يوم الحر بجولة Y" — exclude any
      // "يوم حر" placeholder tour in the same city so the new tour actually
      // takes its slot rather than just being added on top.
      const yomHorTour = allTours.find(t =>
        isFreeDayName(t.name)
        && tourBelongsToCity(t, cityDefs, city),
      );
      if (yomHorTour) cm.excludeNames.add(yomHorTour.name.trim().toLowerCase());
      cm.pinnedTours.push(tour);
      // Day-specific add: also queue an override so the tour lands on the
      // chosen day. Without this, the tour just gets added to the pool and
      // the order-based assignment may put it on a different day.
      if (mod.dayNumber) dayOverrides.set(mod.dayNumber, tour);
      appliedModifications.push({ kind: "add", tourName: tour.name.trim(), city });
      continue;
    }

    // Remove-by-day with no tour name ("غير اليوم 4 الى يوم حر") — convert
    // to a freeDay on that day's city. Without a name we can't go through
    // the standard from-tour lookup below.
    if (mod.kind === "remove" && (!mod.name || !mod.name.trim()) && mod.dayNumber) {
      const dayCity = cityForDay(mod.dayNumber);
      if (!dayCity) {
        return { ok: false, chatMessage: `اليوم ${mod.dayNumber} مو يوم إقامة في البرنامج.` };
      }
      // Force the specific day to be a free day. We don't bump freeDayCount
      // here because that would compound with any existing deficit; the
      // post-pick override below replaces whatever was auto-assigned to
      // that day with the "يوم حر" placeholder.
      dayOverrides.set(mod.dayNumber, null);
      appliedModifications.push({ kind: "remove", tourName: `(اليوم ${mod.dayNumber})`, city: dayCity });
      continue;
    }

    const fromQuery = mod.kind === "swap" ? mod.from : mod.name;
    const fromTour = findTourByKeywords(fromQuery, allTours);
    if (!fromTour) {
      return { ok: false, chatMessage: `ما لقيت جولة باسم "${fromQuery}" في النظام. تأكد من الاسم أو راجع الشيت.` };
    }
    const fromCity = getTourCity(fromTour, cityDefs);
    if (!fromCity) {
      return { ok: false, chatMessage: `الجولة "${fromTour.name.trim()}" مو مربوطة بمدينة معروفة في وجهة ${request.destination}.` };
    }
    if (!request.cities.includes(fromCity)) {
      return { ok: false, chatMessage: `الجولة "${fromTour.name.trim()}" في ${fromCity}، لكن ${fromCity} مو ضمن البرنامج. ما يصير نحذف جولة من مدينة مو في البرنامج.` };
    }
    const cm = ensureCityMod(fromCity);
    cm.excludeNames.add(fromTour.name.trim().toLowerCase());

    if (mod.kind === "remove") {
      cm.freeDayCount += 1;
      appliedModifications.push({ kind: "remove", tourName: fromTour.name.trim(), city: fromCity });
    } else {
      // Swap target "أخرى/اخرى/ثانية/بديلة" is a placeholder for "pick any
      // other unused tour from this city" — don't treat it as a literal
      // tour name. Find the cheapest tour in the city that's not the
      // source AND not already in any other applied mod for this city.
      const isAnyAlternative = /^(?:[أا]خر[ىي][هة]?|ثاني[هة]?|بديل[هة]?|اي\s*جول[هة]?|أي\s*جول[هة]?|other|another|any)$/iu
        .test((mod.to || "").trim());
      let toTour: TourRow | null = null;
      if (isAnyAlternative) {
        const excludeForPick = new Set<string>(cm.excludeNames);
        for (const p of cm.pinnedTours) excludeForPick.add(p.name.trim().toLowerCase());
        // Also exclude every tour currently in the previous program. Without
        // this, "اخرى" can pick a tour that's already on a non-modded day —
        // the builder pins it to the swap day, leaving the original day to
        // be auto-filled with whatever's cheapest. Net result: a non-modded
        // day gets clobbered and the employee sees the swap "undo" itself.
        if (previouslyScheduledTourNames) {
          for (const n of previouslyScheduledTourNames) excludeForPick.add(n.toLowerCase());
        }
        const candidates = allTours.filter(t =>
          !isTransferTour(t.name) &&
          tourBelongsToCity(t, cityDefs, fromCity) &&
          !excludeForPick.has(t.name.trim().toLowerCase()) &&
          !isFreeDayName(t.name),
        );
        candidates.sort((a, b) =>
          pickTourVariantPrice(a, request.adults || 2, false) -
          pickTourVariantPrice(b, request.adults || 2, false),
        );
        toTour = candidates[0] || null;
        if (!toTour) {
          return { ok: false, chatMessage: `ما عندنا جولة بديلة متاحة في ${cityArabicNames[fromCity] || fromCity}. كل الجولات مستخدمة.` };
        }
      } else {
        toTour = findTourByKeywords(mod.to, allTours, { cityDefs, canonicalCity: fromCity });
      }
      if (!toTour) {
        return { ok: false, chatMessage: `ما لقيت جولة "${mod.to}" في مدينة ${fromCity}. اختر بديل من جولات هالمدينة فقط، أو اكتب "غيّر جولة X الى جولة أخرى" لاختيار بديل تلقائياً.` };
      }
      cm.pinnedTours.push(toTour);
      // Anchor the replacement to the same day the original tour was on,
      // when index.ts was able to look it up from the previous program.
      // Without this, two consecutive swaps on different days both land on
      // the first cheapest stay slot and only the latest one is visible.
      if (mod.dayNumber) dayOverrides.set(mod.dayNumber, toTour);
      appliedModifications.push({ kind: "swap", fromName: fromTour.name.trim(), toName: toTour.name.trim(), city: fromCity });
    }
    // Same treatment for remove-by-name: if we resolved a dayNumber from the
    // previous program, make THAT day the free day rather than letting the
    // freeDayCount push out whatever auto-pick happened to land last.
    if (mod.kind === "remove" && mod.dayNumber) {
      dayOverrides.set(mod.dayNumber, null);
    }
  }

  // 3. Pick tours for each city's stay days. STAY days only —
  // never on arrival, transit, or departure days (per business rule).
  const selectedTours: SelectedTour[] = [];
  const tourMessages: string[] = [];
  const usedCities = new Set<string>();
  for (const city of request.cities) {
    if (usedCities.has(city)) continue; // dedup repeated cities (e.g. Hanoi at start and end)
    usedCities.add(city);
    // Only pure "stay" days qualify for tours. Arrival/transit/departure are excluded.
    const cityStayDays = days.filter(d => d.city === city && d.type === "stay");
    const stayDayNumbers = cityStayDays.map(d => d.number);
    if (stayDayNumbers.length === 0) continue;
    const cityMod = perCityMods.get(city);
    const { selected, available, deficit } = pickToursForCity(
      allTours, cityDefs, city, stayDayNumbers.length, request.adults || 2,
      cityMod ? {
        pinnedTours: cityMod.pinnedTours,
        excludeNames: cityMod.excludeNames,
        freeDayCount: cityMod.freeDayCount,
      } : undefined,
    );
    // Day-specific overrides win over the order-based auto pick. Two-pass
    // assignment so an override on a later day still consumes its tour
    // FROM the pool — otherwise the same tour was being added twice (once
    // by the auto loop reaching it first, then again by the override).
    //
    // Re-sort the auto pool so "يوم حر" tours fall to the END of the city's
    // stay days (employee rule: free day must be the LAST day in a city,
    // never the arrival day). pickToursForCity sorts purely by price, so
    // a zero-priced "يوم حر للاستجمام" beats a paid sightseeing tour for
    // the first slot — flipping the order here makes paying tours go first.
    const isFreeRow = (n: string) => isFreeDayName(n);
    const autoPool = [...selected].sort((a, b) => {
      const af = isFreeRow(a.name) ? 1 : 0;
      const bf = isFreeRow(b.name) ? 1 : 0;
      if (af !== bf) return af - bf;
      return 0;
    });
    // Pass 1: reserve each pinned-day from autoPool so it can't be re-used.
    for (const dayNum of stayDayNumbers) {
      if (!dayOverrides.has(dayNum)) continue;
      const override = dayOverrides.get(dayNum);
      if (!override) continue;
      const idx = autoPool.findIndex(t => t.name === override.name);
      if (idx >= 0) autoPool.splice(idx, 1);
    }
    // Pass 2: assign in day order. Override-days get their pinned tour;
    // override=null days stay empty (free); other days consume autoPool.
    for (const dayNum of stayDayNumbers) {
      if (dayOverrides.has(dayNum)) {
        const override = dayOverrides.get(dayNum);
        if (override) selectedTours.push({ day: dayNum, city, tour: override });
        // null → leave the day empty (free day)
      } else if (autoPool.length > 0) {
        selectedTours.push({ day: dayNum, city, tour: autoPool.shift()! });
      }
    }
    if (deficit > 0) {
      const list = selected.map((t, i) => `  ${i + 1}. ${t.name.trim()}`).join("\n");
      tourMessages.push(
        `في مدينة ${cityArabicNames[city] || city} عندنا ${available} جولة فقط:\n${list}\nلكن إقامتك ${stayDayNumbers.length} ليالي. يوجد ${deficit} يوم/أيام بدون جولة.`
      );
    }
  }

  // 3. FLIGHTS — for each transit day, find a flight to attach.
  //    Strategy:
  //      a) Direct flight from→to exists → use it.
  //      b) Otherwise, use the destination's preferred hub (geographic gateway,
  //         not just the city with most flights — Da Nang has more flights
  //         than Hanoi but Hanoi is the actual gateway to Halong/Sapa).
  //      c) If fromCity is road-only (no flights), use hub → toCity.
  //      d) If toCity is road-only, use fromCity → hub.
  //      e) If both have flights but no direct route, try a 2-leg via hub.
  const selectedFlights: SelectedFlight[] = [];
  const flightCities = new Set<string>();
  for (const f of allFlights) {
    flightCities.add(f.from_city.toLowerCase());
    flightCities.add(f.to_city.toLowerCase());
  }
  // Hardcoded geographic hub per destination — the city most travellers transit
  // through to reach road-only destinations (Halong/Sapa for Vietnam, etc.).
  const PREFERRED_HUB: Record<string, string> = {
    vietnam: "Ha Noi",
    Malaysia: "Kuala Lumpur",
    thailand: "Bangkok",
    Turky: "Istanbul",
    russia: "Moscow",
    indonesia: "Jakarta",
    Bosnia: "Sarajevo",
  };
  const mainHub = PREFERRED_HUB[request.destination!] || "";
  // Strict check: a city "has flights" only if its full normalized name
  // matches an entry in flightCities (handles "Ha Noi" ≈ "ha noi (han)"
  // but rejects loose-prefix false positives like "Ha Long" ≈ "ha noi").
  const normCity = (s: string) => s.toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[\(\)\.\-_,]/g, " ")
    .replace(/\s+/g, " ").trim();
  const cityHasFlights = (city: string): boolean => {
    const target = normCity(city);
    const targetWords = target.split(" ").filter(Boolean);
    if (targetWords.length === 0) return false;
    for (const fc of flightCities) {
      const fcNorm = normCity(fc);
      // All words of target must appear as substrings in flight city name
      if (targetWords.every(w => fcNorm.includes(w))) return true;
    }
    return false;
  };
  for (const d of days) {
    if (request.transportOnly) break; // transport-only: skip flight picking
    if (d.type !== "transit" || !d.fromCity || !d.toCity) continue;
    // Intra-city transit (Bali Kuta → Bali Seminyak): same canonical city,
    // no flight/train needed even if a bogus "Bali → Bali" row exists.
    if (d.fromCity === d.toCity) continue;
    // Trains take precedence when a direct one exists for this city pair
    // (Russia: Moscow ↔ Saint Petersburg by Sapsan; cheaper + faster than
    // a flight). Only direct trains — no train hubbing.
    const train = findFlight(allTrains, d.fromCity, d.toCity);
    if (train) {
      selectedFlights.push({ day: d.number, flight: train, kind: "train" });
      continue;
    }
    const direct = findFlight(allFlights, d.fromCity, d.toCity);
    if (direct) {
      selectedFlights.push({ day: d.number, flight: direct });
      continue;
    }
    // Reverse-direction flight fallback: a route is bidirectional at the same
    // fare, but the sheet often carries only one direction. Use the opposite
    // row's price and SWAP its endpoints so the leg flies the right way (e.g.
    // only "Phu Quoc → Ho Chi Minh" exists, but the trip needs HCM → Phu Quoc).
    const reverseFlight = findFlight(allFlights, d.toCity, d.fromCity);
    if (reverseFlight) {
      selectedFlights.push({
        day: d.number,
        flight: { ...reverseFlight, from_city: reverseFlight.to_city, to_city: reverseFlight.from_city },
      });
      continue;
    }
    const fromHasFlights = cityHasFlights(d.fromCity);
    const toHasFlights = cityHasFlights(d.toCity);
    // Case (c): fromCity is road-only → use hub→toCity flight
    if (!fromHasFlights && toHasFlights && mainHub) {
      const f = findFlight(allFlights, mainHub, d.toCity);
      if (f) { selectedFlights.push({ day: d.number, flight: f }); continue; }
    }
    // Case (d): toCity is road-only → use fromCity→hub flight
    if (fromHasFlights && !toHasFlights && mainHub) {
      const f = findFlight(allFlights, d.fromCity, mainHub);
      if (f) { selectedFlights.push({ day: d.number, flight: f }); continue; }
    }
    // Case (e): both cities have flights but no DIRECT route between them.
    // We deliberately do NOT invent a multi-hop "via hub" flight here — that
    // produced wrong routes through cities not in the trip (e.g. Ho Chi Minh →
    // Ha Noi → Nha Trang) and even backtracked through a LATER stop (Nha Trang
    // → Phu Quoc → Dalat). Leave the leg without a flight: the transfer loop
    // adds a ground/car ride when the sheet has a road row in EITHER direction,
    // and otherwise the employee sees the gap and adds the missing direct
    // flight to the sheet — far safer than fabricating a nonsense route.
  }

  // 4. Pick ground transfers (now passing cityDefs for strict matching).
  // Use the actual stay order (not the deduped city list) so the last stay's
  // city — not last unique — gets the departure drop. For a Moscow → StP →
  // Moscow trip, the employee leaves from Moscow, not StP.
  const selectedTransfers: SelectedTransfer[] = [];
  const firstCity = stayOrder.length > 0 ? stayOrder[0].city : request.cities[0];
  const lastCity = stayOrder.length > 0 ? stayOrder[stayOrder.length - 1].city : request.cities[request.cities.length - 1];
  const dest = request.destination!;
  // Day 1 = international arrival → always airport pickup.
  const arrPickup = findArrivalPickup(allTours, firstCity, dest, cityDefs, "airport", request.transport);
  if (arrPickup) selectedTransfers.push({ day: 1, row: arrPickup, kind: "Pickup" });
  // Inter-city transit days. The pickup type for the destination city
  // depends on HOW the group arrives — by train (qatar) or by flight.
  // Look up whether this transit is a train (in selectedFlights with
  // kind="train") so the matching pickup row gets selected.
  const transitKind = (dayNum: number): "airport" | "train" => {
    const sf = selectedFlights.find(f => f.day === dayNum);
    return sf?.kind === "train" ? "train" : "airport";
  };
  for (const d of days) {
    if (d.type === "transit" && d.fromCity && d.toCity) {
      // Intra-city transit (Bali Kuta → Bali Seminyak): no airport drop, no
      // pickup, no flight. The employee organizes the area-to-area ride on
      // their own; the sheet usually doesn't model these moves at all.
      if (d.fromCity === d.toCity) continue;
      const arrivalType = transitKind(d.number);
      const hasFlightThisLeg = selectedFlights.some(f => f.day === d.number);
      let fromAirportDrop = findInterCityTransfer(allTours, d.fromCity, d.toCity, dest, cityDefs, arrivalType, request.transport);
      // A road leg (no flight) must NOT use an airport-drop row — the customer
      // isn't flying, so "go from the hotel to the airport" is bogus. Drop any
      // airport-only match so the road fallbacks below (forward road row, then
      // reverse-direction synthesized car) take over instead.
      if (!hasFlightThisLeg && fromAirportDrop && /مطار|airport/iu.test(fromAirportDrop.name)) {
        fromAirportDrop = null;
      }
      // Hub-departure case: fromCity is road-only and the flight on this day
      // departs from the destination's preferred hub. The customer needs a
      // road segment from fromCity → hub BEFORE the flight, but the direct
      // findInterCityTransfer(fromCity, toCity) returns nothing because the
      // sheet has no fromCity-to-toCity row. Retry with the hub as the
      // logical destination — that surfaces e.g. a "Sapa → Hanoi" row when
      // the flight is Hanoi → Phu Quoc.
      if (!fromAirportDrop && mainHub) {
        const sfDay = selectedFlights.find(f => f.day === d.number);
        const fc = sfDay ? normCity(sfDay.flight.from_city) : "";
        const hub = normCity(mainHub);
        // 'Ha Noi (HAN)' normalises to 'ha noi han' — substring either way
        // covers the airport-code suffix without per-word strictness.
        const flightFromHub = !!sfDay
          && (fc.includes(hub) || hub.includes(fc))
          && normCity(d.fromCity) !== hub;
        if (flightFromHub) {
          fromAirportDrop = findInterCityTransfer(allTours, d.fromCity, mainHub, dest, cityDefs, arrivalType, request.transport);
        }
      }
      // Reverse-direction road fallback: when this leg has no flight and no
      // forward road row, but the sheet carries the OPPOSITE direction (e.g.
      // only "Dalat → Nha Trang بسيارة" for a Nha Trang → Dalat leg), reuse
      // that row's price but emit a correctly-worded forward line so the
      // customer sees "from → to", not the reverse. Without this the short
      // road hop would silently disappear from the program.
      if (!fromAirportDrop && arrivalType === "airport"
          && !selectedFlights.some(f => f.day === d.number)) {
        const rev = findInterCityTransfer(allTours, d.toCity, d.fromCity, dest, cityDefs, "airport", request.transport);
        if (rev && !/مطار|airport/iu.test(rev.name)) {
          const fromAr = cityArabicNames[d.fromCity] || d.fromCity;
          const toAr = cityArabicNames[d.toCity] || d.toCity;
          fromAirportDrop = { ...rev, name: `التوجه من ${fromAr} إلى ${toAr} بسيارة خاصة` };
        }
      }
      if (fromAirportDrop) selectedTransfers.push({ day: d.number, row: fromAirportDrop, kind: "Drop" });
      // Only add an airport pickup when this transit is actually a flight
      // (or train). Road transits like Sapa → Hanoi use a single door-to-
      // door car ride; the Drop row above covers the entire journey so an
      // additional "استقبال في مطار هانوي" line is bogus — the customer
      // never went through an airport.
      const flightForDay = selectedFlights.find(f => f.day === d.number);
      if (flightForDay) {
        // Hub-flight case: flight lands at the destination's preferred hub
        // (e.g. Hanoi) but the stay is in a road-only city (HaLong). The
        // airport pickup at the hub doesn't deliver them to HaLong — so
        // append the road segment from hub → toCity instead. Without it,
        // the program shows the customer landing at Hanoi airport with no
        // way of getting to HaLong.
        const normCityKey = (s: string) => s.toLowerCase().normalize("NFD")
          .replace(/\p{M}/gu, "").replace(/[\(\)\.\-_,]/g, " ")
          .replace(/\s+/g, " ").trim();
        const flightLandsAtHub =
          mainHub &&
          normCityKey(flightForDay.flight.to_city).includes(normCityKey(mainHub)) &&
          normCityKey(d.toCity) !== normCityKey(mainHub);
        if (flightLandsAtHub) {
          const hubToCity = findInterCityTransfer(
            allTours, mainHub, d.toCity, dest, cityDefs, "airport", request.transport,
          );
          if (hubToCity) {
            selectedTransfers.push({ day: d.number, row: hubToCity, kind: "Pickup" });
          }
        } else {
          const arrPickupForCity = findArrivalPickup(allTours, d.toCity, dest, cityDefs, arrivalType, request.transport);
          if (arrPickupForCity) {
            selectedTransfers.push({ day: d.number, row: arrPickupForCity, kind: "Pickup" });
          }
        }
      }
    }
  }
  // Departure drop (last day) — uses the last STAY's city, not last unique
  const depDrop = findDepartureDrop(allTours, lastCity, dest, cityDefs, request.transport);
  if (depDrop) selectedTransfers.push({ day: days.length, row: depDrop, kind: "Drop" });

  // 5. Format
  const programData: ProgramData = {
    request,
    destinationName: DESTINATION_AR_NAMES[dest] || dest,
    days,
    hotels: hotelsList,
    flights: selectedFlights,
    tours: selectedTours,
    transfers: selectedTransfers,
    simCount: request.sim || 0,
    extraBedScope: request.extraBed.scope,
    cityArabicNames,
  };

  let program = formatProgram(programData);
  // Compose CHAT notes. Occupancy upsize comes first (more important — affects
  // pricing & client expectations); tour-deficit second; default if neither.
  const chatParts: string[] = [];
  if (occupancyUpsizeNotes.length > 0) chatParts.push(occupancyUpsizeNotes.join(" "));
  if (tourMessages.length > 0) {
    chatParts.push(`${tourMessages.join(" | ")} حابب تكرّر جولة معيّنة؟ بلّغني الرقم.`);
  }
  if (chatParts.length > 0) {
    program = program.replace(/^CHAT:.*$/m, `CHAT:${chatParts.join(" ")}`);
  }
  return { ok: true, program, appliedModifications: [...appliedHotelSwaps, ...appliedModifications] };
}

function cityMatchesFlight(canonicalCity: string, flightCity: string): boolean {
  const norm = (s: string) => String(s || "").toLowerCase().replace(/[\s\.\-_]/g, "");
  return norm(flightCity).includes(norm(canonicalCity).split(" ")[0])
      || norm(canonicalCity).includes(norm(flightCity).split(" ")[0]);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers exported for test scripts
// ─────────────────────────────────────────────────────────────────────────

export const __selectors_internal__ = {
  extractAdultsCount,
  cityFromLocation,
  destFromLocation,
  parseAnyDate,
  monthNumber,
};

