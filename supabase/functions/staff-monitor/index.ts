// 🕘 الحضور والمخالفات (طلب المالكة ٢١ نوفمبر ٢٠٢٦)
// - الحارس (601) عند التذكير العاشر بلا رد → sm-violation → نحدد المسؤولة حسب جدول الدوام (توقيت عُمان):
//     • استلمت موظفة الطلب ولم ترد → المخالفة عليها وحدها.
//     • لم يستلمه أحد → المخالفة على كل الموظفات اللي كان وقت دوامهن.
//     • موظفة بإذن/إجازة معتمدة وقتها → تُكتب المخالفة «غير مطبّقة — إذن انصراف».
// - إشعار المخالفة يروح لقروب الموظفة الخاص (هي + المالكة + المحاسب) عبر صندوق staff_notices.
// - الموظفة تعترض بالرد على الإشعار؛ الإدارة تلغي/تثبّت بالرد أو من النظام المحاسبي.
// - اعتماد إذن لاحقاً يغطي وقت المخالفة → تُلغى تلقائياً.
// الصلاحيات: x-bridge-token (الحارس) أو مفتاح/جلسة النظام المحاسبي (المالكة/المحاسب).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ACCESS_KEY = 'alezz-2027-12ecc215b4f92deda19ed956937c3899';
const BRIDGE_TOKEN = Deno.env.get('WA_BRIDGE_TOKEN') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-acc-key, x-acc-token, x-bridge-token, content-type, apikey', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

import { OM, omParts, omHM, omDate, hm, digits, onShift, parseLeave } from './logic.ts';

const STATUS_AR: Record<string, string> = { applied: '✅ مطبّقة', not_applied_leave: '⏸️ غير مطبّقة — إذن انصراف', under_review: '🔎 قيد المراجعة (اعتراض)', cancelled: '❌ ملغاة' };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const url = new URL(req.url);
  let body: any = {}; try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || ''); const p = body.payload || body;

  // ── الصلاحيات ──
  const isBridge = !!BRIDGE_TOKEN && req.headers.get('x-bridge-token') === BRIDGE_TOKEN;
  let who = '';
  if (!isBridge) {
    const key = req.headers.get('x-acc-key') || url.searchParams.get('key');
    if (key === ACCESS_KEY) who = 'المالكة';
    else {
      const tok = req.headers.get('x-acc-token') || url.searchParams.get('token');
      if (tok) {
        const { data: s } = await sb.from('acc_sessions').select('staff_name,is_owner,expires_at').eq('token', tok).maybeSingle();
        if (s && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now())) {
          if (s.is_owner) who = s.staff_name || 'المالكة';
          else { const { data: sa } = await sb.from('acc_staff_access').select('role,active').eq('staff_name', s.staff_name).maybeSingle(); if (sa && sa.active !== false && /محاسب|accountant/i.test(String(sa.role || ''))) who = s.staff_name; }
        }
      }
    }
    if (!who) return J({ error: 'unauthorized' }, 401);
  }

  const cfg = async () => { const { data } = await sb.from('acc_config').select('key,value').like('key', 'sm_%'); const m: any = {}; (data || []).forEach((r: any) => m[r.key] = r.value); return { enabled: String(m.sm_enabled) === 'true', amount: Number(m.sm_fine_amount || 10), currency: String(m.sm_fine_currency || 'SAR'), edit_group: String(m.sm_edit_group || '') }; };
  const staffAll = async () => { const { data } = await sb.from('staff_schedule').select('*').order('name'); return data || []; };
  const notify = async (staff_id: number, text: string, extra: any = {}) => { await sb.from('staff_notices').insert({ staff_id, body: text, ...extra }); };
  const curAr = (c: string) => c === 'SAR' ? 'ريال سعودي' : c === 'OMR' ? 'ريال عُماني' : c;

  // إلغاء المخالفات اللي يغطيها إذن معتمد (يُستدعى عند اعتماد إذن، حتى لو متأخر)
  const voidByLeave = async (leave: any, by: string) => {
    if (!leave || leave.status !== 'approved' || !leave.from_ts || !leave.to_ts) return 0;
    const { data: vs } = await sb.from('staff_violations').select('*').eq('staff_id', leave.staff_id).in('status', ['applied', 'under_review']).gte('occurred_at', leave.from_ts).lt('occurred_at', leave.to_ts);
    for (const v of vs || []) {
      await sb.from('staff_violations').update({ status: 'cancelled', leave_id: leave.id, decided_by: by, decided_at: new Date().toISOString(), decision_note: 'أُلغيت تلقائياً — اعتُمد ' + leave.kind + ' يغطي وقت المخالفة' }).eq('id', v.id);
      await notify(v.staff_id, `✅ أُلغيت المخالفة #${v.id}\n🏢 ${v.company || ''}\n📋 ${String(v.request_summary || '').slice(0, 80)}\nالسبب: اعتُمد ${leave.kind} يغطي وقت المخالفة (${omDate(v.occurred_at)} ${omHM(v.occurred_at)}).`, { violation_id: v.id, leave_id: leave.id });
    }
    return (vs || []).length;
  };
  const leaveLabel = (l: any) => `${l.kind} من ${omDate(l.from_ts)} ${omHM(l.from_ts)} إلى ${omDate(l.to_ts)} ${omHM(l.to_ts)}`;

  try {
    // ════════════════ أوامر الحارس ════════════════
    if (isBridge) {
      if (action === 'sm-config') {
        const c = await cfg(); const st = (await staffAll()).filter((s: any) => s.active);
        return J({ ok: true, ...c, staff: st.map((s: any) => ({ id: s.id, name: s.name, phone: digits(s.phone), group: s.violation_group || '' })) });
      }

      if (action === 'sm-violation') {
        const c = await cfg(); if (!c.enabled) return J({ ok: true, disabled: true, violations: [] });
        const at = p.at ? new Date(p.at) : new Date();
        const st = (await staffAll()).filter((s: any) => s.active);
        const ackPh = digits(p.ack_phone);
        let targets: any[] = []; let reason = '';
        if (p.acked) {
          const s = st.find((x: any) => ackPh && digits(x.phone) === ackPh) || st.find((x: any) => p.ack_name && String(x.name).trim() === String(p.ack_name).trim());
          if (s) { targets = [s]; reason = 'استلمتِ الطلب ولم تردّي على الشركة حتى التذكير العاشر'; }
        }
        if (!targets.length) { targets = st.filter((s: any) => onShift(s, at)); reason = p.acked ? 'استُلم الطلب من رقم غير مسجّل ولم يُرد عليه — على كل من كانت في دوامها' : 'لم يستلم الطلب أحد خلال الدوام حتى التذكير العاشر'; }
        else if (!onShift(targets[0], at)) {
          // استلمته لكن انتهى دوامها قبل التذكير العاشر → ما تُحسب عليها؛ تُحسب على اللي في دوامها
          targets = st.filter((s: any) => onShift(s, at)); reason = 'استلمته موظفة انتهى دوامها ولم يُرد عليه — على كل من كانت في دوامها';
        }
        const out: any[] = [];
        for (const s of targets) {
          const { data: lv } = await sb.from('staff_leaves').select('*').eq('staff_id', s.id).eq('status', 'approved').lte('from_ts', at.toISOString()).gt('to_ts', at.toISOString()).limit(1);
          const leave = (lv || [])[0];
          const { data: pend } = await sb.from('staff_leaves').select('id').eq('staff_id', s.id).eq('status', 'pending').limit(1);
          const status = leave ? 'not_applied_leave' : 'applied';
          const row = { staff_id: s.id, staff_name: s.name, occurred_at: at.toISOString(), received_at: p.received_at || null, kind: p.kind === 'تعديل' ? 'تعديل' : 'رد', company: p.company || null, request_summary: String(p.summary || '').slice(0, 300), request_key: String(p.key || '').slice(0, 200), reason, amount: c.amount, currency: c.currency, status, leave_id: leave ? leave.id : null };
          const { data: ins, error } = await sb.from('staff_violations').insert(row).select().single();
          if (error) { if (/duplicate|unique/i.test(error.message)) continue; throw error; }
          const lines = [
            '🧾 إشعار مخالفة #' + ins.id, '',
            '👩‍💼 الموظفة: ' + s.name,
            '💰 القيمة: ' + c.amount + ' ' + curAr(c.currency),
            '📌 الحالة: ' + (leave ? '⏸️ غير مطبّقة — عندك ' + leaveLabel(leave) : '✅ مطبّقة'),
            '📂 النوع: ' + (row.kind === 'تعديل' ? 'تعديل من الشركة بلا رد' : 'طلب شركة بلا رد'),
            '🏢 الشركة: ' + (p.company || '—'),
            '📋 الطلب: ' + String(p.summary || '').slice(0, 120),
            '🕐 وصل: ' + omHM(p.received_at) + ' · التذكير العاشر: ' + omHM(at) + ' (' + omDate(at) + ')',
            '❓ السبب: ' + reason,
          ];
          if (!leave) {
            lines.push('', '✍️ للاعتراض: ردّي على هذه الرسالة بالسبب، وأرفقي صورة ردّك على الشركة إن وُجد.');
            if (pend && pend.length) lines.push('ℹ️ عندك طلب إذن/إجازة بانتظار الموافقة — لو اعتُمد ويغطي هذا الوقت تُلغى المخالفة تلقائياً.');
          }
          const text = lines.join('\n');
          await notify(s.id, text, { violation_id: ins.id });
          out.push({ id: ins.id, name: s.name, status });
        }
        return J({ ok: true, violations: out, reason, nobody_on_shift: !targets.length });
      }

      if (action === 'sm-outbox') {
        const { data } = await sb.from('staff_notices').select('id,staff_id,violation_id,leave_id,body').is('sent_at', null).order('id').limit(20);
        return J({ ok: true, notices: data || [] });
      }
      if (action === 'sm-sent') {
        const now = new Date().toISOString();
        await sb.from('staff_notices').update({ sent_at: now, msg_id: p.msg_id || null }).eq('id', p.id);
        if (p.msg_id) {
          const { data: n } = await sb.from('staff_notices').select('violation_id,body').eq('id', p.id).maybeSingle();
          if (n && n.violation_id && /^🧾 إشعار مخالفة/.test(n.body || '')) await sb.from('staff_violations').update({ notice_msg_id: p.msg_id }).eq('id', n.violation_id);
        }
        return J({ ok: true });
      }

      // رسالة داخل قروب مخالفات موظفة: p = { staff_id, from_staff, sender_name, text, media, quoted_msg_id, msg_id }
      if (action === 'sm-group-msg') {
        const s = (await staffAll()).find((x: any) => x.id === Number(p.staff_id)); if (!s) return J({ ok: true });
        const text = String(p.text || '').trim(); const now = new Date();
        const findV = async () => { if (!p.quoted_msg_id) return null; const { data } = await sb.from('staff_violations').select('*').eq('staff_id', s.id).eq('notice_msg_id', p.quoted_msg_id).maybeSingle(); return data; };
        const findL = async () => { if (!p.quoted_msg_id) return null; const { data } = await sb.from('staff_leaves').select('*').eq('staff_id', s.id).eq('msg_id', p.quoted_msg_id).maybeSingle(); return data; };
        if (p.from_staff) {
          // ① طلب إذن/إجازة
          if (!p.quoted_msg_id && /(طلب|ابغى|أبغى|ابي|أبي|اريد|أريد|استأذن|استاذن|ممكن)\s*.{0,10}(إجاز|اجاز|إذن|اذن|تفر[غّ]|انصراف)|^(إجاز|اجاز|إذن|اذن)/.test(text)) {
            const pl = parseLeave(text, now);
            const { data: lv } = await sb.from('staff_leaves').insert({ staff_id: s.id, kind: pl.kind, from_ts: pl.from?.toISOString() || null, to_ts: pl.to?.toISOString() || null, status: 'pending', request_text: text.slice(0, 500), source: 'whatsapp', msg_id: p.msg_id || null }).select().single();
            return J({ ok: true, reply: `📝 سُجّل طلبك #${lv.id}: ${leaveLabel(lv)}\n⏳ بانتظار موافقة الإدارة.\n(للإدارة: ردّوا على رسالة الطلب بـ«موافق» أو «مرفوض»، أو من النظام المحاسبي ← الحضور والمخالفات)` });
          }
          // ② اعتراض على مخالفة (رد على الإشعار)
          const v = await findV();
          if (v && v.status !== 'cancelled') {
            const upd: any = { objection_text: [v.objection_text, text || (p.media ? '📎 مرفق' : '')].filter(Boolean).join('\n— ').slice(0, 1500), objection_media: !!(v.objection_media || p.media), objection_at: now.toISOString() };
            if (v.status === 'applied') upd.status = 'under_review';
            await sb.from('staff_violations').update(upd).eq('id', v.id);
            const { data: pend } = await sb.from('staff_leaves').select('*').eq('staff_id', s.id).eq('status', 'pending');
            const covering = (pend || []).find((l: any) => l.from_ts && l.to_ts && v.occurred_at >= l.from_ts && v.occurred_at < l.to_ts);
            return J({ ok: true, reply: `🔎 استلمنا اعتراضك على المخالفة #${v.id}${p.media ? ' (مع المرفق)' : ''} — بانتظار قرار الإدارة.` + (covering ? `\nℹ️ عندك طلب #${covering.id} (${leaveLabel(covering)}) بانتظار الموافقة؛ لو اعتُمد تُلغى المخالفة تلقائياً.` : '') + `\n(للإدارة: ردّوا على إشعار المخالفة بـ«إلغاء» أو «تثبيت»)` });
          }
          return J({ ok: true });
        }
        // ③ الإدارة (المالكة / المحاسب): قرار على مخالفة أو طلب إذن بالرد
        const by = p.sender_name || 'الإدارة';
        const v = await findV();
        if (v) {
          if (/(الغ|إلغ|ألغ|امسح|شيل|سامح|تلغى)/.test(text)) {
            await sb.from('staff_violations').update({ status: 'cancelled', decided_by: by, decided_at: now.toISOString(), decision_note: text.slice(0, 300) }).eq('id', v.id);
            return J({ ok: true, reply: `❌ أُلغيت المخالفة #${v.id} على ${s.name} — بقرار ${by}.` });
          }
          if (/(ثب[تّ]|طب[قّ]|تُطب|تطب|مرفوض|ترفض|ما تلغى|لا تلغى)/.test(text)) {
            await sb.from('staff_violations').update({ status: 'applied', decided_by: by, decided_at: now.toISOString(), decision_note: text.slice(0, 300) }).eq('id', v.id);
            return J({ ok: true, reply: `✅ ثُبّتت المخالفة #${v.id} على ${s.name} (${v.amount} ${curAr(v.currency)}) — بقرار ${by}.` });
          }
          return J({ ok: true });
        }
        const l = await findL();
        if (l && l.status === 'pending') {
          if (/(موافق|اعتمد|معتمد|تم الموافق|اوك|أوك|ok\b|تمام)/i.test(text)) {
            if (!l.from_ts || !l.to_ts) return J({ ok: true, reply: `⚠️ الطلب #${l.id} بلا وقت واضح — حدّدي الوقت واعتمديه من النظام المحاسبي ← الحضور والمخالفات.` });
            const { data: ap } = await sb.from('staff_leaves').update({ status: 'approved', decided_by: by, decided_at: now.toISOString() }).eq('id', l.id).select().single();
            const n = await voidByLeave(ap, by);
            return J({ ok: true, reply: `✅ اعتُمد الطلب #${l.id} لـ${s.name}: ${leaveLabel(ap)}` + (n ? `\n🧹 أُلغيت ${n} مخالفة يغطيها هذا الإذن.` : '') });
          }
          if (/(مرفوض|رفض|ما ينفع|لا\b)/.test(text)) {
            await sb.from('staff_leaves').update({ status: 'rejected', decided_by: by, decided_at: now.toISOString(), note: text.slice(0, 300) }).eq('id', l.id);
            return J({ ok: true, reply: `🚫 رُفض الطلب #${l.id} لـ${s.name}.` });
          }
        }
        return J({ ok: true });
      }
      return J({ error: 'unknown action' }, 400);
    }

    // ════════════════ أوامر النظام المحاسبي ════════════════
    if (action === 'list' || !action) {
      const since = new Date(Date.now() - 200 * 86400e3).toISOString();
      const [staff, leaves, viol, c] = await Promise.all([
        staffAll(),
        sb.from('staff_leaves').select('*').gte('requested_at', since).order('requested_at', { ascending: false }).then((r: any) => r.data || []),
        sb.from('staff_violations').select('*').gte('occurred_at', since).order('occurred_at', { ascending: false }).then((r: any) => r.data || []),
        cfg(),
      ]);
      return J({ ok: true, staff, leaves, violations: viol, config: c, me: who });
    }
    if (action === 'save_staff') {
      const rec: any = { updated_at: new Date().toISOString() };
      for (const f of ['name', 'phone', 'active', 'shift1_start', 'shift1_end', 'shift2_start', 'shift2_end', 'work_days', 'violation_group', 'note']) if (f in p) rec[f] = p[f] === '' ? null : p[f];
      if ('phone' in rec) rec.phone = digits(rec.phone) || null;
      if (!p.id && !rec.name) return J({ error: 'الاسم مطلوب' }, 400);
      const q = p.id ? sb.from('staff_schedule').update(rec).eq('id', p.id) : sb.from('staff_schedule').insert(rec);
      const { data, error } = await q.select().single(); if (error) return J({ error: error.message }, 400);
      return J({ ok: true, row: data });
    }
    if (action === 'add_leave') {
      if (!p.staff_id || !p.from_ts || !p.to_ts) return J({ error: 'الموظفة والوقت من/إلى مطلوبة' }, 400);
      if (new Date(p.to_ts) <= new Date(p.from_ts)) return J({ error: 'وقت النهاية لازم بعد البداية' }, 400);
      const approved = p.status !== 'pending';
      const { data, error } = await sb.from('staff_leaves').insert({ staff_id: p.staff_id, kind: p.kind || 'إجازة', from_ts: p.from_ts, to_ts: p.to_ts, status: approved ? 'approved' : 'pending', note: p.note || null, source: 'dashboard', decided_by: approved ? who : null, decided_at: approved ? new Date().toISOString() : null }).select().single();
      if (error) return J({ error: error.message }, 400);
      const n = await voidByLeave(data, who);
      if (approved) await notify(data.staff_id, `🗓️ سُجّل لك ${leaveLabel(data)} ✅ معتمد — بقرار ${who}.`, { leave_id: data.id });
      return J({ ok: true, row: data, voided: n });
    }
    if (action === 'decide_leave') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const upd: any = { status: p.status === 'rejected' ? 'rejected' : 'approved', decided_by: who, decided_at: new Date().toISOString() };
      if (p.from_ts) upd.from_ts = p.from_ts; if (p.to_ts) upd.to_ts = p.to_ts; if ('note' in p) upd.note = p.note || null;
      const { data, error } = await sb.from('staff_leaves').update(upd).eq('id', p.id).select().single(); if (error) return J({ error: error.message }, 400);
      if (data.status === 'approved' && (!data.from_ts || !data.to_ts)) return J({ error: 'حدّدي الوقت من/إلى قبل الاعتماد' }, 400);
      const n = await voidByLeave(data, who);
      await notify(data.staff_id, data.status === 'approved' ? `✅ اعتُمد طلبك #${data.id}: ${leaveLabel(data)}` + (n ? `\n🧹 أُلغيت ${n} مخالفة يغطيها هذا الإذن.` : '') : `🚫 رُفض طلبك #${data.id} (${data.kind}).`, { leave_id: data.id });
      return J({ ok: true, row: data, voided: n });
    }
    if (action === 'delete_leave') {
      const { error } = await sb.from('staff_leaves').delete().eq('id', p.id); if (error) return J({ error: error.message }, 400); return J({ ok: true });
    }
    if (action === 'decide_violation') {
      if (!p.id || !['cancelled', 'applied'].includes(p.status)) return J({ error: 'id/status' }, 400);
      const { data, error } = await sb.from('staff_violations').update({ status: p.status, decided_by: who, decided_at: new Date().toISOString(), decision_note: p.note || null }).eq('id', p.id).select().single();
      if (error) return J({ error: error.message }, 400);
      await notify(data.staff_id, p.status === 'cancelled' ? `❌ أُلغيت المخالفة #${data.id} — بقرار ${who}.` + (p.note ? '\n📝 ' + p.note : '') : `✅ ثُبّتت المخالفة #${data.id} (${data.amount} ${curAr(data.currency)}) — بقرار ${who}.` + (p.note ? '\n📝 ' + p.note : ''), { violation_id: data.id });
      return J({ ok: true, row: data });
    }
    if (action === 'save_config') {
      const rows: any[] = [];
      if ('enabled' in p) rows.push({ key: 'sm_enabled', value: p.enabled ? 'true' : 'false' });
      if ('amount' in p) rows.push({ key: 'sm_fine_amount', value: String(Number(p.amount) || 10) });
      if ('currency' in p) rows.push({ key: 'sm_fine_currency', value: String(p.currency || 'SAR') });
      if ('edit_group' in p) rows.push({ key: 'sm_edit_group', value: String(p.edit_group || '').trim() });
      for (const r of rows) { const { error } = await sb.from('acc_config').upsert({ ...r, updated_at: new Date().toISOString() }, { onConflict: 'key' }); if (error) return J({ error: error.message }, 400); }
      return J({ ok: true, config: await cfg() });
    }
    return J({ error: 'unknown action' }, 400);
  } catch (e) {
    return J({ error: String((e as any)?.message || e) }, 500);
  }
});

