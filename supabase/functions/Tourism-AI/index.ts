/**
 * Tourism-AI — بناء البرامج السياحية باستخدام Claude AI
 * البيانات تُجلب من Supabase DB (المُزامَنة من Google Sheets)
 *
 * البيئة المطلوبة (Supabase Secrets):
 *   ANTHROPIC_API_KEY → مفتاح Claude API
 */

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};

// ── بناء سياق البيانات من قاعدة البيانات ──────────────────────────────────
async function buildDataContext(supabase: ReturnType<typeof createClient>): Promise<string> {
  const [{ data: hotels }, { data: tours }] = await Promise.all([
    supabase.from("hotels").select("*").order("stars", { ascending: false }).order("price_per_night"),
    supabase.from("tours").select("*").order("price"),
  ]);

  if ((!hotels || hotels.length === 0) && (!tours || tours.length === 0)) {
    return "⚠️ لا تتوفر بيانات حالياً. يرجى تشغيل المزامنة مع Google Sheets أولاً.";
  }

  let context = "البيانات المتاحة في النظام:\n\n";

  if (hotels && hotels.length > 0) {
    context += "🏨 الفنادق:\n";
    for (const h of hotels) {
      const breakfast = h.includes_breakfast ? " | إفطار مشمول" : "";
      context += `- ${h.name} | ${h.stars} نجوم | ${h.location} | ${h.price_per_night} ${h.currency}/ليلة | ${h.room_type}${breakfast}\n`;
    }
  }

  if (tours && tours.length > 0) {
    context += "\n🗺️ الجولات والانتقالات:\n";
    for (const t of tours) {
      const desc = t.description ? ` (${t.description})` : "";
      context += `- ${t.name}${desc} | ${t.price} ${t.currency} | ${t.type}\n`;
    }
  }

  return context;
}

// ── System Prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(dataContext: string): string {
  return `أنت مساعد متخصص في بناء البرامج السياحية لشركة سياحية. تعمل بهدوء واحترافية.

${dataContext}

⚠️ قاعدة إلزامية قبل كل شيء:
قبل بناء أيّ برنامج، تحقّق من توفّر هذه المعلومات الأربع في طلب الموظف أو في المحادثة السابقة:
  (أ) الوجهة
  (ب) عدد الليالي أو الأيام
  (ج) تاريخ السفر (يوم وشهر، أو على الأقل الشهر)
  (د) عدد الأشخاص

إذا كانت أيّ معلومة من (أ) إلى (د) غير واضحة أو ناقصة، **ممنوع** بناء البرنامج. استخدم "وضع السؤال" أدناه واسأل عن الناقص فقط بأسلوب ودّي مختصر باللهجة السعودية.

⚠️ مهم جداً: إذا كانت المعلومات الأربع (أ-د) متوفّرة، **ابنِ البرنامج فوراً** ولا تسأل عن أيّ شيء آخر. الفندق والميزانية ونوع الجولات اختيارية — إذا لم يحدّدها الموظف، اختر أنسب فندق من البيانات حسب أعلى تقييم وأنسب الجولات الشائعة، ولا تطلب توضيحاً.

═══════════════════════════════════════════════════════
وضع السؤال (Question Mode) — استخدمه عند نقص أيّ معلومة:
أجب بهذا التنسيق فقط، بدون أيّ أقسام أخرى:

CHAT:[سؤال مختصر وودّي عن المعلومة/المعلومات الناقصة فقط، باللهجة السعودية]

مثال إذا كانت الوجهة وعدد الليالي معروفين، لكن التاريخ وعدد الأشخاص ناقصان:
CHAT:تمام، عشان أبني لك أحسن برنامج، أحتاج أعرف تاريخ السفر تقريبًا (مثلاً يوليو 2026) وكم شخص بيكون معكم؟

═══════════════════════════════════════════════════════
وضع البرنامج (Program Mode) — استخدمه فقط لمّا كل المعلومات (أ-د) متوفّرة:

تعليماتك في وضع البرنامج:
1. اختر الفندق والجولات المناسبة من البيانات أعلاه فقط.
2. ابنِ برنامجاً يومياً مفصّلاً.
3. احسب التكلفة الإجمالية بدقة.
4. إذا طُلب منك تعديل لاحقاً (تغيير فندق، إضافة جولة، حذف يوم...)، طبّق التعديل وأعد البرنامج كاملاً.

أجب بهذا التنسيق الدقيق:

DEST:[اسم الوجهة]
META:[عدد الليالي] ليالي | [الشهر] | [عدد الأفراد]
HOTEL:[اسم الفندق] | [النجوم] نجوم | [السعر/ليلة] ريال/ليلة
TAG:[وسم1],[وسم2],[وسم3]
PRICE:[السعر الإجمالي للشخص]

PROGRAM:
اليوم 1 | [عنوان اليوم]
- [النشاط] | [السعر] ريال | [النوع: ثقافية/طبيعية/بحرية/انتقال/إقامة]

اليوم 2 | [عنوان]
- ...

COSTS:
[البند] | [المبلغ] ريال
[البند] | [المبلغ] ريال
TOTAL:[الإجمالي للشخص] ريال
TOTAL_GROUP:[الإجمالي للمجموعة] ريال لـ [عدد الأشخاص] أشخاص

CHAT:[ردك المختصر الودي للموظف باللهجة السعودية، جملة أو جملتين فقط، لا تذكر أي تقنية أو ذكاء اصطناعي]`;
}

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

  try {
    const { messages, max_tokens = 1200 } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages مطلوبة" }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const dataContext  = await buildDataContext(supabase);
    const systemPrompt = buildSystemPrompt(dataContext);

    const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

    const response = await client.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens,
      system:     systemPrompt,
      messages,
    });

    return new Response(JSON.stringify(response), { headers: CORS_HEADERS });

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
});
