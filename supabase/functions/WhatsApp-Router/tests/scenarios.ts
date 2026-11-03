// سيناريوهات انحدار طلال — كل واحد محادثة حقيقية خربت قبل (التاريخ + ما اشتكت منه المالكة).
// history = ما قبل الرسالة الحالية، customer = رسالة العميل الحالية، model = ما يرده النموذج
// (نبرمجه بالخطأ اللي سواه فعلاً — الحارس الخادمي لازم يصحّحه)، expect = شروط النجاح.

export type Ctx = { reply: string; session: Record<string, any>; intake: Record<string, any>; buildCalls: number; modelCalls: number; proposals: number; jobs: Array<Record<string, any>>; buildBody: Record<string, any> | null; modelSystem: string };
export type Scenario = {
  id: string; title: string;
  entry?: "intake" | "followup";   // followup = بعد إقفال الطلب (تشغيل كامل لرقم المالكة)
  history: Array<["C" | "T", string]>;
  customer: string;
  intakeData?: Record<string, unknown>;
  session?: { destination?: string | null };
  model: string[];
  jobs?: Array<Record<string, unknown>>;
  inboundDuringModel?: string;   // رسالة عميل أحدث تصل أثناء تفكير النموذج (اختبار دمج الرسائل)   // طابور الـPDF (program_pdf_jobs) قبل الرسالة
  expect: Array<[string, (c: Ctx) => boolean]>;
};

const M = (msg: string, fields: Record<string, unknown> = {}, complete = false) =>
  JSON.stringify({ messages: [msg], fields: { destination: "", pax: null, date: "", ages: "", cities: "", nights: "", days: null, ...fields }, complete });

const noLabs: [string, (c: Ctx) => boolean] = ["ما يسأل «عمرة ولا عمان؟» / لبس", c => !/لبس|ولا\s*عُ?مان|عُ?مان\s*ولا/.test(c.reply)];
const notSilent: [string, (c: Ctx) => boolean] = ["طلال ردّ (ما سكت)", c => c.reply.trim().length > 0 || c.buildCalls > 0];
const destUmrah: [string, (c: Ctx) => boolean] = ["الوجهة المخزّنة = عمرة", c => /عمر[ةه]/.test(String(c.intake.destination || ""))];

const RESET = "🔄 أُعيد ضبط المحادثة — يبدأ طلال من جديد. (الإدارة)";

const FU = (message: string, action = "reply", fields: Record<string, unknown> = {}) => JSON.stringify({ message, action, fields });
const DONE = { destination: "العمرة", pax: 5, ages: "11 و 6", date: "2026-11-11", nights: "3 مكة 2 المدينة", cities: "مكة والمدينة",
  summary_confirmed: true, auto_program: "برنامج عمرة MK-2026-008\nمكة: فندق فوكو 3 ليال\nالمدينة: بولمان 2 ليال" };
const PROG_HIST: Array<["C" | "T", string]> = [["T", RESET], ["C", "عمره"], ["C", "٥"], ["C", "٣ كبار وطفلين"], ["C", "١١ و ٦"], ["C", "صحيح"],
  ["T", "📄 برنامج PDF — MK-2026-008"], ["T", "تفضل أستاذي، برنامجك صار جاهز. أي تعديل في البرنامج أنا حاضر."]];

export const SCENARIOS: Scenario[] = [
  {
    id: "fu-resend-failed-pdf", entry: "followup", title: "٣ نوفمبر: الـPDF فشل و«ارسل البرنامج» → يعيده للطابور، ❌ لا «البرنامج فوق»",
    history: [...PROG_HIST.slice(0, 6), ["C", "في انتظارك"]], customer: "ارسل البرنامج ياغبي", intakeData: DONE,
    jobs: [{ id: 9, code: "MK-2026-008", status: "failed", attempts: 5 }],
    model: [FU("البرنامج كامل فوق في المحادثة، مرسل لك من قبل.")],
    expect: [["ما يقول «فوق/مرسل»", c => !/فوق|مرسل\s*لك/.test(c.reply)], ["الـPDF رجع للطابور", c => c.jobs.some(j => j.id === 9 && j.status === "pending")], notSilent],
  },
  {
    id: "fu-resend-sent-pdf", entry: "followup", title: "الـPDF وصل والعميل «مش مبين عندي» → يرسله مرة ثانية",
    history: PROG_HIST, customer: "مش مبين عندي ارسله مره ثانيه", intakeData: DONE,
    jobs: [{ id: 9, code: "MK-2026-008", status: "sent" }],
    model: [FU("البرنامج فوق في المحادثة")],
    expect: [["مهمة PDF جديدة", c => c.jobs.filter(j => j.code === "MK-2026-008" && j.status !== "sent").length === 1], ["ما يقول «فوق»", c => !/فوق/.test(c.reply)]],
  },
  {
    id: "fu-airport-truth-old-text", entry: "followup", title: "٣ نوفمبر: نص السيرفر فيه «مطار المدينة» والـPDF جدة → النموذج ما يشوف «مطار المدينة»، والمعتمد جدة",
    history: PROG_HIST, customer: "من وين المغادرة؟",
    intakeData: { ...DONE, auto_program: "برنامج العمرة\n📍 اليوم الخامس\n🚗 نقل من الفندق في المدينة المنورة إلى مطار المدينة المنورة\nمكة: فوكو" },
    model: [FU("المغادرة من مطار جدة")],
    expect: [["النموذج ما يشوف «مطار المدينة»", c => !/مطار المدين/.test(c.modelSystem.split("القواعد:")[0])], ["الحقيقة: العودة من جدة", c => /الذهاب والعودة من مطار جدة/.test(c.modelSystem)]],
  },
  {
    id: "fu-final-raw-preferred", entry: "followup", title: "لو فيه نص الـPDF النهائي → طلال يقرأه بدل نسخة السيرفر",
    history: PROG_HIST, customer: "وش الفندق في المدينة؟",
    intakeData: { ...DONE, program_final_raw: "HOTELS:\nPullman Zamzam Madina | Al Madinah | 5 نجوم\nFLIGHTS:\nجدة ← مسقط | عودة", auto_program: "نسخة قديمة فيها فندق ثاني XYZ" },
    model: [FU("بولمان زمزم")],
    expect: [["يقرأ النص النهائي", c => /Pullman Zamzam/.test(c.modelSystem) && !/XYZ/.test(c.modelSystem)]],
  },
  {
    id: "fu-question-from-program", entry: "followup", title: "متابعة: سؤال جوابه في البرنامج → يرد بنفسه بلا تحويل",
    history: PROG_HIST, customer: "وش اسم الفندق في مكة؟", intakeData: DONE,
    model: [FU("الفندق في مكة فوكو، ٣ ليال")],
    expect: [["يرد بالفندق", c => /فوكو/.test(c.reply)], ["ما يحوّل للموظفة", c => c.proposals === 0]],
  },
  {
    id: "fu-no-reask-known", entry: "followup", title: "متابعة: النموذج يعيد سؤال العدد المعروف → الحارس يرفض",
    history: PROG_HIST, customer: "طيب ممكن نغير الفندق؟", intakeData: DONE,
    model: [FU("أكيد، كم عدد المعتمرين معكم؟"), FU("أكيد، كم عدد المعتمرين معكم؟"), FU("أكيد، كم عدد المعتمرين معكم؟")],
    expect: [["ما يسأل عن العدد", c => !/كم\s*عدد/.test(c.reply)], notSilent],
  },
  {
    id: "fu-modify-nights", entry: "followup", title: "متابعة: «زيدها ليلة في المدينة» → سؤال تأكيد طبيعي أولاً (مو الكرت)",
    history: PROG_HIST, customer: "زيدها ليلة في المدينة", intakeData: DONE,
    model: [FU("تمام، بعدّلها", "modify", { nights: "3 مكة 3 المدينة" })],
    expect: [["سؤال تأكيد «تقصد…؟»", c => /تقصد/.test(c.reply) && /3 مكة 3 المدينة/.test(c.reply)], ["❌ ما يرسل الكرت مباشرة", c => !/أكّ?د لي|المعلومات صحيحة/.test(c.reply)],
      ["التعديل معلّق", c => c.intake.pending_modify?.nights === "3 مكة 3 المدينة"], ["البيانات ما تغيّرت بعد", c => c.intake.nights === "3 مكة 2 المدينة"]],
  },
  {
    id: "fu-modify-nights-yes", entry: "followup", title: "متابعة: «نعم» على سؤال التأكيد → الكرت النهائي بالليالي الجديدة",
    history: [...PROG_HIST, ["C", "زيدها ليلة في المدينة"], ["T", "تمام، تقصد نخلي الليالي 3 مكة 3 المدينة؟"]], customer: "نعم",
    intakeData: { ...DONE, pending_modify: { nights: "3 مكة 3 المدينة" } },
    model: [FU("ما المفروض يوصل للنموذج")],
    expect: [["الكرت فيه الليالي الجديدة", c => /3 مكة 3 المدينة/.test(c.reply) && /المعلومات صحيحة/.test(c.reply)], ["العدد والتاريخ ثابتين", c => Number(c.intake.pax) === 5 && c.intake.date === "2026-11-11"],
      ["رجع للاستقبال بانتظار التأكيد", c => c.session.intake_active === true && c.intake.awaiting_confirm === true], ["ما استدعى النموذج", c => c.modelCalls === 0]],
  },
  {
    id: "fu-airport-ask", entry: "followup", title: "٣ نوفمبر: «احتاج العوده من مطار المدينه» → «تقصد الذهاب إلى مطار جدة، وبعد ذلك العودة من مطار المدينة؟»",
    history: PROG_HIST, customer: "احتاج العوده من مطار المدينه", intakeData: DONE,
    model: [FU("البرنامج يبدأ من مطار جدة لأن الوصول عادة يكون عليه")],
    expect: [["سؤال التأكيد بصيغة المالكة", c => /تقصد الذهاب إلى مطار جدة، وبعد ذلك العودة من مطار المدينة؟/.test(c.reply)], ["❌ لا كرت", c => !/المعلومات صحيحة/.test(c.reply)],
      ["معلّق: العودة من المدينة", c => c.intake.pending_modify?.return_airport === "madinah"], ["ما يحوّل للموظفة", c => c.proposals === 0]],
  },
  {
    id: "fu-airport-yes", entry: "followup", title: "«نعم» على سؤال المطار → الكرت فيه «العودة من مطار المدينة»",
    history: [...PROG_HIST, ["C", "احتاج العوده من مطار المدينه"], ["T", "تمام، تقصد الذهاب إلى مطار جدة، وبعد ذلك العودة من مطار المدينة؟"]], customer: "ايوه",
    intakeData: { ...DONE, pending_modify: { return_airport: "madinah" } },
    model: [FU("x")],
    expect: [["الكرت فيه المطار", c => /العودة من مطار المدينة/.test(c.reply) && /المعلومات صحيحة/.test(c.reply)], ["محفوظ return_airport", c => c.intake.return_airport === "madinah"],
      ["بانتظار التأكيد النهائي", c => c.session.intake_active === true && c.intake.awaiting_confirm === true]],
  },
  {
    id: "fu-airport-no", entry: "followup", title: "«لا» على سؤال المطار → ما يتغيّر شي ويسأل وش التعديل",
    history: [...PROG_HIST, ["C", "احتاج العوده من مطار المدينه"], ["T", "تمام، تقصد الذهاب إلى مطار جدة، وبعد ذلك العودة من مطار المدينة؟"]], customer: "لا",
    intakeData: { ...DONE, pending_modify: { return_airport: "madinah" } },
    model: [FU("x")],
    expect: [["ما تغيّر المطار", c => !c.intake.return_airport], ["مسح المعلّق", c => !c.intake.pending_modify], ["يسأل وش التعديل", c => /وش التعديل/.test(c.reply)]],
  },
  {
    id: "fu-two-msgs-merge", entry: "followup", title: "٣ نوفمبر: رسالتين ورا بعض («…مطار المدينه» ثم «ليش من مطار جده») → ردّ واحد، مو ردّين متناقضين",
    history: PROG_HIST, customer: "طيب وش الفنادق؟", intakeData: DONE,
    inboundDuringModel: "ليش من مطار جده",
    model: [FU("الفنادق فوكو مكة وبولمان المدينة")],
    expect: [["المعالج الأقدم ما رد (الأحدث يرد على الكل)", c => c.reply.trim() === ""]],
  },
  {
    id: "fu-modify-oman-ignored", entry: "followup", title: "متابعة: تعديل يطلّع وجهة «عُمان» من «مسقط» → الوجهة تبقى عمرة",
    history: PROG_HIST, customer: "نبي نطلع من مسقط بدل صلالة وزيد شخص", intakeData: DONE,
    model: [FU("تمام", "modify", { destination: "عُمان", pax: 6 })],
    expect: [destUmrah, ["التعديل المعلّق = العدد ٦ بلا وجهة", c => Number(c.intake.pending_modify?.pax) === 6 && !c.intake.pending_modify?.destination], ["ما يذكر عمان", c => !/عُ?مان/.test(c.reply)]],
  },
  {
    id: "fu-handoff-booking", entry: "followup", title: "متابعة: «ابي احجز» → يحوّل للموظفة مع رد",
    history: PROG_HIST, customer: "تمام ابي احجز كيف ادفع؟", intakeData: DONE,
    model: [FU("أبشر، بحوّل طلبك لزميلي المختص ويرد عليك قريب", "handoff")],
    expect: [notSilent, ["انفتح طلب للموظفة", c => c.proposals > 0]],
  },
  {
    id: "fu-model-fail", entry: "followup", title: "متابعة: النموذج فشل → ما يسكت (يحوّل)",
    history: PROG_HIST, customer: "كم المسافة بين الفندق والحرم؟", intakeData: DONE,
    model: ["نص بلا جيسون", "نص بلا جيسون", "نص بلا جيسون"],
    expect: [notSilent],
  },
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
    id: "card-yes-builds-medina-return", title: "«صحيح» على الكرت وفيه العودة من المدينة → البناء يرسل return_airport=madinah",
    history: [["T", RESET], ["C", "عمره"], ["C", "٥"], ["C", "٤ كبار وطفل"], ["C", "٦"], ["C", "٣ مكه ٢ المدينه"], ["C", "١١ هذا الشهر"],
      ["T", "خليني أتأكد من طلبك قبل ما أجهّز لك العرض:\n- الوجهة: العمرة\n- المطار: الذهاب إلى مطار جدة، والعودة من مطار المدينة\nالمعلومات صحيحة؟"]],
    customer: "صحيح",
    intakeData: { destination: "العمرة", pax: 5, ages: "6", date: "2026-11-11", nights: "3 مكة 2 المدينة", cities: "مكة والمدينة", asked_children: true, asked_nights: true, awaiting_confirm: true, return_airport: "madinah" },
    model: [M("تمام", { destination: "العمرة", pax: 5, ages: "6", date: "2026-11-11", nights: "3 مكة 2 المدينة" }, true)],
    expect: [["بنى البرنامج", c => c.buildCalls > 0], ["أرسل return_airport=madinah", c => c.buildBody?.return_airport === "madinah"]],
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
