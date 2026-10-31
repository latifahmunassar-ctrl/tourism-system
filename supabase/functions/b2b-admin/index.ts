/**
 * b2b-admin — واجهة إدارة «واتساب شركات» (لوحة التسويق → العلاقات العامة).
 *
 * جداول B2B مقفلة بـ RLS (053)، فاللوحة تقرأ/تكتب عبر هذه الدالة بمفتاح الخدمة.
 * البوابة: ترويسة x-admin-secret مطابِقة للسر B2B_ADMIN_SECRET (مغلقة إن لم يُضبط).
 *
 * POST { action, ...params }:
 *   companies.list | companies.save {company} | companies.delete {id} | companies.import {rows[]}
 *   campaigns.list | campaigns.save {campaign} | campaigns.delete {id}
 *   campaigns.messages {campaign_id} | campaigns.preview {filters} (عدد الشركات المطابقة)
 *   templates.list  → قوالب WABA المعتمدة (للاختيار في الحملة)
 *   templates.create {name, language, category, components[], settings_key?} → إنشاء قالب WABA
 *   inbox.list | inbox.messages {conversation_id} | inbox.reply {conversation_id, body}
 *   inbox.auto_reply {conversation_id, auto_reply}
 *   profile.get | profile.update {about, description, vertical, websites[], email, address, profile_picture_b64?, profile_picture_mime?}
 *   settings.get | settings.save {key, value}
 *
 * ⚠️ يرسل من رقم B2B فقط (1323027874234661) — لا يمسّ رقم السياحة.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GRAPH_VERSION = "v22.0";
const B2B_PHONE_NUMBER_ID = "1323027874234661";
const B2B_WABA_ID = "1338474844901989";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret, Authorization, apikey",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

// نفس توحيد b2b-talal: أرقام فقط مع «+» (مفتاح المحادثة والشركة).
function normWa(raw: string): string {
  const d = String(raw || "").replace(/[^\d]/g, "");
  return d ? "+" + d : "";
}

const COMPANY_FIELDS = ["name", "contact_name", "whatsapp", "country", "destinations", "category", "status", "notes"];
function cleanCompany(c: any) {
  const out: Record<string, unknown> = {};
  for (const k of COMPANY_FIELDS) if (k in (c || {})) out[k] = c[k];
  if ("whatsapp" in out) out.whatsapp = normWa(String(out.whatsapp || "")) || null;
  if ("destinations" in out) {
    const d = out.destinations;
    out.destinations = (Array.isArray(d) ? d : String(d || "").split(/[,،]/)).map((s) => String(s).trim()).filter(Boolean);
  }
  for (const k of ["country", "category", "contact_name", "notes"]) {
    if (k in out) out[k] = String(out[k] ?? "").trim() || null;
  }
  return out;
}

// ⚠️ Supabase يرجّع 1000 صف كحد أقصى — نرقّم الصفحات بـ range() لجلب الكل (قوائم الآلاف).
const PAGE = 1000;
async function selectAll(sb: any, table: string, columns: string, apply?: (q: any) => any) {
  let from = 0; const out: any[] = [];
  for (;;) {
    let q = sb.from(table).select(columns);
    if (apply) q = apply(q);
    q = q.order("id", { ascending: true }); // مفتاح ترتيب ثابت — ضروري لثبات ترقيم الصفحات
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const adminSecret = Deno.env.get("B2B_ADMIN_SECRET") || "";
  if (!adminSecret || req.headers.get("x-admin-secret") !== adminSecret) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  let p: any = {};
  try { p = await req.json(); } catch (_) { /* */ }
  const action = String(p?.action || "");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";

  try {
    switch (action) {
      // ── الشركات ──────────────────────────────────────────────────────────
      case "companies.list": {
        const data = await selectAll(sb, "b2b_companies", "*", (q: any) => q.order("created_at", { ascending: false }));
        return json({ ok: true, companies: data });
      }
      case "companies.save": {
        const c = cleanCompany(p.company);
        if (!String(c.name || "").trim()) return json({ ok: false, error: "اسم الشركة مطلوب" }, 400);
        const q = p.company?.id
          ? sb.from("b2b_companies").update(c).eq("id", p.company.id)
          : sb.from("b2b_companies").insert(c);
        const { data, error } = await q.select("*").single();
        if (error) throw error;
        // ربط محادثة قائمة بنفس الرقم إن لم تكن مربوطة
        if (data?.whatsapp) {
          await sb.from("b2b_conversations").update({ company_id: data.id })
            .eq("whatsapp", data.whatsapp).is("company_id", null);
        }
        return json({ ok: true, company: data });
      }
      case "companies.delete": {
        const { error } = await sb.from("b2b_companies").delete().eq("id", String(p.id || ""));
        if (error) throw error;
        return json({ ok: true });
      }
      case "companies.delete_many": {
        // حذف جماعي بقائمة معرّفات صريحة (استدعاء واحد).
        const ids = Array.isArray(p.ids) ? p.ids.map((x: any) => String(x)).filter(Boolean) : [];
        if (!ids.length) return json({ ok: false, error: "ids مطلوبة" }, 400);
        for (let i = 0; i < ids.length; i += 150) {
          const { error } = await sb.from("b2b_companies").delete().in("id", ids.slice(i, i + 150));
          if (error) throw error;
        }
        return json({ ok: true, requested: ids.length });
      }
      case "companies.dedupe": {
        // إزالة التكرار بحسب رقم الواتساب المطبّع (يبقي الأقدم، يحذف الباقي) عبر كل الجدول.
        const all = await selectAll(sb, "b2b_companies", "id, whatsapp, created_at");
        all.sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
        const seen = new Set<string>(); const toDelete: string[] = [];
        for (const r of all) {
          const key = String(r.whatsapp || "").replace(/\D/g, "");
          if (!key) continue;
          if (seen.has(key)) toDelete.push(r.id); else seen.add(key);
        }
        for (let i = 0; i < toDelete.length; i += 150) {
          const { error } = await sb.from("b2b_companies").delete().in("id", toDelete.slice(i, i + 150));
          if (error) throw error;
        }
        return json({ ok: true, removed: toDelete.length });
      }
      case "companies.purge": {
        // حذف جماعي بحسب الدولة (لإعادة استيراد قائمة منقّحة). يحذف كل المطابق على دفعات.
        const country = String(p.country || "").trim();
        if (!country) return json({ ok: false, error: "country مطلوب" }, 400);
        const all = await selectAll(sb, "b2b_companies", "id", (q: any) => q.eq("country", country));
        const ids = all.map((r: any) => r.id);
        const CHUNK = 150; // UUIDs طويلة — دفعة صغيرة حتى لا يتجاوز رابط الطلب الحد
        for (let i = 0; i < ids.length; i += CHUNK) {
          const { error } = await sb.from("b2b_companies").delete().in("id", ids.slice(i, i + CHUNK));
          if (error) throw error;
        }
        return json({ ok: true, deleted: ids.length });
      }
      case "companies.import": {
        const rows = (Array.isArray(p.rows) ? p.rows : []).map(cleanCompany)
          .filter((r: any) => String(r.name || "").trim());
        if (!rows.length) return json({ ok: false, error: "لا صفوف صالحة" }, 400);
        // تخطّي الأرقام الموجودة مسبقاً (منع التكرار) — بترقيم صفحات لتفادي سقف 1000
        const existing = await selectAll(sb, "b2b_companies", "whatsapp", (q: any) => q.not("whatsapp", "is", null));
        const seen = new Set((existing || []).map((e: any) => e.whatsapp));
        const fresh = rows.filter((r: any) => {
          if (!r.whatsapp) return true;
          if (seen.has(r.whatsapp)) return false;
          seen.add(r.whatsapp);
          return true;
        });
        if (fresh.length) {
          const { error } = await sb.from("b2b_companies").insert(fresh);
          if (error) throw error;
        }
        return json({ ok: true, inserted: fresh.length, skipped: rows.length - fresh.length });
      }

      // ── الحملات ──────────────────────────────────────────────────────────
      case "campaigns.list": {
        const { data: camps, error } = await sb.from("b2b_campaigns").select("*").order("created_at", { ascending: false });
        if (error) throw error;
        const msgs = await selectAll(sb, "b2b_campaign_messages", "campaign_id, status");
        const stats: Record<string, Record<string, number>> = {};
        for (const m of msgs || []) {
          const s = (stats[m.campaign_id] ||= {});
          s[m.status || "pending"] = (s[m.status || "pending"] || 0) + 1;
        }
        return json({ ok: true, campaigns: (camps || []).map((c: any) => ({ ...c, stats: stats[c.id] || {} })) });
      }
      case "campaigns.save": {
        const c = p.campaign || {};
        const row = {
          name: String(c.name || "").trim(),
          template_name: String(c.template_name || "").trim() || null,
          template_lang: String(c.template_lang || "ar").trim(),
          filters: c.filters || {},
        };
        if (!row.name) return json({ ok: false, error: "اسم الحملة مطلوب" }, 400);
        const q = c.id ? sb.from("b2b_campaigns").update(row).eq("id", c.id) : sb.from("b2b_campaigns").insert(row);
        const { data, error } = await q.select("*").single();
        if (error) throw error;
        return json({ ok: true, campaign: data });
      }
      case "campaigns.delete": {
        const { error } = await sb.from("b2b_campaigns").delete().eq("id", String(p.id || ""));
        if (error) throw error;
        return json({ ok: true });
      }
      case "campaigns.messages": {
        const data = await selectAll(sb, "b2b_campaign_messages",
          "id, status, error, sent_at, updated_at, b2b_companies(name, whatsapp)",
          (q: any) => q.eq("campaign_id", String(p.campaign_id || "")).order("sent_at", { ascending: false }));
        return json({ ok: true, messages: data });
      }
      case "campaigns.preview": {
        // نفس منطق الاستهداف في b2b-send
        const f = p.filters || {};
        let q = sb.from("b2b_companies").select("id", { count: "exact", head: true }).not("whatsapp", "is", null);
        if (f.country) q = q.eq("country", f.country);
        if (f.category) q = q.eq("category", f.category);
        if (Array.isArray(f.destinations) && f.destinations.length) q = q.overlaps("destinations", f.destinations);
        const { count, error } = await q;
        if (error) throw error;
        return json({ ok: true, count: count || 0 });
      }
      case "templates.list": {
        const res = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_WABA_ID}/message_templates?fields=name,language,status,category,components&limit=100`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return json({ ok: false, error: data?.error?.message || `HTTP ${res.status}` }, 502);
        return json({ ok: true, templates: data?.data || [] });
      }
      case "templates.create": {
        const name = String(p.name || "").trim();
        const language = String(p.language || "ar").trim();
        const category = String(p.category || "MARKETING").trim().toUpperCase();
        const components = Array.isArray(p.components) ? p.components : [];
        if (!name || !components.length) return json({ ok: false, error: "name و components مطلوبة" }, 400);
        const res = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_WABA_ID}/message_templates`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name, language, category, components }),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return json({ ok: false, error: data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}`, raw: data?.error || null }, 502);
        }
        // سجّل اسم القالب في b2b_settings إن طُلب (مثل template_intro)
        const settingsKey = String(p.settings_key || "").trim();
        if (settingsKey) {
          try { await sb.from("b2b_settings").upsert({ key: settingsKey, value: name }); } catch (_) { /* best-effort */ }
        }
        return json({ ok: true, id: data?.id || "", status: data?.status || "", category: data?.category || category, settings_key: settingsKey || null });
      }

      // رفع صورة نموذجية والحصول على header_handle لإنشاء قالب بهيدر صورة.
      // يجلب الصورة من رابط عام ثم يرفعها عبر Resumable Upload ويرجّع الـ handle.
      case "templates.upload_header": {
        const imageUrl = String(p.image_url || "").trim();
        if (!imageUrl) return json({ ok: false, error: "image_url مطلوب" }, 400);
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) return json({ ok: false, error: `تعذّر جلب الصورة HTTP ${imgRes.status}` }, 502);
        const buf = new Uint8Array(await imgRes.arrayBuffer());
        const mime = (imgRes.headers.get("content-type") || "image/jpeg").split(";")[0];
        const appRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/app?access_token=${encodeURIComponent(token)}`);
        const appId = (await appRes.json().catch(() => ({})))?.id;
        if (!appId) return json({ ok: false, error: "تعذّر جلب معرّف تطبيق Meta" }, 502);
        const startRes = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads?file_length=${buf.length}&file_type=${encodeURIComponent(mime)}&access_token=${encodeURIComponent(token)}`,
          { method: "POST" },
        );
        const sessionId = (await startRes.json().catch(() => ({})))?.id;
        if (!sessionId) return json({ ok: false, error: "فشل بدء رفع الصورة" }, 502);
        const upRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${sessionId}`, {
          method: "POST",
          headers: { Authorization: `OAuth ${token}`, file_offset: "0" },
          body: buf,
        });
        const upData = await upRes.json().catch(() => ({}));
        if (!upData?.h) return json({ ok: false, error: upData?.error?.message || "فشل رفع الصورة", raw: upData?.error || null }, 502);
        return json({ ok: true, handle: upData.h, bytes: buf.length, mime });
      }

      // ── إرسال اختباري لقالب (مع دعم متغيّرات الـBody) ────────────────────
      case "templates.test_send": {
        const to = String(p.to || "").replace(/\D/g, "");
        const name = String(p.name || "");
        const lang = String(p.lang || "ar");
        const params = Array.isArray(p.params) ? p.params : [];
        if (!to || !name) return json({ ok: false, error: "to و name مطلوبة" }, 400);
        const template: any = { name, language: { code: lang } };
        const comps: any[] = [];
        if (p.image) comps.push({ type: "header", parameters: [{ type: "image", image: { link: String(p.image) } }] });
        if (params.length) comps.push({ type: "body", parameters: params.map((v: any) => ({ type: "text", text: String(v) })) });
        if (comps.length) template.components = comps;
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
        });
        const data = await res.json().catch(() => ({}));
        const id = data?.messages?.[0]?.id || "";
        if (!id) return json({ ok: false, error: data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}` }, 502);
        return json({ ok: true, id });
      }

      // ── تشخيص أهلية/فوترة WABA رقم B2B ──────────────────────────────────
      case "waba.info": {
        const wres = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_WABA_ID}?fields=id,name,account_review_status,primary_funding_id,health_status`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const waba = await wres.json().catch(() => ({}));
        const pres = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating,status,platform_type,throughput`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const phone = await pres.json().catch(() => ({}));
        return json({ ok: true, waba, phone });
      }

      // ── بروفايل واتساب الأعمال (رقم B2B فقط) ─────────────────────────────
      case "profile.get": {
        const res = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/whatsapp_business_profile?fields=about,address,description,email,vertical,websites,profile_picture_url`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return json({ ok: false, error: data?.error?.message || `HTTP ${res.status}` }, 502);
        return json({ ok: true, profile: (data?.data && data.data[0]) || data });
      }
      case "profile.update": {
        const fields: Record<string, unknown> = { messaging_product: "whatsapp" };
        for (const k of ["about", "address", "description", "email", "vertical"]) {
          if (p[k] !== undefined) fields[k] = p[k];
        }
        if (Array.isArray(p.websites)) fields.websites = p.websites;
        // صورة بروفايل (اختياري): base64 → رفع resumable عبر /{app}/uploads → handle.
        // معرّف التطبيق يُجلب من التوكن نفسه عبر GET /app (لا نحتاج نخزّنه).
        if (p.profile_picture_b64) {
          const appRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/app?access_token=${encodeURIComponent(token)}`);
          const appData = await appRes.json().catch(() => ({}));
          const appId = appData?.id;
          if (!appId) return json({ ok: false, error: "تعذّر جلب معرّف تطبيق Meta من التوكن", raw: appData?.error || null }, 502);
          const bin = Uint8Array.from(atob(String(p.profile_picture_b64)), (c) => c.charCodeAt(0));
          const mime = String(p.profile_picture_mime || "image/png");
          const startRes = await fetch(
            `https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads?file_length=${bin.length}&file_type=${encodeURIComponent(mime)}&access_token=${encodeURIComponent(token)}`,
            { method: "POST" },
          );
          const startData = await startRes.json().catch(() => ({}));
          const sessionId = startData?.id; // «upload:XXXX»
          if (!sessionId) return json({ ok: false, error: startData?.error?.message || "فشل بدء رفع الصورة" }, 502);
          const upRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${sessionId}`, {
            method: "POST",
            headers: { Authorization: `OAuth ${token}`, file_offset: "0" },
            body: bin,
          });
          const upData = await upRes.json().catch(() => ({}));
          if (!upData?.h) return json({ ok: false, error: upData?.error?.message || "فشل رفع الصورة", raw: upData?.error || null }, 502);
          fields.profile_picture_handle = upData.h;
        }
        const res = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/whatsapp_business_profile`,
          { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(fields) },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) {
          return json({ ok: false, error: data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}`, raw: data?.error || null }, 502);
        }
        return json({ ok: true, result: data, picture: !!fields.profile_picture_handle });
      }

      // ── الوارد ───────────────────────────────────────────────────────────
      case "inbox.list": {
        const { data: convs, error } = await sb.from("b2b_conversations")
          .select("*, b2b_companies(name, contact_name)").order("last_message_at", { ascending: false }).limit(200);
        if (error) throw error;
        // آخر رسالة لكل محادثة (للمعاينة)
        const ids = (convs || []).map((c: any) => c.id);
        const last: Record<string, any> = {};
        if (ids.length) {
          const { data: msgs } = await sb.from("b2b_messages").select("conversation_id, direction, body, created_at")
            .in("conversation_id", ids).order("created_at", { ascending: false }).limit(1000);
          for (const m of msgs || []) if (!last[m.conversation_id]) last[m.conversation_id] = m;
        }
        return json({ ok: true, conversations: (convs || []).map((c: any) => ({ ...c, last: last[c.id] || null })) });
      }
      case "inbox.messages": {
        const { data, error } = await sb.from("b2b_messages").select("*")
          .eq("conversation_id", String(p.conversation_id || "")).order("created_at", { ascending: true });
        if (error) throw error;
        return json({ ok: true, messages: data });
      }
      case "inbox.reply": {
        const body = String(p.body || "").trim();
        if (!body) return json({ ok: false, error: "النص فارغ" }, 400);
        const { data: conv } = await sb.from("b2b_conversations").select("*").eq("id", String(p.conversation_id || "")).maybeSingle();
        if (!conv) return json({ ok: false, error: "محادثة غير موجودة" }, 404);
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: conv.whatsapp.replace(/^\+/, ""), type: "text", text: { body } }),
        });
        const data = await res.json().catch(() => ({}));
        const waId = data?.messages?.[0]?.id || "";
        if (!waId) {
          // غالباً: انتهت نافذة ٢٤ ساعة → يلزم قالب
          return json({ ok: false, error: data?.error?.message || `HTTP ${res.status}` }, 502);
        }
        const { data: msg } = await sb.from("b2b_messages").insert({
          conversation_id: conv.id, direction: "out", body, wa_message_id: waId, status: "sent",
        }).select("*").single();
        await sb.from("b2b_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
        return json({ ok: true, message: msg });
      }
      case "inbox.send_image": {
        // إرسال رسالة صورة (مع تعليق اختياري) داخل نافذة ٢٤ ساعة.
        const link = String(p.image || p.link || "").trim();
        if (!link) return json({ ok: false, error: "رابط الصورة مطلوب" }, 400);
        const caption = String(p.caption || p.body || "").trim().slice(0, 1024);
        const { data: conv } = await sb.from("b2b_conversations").select("*").eq("id", String(p.conversation_id || "")).maybeSingle();
        if (!conv) return json({ ok: false, error: "محادثة غير موجودة" }, 404);
        const image: Record<string, unknown> = { link };
        if (caption) image.caption = caption;
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: conv.whatsapp.replace(/^\+/, ""), type: "image", image }),
        });
        const data = await res.json().catch(() => ({}));
        const waId = data?.messages?.[0]?.id || "";
        if (!waId) {
          return json({ ok: false, error: data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}` }, 502);
        }
        const { data: msg } = await sb.from("b2b_messages").insert({
          conversation_id: conv.id, direction: "out", body: caption || "[صورة]", wa_message_id: waId, status: "sent",
        }).select("*").single();
        await sb.from("b2b_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
        return json({ ok: true, message: msg });
      }
      case "inbox.auto_reply": {
        const { error } = await sb.from("b2b_conversations").update({ auto_reply: !!p.auto_reply })
          .eq("id", String(p.conversation_id || ""));
        if (error) throw error;
        return json({ ok: true });
      }
      case "inbox.delete": {
        // حذف المحادثة ورسائلها نهائياً (تختفي من الوارد).
        const id = String(p.conversation_id || "");
        if (!id) return json({ ok: false, error: "conversation_id مطلوب" }, 400);
        await sb.from("b2b_messages").delete().eq("conversation_id", id);
        const { error } = await sb.from("b2b_conversations").delete().eq("id", id);
        if (error) throw error;
        return json({ ok: true });
      }

      // ── الإعدادات ────────────────────────────────────────────────────────
      case "settings.get": {
        const { data, error } = await sb.from("b2b_settings").select("*");
        if (error) throw error;
        return json({ ok: true, settings: Object.fromEntries((data || []).map((r: any) => [r.key, r.value])) });
      }
      case "settings.save": {
        const key = String(p.key || "");
        if (!["talal_system_prompt", "admin_whatsapp", "admin_whatsapp_link", "template_intro"].includes(key)) {
          return json({ ok: false, error: "مفتاح غير مسموح" }, 400);
        }
        const { error } = await sb.from("b2b_settings").upsert({ key, value: String(p.value ?? "") });
        if (error) throw error;
        return json({ ok: true });
      }
    }
    return json({ ok: false, error: "action غير معروف" }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as any)?.message || String(e) }, 500);
  }
});
