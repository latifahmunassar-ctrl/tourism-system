import { createClient } from 'jsr:@supabase/supabase-js@2';

const ACCESS_KEY = 'alezz-2027-12ecc215b4f92deda19ed956937c3899';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-acc-key, x-acc-token, content-type, apikey', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
async function fetchAll(supabase: any, table: string, orderCol: string | null = 'id') { let out: any[] = []; let from = 0; const page = 1000; while (true) { let q = supabase.from(table).select('*'); if (orderCol) q = q.order(orderCol, { ascending: true }); const { data, error } = await q.range(from, from + page - 1); if (error) throw new Error(table + ': ' + error.message); out = out.concat(data || []); if (!data || data.length < page) break; from += page; } return out; }
const SVC_FIELDS = ['kind','name','detail','supplier','amount','currency_rate','check_in','check_out','final_rate_booked','conf_no','cancel_charge','refund','booked_by','status','booked_from','charge_from','agent_code','bank_name','currency','confirmed_by','type_of_job','sell_currency','booked_currency','rooms_count'];
const ALL_TABS = ['overview','notifs','tickets','entry','clients','sales','booking','bookings','detail','hotels','pnl','due','payments','staff','agents','suppliers','banks','bankscash','control'];
const TAB_DATA: Record<string, string[]> = { overview: ['kpis','overview','monthly','due','fcd'], notifs: ['alerts','pendingMovements','overview','serviceLines','fcd'], tickets: ['serviceLines','fcd','overview'], entry: ['lists','fcd','serviceLines','supplierInvoices'], clients: ['fcd','due','overview','serviceLines'], sales: ['sales','fcd'], booking: ['bookingForm','bf','serviceLines','fcd'], bookings: ['overview','serviceLines','fcd'], detail: ['overview','serviceLines','fcd','hotelBookings','supplierInvoices','supplierPayments','allocations','bankTx'], hotels: ['hotelBookings','hotelPayments','supplierInvoices','supplierPayments','allocations'], pnl: ['overview','monthly','kpis','bf','fcd'], due: ['due','fcd'], payments: ['refunds','fcd','bankTx','due','overview'], staff: ['staff'], agents: ['agents'], suppliers: ['supplierInvoices','supplierPayments','allocations','autofillInvoices','fcd'], banks: ['bankTx','banksCash','fcd'], bankscash: ['banksCash'], control: ['staffAccess','auditLog','securityCount'] };
const BASE_KEYS = ['lists','profitOverrides','settlements','deletedClients','lastSync','generatedAt','me'];
const ARR_KEYS = ['overview','due','staff','agents','fcd','bookingForm','sales','serviceLines','hotelBookings','refunds','supplierInvoices','bankTx','banksCash','alerts','supplierPayments','allocations','autofillInvoices','pendingMovements','hotelPayments','staffAccess','auditLog','profitOverrides','settlements','deletedClients','monthly','lists'];
function filterForStaff(resp: any, allowedTabs: string[]) { const allow = new Set(BASE_KEYS); for (const t of (allowedTabs || [])) (TAB_DATA[t] || []).forEach((k) => allow.add(k)); for (const k of ARR_KEYS) { if (!allow.has(k)) resp[k] = []; } if (!allow.has('bf')) resp.bf = {}; if (!allow.has('kpis')) resp.kpis = { totalProfit: 0, bookings: 0, outstanding: 0, overdue: 0, clients: 0 }; resp.staffAccess = []; resp.auditLog = []; resp.securityCount = 0; return resp; }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const key = req.headers.get('x-acc-key') || url.searchParams.get('key');
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || '';
  const ua = req.headers.get('user-agent') || '';
  const wa = async (msg: string) => { try { const { data: cfg } = await supabase.from('acc_config').select('key,value').in('key', ['callmebot_phone', 'callmebot_apikey']); const m: any = {}; (cfg || []).forEach((r: any) => m[r.key] = r.value); const ph = m.callmebot_phone, k = m.callmebot_apikey; if (!ph || !k) return; await fetch('https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(ph) + '&apikey=' + encodeURIComponent(k) + '&text=' + encodeURIComponent(msg)); } catch (_) {} };
  const geoCountry = async (a: string) => { if (!a) return ''; try { const r = await fetch('https://ipwho.is/' + encodeURIComponent(a) + '?fields=success,country_code'); const j = await r.json(); return (j && j.success !== false) ? String(j.country_code || '') : ''; } catch (_) { return ''; } };
  const audit = async (e: any) => { try { await supabase.from('acc_audit_log').insert({ event_type: e.event_type, severity: e.severity || 'info', staff_name: e.staff_name || null, action: e.action || null, detail: e.detail || null, ip: ip || null, user_agent: ua || null, ok: e.ok }); } catch (_) {} if ((e.severity || '') === 'critical') { await wa('🚨 تنبيه أمني — نظام الحسابات\n• النوع: ' + (e.event_type || '') + '\n• ' + (e.detail || '') + (e.staff_name ? '\n• الاسم: ' + e.staff_name : '') + (ip ? '\n• IP: ' + ip : '')); } if (e.event_type === 'login' && e.ok === true && ip) { try { const cc = await geoCountry(ip); if (cc && cc !== 'OM') { await wa('🚨 دخول ناجح للنظام المحاسبي من خارج عُمان\n• الدولة: ' + cc + '\n• المستخدم: ' + (e.staff_name || '—') + '\n• IP: ' + ip); try { await supabase.from('acc_audit_log').insert({ event_type: 'login_foreign', severity: 'critical', staff_name: e.staff_name || null, action: 'login', detail: 'دخول ناجح من خارج عُمان — الدولة ' + cc, ip: ip || null, user_agent: ua || null, ok: true }); } catch (_) {} } } catch (_) {} } };
  const recentCount = async (et: string, minutes: number) => { try { const since = new Date(Date.now() - minutes * 60000).toISOString(); const { count } = await supabase.from('acc_audit_log').select('id', { count: 'exact', head: true }).eq('event_type', et).eq('ip', ip || '').eq('ok', false).gte('ts', since); return count || 0; } catch (_) { return 0; } };
  let sess: any = null;
  if (key !== ACCESS_KEY) { const tok = req.headers.get('x-acc-token') || url.searchParams.get('token'); if (tok) { const { data: s } = await supabase.from('acc_sessions').select('staff_name,is_owner,allowed_tabs,expires_at').eq('token', tok).maybeSingle(); if (s && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now())) { sess = s; try { await supabase.from('acc_sessions').update({ last_seen: new Date().toISOString() }).eq('token', tok); } catch (_) {} } } }
  // 🏦 صلاحية إدخال المرجع البنكي: المالكة أو المحاسب فقط (قرار المالكة 19 يوليو 2026)
  let callerRole = (key === ACCESS_KEY) ? 'owner' : '';
  if (sess) { if (sess.is_owner) callerRole = 'owner'; else { try { const { data: sa } = await supabase.from('acc_staff_access').select('role').eq('staff_name', sess.staff_name).maybeSingle(); callerRole = (sa && sa.role) ? String(sa.role) : ''; } catch (_) {} } }
  const callerBankRef = (key === ACCESS_KEY) || (sess && !!sess.is_owner) || /محاسب|accountant/i.test(callerRole);
  let _body: any = null;
  if (req.method === 'POST') { try { _body = await req.json(); } catch { _body = {}; } }
  const _isLogin = req.method === 'POST' && _body && _body.action === 'staff_login';
  if (key !== ACCESS_KEY && !sess && !_isLogin) { const rc = await recentCount('unauthorized', 15); await audit({ event_type: 'unauthorized', severity: rc >= 3 ? 'critical' : 'info', detail: 'محاولة وصول بمفتاح خاطئ أو مفقود' + (rc >= 3 ? ' — متكرر ×' + (rc + 1) + ' من نفس IP' : ''), ok: false }); return J({ error: 'unauthorized' }, 401); }

  if (req.method === 'POST') {
    const body: any = _body || {};
    const action = body.action; const p = body.payload || {};
    const _today = new Date().toISOString().slice(0, 10);   // 📅 تاريخ اليوم — يُستخدم افتراضاً لأي دفعة بلا تاريخ (لا دفعة بلا تاريخ)
    // 🔒 حارس دائم: توحيد كود العميل لحروف كبيرة في كل مسارات الحفظ (يمنع فصل c26507 عن C26507 في المستحقات/النظرة العامة والمرتجعات والتوزيعات)
    if (p && typeof p.client_code === 'string') p.client_code = p.client_code.trim().toUpperCase();
    if (action === 'staff_login') {
      const name = String(p.name || '').trim(); const pin = String(p.pin || '').trim();
      if (!name) return J({ error: 'الاسم مطلوب' }, 400);
      const { data: u, error } = await supabase.from('acc_staff_access').select('*').eq('staff_name', name).maybeSingle();
      if (error) return J({ error: error.message }, 400);
      if (!u || u.active === false) { const rc = await recentCount('failed_login', 15); await audit({ event_type: 'failed_login', severity: rc >= 2 ? 'critical' : 'warning', staff_name: name, detail: (u ? 'حساب موقوف' : 'اسم غير موجود') + (rc >= 2 ? ' — متكرر ×' + (rc + 1) : ''), ok: false }); return J({ error: 'مستخدم غير موجود أو موقوف' }, 400); }
      if (String(u.pin || '') !== pin) { const rc = await recentCount('failed_login', 15); await audit({ event_type: 'failed_login', severity: rc >= 2 ? 'critical' : 'warning', staff_name: name, detail: 'رمز دخول خاطئ' + (rc >= 2 ? ' — متكرر ×' + (rc + 1) : ''), ok: false }); return J({ error: 'رمز الدخول غير صحيح' }, 400); }
      // 🔐 اعتماد الجهاز مربوط بـ(اسم الموظف + الجهاز): الاسم والرمز صحيحان، لكن لا يُسمح بالدخول إلا من جهاز معتمد لهذا الموظف تحديداً.
      // المالكة (is_owner) مُعفاة (حتى لا تُقفل عن لوحة الموافقة). الموظف: جهاز جديد → طلب اعتماد معلّق ورفض الدخول حتى موافقة المالكة.
      if (!u.is_owner) {
        const dtok = String(p.device_token || '').trim();
        if (!dtok) return J({ error: 'الجهاز غير معرّف — أعيدي فتح الصفحة', device_pending: true }, 200);
        const { data: dev } = await supabase.from('acc_devices').select('status').eq('device_token', dtok).eq('staff_name', u.staff_name).maybeSingle();
        if (!dev) {
          try { await supabase.from('acc_devices').insert({ device_token: dtok, staff_name: u.staff_name, status: 'pending', ip: ip || null, user_agent: ua || null, requested_at: new Date().toISOString(), last_seen: new Date().toISOString() }); } catch (_) {}
          await audit({ event_type: 'device_request', severity: 'warning', staff_name: u.staff_name, detail: 'طلب اعتماد جهاز جديد', ok: false });
          return J({ ok: false, device_pending: true, staff_name: u.staff_name });
        }
        if (dev.status === 'rejected') { await audit({ event_type: 'device_rejected_login', severity: 'critical', staff_name: u.staff_name, detail: 'محاولة دخول من جهاز مرفوض', ok: false }); return J({ ok: false, device_rejected: true }); }
        if (dev.status !== 'approved') { try { await supabase.from('acc_devices').update({ last_seen: new Date().toISOString(), ip: ip || null, user_agent: ua || null }).eq('device_token', dtok).eq('staff_name', u.staff_name); } catch (_) {} return J({ ok: false, device_pending: true, staff_name: u.staff_name }); }
        try { await supabase.from('acc_devices').update({ last_seen: new Date().toISOString() }).eq('device_token', dtok).eq('staff_name', u.staff_name); } catch (_) {}
      }
      await audit({ event_type: 'login', severity: 'info', staff_name: u.staff_name, detail: u.is_owner ? 'دخول مالكة' : 'دخول موظف', ok: true });
      const token = crypto.randomUUID() + '-' + crypto.randomUUID();
      try { await supabase.from('acc_sessions').insert({ token, staff_name: u.staff_name, is_owner: !!u.is_owner, allowed_tabs: u.allowed_tabs || [], ip: ip || null, user_agent: ua || null, expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString() }); } catch (_) {}
      return J({ ok: true, token, user: { staff_name: u.staff_name, is_owner: u.is_owner, allowed_tabs: u.allowed_tabs || [] } });
    }
    if (action === 'log_event') { await audit({ event_type: String(p.event_type || 'event'), severity: p.severity || 'info', staff_name: p.staff_name || null, action: p.action || null, detail: p.detail || null, ok: p.ok !== false }); return J({ ok: true }); }
    if (action === 'ack_audit') { let q = supabase.from('acc_audit_log').update({ acknowledged: true }); if (Array.isArray(p.ids) && p.ids.length) q = q.in('id', p.ids); else q = q.eq('acknowledged', false); const { error } = await q; if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'change_profit') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const { data: row, error: e0 } = await supabase.from('acc_first_client_data').select('id,payment_code,client_code,client_name,cost,profit,amount_paid').eq('id', p.id).single();
      if (e0 || !row) return J({ error: 'السطر غير موجود' }, 400);
      if (!row.payment_code) return J({ error: 'لا يمكن تعديل ربح سطر بلا كود دفعة' }, 400);
      const oldP = Number(row.profit || 0); const newP = Number(p.new_profit);
      if (isNaN(newP)) return J({ error: 'قيمة الربح غير صحيحة' }, 400);
      const reason = String(p.reason || '').trim(); const decreased = newP < oldP;
      if (decreased && !reason) return J({ error: 'سبب نقصان الربح إجباري' }, 400);
      // 🔒 غير المالكة: تعديل ربح إدخال محفوظ يُرسَل طلب موافقة للمالكة، ولا يُطبَّق حتى الاعتماد
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner)) && Math.abs(newP - oldP) > 0.005) {
        await supabase.from('acc_pending_movements').insert({ kind: 'client_edit', scope: 'fcd', status: 'pending', summary: '💰 طلب تعديل ربح «' + (row.client_code || row.payment_code || '') + '» من ' + oldP + ' إلى ' + newP, note: 'تعديل ربح إدخال محفوظ (يحتاج موافقتك)' + (reason ? ' · السبب: ' + reason : '') + ' · مقدّم الطلب: ' + (p.by || '—'), payload: { _profit_only: true, id: p.id, new_profit: newP, reason: reason || null, by: p.by || null } });
        return J({ ok: true, pending: true, msg: 'أُرسل طلب تعديل الربح لموافقة المالكة — لن يتغيّر حتى الاعتماد' });
      }
      const { error: oe } = await supabase.from('acc_profit_overrides').upsert({ payment_code: row.payment_code, client_code: row.client_code, new_profit: newP, old_profit: oldP, reason: reason || null, changed_by: p.by || null, created_at: new Date().toISOString() }, { onConflict: 'payment_code' });
      if (oe) return J({ error: oe.message }, 400);
      const { error: ue } = await supabase.from('acc_first_client_data').update({ profit: newP }).eq('id', p.id);
      if (ue) return J({ error: ue.message }, 400);
      if (decreased) { await supabase.from('acc_alerts').insert({ type: 'profit_decrease', client_code: row.client_code || null, service_name: row.client_name || row.payment_code || '', message: 'تخفيض ربح «' + (row.client_code || '') + '» من ' + oldP + ' إلى ' + newP + ' (فرق ' + (newP - oldP) + ') · السبب: ' + reason, status: 'pending' }); }
      await audit({ event_type: 'profit_change', severity: 'info', staff_name: p.by || null, action: 'change_profit', detail: (decreased ? 'تخفيض' : 'زيادة') + ' ربح ' + (row.payment_code || '') + ' من ' + oldP + ' إلى ' + newP + (decreased ? ' · ' + reason : ''), ok: true });
      return J({ ok: true, decreased: decreased, old: oldP, new: newP });
    }
    if (action === 'request_cost_change') {
      const sid = p.service_id; if (!sid) return J({ error: 'no service_id' }, 400);
      const nv = Number(p.new_cost); if (isNaN(nv)) return J({ error: 'قيمة التكلفة غير صحيحة' }, 400);
      const ov = Number(p.old_cost || 0);
      const reason = String(p.reason || '').trim(); if (!reason) return J({ error: 'سبب التعديل إجباري' }, 400);
      const { data: ex } = await supabase.from('acc_alerts').select('id').eq('type', 'cost_change_request').eq('service_id', sid).eq('status', 'pending').limit(1);
      if (ex && ex.length) return J({ ok: true, requested: true, dup: true });
      const { error } = await supabase.from('acc_alerts').insert({ type: 'cost_change_request', client_code: p.client_code || null, service_id: sid, service_name: p.service_name || null, req_value: nv, req_old: ov, message: 'طلب تعديل تكلفة الحجز «' + (p.service_name || '') + '» من ' + ov + ' إلى ' + nv + ' · السبب: ' + reason + ' · مقدّم الطلب: ' + (p.by || '—'), status: 'pending' });
      if (error) return J({ error: error.message }, 400);
      await audit({ event_type: 'cost_change_request', severity: 'info', staff_name: p.by || null, action: 'request_cost_change', detail: 'طلب تعديل تكلفة خدمة ' + sid + ' إلى ' + nv, ok: true });
      return J({ ok: true, requested: true });
    }
    if (action === 'resolve_cost_change') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: al, error: e0 } = await supabase.from('acc_alerts').select('*').eq('id', p.id).single();
      if (e0 || !al) return J({ error: 'الطلب غير موجود' }, 400);
      if (al.type !== 'cost_change_request') return J({ error: 'نوع غير صحيح' }, 400);
      if (al.status !== 'pending') return J({ error: 'الطلب معالَج مسبقاً' }, 400);
      if (decision === 'approve') {
        const { error: ue } = await supabase.from('acc_service_lines').update({ final_rate_booked: al.req_value, source: 'dashboard' }).eq('id', al.service_id);
        if (ue) return J({ error: ue.message }, 400);
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '✅ تمت الموافقة — عُدّلت التكلفة إلى ' + al.req_value, resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'cost_change_approved', severity: 'info', staff_name: p.by || null, action: 'resolve_cost_change', detail: 'تعديل تكلفة خدمة ' + al.service_id + ' إلى ' + al.req_value, ok: true });
      } else {
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '❌ رُفض الطلب — التكلفة تبقى ' + (al.req_old != null ? al.req_old : ''), resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'cost_change_rejected', severity: 'info', staff_name: p.by || null, action: 'resolve_cost_change', detail: 'رفض تعديل تكلفة خدمة ' + al.service_id, ok: true });
      }
      return J({ ok: true, decision });
    }
    if (action === 'request_cancel') {
      const sid = p.service_id; if (!sid) return J({ error: 'no service_id' }, 400);
      const cc = Number(p.cancel_charge || 0); if (isNaN(cc) || cc < 0) return J({ error: 'قيمة رسوم الإلغاء غير صحيحة' }, 400);
      const reason = String(p.reason || '').trim();
      const { data: ex } = await supabase.from('acc_alerts').select('id').eq('type', 'cancel_request').eq('service_id', sid).eq('status', 'pending').limit(1);
      if (ex && ex.length) return J({ ok: true, requested: true, dup: true });
      const { data: sl } = await supabase.from('acc_service_lines').select('final_rate_booked').eq('id', sid).single();
      const finalv = Number(sl?.final_rate_booked || 0);
      if (finalv > 0 && cc > finalv + 0.005) return J({ error: 'رسوم الإلغاء لا يمكن أن تتجاوز قيمة الحجز الفعلي (' + finalv + ')' }, 400);
      const { error } = await supabase.from('acc_alerts').insert({ type: 'cancel_request', client_code: p.client_code || null, service_id: sid, service_name: p.service_name || null, req_value: cc, message: 'طلب إلغاء حجز «' + (p.service_name || '') + '» · رسوم الإلغاء ' + cc + (reason ? ' · السبب: ' + reason : '') + ' · مقدّم الطلب: ' + (p.by || '—'), status: 'pending' });
      if (error) return J({ error: error.message }, 400);
      await audit({ event_type: 'cancel_request', severity: 'info', staff_name: p.by || null, action: 'request_cancel', detail: 'طلب إلغاء خدمة ' + sid + ' رسوم ' + cc, ok: true });
      return J({ ok: true, requested: true });
    }
    if (action === 'resolve_cancel') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: al, error: e0 } = await supabase.from('acc_alerts').select('*').eq('id', p.id).single();
      if (e0 || !al) return J({ error: 'الطلب غير موجود' }, 400);
      if (al.type !== 'cancel_request') return J({ error: 'نوع غير صحيح' }, 400);
      if (al.status !== 'pending') return J({ error: 'الطلب معالَج مسبقاً' }, 400);
      if (decision === 'approve') {
        const { data: sl } = await supabase.from('acc_service_lines').select('final_rate_booked').eq('id', al.service_id).single();
        const finalv = Number(sl?.final_rate_booked || 0); const cc = Number(al.req_value || 0);
        const refund = Math.max(0, finalv - cc);
        const { error: ue } = await supabase.from('acc_service_lines').update({ status: 'Cancel', cancel_charge: cc, refund: refund, source: 'dashboard' }).eq('id', al.service_id);
        if (ue) return J({ error: ue.message }, 400);
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '✅ تمت الموافقة — أُلغي الحجز (رسوم ' + cc + ' · مرتجع ' + refund + ')', resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'cancel_approved', severity: 'info', staff_name: p.by || null, action: 'resolve_cancel', detail: 'إلغاء خدمة ' + al.service_id + ' رسوم ' + cc, ok: true });
      } else {
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '❌ رُفض طلب الإلغاء — الحجز يبقى نشطاً', resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'cancel_rejected', severity: 'info', staff_name: p.by || null, action: 'resolve_cancel', detail: 'رفض إلغاء خدمة ' + al.service_id, ok: true });
      }
      return J({ ok: true, decision });
    }
    // إلغاء مباشر (المالكة فقط — بلا موافقة) — يطبّق نفس منطق resolve_cancel فوراً
    if (action === 'cancel_booking_direct') {
      const callerIsOwner = (key === ACCESS_KEY) || (sess && !!sess.is_owner);
      if (!callerIsOwner) return J({ error: 'الإلغاء المباشر للمالكة فقط' }, 403);
      const sid = p.service_id; if (!sid) return J({ error: 'no service_id' }, 400);
      const cc = Number(p.cancel_charge || 0); if (isNaN(cc) || cc < 0) return J({ error: 'قيمة رسوم الإلغاء غير صحيحة' }, 400);
      const { data: sl } = await supabase.from('acc_service_lines').select('final_rate_booked').eq('id', sid).single();
      const finalv = Number(sl?.final_rate_booked || 0);
      if (finalv > 0 && cc > finalv + 0.005) return J({ error: 'رسوم الإلغاء لا يمكن أن تتجاوز قيمة الحجز الفعلي (' + finalv + ')' }, 400);
      const refund = Math.max(0, finalv - cc);
      const { error: ue } = await supabase.from('acc_service_lines').update({ status: 'Cancel', cancel_charge: cc, refund: refund, source: 'dashboard' }).eq('id', sid);
      if (ue) return J({ error: ue.message }, 400);
      await audit({ event_type: 'cancel_direct', severity: 'info', staff_name: p.by || null, action: 'cancel_booking_direct', detail: 'إلغاء مباشر خدمة ' + sid + ' رسوم ' + cc, ok: true });
      return J({ ok: true, cancelled: sid, refund: refund });
    }
    if (action === 'request_reactivate') {
      const sid = p.service_id; if (!sid) return J({ error: 'no service_id' }, 400);
      const reason = String(p.reason || '').trim();
      const { data: ex } = await supabase.from('acc_alerts').select('id').eq('type', 'reactivate_request').eq('service_id', sid).eq('status', 'pending').limit(1);
      if (ex && ex.length) return J({ ok: true, requested: true, dup: true });
      const { error } = await supabase.from('acc_alerts').insert({ type: 'reactivate_request', client_code: p.client_code || null, service_id: sid, service_name: p.service_name || null, message: 'طلب إعادة تفعيل حجز «' + (p.service_name || '') + '» (إلغاء الإلغاء)' + (reason ? ' · السبب: ' + reason : '') + ' · مقدّم الطلب: ' + (p.by || '—'), status: 'pending' });
      if (error) return J({ error: error.message }, 400);
      await audit({ event_type: 'reactivate_request', severity: 'info', staff_name: p.by || null, action: 'request_reactivate', detail: 'طلب تفعيل خدمة ' + sid, ok: true });
      return J({ ok: true, requested: true });
    }
    if (action === 'resolve_reactivate') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: al, error: e0 } = await supabase.from('acc_alerts').select('*').eq('id', p.id).single();
      if (e0 || !al) return J({ error: 'الطلب غير موجود' }, 400);
      if (al.type !== 'reactivate_request') return J({ error: 'نوع غير صحيح' }, 400);
      if (al.status !== 'pending') return J({ error: 'الطلب معالَج مسبقاً' }, 400);
      if (decision === 'approve') {
        const { error: ue } = await supabase.from('acc_service_lines').update({ status: 'Active', cancel_charge: 0, refund: 0, source: 'dashboard' }).eq('id', al.service_id);
        if (ue) return J({ error: ue.message }, 400);
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '✅ تمت الموافقة — أُعيد تفعيل الحجز كاملاً', resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'reactivate_approved', severity: 'info', staff_name: p.by || null, action: 'resolve_reactivate', detail: 'تفعيل خدمة ' + al.service_id, ok: true });
      } else {
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: '❌ رُفض الطلب — الحجز يبقى ملغى', resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'reactivate_rejected', severity: 'info', staff_name: p.by || null, action: 'resolve_reactivate', detail: 'رفض تفعيل خدمة ' + al.service_id, ok: true });
      }
      return J({ ok: true, decision });
    }
    if (action === 'request_delete_client') {
      const code = String(p.client_code || '').trim();
      if (!code) return J({ error: 'no client_code' }, 400);
      const { count: sfCount } = await supabase.from('acc_sales_form').select('id', { count: 'exact', head: true }).eq('client_code', code);
      if ((sfCount || 0) > 0) return J({ blocked: true, reason: 'لا يمكن الحذف — للعميل «' + code + '» معلومات مُدخَلة في Sales Form (الحسابات).' });
      const { data: cr } = await supabase.from('acc_first_client_data').select('client_name').eq('client_code', code).limit(1).maybeSingle();
      const cname = (cr && cr.client_name) || p.client_name || '';
      const { data: ex } = await supabase.from('acc_alerts').select('id').eq('type', 'delete_request').eq('client_code', code).eq('status', 'pending').limit(1);
      if (ex && ex.length) return J({ ok: true, requested: true, dup: true });
      const { error } = await supabase.from('acc_alerts').insert({ type: 'delete_request', client_code: code, service_name: cname, message: 'طلب حذف العميل «' + code + '»' + (cname ? ' (' + cname + ')' : '') + ' — لا يملك بيانات في Sales Form · مقدّم الطلب: ' + (p.by || '—'), status: 'pending' });
      if (error) return J({ error: error.message }, 400);
      await audit({ event_type: 'delete_request', severity: 'info', staff_name: p.by || null, action: 'request_delete_client', detail: 'طلب حذف العميل ' + code, ok: true });
      return J({ ok: true, requested: true });
    }
    if (action === 'resolve_delete_request') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const decision = p.decision === 'approve' ? 'approve' : 'reject';
      const { data: al, error: e0 } = await supabase.from('acc_alerts').select('*').eq('id', p.id).single();
      if (e0 || !al) return J({ error: 'الطلب غير موجود' }, 400);
      if (al.type !== 'delete_request') return J({ error: 'نوع غير صحيح' }, 400);
      if (al.status !== 'pending') return J({ error: 'الطلب معالَج مسبقاً' }, 400);
      const code = String(al.client_code || '').trim();
      let deleted = 0;
      if (decision === 'approve') {
        const { count: sfCount } = await supabase.from('acc_sales_form').select('id', { count: 'exact', head: true }).eq('client_code', code);
        if ((sfCount || 0) > 0) return J({ error: 'تعذّر الحذف — صار للعميل بيانات في Sales Form.' }, 400);
        const { data: del, error: de } = await supabase.from('acc_first_client_data').delete().eq('client_code', code).select('id');
        if (de) return J({ error: de.message }, 400);
        deleted = (del || []).length;
        await supabase.from('acc_deleted_clients').upsert({ client_code: code, client_name: al.service_name || null, deleted_by: p.by || null, reason: 'حذف عميل باعتماد الإدارة', deleted_at: new Date().toISOString() }, { onConflict: 'client_code' });
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: 'تمت الموافقة — حُذف العميل (' + deleted + ' صف)', resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'delete_approved', severity: 'info', staff_name: p.by || null, action: 'resolve_delete_request', detail: 'حذف العميل ' + code + ' (' + deleted + ' صف)', ok: true });
      } else {
        await supabase.from('acc_alerts').update({ status: 'resolved', resolution: 'رُفض الطلب — لم يُحذف العميل', resolved_at: new Date().toISOString() }).eq('id', p.id);
        await audit({ event_type: 'delete_rejected', severity: 'info', staff_name: p.by || null, action: 'resolve_delete_request', detail: 'رفض حذف العميل ' + code, ok: true });
      }
      return J({ ok: true, decision: decision, deleted: deleted });
    }
    if (action === 'set_staff_access') {
      if (!((key === ACCESS_KEY) || (sess && sess.is_owner))) return J({ error: 'إدارة موظفي النظام وصلاحياتهم للمالكة فقط' }, 403);
      const name = String(p.staff_name || '').trim();
      if (!name) return J({ error: 'الاسم مطلوب' }, 400);
      const rec: any = { staff_name: name, is_owner: !!p.is_owner, allowed_tabs: Array.isArray(p.allowed_tabs) ? p.allowed_tabs : [], active: p.active === false ? false : true };
      if (p.pin != null && String(p.pin).trim() !== '') rec.pin = String(p.pin).trim();
      if (p.role != null) rec.role = String(p.role).trim() || null;
      const { data: ex } = await supabase.from('acc_staff_access').select('id').eq('staff_name', name).maybeSingle();
      if (ex) { const { error } = await supabase.from('acc_staff_access').update(rec).eq('staff_name', name); if (error) return J({ error: error.message }, 400); }
      else { const { error } = await supabase.from('acc_staff_access').insert(rec); if (error) return J({ error: error.message }, 400); }
      return J({ ok: true });
    }
    if (action === 'delete_staff_access') {
      if (!((key === ACCESS_KEY) || (sess && sess.is_owner))) return J({ error: 'حذف موظفي النظام للمالكة فقط' }, 403);
      if (!p.id && !p.staff_name) return J({ error: 'id or staff_name required' }, 400);
      const qd = supabase.from('acc_staff_access').delete();
      const { error } = p.id ? await qd.eq('id', p.id) : await qd.eq('staff_name', String(p.staff_name));
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'add_client_entry') {
      if (!callerBankRef && p.bank_ref) { p.bank_ref = null; }   // 🏦 غير المحاسب/المالكة: يُجرَّد المرجع البنكي (لا يُدخله)
      if (p.client_code) p.client_code = String(p.client_code).trim().toUpperCase();   // 🔒 توحيد كود العميل لحروف كبيرة دائماً (يمنع فصل c26507 عن C26507 في المستحقات)
      const { data, error } = await supabase.rpc('acc_add_client_entry', { p_is_new_client: !!p.is_new_client, p_client_code: p.client_code || null, p_booking_date: p.booking_date || new Date().toISOString().slice(0, 10), p_arrival_date: p.arrival_date || null, p_client_name: p.client_name || null, p_phone: p.phone || null, p_agent_name: p.agent_name || null, p_travel_from: p.travel_from || null, p_travel_to: p.travel_to || null, p_cost: p.cost ?? 0, p_profit: p.profit ?? 0, p_amount_paid: p.amount_paid ?? 0, p_currency: p.currency || 'SAR', p_package_type: p.package_type || null, p_confirmed_by: p.confirmed_by || null, p_bank_name: p.bank_name || null, p_bank_ref: p.bank_ref || null, p_note: p.note || null, p_client_email: p.client_email || null });
      if (error) return J({ error: error.message }, 400);
      if (data?.id) { const upd: any = { source: 'dashboard' }; if (p.payment_date) upd.payment_date = p.payment_date; if (p.pax != null && p.pax !== '') upd.pax = Number(p.pax); if (p.created_by) upd.created_by = String(p.created_by).slice(0, 80); await supabase.from('acc_first_client_data').update(upd).eq('id', data.id); if (p.payment_date) data.payment_date = p.payment_date; if (p.pax != null && p.pax !== '') data.pax = Number(p.pax); if (p.created_by) data.created_by = upd.created_by; }
      return J({ ok: true, row: data });
    }
    if (action === 'delete_client_entry') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'حذف بيانات العميل للمالكة فقط — اطلبي من المالكة' }, 403);   // 🔒 حذف إدخال محفوظ = المالكة فقط
      if (!p.id) return J({ error: 'no id' }, 400);
      const { data: row, error: e0 } = await supabase.from('acc_first_client_data').select('id,source,payment_code,client_code').eq('id', p.id).single();
      if (e0 || !row) return J({ error: 'السطر غير موجود' }, 400);
      if (row.source !== 'dashboard') return J({ error: 'يُسمح بحذف المُدخَل من الداشبورد فقط' }, 400);
      const { error } = await supabase.from('acc_first_client_data').delete().eq('id', p.id).eq('source', 'dashboard');
      if (error) return J({ error: error.message }, 400);
      await audit({ event_type: 'data_delete', severity: 'info', staff_name: p.by || null, action: 'delete_client_entry', detail: 'حذف سطر ' + (row.payment_code || row.client_code || p.id), ok: true });
      return J({ ok: true, deleted: row.payment_code });
    }
    if (action === 'update_client_entry') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const { data: row, error: e0 } = await supabase.from('acc_first_client_data').select('*').eq('id', p.id).single();
      if (e0 || !row) return J({ error: 'السطر غير موجود' }, 400);
      if (row.source !== 'dashboard') return J({ error: 'يُسمح بتعديل المُدخَل من الداشبورد فقط' }, 400);
      const cost = p.cost != null ? Number(p.cost) : Number(row.cost || 0);
      const profit = p.profit != null ? Number(p.profit) : Number(row.profit || 0);
      const paid = p.amount_paid != null ? Number(p.amount_paid) : Number(row.amount_paid || 0);
      const rate = cost + profit;
      const upd: any = { cost, profit, package_rate: rate, amount_paid: paid, balance: rate - paid };
      if ('bank_name' in p) upd.bank_name = p.bank_name || null;
      if (('bank_ref' in p) && callerBankRef) upd.bank_ref = p.bank_ref || null;   // 🏦 المرجع البنكي: المحاسب/المالكة فقط
      if ('payment_date' in p) upd.payment_date = p.payment_date || null;
      if ('note' in p) upd.note = p.note || null;
      if ('pax' in p) upd.pax = (p.pax === '' || p.pax == null) ? null : Number(p.pax);
      // 🔒 تصحيح كود العميل / مرجع الدفعة — للمالكة فقط (لدمج صفوف انفصلت بخطأ حالة الأحرف مثل c26507↔C26507)
      const _isOwner = (key === ACCESS_KEY) || (sess && !!sess.is_owner);
      if (_isOwner && 'client_code' in p && p.client_code) upd.client_code = String(p.client_code).trim().toUpperCase();
      if (_isOwner && 'payment_code' in p && p.payment_code) upd.payment_code = String(p.payment_code).trim();
      const { error } = await supabase.from('acc_first_client_data').update(upd).eq('id', p.id).eq('source', 'dashboard');
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true });
    }
    if (action === 'set_client_due') { if (!p.client_code) return J({ error: 'no client_code' }, 400);
      const _own = (key === ACCESS_KEY) || (sess && !!sess.is_owner);
      if (!_own) {   // 🔒 غير المالكة: تغيير تاريخ استحقاق موجود يُرسَل طلب موافقة؛ التعبئة لخانة فارغة مباشرة
        const { data: curd } = await supabase.from('acc_client_due').select('due_date').eq('client_code', p.client_code).maybeSingle();
        const had = curd && curd.due_date != null && String(curd.due_date).trim() !== '';
        const nd = p.due_date ? String(p.due_date).slice(0, 10) : '';
        if (had && nd && nd !== String(curd.due_date).slice(0, 10)) {
          await supabase.from('acc_pending_movements').insert({ kind: 'client_edit', scope: 'fcd', status: 'pending', summary: '📅 طلب تغيير تاريخ الاستحقاق — «' + p.client_code + '»', note: 'تغيير تاريخ استحقاق محفوظ (يحتاج موافقتك) · مقدّم الطلب: ' + (p.by || '—'), payload: { _due_only: true, client_code: p.client_code, due_date: p.due_date || null, alarm_date: p.alarm_date || null, note: p.note || null, by: p.by || null } });
          return J({ ok: true, pending: true, msg: 'أُرسل طلب تغيير تاريخ الاستحقاق لموافقة المالكة — لن يتغيّر حتى الاعتماد' });
        }
      }
      const { error } = await supabase.from('acc_client_due').upsert({ client_code: p.client_code, due_date: p.due_date || null, alarm_date: p.alarm_date || null, note: p.note || null, updated_at: new Date().toISOString() }, { onConflict: 'client_code' }); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'add_refund') { if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تسجيل المرتجع للمالكة فقط — يُرسَل كطلب موافقة' }, 403); if (!p.client_code) return J({ error: 'no client_code' }, 400); if (!p.bank_name) return J({ error: 'لازم تحديد البنك' }, 400); if (!callerBankRef && p.bank_ref) { p.bank_ref = null; }   /* 🏦 المرجع البنكي للمحاسب/المالكة فقط */ const { data, error } = await supabase.from('acc_refunds').insert({ client_code: p.client_code, client_name: p.client_name || null, refund: p.refund ?? 0, payment_date: p.payment_date || _today, bank_name: p.bank_name || null, bank_ref: p.bank_ref || null, note: p.note || null, source: 'dashboard' }).select().single(); if (error) return J({ error: error.message }, 400); return J({ ok: true, row: data }); }
    if (action === 'update_refund') { const callerIsOwner = (key === ACCESS_KEY) || (sess && !!sess.is_owner); if (!callerIsOwner) return J({ error: 'تعديل المرتجع المباشر للمالكة فقط' }, 403); if (!p.id) return J({ error: 'no id' }, 400); const upd: any = {}; if ('bank_ref' in p) upd.bank_ref = (p.bank_ref === '' ? null : p.bank_ref); if ('bank_name' in p) upd.bank_name = (p.bank_name === '' ? null : p.bank_name); if ('note' in p) upd.note = (p.note === '' ? null : p.note); if ('refund' in p) upd.refund = p.refund; if ('payment_date' in p) upd.payment_date = (p.payment_date === '' ? null : p.payment_date); const { error } = await supabase.from('acc_refunds').update(upd).eq('id', p.id).eq('source', 'dashboard'); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'dismiss_alert') { if (!((key === ACCESS_KEY) || (sess && sess.is_owner))) return J({ error: 'إخفاء الإشعارات للمالكة فقط' }, 403); if (!p.alert_key) return J({ error: 'no alert_key' }, 400); const { error } = await supabase.from('acc_dismissed_alerts').upsert({ alert_key: String(p.alert_key), alert_group: p.alert_group || null, client_code: p.client_code || null, note: p.note || null, dismissed_by: p.by || null, dismissed_at: new Date().toISOString() }, { onConflict: 'alert_key' }); if (error) return J({ error: error.message }, 400); try { await audit({ event_type: 'dismiss_alert', severity: 'info', staff_name: p.by || 'المالكة', detail: 'إخفاء إشعار ' + p.alert_key, ok: true }); } catch (_) {} return J({ ok: true }); }
    if (action === 'undismiss_alert') { if (!((key === ACCESS_KEY) || (sess && sess.is_owner))) return J({ error: 'استرجاع الإشعارات للمالكة فقط' }, 403); if (!p.alert_key) return J({ error: 'no alert_key' }, 400); const { error } = await supabase.from('acc_dismissed_alerts').delete().eq('alert_key', String(p.alert_key)); if (error) return J({ error: error.message }, 400); try { await audit({ event_type: 'undismiss_alert', severity: 'info', staff_name: p.by || 'المالكة', detail: 'استرجاع إشعار ' + p.alert_key, ok: true }); } catch (_) {} return J({ ok: true }); }
    if (action === 'add_supplier_payment') { if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تسجيل دفعة المورّد للمالكة فقط — يُرسَل كطلب موافقة' }, 403); if (!p.supplier_name) return J({ error: 'no supplier' }, 400); if (!p.bank_name) return J({ error: 'لازم تحديد البنك' }, 400); const _hand = /سُلّم للمورّد|تسليم مباشر|🤝/.test(String(p.bank_name || '')); if (!_hand && !String(p.bank_ref || '').trim()) return J({ error: 'المرجع البنكي إلزامي لتسجيل دفعة المورّد (قرار المالكة — لا دفعة بلا مرجع)' }, 400); const { data, error } = await supabase.from('acc_supplier_payments').insert({ supplier_name: p.supplier_name, client_code: p.client_code || null, client_name: p.client_name || null, amount: p.amount ?? 0, currency: p.currency || 'SAR', payment_date: p.payment_date || _today, bank_name: p.bank_name || null, bank_ref: p.bank_ref || null, note: p.note || null }).select().single(); if (error) return J({ error: error.message }, 400); return J({ ok: true, row: data }); }
    if (action === 'delete_supplier_payment') { if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'حذف دفعة المورّد للمالكة فقط' }, 403); if (!p.id) return J({ error: 'no id' }, 400); const { error } = await supabase.from('acc_supplier_payments').delete().eq('id', p.id); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    // ↩️ تراجع عن الملء التلقائي للفواتير (يعيد actual_invoice لقيمته السابقة من النسخة الاحتياطية ثم يحذف الدفعة) — المالكة فقط
    if (action === 'undo_autofill_invoices') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'التراجع للمالكة فقط' }, 403);
      const label = String(p.batch_label || '').trim(); if (!label) return J({ error: 'no batch_label' }, 400);
      const { data: recs, error: e0 } = await supabase.from('acc_autofill_invoices').select('service_id,old_value,target_table').eq('batch_label', label);
      if (e0) return J({ error: e0.message }, 400);
      let n = 0;
      for (const r of (recs || [])) { const tbl = (r.target_table === 'supplier_invoices') ? 'acc_supplier_invoices' : 'acc_service_lines'; const { error } = await supabase.from(tbl).update({ actual_invoice: (r.old_value == null || String(r.old_value).trim() === '') ? null : Number(r.old_value) }).eq('id', r.service_id); if (!error) n++; }
      await supabase.from('acc_autofill_invoices').delete().eq('batch_label', label);
      try { await audit({ event_type: 'undo_autofill', severity: 'info', staff_name: p.by || 'المالكة', action: 'undo_autofill_invoices', detail: 'تراجع عن ملء تلقائي للفواتير — دفعة ' + label + ' (' + n + ' صف)', ok: true }); } catch (_) {}
      return J({ ok: true, reverted: n });
    }
    // 📌 توزيع/إعادة ربط دفعة مورّد بالعميل/العملاء — لا يضيف/ينقص مبلغاً (المجموع = مجموع الدفعات الأصلية) — للمالكة فقط
    // يقبل id مفرد أو pay_ids (تحويل مجمّع بعدة دفعات) — يحذف الأصل ويعيد الإدراج موزّعاً بنفس البنك/المرجع/التاريخ/العملة
    if (action === 'allocate_supplier_payment') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'توزيع دفعة المورّد للمالكة فقط' }, 403);
      const ids = Array.isArray(p.pay_ids) ? p.pay_ids.map((x: any) => Number(x)).filter((x: number) => !isNaN(x)) : (p.id != null ? [Number(p.id)] : []);
      if (!ids.length) return J({ error: 'no id' }, 400);
      const lines = Array.isArray(p.lines) ? p.lines.filter((l: any) => l && l.client_code && Number(l.amount) > 0) : [];
      if (!lines.length) return J({ error: 'حدّدي عميلاً واحداً على الأقل بمبلغ' }, 400);
      const { data: sps, error: e0 } = await supabase.from('acc_supplier_payments').select('*').in('id', ids);
      if (e0 || !sps || !sps.length) return J({ error: 'الدفعة غير موجودة' }, 400);
      const base = sps[0];   // المرجع الأساسي للبنك/المرجع/التاريخ/العملة (التحويل المجمّع يشترك فيها)
      const _pdate = base.payment_date || _today;   // 📅 لا دفعة موزّعة بلا تاريخ — لو الأصل بلا تاريخ نستخدم اليوم
      const orig = sps.reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const sum = lines.reduce((s: number, l: any) => s + Number(l.amount || 0), 0);
      // ✅ توزيع جزئي مسموح: المجموع لا يتجاوز مبلغ الدفعة؛ المتبقّي يبقى سطراً «غير موزّعاً» (رصيد مقدّم) — يُمنع فقط تجاوز المبلغ (لا توزيع أكثر من المدفوع)
      if (sum > orig + 0.5) return J({ error: 'مجموع التوزيع (' + sum + ') أكبر من مبلغ الدفعة (' + orig + ') — لا يمكن توزيع أكثر من المدفوع' }, 400);
      // 🆕 FIP: لا حذف ولا تجزئة — الدفعة تبقى خام. التوزيع يُكتب في جدول التخصيص المنفصل acc_payment_allocations.
      void _pdate;
      // 1) الدفعة الأساسية تصبح «مجمّعة» (client_code=null) — الإسناد للعملاء عبر جدول التخصيص لا بتجزئة الدفعة
      const { error: ue } = await supabase.from('acc_supplier_payments').update({ client_code: null, client_name: null }).in('id', ids);
      if (ue) return J({ error: ue.message }, 400);
      // 2) امسح تخصيصات هذه الدفعة السابقة (إعادة توزيع نظيفة)
      await supabase.from('acc_payment_allocations').delete().eq('payment_id', base.id);
      // 3) اكتب التخصيصات الجديدة (رابط الدفعة الخام بالعملاء) — الباقي غير الموزّع = مبلغ الدفعة − مجموع التخصيصات (يُحسب في الواجهة)
      const allocRows = lines.map((l: any) => ({ payment_id: base.id, client_code: String(l.client_code).trim().toUpperCase(), client_name: l.client_name || null, amount: Number(l.amount), service: ((l.svc && String(l.svc).trim()) ? String(l.svc).trim() : null), currency: base.currency, currency_rate: ((l.currency_rate != null && l.currency_rate !== '') ? Number(l.currency_rate) : base.currency_rate), created_by: p.by || 'المالكة' }));
      const { data: ins, error: ie } = await supabase.from('acc_payment_allocations').insert(allocRows).select();
      if (ie) return J({ error: ie.message }, 400);
      try { await audit({ event_type: 'reallocate', severity: 'info', staff_name: p.by || 'المالكة', action: 'allocate_supplier_payment', detail: 'توزيع دفعة «' + base.supplier_name + '» ' + orig + ' ' + (base.currency || '') + ' على ' + lines.length + ' عميل', ok: true }); } catch (_) {}
      return J({ ok: true, rows: ins });
    }
    // 🔵 إلغاء تخصيص دفعة مورّد — تُصبح «غير موزّعة» (client_code=null) حتى تُوزَّع لاحقاً. للمالكة فقط. لا يمسّ المبلغ/البنك/المرجع.
    if (action === 'unallocate_supplier_payment') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'إلغاء تخصيص الدفعة للمالكة فقط' }, 403);
      const ids = Array.isArray(p.pay_ids) ? p.pay_ids.map((x: any) => Number(x)).filter((x: number) => !isNaN(x)) : (p.id != null ? [Number(p.id)] : []);
      if (!ids.length) return J({ error: 'no id' }, 400);
      const { data, error } = await supabase.from('acc_supplier_payments').update({ client_code: null, client_name: null }).in('id', ids).select('id');
      if (error) return J({ error: error.message }, 400);
      return J({ ok: true, n: (data || []).length });
    }
    if (action === 'delete_payment_cascade') {
      if (!p.id) return J({ error: 'no id' }, 400);
      const reason = String(p.reason || '').trim();
      if (!reason) return J({ error: 'سبب الحذف إجباري' }, 400);
      const { data: sp, error: e0 } = await supabase.from('acc_supplier_payments').select('*').eq('id', p.id).single();
      if (e0 || !sp) return J({ error: 'الدفعة غير موجودة' }, 400);
      const ref = String(sp.bank_ref || '').trim(); const sup = sp.supplier_name || '';
      let delSp = 0, delBtx = 0;
      if (ref) {
        const { data: d1, error: se } = await supabase.from('acc_supplier_payments').delete().eq('bank_ref', ref).eq('supplier_name', sup).select('id');
        if (se) return J({ error: se.message }, 400); delSp = (d1 || []).length;
        const { data: d2, error: be } = await supabase.from('acc_bank_txn').delete().eq('bank_ref', ref).eq('source', 'dashboard').select('id');
        if (be) return J({ error: be.message }, 400); delBtx = (d2 || []).length;
      } else {
        const { error: se } = await supabase.from('acc_supplier_payments').delete().eq('id', p.id);
        if (se) return J({ error: se.message }, 400); delSp = 1;
      }
      await supabase.from('acc_pending_movements').insert({ kind: 'delete', scope: 'hotels', status: 'deleted', summary: 'حذف دفعة «' + sup + '»' + (ref ? ' · مرجع ' + ref : '') + ' (' + delSp + ' دفعة + ' + delBtx + ' حركة بنكية)', note: reason, payload: { bank_ref: ref, supplier_name: sup, deleted_supplier_payments: delSp, deleted_bank_txn: delBtx }, decided_at: new Date().toISOString() });
      return J({ ok: true, deleted_supplier_payments: delSp, deleted_bank_txn: delBtx });
    }
    if (action === 'add_bank_txn') { if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تسجيل حركة بنكية للمالكة فقط — يُرسَل كطلب موافقة' }, 403); if (!p.bank_name) return J({ error: 'لازم تحديد البنك' }, 400); const { data, error } = await supabase.from('acc_bank_txn').insert({ tx_date: p.tx_date || null, amount_out: p.amount_out ?? 0, amount_in: p.amount_in ?? 0, bank_name: p.bank_name || null, bank_ref: p.bank_ref || null, client_code: p.client_code || null, note: p.note || null, source: 'dashboard' }).select().single(); if (error) return J({ error: error.message }, 400); return J({ ok: true, row: data }); }
    if (action === 'delete_bank_txn') { if (!p.id) return J({ error: 'no id' }, 400); let q = supabase.from('acc_bank_txn').delete().eq('id', p.id); if (!(p.allow_sheet && ((key === ACCESS_KEY) || (sess && !!sess.is_owner)))) q = q.eq('source','dashboard'); /* 🔓 حذف الشيت للمالكة فقط عند allow_sheet */ const { error } = await q; if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    // 🏷️ تعديل تصنيف (ملاحظة) حركة بنكية بمعرّفها — للمالكة فقط. يُستخدم لتصنيف العمليات السابقة (القناة←الوصف←التفاصيل←الفرعي).
    if (action === 'update_bank_txn_note') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تعديل التصنيف للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      let q = supabase.from('acc_bank_txn').update({ note: (p.note === '' || p.note == null) ? null : String(p.note) }).eq('id', p.id);
      if (!(p.allow_sheet)) q = q.eq('source', 'dashboard');   // 🔓 الشيت للمالكة عند allow_sheet
      const { data, error } = await q.select('id').maybeSingle();
      if (error) return J({ error: error.message }, 400);
      if (!data) return J({ error: 'الحركة غير موجودة' }, 400);
      return J({ ok: true });
    }
    // 🗓️ تصحيح تاريخ حركة بنكية بمعرّفها (التاريخ فقط) — للمالكة فقط. يُستخدم لتصحيح تواريخ انقلبت من الشيت (يوم↔شهر) بلا مساس بأي حقل آخر.
    if (action === 'update_bank_txn_date') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تعديل الحركة البنكية للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const nd = String(p.tx_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nd)) return J({ error: 'تاريخ غير صالح (YYYY-MM-DD)' }, 400);
      const { data, error } = await supabase.from('acc_bank_txn').update({ tx_date: nd }).eq('id', p.id).select('id,tx_date').maybeSingle();
      if (error) return J({ error: error.message }, 400);
      if (!data) return J({ error: 'الحركة غير موجودة' }, 400);
      return J({ ok: true, row: data });
    }
    // 💵 تصحيح مبلغ حركة بنكية بمعرّفها — للمالكة فقط. يُستخدم لمطابقة قيمة الكشف عند فرق تقريب/رسوم SWIFT (بلا مساس بأي حقل آخر).
    if (action === 'update_bank_txn_amount') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تعديل مبلغ الحركة البنكية للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const ao = (p.amount_out === '' || p.amount_out == null) ? 0 : Number(p.amount_out);
      const ai = (p.amount_in === '' || p.amount_in == null) ? 0 : Number(p.amount_in);
      if (!isFinite(ao) || !isFinite(ai) || ao < 0 || ai < 0) return J({ error: 'مبلغ غير صالح' }, 400);
      if (ao <= 0.005 && ai <= 0.005) return J({ error: 'لازم مبلغ داخل أو خارج' }, 400);
      const { data, error } = await supabase.from('acc_bank_txn').update({ amount_out: ao, amount_in: ai }).eq('id', p.id).select('id,amount_out,amount_in').maybeSingle();
      if (error) return J({ error: error.message }, 400);
      if (!data) return J({ error: 'الحركة غير موجودة' }, 400);
      return J({ ok: true, row: data });
    }
    // 🏦 تصحيح البنك المسجّلة عليه حركة بنكية بمعرّفها — للمالكة فقط. يُستخدم عند تسجيل دفعة على بنك خطأ (مثل دفعة بطاقة سُجّلت على بنك آخر) لتظهر في مطابقة البنك الصحيح.
    if (action === 'update_bank_txn_bank') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تعديل بنك الحركة للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const nb = String(p.bank_name || '').trim();
      if (!nb) return J({ error: 'لازم تحديد البنك' }, 400);
      const { data, error } = await supabase.from('acc_bank_txn').update({ bank_name: nb }).eq('id', p.id).select('id,bank_name').maybeSingle();
      if (error) return J({ error: error.message }, 400);
      if (!data) return J({ error: 'الحركة غير موجودة' }, 400);
      return J({ ok: true, row: data });
    }
    // 💵 تصحيح مبلغ حركة كاش بنكي بمعرّفها — للمالكة فقط (نفس الغرض). يحدّث الخام ويعيد حساب المكافئ بالعملة إن وُجد سعر.
    if (action === 'update_bank_cash_amount') {
      if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'تعديل مبلغ الكاش للمالكة فقط' }, 403);
      if (!p.id) return J({ error: 'no id' }, 400);
      const inRaw = (p.in_raw === '' || p.in_raw == null) ? null : Number(p.in_raw);
      const outRaw = (p.out_raw === '' || p.out_raw == null) ? null : Number(p.out_raw);
      if ((inRaw == null || inRaw <= 0.005) && (outRaw == null || outRaw <= 0.005)) return J({ error: 'لازم مبلغ داخل أو خارج' }, 400);
      const upd: any = { in_raw: inRaw, out_raw: outRaw };
      const rate = (p.currency_rate === '' || p.currency_rate == null) ? null : Number(p.currency_rate);
      if (rate != null && isFinite(rate)) { upd.in_sar = inRaw != null ? inRaw * rate : null; upd.out_sar = outRaw != null ? outRaw * rate : null; }
      const { data, error } = await supabase.from('acc_banks_cash').update(upd).eq('id', p.id).select('id,in_raw,out_raw').maybeSingle();
      if (error) return J({ error: error.message }, 400);
      if (!data) return J({ error: 'الحركة غير موجودة' }, 400);
      return J({ ok: true, row: data });
    }
    if (action === 'add_bank_cash') { if (!p.bank_name) return J({ error: 'لازم تحديد البنك' }, 400); if (!callerBankRef && p.bank_ref) { p.bank_ref = null; }   /* 🏦 المرجع البنكي: المحاسب/المالكة فقط — يُجرَّد لغيرهم */ const inRaw = p.in_raw === '' || p.in_raw == null ? null : Number(p.in_raw); const outRaw = p.out_raw === '' || p.out_raw == null ? null : Number(p.out_raw); const rate = p.currency_rate === '' || p.currency_rate == null ? null : Number(p.currency_rate); let inSar = p.in_sar === '' || p.in_sar == null ? null : Number(p.in_sar); let outSar = p.out_sar === '' || p.out_sar == null ? null : Number(p.out_sar); if (inSar == null && inRaw != null && rate != null) inSar = inRaw * rate; if (outSar == null && outRaw != null && rate != null) outSar = outRaw * rate; const { data, error } = await supabase.from('acc_banks_cash').insert({ tx_date: p.tx_date || null, in_raw: inRaw, out_raw: outRaw, bank_name: p.bank_name, bank_ref: p.bank_ref || null, description: p.description || null, details: p.details || null, more_details: p.more_details || null, note: p.note || null, currency: p.currency || null, currency_rate: rate, in_sar: inSar, out_sar: outSar, source: 'dashboard' }).select().single(); if (error) return J({ error: error.message }, 400); return J({ ok: true, row: data }); }
    if (action === 'delete_bank_cash') { if (!p.id) return J({ error: 'no id' }, 400); let q = supabase.from('acc_banks_cash').delete().eq('id', p.id); if (!(p.allow_sheet && ((key === ACCESS_KEY) || (sess && !!sess.is_owner)))) q = q.eq('source','dashboard'); /* 🔓 حذف الشيت للمالكة فقط عند allow_sheet */ const { error } = await q; if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'add_service_line') { if (!p.client_code) return J({ error: 'no client_code' }, 400); const rec: any = { client_code: p.client_code, source: 'dashboard' }; for (const f of SVC_FIELDS) if (f in p) rec[f] = p[f] === '' ? null : p[f]; if ('amount' in p) rec.raw_value = p.amount; const { data, error } = await supabase.from('acc_service_lines').insert(rec).select().single(); if (error) return J({ error: error.message }, 400); await supabase.from('acc_service_lines').update({ source: 'dashboard' }).eq('client_code', p.client_code); return J({ ok: true, row: data }); }
    if (action === 'update_service_line') { if (!p.id) return J({ error: 'no id' }, 400); const rec: any = { source: 'dashboard' }; for (const f of SVC_FIELDS) if (f in p) rec[f] = p[f] === '' ? null : p[f]; if ('amount' in p) rec.raw_value = p.amount; const { error } = await supabase.from('acc_service_lines').update(rec).eq('id', p.id); if (error) return J({ error: error.message }, 400); if (p.client_code) await supabase.from('acc_service_lines').update({ source: 'dashboard' }).eq('client_code', p.client_code); return J({ ok: true }); }
    if (action === 'delete_service_line') { if (!p.id) return J({ error: 'no id' }, 400); if (p.client_code) await supabase.from('acc_service_lines').update({ source: 'dashboard' }).eq('client_code', p.client_code); const { error } = await supabase.from('acc_service_lines').delete().eq('id', p.id); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'add_settlement') {
      // 🧹 تسوية/شطب مستحق صغير — حصراً للمالكة
      const callerIsOwner = (key === ACCESS_KEY) || (sess && !!sess.is_owner);
      if (!callerIsOwner) return J({ error: 'التسوية متاحة للمالكة فقط' }, 403);
      if (!p.client_code || p.amount == null) return J({ error: 'client_code/amount required' }, 400);
      const { error } = await supabase.from('acc_settlements').insert({ client_code: String(p.client_code).trim().toUpperCase(), amount: Number(p.amount), currency: p.currency || null, reason: p.reason || 'شطب مستحق صغير', settled_by: p.by || null });
      if (error) return J({ error: error.message }, 400);
      await audit({ event_type: 'settlement', severity: 'info', staff_name: p.by || null, action: 'add_settlement', detail: '🧹 تسوية مستحق «' + p.client_code + '» بمبلغ ' + p.amount + ' ' + (p.currency || '') + ' · ' + (p.reason || 'شطب مستحق صغير'), ok: true });
      return J({ ok: true });
    }
    if (action === 'delete_settlement') { const callerIsOwner = (key === ACCESS_KEY) || (sess && !!sess.is_owner); if (!callerIsOwner) return J({ error: 'التسوية متاحة للمالكة فقط' }, 403); if (!p.id) return J({ error: 'no id' }, 400); const { error } = await supabase.from('acc_settlements').delete().eq('id', p.id); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'add_list_item') { if (!p.category || !p.value) return J({ error: 'category/value required' }, 400); const { error } = await supabase.from('acc_lists').upsert({ category: p.category, value: String(p.value).trim() }, { onConflict: 'category,value' }); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'delete_list_item') { if (p.id) { const { error } = await supabase.from('acc_lists').delete().eq('id', p.id); if (error) return J({ error: error.message }, 400); } else if (p.category && p.value) { const { error } = await supabase.from('acc_lists').delete().eq('category', p.category).eq('value', p.value); if (error) return J({ error: error.message }, 400); } else return J({ error: 'id or category/value required' }, 400); return J({ ok: true }); }
    if (action === 'add_alert') { if (p.service_id) { const { data: ex } = await supabase.from('acc_alerts').select('id').eq('service_id', p.service_id).eq('type', p.type || 'currency_mismatch').eq('status', 'pending').limit(1); if (ex && ex.length) return J({ ok: true, dup: true }); } const { error } = await supabase.from('acc_alerts').insert({ type: p.type || 'currency_mismatch', client_code: p.client_code || null, service_id: p.service_id || null, service_name: p.service_name || null, sf_currency: p.sf_currency || null, booked_currency: p.booked_currency || null, message: p.message || null, status: 'pending' }); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'resolve_alert') { if (!p.id) return J({ error: 'no id' }, 400); const { error } = await supabase.from('acc_alerts').update({ status: 'resolved', resolution: p.resolution || null, resolved_at: new Date().toISOString() }).eq('id', p.id); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'add_pending_movement') { const { data, error } = await supabase.from('acc_pending_movements').insert({ kind: p.kind || 'payment', scope: p.scope || 'hotels', status: 'pending', summary: p.summary || null, note: p.note || null, payload: p.payload || {} }).select().single(); if (error) return J({ error: error.message }, 400);
      // 🔔 تنبيه واتساب للمالكة عند طلب دفعة من موظف (غير المالكة) — يصلها فوراً بلا الحاجة لفتح الإشعارات
      try { const byName = (p.payload && p.payload.by) || ''; const isOwnerCaller = (key === ACCESS_KEY) || (sess && !!sess.is_owner); if (!isOwnerCaller) { await wa('🔔 نظام الحسابات — طلب دفعة بانتظار موافقتك\n• ' + (p.summary || 'دفعة جديدة') + (byName ? '\n• مقدّم الطلب: ' + byName : '') + '\nافتحي 🔔 الإشعارات في الداشبورد للاعتماد أو الرفض.'); } } catch (_) {}
      return J({ ok: true, row: data }); }
    if (action === 'delete_pending_movement') { if (!((key === ACCESS_KEY) || (sess && !!sess.is_owner))) return J({ error: 'رفض/حذف الطلبات للمالكة فقط' }, 403); if (!p.id) return J({ error: 'no id' }, 400); const { error } = await supabase.from('acc_pending_movements').delete().eq('id', p.id).eq('status', 'pending'); if (error) return J({ error: error.message }, 400); return J({ ok: true }); }
    if (action === 'set_movement_status') {
      const _own = (key === ACCESS_KEY) || (sess && !!sess.is_owner);
      if (!_own) return J({ error: 'اعتماد/رفض الحركات المالية للمالكة فقط' }, 403);   // 🔒 لا يعتمد الموظف طلبه بنفسه
      if (!p.id) return J({ error: 'no id' }, 400);
      const newStatus = p.status === 'approved' ? 'approved' : 'rejected';
      const { data: mv, error: e0 } = await supabase.from('acc_pending_movements').select('*').eq('id', p.id).single();
      if (e0 || !mv) return J({ error: 'movement not found' }, 400);
      if (mv.status !== 'pending') return J({ error: 'الحركة معالَجة مسبقاً' }, 400);
      let result: any = {};
      if (newStatus === 'approved') {
        const pl = mv.payload || {};
        if (mv.kind === 'list_item') {
          // اعتماد طلب تعديل قائمة (إضافة/حذف عناصر acc_lists) من المحاسب
          const ops = Array.isArray(pl.ops) ? pl.ops : [];
          for (const op of ops) {
            if (!op || !op.category || op.value == null) continue;
            if (op.do === 'add') { await supabase.from('acc_lists').upsert({ category: op.category, value: String(op.value).trim() }, { onConflict: 'category,value' }); }
            else if (op.do === 'del') { await supabase.from('acc_lists').delete().eq('category', op.category).eq('value', op.value); }
          }
          result = { list_ops: ops.length };
        } else if (mv.kind === 'delete') {
          const tid = pl.target_id; if (!tid) return J({ error: 'no target_id' }, 400);
          const { error } = await supabase.from('acc_supplier_payments').delete().eq('id', tid);
          if (error) return J({ error: error.message }, 400); result = { deleted_payment: tid };
        } else {
          const sup = pl.supplier_name || 'TBO'; const tcur = pl.tcur || 'SAR';
          const bank = pl.bank || null; const ref = pl.ref || null; const date = pl.date || _today;   // 📅 لا دفعة/توزيع بلا تاريخ — افتراضياً اليوم
          if (!bank) return J({ error: 'لازم تحديد البنك' }, 400);
          const isRefund = (pl.txn_type === 'refund'); const sign = isRefund ? -1 : 1;
          const rawLines = (Array.isArray(pl.lines) && pl.lines.length) ? pl.lines : [{ client_code: pl.client_code, client_name: pl.client_name, amount: pl.amount }];
          const valid = rawLines.filter((l: any) => Number(l.amount || 0) > 0);
          if (!valid.length) return J({ error: 'لا يوجد توزيع' }, 400);
          const gross = Number(pl.gross != null ? pl.gross : valid.reduce((s: number, l: any) => s + Number(l.amount || 0), 0));
          const bnote = (isRefund ? 'مرتجع من ' : 'دفعة ') + sup + (pl.note ? ' — ' + pl.note : '') + (ref ? ' · مرجع ' + ref : '');
          const { data: btx, error: be } = await supabase.from('acc_bank_txn').insert({ tx_date: date, amount_out: isRefund ? 0 : gross, amount_in: isRefund ? gross : 0, bank_name: bank, bank_ref: ref, client_code: valid.length === 1 ? (valid[0].client_code || null) : null, note: bnote, source: 'dashboard' }).select().single();
          if (be) return J({ error: be.message }, 400);
          const spIds: any[] = [];
          for (const l of valid) {
            const { data: spy, error: se } = await supabase.from('acc_supplier_payments').insert({ supplier_name: sup, client_code: l.client_code || null, client_name: l.client_name || null, amount: sign * Number(l.amount || 0), currency: tcur, payment_date: date, bank_name: bank, bank_ref: ref, note: (pl.note || ((isRefund ? 'مرتجع من ' : 'توزيع ') + sup + ' · مرجع ' + (ref || ''))), source: 'dashboard' }).select().single();
            if (se) return J({ error: se.message }, 400);
            spIds.push(spy?.id);
          }
          result = { bank_txn: btx?.id, supplier_payments: spIds, refund: isRefund };
        }
      }
      const { error: e1 } = await supabase.from('acc_pending_movements').update({ status: newStatus, decided_at: new Date().toISOString(), result }).eq('id', p.id);
      if (e1) return J({ error: e1.message }, 400);
      return J({ ok: true, result });
    }
    return J({ error: 'unknown action' }, 400);
  }

  try {
    const [overview, due, staff, agents, fcd, bfRows, sales, svc, hotels, refunds, lists, supInv, bankTx, alerts, supPay, pendingMv, hotelPay, logsArr] = await Promise.all([
      fetchAll(supabase, 'acc_v_overview_of_bookings', null), fetchAll(supabase, 'acc_v_client_due_payment', null), fetchAll(supabase, 'acc_v_staff_report', null), fetchAll(supabase, 'acc_v_agents_account', null),
      fetchAll(supabase, 'acc_first_client_data'), fetchAll(supabase, 'acc_booking_form'), fetchAll(supabase, 'acc_sales_form'), fetchAll(supabase, 'acc_service_lines'), fetchAll(supabase, 'acc_hotel_bookings'), fetchAll(supabase, 'acc_refunds'), fetchAll(supabase, 'acc_lists'), fetchAll(supabase, 'acc_supplier_invoices'), fetchAll(supabase, 'acc_bank_txn'), fetchAll(supabase, 'acc_alerts'), fetchAll(supabase, 'acc_supplier_payments'), fetchAll(supabase, 'acc_pending_movements'), fetchAll(supabase, 'acc_hotel_payments'),
      supabase.from('acc_sync_logs').select('*').order('ran_at', { ascending: false }).limit(1),
    ]);
    // ⚡ تحسين أداء: الجداول الثمانية كانت تُجلب بالتسلسل (يتراكم الزمن) — الآن بالتوازي (نفس البيانات تماماً)
    const [banksCash, staffAccessRaw, auditRes, secRes, profitOverrides, settlements, deletedClients, dismissedAlerts, allocations, autofillInvoices] = await Promise.all([
      fetchAll(supabase, 'acc_banks_cash'),
      fetchAll(supabase, 'acc_staff_access'),
      supabase.from('acc_audit_log').select('*').order('ts', { ascending: false }).limit(300),
      supabase.from('acc_audit_log').select('id', { count: 'exact', head: true }).eq('acknowledged', false).in('severity', ['critical', 'warning']),
      fetchAll(supabase, 'acc_profit_overrides', null),
      fetchAll(supabase, 'acc_settlements', null),
      fetchAll(supabase, 'acc_deleted_clients', null),
      fetchAll(supabase, 'acc_dismissed_alerts', null),
      fetchAll(supabase, 'acc_payment_allocations'),
      fetchAll(supabase, 'acc_autofill_invoices'),
    ]);
    // pin/role يُضمّنان هنا لكن filterForStaff يُصفّر staffAccess بالكامل لغير المالك، فيصلان للمالكة فقط
    const staffAccess = staffAccessRaw.map((u: any) => ({ id: u.id, staff_name: u.staff_name, is_owner: u.is_owner, allowed_tabs: u.allowed_tabs || [], active: u.active, has_pin: !!(u.pin && String(u.pin).length), pin: u.pin || '', role: u.role || '' }));
    const auditLog = auditRes.data || [];
    const securityCount = secRes.count || 0;
    const rows = overview; rows.sort((a: any, b: any) => String(b.booking_date || '').localeCompare(String(a.booking_date || '')));
    const bfMap: Record<string, { name: string; sold: number; cost: number; profit: number }> = {};
    for (const b of bfRows) { const c = b.client_code; if (!c) continue; bfMap[c] = bfMap[c] || { name: '', sold: 0, cost: 0, profit: 0 }; if (b.client_name && !bfMap[c].name) bfMap[c].name = b.client_name; bfMap[c].sold += Number(b.sold_to_client || 0); bfMap[c].cost += Number(b.cost_local || 0); bfMap[c].profit += Number(b.difference || 0); }
    const totalProfit = rows.reduce((s: number, r: any) => s + Number(r.profit || 0), 0);
    const outstanding = due.reduce((s: number, r: any) => s + Math.max(0, Number(r.balance || 0)), 0);
    const overdue = due.filter((r: any) => r.is_overdue).length;
    const monthly: Record<string, { profit: number; count: number }> = {};
    for (const r of rows) { if (!r.booking_date) continue; const m = String(r.booking_date).slice(0, 7); monthly[m] = monthly[m] || { profit: 0, count: 0 }; monthly[m].profit += Number(r.profit || 0); monthly[m].count += 1; }
    const monthlyArr = Object.entries(monthly).sort().map(([month, v]) => ({ month, ...v }));
    const me = (key === ACCESS_KEY) ? { staff_name: 'المالكة', is_owner: true, allowed_tabs: ALL_TABS, via: 'key', role: callerRole, can_bankref: callerBankRef } : (sess ? { staff_name: sess.staff_name, is_owner: !!sess.is_owner, allowed_tabs: sess.allowed_tabs || [], via: 'token', role: callerRole, can_bankref: callerBankRef } : { staff_name: '', is_owner: false, allowed_tabs: [], via: 'token', role: '', can_bankref: false });
    const payload: any = { kpis: { totalProfit, bookings: rows.length, outstanding, overdue, clients: new Set(rows.map((r: any) => r.client_code)).size }, overview: rows, due, staff, agents, fcd, bf: bfMap, bookingForm: bfRows, sales, serviceLines: svc, hotelBookings: hotels, refunds, lists, supplierInvoices: supInv, bankTx, banksCash, alerts, supplierPayments: supPay, pendingMovements: pendingMv, hotelPayments: hotelPay, staffAccess, auditLog, securityCount, profitOverrides, settlements, deletedClients, dismissedAlerts, allocations, autofillInvoices, monthly: monthlyArr, lastSync: logsArr.data?.[0] || null, generatedAt: new Date().toISOString(), me };
    if (sess && !sess.is_owner) filterForStaff(payload, sess.allowed_tabs || []);
    return J(payload);
  } catch (e) { return J({ error: String(e) }, 500); }
});
