// TBO hotel rate scraper — paste into DevTools / javascript_tool on any hotels.tboholidays.com page
// (logged in). Uses a hidden same-origin iframe + deep link with a fresh sessionId (works without UI clicks).
// See "اسعار الفنادق.md" for the business rules (MYR, average nightly, breakfast/pax matching, purple = Booking).

window.tboRoomsUrl = function (H, name, ci, co, pax) {
  const p = new URLSearchParams({ H: String(H), sessionId: crypto.randomUUID(), DisplayData: name, RoomDisplayData: name, HN: name,
    C: '127891' /* Makkah */, SearchType: '2', SearchedHotelCode: String(H), CheckIn: ci, CheckOut: co, Sources: '', NoOfRooms: '1',
    PaxDetails: pax + '-0', ChildAges: 'null', Nationality: 'MY', CountryCode: 'SA', AgentMarkup: '0', AffiliateCommissionPercentage: '0',
    TripName: '', TripRef: '', AgencyCountryCode: 'MY', Language: 'en-US', time: String(Date.now()), idrp: '1', viewRoomClickTime: String(Date.now()) });
  return '/hotels/en-US/rooms?' + p;
};

// Load rooms page in hidden iframe, expand all "Show N More Options"/"Load More Options". Returns {f, D} or {err}.
window.tboLoad = async function (H, name, ci, co, pax) {
  const sl = ms => new Promise(r => setTimeout(r, ms));
  const f = document.createElement('iframe');
  f.style.cssText = 'width:1400px;height:1000px;position:fixed;left:-3000px;top:0';
  f.src = tboRoomsUrl(H, name, ci, co, pax); document.body.appendChild(f);
  let ok = false, t = '';
  for (let i = 0; i < 70; i++) { await sl(1000); t = f.contentDocument?.body?.innerText || '';
    if (/Choose Your Rate Plan/.test(t) && /MYR/.test(t)) { ok = true; break; } }
  if (!ok) { f.remove(); return { err: 'noload', snip: t.slice(-300) }; }
  await sl(1500); const D = f.contentDocument;
  for (let r = 0; r < 40; r++) {
    const b = [...D.querySelectorAll('button,span')].filter(e => e.children.length == 0 && /^(Load More Options|Show \d+ More Options)$/.test((e.innerText || '').trim()));
    if (!b.length) break; b.forEach(e => e.click()); await sl(1200);
  }
  return { f, D };
};

// Parse rate list: [{name, meal, ref, p}] — p = TOTAL MYR for the stay.
window.tboParseDoc = function (D) {
  const t = D.body.innerText; const i = t.indexOf('Choose Your Rate Plan');
  const L = t.slice(i).split('\n').map(s => s.trim()).filter(Boolean);
  const M = /^(Room Only|Bed And Breakfast|Breakfast|Half Board|Full Board|All Inclusive|Breakfast For \d+.*|Breakfast and dinner.*)$/i;
  const out = [];
  for (let k = 0; k < L.length; k++) if (M.test(L[k])) {
    const name = L[k - 1]; let p = null, ref = '';
    for (let j = k + 1; j < k + 8 && j < L.length; j++) {
      if (/Refundable|Free Cancellation/i.test(L[j])) ref = L[j];
      const m = L[j].match(/^MYR ([\d,\.]+)/); if (m) { p = parseFloat(m[1].replace(/,/g, '')); break; }
    }
    if (p) out.push({ name, meal: L[k], ref, p });
  }
  return out;
};

// ---- Sheet-row → TBO room matching (Makkah tab rows 7–28, decided 2026-11-06) ----
// inc = room name must match, exc = must not match. Meal: Breakfast unless meal:'RO' (sheet says NO Breakfast).
// Cheapest matching rate wins. Half/Full board ignored.
const A = 5015566, AN = 'Address Jabal Omar Makkah', NOT = /haram|kaaba|premier|executive|suite/i;
window.ROWS = [
  { r: 7, H: A, n: AN, pax: 2, inc: /classic.*partial haram/i, exc: /premier/i },
  { r: 8, H: A, n: AN, pax: 2, inc: /deluxe.*partial haram/i, exc: /premier/i },
  { r: 9, H: A, n: AN, pax: 2, inc: /standard room/i, exc: NOT },
  { r: 10, H: A, n: AN, pax: 3, inc: /standard room/i, exc: NOT },
  { r: 11, H: A, n: AN, pax: 4, inc: /deluxe/i, exc: NOT },
  { r: 12, H: 1626228, n: 'Hilton Hotel & Convention Jabal Omar Makkah', pax: 4, inc: /standard room/i, exc: NOT },
  { r: 13, H: 1366261, n: 'Makkah Clock Royal Tower, A Fairmont Hotel', pax: 4, inc: /triple.*city|fairmont.*city/i, exc: /haram|kaaba|suite/i },
  { r: 14, H: 1038230, n: 'Conrad Jabal Omar Makkah', pax: 4, inc: /superior/i, exc: NOT },
  { r: 15, H: 1379777, n: 'Jabal Omar Hyatt Regency Makkah', pax: 4, inc: /quadruple standard|standard.*quad|quad.*standard/i, exc: NOT, meal: 'RO' },
  { r: 16, H: 1558881, n: 'Swissôtel Al Maqam Makkah', pax: 4, inc: /classic.*quad/i, exc: NOT },
  { r: 17, H: 1254027, n: 'Al Shohada by Palm Rich Makkah', pax: 4, inc: /family|quad/i, exc: /haram|kaaba|suite/i },
  { r: 18, H: 1373529, n: 'Anjum Hotel Makkah', pax: 4, inc: /classic.*twin.*city/i, exc: NOT },
  { r: 19, H: 1373529, n: 'Anjum Hotel Makkah', pax: 3, inc: /classic.*twin.*city/i, exc: NOT },
  { r: 20, H: 1373529, n: 'Anjum Hotel Makkah', pax: 2, inc: /classic.*twin.*city/i, exc: NOT },
  { r: 21, H: 1254027, n: 'Al Shohada by Palm Rich Makkah', pax: 2, inc: /double/i, exc: NOT },
  { r: 22, H: 6094266, n: 'Voco Makkah', pax: 4, inc: /quad/i, exc: NOT },
  { r: 23, H: 1366261, n: 'Makkah Clock Royal Tower, A Fairmont Hotel', pax: 4, inc: /fairmont room|quad/i, exc: /haram|kaaba|suite|triple/i },
  { r: 24, H: 6094266, n: 'Voco Makkah', pax: 5, inc: /grand/i, exc: /suite/i },
  { r: 25, H: 5010318, n: 'Novotel Makkah Thakher City', pax: 5, inc: /family/i, exc: /suite/i },
  { r: 26, H: 6201697, n: 'Wirgan Al Noor, Tapestry Collection by Hilton', pax: 5, inc: /two bedroom family.*city/i, exc: /suite/i },
  { r: 27, H: 6094266, n: 'Voco Makkah', pax: 6, inc: /grand/i, exc: /suite/i },
  { r: 28, H: 1092888, n: 'Swissôtel Makkah', pax: 4, inc: /kaaba/i, exc: /suite/i },
];
window.pickRate = function (rates, row) {
  const wantRO = row.meal == 'RO';
  const c = rates.filter(x => { const nm = x.name.split(' | ')[0]; const ro = /Room Only/i.test(x.meal), hb = /Half|Full|dinner|All Incl/i.test(x.meal);
    if (hb) return false; if (wantRO ? !ro : ro) return false; return row.inc.test(nm) && !row.exc.test(nm); });
  c.sort((a, b) => a.p - b.p); return c[0] || null;
};
// Nightly breakup: click the button beside the chosen rate's price → "Nightly Rate Breakup" → first N MYR values = nights.
// (see tboNightly in session 2026-11-06; average = mean of nights, spread = max-min; >60 MYR → tell owner)

// ===== PREFERRED (2026-11-06): read rates straight from React props — includes nightly RateBreakUp =====
window.tboGet = async function (H, name, ci, co, pax) {
  const sl = ms => new Promise(r => setTimeout(r, ms)); const f = document.createElement('iframe');
  f.style.cssText = 'width:1200px;height:900px;position:fixed;left:-3000px;top:0'; f.src = tboRoomsUrl(H, name, ci, co, pax); document.body.appendChild(f);
  try {
    let hd = null, txt = '';
    for (let i = 0; i < 80; i++) { await sl(1000); const D = f.contentDocument; if (!D || !D.body) continue; txt = D.body.innerText.slice(-200);
      if (/no rooms|not available|sold out/i.test(txt) && i > 15 && !/MYR/.test(D.body.innerText)) return { none: 1, why: txt.slice(-100) };
      const el = [...D.querySelectorAll('span,div,p')].find(e => e.children.length == 0 && /^MYR [\d,]/.test(e.textContent.trim())); if (!el) continue;
      const k = Object.keys(el).find(k => k.startsWith('__reactFiber')); let fb = el[k];
      for (let j = 0; j < 60 && fb; j++) { const p = fb.memoizedProps || {}; if (p.hotelDetails && p.hotelDetails.RoomGroups) { hd = p.hotelDetails; break; } fb = fb.return; }
      if (hd) break; }
    if (!hd) return { err: 'noload', snip: txt };
    const all = hd.RoomGroups.flatMap(x => x.RoomCombinations || []), m = {};
    for (const c of all) { if (c.Rooms.length != 1) continue; const nv = (c.Rooms[0].RateBreakUp || []).map(x => +x.Total.toFixed(2));
      const key = c.RoomName + '|' + c.MealPlanText; if (!m[key] || m[key].p > c.TotalAmount) m[key] = { n: c.RoomName, meal: c.MealPlanText, p: +c.TotalAmount.toFixed(2), nv, cur: c.Currency }; }
    return { cnt: hd.CombinationCount, got: all.length, rates: Object.values(m) };
  } finally { f.remove(); }
};
// pick2(rates,row): same rules as pickRate but on {n, meal, p, nv}.
