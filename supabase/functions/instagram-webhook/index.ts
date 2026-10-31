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

// رابط الرجوع العام المسجَّل في Meta. ⚠️ لا نبنيه من url.origin/url.pathname —
//   داخل Supabase Edge يصل الطلب كـ http:// وبمسار مقصوص (/instagram-webhook بلا
//   /functions/v1) فينتج رابط خاطئ يرفضه إنستقرام. نثبّت الرابط العام الصحيح
//   (قابل للتجاوز بسرّ IG_OAUTH_REDIRECT). مسار نظيف بلا query لأن إنستقرام يرفض
//   الـquery في redirect_uri.
const PUBLIC_FN_BASE = "https://ofotvacszlmrqxzfjmtn.supabase.co/functions/v1/instagram-webhook";
function oauthRedirectUri(): string {
  return (Deno.env.get("IG_OAUTH_REDIRECT") || `${PUBLIC_FN_BASE}/oauth-callback`).trim();
}
// صفحة HTML بسيطة بالعربية تُعرَض للمالكة بعد (أو أثناء) إعادة الربط.
function htmlPage(title: string, body: string): Response {
  const h = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:440px;padding:30px;background:#1e293b;border-radius:16px;text-align:center;line-height:1.8"><h2 style="margin:0 0 12px">${title}</h2><p style="color:#94a3b8;margin:0">${body}</p></div></body></html>`;
  return new Response(h, { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
}

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

  // رابط رجوع OAuth بلا query (مسار نظيف) — إنستقرام يرفض redirect_uri فيه
  //   باراميترات query، فنستخدم مقطع مسار «/oauth-callback» ونكتشفه من pathname.
  const action = url.searchParams.get("action")
    || (url.pathname.endsWith("/oauth-callback") ? "oauth_callback" : null);

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
    // نحاول الإرسال العادي أولاً (داخل نافذة الـ ٢٤ ساعة). لو رفض إنستقرام
    // بسبب انتهاء النافذة، نعيد المحاولة تلقائياً بوسم HUMAN_AGENT الذي يمدّ
    // نافذة الرد إلى ٧ أيام للردود البشرية على استفسارات العملاء
    // (يتطلب تفعيل ميزة Human Agent / صلاحية human_agent في تطبيق ميتا).
    const IG_SEND_URL = "https://graph.instagram.com/v23.0/me/messages";
    const igPost = async (humanAgent: boolean) => {
      const payload: Record<string, unknown> = humanAgent
        ? { recipient: { id: recipient }, message: { text }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
        : { recipient: { id: recipient }, message: { text } };
      const res = await fetch(IG_SEND_URL, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      return { res, j };
    };
    // هل الخطأ سببه خروج عن نافذة الرسائل المسموحة (٢٤ ساعة)؟
    const isWindowErr = (e: any) =>
      e?.code === 10 || /outside|window|allowed|24|two.?day|48/i.test(e?.message || "");

    let sendRes: Response, sendJson: any;
    let usedHumanAgent = false;
    ({ res: sendRes, j: sendJson } = await igPost(false));
    if (!sendRes.ok && isWindowErr(sendJson?.error || {})) {
      // انتهت نافذة الـ ٢٤ ساعة — أعِد المحاولة بوسم Human Agent (حتى ٧ أيام).
      usedHumanAgent = true;
      ({ res: sendRes, j: sendJson } = await igPost(true));
    }
    if (!sendRes.ok) {
      const err = sendJson?.error || {};
      const emsg = String(err?.message || "");
      // خطأ صلاحية Human Agent غير مفعّلة (يحتاج App Review / Advanced Access).
      const permIssue = usedHumanAgent &&
        /permission|human_agent|not have|approved|advanced access|standard access|#200|#10\b.*tag/i.test(emsg);
      const outside = isWindowErr(err);
      return json({
        error: permIssue
          ? ("ميزة Human Agent غير مفعّلة في تطبيق ميتا — فعّليها لتمديد الرد إلى ٧ أيام (" + emsg + ")")
          : outside
            ? "انتهت نافذة الرد (٧ أيام). لا يمكن الإرسال حتى يرسل العميل رسالة جديدة."
            : ("تعذّر الإرسال: " + (emsg || ("http " + sendRes.status))),
        window_closed: outside,
        needs_human_agent: permIssue,
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

  // ── OAuth «إعادة ربط بنقرة»: بدء تسجيل الدخول في Meta ──────────────────────
  // تفتحها المالكة من الداشبورد (نافذة جديدة). تحوّل المتصفح لصفحة موافقة إنستقرام.
  // صلاحيات: أساسية + إدارة رسائل الأعمال (للرد على الـ DM).
  if (action === "oauth_start") {
    const appId = (Deno.env.get("IG_APP_ID") || "").trim();
    if (!appId) return htmlPage("إعداد ناقص", "لم يُضبط IG_APP_ID في أسرار Supabase بعد.");
    const redirect = oauthRedirectUri();
    const scope = "instagram_business_basic,instagram_business_manage_messages";
    const state = crypto.randomUUID();
    const auth = `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1`
      + `&client_id=${encodeURIComponent(appId)}`
      + `&redirect_uri=${encodeURIComponent(redirect)}`
      + `&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
    return new Response(null, { status: 302, headers: { ...CORS, Location: auth } });
  }

  // ── OAuth: رجوع Meta بعد الموافقة — نبدّل الكود بتوكن طويل (٦٠ يوم) ونخزّنه ──
  if (action === "oauth_callback") {
    const appId = (Deno.env.get("IG_APP_ID") || "").trim();
    const appSecret = (Deno.env.get("IG_APP_SECRET") || "").trim();
    const redirect = oauthRedirectUri();
    const oErr = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (oErr) return htmlPage("تعذّر الربط", "رفض Meta الطلب: " + oErr);
    const code = url.searchParams.get("code") || "";
    if (!code) return htmlPage("تعذّر الربط", "لم يصل كود التفويض من Meta.");
    if (!appId || !appSecret) return htmlPage("إعداد ناقص", "اضبطي IG_APP_ID و IG_APP_SECRET في أسرار Supabase.");
    try {
      // 1) الكود → توكن قصير المدى (+ user_id للحساب).
      const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: appId, client_secret: appSecret,
          grant_type: "authorization_code", redirect_uri: redirect, code,
        }),
      });
      const shortJ: any = await shortRes.json().catch(() => ({}));
      if (!shortRes.ok || !shortJ.access_token) {
        return htmlPage("تعذّر الربط", "فشل تبديل الكود: " + JSON.stringify(shortJ).slice(0, 300));
      }
      // 2) التوكن القصير → توكن طويل المدى (~٦٠ يوم).
      const longRes = await fetch(
        "https://graph.instagram.com/access_token?grant_type=ig_exchange_token"
        + `&client_secret=${encodeURIComponent(appSecret)}`
        + `&access_token=${encodeURIComponent(shortJ.access_token)}`);
      const longJ: any = await longRes.json().catch(() => ({}));
      if (!longRes.ok || !longJ.access_token) {
        return htmlPage("تعذّر الربط", "فشل التوكن الطويل: " + JSON.stringify(longJ).slice(0, 300));
      }
      const longTok = String(longJ.access_token);
      const days = longJ.expires_in ? Math.round(Number(longJ.expires_in) / 86400) : 60;
      // 3) هوية الحساب (user_id + username) لمطابقة الصف الصحيح.
      const meRes = await fetch(
        `https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(longTok)}`);
      const meJ: any = await meRes.json().catch(() => ({}));
      const igId = String(meJ.user_id || shortJ.user_id || "");
      const uname = String(meJ.username || "");
      if (!igId) return htmlPage("تعذّر الربط", "لم نتعرّف على معرّف الحساب من Meta.");
      // 4) خزّن التوكن الجديد (upsert على ig_account_id).
      const supabase = supaRead();
      const row: Record<string, unknown> = { ig_account_id: igId, access_token: longTok };
      if (uname) row.username = uname;
      const { error } = await supabase.from("ig_accounts").upsert(row, { onConflict: "ig_account_id" });
      if (error) return htmlPage("تعذّر الحفظ", error.message);
      return htmlPage("تم الربط ✅",
        `تم تحديث توكن حساب <b>${uname || igId}</b> — صالح ~${days} يوم.<br>تقدرين تقفلين هذه الصفحة وترجعين للداشبورد.`);
    } catch (e) {
      return htmlPage("خطأ", (e as Error).message);
    }
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
