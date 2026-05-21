/**
 * fillEmptyRowsBatch — Google Apps Script
 *
 * Target sheet: ALEZZ Chat (ID 1wBbUNMyZvYMFzxhw9CSVWZvnolMX_yzr13bUVfUxmYQ)
 *
 * Behavior — for each entry in UPDATES:
 *   1. Find row by ID + Sub-intent.
 *   2. For each target column: if the cell is empty, write the value.
 *   3. Mark filled cells YELLOW; mark the rest of the row LIGHT BLUE
 *      (preserving any existing yellow from previous runs).
 *
 * Run: Sheet → Extensions → Apps Script → paste → click Run.
 */
function fillEmptyRowsBatch() {

  // ── content (Khaleeji Arabic, no punctuation) ────────────────────────────
  const UPDATES = [
    // PKG001 General — only SA2 missing
    {id:'PKG001', sub:'general', cols:{
      'Answer_SA2': 'تحت امرك في عروض شهر العسل وعروض العوايل وعروض اليوم الوطني والعيد وكل عرض له ميزانيه تختلف ومدد تختلف فلو تحدد لي رغبتك نجيب لك الانسب'
    }},

    // PKG001 Specific_Destination — Keywords, SA2, OM missing
    {id:'PKG001', sub:'specific _destination', cols:{
      'Keywords': 'مصر دبي ابوظبي اندونيسيا بالي المالديف سريلانكا تايلاند ماليزيا البوسنه اذربيجان جورجيا تركيا البانيا كازاخستان موريشيوس كيب تاون الصين فيتنام روسيا',
      'Answer_SA2': 'كل وجهه عندها خياراتها الخاصه من فنادق وجولات ومواعيد افضل للسفر ولو ركزت على وجهه معينه ارسل لك تفاصيل اكثر',
      'Answer_OM': 'اكيد عندنا برامج للوجهات المذكوره خبرني الوجهه وعددكم ومتى التاريخ التقريبي عشان نضبط لك البكج'
    }},

    // PKG002 Customization
    {id:'PKG002', sub:'', cols:{
      'Answer_SA2': 'نقدر نزيد ايام او نشيل اي جوله ما تناسبك ونغير مستوى الفندق ونرفع او ننزل التكلفه حسب طلبك بدون اي تعقيد',
      'Answer_OM': 'اكيد نرتب البرنامج لك مثل ما تحب خبرني وش طلباتك بالضبط عشان نضبطها لك'
    }},

    // PKG003 Pricing
    {id:'PKG003', sub:'', cols:{
      'Answer_SA2': 'تتراوح اسعار البكجات اللي عندنا حسب الوجهه من خمس الاف ريال للوجهات القريبه الى خمسه وعشرين الف وفوق للوجهات البعيده والفخمه',
      'Answer_OM': 'ابشر الاسعار تختلف حسب الوجهه وعدد الافراد فاحتاج تساعدني تزودني بعدد المسافرين واعمارهم ووين تحبون'
    }},

    // PKG004 Trust
    {id:'PKG004', sub:'', cols:{
      'Answer_SA2': 'تقدر تشوف اراء عملائنا على قوقل وحساباتنا في الانستقرام والسناب والتويتر وكل التحويلات تكون على حساب باسم الشركه بالضبط',
      'Answer_OM': 'اكيد شركتنا رسميه ولها اكثر من سته عشر سنه بالسوق وكل وثائقها رسميه وتقدر تشوف اراء الزبائن في السوشيل ميديا'
    }},

    // PKG005 Support — fully empty
    {id:'PKG005', sub:'', cols:{
      'Keywords': 'تواصل تواصلكم رقم خدمه عملاء اتصال الواتساب الرد احد يخدمني استفسار سؤال ابي اكلم احد ابي مساعده',
      'sample Q': 'كيف اتواصل معكم وين رقمكم ابي اتكلم مع موظف عندكم خدمه عملاء متى تردون ابي حد يساعدني',
      'Answer_SA1': 'ابشر انا هنا اخدمك وش طلبك بالضبط',
      'Answer_SA2': 'نخدم عملاءنا على مدار اليوم تقريبا واي وقت تحتاج فيه شي ارسل لنا الواتس وراح نرد بسرعه',
      'Answer clarification': 'لو ما توضح طلبك تقدر تكتب لي ايش اللي يحيرك وانا اوصلك للموظف المختص فورا',
      'Answer_OM': 'هلا بك انا حاضر اخدمك وش اللي تبيه بالضبط'
    }},

    // PKG006 Includes — keywords/sampleQ present
    {id:'PKG006', sub:'', cols:{
      'Answer_SA1': 'غالبا البكج يكون شامل الفنادق والجولات والانتقالات والاستقبال من المطار',
      'Answer_SA2': 'بعض البكجات شامله الطيران الداخلي وبعضها شامله الوجبات بس الطيران الدولي عاده مو ضمن البكج الا اذا طلبته',
      'Answer clarification': 'اذا تبي بكج شامل كل شي او بدون طيران خبرني عشان اضبط لك الباقه الانسب',
      'Answer_OM': 'عاده البكج يشمل الفنادق والجولات والمواصلات واستقبال من المطار'
    }},

    // PKG0067 Duration — SA1 has junk so we leave it; fill the rest
    {id:'PKG0067', sub:'', cols:{
      'Keywords': 'مده كم يوم كم ليله طول الرحله duration نمدد نقصر يومين ايام اسبوع عشره ايام نمدد البرنامج اقصر اطول',
      'sample Q': 'كم يوم البكج كم تطول الرحله نقدر نمدد كم يوم افضل مده للزياره كم نحتاج كم ليله',
      'Answer_SA2': 'عاده نرشح لك بين خمس الى سبع ايام للوجهات القريبه وعشره الى اربعطعشر يوم للوجهات الابعد عشان تستمتع وما تتعب',
      'Answer clarification': 'لو تخبرني الوجهه ومتى تبي تسافر اقدر اخبرك عن المده المثلى وبرنامج كل يوم',
      'Answer_OM': 'المده تعتمد على وين تبا تسافر وش تحب تشوف بالضبط'
    }},

    // PKG008 Destination Recommendation — fully empty
    {id:'PKG008', sub:'', cols:{
      'Keywords': 'وجهات تنصحون ترشيح افضل دوله وجهه حلوه وين نروح اقتراح سفر destinations recommendations اقترح علي وين الانسب',
      'sample Q': 'وش وجهاتكم تنصحوني وين اروح افضل دوله للسفر شو احلى مكان نزوره عندكم اقتراحات وجهات',
      'Answer_SA1': 'عندنا وجهات حلوه كثيره وعلى راسها تركيا وماليزيا وتايلاند والمالديف',
      'Answer_SA2': 'نقدر نقترح عليك حسب اهتماماتك مثلا شي للبحر او شي للطبيعه او شي للتسوق والمدن الكبيره',
      'Answer clarification': 'قل لي وش تحب تشوف في رحلتك بحر او جبال او مدن سياحيه وانا اعطيك انسب الوجهات',
      'Answer_OM': 'عندنا وجهات حلوه ومتنوعه وش يجذبك اكثر بحر ولا جبال ولا مدن'
    }},

    // PKG009 Seasons Recommendation
    {id:'PKG009', sub:'', cols:{
      'Answer_SA1': 'كل موسم له وجهه تختلف عن الثاني وحسب الموسم اللي تبي تسافر فيه اقدر ارشح لك',
      'Answer_SA2': 'بالصيف نرشح تركيا والبوسنه واذربيجان لانها معتدله وبالشتا تايلاند وماليزيا والمالديف لانها دافيه',
      'Answer clarification': 'خبرني بشهر سفرك بالتقريب وانا اعطيك افضل خيار للوجهه الانسب للجو وقتها',
      'Answer_OM': 'كل موسم له وجهه مناسبه خبرني متى تبا تسافر وانا ارشح لك المناسب'
    }},

    // PKG0010 Booking Process General
    {id:'PKG0010', sub:'general booking process', cols:{
      'Answer_SA1': 'حجزك بكل بساطه نتفق على الباقه وانت تحول العربون ونثبت لك الحجز',
      'Answer_SA2': 'بعد ما نستلم العربون نرسل لك تأكيد الفنادق والطيران وكامل البرنامج خطوه خطوه',
      'Answer clarification': 'لو تبي اشرح لك الخطوات بالترتيب من الاول جاهز اخدمك واي خطوه ما واضحه لك خبرني',
      'Answer_OM': 'الحجز سهل نتفق على البكج وانت تدفع العربون ونثبت لك كل شي'
    }},

    // PKG0011 Payment Method — fully empty
    {id:'PKG0011', sub:'payment method', cols:{
      'Keywords': 'دفع طريقه الدفع تحويل حساب بنكي فيزا ماستركارد ايبان عربون payment transfer مدفوعات تحويل بنكي',
      'sample Q': 'كيف ادفع وش طرق الدفع عندكم اقدر ادفع بالفيزا يوصل تحويل بنكي وش ايبانكم كيف اسدد',
      'Answer_SA1': 'الدفع يكون تحويل بنكي على حسابنا الرسمي وما نقبل غيرها',
      'Answer_SA2': 'بعد ما تتفق على البكج نرسل لك الايبان وتحول العربون ونثبت الحجز ولما يقترب موعد السفر تحول الباقي',
      'Answer clarification': 'لو تحتاج تفاصيل اكثر عن طريقه التحويل او الحساب البنكي قول لي وانا ارسل لك المعلومات',
      'Answer_OM': 'الدفع تحويل بنكي بس على حسابنا الرسمي وما نتعامل بغيره'
    }},

    // PKG0012 Honeymoon
    {id:'PKG0012', sub:'', cols:{
      'Answer_SA2': 'نقدر نرتب لك جوله مخصصه للعرسان بمنتجعات هادئه وغرف بمسبح خاص اذا تبي خصوصيه او برنامج فيه فعاليات وتسوق',
      'Answer_OM': 'خيارات شهر العسل كثيره خبرني وش تفضل بحر وهدوء او تنوع انشطه وتسوق'
    }},

    // PKG0015 Family adults
    {id:'PKG0015', sub:'', cols:{
      'Answer_SA2': 'نوفر فنادق عائليه وجولات مناسبه للعدد ونرتب لك سيارات واسعه عشان الكل يكون مرتاح خصوصا الكبار',
      'Answer_OM': 'خبرني تقريبا اعمار من معاكم وهل تبا برنامج هادي ولا فيه انشطه'
    }},

    // PKG0016 Family with kids
    {id:'PKG0016', sub:'', cols:{
      'Answer_SA2': 'نرشح لكم اماكن فيها ملاهي ومسابح وحدائق وحياه بريه ونرتب لكم جولات تناسب اعمار الاطفال',
      'Answer_OM': 'خبرني اعمار الاطفال وش يحبون عشان نضبط لكم الجولات'
    }},

    // PKG0017 Vehicle Capacity
    {id:'PKG0017', sub:'vehicle_capacity', cols:{
      'Answer_SA2': 'السياره المختاره عاده مناسبه للعدد المذكور في العرض وتحمل عفش معتدل ولو فيه عفش زياده نقدر نوفر سياره اكبر بفرق سعر',
      'Answer_OM': 'نوفر سياره تناسب عدد المسافرين خبرني كم فرد وكم شنطه عشان نختار لك المناسب'
    }},

    // PKG0018 Driver Language
    {id:'PKG0018', sub:'driver-language', cols:{
      'Answer_SA2': 'عندنا سايقين عرب في تركيا وتايلاند وماليزيا والمالديف واغلب الوجهات السياحيه واذا الوجهه ما فيها سايق عربي نوفر لك مرشد عربي بدله',
      'Answer_OM': 'اغلب الوجهات فيها سايق عربي خبرني الوجهه وانا اعرفك'
    }},

    // PKG0019 Vehicle Condition
    {id:'PKG0019', sub:'vehicle_condition& type', cols:{
      'Answer_SA2': 'سياراتنا حديثه ومكيفه ومريحه ولو تبي مستوى افخم مثل سيارات VIP او دفع رباعي او سياره بسائق خاص نوفرها بفرق سعر',
      'Answer_OM': 'سياراتنا حديثه ومكيفه ونظيفه واي عطل نغيرها فورا'
    }},

    // PKG0020 Tour Duration
    {id:'PKG0020', sub:'tour duration', cols:{
      'Answer_SA1': 'الجولات تختلف من نص يوم الى يوم كامل وحسب نوع الجوله نفسها',
      'Answer_SA2': 'الجولات القصيره تكون اربع الى خمس ساعات والكامله من ثمان الى عشر ساعات وتشمل وجبه غدا غالبا',
      'Answer clarification': 'اذا تبي تفاصيل اوقات كل جوله بالضبط لاي وجهه خبرني الوجهه وانا اعطيك الجدول',
      'Answer_OM': 'الجولات بين نص يوم الى يوم كامل حسب الجوله نفسها'
    }},

    // PKG0021 Tour Flexibility
    {id:'PKG0021', sub:'tour flexibility', cols:{
      'Answer_SA1': 'اكيد تقدر تختار جولاتك حسب رغبتك ومافي شي مفروض عليك',
      'Answer_SA2': 'نقدر نقترح لك جدول ابتدائي ثم نعدله معك ونضيف او نشيل اي جوله ما تناسبك',
      'Answer clarification': 'لو تحتار في اختيار الجولات خبرني اهتماماتك وانا ارشح لك الانسب وتقرر تضيفها او لا',
      'Answer_OM': 'اكيد جولاتك مرنه نقدر نغير ونضيف ونحذف زي ما تحب'
    }},

    // PKG0022 International Flight (SA1 = "البكج" stays, fill SA2 + OM)
    {id:'PKG0022', sub:'international flight', cols:{
      'Answer_SA2': 'نوفر تذاكر من السعوديه وعمان والامارات وكل الخليج وحسب رحلتك نختار الخط الانسب من ناحيه السعر والمواعيد',
      'Answer_OM': 'البكج شامل الطيران الدولي خبرني وين مدينتك وانا اشيك على الافضل'
    }},

    // PKG0023 Flight Timing
    {id:'PKG0023', sub:'international flight timing', cols:{
      'Answer_SA1': 'مواعيد الرحلات تختلف من خط طيران لاخر وحسب وقت السفر بالضبط',
      'Answer_SA2': 'غالبا الرحلات للوجهات السياحيه تقلع من السعوديه فجرا او ليلا وتستغرق من اربع الى اثنا عشر ساعه حسب الوجهه',
      'Answer clarification': 'لو تخبرني الوجهه ومن اي مدينه تقلع اقدر اعطيك مواعيد دقيقه ومده الرحله بالضبط',
      'Answer_OM': 'مواعيد الرحلات تختلف حسب خط الطيران والوجهه'
    }},

    // PKG0024 Flight Cancellation
    {id:'PKG0024', sub:'flight cancelatoin/change', cols:{
      'Answer_SA1': 'الالغاء يعتمد على شروط شركه الطيران ووقت الالغاء قبل الموعد',
      'Answer_SA2': 'عاده الالغاء فيه رسوم خصم تختلف حسب نوع التذكره وقربها من موعد السفر والريفند ياخذ من اسبوعين لشهر',
      'Answer clarification': 'لو تبي تفاصيل عن تذكرتك بالتحديد خبرني رقم الحجز وانا اشيك لك على رسوم الالغاء بالضبط',
      'Answer_OM': 'الالغاء حسب شروط شركه الطيران ووقت الالغاء قبل السفر'
    }},

    // PKG0025 Flight Change
    {id:'PKG0025', sub:'flight change', cols:{
      'Answer_SA1': 'التعديل ممكن غالبا بس فيه رسوم وفرق سعر اذا اختلف يوم السفر',
      'Answer_SA2': 'لو تبي تقدم او تأخر الرحله نقدر نعدلها مع ملاحظه ان فرق السعر ممكن يطلع موجب او سالب حسب يوم الرحله الجديد',
      'Answer clarification': 'ابعت لي رقم الحجز ومتى تبي اليوم الجديد وانا اشيك لك على الفرق والرسوم',
      'Answer_OM': 'التعديل ممكن غالبا بس فيه رسوم وفرق سعر'
    }},

    // PKG0026 Intl Baggage
    {id:'PKG0026', sub:'intenational flight baggage weight', cols:{
      'Answer_SA1': 'الوزن المسموح للرحلات الدوليه عاده ثلاثين كيلو للحقيبه الكبيره مع سبع كيلو للكابينه',
      'Answer_SA2': 'بعض الخطوط مثل السعوديه والخليج تسمح بقطعتين ثلاث وعشرين كيلو لكل وحده والعمانيه قطعه واحده ثلاثين كيلو',
      'Answer clarification': 'لو تخبرني خط الطيران واسم البكج اقدر اعطيك الوزن المسموح بالضبط',
      'Answer_OM': 'الوزن للرحلات الدوليه غالبا ثلاثين كيلو وكابينه سبع كيلو'
    }},

    // PKG0027 Domestic Baggage
    {id:'PKG0027', sub:'domestic flight baggage weight', cols:{
      'Answer_SA1': 'الرحلات الداخليه عاده تسمح بعشرين كيلو للحقيبه الكبيره مع سبع كيلو للكابينه',
      'Answer_SA2': 'بعض الوجهات الداخليه ممكن تكون السمحه اقل مثل خمسطعشر كيلو والوزن الزياده له رسوم بسيطه',
      'Answer clarification': 'خبرني اي وجهه داخليه واي خط طيران وانا اعطيك الوزن المسموح بالضبط',
      'Answer_OM': 'الداخلي عشرين كيلو وكابينه سبع كيلو غالبا'
    }},

    // PKG0028 Items Allowed
    {id:'PKG0028', sub:'flight baggage itmes allawed', cols:{
      'Answer_SA1': 'السوائل تكون بالشحن لا بالكابينه والاجهزه الالكترونيه والباور بانك بالكابينه فقط',
      'Answer_SA2': 'الادويه ممكن تكون معك بالكابينه مع روشته طبيه والعطور والكريمات السائله ممنوعه بالكابينه فوق ميه ملي ولكنها مسموحه بالعفش',
      'Answer clarification': 'لو تبي تتأكد من غرض محدد قبل السفر اكتب لي اسمه وانا اخبرك مسموح ولا ممنوع وين تحطه',
      'Answer_OM': 'السوائل بالشحن والباور بانك بالكابينه فقط'
    }},

    // PKG0029 Seatings
    {id:'PKG0029', sub:'flight seatings', cols:{
      'Answer_SA1': 'اختيار المقاعد يكون اثناء الحجز او عند الاستلام بالمطار وغالبا فيه رسوم لاختيار المسبق',
      'Answer_SA2': 'المقاعد الاماميه ومخارج الطوارئ غالبا يطلبون رسوم اضافيه والمقاعد العاديه ممكن تطلبها مجانا قبل اربع وعشرين ساعه من الرحله',
      'Answer clarification': 'لو تبي مقاعد عائليه جنب بعض او شباك او ممر خبرني وانا احجزها لك',
      'Answer_OM': 'اختيار المقاعد عند الحجز او بالمطار وفيه رسوم للاماميه'
    }},

    // PKG0030 Hotel Level
    {id:'PKG0030', sub:'', cols:{
      'Answer_SA1': 'نقدر نوفر لك مستويات مختلفه من فنادق ثلاث نجوم اقتصاديه الى خمس نجوم فاخره',
      'Answer_SA2': 'المستوى المتوسط اربع نجوم يكون عاده الافضل من ناحيه السعر والخدمه ويناسب اغلب العملاء',
      'Answer clarification': 'خبرني ميزانيتك ومستوى الفندق اللي تبي وانا اقترح عليك خيارات مناسبه',
      'Answer_OM': 'عندنا فنادق من ثلاث نجوم الى خمس نجوم حسب ميزانيتك'
    }},

    // PKG0031 Flexibility
    {id:'PKG0031', sub:'', cols:{
      'Answer_SA1': 'البكج كله مرن ونقدر نعدله حسب رغبتك سواء فنادق او جولات او مدد',
      'Answer_SA2': 'نقدر نزيد ايام او ننقص او نضيف مدن او نغير مستوى الفندق او نخصص الجولات حسب طلبك',
      'Answer clarification': 'لو تبي تعدل شي معين قول لي ايش بالضبط وانا اضبطه لك',
      'Answer_OM': 'البكج مرن جدا نقدر نعدل اي شي حسب طلبك'
    }},

    // PKG0032 Interest — only OM missing
    {id:'PKG0032', sub:'', cols:{
      'Answer_OM': 'تحت امرك خبرني وش تبي تشوف بالضبط وش ميزانيتك ومتى تبا تسافر عشان نرشح لك'
    }}
  ];

  // ── engine ───────────────────────────────────────────────────────────────
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const all = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = all[0].map(h => String(h).trim().toLowerCase());

  const want = ['ID','Sub-intent','Keywords','sample Q','Answer_SA1','Answer_SA2','Answer clarification','Answer_OM'];
  const colByName = {};
  for (const name of want) {
    const idx = header.indexOf(name.toLowerCase());
    if (idx < 0) {
      SpreadsheetApp.getUi().alert('Header not found: ' + name);
      return;
    }
    colByName[name] = idx;
  }

  const yellow = '#FFF59D';
  const lightBlue = '#BBDEFB';
  const white = '#ffffff';
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  let rowsTouched = 0, cellsFilled = 0, notFound = 0;
  const log = [];

  for (const u of UPDATES) {
    let rowIdx = -1;
    for (let r = 1; r < all.length; r++) {
      const rowId  = norm(all[r][colByName['ID']]);
      const rowSub = norm(all[r][colByName['Sub-intent']]);
      if (rowId === norm(u.id) && rowSub === norm(u.sub)) {
        rowIdx = r;
        break;
      }
    }
    if (rowIdx < 0) {
      notFound++;
      log.push('NOT FOUND: ' + u.id + ' / ' + u.sub);
      continue;
    }

    // Read current backgrounds so we can preserve previously-set yellow.
    const curBgs = sheet.getRange(rowIdx + 1, 1, 1, lastCol).getBackgrounds()[0];
    const newBgs = curBgs.slice();

    // Default the row to light-blue where it's still untouched.
    for (let c = 0; c < lastCol; c++) {
      const cur = (curBgs[c] || '').toLowerCase();
      if (!cur || cur === white) newBgs[c] = lightBlue;
    }

    // Fill empty cells; mark them yellow.
    let filledThisRow = 0;
    for (const [colName, value] of Object.entries(u.cols)) {
      const colIdx = colByName[colName];
      const existing = String(all[rowIdx][colIdx] || '').trim();
      if (existing) continue; // never overwrite
      sheet.getRange(rowIdx + 1, colIdx + 1).setValue(value);
      newBgs[colIdx] = yellow;
      filledThisRow++;
    }

    if (filledThisRow > 0) {
      sheet.getRange(rowIdx + 1, 1, 1, lastCol).setBackgrounds([newBgs]);
      rowsTouched++;
      cellsFilled += filledThisRow;
      log.push('Row ' + (rowIdx+1) + ' (' + u.id + '/' + u.sub + '): filled ' + filledThisRow + ' cells');
    } else {
      log.push('Row ' + (rowIdx+1) + ' (' + u.id + '/' + u.sub + '): nothing to fill (all target cells already non-empty)');
    }
  }

  log.forEach(l => Logger.log(l));
  SpreadsheetApp.getActive().toast(
    'صفوف: ' + rowsTouched + ' • خلايا: ' + cellsFilled + ' • غير موجود: ' + notFound,
    'انتهى', 8
  );
}
