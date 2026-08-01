/**
 * instagram-webhook — استقبال رسائل إنستقرام Direct من ميتا.
 *
 * GET  : تحقق ميتا (hub.mode/hub.verify_token/hub.challenge) — IG_VERIFY_TOKEN.
 * POST : أحداث الرسائل (object=instagram) → تُخزَّن في instagram_messages.
 *
 * مبدأ مهم: نُرجع 200 دائماً وبسرعة حتى عند خطأ التخزين — ميتا تعيد المحاولة
 * وتوقف الويبهوك لو تكرر الفشل. الأخطاء تُسجَّل في console فقط.
 *
 * verify_jwt = false (ميتا لا ترسل JWT). الكتابة عبر SERVICE_ROLE_KEY.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS لواجهة داشبورد الواتساب (madartrip.com) عند قراءة المحادثات.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-secret",
  "Cache-Control": "no-store",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// بوابة القراءة الإدارية: نقبل مفتاح صندوق الطلبات (CLIENT_ADMIN_SECRET) أو كلمة
// البوابة المشتركة (APP_PASSWORD) — نفس ما يخزّنه داشبورد الواتساب في alezz_admin_secret.
function adminOk(req: Request): boolean {
  const got = (req.headers.get("x-admin-secret") || "").trim();
  if (!got) return false;
  const a = (Deno.env.get("CLIENT_ADMIN_SECRET") || "").trim();
  const b = (Deno.env.get("APP_PASSWORD") || "").trim();
  return (!!a && got === a) || (!!b && got === b);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supaRead = () => createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const action = url.searchParams.get("action");

  // ── إرسال رد إنستقرام (Send API) — نافذة الـ 24 ساعة يفرضها إنستقرام خادميّاً ──
  if (action === "send") {
    if (req.method !== "POST") return json({ error: "POST required" }, 405);
    if (!adminOk(req)) return json({ error: "unauthorized" }, 401);
    let b: any = {};
    try { b = await req.json(); } catch (_e) { /* */ }
    const acct = String(b.account || "").trim();          // ig_account_id (حسابنا)
    const recipient = String(b.recipient || "").trim();    // sender_igsid (العميل)
    const text = String(b.text || "").trim();
    if (!acct || !recipient || !text) return json({ error: "account & recipient & text required" }, 400);

    const supabase = supaRead();
    const { data: acctRow } = await supabase.from("ig_accounts")
      .select("ig_account_id, access_token").eq("ig_account_id", acct).maybeSingle();
    const token = (acctRow as any)?.access_token;
    if (!token) return json({ error: "لا يوجد توكن محفوظ لهذا الحساب" }, 400);

    // Instagram Send API: POST /me/messages بتوكن الحساب.
    const sendRes = await fetch("https://graph.instagram.com/v23.0/me/messages", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipient }, message: { text } }),
    });
    const sendJson = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      const err = sendJson?.error || {};
      // خطأ نافذة الـ 24 ساعة (خارج نافذة الرسائل المسموحة).
      const outside = err?.code === 10 || /24|outside|window|allowed/i.test(err?.message || "");
      return json({
        error: outside
          ? "انتهت نافذة الرد (٢٤ ساعة). لا يمكن الإرسال حتى يرسل العميل رسالة جديدة."
          : ("تعذّر الإرسال: " + (err?.message || ("http " + sendRes.status))),
        window_closed: outside,
      }, 400);
    }

    // تخزين الرد كصف صادر ضمن نفس المحادثة (sender_igsid = العميل ليبقى مجمّعاً).
    const mid = String(sendJson?.message_id || "") || null;
    const nowIso = new Date().toISOString();
    await supabase.from("instagram_messages").insert({
      ig_account_id: acct, sender_igsid: recipient, recipient_id: recipient,
      mid, message_text: text, direction: "outbound", sent_at: nowIso, raw: sendJson,
    });
    return json({ ok: true, message_id: mid, sent_at: nowIso });
  }

  // ── قراءة إدارية: قائمة المحادثات / سجل محادثة واحدة (لداشبورد الواتساب) ──
  if (action === "conversations" || action === "conversation") {
    if (!adminOk(req)) return json({ error: "unauthorized" }, 401);
    const supabase = supaRead();
    const { data: accts } = await supabase.from("ig_accounts").select("ig_account_id, username, country");
    const acctMap: Record<string, { username: string; country: string }> = {};
    for (const a of (accts || []) as Array<any>) acctMap[a.ig_account_id] = { username: a.username, country: a.country };

    // سجل محادثة واحدة (كل الرسائل بين عميل وحساب، تصاعدياً).
    if (action === "conversation") {
      const sender = String(url.searchParams.get("sender") || "");
      const acct = String(url.searchParams.get("account") || "");
      if (!sender || !acct) return json({ error: "sender & account required" }, 400);
      const { data: msgs } = await supabase.from("instagram_messages")
        .select("id, sender_igsid, recipient_id, message_text, direction, sent_at, created_at")
        .eq("ig_account_id", acct).eq("sender_igsid", sender)
        .order("created_at", { ascending: true }).limit(500);
      return json({ ok: true, account: { ig_account_id: acct, ...(acctMap[acct] || {}) }, sender_igsid: sender, messages: msgs || [] });
    }

    // قائمة المحادثات: تُجمَّع بـ (الحساب + المُرسِل)، الأحدث أولاً، مفصولة بالحساب/الدولة.
    const { data: rows } = await supabase.from("instagram_messages")
      .select("ig_account_id, sender_igsid, message_text, direction, created_at")
      .order("created_at", { ascending: false }).limit(3000);
    const conv: Record<string, any> = {};
    for (const r of (rows || []) as Array<any>) {
      const key = r.ig_account_id + "|" + r.sender_igsid;
      let c = conv[key];
      if (!c) {
        const a = acctMap[r.ig_account_id] || { username: r.ig_account_id, country: "" };
        c = conv[key] = {
          ig_account_id: r.ig_account_id, username: a.username, country: a.country,
          sender_igsid: r.sender_igsid, last_text: r.message_text, last_at: r.created_at,
          last_direction: r.direction, count: 0,
        };
      }
      c.count++;   // rows تنازلية: أول ما نشوف المفتاح = الأحدث (فنثبّت last_*)
    }
    const conversations = Object.values(conv).sort((a: any, b: any) => (a.last_at < b.last_at ? 1 : -1));
    return json({ ok: true, accounts: accts || [], conversations });
  }

  // ── GET: تحقق الاشتراك من ميتا ──
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = (Deno.env.get("IG_VERIFY_TOKEN") || "").trim();
    if (mode === "subscribe" && token === expected && expected) {
      return new Response(challenge ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: أحداث الرسائل ──
  if (req.method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch (_e) { /* تجاهل */ }

    try {
      if (body && body.object === "instagram" && Array.isArray(body.entry)) {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        for (const entry of body.entry) {
          const igAccountId = String(entry?.id || "");
          const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
          for (const ev of events) {
            const msg = ev?.message;
            if (!msg || !msg.text) continue;          // نتعامل مع الرسائل النصية فقط
            if (msg.is_echo === true) continue;         // صدى رسائلنا نحن — نتجاهله
            const row = {
              ig_account_id: igAccountId,
              sender_igsid: String(ev?.sender?.id || ""),
              recipient_id: String(ev?.recipient?.id || ""),
              mid: String(msg.mid || ""),
              message_text: String(msg.text || ""),
              direction: "inbound",
              sent_at: ev?.timestamp ? new Date(Number(ev.timestamp)).toISOString() : null,
              raw: ev,
            };
            const { error } = await supabase
              .from("instagram_messages")
              .upsert(row, { onConflict: "mid", ignoreDuplicates: true });
            if (error) console.error("ig insert error:", error.message);
          }
        }
      }
    } catch (e) {
      console.error("ig webhook error:", (e as Error).message);
    }

    // دائماً 200 حتى لو صار خطأ — نمنع ميتا من إيقاف الويبهوك.
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});
