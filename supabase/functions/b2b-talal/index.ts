/**
 * b2b-talal — معالج واتساب الشركات (B2B).
 *
 * يستقبل حمولة ويبهوك Meta كاملة (مُوجّهة من WhatsApp-Router عندما يكون
 * metadata.phone_number_id == رقم B2B). يقوم بـ:
 *   1) حفظ الرسائل الواردة في b2b_messages (+ إنشاء/تحديث b2b_conversations).
 *   2) تحديث حالات التسليم/القراءة في b2b_campaign_messages من statuses[].
 *   3) إن كان auto_reply=true للمحادثة → يرد بشخصية «سارة» عبر Anthropic
 *      (system prompt من b2b_settings) ويرسل عبر Cloud API من رقم B2B.
 *
 * ⚠️ لا يمسّ رقم السياحة (9117 1630) ولا Tourism-AI. يرسل من رقم B2B فقط.
 * منطق الردود مبدئي (هيكل) — يُعدّل لاحقاً.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROJECT_REF = "ofotvacszlmrqxzfjmtn";
const GRAPH_VERSION = "v22.0";
const B2B_PHONE_NUMBER_ID = "1323027874234661"; // رقم الأعمال B2B (نرسل منه)
const AI_MODEL = "claude-sonnet-4-6";

const JSON_HEADERS = { "Content-Type": "application/json" };
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });

// Meta يرسل أرقاماً بلا «+» (مثل 96891171630). نوحّدها لمفتاح واتساب داخلي.
function normWa(raw: string): string {
  const d = String(raw || "").replace(/[^\d]/g, "");
  return d ? "+" + d : "";
}

// إرسال نص عبر Meta Cloud API من رقم B2B.
async function sendText(to: string, body: string): Promise<string> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";
  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${B2B_PHONE_NUMBER_ID}/messages`;
  const graphTo = String(to || "").replace(/^\+/, "");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: graphTo, type: "text", text: { body } }),
  });
  const data = await res.json().catch(() => ({}));
  return data?.messages?.[0]?.id || "";
}

// رد «سارة» عبر Anthropic — system من b2b_settings + سياق آخر الرسائل.
async function talalReply(systemPrompt: string, history: Array<{ role: string; content: string }>): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!key) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: history.map((h) => ({ role: h.role, content: h.content })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    return (data?.content?.[0]?.text || "").trim();
  } catch (_) { return ""; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("b2b-talal OK", { status: 200 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let payload: any;
  try { payload = await req.json(); } catch (_) { return ok(); }

  try {
    for (const entry of (payload?.entry ?? [])) {
      for (const change of (entry?.changes ?? [])) {
        const value = change?.value;
        if (!value) continue;

        // 2) تحديث حالات التسليم/القراءة في b2b_campaign_messages
        for (const st of (value?.statuses ?? [])) {
          const waId = String(st?.id || "");
          if (!waId) continue;
          const status = String(st?.status || "");
          const errTitle = Array.isArray(st?.errors) && st.errors[0]
            ? String(st.errors[0]?.title || st.errors[0]?.message || "") : null;
          try {
            await supabase.from("b2b_campaign_messages")
              .update({ status, error: errTitle, updated_at: new Date().toISOString() })
              .eq("wa_message_id", waId);
          } catch (_) { /* best-effort */ }
        }

        // 1) الرسائل الواردة
        const messages = value?.messages;
        if (!Array.isArray(messages) || messages.length === 0) continue;

        const nameByWaId = new Map<string, string>();
        for (const c of (value?.contacts ?? [])) {
          const wid = String(c?.wa_id || "");
          if (wid) nameByWaId.set(wid, String(c?.profile?.name || ""));
        }

        for (const m of messages) {
          const rawFrom = String(m?.from || "");
          if (!rawFrom) continue;
          const wa = normWa(rawFrom);
          const waMsgId = String(m?.id || "");
          const type = String(m?.type || "");
          // نص الرسالة من النص أو من ضغطة الأزرار:
          //   قالب quick-reply → نوع «button» (m.button.text) · رسالة تفاعلية → «interactive» (button_reply.title)
          let text = "";
          if (type === "text") text = String(m?.text?.body || "");
          else if (type === "button") text = String(m?.button?.text || m?.button?.payload || "");
          else if (type === "interactive") text = String(m?.interactive?.button_reply?.title || m?.interactive?.list_reply?.title || "");
          const body = text || `[${type || "مرفق"}]`;
          const profileName = nameByWaId.get(rawFrom) || "";

          // إنشاء/جلب المحادثة (+ربط شركة إن وُجدت بنفس الرقم)
          let conv: any = null;
          try {
            const { data: existing } = await supabase.from("b2b_conversations")
              .select("*").eq("whatsapp", wa).maybeSingle();
            if (existing) {
              conv = existing;
              await supabase.from("b2b_conversations")
                .update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
            } else {
              let companyId: string | null = null;
              try {
                const { data: comp } = await supabase.from("b2b_companies")
                  .select("id").eq("whatsapp", wa).maybeSingle();
                companyId = comp?.id || null;
              } catch (_) { /* */ }
              const { data: created } = await supabase.from("b2b_conversations")
                .insert({ whatsapp: wa, company_id: companyId, last_message_at: new Date().toISOString() })
                .select("*").single();
              conv = created;
            }
          } catch (_) { /* */ }
          if (!conv) continue;

          // حفظ الرسالة الواردة
          try {
            await supabase.from("b2b_messages").insert({
              conversation_id: conv.id, direction: "in", body,
              wa_message_id: waMsgId, status: "received",
            });
          } catch (_) { /* */ }

          // 🔔 تنبيه الإدارة على الواتساب بأن شركة ردّت (اسم الشركة + نوع الرد).
          //   مجرّد إشعار ليدخل المسؤول اللوحة ويرد — لا يُسجَّل كرسالة محادثة.
          //   الرقم من b2b_settings.notify_whatsapp وإلا الرقم الافتراضي أدناه.
          try {
            const { data: nrow } = await supabase.from("b2b_settings")
              .select("value").eq("key", "notify_whatsapp").maybeSingle();
            const notifyTo = (nrow?.value || "").trim() || "96877428881"; // +968 7742 8881
            // لا نرسل التنبيه لنفس الرقم الذي ردّ (يتجنّب الحلقة عند الاختبار)
            if (notifyTo && normWa(notifyTo) !== wa) {
              let companyName = profileName || "";
              try {
                if (conv.company_id) {
                  const { data: comp } = await supabase.from("b2b_companies")
                    .select("name").eq("id", conv.company_id).maybeSingle();
                  if (comp?.name) companyName = comp.name;
                }
              } catch (_) { /* */ }
              if (!companyName) companyName = wa;

              let kind = "💬 رد نصي";
              if (/مهتم|interested/i.test(text)) kind = (type === "button" || type === "interactive") ? "✅ مهتم (ضغط زر)" : "✅ مهتم";
              else if (/ليس\s*الآن|لاحق|لا\s*شكر|not\s*now|no\s*thanks|later/i.test(text)) kind = "🕐 لاحقاً / ليس الآن";

              const preview = body.length > 90 ? body.slice(0, 90) + "…" : body;
              const alertMsg = `🔔 رد جديد من شركة\n🏢 ${companyName}\n📞 ${wa}\n📌 النوع: ${kind}\n💬 ${preview}\n\nافتحي لوحة الشركات للرد.`;
              await sendText(notifyTo, alertMsg);
            }
          } catch (_) { /* التنبيه best-effort — لا يكسر الاستقبال */ }

          // 3) رد سارة التلقائي (للنص ولضغطات الأزرار «مهتم»/«ليس الآن»)
          //    مفتاح تشغيل عام: سارة متوقّفة افتراضياً، وتعمل فقط إذا b2b_settings.auto_reply_enabled = on/true/1/yes.
          const { data: arGlobalRow } = await supabase.from("b2b_settings")
            .select("value").eq("key", "auto_reply_enabled").maybeSingle();
          const autoReplyGlobalOn = /^(on|true|1|yes)$/i.test(String(arGlobalRow?.value || "").trim());
          if (autoReplyGlobalOn && conv.auto_reply !== false && text) {
            try {
              const { data: rows } = await supabase.from("b2b_settings")
                .select("key, value").in("key", ["talal_system_prompt", "admin_whatsapp", "admin_whatsapp_link"]);
              const settings: Record<string, string> = Object.fromEntries((rows || []).map((r: any) => [r.key, r.value || ""]));

              // «ليس الآن» → رد لطيف مختصر بلا ترحيب كامل ولا إلحاح.
              if (/ليس\s*الآن|لاحق|لا\s*شكر|not\s*now|no\s*thanks|later/i.test(text)) {
                const aw = settings.admin_whatsapp || "";
                const awl = settings.admin_whatsapp_link || "";
                const tail = aw ? ` وللتواصل مع الإدارة وقت ما ترغبون: واتساب ${aw}${awl ? ` أو عبر الرابط ${awl}` : ""}.` : "";
                const niceReply = `شكراً لوقتكم الكريم 🌹 يسعدنا نكون في خدمتكم مستقبلاً، وأبواب العز الدولية مفتوحة وقت ما ترغبون بالتعاون.${tail}`;
                const outId = await sendText(wa, niceReply);
                await supabase.from("b2b_messages").insert({
                  conversation_id: conv.id, direction: "out", body: niceReply,
                  wa_message_id: outId, status: "sent",
                });
                continue; // لا نكمل لمسار الذكاء
              }

              // متغيّرات الـ prompt: {admin_whatsapp} و {admin_whatsapp_link} من b2b_settings
              const systemPrompt = (settings.talal_system_prompt
                || "أنتِ «سارة» مندوبة شراكات في العز الدولية للسفر والسياحة. رحّبي بالشركة واسألي عن اسمها واسم المسؤول، وأفيدي أن مسؤول الشراكات سيتواصل قريباً. لا تستخدمي Markdown ولا نجوم ولا عناوين — نص عادي فقط.")
                .replaceAll("{admin_whatsapp}", settings.admin_whatsapp || "")
                .replaceAll("{admin_whatsapp_link}", settings.admin_whatsapp_link || "");

              // سياق: آخر ١٠ رسائل للمحادثة (in→user, out→assistant) — الأحدث ثم نعكس للترتيب الزمني
              const { data: recent } = await supabase.from("b2b_messages")
                .select("direction, body").eq("conversation_id", conv.id)
                .order("created_at", { ascending: false }).limit(10);
              const history = (recent || []).reverse()
                .filter((r: any) => (r.body || "").trim())
                .map((r: any) => ({ role: r.direction === "out" ? "assistant" : "user", content: r.body }));
              // Anthropic يشترط أن تبدأ المحادثة برسالة user
              while (history.length && history[0].role !== "user") history.shift();
              if (!history.length || history[history.length - 1].role !== "user") {
                history.push({ role: "user", content: text });
              }

              const reply = await talalReply(systemPrompt, history);
              if (reply) {
                const outId = await sendText(wa, reply);
                await supabase.from("b2b_messages").insert({
                  conversation_id: conv.id, direction: "out", body: reply,
                  wa_message_id: outId, status: "sent",
                });
              }
            } catch (_) { /* لا نكسر الاستقبال */ }
          }
        }
      }
    }
  } catch (e) {
    try { console.log("b2b-talal error:", (e as Error).message); } catch (_) { /* */ }
  }

  return ok();
});
