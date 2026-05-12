// ─────────────────────────────────────────────────────────────────────────
// Local Builder — selects hotels/tours/flights/transfers from Postgres,
// arranges the day-by-day plan, and formats the final program text.
// Replaces Claude for standard build requests.
// ─────────────────────────────────────────────────────────────────────────

import type { CityDef, TripRequest } from "./local-parser.ts";

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
function hotelCityMatches(hotelLocation: string, canonicalCity: string): boolean {
  const norm = (s: string) => s
    .toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[\.\-_,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hotelCity = norm(cityFromLocation(hotelLocation));
  const target = norm(canonicalCity);
  if (!hotelCity || !target) return false;
  // Exact match
  if (hotelCity === target) return true;
  // No-space variant: "halong" === "ha long"
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
export function pickCheapestHotel(
  allHotels: HotelRow[],
  city: string,
  request: TripRequest,
): HotelRow | null {
  const adults = request.adults || 2;

  let candidates = allHotels.filter(h => {
    if (!hotelCityMatches(h.location, city)) return false;
    // Adults exact match
    const ac = extractAdultsCount(h.occupancy || "");
    if (ac !== adults) return false;
    // Stars filter (if specified)
    if (request.stars && request.stars.length > 0) {
      if (!request.stars.includes(h.stars)) return false;
    }
    // Date range filter (use startDate or first day of travel month)
    const dateForCheck = request.startDate
      || (request.year && request.month
          ? `${request.year}-${String(monthNumber(request.month)).padStart(2, "0")}-01`
          : null);
    if (!hotelCoversDate(h, dateForCheck)) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Sort: price ASC, then name ASC for deterministic tie-break
  candidates.sort((a, b) => {
    if (a.price_per_night !== b.price_per_night) return a.price_per_night - b.price_per_night;
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
 * Match a tour to a city using the same regex table as the parser.
 * Returns true if any of the city's patterns matches the tour name.
 */
function tourBelongsToCity(tour: TourRow, cityDefs: CityDef[], canonicalCity: string): boolean {
  const def = cityDefs.find(c => c.canonical === canonicalCity);
  if (!def) return false;
  return def.pattern.test(tour.name);
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
): { selected: TourRow[]; available: number; deficit: number } {
  // Filter: real tours (not transfer rows) belonging to this city
  const TRANSFER_PREFIXES = [
    "استقبال", "الاستقبال", "توديع", "التوديع",
    "التوجه", "توصيل", "توصیل", "يتم توصيل", "يتم توصیل",
    "العوده", "العودة", "العود",
    "الانتقال", "انتقال",
    "حضور السائق", "السائق",
    "ذهاب من", "الذهاب من", "للذهاب",
    "انتهاء", "انتهاء جوله", "انتهاء جولة",
  ];
  const isTransfer = (name: string) => {
    const n = (name || "").trim();
    return TRANSFER_PREFIXES.some(p => n.startsWith(p));
  };

  const cityTours = allTours.filter(t => !isTransfer(t.name) && tourBelongsToCity(t, cityDefs, canonicalCity));

  // Sort by the PAX-MATCHING variant price (cheapest first), then name.
  // Tours always private → isShared = false.
  cityTours.sort((a, b) => {
    const pa = pickTourVariantPrice(a, paxCount, false);
    const pb = pickTourVariantPrice(b, paxCount, false);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  const selected = cityTours.slice(0, nightsInCity);
  return {
    selected,
    available: cityTours.length,
    deficit: Math.max(0, nightsInCity - cityTours.length),
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
    const match = findFlight(allFlights, from, to);
    if (match) result.push(match);
  }
  return result;
}

function findFlight(flights: FlightRow[], from: string, to: string): FlightRow | null {
  const norm = (s: string) => String(s || "").toLowerCase().replace(/[\s\.\-_]/g, "");
  const f = norm(from);
  const t = norm(to);
  return flights.find(fl => {
    const ff = norm(fl.from_city);
    const tt = norm(fl.to_city);
    return (ff.includes(f.split(" ")[0]) || f.includes(ff.split(" ")[0]))
        && (tt.includes(t.split(" ")[0]) || t.includes(tt.split(" ")[0]));
  }) || null;
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
): TourRow | null {
  const candidates = allTours.filter(t => {
    if (t.type !== destination) return false;
    const n = t.name;
    if (!/استقبال|الاستقبال/.test(n)) return false;
    return tourNameMatchesCity(n, city, cityDefs);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.price - b.price);
  return candidates[0];
}

export function findDepartureDrop(
  allTours: TourRow[],
  city: string,
  destination: string,
  cityDefs: CityDef[],
): TourRow | null {
  const candidates = allTours.filter(t => {
    if (t.type !== destination) return false;
    const n = t.name;
    if (!/توديع|التوديع|التوجه.*المطار|للعوده|للعودة/.test(n)) return false;
    return tourNameMatchesCity(n, city, cityDefs);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.price - b.price);
  return candidates[0];
}

export function findInterCityTransfer(
  allTours: TourRow[],
  fromCity: string,
  toCity: string,
  destination: string,
  cityDefs: CityDef[],
): TourRow | null {
  const candidates = allTours.filter(tr => {
    if (tr.type !== destination) return false;
    const n = tr.name;
    const hasFrom = tourNameMatchesCity(n, fromCity, cityDefs);
    const hasTo = tourNameMatchesCity(n, toCity, cityDefs);
    return (hasFrom && hasTo);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.price - b.price);
  return candidates[0];
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
export type SelectedFlight = { day: number; flight: FlightRow };
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

function pickTourVariantPrice(tour: TourRow, paxCount: number, isShared: boolean): number {
  const variants = tour.variants || [];
  if (variants.length === 0) return tour.price || 0;
  // Find best matching variant by pax range
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
  const match = variants.find(v => labelMatches(v.label));
  if (match) return match.price;
  // Fallback: first variant
  return variants[0].price || tour.price || 0;
}

export function formatProgram(data: ProgramData): string {
  const { request, days, hotels, flights, tours, transfers, simCount, destinationName, cityArabicNames } = data;
  const adults = request.adults || 2;
  const totalDays = days.length;
  const totalNights = totalDays - 1;
  const monthLabel = request.month
    ? `${request.month}${request.year ? " " + request.year : ""}`
    : "";
  const startDate = days[0]?.date || resolveStartDate(request);
  const endDate = days[days.length - 1]?.date || startDate;

  let out = "";

  // ── DEST / META / DATES / CLIENT ────────────────────────────────────
  out += `DEST:${destinationName}\n`;
  out += `META:${totalDays} أيام | ${totalNights} ليالي | ${monthLabel} | ${adults} ${adults === 1 ? "شخص" : adults === 2 ? "شخص" : "أشخاص"}\n`;
  out += `DATE_FROM:${formatArabicDate(startDate)}\n`;
  out += `DATE_TO:${formatArabicDate(endDate)}\n`;
  out += `CLIENT:${adults === 2 ? "شخصان بالغان" : `${adults} بالغين`}\n`;
  out += `CLIENT_CODE:ALZ-2026-001\n\n`;

  // ── HOTELS ───────────────────────────────────────────────────────────
  out += "HOTELS:\n";
  for (const sh of hotels) {
    const meals = sh.hotel.meals
      ? `ما يشمل: ${sh.hotel.meals}`
      : (sh.hotel.includes_breakfast ? "إفطار مشمول" : "بدون وجبات");
    const cityAr = cityArabicNames[sh.city] || sh.city;
    out += `${sh.hotel.name} | ${cityAr} | ${sh.hotel.stars} نجوم | ${sh.hotel.room_type} | ${formatNumber(sh.hotel.price_per_night)} ريال/ليلة | ${sh.nights} ${sh.nights === 1 ? "ليلة" : "ليالي"} (من ${formatArabicDate(sh.rangeFrom)} إلى ${formatArabicDate(sh.rangeTo)}) | ${meals}\n`;
  }
  out += "\n";

  // ── FLIGHTS — only emit the section if there are actual flight rows.
  //    Empty FLIGHTS section is suppressed entirely so the PDF stays clean.
  let flightsTotal = 0;
  if (flights.length > 0) {
    out += "FLIGHTS:\n";
    for (const sf of flights) {
      const total = sf.flight.price_per_pax * adults;
      flightsTotal += total;
      out += `${sf.flight.from_city} - ${sf.flight.to_city} | داخلي | ${formatNumber(sf.flight.price_per_pax)} ريال/شخص | ${adults} ${adults === 2 ? "أشخاص" : "أشخاص"} | ${formatNumber(total)} ريال\n`;
    }
    out += "\n";
  }

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
    const price = pickTourVariantPrice(t.row, adults, isShared);
    transfersTotal += isShared ? price * adults : price;
    out += `اليوم ${t.day} | ${t.row.name.trim()} | ${t.kind} | ${formatNumber(isShared ? price * adults : price)} ريال\n`;
  }
  out += "\n";

  // ── TOURS (sorted by day for clean reading) ──────────────────────────
  out += "TOURS:\n";
  let toursTotal = 0;
  const sortedTours = [...tours].sort((a, b) => a.day - b.day);
  for (const tt of sortedTours) {
    const price = pickTourVariantPrice(tt.tour, adults, false); // tours always private
    toursTotal += price;
    const tourType = "ثقافية"; // default; sheet doesn't always specify
    out += `اليوم ${tt.day} | ${tt.tour.name.trim()} | ${tourType} | ${formatNumber(price)} ريال\n`;
  }
  out += "\n";

  // ── SUMMARY ──────────────────────────────────────────────────────────
  const hotelsTotal = hotels.reduce((s, sh) => s + sh.hotel.price_per_night * sh.nights, 0);
  const simTotal = simCount * 50;
  const grand = hotelsTotal + flightsTotal + transfersTotal + toursTotal + simTotal;

  out += "SUMMARY:\n";
  out += `الفنادق | ${formatNumber(hotelsTotal)} ريال\n`;
  if (flightsTotal > 0) out += `الطيران الداخلي | ${formatNumber(flightsTotal)} ريال\n`;
  if (transfersTotal > 0) out += `الانتقالات | ${formatNumber(transfersTotal)} ريال\n`;
  if (toursTotal > 0) out += `الجولات السياحية | ${formatNumber(toursTotal)} ريال\n`;
  if (simTotal > 0) out += `شرائح الاتصال | ${formatNumber(simTotal)} ريال\n`;
  out += `TOTAL_PER_PERSON:${formatNumber(grand / adults)}\n`;
  out += `TOTAL_GROUP:${formatNumber(grand)} | ${adults} ${adults === 2 ? "شخص" : "أشخاص"}\n\n`;

  out += `CHAT:برنامجك جاهز! إجمالي ${totalDays} أيام / ${totalNights} ليالي بمبلغ ${formatNumber(grand)} ريال للمجموعة.`;

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// PIPELINE — high-level builder that selects, arranges, formats
// ─────────────────────────────────────────────────────────────────────────

export type BuildResult =
  | { ok: true; program: string }
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
  fetchData: () => Promise<{ hotels: HotelRow[]; tours: TourRow[]; flights: FlightRow[] }>,
  cityArabicNames: Record<string, string>,
): Promise<BuildResult> {
  if (!canBuildLocally(request)) {
    return { ok: false, chatMessage: "البيانات ناقصة، لم أستطع البناء محلّياً." };
  }
  const { hotels: allHotels, tours: allTours, flights: allFlights } = await fetchData();

  // 1. Pick hotel for each STAY in order (handles repeated cities like
  //    "Hanoi at start, Sapa middle, Hanoi at end" → 2 separate Hanoi stays).
  const days = arrangeDays(request);
  const stayOrder = request.cityStaysOrdered && request.cityStaysOrdered.length > 0
    ? request.cityStaysOrdered.filter(s => s.nights > 0)
    : request.cities.map(c => ({ city: c, nights: request.nightsByCity[c] || 0 })).filter(s => s.nights > 0);
  const hotelsList: SelectedHotel[] = [];
  // Walk days in order, grouping consecutive same-city days into stays.
  let consumedDays = 0;
  for (const stay of stayOrder) {
    const hotel = pickCheapestHotel(allHotels, stay.city, request);
    if (!hotel) {
      return { ok: false, chatMessage: `ما عندنا فندق يطابق المعايير في ${stay.city} (Adults=${request.adults}، نجوم=${request.stars?.join("/")  || "أيّ"}).` };
    }
    // Pull this stay's days out of the days[] array (next N days)
    const stayDays = days.slice(consumedDays, consumedDays + stay.nights);
    consumedDays += stay.nights;
    if (stayDays.length === 0) continue;
    const rangeFrom = stayDays[0].date;
    const rangeTo = addDays(stayDays[stayDays.length - 1].date, 1);
    hotelsList.push({ city: stay.city, hotel, nights: stay.nights, rangeFrom, rangeTo });
  }

  // 2. Pick tours for each city's stay days. STAY days only —
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
    const { selected, available, deficit } = pickToursForCity(allTours, cityDefs, city, stayDayNumbers.length, request.adults || 2);
    selected.forEach((tour, i) => {
      selectedTours.push({ day: stayDayNumbers[i], city, tour });
    });
    if (deficit > 0) {
      const list = selected.map((t, i) => `  ${i + 1}. ${t.name.trim()}`).join("\n");
      tourMessages.push(
        `في مدينة ${cityArabicNames[city] || city} عندنا ${available} جولة فقط:\n${list}\nلكن إقامتك ${stayDayNumbers.length} ليالي. يوجد ${deficit} يوم/أيام بدون جولة.`
      );
    }
  }

  // 3. FLIGHTS — DISABLED per user request. Flights are always assumed to
  //    exist (booked separately by the client). Inter-city movement is
  //    handled exclusively via TRANSFERS rows below.
  const selectedFlights: SelectedFlight[] = [];

  // 4. Pick ground transfers (now passing cityDefs for strict matching)
  const selectedTransfers: SelectedTransfer[] = [];
  const firstCity = request.cities[0];
  const lastCity = request.cities[request.cities.length - 1];
  const dest = request.destination!;
  // Arrival pickup (Day 1)
  const arrPickup = findArrivalPickup(allTours, firstCity, dest, cityDefs);
  if (arrPickup) selectedTransfers.push({ day: 1, row: arrPickup, kind: "Pickup" });
  // Inter-city transfers + arrival pickups
  for (const d of days) {
    if (d.type === "transit" && d.fromCity && d.toCity) {
      const fromAirportDrop = findInterCityTransfer(allTours, d.fromCity, d.toCity, dest, cityDefs);
      if (fromAirportDrop) selectedTransfers.push({ day: d.number, row: fromAirportDrop, kind: "Drop" });
      const arrPickupForCity = findArrivalPickup(allTours, d.toCity, dest, cityDefs);
      if (arrPickupForCity && arrPickupForCity.id !== arrPickup?.id) {
        selectedTransfers.push({ day: d.number, row: arrPickupForCity, kind: "Pickup" });
      }
    }
  }
  // Departure drop (last day)
  const depDrop = findDepartureDrop(allTours, lastCity, dest, cityDefs);
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
  if (tourMessages.length > 0) {
    program = program.replace(/^CHAT:.*$/m,
      `CHAT:${tourMessages.join(" | ")} حابب تكرّر جولة معيّنة؟ بلّغني الرقم.`);
  }
  return { ok: true, program };
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

