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
code += "\nexport { handleNewLeadIntake };\n";
await Deno.writeTextFile(TMP, code);
(globalThis as any).__noServe = () => {};

// متغيرات بيئة وهمية (ليست أسراراً — قيم اختبار فقط)
Deno.env.set("ANTHROPIC_API_KEY", "test-key");
Deno.env.set("WHATSAPP_ACCESS_TOKEN", "test-token");
Deno.env.set("WHATSAPP_PHONE_NUMBER_ID", "test-id");
Deno.env.set("SUPABASE_URL", "http://fake.local");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");

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
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input?.url || input);
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("api.anthropic.com")) {
    modelCalls++;
    const txt = modelQueue.length ? modelQueue.shift()! : modelQueue.at(-1) ?? "{}";
    return json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: txt }] });
  }
  if (url.includes("graph.facebook.com")) return json({ messages: [{ id: "wamid.test" + Math.random() }] });
  if (url.includes("Tourism-AI")) { buildCalls++; return json({ ok: true, formatted: "برنامج اختبار", program_code: "MK-TEST", kid_ages: [], price_ready: true }); }
  return json({});
};

const { handleNewLeadIntake } = await import(TMP.href);

// ── 4) تشغيل السيناريوهات ──
const PHONE = "whatsapp:+96899621742";
function seed(s: Scenario) {
  DB = { wa_message_audit: [], wa_admin_messages: [], whatsapp_sessions: [], guard_logs: [], program_pdf_jobs: [],
    wa_settings: [{ key: "ai_mode", value: "PREVIEW" }, { key: "auto_program_test_numbers", value: "99621742" }] };
  let t = Date.parse("2026-11-02T10:00:00Z");
  const ts = () => new Date(t += 15_000).toISOString();
  for (const [who, body] of s.history) {
    if (who === "C") DB.wa_message_audit.push({ from_phone: PHONE, body, received_at: ts(), status: "received" });
    else DB.wa_admin_messages.push({ customer_phone: PHONE, body, sent_by: "طلال", sent_at: ts() });
  }
  DB.wa_message_audit.push({ from_phone: PHONE, body: s.customer, received_at: ts(), status: "received" });
  DB.whatsapp_sessions.push({ phone: PHONE, profile_name: "اختبار", intake_active: true, stage: "new",
    destination: s.session?.destination ?? null, intake_data: structuredClone(s.intakeData || {}), ad_referral: null, last_message_at: ts() });
  return ts;
}

let pass = 0, fail = 0;
const only = Deno.args[0];
const realErr = console.error, realWarn = console.warn, realLog = console.log;
for (const s of SCENARIOS) {
  if (only && !s.id.includes(only)) continue;
  const lastTs = seed(s);
  const before = DB.wa_admin_messages.length;
  modelQueue = [...s.model]; modelCalls = 0; buildCalls = 0; _bg.length = 0;
  let crash = "";
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  try { await handleNewLeadIntake({ supabase: fakeSupabase, from: PHONE, body: s.customer }); await Promise.all(_bg); }
  catch (e) { crash = String((e as Error)?.stack || e); }
  finally { console.error = realErr; console.warn = realWarn; console.log = realLog; }
  void lastTs;
  const sent = DB.wa_admin_messages.slice(before).map(m => String(m.body || "")).join("\n");
  const sess = DB.whatsapp_sessions[0] || {};
  const ctx = { reply: sent, session: sess, intake: sess.intake_data || {}, buildCalls, modelCalls };
  const errs: string[] = [];
  if (crash) errs.push("انهار: " + crash.split("\n").slice(0, 3).join(" | "));
  for (const [label, check] of s.expect) { try { if (!check(ctx)) errs.push(label); } catch (e) { errs.push(label + " (" + (e as Error).message + ")"); } }
  if (errs.length) {
    fail++;
    realLog(`❌ ${s.id} — ${s.title}`);
    for (const e of errs) realLog(`     ✗ ${e}`);
    realLog(`     ردّ طلال: ${sent.replace(/\n/g, " ⏎ ").slice(0, 300) || "(لا شيء)"}`);
    realLog(`     الوجهة المخزّنة: ${JSON.stringify((sess.intake_data || {}).destination)} | ages=${JSON.stringify((sess.intake_data || {}).ages)} | build=${buildCalls}`);
  } else { pass++; realLog(`✅ ${s.id} — ${s.title}`); }
}
await Deno.remove(TMP).catch(() => {});
realLog(`\nالنتيجة: ${pass} ناجح، ${fail} فاشل من ${pass + fail}`);
Deno.exit(fail ? 1 : 0);
