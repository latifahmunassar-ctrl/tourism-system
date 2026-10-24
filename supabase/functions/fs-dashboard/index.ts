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
  expenses: 'fs_expenses',
};
// الأعمدة المسموح كتابتها لكل جدول (حارس ضد الحقول الغريبة)
const FIELDS: Record<string, string[]> = {
  daily_sales: ['sale_date','branch','machine','cash','credit_sales','credits','bank_transfer','transfers','total','rewa_machine','rewa_cash','rewa_credit','rewa_transfer','rewa_total','tax_rate','returns','note','note_machine','note_cash','note_credit','note_transfer','created_by'],
  expenses: ['exp_date','branch','category','amount','pay_method','note','created_by'],
  rewa_recon: ['recon_date','period','branch','payment_method','rewa_total','sheet_total','note','created_by'],
  credit_customers: ['name','phone','note'],
  credit_txn: ['customer_id','txn_date','doc_no','invoice_amount','paid_amount','returned_amount','note'],
  bank_txn: ['actual_date','close_date','amount','direction','bank_name','note'],
  atm_deposit: ['dep_date','branch','amount','note'],
  inventory_short: ['code','qty_invoice','price','qty_actual','note'],
  lists: ['category','value','sort'],
};
const pick = (obj: any, allowed: string[]) => { const o: any = {}; for (const k of allowed) if (k in (obj || {})) o[k] = obj[k] === '' ? null : obj[k]; return o; };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  // 🔐 مصادقة نظام العز: مفتاح النظام (المالكة) أو جلسة مالكة صالحة من acc_sessions
  const key = req.headers.get('x-acc-key') || req.headers.get('x-fs-key') || url.searchParams.get('key');
  let authed = (!!ACCESS_KEY && key === ACCESS_KEY);
  if (!authed) {
    const tok = req.headers.get('x-acc-token') || url.searchParams.get('token');
    if (tok) {
      const { data: s } = await supabase.from('acc_sessions').select('expires_at,is_owner').eq('token', tok).maybeSingle();
      if (s && s.is_owner && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now())) authed = true;
    }
  }
  if (!authed) return J({ error: 'unauthorized' }, 401);

  // ===== GET: كل البيانات =====
  if (req.method === 'GET') {
    const [config, lists, daily_sales, rewa_recon, credit_customers, credit_txn, bank_txn, atm_deposit, inventory_short, expenses] = await Promise.all([
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
    ]);
    const cfg: any = {}; (config.data || []).forEach((r: any) => cfg[r.key] = r.value);
    return J({ config: cfg, lists: lists.data || [], daily_sales: daily_sales.data || [], rewa_recon: rewa_recon.data || [],
      credit_customers: credit_customers.data || [], credit_txn: credit_txn.data || [], bank_txn: bank_txn.data || [],
      atm_deposit: atm_deposit.data || [], inventory_short: inventory_short.data || [], expenses: expenses.data || [] });
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
