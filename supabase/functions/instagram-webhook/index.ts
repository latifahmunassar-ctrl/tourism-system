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

Deno.serve(async (req) => {
  const url = new URL(req.url);

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
