// سيناريوهات انحدار طلال — كل واحد محادثة حقيقية خربت قبل (التاريخ + ما اشتكت منه المالكة).
// history = ما قبل الرسالة الحالية، customer = رسالة العميل الحالية، model = ما يرده النموذج
// (نبرمجه بالخطأ اللي سواه فعلاً — الحارس الخادمي لازم يصحّحه)، expect = شروط النجاح.

export type Ctx = { reply: string; session: Record<string, any>; intake: Record<string, any>; buildCalls: number; modelCalls: number };
export type Scenario = {
  id: string; title: string;
  history: Array<["C" | "T", string]>;
  customer: string;
  intakeData?: Record<string, unknown>;
  session?: { destination?: string | null };
  model: string[];
  expect: Array<[string, (c: Ctx) => boolean]>;
};

const M = (msg: string, fields: Record<string, unknown> = {}, complete = false) =>
  JSON.stringify({ messages: [msg], fields: { destination: "", pax: null, date: "", ages: "", cities: "", nights: "", days: null, ...fields }, complete });

const noLabs: [string, (c: Ctx) => boolean] = ["ما يسأل «عمرة ولا عمان؟» / لبس", c => !/لبس|ولا\s*عُ?مان|عُ?مان\s*ولا/.test(c.reply)];
const notSilent: [string, (c: Ctx) => boolean] = ["طلال ردّ (ما سكت)", c => c.reply.trim().length > 0 || c.buildCalls > 0];
const destUmrah: [string, (c: Ctx) => boolean] = ["الوجهة المخزّنة = عمرة", c => /عمر[ةه]/.test(String(c.intake.destination || ""))];

const RESET = "🔄 أُعيد ضبط المحادثة — يبدأ طلال من جديد. (الإدارة)";

export const SCENARIOS: Scenario[] = [
  {
    id: "kids-after-adults-q", title: "٢ نوفمبر: «٣ كبار وطفلين» بعد سؤال «كلهم بالغين؟» → لازم يسأل الأعمار",
    history: [["T", RESET], ["C", "العمره"], ["T", "حاضر، كم عدد المعتمرين الإجمالي، الكبار والأطفال؟"], ["C", "٥"],
      ["T", "تمام الـ5 كلهم بالغين ولا معكم أطفال؟ (أسأل لأن سعر الأطفال يختلف حسب أعمارهم)"]],
    customer: "٣ كبار وطفلين",
    intakeData: { destination: "العمرة", pax: 5, asked_children: true },
    model: [M("كم ليلة تنوون تقضون في مكة؟", { destination: "العمرة", pax: 5 })],
    expect: [["يسأل «كم أعمارهم؟»", c => /كم\s*أعمارهم/.test(c.reply)], ["ما يقفز لليالي", c => !/كم\s*ليل/.test(c.reply)]],
  },
  {
    id: "one-kid-age", title: "٢ نوفمبر: «فيه طفل واحد» → «ممكن أعرف كم عمره؟»",
    history: [["T", RESET], ["C", "عندكم عروض عمره"], ["T", "حاضر، كم عدد المعتمرين الإجمالي، الكبار والأطفال؟"], ["C", "٤"],
      ["T", "تمام الـ4 كلهم بالغين ولا معكم أطفال؟"]],
    customer: "في طفل واحد",
    intakeData: { destination: "العمرة", pax: 4, asked_children: true },
    model: [M("كم ليلة تنوون تقضون في مكة؟", { destination: "العمرة", pax: 4 })],
    expect: [["يسأل «كم عمره؟»", c => /كم\s*عمره/.test(c.reply)]],
  },
  {
    id: "adults-by-customer", title: "العميل نفسه قال «كلهم كبار» → لا يسأل الأعمار",
    history: [["T", RESET], ["C", "العمره"], ["T", "حاضر، كم عدد المعتمرين الإجمالي، الكبار والأطفال؟"], ["C", "٣"],
      ["T", "تمام الـ3 كلهم بالغين ولا معكم أطفال؟"]],
    customer: "كلهم كبار",
    intakeData: { destination: "العمرة", pax: 3, asked_children: true },
    model: [M("كم ليلة تنوون تقضون في مكة؟", { destination: "العمرة", pax: 3 })],
    expect: [["ما يسأل عن الأعمار", c => !/أعمار|عمره|عمرها/.test(c.reply)], notSilent],
  },
  {
    id: "kid-age-captured", title: "ردّ برقم على سؤال العمر → يُلتقط ولا يُعاد السؤال",
    history: [["T", RESET], ["C", "العمره"], ["C", "٥"], ["C", "٣ كبار وطفلين"], ["T", "ممكن أعرف كم أعمارهم؟"]],
    customer: "١١ و ٦",
    intakeData: { destination: "العمرة", pax: 5, asked_children: true, asked_ages_n: 1, ages: "" },
    model: [M("كم ليلة تنوون تقضون في مكة؟", { destination: "العمرة", pax: 5 })],
    expect: [["الأعمار مخزّنة برقم", c => /[0-9٠-٩]/.test(String(c.intake.ages || ""))], ["ما يعيد سؤال العمر", c => !/أعمارهم|كم\s*عمر/.test(c.reply)]],
  },
  {
    id: "muscat-airport", title: "٢ نوفمبر: «مسقط» جواب سؤال المطار → لا «عمرة ولا عمان؟»",
    history: [["T", RESET], ["C", "عندكم عروض عمره"], ["C", "٦"], ["C", "٢ أطفال"], ["C", "٣ مكه \n٢ المدينه"], ["C", "١١ و ٦"],
      ["T", "ممتاز، وآخر سؤال: الإقلاع من مطار صلالة أو مسقط؟"]],
    customer: "مسقط",
    intakeData: { destination: "العمرة", pax: 6, ages: "11 و 6", nights: "3 مكة 2 المدينة", cities: "مكة والمدينة", asked_children: true, asked_nights: true },
    model: [M("متى موعد السفر؟", { destination: "عُمان", pax: 6, ages: "11 و 6", nights: "3 مكة 2 المدينة" })],
    expect: [noLabs, destUmrah, notSilent],
  },
  {
    id: "stored-oman-confirm", title: "٢ نوفمبر: المخزّن «عُمان» غلطاً والعميل ردّ «صحيح» على الكرت → يجهّز بدل «لبس»",
    history: [["T", RESET], ["C", "عمره"], ["C", "٦"], ["C", "١١ و ٦"], ["C", "٣ مكه ٢ المدينه"], ["C", "تاريخ ١٥ الشهر هذا"],
      ["T", "خليني أتأكد من طلبك قبل ما أجهز لك العرض:\n- الوجهة: عمان\n- عدد المسافرين: 6\n- تاريخ السفر: 2026-11-15\n- عدد الليالي: 3 مكة 2 المدينة\nالمعلومات صحيحة؟"]],
    customer: "صحيح",
    intakeData: { destination: "عُمان", pax: 6, ages: "11 و 6", date: "2026-11-15", nights: "3 مكة 2 المدينة", cities: "مكة والمدينة المنورة", asked_children: true, asked_nights: true, awaiting_confirm: true },
    model: [M("تمام، معلوماتك وصلت", { destination: "عمرة (مكة المكرمة والمدينة المنورة)", pax: 6, ages: "11 و 6", date: "2026-11-15", nights: "3 مكة 2 المدينة" }, true)],
    expect: [noLabs, destUmrah, ["يبني البرنامج (أو يرد بلا لبس)", c => c.buildCalls > 0 || c.intake.summary_confirmed === true]],
  },
  {
    id: "pending-dest-wenkom", title: "٢ نوفمبر: سؤال وجهة معلّق والعميل كتب «وينكم» → تبقى العمرة",
    history: [["T", RESET], ["C", "عمره"], ["C", "مسقط"], ["T", "تمام عشان ما يصير لبس: تقصد وجهتك عمرة ولا عمان؟"]],
    customer: "وينكم",
    intakeData: { destination: "العمرة", pax: 6, asked_dest_change: true, pending_dest: "عُمان", asked_children: true },
    model: [M("احنا هنا، الإقلاع من مسقط صح؟", { destination: "عُمان", pax: 6 })],
    expect: [destUmrah, ["مسح السؤال المعلّق", c => c.intake.asked_dest_change !== true], notSilent],
  },
  {
    id: "real-dest-change", title: "تبديل وجهة حقيقي (ماليزيا ← تركيا) → لازم يسأل التأكيد",
    history: [["T", RESET], ["C", "ابي ماليزيا"], ["C", "شخصين"]],
    customer: "لا خلها تركيا",
    intakeData: { destination: "ماليزيا", pax: 2, asked_children: true },
    model: [M("تمام، متى موعد السفر؟", { destination: "تركيا", pax: 2 })],
    expect: [["يسأل تأكيد التبديل", c => /ماليزيا/.test(c.reply) && /تركيا/.test(c.reply)]],
  },
  {
    id: "pax-total-wording", title: "٢ نوفمبر: سؤال العدد لازم يطلب الإجمالي (كبار وأطفال)",
    history: [["T", RESET], ["C", "مرحبا"], ["T", "أهلاً وسهلاً، حياك الله، آمرني"]],
    customer: "عندكم عروض عمره",
    intakeData: {},
    model: [M("أبشر، كم عدد المعتمرين؟", { destination: "العمرة" })],
    expect: [["فيه «الإجمالي»", c => /الإجمالي|إجمالي/.test(c.reply)]],
  },
  {
    id: "model-no-json", title: "٢ نوفمبر: النموذج ردّ نص بلا JSON مرتين → لا سكوت",
    history: [["T", RESET], ["C", "عندكم عروض عمره"], ["T", "حاضر، كم عدد المعتمرين الإجمالي، الكبار والأطفال؟"]],
    customer: "٦",
    intakeData: { destination: "العمرة" },
    model: ["تمام، الستة كلهم بالغين ولا فيه أطفال معكم؟", "تمام، الستة كلهم بالغين ولا فيه أطفال معكم؟"],
    expect: [notSilent, ["العدد ٦ مُلتقط", c => Number(c.intake.pax) === 6]],
  },
  {
    id: "talal-summary-not-customer", title: "تاريخ مذكور في كلام طلال فقط ما يُعتبر من العميل",
    history: [["T", RESET], ["C", "عمره"], ["C", "٢"], ["C", "كلهم كبار"], ["C", "٣ مكه ٢ المدينه"],
      ["T", "العروض متوفرة من 10/11 — متى موعد السفر؟"]],
    customer: "ما ادري للحين",
    intakeData: { destination: "العمرة", pax: 2, nights: "3 مكة 2 المدينة", asked_children: true, asked_nights: true },
    model: [M("تمام، خليني أتأكد من طلبك", { destination: "العمرة", pax: 2, nights: "3 مكة 2 المدينة" })],
    expect: [["ما يرسل كرت التأكيد بلا تاريخ", c => !/أكد لي|المعلومات صحيحة/.test(c.reply)], ["ما يبني", c => c.buildCalls === 0]],
  },
];
