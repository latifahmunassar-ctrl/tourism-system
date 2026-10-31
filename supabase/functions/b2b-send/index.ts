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
 * محتوى قالب العروض (صورة + ٦ متغيّرات) يُخزَّن على الحملة: عمودا
 *   template_image/template_params إن وُجدا، وإلا داخل filters كـ _tpl_image/_tpl_params.
 *   (مفاتيح _tpl_* تُتجاهَل في الاستهداف لأنه يقرأ country/category/destinations فقط.)
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
// يدعم هيدر صورة (image: رابط عام) و٦ متغيّرات نصّية في الـ body (params) للقوالب
// مثل b2b_offer_alezz. القوالب البسيطة (بدون صورة/متغيّرات) تُرسَل كما هي.
async function sendTemplate(
  to: string,
  name: string,
  lang: string,
  image?: string | null,
  params?: unknown[] | null,
): Promise<{ ok: boolean; id: string; error: string }> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";
  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/messages`;
  const graphTo = String(to || "").replace(/[^\d]/g, "");
  const template: Record<string, unknown> = { name, language: { code: lang || "ar" } };
  const components: Array<Record<string, unknown>> = [];
  if (image) {
    components.push({ type: "header", parameters: [{ type: "image", image: { link: String(image) } }] });
  }
  if (Array.isArray(params) && params.length) {
    components.push({ type: "body", parameters: params.map((v) => ({ type: "text", text: String(v) })) });
  }
  if (components.length) template.components = components;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: graphTo, type: "template", template }),
    });
    const data = await res.json().catch(() => ({}));
    const id = data?.messages?.[0]?.id || "";
    if (id) return { ok: true, id, error: "" };
    const err = data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}`;
    return { ok: false, id: "", error: String(err).slice(0, 300) };
  } catch (e) {
    return { ok: false, id: "", error: String((e as Error).message).slice(0, 300) };
  }
}

// توحيد رقم الواتساب بنفس صيغة b2b-talal ("+" + أرقام) ليتطابق مفتاح المحادثة.
function normWa(raw: string): string {
  const d = String(raw || "").replace(/[^\d]/g, "");
  return d ? "+" + d : "";
}

// تسجيل رسالة الحملة الصادرة داخل خيط المحادثة (b2b_conversations/b2b_messages)
// حتى تظهر في «الوارد» بالداشبورد. يُنشئ المحادثة إن لم توجد (مطابقة لمنطق b2b-talal).
async function logOutbound(
  sb: SupabaseClient,
  companyId: string | null,
  waRaw: string,
  body: string,
  waMsgId: string,
) {
  const wa = normWa(waRaw);
  if (!wa) return;
  try {
    let { data: conv } = await sb.from("b2b_conversations").select("id").eq("whatsapp", wa).maybeSingle();
    if (!conv) {
      const { data: created } = await sb.from("b2b_conversations")
        .insert({ whatsapp: wa, company_id: companyId || null, auto_reply: false, last_message_at: new Date().toISOString() })
        .select("id").single();
      conv = created;
    } else {
      await sb.from("b2b_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
    }
    if (conv) {
      await sb.from("b2b_messages").insert({
        conversation_id: conv.id, direction: "out", body,
        wa_message_id: waMsgId || null, status: "sent",
      });
    }
  } catch (_) { /* best-effort — لا يعطّل الإرسال */ }
}

// ⚠️ Supabase يرجّع 1000 صف كحد أقصى للاستعلام الواحد — نرقّم الصفحات بـ range()
// حتى نجلب كل المطابقين (قوائم الآلاف) ولا يُقتطع الإرسال.
const PAGE = 1000;

async function allCompanies(sb: SupabaseClient, filters: any) {
  let from = 0; const out: Array<{ id: string; whatsapp: string }> = [];
  for (;;) {
    let q = sb.from("b2b_companies").select("id, whatsapp").not("whatsapp", "is", null);
    if (filters.country) q = q.eq("country", filters.country);
    if (filters.category) q = q.eq("category", filters.category);
    if (Array.isArray(filters.destinations) && filters.destinations.length) q = q.overlaps("destinations", filters.destinations);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function allDoneIds(sb: SupabaseClient, campaignId: string) {
  let from = 0; const ids = new Set<string>();
  for (;;) {
    const { data } = await sb.from("b2b_campaign_messages").select("company_id")
      .eq("campaign_id", campaignId).range(from, from + PAGE - 1);
    (data || []).forEach((d: any) => ids.add(d.company_id));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

// الشركات المطابقة للفلاتر (ولها رقم واتساب) والتي لم تُرسل لها هذه الحملة بعد.
// استهداف دقيق اختياري: filters.company_ids (مصفوفة) → يُرسل فقط لهذه الشركات (قائمة منقّاة).
async function pendingTargets(sb: SupabaseClient, campaignId: string, filters: any) {
  let all = (await allCompanies(sb, filters)).filter((c: any) => (c.whatsapp || "").trim());
  if (Array.isArray(filters.company_ids) && filters.company_ids.length) {
    const allow = new Set(filters.company_ids.map((x: any) => String(x)));
    all = all.filter((c: any) => allow.has(String(c.id)));
  }
  const doneIds = await allDoneIds(sb, campaignId);
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

// دفعة واحدة (تعمل في الخلفية): ترسل حتى sliceN ثم تطلق الدفعة التالية أو تُنهي الحملة.
// opts.limit: حدّ أقصى للإرسال في هذا الاستدعاء (بدون تسلسل) — للتجربة/الدفعات المتحكّم بها.
// opts.stopOnError: يوقف الحملة فوراً (status=paused) عند أول رسالة فاشلة ولا يُسلسل.
async function runBatch(
  sb: SupabaseClient,
  camp: any,
  pending: Array<{ id: string; whatsapp: string }>,
  adminSecret: string,
  opts: { limit?: number; stopOnError?: boolean } = {},
) {
  // صورة الهيدر و٦ متغيّرات القالب تُخزَّن على الحملة: إمّا عمودين مخصّصين
  // (template_image/template_params) أو داخل filters (_tpl_image/_tpl_params)
  // لتجنّب تغيير مخطّط القاعدة. نفس القيم لكل الشركات (عرض واحد).
  const tplImage = camp.template_image || camp.filters?._tpl_image || null;
  const tplParams = camp.template_params || camp.filters?._tpl_params || null;
  // نص يُسجّل في خيط المحادثة ليظهر في الوارد (العرض الكامل إن وُفّر، وإلا علامة مختصرة).
  const displayBody = String(camp.filters?._display_body || `📣 أُرسل العرض (قالب: ${camp.template_name})`);
  const noChain = !!(opts.limit && opts.limit > 0);
  const sliceN = noChain ? Math.min(opts.limit!, BATCH_SIZE) : BATCH_SIZE;
  const stopOnError = !!opts.stopOnError;
  let halted = false;
  let lastError = "";
  try {
    for (const c of pending.slice(0, sliceN)) {
      const r = await sendTemplate(c.whatsapp, camp.template_name, camp.template_lang, tplImage, tplParams);
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
      // تسجيل الرسالة الصادرة في المحادثة لتظهر في الوارد (فقط عند نجاح الإرسال).
      if (r.ok) await logOutbound(sb, c.id, c.whatsapp, displayBody, r.id);
      if (!r.ok && stopOnError) { halted = true; lastError = r.error; break; }
      await sleep(SEND_DELAY_MS);
    }
  } finally {
    await releaseLock(sb, camp.id);
  }

  // توقّف فوري عند أي خطأ (بطلب المستخدم): نوقف الحملة ولا نُسلسل.
  if (halted) {
    await sb.from("b2b_campaigns").update({ status: "paused" }).eq("id", camp.id);
    console.log("b2b-send halted on error:", lastError);
    return;
  }

  // دفعة محدودة (تجريبية): لا نُسلسل — نترك الحملة «sending» للاستكمال اليدوي.
  if (noChain) {
    await sb.from("b2b_campaigns").update({ status: "sending" }).eq("id", camp.id);
    return;
  }

  if (pending.length > BATCH_SIZE) {
    // الدفعة التالية: استدعاء ذاتي يرد فوراً ويعمل في خلفيته (لا تتراكم مدة التشغيل).
    const jwt = Deno.env.get("LEGACY_ANON_JWT") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    try {
      await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/b2b-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: jwt, "x-admin-secret": adminSecret },
        body: JSON.stringify({ campaign_id: camp.id, stop_on_error: stopOnError }),
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

  let reqBody: any = {};
  try { reqBody = await req.json(); } catch (_) { /* */ }
  const campaign_id = String(reqBody?.campaign_id || "");
  const limit = Number(reqBody?.limit) || 0;              // دفعة محدودة (تجربة) — 0 = الكل بالتسلسل
  const stopOnError = reqBody?.stop_on_error === true;    // الوقف الفوري عند أي خطأ
  if (!campaign_id) return json({ ok: false, error: "campaign_id مطلوب" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: camp, error: cErr } = await sb.from("b2b_campaigns").select("*").eq("id", campaign_id).maybeSingle();
  if (cErr || !camp) return json({ ok: false, error: "حملة غير موجودة" }, 404);

  // تحديث المحادثات الموجودة (backfill): يستبدل نص الرسائل الصادرة المُسجّلة من الحملة
  // بالنص الحالي (_display_body) — بدون إرسال أي رسالة جديدة.
  if (reqBody?.backfill === true) {
    const display = String(camp.filters?._display_body || "");
    if (!display) return json({ ok: false, error: "لا يوجد نص (_display_body) للتحديث" }, 400);
    const { data: updated, error: uErr } = await sb.from("b2b_messages")
      .update({ body: display })
      .eq("direction", "out")
      .like("body", "🖼️ [صورة بوستر المغرب]%")
      .select("id");
    if (uErr) return json({ ok: false, error: uErr.message }, 500);
    return json({ ok: true, backfilled: (updated || []).length });
  }

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

  const work = runBatch(sb, camp, pending, adminSecret, { limit, stopOnError });
  // @ts-ignore EdgeRuntime injected by Supabase
  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(work);
  else await work;

  const thisBatch = limit > 0 ? Math.min(limit, BATCH_SIZE, pending.length) : Math.min(BATCH_SIZE, pending.length);
  return json({ ok: true, started: true, total, remaining: pending.length, batch: thisBatch, stop_on_error: stopOnError });
});
