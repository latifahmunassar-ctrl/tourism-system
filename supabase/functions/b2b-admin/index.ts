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
 *   inbox.list | inbox.messages {conversation_id} | inbox.reply {conversation_id, body}
 *   inbox.auto_reply {conversation_id, auto_reply}
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
        const { data, error } = await sb.from("b2b_companies").select("*").order("created_at", { ascending: false });
        if (error) throw error;
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
      case "companies.import": {
        const rows = (Array.isArray(p.rows) ? p.rows : []).map(cleanCompany)
          .filter((r: any) => String(r.name || "").trim());
        if (!rows.length) return json({ ok: false, error: "لا صفوف صالحة" }, 400);
        // تخطّي الأرقام الموجودة مسبقاً (منع التكرار)
        const { data: existing } = await sb.from("b2b_companies").select("whatsapp").not("whatsapp", "is", null);
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
        const { data: msgs } = await sb.from("b2b_campaign_messages").select("campaign_id, status");
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
        const { data, error } = await sb.from("b2b_campaign_messages")
          .select("id, status, error, sent_at, updated_at, b2b_companies(name, whatsapp)")
          .eq("campaign_id", String(p.campaign_id || "")).order("sent_at", { ascending: false });
        if (error) throw error;
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
      case "inbox.auto_reply": {
        const { error } = await sb.from("b2b_conversations").update({ auto_reply: !!p.auto_reply })
          .eq("id", String(p.conversation_id || ""));
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
        if (!["talal_system_prompt", "admin_whatsapp", "admin_whatsapp_link"].includes(key)) {
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
