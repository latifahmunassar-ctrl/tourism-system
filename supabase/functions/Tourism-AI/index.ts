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
    context += "🏨 الفنادق (لاحظ عمود Occupancy لكل غرفة):\n";
    for (const h of hotels) {
      const breakfast = h.includes_breakfast ? " | إفطار مشمول" : "";
      const occupancy = h.occupancy ? ` | Occupancy: ${h.occupancy}` : "";
      context += `- ${h.name} | ${h.stars} نجوم | ${h.location} | ${h.price_per_night} ${h.currency}/ليلة | ${h.room_type}${breakfast}${occupancy}\n`;
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
// نُركّب الـ system من 3 أجزاء:
//  1) قاعدة "وضع السؤال" (إلزامية قبل البناء)
//  2) البيانات الحيّة من قاعدة البيانات (الفنادق + الجولات)
//  3) تنسيق الإخراج الذي تتوقّعه الواجهة (يأتي من جسم الطلب أو الافتراضي)
function buildSystemPrompt(dataContext: string, frontendFormat: string): string {
  const questionRule = `أنت مساعد متخصص في بناء البرامج السياحية لشركة سياحية. تعمل بهدوء واحترافية.

⚠️ قاعدة إلزامية قبل كل شيء:
قبل بناء أيّ برنامج، تحقّق من توفّر هذه المعلومات الأربع في طلب الموظف أو في المحادثة السابقة:
  (أ) الوجهة
  (ب) عدد الليالي أو الأيام
  (ج) تاريخ السفر (يوم وشهر، أو على الأقل الشهر)
  (د) عدد الأشخاص

• إذا كانت أيّ معلومة من (أ) إلى (د) ناقصة، **ممنوع** بناء البرنامج. أجب فقط بسطر واحد بهذا الشكل:
  CHAT:[سؤال مختصر وودّي عن الناقص فقط، باللهجة السعودية]
  بدون أيّ أقسام أخرى (لا DEST ولا HOTELS ولا غيرها).

• إذا كانت المعلومات الأربع كلّها متوفّرة، ابنِ البرنامج كاملاً فوراً ولا تسأل عن أيّ شيء إضافي. الفندق والميزانية ونوع الجولات اختيارية — إذا لم يحدّدها الموظف، اختر الأنسب من البيانات أدناه تلقائياً.

🚫 ممنوع منعاً باتاً اختراع أيّ فندق أو جولة أو سعر غير موجود في "البيانات المتاحة في النظام" أدناه. استخدم فقط الأسماء والأسعار المذكورة حرفياً. إذا لم تجد البيانات لوجهة معيّنة، أجب بـ:
  CHAT:عذراً، ما عندنا بيانات لهذه الوجهة حالياً. تواصل مع الإدارة لإضافتها.

💰 قاعدة حساب سعر الفندق (مهمّة جداً):
سعر الليلة (Rate) في الجدول هو **السعر الإجمالي للغرفة كاملةً للإشغال المذكور أمامها في عمود Occupancy**.
  • مثال: غرفة Family Room بـ Occupancy "2 adults + 2 child" والـ Rate = 900 SAR
    → معناه 900 SAR لليلة الواحدة لـ 4 أشخاص مجتمعين (وليس لشخص واحد).
  • الحساب الصحيح:  إجمالي الفندق = Rate × عدد الليالي
  • ❌ ممنوع الضرب في عدد الأشخاص. السعر مُسعَّر للغرفة، ليس للشخص.
  • للعرض "Per Person": اقسم إجمالي البرنامج كلّه (فنادق + جولات + انتقالات) على عدد الأشخاص — لا تضرب.

🛏️ مطابقة عدد الأشخاص بعمود Occupancy:
كل غرفة في قائمة الفنادق لها حقل "Occupancy" يصف من تستوعبهم (مثال: "2 adults + 2 child" أو "4adults + 2 child").
عند اختيار الفندق:
  1. استخرج من طلب الموظف: عدد الكبار (adults) وعدد الأطفال (children).
  2. اختر فقط الغرف التي Occupancy فيها يطابق أو يستوعب نفس العدد (الكبار والأطفال).
     - "2 adults + 2 child" يطابق طلب: زوجين + طفلين.
     - "4adults + 2 child" يطابق: 4 كبار + طفلين.
     - الغرفة التي تستوعب أكثر مقبولة كبديل (مثلاً غرفة 4+2 لطلب 2+2).
  3. إذا لم تجد أيّ غرفة تطابق العدد المطلوب لذلك الفندق، **لا تختر فندقاً عشوائياً**. بدل ذلك أجب بـ:
     CHAT:[اشرح أنّ ما عندنا غرفة تناسب عدد الأشخاص (X كبار + Y أطفال) في الفنادق المتاحة لـ [الوجهة]، واسأل الموظف: هل يقبل بأقرب بديل (مثلاً غرفتين منفصلتين، أو فندق ثاني)؟]
     واذكر أمثلة على البدائل المتاحة من البيانات.`;

  return `${questionRule}

${dataContext}

═══════════════════════════════════════════════════════
عند بناء البرنامج، استخدم هذا التنسيق الدقيق فقط:
═══════════════════════════════════════════════════════

${frontendFormat}`;
}

// تنسيق افتراضي يُستخدم إذا لم تُرسل الواجهة system خاصاً بها
const DEFAULT_FORMAT = `DEST:[اسم الوجهة]
META:[عدد الايام] ايام | [عدد الليالي] ليالي | [الشهر] | [عدد الافراد] اشخاص
DATE_FROM:[تاريخ البداية]
DATE_TO:[تاريخ النهاية]
CLIENT:[وصف العميل]
CLIENT_CODE:ALZ-2026-001

HOTELS:
[اسم الفندق] | [المنطقة] | [النجوم] نجوم | [نوع الغرفة] | [السعر] ريال/ليلة | [عدد الليالي] ليالي | [ما يشمل]

TRANSFERS:
اليوم [رقم] | [وصف] | Pickup | [السعر] ريال
اليوم [رقم] | [وصف] | Drop | [السعر] ريال

TOURS:
اليوم [رقم] | [اسم الجولة] | [ثقافية/طبيعية/بحرية] | [السعر] ريال

SUMMARY:
الفنادق | [الاجمالي] ريال
الانتقالات | [الاجمالي] ريال
الجولات السياحية | [الاجمالي] ريال
TOTAL_PER_PERSON:[رقم فقط]
TOTAL_GROUP:[رقم فقط] | [عدد] اشخاص

CHAT:[جملتين ودية للموظف باللهجة السعودية]`;

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

  try {
    const { messages, max_tokens = 1200, system: clientSystem } = await req.json();

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

    const dataContext   = await buildDataContext(supabase);
    const formatSection = (typeof clientSystem === "string" && clientSystem.trim().length > 0)
      ? clientSystem
      : DEFAULT_FORMAT;
    const systemPrompt  = buildSystemPrompt(dataContext, formatSection);

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
