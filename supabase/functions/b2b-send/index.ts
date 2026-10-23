/**
 * b2b-send — تشغيل حملة واتساب B2B على دفعات.
 *
 * POST { campaign_id }  →  يجلب الحملة وفلاترها ويختار الشركات المطابقة.
 *   - لا شركات مطابقة → { ok, sent:0, failed:0 } فوراً.
 *   - غير ذلك → يرد فوراً { ok, started, total, remaining } ويرسل في الخلفية دفعة
 *     من BATCH_SIZE شركة (تأخير ثانية بين كل رسالة)، ثم يستدعي نفسه للدفعة
 *     التالية حتى تنتهي الحملة، فتصبح حالتها sent (أو failed إن فشل الكل).
 *
 * الاستئناف: الشركات التي لها سطر في b2b_campaign_messages لهذه الحملة تُتخطّى،
 * فإعادة التشغيل تُكمل من حيث توقفت ولا تكرّر.
 * القفل: صف send_lock:<campaign_id> في b2b_settings (المفتاح الأساسي يمنع تشغيلين
 * متوازيين). القفل الأقدم من LOCK_STALE_MS يُعتبر عالقاً ويُكسر.
 *
 * الفلاتر (campaigns.filters jsonb) المدعومة: { country, category, destinations[] }.
 * ⚠️ يرسل من رقم B2B فقط (1323027874234661) — لا يمسّ رقم السياحة.
 * البوابة: لو B2B_ADMIN_SECRET مضبوط، لازم ترويسة x-admin-secret مطابِقة.
 */
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROJECT_REF = "ofotvacszlmrqxzfjmtn";
const GRAPH_VERSION = "v22.0";
const B2B_PHONE_NUMBER_ID = "1323027874234661";
const SEND_DELAY_MS = 1000;
const BATCH_SIZE = 50;
const LOCK_STALE_MS = 3 * 60_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret, Authorization, apikey",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// إرسال قالب عبر Meta Cloud API من رقم B2B. يرجّع { ok, id, error }.
async function sendTemplate(to: string, name: string, lang: string): Promise<{ ok: boolean; id: string; error: string }> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";
  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/messages`;
  const graphTo = String(to || "").replace(/[^\d]/g, "");
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: graphTo,
        type: "template",
        template: { name, language: { code: lang || "ar" } },
        // ملاحظة: مكوّنات/متغيّرات القالب تُضاف لاحقاً عند الحاجة (هيكل الآن).
      }),
    });
    const data = await res.json().catch(() => ({}));
    const id = data?.messages?.[0]?.id || "";
    if (id) return { ok: true, id, error: "" };
    const err = data?.error?.message || data?.error?.error_user_msg || `HTTP ${res.status}`;
    return { ok: false, id: "", error: String(err).slice(0, 300) };
  } catch (e) {
    return { ok: false, id: "", error: String((e as Error).message).slice(0, 300) };
  }
}

// الشركات المطابقة للفلاتر (ولها رقم واتساب) والتي لم تُرسل لها هذه الحملة بعد.
async function pendingTargets(sb: SupabaseClient, campaignId: string, filters: any) {
  let q = sb.from("b2b_companies").select("id, whatsapp").not("whatsapp", "is", null);
  if (filters.country) q = q.eq("country", filters.country);
  if (filters.category) q = q.eq("category", filters.category);
  if (Array.isArray(filters.destinations) && filters.destinations.length) q = q.overlaps("destinations", filters.destinations);
  const { data: companies, error } = await q;
  if (error) throw error;
  const all = (companies || []).filter((c: any) => (c.whatsapp || "").trim());
  const { data: done } = await sb.from("b2b_campaign_messages").select("company_id").eq("campaign_id", campaignId);
  const doneIds = new Set((done || []).map((d: any) => d.company_id));
  return { total: all.length, pending: all.filter((c: any) => !doneIds.has(c.id)) };
}

// قفل ذرّي عبر المفتاح الأساسي في b2b_settings.
async function acquireLock(sb: SupabaseClient, campaignId: string): Promise<boolean> {
  const key = `send_lock:${campaignId}`;
  const { error } = await sb.from("b2b_settings").insert({ key, value: String(Date.now()) });
  if (!error) return true;
  const { data } = await sb.from("b2b_settings").select("value").eq("key", key).maybeSingle();
  if (data && Date.now() - Number(data.value || 0) > LOCK_STALE_MS) {
    // قفل عالق (توقفت السلسلة) → نكسره بشرط أنه نفس القيمة التي قرأناها
    const { data: removed } = await sb.from("b2b_settings").delete().eq("key", key).eq("value", data.value).select("key");
    if (removed?.length) return acquireLock(sb, campaignId);
  }
  return false;
}
const releaseLock = (sb: SupabaseClient, campaignId: string) =>
  sb.from("b2b_settings").delete().eq("key", `send_lock:${campaignId}`);

// دفعة واحدة (تعمل في الخلفية): ترسل حتى BATCH_SIZE ثم تطلق الدفعة التالية أو تُنهي الحملة.
async function runBatch(sb: SupabaseClient, camp: any, pending: Array<{ id: string; whatsapp: string }>, adminSecret: string) {
  try {
    for (const c of pending.slice(0, BATCH_SIZE)) {
      const r = await sendTemplate(c.whatsapp, camp.template_name, camp.template_lang);
      try {
        await sb.from("b2b_campaign_messages").insert({
          campaign_id: camp.id, company_id: c.id,
          wa_message_id: r.id || null,
          status: r.ok ? "sent" : "failed",
          error: r.ok ? null : r.error,
          sent_at: r.ok ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        });
      } catch (_) { /* best-effort */ }
      await sleep(SEND_DELAY_MS);
    }
  } finally {
    await releaseLock(sb, camp.id);
  }

  if (pending.length > BATCH_SIZE) {
    // الدفعة التالية: استدعاء ذاتي يرد فوراً ويعمل في خلفيته (لا تتراكم مدة التشغيل).
    const jwt = Deno.env.get("LEGACY_ANON_JWT") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    try {
      await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/b2b-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: jwt, "x-admin-secret": adminSecret },
        body: JSON.stringify({ campaign_id: camp.id }),
      });
    } catch (e) {
      // السلسلة توقفت — الحملة تبقى «sending» ويمكن استكمالها من اللوحة
      console.log("b2b-send chain error:", (e as Error).message);
    }
    return;
  }

  // انتهت الحملة → الحالة النهائية من مجموع السجل
  const { data: rows } = await sb.from("b2b_campaign_messages").select("status").eq("campaign_id", camp.id);
  const anyOk = (rows || []).some((r: any) => r.status !== "failed");
  await sb.from("b2b_campaigns").update({ status: anyOk ? "sent" : "failed" }).eq("id", camp.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const adminSecret = Deno.env.get("B2B_ADMIN_SECRET") || "";
  if (adminSecret && req.headers.get("x-admin-secret") !== adminSecret) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  let campaign_id = "";
  try { campaign_id = String((await req.json())?.campaign_id || ""); } catch (_) { /* */ }
  if (!campaign_id) return json({ ok: false, error: "campaign_id مطلوب" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: camp, error: cErr } = await sb.from("b2b_campaigns").select("*").eq("id", campaign_id).maybeSingle();
  if (cErr || !camp) return json({ ok: false, error: "حملة غير موجودة" }, 404);

  let total = 0, pending: Array<{ id: string; whatsapp: string }> = [];
  try { ({ total, pending } = await pendingTargets(sb, campaign_id, camp.filters || {})); }
  catch (e) { return json({ ok: false, error: (e as Error).message }, 500); }
  if (!total) return json({ ok: true, sent: 0, failed: 0, message: "لا شركات مطابقة للفلاتر" });
  if (!pending.length) {
    await sb.from("b2b_campaigns").update({ status: "sent" }).eq("id", campaign_id);
    return json({ ok: true, done: true, total, remaining: 0, message: "كل الشركات المطابقة استلمت الحملة" });
  }

  if (!(await acquireLock(sb, campaign_id))) {
    return json({ ok: false, error: "الحملة قيد الإرسال الآن" }, 409);
  }
  await sb.from("b2b_campaigns").update({ status: "sending" }).eq("id", campaign_id);

  const work = runBatch(sb, camp, pending, adminSecret);
  // @ts-ignore EdgeRuntime injected by Supabase
  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(work);
  else await work;

  return json({ ok: true, started: true, total, remaining: pending.length, batch: Math.min(BATCH_SIZE, pending.length) });
});
