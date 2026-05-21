/**
 * fillAnswerClarifications — Google Apps Script
 *
 * Target sheet: ALEZZ Chat (ID 1wBbUNMyZvYMFzxhw9CSVWZvnolMX_yzr13bUVfUxmYQ)
 * Behavior: for each row where Answer_SA1 has content but
 *           Answer clarification (column H) is empty AND the row's ID is in REPLIES,
 *           write the Khaleeji-Arabic clarification + highlight the cell yellow.
 *
 * Run from: Sheet → Extensions → Apps Script → paste this file → click Run.
 */
function fillAnswerClarifications() {
  // Khaleeji-Arabic clarifications. No punctuation marks.
  const REPLIES = {
    'PKG002':  'خبرني وش بالتحديد تبي تغير سواء فنادق ولا جولات ولا الطيران ولا المده وحدد لي مستواك اللي تبغاه فخم ولا متوسط ولا اقتصادي عشان نضبط الباكج لك',
    'PKG003':  'بالنسبه للسعر يعتمد على الوجهه وعدد المسافرين وتواريخ السفر والمده اللي تبيها فلو تزودني بهالتفاصيل اقدر اعطيك سعر دقيق',
    'PKG004':  'اقدر اوريك صفحاتنا في السوشيل ميديا فيها اراء العملاء اللي خدمناهم وكل التحويلات تنزل على حساب بنكي رسمي باسم الشركه فلو تبي نمشي خطوه خطوه احنا حاضرين',
    'PKG0012': 'خبرني ميزانيتك تقريبا وكم مده تبي تقضيها وهل تفضل بحر وهدوء او تنوع انشطه وتسوق عشان ارشح لك الوجهه الانسب لكم',
    'PKG0015': 'خبرني تقريبا اعمار الموجودين معاكم وهل في كبار سن مايتحملون رحلات طويله وايش يحبون اكثر استجمام او تسوق او طبيعه عشان نختار الوجهه اللي تناسبهم',
    'PKG0016': 'خبرني اعمار الاطفال تقريبا وايش يحبون اكثر ملاهي ولا مسابح ولا الحياه البريه عشان اضبط لك جولات تناسبهم',
    'PKG0017': 'زودني بعدد الاشخاص الكامل بالتحديد وكم شنطه راح يكون معاكم لكل واحد عشان اختار لك سياره مريحه ومناسبه للعدد والامتعه',
    'PKG0018': 'حدد لي الوجهه اللي حابب تسافر لها وانا اوضح لك مباشره هل متوفر فيها سايق عربي ولا نوفر لك مرشد بدله',
    'PKG0019': 'لو تحب نوع سياره معين مثل دفع رباعي او فان فخم خبرني عشان احجز لك المناسب من ضمن خياراتنا',
    'PKG0022': 'البكج شامل الطيران الدولي بس احتاج تخبرني وين مدينتك يعني من اي مطار راح تنطلق ومتى تواريخك تقريبا عشان اشيك على افضل الخيارات',
    'PKG0032': 'حدد لي ميزانيتك تقريبا وهل تفضل وجهه قريبه او بعيده ونوع السفر اللي تبيه استكشاف ولا استجمام ولا تسوق عشان اقترح عليك الانسب'
  };

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const all = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = all[0].map(h => String(h).trim().toLowerCase());

  const idCol   = header.indexOf('id');
  const sa1Col  = header.indexOf('answer_sa1');
  const clarCol = header.indexOf('answer clarification');

  if (idCol < 0 || sa1Col < 0 || clarCol < 0) {
    SpreadsheetApp.getUi().alert('Header not found. Expected columns: ID, Answer_SA1, Answer clarification');
    return;
  }

  const yellow = '#FFF59D';
  let updated = 0, skipped = 0;
  const log = [];

  for (let r = 1; r < all.length; r++) {
    const id   = String(all[r][idCol] || '').trim();
    const sa1  = String(all[r][sa1Col] || '').trim();
    const clar = String(all[r][clarCol] || '').trim();
    const reply = REPLIES[id];
    if (!reply) continue;
    if (!sa1)   { skipped++; log.push('Row ' + (r+1) + ' (' + id + '): SA1 empty — skipped'); continue; }
    if (clar)   { skipped++; log.push('Row ' + (r+1) + ' (' + id + '): H already filled — skipped'); continue; }

    const cell = sheet.getRange(r + 1, clarCol + 1);
    cell.setValue(reply);
    cell.setBackground(yellow);
    updated++;
    log.push('Row ' + (r+1) + ' (' + id + '): updated');
  }

  log.forEach(l => Logger.log(l));
  SpreadsheetApp.getActive().toast('تم تحديث ' + updated + ' صف وتخطّي ' + skipped, 'انتهى', 6);
}
