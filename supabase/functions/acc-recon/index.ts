import { createClient } from 'jsr:@supabase/supabase-js@2';
const ACCESS_KEY = 'alezz-2027-12ecc215b4f92deda19ed956937c3899';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-acc-key, x-acc-token, content-type, apikey', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const LIST_COLS = 'id,bank_name,period_from,period_to,txn_count,total_in,total_out,status,file_name,created_by,created_at';
const RDOC_META = 'id,movement_id,client_code,client_name,currency,refund_amount,company_profit,expected_refund,remaining_expected,payment_date,bank_name,bank_ref,status,created_by,created_at,approved_at,doc_name,doc_type';
const num = (v: any) => (v === '' || v == null) ? null : Number(v);
const E_NF = 'الطلب غير موجود', E_TY = 'نوع غير صحيح', E_DONE = 'الطلب معالَج مسبقاً';
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const key = req.headers.get('x-acc-key') || url.searchParams.get('key');
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  // 🔔 تنبيه واتساب للمالكة (CallMeBot) — يُستخدم عند رفع طلبات تحتاج موافقتها
  const wa = async (msg: string) => { try { const { data: cfg } = await supabase.from('acc_config').select('key,value').in('key', ['callmebot_phone', 'callmebot_apikey']); const m: any = {}; (cfg || []).forEach((r: any) => m[r.key] = r.value); const ph = m.callmebot_phone, k = m.callmebot_apikey; if (!ph || !k) return; await fetch('https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(ph) + '&apikey=' + encodeURIComponent(k) + '&text=' + encodeURIComponent(msg)); } catch (_) {} };
  let callerIsOwner = (key === ACCESS_KEY);   // المفتاح = مالكة
  let callerBankRef = (key === ACCESS_KEY);   // 🏦 صلاحية المرجع البنكي: المالكة أو المحاسب فقط
  if (key !== ACCESS_KEY) { const tok = req.headers.get('x-acc-token') || url.searchParams.get('token'); let okk = false; if (tok) { const { data: s } = await supabase.from('acc_sessions').select('staff_name,expires_at,is_owner').eq('token', tok).maybeSingle(); if (s && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now())) { okk = true; if (s.is_owner) { callerIsOwner = true; callerBankRef = true; } else { try { const { data: sa } = await supabase.from('acc_staff_access').select('role').eq('staff_name', s.staff_name).maybeSingle(); if (sa && /محاسب|accountant/i.test(String(sa.role || ''))) callerBankRef = true; } catch (_) {} } } } if (!okk) return J({ error: 'unauthorized' }, 401); }
  if (req.method === 'POST') {
    let body: any = {}; try { body = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
    const action = body.action; const p = body.payload || {};
    if (action === 'save_recon') {
      if (!p.bank_name) return J({ error: 'no bank' }, 400);
      const { data, error } = await supabase.from('acc_recon_reports').insert({ bank_name: p.bank_name, period_from: p.period_from || null, period_to: p.period_to || null, txn_count: p.txn_count ?? null, total_in: p.total_in ?? null, total_out: p.total_out ?? null, status: p.status || 'مطابق', file_name: p.file_name || null, pdf_base64: p.pdf_base64 || null, created_by: p.by || null }).select(LIST_COLS).single();
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, row: data });
    }
    if (action === 'get_recon_pdf') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const { data, error } = await supabase.from('acc_recon_reports').select('pdf_base64,file_name').eq('id', p.id).single();
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, pdf_base64: data.pdf_base64, file_name: data.file_name });
    }
    if (action === 'delete_recon') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const { error } = await supabase.from('acc_recon_reports').delete().eq('id', p.id);
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'set_payment_date') {
      const pc = String(p.payment_code || '').trim(); if (!pc) return J({ error: 'no payment_code' }, 400);
      const pd = (p.payment_date === '' || p.payment_date == null) ? null : p.payment_date;
      if (!callerIsOwner && pd) {   // 🔒 غير المالكة: تغيير تاريخ دفع موجود يُرسَل طلب موافقة؛ التعبئة لخانة فارغة مباشرة
        const { data: ov } = await supabase.from('acc_fcd_payment_dates').select('payment_date').eq('payment_code', pc).maybeSingle();
        let cur: any = ov ? ov.payment_date : null;
        if (cur == null) { const { data: fc } = await supabase.from('acc_first_client_data').select('payment_date').eq('payment_code', pc).limit(1).maybeSingle(); cur = fc ? fc.payment_date : null; }
        const had = cur != null && String(cur).trim() !== '';
        if (had && String(pd).slice(0, 10) !== String(cur).slice(0, 10)) {
          await supabase.from('acc_pending_movements').insert({ kind: 'client_edit', scope: 'fcd', status: 'pending', summary: '📅 طلب تغيير تاريخ الدفع — دفعة ' + pc, note: 'تغيير تاريخ دفع محفوظ (يحتاج موافقتك) · مقدّم الطلب: ' + (p.by || '—'), payload: { _paydate_only: true, payment_code: pc, payment_date: pd, by: p.by || null } });
          return J({ ok: true, pending: true, msg: 'أُرسل طلب تغيير تاريخ الدفع لموافقة المالكة — لن يتغيّر حتى الاعتماد' });
        }
      }
      const { error } = await supabase.from('acc_fcd_payment_dates').upsert({ payment_code: pc, payment_date: pd, updated_by: p.by || null, updated_at: new Date().toISOString() }, { onConflict: 'payment_code' });
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'set_sup_invoice') {
      // 🧾 «فاتورة المورّد» (actual_invoice): التسجيل لأول مرة مباشر؛ أي تعديل لقيمة مسجّلة سابقاً من غير المالكة → طلب موافقة (لا يُطبَّق حتى الاعتماد)
      const rawId = p.id; if (rawId == null || rawId === '') return J({ error: 'no id' }, 400);
      const av = (p.actual_invoice === '' || p.actual_invoice == null) ? null : Number(p.actual_invoice);
      // نوع السطر: رقم = فاتورة شيت (acc_supplier_invoices)؛ «sl-<n>» = حجز من Booking Form (acc_service_lines)
      const slm = String(rawId).match(/^sl-(\d+)$/);
      const realId = slm ? Number(slm[1]) : rawId;
      let cur: any = null;
      if (slm) { const { data } = await supabase.from('acc_service_lines').select('actual_invoice,supplier,booked_from,client_code').eq('id', realId).maybeSingle(); if (data) cur = { actual_invoice: data.actual_invoice, supplier_name: data.booked_from || data.supplier, client_code: data.client_code, client_name: null }; }
      else { const { data } = await supabase.from('acc_supplier_invoices').select('actual_invoice,supplier_name,client_code,client_name').eq('id', realId).maybeSingle(); cur = data; }
      const had = cur && cur.actual_invoice != null && String(cur.actual_invoice).trim() !== '';
      const changed = had && Number(cur.actual_invoice) !== Number(av);
      if (!callerIsOwner && changed) {
        const who = (cur.client_code || cur.client_name || '');
        await supabase.from('acc_pending_movements').insert({ kind: 'client_edit', scope: 'suppliers', status: 'pending', summary: '🧾 طلب تعديل «فاتورة المورّد» — ' + (cur.supplier_name || '') + (who ? ' · عميل ' + who : ''), note: 'تعديل قيمة فاتورة مورّد مسجّلة سابقاً (يحتاج موافقتك): من ' + String(cur.actual_invoice) + ' إلى ' + String(av) + ' · مقدّم الطلب: ' + (p.by || '—'), payload: { _sup_invoice_only: true, id: rawId, actual_invoice: av, old_value: cur.actual_invoice, supplier_name: cur.supplier_name || null, client_code: cur.client_code || null, reason: 'تعديل فاتورة مورّد مسجّلة', by: p.by || null } });
        return J({ ok: true, pending: true, msg: 'أُرسل طلب تعديل فاتورة المورّد لموافقة المالكة — لن يتغيّر حتى الاعتماد' });
      }
      const { error } = slm
        ? await supabase.from('acc_service_lines').update({ actual_invoice: av }).eq('id', realId)
        : await supabase.from('acc_supplier_invoices').update({ actual_invoice: av }).eq('id', realId);
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'edit_sup_transfer') {
      // ✏️ تعديل بيانات تحويل مورّد مسجّل (اسم البنك/المرجع البنكي/تاريخ الدفع) على كل صفوف التحويل + حركته البنكية. المالكة: مباشر؛ غيرها: طلب موافقة.
      const ids = Array.isArray(p.pay_ids) ? p.pay_ids.map((x: any) => Number(x)).filter((x: number) => !isNaN(x)) : [];
      if (!ids.length) return J({ error: 'no pay_ids' }, 400);
      const txnId = (p.txn_id != null && p.txn_id !== '') ? Number(p.txn_id) : null;
      const hasBank = ('bank_name' in p); const hasDate = ('payment_date' in p);
      let hasRef = ('bank_ref' in p);
      if (hasRef && !callerBankRef) hasRef = false;   // 🏦 المرجع البنكي: المحاسب/المالكة فقط
      // 💰 تعديل قيمة المبلغ — للتحويل المفرد فقط (سطر واحد)؛ الموزّع على عدة عملاء يُعاد توزيعه من زر «وزّع»
      const hasAmt = ('amount' in p) && p.amount != null && p.amount !== '' && !isNaN(Number(p.amount));
      if (hasAmt && ids.length !== 1 && !callerIsOwner) return J({ error: 'تعديل مبلغ التحويل الموزّع للمالكة فقط' }, 400);   // الموزّع: المالكة تعدّله (يُوزَّع نسبيّاً على السجلات)
      // 💱 العملة المدفوعة + 🔁 سعر الصرف — تُطبَّق على كل صفوف التحويل (سجل acc_supplier_payments فقط، لا تمسّ عملة الحركة البنكية)
      const hasCur = ('currency' in p);
      const hasRate = ('currency_rate' in p) && !(p.currency_rate !== '' && p.currency_rate != null && isNaN(Number(p.currency_rate)));
      if (!hasBank && !hasRef && !hasDate && !hasAmt && !hasCur && !hasRate) return J({ error: 'لا يوجد تغيير' }, 400);
      // إشارة الحركة (تحويل خارج / مرتجع وارد) من الصف الحالي لحفظها عند تغيير المبلغ
      let curAmt: number | null = null;
      if (hasAmt) { const { data: cr } = await supabase.from('acc_supplier_payments').select('amount').eq('id', ids[0]).maybeSingle(); if (cr) curAmt = Number(cr.amount || 0); }
      const signedAmt = hasAmt ? ((curAmt != null && curAmt < 0) ? -Math.abs(Number(p.amount)) : Math.abs(Number(p.amount))) : null;
      if (!callerIsOwner) {
        const payload: any = { _sup_transfer_only: true, pay_ids: ids, txn_id: txnId, sup: p.sup || null, reason: 'تعديل بيانات تحويل (بنك/مرجع/تاريخ/مبلغ)', by: p.by || null };
        if (hasBank) payload.bank_name = p.bank_name || null;
        if (hasRef) payload.bank_ref = p.bank_ref || null;
        if (hasDate) payload.payment_date = p.payment_date || null;
        if (hasAmt) { payload.amount = signedAmt; payload.old_amount = curAmt; }
        if (hasCur) payload.currency = (p.currency === '' || p.currency == null) ? null : String(p.currency);
        if (hasRate) payload.currency_rate = (p.currency_rate === '' || p.currency_rate == null) ? null : Number(p.currency_rate);
        await supabase.from('acc_pending_movements').insert({ kind: 'client_edit', scope: 'suppliers', status: 'pending', summary: '✏️ طلب تعديل تحويل مورّد «' + (p.sup || '') + '»' + (hasAmt ? (' — المبلغ إلى ' + Math.abs(Number(p.amount))) : (' — ' + ids.length + ' عميل')), note: 'تعديل (بنك/مرجع/تاريخ/مبلغ/عملة/سعر صرف) لتحويل مسجّل (يحتاج موافقتك)' + (hasAmt ? (' · المبلغ من ' + (curAmt != null ? Math.abs(curAmt) : '?') + ' إلى ' + Math.abs(Number(p.amount))) : '') + (hasCur ? (' · العملة → ' + (p.currency || '—')) : '') + (hasRate ? (' · سعر الصرف → ' + (p.currency_rate || '—')) : '') + ' · مقدّم الطلب: ' + (p.by || '—'), payload });
        return J({ ok: true, pending: true, msg: 'أُرسل طلب تعديل التحويل لموافقة المالكة — لن يتغيّر حتى الاعتماد' });
      }
      // الحقول غير المبلغ (بنك/مرجع/تاريخ/عملة/سعر) تُطبَّق على كل صفوف التحويل
      const upd: any = {};
      if (hasBank) upd.bank_name = p.bank_name || null;
      if (hasRef) upd.bank_ref = p.bank_ref || null;
      if (hasDate) upd.payment_date = p.payment_date || null;
      if (hasCur) upd.currency = (p.currency === '' || p.currency == null) ? null : String(p.currency);
      if (hasRate) upd.currency_rate = (p.currency_rate === '' || p.currency_rate == null) ? null : Number(p.currency_rate);
      if (Object.keys(upd).length) { const { error } = await supabase.from('acc_supplier_payments').update(upd).in('id', ids); if (error) return J({ error: error.message }, 400); }
      // 💰 المبلغ: مفرد → يُضبط مباشرة؛ موزّع على عدة سجلات → يُوزَّع الإجمالي الجديد نسبيّاً على السجلات (يحافظ على النِّسَب)
      const newTotal = hasAmt ? Math.abs(Number(p.amount)) : null;
      if (hasAmt) {
        if (ids.length === 1) {
          const { error } = await supabase.from('acc_supplier_payments').update({ amount: signedAmt }).eq('id', ids[0]); if (error) return J({ error: error.message }, 400);
        } else {
          const { data: subs } = await supabase.from('acc_supplier_payments').select('id,amount').in('id', ids);
          const oldTotal = (subs || []).reduce((s: number, x: any) => s + Math.abs(Number(x.amount || 0)), 0);
          if (oldTotal > 0.005) {
            for (const sx of (subs || [])) { const a = Number(sx.amount || 0); const sign = a < 0 ? -1 : 1; const scaled = sign * (Math.round(Math.abs(a) * (newTotal as number) / oldTotal * 1000) / 1000); const { error } = await supabase.from('acc_supplier_payments').update({ amount: scaled }).eq('id', sx.id); if (error) return J({ error: error.message }, 400); }
          }
        }
      }
      if (txnId) { const t: any = {}; if (hasBank) t.bank_name = p.bank_name || null; if (hasRef) t.bank_ref = p.bank_ref || null; if (hasDate) t.tx_date = p.payment_date || null; if (hasAmt) { const isRef = (signedAmt != null && signedAmt < 0); t.amount_out = isRef ? 0 : (newTotal as number); t.amount_in = isRef ? (newTotal as number) : 0; } if (Object.keys(t).length) await supabase.from('acc_bank_txn').update(t).eq('id', txnId); }
      return J({ ok: true });
    }
    if (action === 'set_fcd_bankref') {
      // تعبئة اسم البنك/المرجع مباشرة (لخانة فارغة) — بلا موافقة. تغيير قيمة موجودة يمر عبر طلب تعديل بموافقة المالكة.
      const pc = String(p.payment_code || '').trim(); if (!pc) return J({ error: 'no payment_code' }, 400);
      const bn = (p.bank_name === '' || p.bank_name == null) ? null : String(p.bank_name).trim();
      let br = (p.bank_ref === '' || p.bank_ref == null) ? null : String(p.bank_ref).trim();
      // 🏦 المرجع البنكي: المحاسب أو المالكة فقط — غير المخوّل لا يُدخله إطلاقاً (يُجرَّد، ويبقى إدخال اسم البنك متاحاً)
      if (!callerBankRef && br) br = null;
      // تغيير قيمة موجودة: المالكة فقط مباشرة. المحاسب يضيف لخانة فارغة مباشرة لكن تغيير الموجود يحتاج موافقة المالكة (عبر ✏️ تعديل). غير المخوّل جُرِّد مرجعه أصلاً.
      if (!callerIsOwner) {
        const { data: cur } = await supabase.from('acc_first_client_data').select('bank_name,bank_ref').eq('payment_code', pc).limit(1).maybeSingle();
        const hadBank = cur && String(cur.bank_name || '').trim() !== '';
        const hadRef = cur && String(cur.bank_ref || '').trim() !== '';
        if ((hadBank && bn && bn !== String(cur.bank_name || '').trim()) || (hadRef && br && br !== String(cur.bank_ref || '').trim())) {
          if (callerBankRef) {   // 🏦 المحاسب: يُرسَل طلب موافقة، ولا يُطبَّق التغيير حتى اعتماد المالكة (إشعار في acc_pending_movements)
            await supabase.from('acc_pending_movements').insert({ kind: 'client_edit', scope: 'fcd', status: 'pending', summary: '🏦 طلب تغيير البنك/المرجع البنكي — دفعة ' + pc, note: 'المحاسب طلب تغيير البنك/المرجع البنكي (يحتاج موافقتك) · مقدّم الطلب: ' + (p.by || '—'), payload: { _bankref_only: true, payment_code: pc, bank_name: bn, bank_ref: br, by: p.by || null } });
            return J({ ok: true, pending: true, msg: 'أُرسل طلب تغيير المرجع البنكي لموافقة المالكة — لن يتغيّر حتى الاعتماد' });
          }
          return J({ error: 'تغيير بنك/مرجع موجود يتطلب موافقة المالكة' }, 403);
        }
      }
      const { error } = await supabase.from('acc_fcd_bank_overrides').upsert({ payment_code: pc, bank_name: bn, bank_ref: br, updated_by: p.by || null, updated_at: new Date().toISOString() }, { onConflict: 'payment_code' });
      if (error) return J({ error: error.message }, 400);
      await supabase.from('acc_first_client_data').update({ bank_name: bn, bank_ref: br }).eq('payment_code', pc);
      return J({ ok: true });
    }
    if (action === 'set_charge_date') {
      const sid = p.service_id; if (!sid) return J({ error: 'no service_id' }, 400);
      const cd = (p.charge_date === '' || p.charge_date == null) ? null : p.charge_date;
      const { error } = await supabase.from('acc_svc_charge_dates').upsert({ service_id: sid, charge_date: cd, updated_by: p.by || null, updated_at: new Date().toISOString() }, { onConflict: 'service_id' });
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'request_suppay_edit' || action === 'request_cash_edit') {
      const isCash = action === 'request_cash_edit';
      const tp = isCash ? 'cash_edit_request' : 'suppay_edit_request';
      const pid = p.payment_id; if (!pid) return J({ error: 'no payment_id' }, 400);
      const nv = Number(p.new_amount); if (isNaN(nv)) return J({ error: 'قيمة غير صحيحة' }, 400);
      const reason = String(p.reason || '').trim(); if (!reason) return J({ error: 'سبب التعديل إجباري' }, 400);
      const { data: ex } = await supabase.from('acc_alerts').select('id').eq('type', tp).eq('service_id', pid).eq('status', 'pending').limit(1);
      if (ex && ex.length) return J({ ok: true, requested: true, dup: true });
      const label = isCash ? 'حركة كاش' : 'دفعة مورّد';
      const { error } = await supabase.from('acc_alerts').insert({ type: tp, client_code: p.client_code || null, service_id: pid, service_name: p.service_name || null, req_value: nv, req_old: Number(p.old_amount || 0), message: 'طلب تعديل قيمة ' + label + ' «' + (p.service_name || '') + '» من ' + (p.old_amount || 0) + ' إلى ' + nv + ' · السبب: ' + reason + ' · مقدّم الطلب: ' + (p.by || '—'), status: 'pending' });
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, requested: true });
    }
    if (action === 'resolve_suppay_edit') {
      if (!callerIsOwner) return J({ error: 'الاعتماد/الرفض للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: al, error: e0 } = await supabase.from('acc_alerts').select('*').eq('id', p.id).single();
      if (e0 || !al) return J({ error: E_NF }, 400);
      if (al.type !== 'suppay_edit_request') return J({ error: E_TY }, 400);
      if (al.status !== 'pending') return J({ error: E_DONE }, 400);
      if (decision === 'approve') {
        const { error: ue } = await supabase.from('acc_supplier_payments').update({ amount: al.req_value }).eq('id', al.service_id);
        if (ue) return J({ error: ue.message }, 400);
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '✅ عُدّلت القيمة إلى ' + al.req_value, resolved_at: new Date().toISOString() }).eq('id', p.id);
      } else { await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '❌ رُفض الطلب', resolved_at: new Date().toISOString() }).eq('id', p.id); }
      return J({ ok: true, decision });
    }
    if (action === 'resolve_cash_edit') {
      if (!callerIsOwner) return J({ error: 'الاعتماد/الرفض للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: al, error: e0 } = await supabase.from('acc_alerts').select('*').eq('id', p.id).single();
      if (e0 || !al) return J({ error: E_NF }, 400);
      if (al.type !== 'cash_edit_request') return J({ error: E_TY }, 400);
      if (al.status !== 'pending') return J({ error: E_DONE }, 400);
      if (decision === 'approve') {
        const { data: row, error: re } = await supabase.from('acc_banks_cash').select('*').eq('id', al.service_id).single();
        if (re || !row) return J({ error: E_NF }, 400);
        const rate = row.currency_rate != null ? Number(row.currency_rate) : null;
        const upd: any = {};
        if (Number(row.in_raw || 0) > 0) { upd.in_raw = al.req_value; upd.in_sar = rate != null ? Number(al.req_value) * rate : al.req_value; }
        else { upd.out_raw = al.req_value; upd.out_sar = rate != null ? Number(al.req_value) * rate : al.req_value; }
        const { error: ue } = await supabase.from('acc_banks_cash').update(upd).eq('id', al.service_id);
        if (ue) return J({ error: ue.message }, 400);
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '✅ عُدّلت القيمة إلى ' + al.req_value, resolved_at: new Date().toISOString() }).eq('id', p.id);
      } else { await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '❌ رُفض الطلب', resolved_at: new Date().toISOString() }).eq('id', p.id); }
      return J({ ok: true, decision });
    }
    if (action === 'set_cash_ref') {
      // إدخال/تعديل الرقم المرجعي لحوالة داخلية (إكمال بيانات — بلا موافقة)
      if (!callerBankRef) return J({ error: 'المرجع البنكي يُدخله المحاسب أو المالكة فقط' }, 403);   // 🏦 ممنوع على موظفي المبيعات
      if (!p.id) return J({ error: 'no id' }, 400);
      const { error } = await supabase.from('acc_banks_cash').update({ bank_ref: String(p.bank_ref || '').trim() || null }).eq('id', p.id);
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'request_cash_add') {
      if (!p.bank_name) return J({ error: 'لازم تحديد البنك' }, 400);
      const { data, error } = await supabase.from('acc_pending_movements').insert({ kind: 'cash', scope: 'banks_cash', status: 'pending', summary: p.summary || null, note: p.note || null, payload: p }).select().single();
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, row: data });
    }
    if (action === 'resolve_cash_add') {
      if (!callerIsOwner) return J({ error: 'الاعتماد/الرفض للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: mv, error: e0 } = await supabase.from('acc_pending_movements').select('*').eq('id', p.id).single();
      if (e0 || !mv) return J({ error: E_NF }, 400);
      if (mv.kind !== 'cash' || mv.scope !== 'banks_cash') return J({ error: E_TY }, 400);
      if (mv.status !== 'pending') return J({ error: E_DONE }, 400);
      let result: any = {};
      if (decision === 'approve') {
        const c = mv.payload || {};
        const inRaw = num(c.in_raw), outRaw = num(c.out_raw), rate = num(c.currency_rate);
        let inSar = num(c.in_sar), outSar = num(c.out_sar);
        if (inSar == null && inRaw != null && rate != null) inSar = inRaw * rate;
        if (outSar == null && outRaw != null && rate != null) outSar = outRaw * rate;
        const { data: row, error: ie } = await supabase.from('acc_banks_cash').insert({ tx_date: c.tx_date || null, in_raw: inRaw, out_raw: outRaw, bank_name: c.bank_name, bank_ref: c.bank_ref || null, channel: c.channel || null, description: c.description || null, details: c.details || null, more_details: c.more_details || null, note: c.note || null, currency: c.currency || null, currency_rate: rate, in_sar: inSar, out_sar: outSar, source: 'dashboard' }).select().single();
        if (ie) return J({ error: ie.message }, 400);
        result = { bank_cash: row?.id };
      }
      const { error: e1 } = await supabase.from('acc_pending_movements').update({ status: decision === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString(), result }).eq('id', p.id);
      if (e1) return J({ error: e1.message }, 400);
      return J({ ok: true, decision, result });
    }
    if (action === 'request_refund_add') {
      if (!p.client_code) return J({ error: 'no client_code' }, 400);
      if (!p.bank_name) return J({ error: 'لازم تحديد البنك' }, 400);
      if (!p.doc_base64) return J({ error: 'لازم إرفاق صورة/طلب العميل بالإرجاع قبل الإرسال' }, 400);
      if (!callerBankRef && p.bank_ref) { p.bank_ref = null; }   // 🏦 المرجع البنكي: المحاسب/المالكة فقط — يُجرَّد من طلب المبيعات
      const { data: doc, error: de } = await supabase.from('acc_refund_docs').insert({ client_code: p.client_code, client_name: p.client_name || null, currency: p.currency || null, refund_amount: p.refund ?? 0, company_profit: p.company_profit ?? 0, expected_refund: p.expected_refund ?? null, remaining_expected: p.remaining_expected ?? null, payment_date: p.payment_date || null, bank_name: p.bank_name || null, bank_ref: p.bank_ref || null, payments_summary: p.payments_summary || null, cancel_summary: p.cancel_summary || null, doc_base64: p.doc_base64, doc_name: p.doc_name || null, doc_type: p.doc_type || null, status: 'pending', created_by: p.by || null }).select('id').single();
      if (de) return J({ error: de.message }, 400);
      const mvPayload: any = { ...p }; delete mvPayload.doc_base64; mvPayload.doc_id = doc.id;
      const { data, error } = await supabase.from('acc_pending_movements').insert({ kind: 'refund', scope: 'client_refund', status: 'pending', summary: p.summary || null, note: p.note || null, payload: mvPayload }).select().single();
      if (error) return J({ error: error.message }, 400);
      await supabase.from('acc_refund_docs').update({ movement_id: data.id }).eq('id', doc.id);
      return J({ ok: true, row: data, doc_id: doc.id });
    }
    if (action === 'get_refund_doc') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const { data, error } = await supabase.from('acc_refund_docs').select('*').eq('id', p.id).single();
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, doc: data });
    }
    if (action === 'delete_refund_doc') {
      // 🗑️ حذف مستند مرتجع — المالكة فقط، والمرفوض فقط (المعتمد/المعلّق محفوظ)
      if (!callerIsOwner) return J({ error: 'حذف المستندات للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const { data: doc, error: ge } = await supabase.from('acc_refund_docs').select('id,status').eq('id', p.id).maybeSingle();
      if (ge) return J({ error: ge.message }, 400);
      if (!doc) return J({ error: 'المستند غير موجود' }, 400);
      if (String(doc.status || '') !== 'rejected') return J({ error: 'يُسمح بحذف المستندات المرفوضة فقط — المعتمدة محفوظة' }, 400);
      const { error } = await supabase.from('acc_refund_docs').delete().eq('id', p.id).eq('status', 'rejected');
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'resolve_refund_add') {
      if (!callerIsOwner) return J({ error: 'الاعتماد/الرفض للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: mv, error: e0 } = await supabase.from('acc_pending_movements').select('*').eq('id', p.id).single();
      if (e0 || !mv) return J({ error: E_NF }, 400);
      if (mv.kind !== 'refund') return J({ error: E_TY }, 400);
      if (mv.status !== 'pending') return J({ error: E_DONE }, 400);
      const c = mv.payload || {};
      let result: any = {};
      if (decision === 'approve') {
        const { data: row, error: ie } = await supabase.from('acc_refunds').insert({ client_code: c.client_code, client_name: c.client_name || null, refund: c.refund ?? 0, payment_date: c.payment_date || null, bank_name: c.bank_name || null, bank_ref: c.bank_ref || null, note: c.note || null, source: 'dashboard' }).select().single();
        if (ie) return J({ error: ie.message }, 400);
        result = { refund: row?.id };
        if (c.doc_id) await supabase.from('acc_refund_docs').update({ status: 'approved', approved_by: p.by || null, approved_at: new Date().toISOString() }).eq('id', c.doc_id);
      } else {
        if (c.doc_id) await supabase.from('acc_refund_docs').update({ status: 'rejected', approved_by: p.by || null, approved_at: new Date().toISOString() }).eq('id', c.doc_id);
      }
      const { error: e1 } = await supabase.from('acc_pending_movements').update({ status: decision === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString(), result }).eq('id', p.id);
      if (e1) return J({ error: e1.message }, 400);
      return J({ ok: true, decision, result });
    }
    if (action === 'request_client_entry') {
      const { data, error } = await supabase.from('acc_pending_movements').insert({ kind: 'client_entry', scope: 'fcd', status: 'pending', summary: p.summary || null, note: p.entry_note || null, payload: p }).select().single();
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, row: data });
    }
    if (action === 'resolve_client_entry') {
      if (!callerIsOwner) return J({ error: 'الاعتماد/الرفض للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: mv, error: e0 } = await supabase.from('acc_pending_movements').select('*').eq('id', p.id).single();
      if (e0 || !mv) return J({ error: E_NF }, 400);
      if (mv.kind !== 'client_entry') return J({ error: E_TY }, 400);
      if (mv.status !== 'pending') return J({ error: E_DONE }, 400);
      let result: any = {};
      if (decision === 'approve') {
        const c = mv.payload || {};
        const { data, error } = await supabase.rpc('acc_add_client_entry', { p_is_new_client: !!c.is_new_client, p_client_code: c.client_code || null, p_booking_date: c.booking_date || new Date().toISOString().slice(0, 10), p_arrival_date: c.arrival_date || null, p_client_name: c.client_name || null, p_phone: c.phone || null, p_agent_name: c.agent_name || null, p_travel_from: c.travel_from || null, p_travel_to: c.travel_to || null, p_cost: c.cost ?? 0, p_profit: c.profit ?? 0, p_amount_paid: c.amount_paid ?? 0, p_currency: c.currency || 'SAR', p_package_type: c.package_type || null, p_confirmed_by: c.confirmed_by || null, p_bank_name: c.bank_name || null, p_bank_ref: c.bank_ref || null, p_note: c.note || null, p_client_email: c.client_email || null });
        if (error) return J({ error: error.message }, 400);
        if (data?.id) { const upd: any = { source: 'dashboard' }; if (c.payment_date) upd.payment_date = c.payment_date; if (c.pax != null && c.pax !== '') upd.pax = Number(c.pax); await supabase.from('acc_first_client_data').update(upd).eq('id', data.id); }
        const dueCode = c.is_new_client ? (data?.client_code || '') : (c.client_code || '');
        if (c.due_date && dueCode) { await supabase.from('acc_client_due').upsert({ client_code: dueCode, due_date: c.due_date, updated_at: new Date().toISOString() }, { onConflict: 'client_code' }); }
        if (c.delivered_to_supplier && data?.id) {
          const ccode = c.is_new_client ? (data?.client_code || '') : (c.client_code || '');
          const srate = (c.supplier_rate != null && Number(c.supplier_rate) > 0) ? Number(c.supplier_rate) : 1;
          const samt = Number(c.amount_paid ?? 0) * srate;
          const scur = c.supplier_currency || c.currency || 'SAR';
          await supabase.from('acc_supplier_payments').insert({ supplier_name: c.delivered_to_supplier, client_code: ccode || null, client_name: c.client_name || null, amount: samt, currency: scur, payment_date: c.payment_date || null, bank_name: '💵 نقداً (تسليم مباشر)', bank_ref: 'تسليم مباشر · من First Client Data', note: '💵 نقداً (Cash) · تسليم مباشر للمورّد — من First Client Data · دُفعت لصالح العميل ' + (ccode || '') + (srate !== 1 ? ' (سعر صرف ' + srate + ')' : ''), source: 'dashboard' });
        }
        result = { payment_code: data?.payment_code, client_code: data?.client_code, delivered_to_supplier: c.delivered_to_supplier || null };
      }
      const { error: e1 } = await supabase.from('acc_pending_movements').update({ status: decision === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString(), result }).eq('id', p.id);
      if (e1) return J({ error: e1.message }, 400);
      return J({ ok: true, decision, result });
    }
    if (action === 'request_client_edit') {
      if (!p.entry_id) return J({ error: 'no entry_id' }, 400);
      const reason = String(p.reason || '').trim(); if (!reason) return J({ error: 'سبب التعديل إجباري' }, 400);
      const { data, error } = await supabase.from('acc_pending_movements').insert({ kind: 'client_edit', scope: 'fcd', status: 'pending', summary: p.summary || null, note: reason, payload: p }).select().single();
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, row: data });
    }
    if (action === 'resolve_client_edit') {
      if (!callerIsOwner) return J({ error: 'الاعتماد/الرفض للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: mv, error: e0 } = await supabase.from('acc_pending_movements').select('*').eq('id', p.id).single();
      if (e0 || !mv) return J({ error: E_NF }, 400);
      if (mv.kind !== 'client_edit') return J({ error: E_TY }, 400);
      if (mv.status !== 'pending') return J({ error: E_DONE }, 400);
      let result: any = {};
      if (decision === 'approve') {
        const c = mv.payload || {};
        if (c._bankref_only) {   // 🏦 اعتماد طلب تغيير المرجع/البنك البنكي فقط → يُطبَّق على جدول التجاوز
          const { error: be } = await supabase.from('acc_fcd_bank_overrides').upsert({ payment_code: c.payment_code, bank_name: c.bank_name || null, bank_ref: c.bank_ref || null, updated_by: p.by || null, updated_at: new Date().toISOString() }, { onConflict: 'payment_code' });
          if (be) return J({ error: be.message }, 400);
          const { error: e1b } = await supabase.from('acc_pending_movements').update({ status: 'approved', decided_at: new Date().toISOString(), result: { bankref: c.payment_code } }).eq('id', p.id);
          if (e1b) return J({ error: e1b.message }, 400);
          return J({ ok: true, decision, result: { bankref: c.payment_code } });
        }
        if (c._paydate_only) {   // 📅 اعتماد تغيير تاريخ الدفع
          const { error: pe } = await supabase.from('acc_fcd_payment_dates').upsert({ payment_code: c.payment_code, payment_date: c.payment_date || null, updated_by: p.by || null, updated_at: new Date().toISOString() }, { onConflict: 'payment_code' });
          if (pe) return J({ error: pe.message }, 400);
          await supabase.from('acc_pending_movements').update({ status: 'approved', decided_at: new Date().toISOString(), result: { paydate: c.payment_code } }).eq('id', p.id);
          return J({ ok: true, decision, result: { paydate: c.payment_code } });
        }
        if (c._due_only) {   // 📅 اعتماد تغيير تاريخ الاستحقاق
          const { error: de } = await supabase.from('acc_client_due').upsert({ client_code: c.client_code, due_date: c.due_date || null, alarm_date: c.alarm_date || null, note: c.note || null, updated_at: new Date().toISOString() }, { onConflict: 'client_code' });
          if (de) return J({ error: de.message }, 400);
          await supabase.from('acc_pending_movements').update({ status: 'approved', decided_at: new Date().toISOString(), result: { due: c.client_code } }).eq('id', p.id);
          return J({ ok: true, decision, result: { due: c.client_code } });
        }
        if (c._profit_only) {   // 💰 اعتماد تعديل الربح
          const { data: prow } = await supabase.from('acc_first_client_data').select('id,payment_code,client_code,profit').eq('id', c.id).single();
          if (prow && prow.payment_code) {
            await supabase.from('acc_profit_overrides').upsert({ payment_code: prow.payment_code, client_code: prow.client_code, new_profit: c.new_profit, old_profit: Number(prow.profit || 0), reason: c.reason || null, changed_by: p.by || null, created_at: new Date().toISOString() }, { onConflict: 'payment_code' });
            await supabase.from('acc_first_client_data').update({ profit: c.new_profit }).eq('id', c.id);
          }
          await supabase.from('acc_pending_movements').update({ status: 'approved', decided_at: new Date().toISOString(), result: { profit: c.id } }).eq('id', p.id);
          return J({ ok: true, decision, result: { profit: c.id } });
        }
        if (c._sup_transfer_only) {   // ✏️ اعتماد تعديل بيانات تحويل مورّد (بنك/مرجع/تاريخ) على كل صفوفه + حركته البنكية
          const ids = Array.isArray(c.pay_ids) ? c.pay_ids : [];
          const hasAmtC = ('amount' in c) && c.amount != null;
          const upd: any = {}; if ('bank_name' in c) upd.bank_name = c.bank_name || null; if ('bank_ref' in c) upd.bank_ref = c.bank_ref || null; if ('payment_date' in c) upd.payment_date = c.payment_date || null; if (hasAmtC) upd.amount = Number(c.amount); if ('currency' in c) upd.currency = c.currency || null; if ('currency_rate' in c) upd.currency_rate = (c.currency_rate == null || c.currency_rate === '') ? null : Number(c.currency_rate);
          if (ids.length && Object.keys(upd).length) { const { error: se } = await supabase.from('acc_supplier_payments').update(upd).in('id', ids); if (se) return J({ error: se.message }, 400); }
          if (c.txn_id) { const t: any = {}; if ('bank_name' in c) t.bank_name = c.bank_name || null; if ('bank_ref' in c) t.bank_ref = c.bank_ref || null; if ('payment_date' in c) t.tx_date = c.payment_date || null; if (hasAmtC) { const isRef = Number(c.amount) < 0; t.amount_out = isRef ? 0 : Math.abs(Number(c.amount)); t.amount_in = isRef ? Math.abs(Number(c.amount)) : 0; } if (Object.keys(t).length) await supabase.from('acc_bank_txn').update(t).eq('id', c.txn_id); }
          await supabase.from('acc_pending_movements').update({ status: 'approved', decided_at: new Date().toISOString(), result: { sup_transfer: ids.length } }).eq('id', p.id);
          return J({ ok: true, decision, result: { sup_transfer: ids.length } });
        }
        if (c._sup_invoice_only) {   // 🧾 اعتماد تعديل «فاتورة المورّد» → فاتورة شيت أو سطر حجز (sl-<n>)
          const _av = (c.actual_invoice == null ? null : Number(c.actual_invoice));
          const _slm = String(c.id).match(/^sl-(\d+)$/);
          const { error: se } = _slm
            ? await supabase.from('acc_service_lines').update({ actual_invoice: _av }).eq('id', Number(_slm[1]))
            : await supabase.from('acc_supplier_invoices').update({ actual_invoice: _av }).eq('id', c.id);
          if (se) return J({ error: se.message }, 400);
          await supabase.from('acc_pending_movements').update({ status: 'approved', decided_at: new Date().toISOString(), result: { sup_invoice: c.id } }).eq('id', p.id);
          return J({ ok: true, decision, result: { sup_invoice: c.id } });
        }
        const { data: row, error: re } = await supabase.from('acc_first_client_data').select('*').eq('id', c.entry_id).single();
        if (re || !row) return J({ error: 'السطر غير موجود' }, 400);
        if (row.source !== 'dashboard') return J({ error: 'يُسمح بتعديل المُدخَل من الداشبورد فقط' }, 400);
        const cost = c.cost != null ? Number(c.cost) : Number(row.cost || 0);
        const profit = c.profit != null ? Number(c.profit) : Number(row.profit || 0);
        const paid = c.amount_paid != null ? Number(c.amount_paid) : Number(row.amount_paid || 0);
        const rate = cost + profit;
        const upd: any = { cost, profit, package_rate: rate, amount_paid: paid, balance: rate - paid };
        if ('bank_name' in c) upd.bank_name = c.bank_name || null;
        if ('bank_ref' in c) upd.bank_ref = c.bank_ref || null;
        if ('payment_date' in c) upd.payment_date = c.payment_date || null;
        if ('note' in c) upd.note = c.note || null;
        if ('confirmed_by' in c) upd.confirmed_by = c.confirmed_by || null;
        if ('agent_name' in c) upd.agent_name = c.agent_name || null;
        if ('pax' in c) upd.pax = (c.pax === '' || c.pax == null) ? null : Number(c.pax);
        if ('currency' in c) upd.currency = c.currency || null;
        if ('arrival_date' in c) upd.arrival_date = c.arrival_date || null;
        if ('booking_date' in c) upd.booking_date = c.booking_date || null;
        const { error: ue } = await supabase.from('acc_first_client_data').update(upd).eq('id', c.entry_id).eq('source', 'dashboard');
        if (ue) return J({ error: ue.message }, 400);
        result = { updated: c.entry_id };
      }
      const { error: e1 } = await supabase.from('acc_pending_movements').update({ status: decision === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString(), result }).eq('id', p.id);
      if (e1) return J({ error: e1.message }, 400);
      return J({ ok: true, decision, result });
    }
    // ===== طلب تعديل مرتجع (محاسب) — يحتاج موافقة المالكة =====
    if (action === 'request_refund_edit') {
      if (!p.refund_id) return J({ error: 'no refund_id' }, 400);
      const reason = String(p.reason || '').trim(); if (!reason) return J({ error: 'سبب التعديل إجباري' }, 400);
      if (!callerBankRef && p.bank_ref) { p.bank_ref = null; }   // 🏦 المرجع البنكي: المحاسب/المالكة فقط
      const { data, error } = await supabase.from('acc_pending_movements').insert({ kind: 'refund_edit', scope: 'client_refund', status: 'pending', summary: p.summary || null, note: reason, payload: p }).select().single();
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, row: data });
    }
    if (action === 'resolve_refund_edit') {
      if (!callerIsOwner) return J({ error: 'الاعتماد/الرفض للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: mv, error: e0 } = await supabase.from('acc_pending_movements').select('*').eq('id', p.id).single();
      if (e0 || !mv) return J({ error: E_NF }, 400);
      if (mv.kind !== 'refund_edit') return J({ error: E_TY }, 400);
      if (mv.status !== 'pending') return J({ error: E_DONE }, 400);
      let result: any = {};
      if (decision === 'approve') {
        const c = mv.payload || {};
        const upd: any = {};
        if ('refund' in c) upd.refund = Number(c.refund);
        if ('bank_ref' in c) upd.bank_ref = (c.bank_ref === '' ? null : c.bank_ref);
        if ('payment_date' in c) upd.payment_date = (c.payment_date === '' ? null : c.payment_date);
        const { error: ue } = await supabase.from('acc_refunds').update(upd).eq('id', c.refund_id).eq('source', 'dashboard');
        if (ue) return J({ error: ue.message }, 400);
        result = { updated: c.refund_id };
      }
      const { error: e1 } = await supabase.from('acc_pending_movements').update({ status: decision === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString(), result }).eq('id', p.id);
      if (e1) return J({ error: e1.message }, 400);
      return J({ ok: true, decision, result });
    }
    // ===== تعديل مباشر لبيانات العميل (المالكة فقط — بلا موافقة) =====
    if (action === 'update_client_entry') {
      if (!callerIsOwner) return J({ error: 'التعديل المباشر للمالكة فقط' }, 403);
      if (!p.entry_id) return J({ error: 'no entry_id' }, 400);
      const { data: row, error: re } = await supabase.from('acc_first_client_data').select('*').eq('id', p.entry_id).single();
      if (re || !row) return J({ error: 'السطر غير موجود' }, 400);
      if (row.source !== 'dashboard') return J({ error: 'يُسمح بتعديل المُدخَل من الداشبورد فقط' }, 400);
      const cost = p.cost != null ? Number(p.cost) : Number(row.cost || 0);
      const profit = p.profit != null ? Number(p.profit) : Number(row.profit || 0);
      const paid = p.amount_paid != null ? Number(p.amount_paid) : Number(row.amount_paid || 0);
      const rate = cost + profit;
      const upd: any = { cost, profit, package_rate: rate, amount_paid: paid, balance: rate - paid };
      if ('bank_name' in p) upd.bank_name = p.bank_name || null;
      if ('bank_ref' in p) upd.bank_ref = p.bank_ref || null;
      if ('payment_date' in p) upd.payment_date = p.payment_date || null;
      if ('note' in p) upd.note = p.note || null;
      if ('confirmed_by' in p) upd.confirmed_by = p.confirmed_by || null;
      if ('agent_name' in p) upd.agent_name = p.agent_name || null;
      if ('pax' in p) upd.pax = (p.pax === '' || p.pax == null) ? null : Number(p.pax);
      if ('currency' in p) upd.currency = p.currency || null;
      if ('arrival_date' in p) upd.arrival_date = p.arrival_date || null;
      if ('booking_date' in p) upd.booking_date = p.booking_date || null;
      const { error: ue } = await supabase.from('acc_first_client_data').update(upd).eq('id', p.entry_id).eq('source', 'dashboard');
      if (ue) return J({ error: ue.message }, 400);
      return J({ ok: true, updated: p.entry_id });
    }
    // ===== ترقية عميل من «شيت» إلى «داشبورد» ليصير قابلاً للتعديل الكامل (المالكة فقط) =====
    // يجعل صف العميل source='dashboard' فيخضع لكل منطق التعديل، والمزامنة تستثنيه من إعادة الإدخال (لا يُمسح ولا يتكرّر)
    if (action === 'promote_sheet_client') {
      if (!callerIsOwner) return J({ error: 'الترقية للمالكة فقط' }, 403);
      const pc = String(p.payment_code || '').trim();
      const cc = String(p.client_code || '').trim();
      if (!pc && !cc) return J({ error: 'no payment_code/client_code' }, 400);
      let q = supabase.from('acc_first_client_data').update({ source: 'dashboard' }).eq('source', 'sheet');
      q = pc ? q.eq('payment_code', pc) : q.eq('client_code', cc);
      const { data, error } = await q.select('id,payment_code,client_code');
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, promoted: (data || []).length, rows: data || [] });
    }
    // ===== اعتماد الأجهزة (المالكة فقط — خادمياً) =====
    if (action === 'approve_device' || action === 'reject_device' || action === 'revoke_device') {
      if (!callerIsOwner) return J({ error: 'forbidden — owner only' }, 403);
    }
    if (action === 'approve_device' || action === 'reject_device') {
      const dt = String(p.device_token || '').trim(); const sn = String(p.staff_name || '').trim();
      if (!dt || !sn) return J({ error: 'device_token/staff_name required' }, 400);
      const st = action === 'approve_device' ? 'approved' : 'rejected';
      const { error } = await supabase.from('acc_devices').update({ status: st, decided_at: new Date().toISOString(), decided_by: p.by || null }).eq('device_token', dt).eq('staff_name', sn);
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, status: st });
    }
    if (action === 'revoke_device') {
      const dt = String(p.device_token || '').trim(); const sn = String(p.staff_name || '').trim();
      if (!dt || !sn) return J({ error: 'device_token/staff_name required' }, 400);
      const { error } = await supabase.from('acc_devices').delete().eq('device_token', dt).eq('staff_name', sn);
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    return J({ error: 'unknown action' }, 400);
  }
  const { data, error } = await supabase.from('acc_recon_reports').select(LIST_COLS).order('created_at', { ascending: false });
  if (error) return J({ error: error.message }, 500);
  const { data: pds } = await supabase.from('acc_fcd_payment_dates').select('payment_code,payment_date');
  const { data: cds } = await supabase.from('acc_svc_charge_dates').select('service_id,charge_date');
  const { data: bnkOv } = await supabase.from('acc_fcd_bank_overrides').select('payment_code,bank_name,bank_ref');
  const { data: rdocs } = await supabase.from('acc_refund_docs').select(RDOC_META).order('created_at', { ascending: false });
  // بيانات الأجهزة للمالكة فقط (لوحة التحكّم) — الموظف يستلم مصفوفة فارغة
  let devs: any[] = [];
  if (callerIsOwner) { const { data: dd } = await supabase.from('acc_devices').select('device_token,staff_name,status,ip,user_agent,requested_at,decided_at,last_seen').order('requested_at', { ascending: false }); devs = dd || []; }
  return J({ ok: true, reconReports: data || [], paymentDates: pds || [], chargeDates: cds || [], bankOverrides: bnkOv || [], refundDocs: rdocs || [], devices: devs });
});
