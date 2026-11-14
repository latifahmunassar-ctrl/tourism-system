// 🛍️ Fancy Sense — نظام محاسبي منفصل تماماً عن العز (جداول fs_*)
// 🔐 المصادقة = نفس نظام العز (لا مفتاح مضمّن في الكود): مفتاح النظام من متغيّر بيئة سرّي، أو جلسة مالكة من acc_sessions.
import { createClient } from 'jsr:@supabase/supabase-js@2';
const ACCESS_KEY = Deno.env.get('FS_ACCESS_KEY') || Deno.env.get('ACC_ACCESS_KEY') || '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-acc-key, x-acc-token, x-fs-key, content-type, apikey', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// الجداول المسموح بها للـ CRUD العام (تمنع أي كتابة خارج نطاق فانسي سنس)
const TABLES: Record<string, string> = {
  config: 'fs_config', lists: 'fs_lists', daily_sales: 'fs_daily_sales',
  rewa_recon: 'fs_rewa_recon', credit_customers: 'fs_credit_customers', credit_txn: 'fs_credit_txn',
  bank_txn: 'fs_bank_txn', atm_deposit: 'fs_atm_deposit', inventory_short: 'fs_inventory_short',
  expenses: 'fs_expenses', machine_deposit: 'fs_machine_deposit',
};
// الأعمدة المسموح كتابتها لكل جدول (حارس ضد الحقول الغريبة)
const FIELDS: Record<string, string[]> = {
  daily_sales: ['sale_date','branch','machine','cash','credit_sales','credits','bank_transfer','transfers','total','rewa_machine','rewa_cash','rewa_credit','rewa_transfer','rewa_total','tax_rate','returns','note','note_machine','note_cash','note_credit','note_transfer','created_by'],
  expenses: ['exp_date','branch','category','amount','pay_method','note','created_by'],
  rewa_recon: ['recon_date','period','branch','payment_method','rewa_total','sheet_total','note','created_by'],
  credit_customers: ['name','phone','note'],
  credit_txn: ['customer_id','txn_date','doc_no','invoice_amount','paid_amount','returned_amount','note'],
  bank_txn: ['actual_date','close_date','amount','direction','bank_name','note'],
  atm_deposit: ['dep_date','branch','amount','bank','note'],
  inventory_short: ['code','qty_invoice','price','qty_actual','note'],
  machine_deposit: ['dep_date','actual_bank','bank_ref','note','created_by'],
  lists: ['category','value','sort'],
};
// 👥 المحاسبون المسموح لهم بطلب تعديل/حذف (المالكة ١٤ نوفمبر ٢٠٢٦): محمد وآية
const canEdit = (name: string) => /mohamed|mohammed|muhammad|محمد|ayah|\baya\b|آية|اية|ايه/i.test(String(name || ''));
const pick = (obj: any, allowed: string[]) => { const o: any = {}; for (const k of allowed) if (k in (obj || {})) o[k] = obj[k] === '' ? null : obj[k]; return o; };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  // 🔐 مصادقة نظام العز: مفتاح النظام (المالكة) أو جلسة مالكة صالحة من acc_sessions
  const key = req.headers.get('x-acc-key') || req.headers.get('x-fs-key') || url.searchParams.get('key');
  let authed = (!!ACCESS_KEY && key === ACCESS_KEY);
  // 👑 مفتاح النظام = المالكة. الجلسة: is_owner → مالكة، غيرها موظّف (اسمه من الجلسة)
  let isOwner = authed; let staffName = authed ? 'المالكة' : '';
  if (!authed) {
    const tok = req.headers.get('x-acc-token') || url.searchParams.get('token');
    if (tok) {
      // المالكة (is_owner) أو موظّف صلاحياته تشمل تبويب "fancy" (تُمنح من لوحة صلاحيات العز)
      const { data: s } = await supabase.from('acc_sessions').select('expires_at,is_owner,allowed_tabs,staff_name').eq('token', tok).maybeSingle();
      if (s && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now())) {
        const tabs = Array.isArray(s.allowed_tabs) ? s.allowed_tabs : [];
        if (s.is_owner || tabs.includes('fancy')) authed = true;
        isOwner = !!s.is_owner; staffName = isOwner ? 'المالكة' : String((s as any).staff_name || '');
      }
    }
  }
  if (!authed) return J({ error: 'unauthorized' }, 401);

  // ===== GET: كل البيانات =====
  if (req.method === 'GET') {
    const [config, lists, daily_sales, rewa_recon, credit_customers, credit_txn, bank_txn, atm_deposit, inventory_short, expenses, machine_deposit] = await Promise.all([
      supabase.from('fs_config').select('*'),
      supabase.from('fs_lists').select('*').order('sort').order('value'),
      supabase.from('fs_daily_sales').select('*').order('sale_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fs_rewa_recon').select('*').order('recon_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fs_credit_customers').select('*').order('created_at', { ascending: false }),
      supabase.from('fs_credit_txn').select('*').order('txn_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fs_bank_txn').select('*').order('actual_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fs_atm_deposit').select('*').order('dep_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fs_inventory_short').select('*').order('created_at', { ascending: false }),
      supabase.from('fs_expenses').select('*').order('exp_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fs_machine_deposit').select('*').order('dep_date', { ascending: false }).order('created_at', { ascending: false }),
    ]);
    const cfg: any = {}; (config.data || []).forEach((r: any) => cfg[r.key] = r.value);
    // 🔗 سجلات فانسي سنس في نظام العز (الكاش إن/آوت) — للمطابقة فقط (قراءة): OMR فقط (استبعاد العملات الأجنبية المصنّفة خطأً)
    let accFancy: any[] = [];
    try {
      const { data: af } = await supabase.from('acc_banks_cash')
        .select('id,tx_date,in_raw,out_raw,bank_name,bank_ref,channel,description,details,more_details,currency')
        .or('channel.ilike.%fancy%,description.ilike.%fancy sense%')
        .order('tx_date', { ascending: false });
      accFancy = (af || []).filter((r: any) => !r.currency || String(r.currency).toUpperCase() === 'OMR');
    } catch (_) {}
    // 🏧 ٨ نوفمبر ٢٠٢٦: إيداعات فانسي في «كشف البنك» بنظام العز (acc_bank_txn) — موسومة Fancy بالملاحظة (ظفار = المكنة، مسقط = الصناديق).
    //   بعض الأيام (يونيو–أغسطس ٢٠٢٦) موجودة هنا فقط وليست في الكاش إن/آوت → لمتابعة المكنة فقط (لا تدخل باقي المطابقات).
    let accFancyBtx: any[] = [];
    try {
      const { data: bt } = await supabase.from('acc_bank_txn')
        .select('id,tx_date,amount_in,bank_name,bank_ref,note,currency')
        .ilike('note', '%fancy%').gt('amount_in', 0)   // كل البنوك: ظفار (المكنة) + مسقط (إيداعات الصناديق)
        .order('tx_date', { ascending: false });
      accFancyBtx = (bt || []).filter((r: any) => !r.currency || String(r.currency).toUpperCase() === 'OMR');
    } catch (_) {}
    // 🔔 طلبات التعديل/الحذف — تظهر للمالكة فقط
    let fsRequests: any[] = [];
    if (isOwner) { try { const { data: rq } = await supabase.from('fs_change_requests').select('*').order('created_at', { ascending: false }).limit(200); fsRequests = rq || []; } catch (_) {} }
    return J({ me: { owner: isOwner, name: staffName, can_edit: isOwner || canEdit(staffName) }, fs_requests: fsRequests, acc_fancy_btx: accFancyBtx, config: cfg, lists: lists.data || [], daily_sales: daily_sales.data || [], rewa_recon: rewa_recon.data || [],
      credit_customers: credit_customers.data || [], credit_txn: credit_txn.data || [], bank_txn: bank_txn.data || [],
      atm_deposit: atm_deposit.data || [], inventory_short: inventory_short.data || [], expenses: expenses.data || [], machine_deposit: machine_deposit.data || [], acc_fancy: accFancy });
  }

  // ===== POST: عمليات =====
  if (req.method === 'POST') {
    let body: any = {}; try { body = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
    const action = body.action; const p = body.payload || {};

    // config: حفظ إعداد (نسبة الضريبة…)
    if (action === 'set_config') {
      if (!p.key) return J({ error: 'no key' }, 400);
      const { error } = await supabase.from('fs_config').upsert({ key: String(p.key), value: p.value == null ? null : String(p.value), updated_at: new Date().toISOString() });
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    // ✅/❌ المالكة تعتمد أو ترفض طلب تعديل/حذف — الأثر ينطبق هنا فقط
    if (action === 'resolve_request') {
      if (!isOwner) return J({ error: 'للمالكة فقط' }, 403);
      const { data: rq } = await supabase.from('fs_change_requests').select('*').eq('id', p.id).maybeSingle();
      if (!rq) return J({ error: 'الطلب غير موجود' }, 404);
      if (rq.status !== 'pending') return J({ error: 'الطلب محسوم مسبقاً' }, 400);
      const tbl = TABLES[String(rq.tbl)]; if (!tbl) return J({ error: 'table not allowed' }, 400);
      let result = 'رُفض — بلا تغيير';
      if (p.decision === 'approve') {
        if (rq.action === 'delete') { const { error } = await supabase.from(tbl).delete().eq('id', rq.row_id); if (error) return J({ error: error.message }, 400); result = 'حُذف السطر'; }
        else { const row = pick(rq.new || {}, FIELDS[String(rq.tbl)] || []); const { error } = await supabase.from(tbl).update(row).eq('id', rq.row_id); if (error) return J({ error: error.message }, 400); result = 'طُبّق التعديل'; }
      }
      await supabase.from('fs_change_requests').update({ status: p.decision === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString(), result }).eq('id', rq.id);
      return J({ ok: true, result });
    }
    // ✏️🗑️ المحاسب (محمد/آية): التعديل والحذف = طلب ينتظر موافقة المالكة، بلا أي أثر قبلها
    if ((action === 'update' || action === 'delete') && !isOwner) {
      if (!canEdit(staffName)) return J({ error: 'التعديل والحذف مسموح للمحاسبين محمد وآية فقط' }, 403);
      const tblKey = String(p.table || ''); const tbl = TABLES[tblKey];
      if (!tbl) return J({ error: 'table not allowed' }, 400);
      if (p.id == null) return J({ error: 'no id' }, 400);
      const reason = String(p.reason || '').trim(); if (!reason) return J({ error: 'سبب التعديل إجباري' }, 400);
      const { data: old } = await supabase.from(tbl).select('*').eq('id', p.id).maybeSingle();
      if (!old) return J({ error: 'السطر غير موجود' }, 404);
      const { data: dup } = await supabase.from('fs_change_requests').select('id').eq('tbl', tblKey).eq('row_id', p.id).eq('status', 'pending').limit(1);
      if (dup && dup.length) return J({ ok: true, pending: true, dup: true });
      let nw: any = null;
      if (action === 'update') { const row = pick(p.data, FIELDS[tblKey] || []); nw = {}; for (const k of Object.keys(row)) if (JSON.stringify(row[k] ?? null) !== JSON.stringify((old as any)[k] ?? null)) nw[k] = row[k]; if (!Object.keys(nw).length) return J({ error: 'ما فيه أي تغيير' }, 400); }
      const { error } = await supabase.from('fs_change_requests').insert({ tbl: tblKey, row_id: p.id, action, old, new: nw, reason, requested_by: staffName || 'موظّف' });
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, pending: true });
    }
    // CRUD عام على الجداول المسموح بها فقط
    if (action === 'insert' || action === 'update' || action === 'delete') {
      const tbl = TABLES[String(p.table || '')];
      if (!tbl) return J({ error: 'table not allowed' }, 400);
      if (action === 'delete') {
        if (p.id == null) return J({ error: 'no id' }, 400);
        const { error } = await supabase.from(tbl).delete().eq('id', p.id);
        if (error) return J({ error: error.message }, 400);
        return J({ ok: true });
      }
      const allowed = FIELDS[String(p.table)] || [];
      const row = pick(p.data, allowed);
      if (action === 'insert') {
        const { data, error } = await supabase.from(tbl).insert(row).select().single();
        if (error) return J({ error: error.message }, 400);
        return J({ ok: true, row: data });
      } else {
        if (p.id == null) return J({ error: 'no id' }, 400);
        const { data, error } = await supabase.from(tbl).update(row).eq('id', p.id).select().single();
        if (error) return J({ error: error.message }, 400);
        return J({ ok: true, row: data });
      }
    }
    return J({ error: 'unknown action' }, 400);
  }
  return J({ error: 'method not allowed' }, 405);
});
