// اختبارات انحدار طلال (Regression) — تعيد تشغيل محادثات حقيقية خربت قبل على كود
// الاستقبال (handleNewLeadIntake) محلياً: قاعدة بيانات وهمية بالذاكرة، والنموذج «مُبرمَج»
// يرد بالخطأ اللي سواه فعلاً، فنتأكد إن الحرّاس الخادمية تصحّحه. ❌ لا إنتاج ولا واتساب.
//
// التشغيل (من repo/):
//   npx -y deno@2.5.6 run -A supabase/functions/WhatsApp-Router/tests/intake_replay.ts
// قاعدة: أي غلطة جديدة تشتكي منها المالكة → سيناريو هنا قبل الإصلاح، ولا نشر إلا والكل ناجح.

import { SCENARIOS, type Scenario } from "./scenarios.ts";

const HERE = new URL(".", import.meta.url);
const SRC = Deno.env.get("REPLAY_SRC") ? new URL("file://" + Deno.env.get("REPLAY_SRC")) : new URL("../index.ts", HERE);
const TMP = new URL("../.index_under_test.ts", HERE);

// ── 1) نسخة قابلة للاستيراد من index.ts: بلا Deno.serve، ومع تصدير الدوال ──
let code = await Deno.readTextFile(SRC);
code = code.replace(/^Deno\.serve\(/m, "(globalThis as any).__noServe(");
code += "\nexport { handleNewLeadIntake, handleFollowupAI, handleMessage, extractDestination, fuzzyDestination, _programIssues, _varyPostMsg, isAffirmative, isYesish, sendPostProgramMessages, replyUnsupportedAttachment, handleVoiceNote };\n";
await Deno.writeTextFile(TMP, code);
(globalThis as any).__noServe = () => {};

// متغيرات بيئة وهمية (ليست أسراراً — قيم اختبار فقط)
Deno.env.set("ANTHROPIC_API_KEY", "test-key");
Deno.env.set("WHATSAPP_ACCESS_TOKEN", "test-token");
Deno.env.set("WHATSAPP_PHONE_NUMBER_ID", "test-id");
Deno.env.set("SUPABASE_URL", "http://fake.local");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
Deno.env.set("RESEND_API_KEY", "test");

// تسريع: تأخيرات «الكتابة» لا داعي لها بالاختبار
const _st = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, _ms?: number, ...a: unknown[]) => _st(fn, 0, ...a);
// waitUntil → ننتظره قبل التقييم
const _bg: Promise<unknown>[] = [];
(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { _bg.push(p.catch(() => {})); } };

// ── 2) قاعدة بيانات وهمية بالذاكرة (تدعم ما يستعمله الاستقبال) ──
type RowT = Record<string, any>;
let DB: Record<string, RowT[]> = {};
function q(table: string) {
  const filters: Array<(r: RowT) => boolean> = [];
  let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
  let payload: any = null;
  let orderBy: { col: string; asc: boolean } | null = null;
  let lim: number | null = null;
  let single: "maybe" | "one" | null = null;
  const rows = () => (DB[table] ||= []);
  const run = () => {
    if (op === "insert" || op === "upsert") {
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const p of arr) {
        if (op === "upsert") {
          const k = "phone" in p ? "phone" : ("key" in p ? "key" : null);
          const ex = k ? rows().find(r => r[k] === p[k]) : null;
          if (ex) { Object.assign(ex, p); continue; }
        }
        rows().push({ id: rows().length + 1, ...p });
      }
      return { data: arr, error: null };
    }
    let res = rows().filter(r => filters.every(f => f(r)));
    if (op === "update") { for (const r of res) Object.assign(r, structuredClone(payload)); return { data: res, error: null }; }
    if (op === "delete") { DB[table] = rows().filter(r => !res.includes(r)); return { data: res, error: null }; }
    if (orderBy) { const { col, asc } = orderBy; res = [...res].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (asc ? 1 : -1)); }
    if (lim != null) res = res.slice(0, lim);
    res = structuredClone(res);
    if (single) return { data: res[0] ?? null, error: single === "one" && !res[0] ? { message: "no rows" } : null };
    return { data: res, error: null, count: res.length };
  };
  const b: any = {
    select: () => b, eq: (c: string, v: any) => (filters.push(r => r[c] === v), b),
    neq: (c: string, v: any) => (filters.push(r => r[c] !== v), b),
    not: (c: string, o: string, v: any) => (filters.push(r => o === "is" && v === null ? r[c] != null : r[c] !== v), b),
    is: (c: string, v: any) => (filters.push(r => (r[c] ?? null) === v), b),
    gte: (c: string, v: any) => (filters.push(r => String(r[c] ?? "") >= String(v)), b),
    gt: (c: string, v: any) => (filters.push(r => String(r[c] ?? "") > String(v)), b),
    lte: (c: string, v: any) => (filters.push(r => String(r[c] ?? "") <= String(v)), b),
    lt: (c: string, v: any) => (filters.push(r => String(r[c] ?? "") < String(v)), b),
    in: (c: string, vs: any[]) => (filters.push(r => vs.includes(r[c])), b),
    like: () => b, ilike: () => b, or: () => b, filter: () => b, contains: () => b, range: () => b,
    order: (col: string, o?: { ascending?: boolean }) => (orderBy = { col, asc: o?.ascending !== false }, b),
    limit: (n: number) => (lim = n, b),
    maybeSingle: () => (single = "maybe", b), single: () => (single = "one", b),
    update: (p: any) => (op = "update", payload = p, b), insert: (p: any) => (op = "insert", payload = p, b),
    upsert: (p: any) => (op = "upsert", payload = p, b), delete: () => (op = "delete", b),
    then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const fakeSupabase: any = { from: q, rpc: async () => ({ data: null, error: null }), storage: { from: () => ({ upload: async () => ({}), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) } };

// ── 3) fetch وهمي: النموذج مُبرمَج، واتساب يُسجَّل، Tourism-AI يرجّع برنامج ──
let modelQueue: string[] = [];
let modelCalls = 0;
let buildCalls = 0;
let proposalCalls = 0;
let lastBuildBody: Record<string, any> | null = null;
let injectOnModel: string | null = null;
let lastModelSystem = "";
let lastModelName = "";
let medFlights: string[] | null = null;
let rejectTools = false;
let curIntent: Record<string, unknown> | null = null;
let intentCalls = 0;
let intentInput = "";   // ٥ نوفمبر: نص المحادثة اللي وصل لمصنّف النية
let buildFail = false;
let buildTotals: number[] = [];   // ٦ نوفمبر: إجمالي كل بناء بالترتيب (ريال سعودي)
const buildBodies: Array<Record<string, any>> = [];
const wire: string[] = [];
const emails: Array<Record<string, any>> = [];   // ٨ نوفمبر: إيميلات التنبيه (Resend)   // ٨ نوفمبر: النصوص اللي طلعت فعلاً لواتساب (بعد الترجمة)
let translateCalls = 0; let curTranslate: string | null = null;
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input?.url || input);
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("api.anthropic.com") && /"talal_intent"/.test(String(init?.body || ""))) {
    // مصنّف النية: السيناريو يحدده بـ intent؛ غير محدد = فشل → كاشفات الكلمات (سلوك السيناريوهات القديمة).
    intentCalls++; intentInput = String(init?.body || "");
    if (!curIntent) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "no intent in scenario" } }), { status: 400, headers: { "content-type": "application/json" } });
    return json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "ti", name: "talal_intent", input: { yes_no: "none", frustrated: false, meaning: "", ...curIntent } }] });
  }
  if (url.includes("api.anthropic.com") && /TALAL_TRANSLATE_EN/.test(String(init?.body || ""))) {
    // ٨ نوفمبر: ترجمة رد طلال للإنجليزي (العميل يكتب إنجليزي) — السيناريو يحدد الناتج بـ translate.
    translateCalls++;
    return json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: curTranslate ?? "Translated reply." }] });
  }
  if (url.includes("api.anthropic.com")) {
    modelCalls++;
    if (rejectTools && /"tools"/.test(String(init?.body || ""))) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tools: invalid schema" } }), { status: 400, headers: { "content-type": "application/json" } });
    try { const _jb = JSON.parse(String(init?.body || "{}")); lastModelSystem = String(_jb.system || ""); lastModelName = String(_jb.model || ""); } catch { lastModelSystem = ""; }
    if (injectOnModel) { DB.wa_message_audit.push({ from_phone: "whatsapp:+96899621742", body: injectOnModel, received_at: new Date(Date.now() + 60_000).toISOString(), status: "received" }); injectOnModel = null; }
    const txt = modelQueue.length ? modelQueue.shift()! : modelQueue.at(-1) ?? "{}";
    // «TOOL:{...}» = ردّ عبر الأداة الإلزامية (tool_use) كما في الإنتاج؛ غير ذلك نص عادي (للتوافق مع السيناريوهات القديمة).
    if (txt.startsWith("TOOL:")) return json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "talal", input: JSON.parse(txt.slice(5)) }] });
    return json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: txt }] });
  }
  if (url.includes("api.resend.com")) { try { emails.push(JSON.parse(String(init?.body || "{}"))); } catch { /* */ } return json({ id: "email-test" }); }
  if (url.includes("graph.facebook.com") && /display_phone_number/.test(url)) return json({ id: "test-id", display_phone_number: "+968 9117 1630" });
  if (url.includes("graph.facebook.com")) { try { const _b = JSON.parse(String(init?.body || "{}")); const _t = _b?.text?.body ?? _b?.document?.caption ?? _b?.image?.caption; if (typeof _t === "string") wire.push(_t); } catch { /* */ } return json({ messages: [{ id: "wamid.test" + Math.random() }] }); }
  if (url.includes("Tourism-AI") && /makkah_flights/.test(String(init?.body || ""))) {
    const t: Record<string, unknown> = {}; for (const d of (medFlights || [])) t[d] = { final: 1342, timing: "17:40 - 21:30" };
    return json({ prices: { oman: { out: {}, ret: {}, ret_med: t } } });
  }
  if (url.includes("Tourism-AI")) { buildCalls++; try { lastBuildBody = JSON.parse(String(init?.body || "{}")); } catch { lastBuildBody = null; } if (lastBuildBody) buildBodies.push(lastBuildBody);
    const _tot = buildTotals.length ? buildTotals[Math.min(buildCalls - 1, buildTotals.length - 1)] : 1000;
    if (buildFail) return json({ ok: false, error: "no buildable program" }); return json({ ok: true, program: "DEST:اختبار\nTOTAL_GROUP:" + _tot, formatted: "برنامج اختبار", program_code: buildTotals.length ? "MK-TEST-" + buildCalls : "MK-TEST", kid_ages: [], price_ready: true }); }
  return json({});
};

const { handleNewLeadIntake, handleFollowupAI, handleMessage, extractDestination, fuzzyDestination, _programIssues, _varyPostMsg, isAffirmative, isYesish, sendPostProgramMessages, replyUnsupportedAttachment, handleVoiceNote } = await import(TMP.href);

// ── 4) تشغيل السيناريوهات ──
const PHONE = "whatsapp:+96899621742";
function seed(s: Scenario) {
  DB = { wa_message_audit: [], wa_admin_messages: [], whatsapp_sessions: [], guard_logs: [], program_pdf_jobs: [],
    wa_settings: [{ key: "ai_mode", value: "PREVIEW" }, { key: "auto_program_test_numbers", value: "99621742" }] };
  let t = Date.now() - 3 * 3600e3;   // أوقات حديثة دائماً (قاعدة «الموظف استلم» تنظر آخر ٤٨ ساعة)
  const ts = () => new Date(t += 15_000).toISOString();
  const _tsList: string[] = [];
  for (const [who, body] of s.history) {
    _tsList.push(new Date(t + 15_000).toISOString());
    if (who === "C") DB.wa_message_audit.push({ from_phone: PHONE, body, received_at: ts(), status: "received" });
    else DB.wa_admin_messages.push({ customer_phone: PHONE, body, sent_by: who === "S" ? "غروب" : (body.startsWith("AUTO:") ? "تأكيد تلقائي" : "طلال"), sent_at: ts() });
  }
  DB.wa_message_audit.push({ from_phone: PHONE, body: s.customer, received_at: ts(), status: "received" });
  if ((s as any).settings) DB.wa_settings = structuredClone((s as any).settings);   // ٨ نوفمبر: إعدادات بديلة (مثلاً بند ON بلا أرقام اختبار)
  for (const [tb, rows] of Object.entries(s.tables || {})) (DB[tb] ||= []).push(...structuredClone(rows as RowT[]));
  for (const j of (s.jobs || [])) DB.program_pdf_jobs.push({ phone: PHONE, created_at: ts(), attempts: 0, ...j });
  DB.whatsapp_sessions.push({ phone: PHONE, profile_name: "اختبار", ...((s as any).aiEnabled !== undefined ? { ai_enabled: (s as any).aiEnabled } : {}), intake_active: s.sessionIntakeActive ?? (s.entry !== "followup"), stage: "new",
    destination: s.session?.destination ?? null, intake_data: { ...structuredClone(s.intakeData || {}), ...(s.seenAt !== undefined ? { last_seen_in_ts: _tsList[s.seenAt] } : {}), ...((s as any).startedAt !== undefined ? { started_at: _tsList[(s as any).startedAt] } : {}) }, ad_referral: (s.session as any)?.ad_referral ?? null, last_message_at: ts() });
  return ts;
}

let pass = 0, fail = 0;
const only = Deno.args[0];
const realErr = console.error, realWarn = console.warn, realLog = console.log;
for (const s of SCENARIOS) {
  if (only && !s.id.includes(only)) continue;
  const lastTs = seed(s);
  const before = DB.wa_admin_messages.length;
  modelQueue = [...s.model]; modelCalls = 0; buildCalls = 0; proposalCalls = 0; lastBuildBody = null; medFlights = s.medFlights || null; rejectTools = !!s.rejectTools; curIntent = (s as any).intent || null; intentCalls = 0; intentInput = ""; buildFail = !!s.buildFail; buildTotals = (s as any).buildTotals || []; buildBodies.length = 0; wire.length = 0; emails.length = 0; translateCalls = 0; curTranslate = (s as any).translate ?? null; lastModelSystem = ""; injectOnModel = s.inboundDuringModel || null; _bg.length = 0;
  let crash = "";
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  try {
    (globalThis as any).__omanHourForTests = (s as any).omanHour ?? 12;   // ٨ نوفمبر: نهار افتراضياً (رسائل الليل لها سيناريوهاتها)
    if ((s as any).entry === "voice") await handleVoiceNote({ supabase: fakeSupabase, from: (s as any).from || PHONE, profileName: "اختبار", transcript: s.customer });   // ٨ نوفمبر: customer = نص الصوت بعد التحويل
    else if (s.entry === "message") await handleMessage({ supabase: fakeSupabase, from: (s as any).from || PHONE, profileName: "اختبار", body: s.customer });
    else if (s.entry === "followup") await handleFollowupAI({ supabase: fakeSupabase, from: PHONE, profileName: "اختبار", body: s.customer });
    else await handleNewLeadIntake({ supabase: fakeSupabase, from: PHONE, body: s.customer });
    await Promise.all(_bg);
  }
  catch (e) { crash = String((e as Error)?.stack || e); }
  finally { console.error = realErr; console.warn = realWarn; console.log = realLog; }
  void lastTs;
  const sent = DB.wa_admin_messages.slice(before).map(m => String(m.body || "")).join("\n");
  const sess = DB.whatsapp_sessions[0] || {};
  const proposals = (DB.whatsapp_admin_proposals || []).length;
  const jobs = DB.program_pdf_jobs || [];
  const ctx = { emails: [...emails], wire: wire.join("\n"), translateCalls, buildBodies: [...buildBodies], db: DB, jobs, modelName: lastModelName, modelSystem: lastModelSystem, intentInput, buildBody: lastBuildBody, reply: sent, session: sess, intake: sess.intake_data || {}, buildCalls, modelCalls, proposals };
  const errs: string[] = [];
  if (crash) errs.push("انهار: " + crash.split("\n").slice(0, 3).join(" | "));
  for (const [label, check] of s.expect) { try { if (!check(ctx)) errs.push(label); } catch (e) { errs.push(label + " (" + (e as Error).message + ")"); } }
  if (errs.length) {
    fail++;
    realLog(`❌ ${s.id} — ${s.title}`);
    for (const e of errs) realLog(`     ✗ ${e}`);
    realLog(`     ردّ طلال: ${sent.replace(/\n/g, " ⏎ ").slice(0, 300) || "(لا شيء)"}`);
    if (wire.length) realLog(`     واتساب فعلياً: ${wire.join(" ⏎ ").slice(0, 300)}`);
    realLog(`     الوجهة المخزّنة: ${JSON.stringify((sess.intake_data || {}).destination)} | ages=${JSON.stringify((sess.intake_data || {}).ages)} | build=${buildCalls}`);
  } else { pass++; realLog(`✅ ${s.id} — ${s.title}`); if (Deno.env.get("VERBOSE")) { realLog(`     ردّ طلال: ${sent.replace(/\n/g, " ⏎ ").slice(0, 260)}`); for (const e of emails) realLog(`     📧 إلى ${JSON.stringify(e.to)} | ${e.subject}\n${e.text}`); } }
}
// ── اختبارات وحدة: كشف الوجهة (كلمات عربية تشبه أسماء وجهات) ──
const DEST_UNITS: Array<[string, string | null]> = [
  ["مشرمن جده", null],            // ٣ نوفمبر: «مش من جدة» طابقت «شرم» → مصر
  ["ابي مصر", "مصر"], ["شرم الشيخ", "مصر"], ["لمصر شهر ٢", "مصر"], ["المصروف كم", null],
];
for (const [t, want] of DEST_UNITS) {
  const got = extractDestination(t);
  if (got === want) { pass++; realLog(`✅ dest-unit «${t}» → ${want}`); }
  else { fail++; realLog(`❌ dest-unit «${t}» → ${got} (المتوقع ${want})`); }
}
// ── اختبارات وحدة: الفحص الذاتي للبرنامج المرسل (قرار المالكة: طلال يكتشف غلطه بنفسه) ──
{
  const D = { program_spec: { pax: 5, date: "12/11/2026", return_airport: "madinah" } };
  const RAW = (n: number, ret: string, cur = true) => `DEST:العمرة${cur ? "\nCURRENCY:ريال عماني|10" : ""}\nDATE_FROM:12 نوفمبر 2026\nFLIGHTS:\nمسقط ← جدة (السلام) | ذهاب | 940 ريال/شخص | ${n} أشخاص | x\n${ret} ← مسقط (العماني) | عودة | 826 ريال/شخص | ${n} أشخاص | y\n\nTOURS:\n`;
  const U: Array<[string, string[], string]> = [
    ["MK-2026-010 الحقيقي (طيران لـ٤ من ٥)", _programIssues(RAW(4, "المدينة"), D, "whatsapp:+96899621742"), "الطيران ما انحسب"],
    ["بعد التصحيح (٥)", _programIssues(RAW(5, "المدينة"), D, "whatsapp:+96899621742"), ""],
    ["طلب المدينة والعودة طلعت جدة", _programIssues(RAW(5, "جدة"), D, "whatsapp:+96899621742"), "العودة طلعت من جدة"],
    ["رقم عماني بلا عملة", _programIssues(RAW(5, "المدينة", false), D, "whatsapp:+96899621742"), "بالريال السعودي"],
    ["رقم سعودي بلا عملة = عادي", _programIssues(RAW(5, "المدينة", false), D, "whatsapp:+966500000000"), ""],
    ["٤ نوفمبر: طلب تايلاند غيّر التاريخ لـ١٧ بعد البناء — المقارنة بنسخة الطلب (١٢) → سليم", _programIssues(RAW(5, "جدة"), { date: "17/11/2026", pax: 5, program_spec: { pax: 5, date: "12/11/2026", return_airport: "jeddah" } }, "whatsapp:+96899621742"), ""],
  ];
  for (const [name, issues, want] of U) {
    const ok = want ? issues.some(i => i.includes(want)) && issues.length === 1 : issues.length === 0;
    if (ok) { pass++; realLog(`✅ self-check «${name}» → ${issues.join(" | ") || "سليم"}`); } else { fail++; realLog(`❌ self-check «${name}» → ${issues.join(" | ") || "سليم"} (المتوقع ${want || "سليم"})`); }
  }
}
// ── وحدة: الأخطاء الإملائية في اسم الوجهة ──
for (const [t, want] of [["يعني الي عمره ١٢ سنه يعتر بالغ ؟", null], ["كم عمرها ٧", null], ["ابي عمره", "العمرة"], ["طيب جيب لي برنامج تلاتد", "تايلاند"], ["ابي ماليزبا", "ماليزيا"], ["وين مطار المدينه", null], ["ابي اغير رحله العوده", null]] as Array<[string, string | null]>) {
  const got = fuzzyDestination(t) ?? (want === "العمرة" || want === null ? extractDestination(t) : null);
  if (got === want) { pass++; realLog(`✅ fuzzy «${t}» → ${want}`); } else { fail++; realLog(`❌ fuzzy «${t}» → ${got} (المتوقع ${want})`); }
}
// ── وحدة: تنويع رسائل ما بعد البرنامج لو تكررت (قرار المالكة) ──
{
  const KID = "علماً أن البرنامج ما فيه سرير إضافي للأطفال (أعمارهم 10 و9). إذا حاب أضيف لهم سرير إضافي في البرنامج، عطني خبر عشان أضيف التكلفة تبعه.";
  const RDY = "تفضل أستاذي، برنامجك صار جاهز. أي تعديل في البرنامج أنا حاضر.";
  const U: Array<[string, string, (x: string) => boolean]> = [
    ["أول مرة = نفس الصيغة", _varyPostMsg(KID, 0), x => x === KID],
    ["تكرار ١ = «مثل ما ذكرت لك سابقاً» ونفس الأعمار", _varyPostMsg(KID, 1), x => /^مثل ما ذكرت لك سابقا?ً?، البرنامج ما فيه سرير إضافي للأطفال \(أعمارهم 10 و9\)/.test(x)],
    ["تكرار ٢ = صياغة ثالثة", _varyPostMsg(KID, 2), x => /^وللتذكير/.test(x) && /10 و9/.test(x)],
    ["الجاهزية تكرار = «بعد التعديل»", _varyPostMsg(RDY, 1), x => /البرنامج بعد التعديل صار جاهز/.test(x)],
  ];
  for (const [n, got, ok] of U) { if (ok(got)) { pass++; realLog(`✅ post-msg «${n}»`); } else { fail++; realLog(`❌ post-msg «${n}» → ${got}`); } }
}
// ── ٤ نوفمبر ٢٠٢٦ (حي): طلب جديد بعد برنامج سابق → «برنامجك صار جاهز» (مو «بعد التعديل») ──
{
  const RDY = "تفضل أستاذي، برنامجك صار جاهز. أي تعديل في البرنامج أنا حاضر.";
  const old = new Date(Date.now() - 3600e3).toISOString(), start = new Date(Date.now() - 600e3).toISOString();
  for (const [n, sessStart, ok] of [["طلب جديد (الجاهزية السابقة قبل بدايته)", start, (x: string) => /برنامجك صار جاهز/.test(x)], ["نفس الطلب (تعديل)", new Date(Date.now() - 7200e3).toISOString(), (x: string) => /بعد التعديل/.test(x)]] as Array<[string, string, (x: string) => boolean]>) {
    DB = { wa_admin_messages: [{ customer_phone: PHONE, body: RDY, sent_by: "طلال", sent_at: old }], whatsapp_sessions: [{ phone: PHONE, intake_data: { started_at: sessStart } }], wa_message_audit: [], guard_logs: [], program_pdf_jobs: [], wa_settings: [] };
    console.log = () => {}; console.error = () => {};
    try { await sendPostProgramMessages(fakeSupabase, PHONE, [RDY]); } catch (_e) { /* */ }
    console.log = realLog; console.error = realErr;
    const got = String(DB.wa_admin_messages.at(-1)?.body || "");
    if (ok(got)) { pass++; realLog(`✅ post-ready «${n}»`); } else { fail++; realLog(`❌ post-ready «${n}» → ${got}`); }
  }
}
// ── ٥ نوفمبر ٢٠٢٦ (قرار المالكة): برنامج انبنى من تعديل (program_modified) → «المعدّل/بعد التعديل» حتى لو رسالة الجاهزية الأولى قبل started_at ──
{
  const RDY = "تفضل أستاذي، برنامجك صار جاهز. أي تعديل في البرنامج أنا حاضر.";
  const old = new Date(Date.now() - 3600e3).toISOString(), start = new Date(Date.now() - 600e3).toISOString();
  DB = { wa_admin_messages: [{ customer_phone: PHONE, body: RDY, sent_by: "طلال", sent_at: old }], whatsapp_sessions: [{ phone: PHONE, intake_data: { started_at: start, program_modified: true } }], wa_message_audit: [], guard_logs: [], program_pdf_jobs: [], wa_settings: [] };
  console.log = () => {}; console.error = () => {};
  try { await sendPostProgramMessages(fakeSupabase, PHONE, [RDY]); } catch (_e) { /* */ }
  console.log = realLog; console.error = realErr;
  const got = String(DB.wa_admin_messages.at(-1)?.body || "");
  if (/بعد التعديل|المعدّل/.test(got)) { pass++; realLog("✅ post-ready «برنامج معدّل (program_modified)»"); } else { fail++; realLog(`❌ post-ready «برنامج معدّل (program_modified)» → ${got}`); }
}
// ── ٥ نوفمبر ٢٠٢٦ (قرار المالكة): بناء «أرخص العروض» (program_cheapest) → ختام «هذي أرخص العروض عندنا، بإمكانك الاطلاع عليها.» ──
{
  const RDY = "تفضل أستاذي، برنامجك صار جاهز. أي تعديل في البرنامج أنا حاضر.";
  DB = { wa_admin_messages: [], whatsapp_sessions: [{ phone: PHONE, intake_data: { started_at: new Date(Date.now() - 600e3).toISOString(), program_modified: true, program_cheapest: true } }], wa_message_audit: [], guard_logs: [], program_pdf_jobs: [], wa_settings: [] };
  console.log = () => {}; console.error = () => {};
  try { await sendPostProgramMessages(fakeSupabase, PHONE, [RDY]); } catch (_e) { /* */ }
  console.log = realLog; console.error = realErr;
  const got = String(DB.wa_admin_messages.at(-2)?.body || "");
  const bud = String(DB.wa_admin_messages.at(-1)?.body || "");
  if (!/ميزانية معيّنة بلغني.*حابين نخدمك طبعاً/.test(bud)) { fail++; realLog(`❌ post-ready «رسالة الميزانية» → ${bud}`); } else { pass++; realLog("✅ post-ready «رسالة الميزانية»"); }
  if (got === "تفضل أستاذي، هذا العرض الثالث، ياريت تطّلع عليه، وأنتظر تأكيدك أو التعديل عليه إذا حبيت.") { pass++; realLog("✅ post-ready «أرخص العروض»"); } else { fail++; realLog(`❌ post-ready «أرخص العروض» → ${got}`); }
}
// ── ٧ نوفمبر ٢٠٢٦ (المالكة): مرفق ما يسلّمه واتساب (عرض مرة واحدة) → طلال يطلب إعادة الإرسال مرة وحدة كل ١٠ دقائق ──
{
  DB = { wa_admin_messages: [], whatsapp_sessions: [{ phone: PHONE }], wa_message_audit: [], guard_logs: [], program_pdf_jobs: [], wa_settings: [] };
  console.log = () => {}; console.error = () => {};
  let r1 = false, r2 = false;
  try { r1 = await replyUnsupportedAttachment(fakeSupabase, PHONE); r2 = await replyUnsupportedAttachment(fakeSupabase, PHONE); } catch (_e) { /* */ }
  console.log = realLog; console.error = realErr;
  const sent = DB.wa_admin_messages.filter((m: any) => /ما وصلنا/.test(String(m.body)) && /عرض مرة واحدة/.test(String(m.body)));
  if (r1 && !r2 && sent.length === 1) { pass++; realLog("✅ unsupported-attach «رد واحد يطلب إعادة الإرسال»"); } else { fail++; realLog(`❌ unsupported-attach r1=${r1} r2=${r2} sent=${sent.length}`); }
}
// ── وحدة: صيغ الموافقة (٤ نوفمبر: «تماما» ما انحسبت) ──
for (const [t, want] of [["تماما", true], ["تمامم", true], ["تمام", true], ["اوكيه", true], ["طيب", true], ["👍", true], ["✅", true], ["ايوه", true], ["okk", true], ["كل شي صح", true], ["ياريت", true], ["يا ريت", true], ["ياليت والله", true], ["لا", false], ["تمام بس غير التاريخ ١٥", false], ["متى", false]] as Array<[string, boolean]>) {
  const got = isYesish(t);
  if (got === want) { pass++; realLog(`✅ yes «${t}» → ${want}`); } else { fail++; realLog(`❌ yes «${t}» → ${got} (المتوقع ${want})`); }
}
await Deno.remove(TMP).catch(() => {});
realLog(`\nالنتيجة: ${pass} ناجح، ${fail} فاشل من ${pass + fail}`);
Deno.exit(fail ? 1 : 0);
