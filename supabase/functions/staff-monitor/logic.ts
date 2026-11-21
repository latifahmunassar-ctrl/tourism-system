// ── الوقت بتوقيت عُمان (UTC+4 ثابت، بلا توقيت صيفي) ──
export const OM = 4 * 3600e3;
export const omParts = (d: Date) => { const o = new Date(d.getTime() + OM); return { dow: o.getUTCDay(), mins: o.getUTCHours() * 60 + o.getUTCMinutes(), ymd: o.toISOString().slice(0, 10) }; };
export const omHM = (d: string | Date | null) => { if (!d) return '—'; const o = new Date(new Date(d).getTime() + OM); return String(o.getUTCHours()).padStart(2, '0') + ':' + String(o.getUTCMinutes()).padStart(2, '0'); };
export const omDate = (d: string | Date | null) => { if (!d) return '—'; const o = new Date(new Date(d).getTime() + OM); return String(o.getUTCDate()).padStart(2, '0') + '/' + String(o.getUTCMonth() + 1).padStart(2, '0') + '/' + o.getUTCFullYear(); };
export const hm = (s: string | null) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
export const digits = (p: string | null) => String(p || '').replace(/\D/g, '');

// هل الموظفة في وقت دوامها لحظة t؟ (الفترة اللي تعدّي منتصف الليل تُحسب ليوم بدايتها)
export function onShift(s: any, t: Date): boolean {
  const days: number[] = Array.isArray(s.work_days) && s.work_days.length ? s.work_days : [0, 1, 2, 3, 4, 5, 6];
  const { dow, mins } = omParts(t);
  const prev = (dow + 6) % 7;
  for (const [a, b] of [[s.shift1_start, s.shift1_end], [s.shift2_start, s.shift2_end]]) {
    const st = hm(a), en = hm(b); if (st == null || en == null) continue;
    if (en > st) { if (days.includes(dow) && mins >= st && mins < en) return true; }
    else { // تعدّي منتصف الليل
      if (days.includes(dow) && mins >= st) return true;
      if (days.includes(prev) && mins < en) return true;
    }
  }
  return false;
}

// تحليل طلب إذن/إجازة مكتوب بالواتساب (أفضل جهد — والإدارة تقدر تعدّل الوقت من النظام)
export function parseLeave(text: string, now: Date): { kind: string; from: Date | null; to: Date | null } {
  const t = String(text || '').replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
  const kind = /إذن|اذن|انصراف|استئذان/.test(t) ? 'إذن انصراف' : /تفر[غّ]/.test(t) ? 'تفرّغ' : 'إجازة';
  const om = new Date(now.getTime() + OM); const Y = om.getUTCFullYear();
  const dayAt = (y: number, m: number, d: number, mins: number) => new Date(Date.UTC(y, m - 1, d, 0, 0) - OM + mins * 60000);
  const dates: { y: number; m: number; d: number }[] = [];
  for (const m of t.matchAll(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?/g)) { const d = +m[1], mo = +m[2]; if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) dates.push({ y: m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : Y, m: mo, d }); }
  if (!dates.length) { const base = /بكر[هة]|غد[اًا]?\b|باكر/.test(t) ? new Date(om.getTime() + 86400e3) : om; dates.push({ y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() }); }
  const d1 = dates[0], d2 = dates[dates.length - 1];
  // أوقات: «من 5 الى 7» / «من الساعة 4:30 إلى 6 مساء»
  const tm = t.match(/(?:من\s*(?:الساعة|الساعه)?\s*)(\d{1,2})(?::(\d{2}))?\s*(ص|م|صباح\S*|مساء\S*|عصر\S*|ظهر\S*)?\s*(?:الى|إلى|لين|لحد|حتى|-|–)\s*(?:الساعة|الساعه)?\s*(\d{1,2})(?::(\d{2}))?\s*(ص|م|صباح\S*|مساء\S*|عصر\S*|ظهر\S*|الليل|بالليل)?/);
  if (tm) {
    const conv = (h: number, mi: number, suf: string | undefined, ref?: number) => { let H = h; const pm = suf && /^(م|مساء|عصر|ظهر|الليل|بالليل)/.test(suf); const am = suf && /^(ص|صباح)/.test(suf); if (pm && H < 12) H += 12; else if (!am && !pm && H < 8) H += 12; if (ref != null && H * 60 + mi <= ref && H < 12) H += 12; return H * 60 + mi; };
    const a = conv(+tm[1], +(tm[2] || 0), tm[3] || tm[6]); let b = conv(+tm[4], +(tm[5] || 0), tm[6], a); if (b <= a) b += 24 * 60;
    return { kind: kind === 'إجازة' ? 'إذن انصراف' : kind, from: dayAt(d1.y, d1.m, d1.d, a), to: dayAt(d1.y, d1.m, d1.d, b) };
  }
  return { kind, from: dayAt(d1.y, d1.m, d1.d, 0), to: dayAt(d2.y, d2.m, d2.d, 24 * 60) };
}

