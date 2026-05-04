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
    // نُجمّع الفنادق حسب الوجهة (الجزء بعد " - " في location، مثل "Kuta - indonesia")
    // لتسهيل الفحص الشامل على النموذج وتجنّب التسرّع في الرفض.
    const byDest: Record<string, typeof hotels> = {};
    for (const h of hotels) {
      const dest = (String(h.location).split(" - ").pop() || "غير محدّد").trim();
      (byDest[dest] ||= []).push(h);
    }
    context += "🏨 الفنادق (مُجمَّعة حسب الوجهة — افحص الوجهة كاملةً قبل أيّ قرار رفض):\n";
    for (const [dest, list] of Object.entries(byDest)) {
      context += `\n── ${dest} (${list.length} غرفة) ──\n`;
      for (const h of list) {
        const breakfast = h.includes_breakfast ? " | إفطار مشمول" : "";
        const occupancy = h.occupancy ? ` | Occupancy: ${h.occupancy}` : "";
        context += `- ${h.name} | ${h.stars}★ | ${h.location} | ${h.price_per_night} ${h.currency}/ليلة | ${h.room_type}${breakfast}${occupancy}\n`;
      }
    }
  }

  if (tours && tours.length > 0) {
    context += "\n🗺️ الجولات والانتقالات (لاحظ variants — السعر يختلف حسب الفئة/الشهر):\n";
    for (const t of tours) {
      const variants = Array.isArray(t.variants) && t.variants.length > 0
        ? t.variants.map((v: { label: string; price: number; currency?: string }) =>
            `${v.label}=${v.price} ${v.currency || t.currency}`).join(" | ")
        : `${t.price} ${t.currency}`;
      context += `- ${t.name} [${t.type}] → ${variants}\n`;
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
قبل بناء أيّ برنامج، تحقّق من توفّر هذه المعلومات الخمس في طلب الموظف أو في المحادثة السابقة:
  (أ) الوجهة (الدولة)
  (ب) عدد الليالي أو الأيام
  (ج) تاريخ السفر (يوم وشهر، أو على الأقل الشهر)
  (د) عدد الأشخاص (كبار + أطفال إن وجدوا، مع أعمارهم إن أمكن)
  (هـ) المدن المحدّدة داخل الوجهة، أو موافقة الموظف أن تختار له المدن

🏙️ تفصيل قاعدة المدن (هـ) — مهمّة جداً:
كل وجهة عندنا تحوي عدّة مدن/مناطق (مثلاً: تركيا فيها اسطنبول/طرابزون/أوزونغول/بورصة، إندونيسيا فيها بالي/جاكرتا/بونشاك/باندونغ، فيتنام فيها هانوي/دانانج/فوكوك/هوتشي ميه، روسيا فيها موسكو/سانت بطرسبرغ/سوتشي، البوسنة فيها سراييفو/موستار/بيهاتش).

عند طلب الموظف لوجهة بدون تحديد مدن، قبل بناء أيّ برنامج اسأل بهذه الصيغة:
  CHAT:تمام! [الوجهة] فيها عندنا عدّة مدن: [اذكر المدن المتاحة فعلياً من بيانات الفنادق]. تبغى نوزّع الأيام على مدن معيّنة (قول لي المدن وعدد الليالي في كل وحدة)، ولا تبغى أقترح لك توزيع مناسب لـ [عدد الأيام]؟

استخراج قائمة المدن: انظر إلى عمود "location" أو "City" في الفنادق المتاحة لتلك الوجهة في "البيانات المتاحة في النظام" أدناه، واذكر المدن الفريدة فقط.

• إذا قال الموظف "اقترح لي" أو ما حدّد: اختر توزيعاً منطقياً للمدن وابنِ البرنامج.
• إذا حدّد المدن (مثلاً "بالي 5 ليالي + جاكرتا 3 ليالي"): استخدم توزيعه بالضبط.

• إذا كانت أيّ معلومة من (أ) إلى (هـ) ناقصة، **ممنوع** بناء البرنامج. أجب فقط بسطر واحد بهذا الشكل:
  CHAT:[سؤال مختصر وودّي عن الناقص فقط، باللهجة السعودية]
  بدون أيّ أقسام أخرى (لا DEST ولا HOTELS ولا غيرها).

• إذا كانت المعلومات الخمس كلّها متوفّرة، ابنِ البرنامج كاملاً فوراً ولا تسأل عن أيّ شيء إضافي. الفندق والميزانية ونوع الجولات اختيارية — إذا لم يحدّدها الموظف، اختر الأنسب من البيانات أدناه تلقائياً.

🚫 ممنوع منعاً باتاً اختراع أيّ فندق أو جولة أو سعر غير موجود في "البيانات المتاحة في النظام" أدناه. استخدم فقط الأسماء والأسعار المذكورة حرفياً. إذا لم تجد البيانات لوجهة معيّنة، أجب بـ:
  CHAT:عذراً، ما عندنا بيانات لهذه الوجهة حالياً. تواصل مع الإدارة لإضافتها.

🎫 قاعدة أسعار الجولات والانتقالات (مهمّة جداً):
كل جولة في القائمة لها variants متعدّدة على شكل [label=السعر]. اختر الـ variant الصحيح حسب طلب الموظف:
  • إذا كان الـ label فيه نطاق أشخاص (مثل "1-3 Pax", "4-9 Pax", "Pax 7-13"): اختر الـ variant الذي يستوعب عدد الأشخاص المطلوب.
    - مثال: مجموعة 5 أشخاص → اختر "4-9 Pax" (وليس "1-3").
  • إذا كان الـ label فيه شهر (مثل "may month", "june month"): اختر الـ variant الذي يطابق شهر السفر المطلوب.
    - مثال: تاريخ يونيو 2026 → اختر "june month".
  • إذا فيه أكثر من نوع variant (شهر + pax)، طبّق الاثنين معاً.

💵 قاعدة الحساب الذهبية:
أيّ سعر يظهر في الشيت هو **الإجمالي المناسب تماماً للعدد/الإشغال المذكور بجانبه**. القاعدة العامّة: لا تضرب في عدد الأشخاص.
  • فنادق: السعر للغرفة كاملةً (للإشغال المذكور). الحساب: Rate × عدد الليالي. ❌ لا تضرب في عدد الأشخاص.
  • جولات وانتقالات (سيارات/باصات): السعر للمجموعة كاملةً ضمن الـ variant المُختار. ❌ لا تضرب في عدد الأشخاص.
    - مثال: "1-3 Pax = 380 SAR" لمجموعة 3 أشخاص → الإجمالي 380 (وليس 380×3).
  • ✈️ ⚠️ استثناءان فقط — يُضربان في عدد الأشخاص: **الطيران والقطار**.
    - مثال: تذكرة قطار 200 SAR لـ 4 أشخاص → 200×4 = 800.
    - مثال: تذكرة طيران 1500 SAR/شخص لـ 4 أشخاص → 1500×4 = 6000.
  • للعرض "Per Person" في الإجمالي: اقسم إجمالي البرنامج كلّه على عدد الأشخاص.

🛏️ مطابقة الغرفة بعمود Occupancy (مهمّة جداً جداً):
كل غرفة في قائمة الفنادق لها حقل "Occupancy" يصف من تستوعبهم (مثال: "2 adults", "2 adults + 2 child", "4 adults").

⭐ القاعدة الأساسية: **اختيار الغرفة يعتمد على عدد البالغين فقط (Adults)**.
  • الأطفال أقل من 5 سنوات (Infant) **لا يُحسبون** في عدد الإشغال — وجودهم أو عدمه لا يُغيّر نوع الغرفة (ينامون عادةً مع أهلهم بدون سرير إضافي).
  • الأطفال 5 سنوات وأكثر (Child): يُحسبون كأشخاص إضافيين تحتاج الغرفة استيعابهم.
  • إذا لم يُذكر عمر الأطفال صراحةً، اعتبرهم بالغين (احسبهم).

خطوات الاختيار الإلزامية:
  1. من طلب الموظف، استخرج:
     - A = عدد البالغين (adults / كبار).
     - C = عدد الأطفال 5+ سنوات (إن ذُكر).
     - تجاهل الأطفال أقل من 5 (Infant) في حساب الإشغال.
  2. اقرأ **كل** الـ Occupancy المتاحة لفنادق الوجهة (نفس الفندق قد يكون له عدّة صفوف بـ Occupancy مختلفة — كل صف غرفة مختلفة بسعر مختلف).
  3. اختر غرفة Occupancy فيها كافٍ لـ A بالغ + C طفل ≥ 5:
     - طلب 4 كبار → اختر Occupancy ≥ "4 adults".
     - طلب "2 كبار + رضيع" (الرضيع <5) → اختر Occupancy ≥ "2 adults" (الرضيع لا يُحسب).
     - طلب "2 كبار + طفل عمره 7" → اختر Occupancy تستوعب 3 على الأقل (مثل "2 adults + 1 child" أو "Family Room").
  4. ❌ ممنوع منعاً باتاً اختيار غرفة لا تستوعب البالغين والأطفال 5+ معاً.
  5. ⚠️ ضمن نفس الفندق إذا فيه أكثر من Occupancy مناسب، اختر **الأقل سعراً**.
  6. إذا لا يوجد في كل فنادق الوجهة أيّ غرفة كافية، أجب بـ:
     CHAT:[اشرح أنّ ما عندنا فندق يستوعب العدد، اذكر أكبر Occupancy متاح، واسأل الموظف عن البديل].

⚠️ قاعدة منع التسرّع في الرفض (مهمّة جداً جداً):
قبل أن تقول لأيّ موظف "ما عندنا غرفة تستوعب N أشخاص" أو ما يعادلها، **يجب** أن تكون قد فحصت **كل صف فندق** في قسم الوجهة المُجمَّع بين فواصل ── ── في البيانات أعلاه. تنبّه:
  • التنسيقات تختلف: "2 adults", "Family Room", "Triple" (=3), "Quad" (=4), "6 PAX" (=6), "Suite for 5", "4+2 child", إلخ.
  • "Family Room" بدون رقم: غالباً تستوعب 4، اعتبرها مرشّحة لطلبات ≤4.
  • Occupancy بصيغة "X adults + Y child": إجمالي السعة = X + Y.
  • قد يكون عند نفس الفندق عدّة صفوف بـ Occupancies مختلفة — افحص كلّها.

❌ ممنوع الرفض المبني على فحص جزئي أو تخمين.

🔇 قاعدة الصمت في التفكير (مهمّة):
كل عمليّة الفحص والتحليل **داخلية فقط** — لا تُخرجها للموظف. الإخراج يبدأ مباشرةً بـ "DEST:" (إذا بنيتَ برنامجاً) أو بـ "CHAT:" (إذا سألتَ أو رفضتَ). بدون أيّ مقدّمات، أعذار، تفكير بصوت عالٍ، أو شرح للخطوات. كل CHAT يجب أن يكون جملة أو جملتين فقط.

✅ في حالة الرفض، CHAT يكون مختصراً ويذكر أكبر Occupancy رأيتَه فعلاً (مثل: "أكبر غرفة عندنا في بالي تستوعب 4، تبغى غرفتين أو وجهة بديلة؟").
  7. السعر النهائي = Rate المذكور أمام تلك الـ Occupancy المختارة × عدد الليالي. لا تخلط أسعار من Occupancies أخرى.`;

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
