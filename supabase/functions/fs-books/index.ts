// 🛍️ Fancy Sense — نظام المصروفات والمنتجات (fancy-books.html)
// 🔐 نفس دخول نظام العز: مفتاح النظام (متغيّر بيئة سرّي) أو جلسة من acc_sessions (المالكة أو موظف عنده تبويب "fancy")
// 💾 التخزين: جدول fs_app_docs (coll, id, data jsonb) — مستند لكل مصروف/منتج + مستند meta للإعدادات والقوائم
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';

const ACCESS_KEY = Deno.env.get('FS_ACCESS_KEY') || Deno.env.get('ACC_ACCESS_KEY') || '';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-acc-key, x-acc-token, content-type, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const COLLS = new Set(['expenses', 'recurring', 'products', 'meta', 'stock_log', 'sales', 'registers', 'shifts', 'promotions', 'customers', 'quotes', 'transfers', 'purchases', 'suppayments', 'stockcounts', 'vouchers', 'wa_out']);
const MAX_DOC = 3_000_000;   // حد حجم المستند الواحد (مرفقات/صور مضغوطة)
const MAX_BATCH = 1500;


// ===== 🔐 صلاحيات الخادم (١٣ نوفمبر ٢٠٢٦): الدور من ملف المستخدم في meta:main (users/roles) — نفس صلاحيات رواء =====
const normS = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const ANY = (...ps: string[]) => (can: (p: string) => boolean) => ps.some(can);
const REPORTS = ['view-sales-reports', 'view-products-and-stock-reports', 'view-financial-reports-in-reports', 'view-tax-reports', 'dashboard-base'];
const READ: Record<string, (can: (p: string) => boolean) => boolean> = {
  expenses: ANY('expenses-base', ...REPORTS), recurring: ANY('expenses-base'), products: ANY('products-base', 'sale-checkout', 'stock-base', 'suppliers-base', ...REPORTS),
  stock_log: ANY('products-base', ...REPORTS), sales: ANY('view-sale-invoices', 'sale-checkout', 'customers-base', ...REPORTS), registers: ANY('sale-checkout', 'review-all-registers-sessions-cash-management', 'dashboard-base'),
  shifts: ANY('sale-checkout', 'review-all-registers-sessions-cash-management', 'dashboard-base'), promotions: ANY('sale-checkout', 'promotions-app-access'), customers: ANY('customers-base', 'sale-checkout'),
  quotes: ANY('sale-checkout'), transfers: ANY('stock-base', ...REPORTS), vouchers: ANY('stock-base', ...REPORTS), stockcounts: ANY('manage-stock-counts', 'stock-base', ...REPORTS),
  purchases: ANY('suppliers-base', ...REPORTS), suppayments: ANY('suppliers-base', ...REPORTS), wa_out: ANY('manage-registers-and-sales-settings'), meta: () => true,
};
const WRITE: Record<string, (can: (p: string) => boolean) => boolean> = {
  expenses: ANY('add-expenses', 'edit-expenses'), recurring: ANY('add-expenses'), products: ANY('add-products', 'edit-products'), stock_log: ANY('edit-products', 'manage-stock-counts'),
  sales: ANY('sale-checkout', 'manage-customer-settlements', 'process-sale-returns'), registers: ANY('sale-checkout', 'manage-registers-and-sales-settings'), shifts: ANY('sale-checkout'),
  promotions: ANY('promotions-app-access'), customers: ANY('add-new-customers', 'edit-customers'), quotes: ANY('sale-checkout'),
  transfers: ANY('request-stock-transfer', 'approve-or-reject-transfer-requests', 'record-draft-stock-operations'), vouchers: ANY('record-draft-stock-operations', 'manage-and-confirm-stock-movements'),
  stockcounts: ANY('manage-stock-counts'), purchases: ANY('record-draft-purchase-orders', 'manage-and-confirm-purchase-invoices', 'record-purchase-returns'), suppayments: ANY('manage-suppliers-and-payables'),
  wa_out: ANY('sale-checkout', 'manage-registers-and-sales-settings'),
  meta: ANY('general-account-setup', 'financial-settings', 'manage-locations', 'manage-users-and-permissions', 'manage-registers-and-sales-settings', 'promotions-app-access', 'add-expenses', 'edit-products', 'manage-customer-settlements'),
};
// يحذف التكلفة من المستندات لمن لا يملك «عرض تكلفة المنتج»
function stripCost(coll: string, d: any) {
  if (!d || typeof d !== 'object') return d;
  const x = structuredClone(d);
  if (coll === 'products') { delete x.cost; delete x.avgCost; if (x.locs) for (const b in x.locs) if (x.locs[b]) delete x.locs[b].buy; }
  if ((coll === 'sales' || coll === 'transfers' || coll === 'vouchers' || coll === 'quotes') && Array.isArray(x.items)) x.items.forEach((i: any) => { delete i.cost; delete i.oldCost; delete i.totalCost; });
  return x;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // ===== 📱 رمز ربط جهاز جديد للمالكة (عام — يُستبدل برمز من 6 أرقام صالح 5 دقائق ولمرة واحدة) =====
  if (req.method === 'POST' && url.searchParams.get('link') === 'redeem') {
    let b: any; try { b = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
    const { data: r } = await db.from('fs_app_docs').select('data').eq('coll', 'login_link').eq('id', 'cur').maybeSingle();
    const d: any = r?.data || null;
    if (!d || !d.code || Date.parse(d.exp) < Date.now()) return J({ error: 'الرمز منتهي — اطلبي رمز جديد من جهازك الثاني' }, 400);
    const code = String(b.code || '').replace(/[٠-٩]/g, (c: string) => String(c.charCodeAt(0) - 0x660)).replace(/\D/g, '');
    if (code !== d.code) {
      const fails = (+d.fails || 0) + 1;
      if (fails >= 5) await db.from('fs_app_docs').delete().eq('coll', 'login_link').eq('id', 'cur');
      else await db.from('fs_app_docs').update({ data: { ...d, fails } }).eq('coll', 'login_link').eq('id', 'cur');
      return J({ error: fails >= 5 ? 'محاولات كثيرة — اطلبي رمز جديد' : 'الرمز غير صحيح' }, 400);
    }
    await db.from('fs_app_docs').delete().eq('coll', 'login_link').eq('id', 'cur');
    const token = crypto.randomUUID() + '-' + crypto.randomUUID();
    const { error } = await db.from('acc_sessions').insert({ token, staff_name: d.staff_name, is_owner: !!d.is_owner, allowed_tabs: d.allowed_tabs || [], ip: req.headers.get('x-forwarded-for') || null, user_agent: req.headers.get('user-agent') || null, expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() });
    if (error) return J({ error: error.message }, 500);
    return J({ ok: true, token, user: { staff_name: d.staff_name, is_owner: !!d.is_owner } });
  }

  // ===== 📲 طابور رسائل واتساب فانسي (للجسر فقط، بمفتاح FS_WA_TOKEN السري) =====
  const waTok = req.headers.get('x-wa-token') || '';
  const WA_TOKEN = Deno.env.get('FS_WA_TOKEN') || '';
  if (req.method === 'POST' && waTok) {
    if (!WA_TOKEN || waTok !== WA_TOKEN) return J({ error: 'unauthorized' }, 401);
    let b: any; try { b = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
    const now = new Date().toISOString();
    if (b.action === 'wa_pull') {
      const lim = Math.min(10, Math.max(1, +b.limit || 5));
      const { data, error } = await db.from('fs_app_docs').select('id,data').eq('coll', 'wa_out').eq('deleted', false).eq('data->>status', 'pending').order('updated_at', { ascending: true }).limit(lim);
      if (error) return J({ error: error.message }, 500);
      const out: any[] = [];
      for (const r of data || []) {
        const d = { ...(r.data || {}), status: 'processing', pulledAt: now };
        const { error: e2 } = await db.from('fs_app_docs').update({ data: d, updated_at: now, updated_by: 'wa-bridge' }).eq('coll', 'wa_out').eq('id', r.id).eq('data->>status', 'pending');
        if (!e2) out.push({ id: r.id, to: d.to, text: d.text });
      }
      return J({ ok: true, messages: out });
    }
    if (b.action === 'wa_ack') {
      const { data: r } = await db.from('fs_app_docs').select('data').eq('coll', 'wa_out').eq('id', String(b.id || '')).maybeSingle();
      if (!r) return J({ error: 'not found' }, 404);
      const d = { ...(r.data || {}), status: b.ok ? 'sent' : 'failed', sentAt: b.ok ? now : null, error: b.ok ? '' : String(b.error || '').slice(0, 200) };
      const { error } = await db.from('fs_app_docs').update({ data: d, updated_at: now, updated_by: 'wa-bridge' }).eq('coll', 'wa_out').eq('id', String(b.id));
      if (error) return J({ error: error.message }, 500);
      return J({ ok: true });
    }
    return J({ error: 'unknown action' }, 400);
  }

  // ===== المصادقة =====
  let who = '';
  let owner = false;
  const key = req.headers.get('x-acc-key') || '';
  if (ACCESS_KEY && key === ACCESS_KEY) { who = 'المالكة'; owner = true; }
  if (!who) {
    const tok = req.headers.get('x-acc-token') || '';
    if (tok) {
      const { data: s } = await db.from('acc_sessions').select('expires_at,is_owner,allowed_tabs,staff_name').eq('token', tok).maybeSingle();
      if (s && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now())) {
        const tabs = Array.isArray(s.allowed_tabs) ? s.allowed_tabs : [];
        if (s.is_owner || tabs.includes('fancy')) { who = s.staff_name || (s.is_owner ? 'المالكة' : 'موظف'); owner = !!s.is_owner; }
      }
    }
  }
  if (!who) return J({ error: 'unauthorized' }, 401);

  // ===== 🔐 الدور =====
  let full = owner;  // المالكة أو مفتاح النظام = كل الصلاحيات
  let perms: Record<string, boolean> = {};
  let profile: any = null;
  let metaRow: any = null;
  if (!full) {
    const { data: m } = await db.from('fs_app_docs').select('data').eq('coll', 'meta').eq('id', 'main').maybeSingle();
    metaRow = m?.data || {};
    profile = (metaRow.users || []).find((u: any) => normS(u.name) === normS(who)) || null;
    if (profile?.status === 'stopped') return J({ error: 'unauthorized' }, 401);
    const role = profile?.roleId ? (metaRow.roles || []).find((r: any) => r.id === profile.roleId) : null;
    if (!profile || !profile.roleId || !role || role.key === 'admin' || role.key === 'super-admin') full = true;   // بلا دور محدد = كما كان (كل الصلاحيات)
    else perms = role.perms || {};
  }
  const can = (p: string) => full || !!perms[p];
  const canRead = (c: string) => full || (READ[c] ? READ[c](can) : false);
  const canWrite = (c: string) => full || (WRITE[c] ? WRITE[c](can) : false);
  const seeCost = can('view-product-cost');

  // ===== GET: كل المستندات (أو المتغيّرة منذ since) =====
  if (req.method === 'GET') {
    const since = url.searchParams.get('since');
    const out: any[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      let q = db.from('fs_app_docs').select('coll,id,data,deleted,updated_at').order('updated_at', { ascending: true }).range(from, from + page - 1);
      q = since ? q.gt('updated_at', since) : q.eq('deleted', false);
      const { data, error } = await q;
      if (error) return J({ error: error.message }, 500);
      for (const r of data || []) { if (r.coll === 'login_link' || r.coll === 'img_log' || !canRead(r.coll)) continue; out.push(seeCost ? r : { ...r, data: stripCost(r.coll, r.data) }); }
      if (!data || data.length < page) break;
    }
    return J({ user: who, owner, now: new Date().toISOString(), docs: out });
  }

  // ===== POST: حفظ / حذف =====
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
    if (body.action === 'whoami') return J({ user: who });
    if (body.action === 'img_identify') {
      // 📷 التعرف على المنتج من صورة (Claude Opus 5.5) — مرحلتين: وصف القطعة، ثم اختيارها من لوحة صور المنتجات المرشحة
      const mode = body.mode === 'pick' ? 'pick' : body.mode === 'index' ? 'index' : 'describe';
      if (mode === 'index') {
        // فهرسة صور المنتجات (للمالكة): وصف بصري لكل صورة منتج مرة واحدة
        if (!owner) return J({ error: 'للمالكة فقط' }, 403);
        const items: any[] = Array.isArray(body.items) ? body.items.slice(0, 12) : [];
        if (!items.length) return J({ error: 'لا توجد صور' }, 400);
        const content: any[] = [];
        items.forEach((it: any) => { content.push({ type: 'text', text: 'Image id ' + String(it.id).slice(0, 40) + ':' }); content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(it.image || '').slice(0, 1_000_000) } }); });
        content.push({ type: 'text', text: 'JSON only.' });
        try {
          const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
          const res: any = await client.beta.messages.create({
            model: 'claude-opus-5-5', max_tokens: 8000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' },
            system: 'Each image is a product photo from a fashion-accessories shop catalogue. For EVERY image return its visual attributes. Reply with ONLY JSON: {"items":[{"id":"<image id>","types":["every item type visible: ring|bracelet|necklace|earrings|set|watch|lenses|box|perfume|bag|other"],"color":"gold|silver|rose gold|multi color|black|white|brown|green|red|blue|pink|other","brand_style":"luxury design imitated if recognisable (cartier, van cleef, tiffany, bulgari, chanel, lv, dior, gucci, messika, boucheron, rolex) else empty","desc":"max 15 words: shape, motif, stones"}]}',
            messages: [{ role: 'user', content }],
          } as any);
          if (res.stop_reason === 'refusal') return J({ error: 'refusal' }, 422);
          const txt = (res.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          const m = txt.match(/\{[\s\S]*\}/); if (!m) return J({ error: 'no json' }, 422);
          const out = JSON.parse(m[0]);
          return J({ ok: true, items: out.items || [], usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens } });
        } catch (e: any) { return J({ error: 'خطأ في خدمة التعرف: ' + String(e?.message || e).slice(0, 160) }, 502); }
      }
      const img = String(body.image || '');
      const sheets: string[] = Array.isArray(body.sheets) ? body.sheets.slice(0, 5).map(String) : [];
      if (!img || img.length > 3_000_000 || sheets.some(s => s.length > 3_000_000)) return J({ error: 'صورة غير صالحة' }, 400);
      if (mode === 'pick' && !sheets.length) return J({ error: 'لا توجد صور مرشحة' }, 400);
      const vocab = String(body.vocab || '').slice(0, 3000);
      const pic = (d: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } });
      const sys = mode === 'describe'
        ? 'You identify items in a fashion-accessories and gifts shop (rings, bracelets, necklaces, earrings, sets, watches, lenses, boxes, perfumes) from a cashier photo. Reply with ONLY a JSON object, no prose: {"type":"ring|bracelet|necklace|earrings|set|watch|lenses|box|perfume|other","types":["every item type that could describe what is shown, e.g. a ring shown with a bracelet -> [\"ring\",\"bracelet\",\"set\"]"],"color":"gold|silver|rose gold|multi color|black|white|brown|green|red|blue|pink|other","brand_style":"","desc":"short visual description: shape, motif, stones","texts":["any visible written words"],"barcode":"digits if a barcode is readable else empty"}. brand_style = the luxury design the piece imitates (e.g. cartier, van cleef, tiffany, bulgari, chanel, lv, dior, gucci, messika, boucheron, rolex) if clearly recognisable, else "". Shop vocabulary: ' + vocab
        : 'A cashier photographed one item. The following contact sheet(s) show candidate shop products, each tile labelled with a number in its corner. Find the tiles showing the SAME product (same design, shape, motif and colour; ignore background, angle and lighting). Reply with ONLY a JSON object: {"picks":[tile numbers, best match first, at most 5, only plausible matches],"confidence":"high|medium|low"}. If none match, {"picks":[],"confidence":"low"}.';
      const content: any[] = [{ type: 'text', text: 'Cashier photo:' }, pic(img)];
      sheets.forEach((s, k) => { content.push({ type: 'text', text: `Contact sheet ${k + 1}:` }); content.push(pic(s)); });
      content.push({ type: 'text', text: 'JSON only.' });
      try {
        const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
        const res: any = await client.beta.messages.create({
          model: 'claude-opus-5-5', max_tokens: 4000,
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
          output_config: { effort: 'low' }, system: sys,
          messages: [{ role: 'user', content }],
        } as any);
        if (res.stop_reason === 'refusal') return J({ error: 'تعذّر التعرف على الصورة' }, 422);
        const txt = (res.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        const m = txt.match(/\{[\s\S]*\}/); if (!m) return J({ error: 'لم أتعرف على المنتج — جرّبي صورة أوضح' }, 422);
        let info: any; try { info = JSON.parse(m[0]); } catch { return J({ error: 'لم أتعرف على المنتج — جرّبي صورة أوضح' }, 422); }
        try { const at = new Date().toISOString(); await db.from('fs_app_docs').upsert({ coll: 'img_log', id: crypto.randomUUID(), data: { at, by: who, mode, info, in: res.usage?.input_tokens, out: res.usage?.output_tokens }, deleted: true, updated_at: at, updated_by: who }, { onConflict: 'coll,id' }); } catch (_) {}
        return J({ ok: true, info, usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens } });
      } catch (e: any) { return J({ error: 'خطأ في خدمة التعرف: ' + String(e?.message || e).slice(0, 160) }, 502); }
    }
    if (body.action === 'link_create') {
      if (!owner) return J({ error: 'للمالكة فقط' }, 403);
      const { data: sa } = await db.from('acc_staff_access').select('allowed_tabs').eq('staff_name', who).maybeSingle();
      const n = new Uint32Array(1); crypto.getRandomValues(n); const code = String(100000 + (n[0] % 900000));
      const exp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const { error } = await db.from('fs_app_docs').upsert({ coll: 'login_link', id: 'cur', data: { code, exp, fails: 0, staff_name: who, is_owner: true, allowed_tabs: sa?.allowed_tabs || [] }, deleted: true, updated_at: new Date().toISOString(), updated_by: who }, { onConflict: 'coll,id' });
      if (error) return J({ error: error.message }, 500);
      return J({ ok: true, code, exp });
    }
    const now = new Date().toISOString();
    if (body.action === 'put') {
      const docs = Array.isArray(body.docs) ? body.docs : [];
      if (docs.length > MAX_BATCH) return J({ error: 'too many docs' }, 400);
      const rows = [];
      const skipped: string[] = [];
      for (const d of docs) {
        if (!COLLS.has(d?.coll) || typeof d?.id !== 'string' || !d.id || d.id.length > 80) return J({ error: 'bad doc' }, 400);
        if (JSON.stringify(d.data ?? null).length > MAX_DOC) return J({ error: 'doc too large: ' + d.id }, 413);
      }
      // المستندات الحالية لمن صلاحياته محدودة (للدمج الآمن)
      const stored = new Map<string, any>();
      if (!full) {
        const byColl: Record<string, string[]> = {};
        docs.forEach((d: any) => { (byColl[d.coll] = byColl[d.coll] || []).push(d.id); });
        const pidSet = new Set<string>();
        docs.filter((d: any) => d.coll === 'sales').forEach((d: any) => (d.data?.items || []).forEach((i: any) => i.productId && pidSet.add(i.productId)));
        if (pidSet.size) (byColl.products = byColl.products || []).push(...pidSet);
        for (const [c, ids] of Object.entries(byColl)) {
          for (let i = 0; i < ids.length; i += 300) {
            const { data } = await db.from('fs_app_docs').select('coll,id,data,deleted').eq('coll', c).in('id', ids.slice(i, i + 300));
            (data || []).forEach((r: any) => stored.set(r.coll + ':' + r.id, r.deleted ? null : r.data));
          }
        }
      }
      for (const d of docs) {
        let data = d.data;
        const old = stored.get(d.coll + ':' + d.id);
        if (!full) {
          if (d.coll === 'products' && !canWrite('products')) {
            // البيع/الجرد/التحويل يغيّر الكمية فقط: نأخذ المخزّن ونطبّق الكميات وسجل الحركة فقط
            if (!old || !(can('sale-checkout') || can('stock-base') || can('manage-stock-counts'))) { skipped.push(d.coll + ':' + d.id); continue; }
            const m = structuredClone(old); m.locs = m.locs || {};
            for (const b in (data?.locs || {})) { m.locs[b] = m.locs[b] || {}; if (data.locs[b] && data.locs[b].qty != null) m.locs[b].qty = data.locs[b].qty; }
            if (Array.isArray(data?.log)) m.log = data.log.slice(-300);
            data = m;
          } else if (d.coll === 'meta') {
            if (!canWrite('meta')) { skipped.push('meta:' + d.id); continue; }
            if (!can('manage-users-and-permissions')) { const cur = metaRow || {}; data = { ...data, users: cur.users || [], roles: cur.roles || [] }; }
          } else if (d.coll === 'customers' && old && !can('edit-customers') && !can('manage-customer-settlements')) {
            skipped.push(d.coll + ':' + d.id); continue;
          } else if (!canWrite(d.coll)) { skipped.push(d.coll + ':' + d.id); continue; }
          if (!seeCost) {
            if (d.coll === 'products' && old) { data = { ...data, cost: old.cost, avgCost: old.avgCost }; if (data.locs && old.locs) for (const b in data.locs) if (old.locs[b]) data.locs[b] = { ...data.locs[b], buy: old.locs[b].buy }; }
            if (d.coll === 'sales' && Array.isArray(data?.items)) {
              const oldItems = Array.isArray(old?.items) ? old.items : [];
              data = { ...data, items: data.items.map((i: any, k: number) => { const prev = oldItems[k]; const pr = stored.get('products:' + i.productId); const cost = prev && prev.productId === i.productId && prev.cost != null ? prev.cost : (pr ? +pr.cost || 0 : 0); return { ...i, cost }; }) };
            }
            if ((d.coll === 'transfers' || d.coll === 'vouchers' || d.coll === 'quotes') && Array.isArray(data?.items) && Array.isArray(old?.items)) {
              data = { ...data, items: data.items.map((i: any, k: number) => { const prev = old.items[k]; return prev && prev.productId === i.productId ? { ...i, cost: prev.cost, oldCost: prev.oldCost, totalCost: prev.totalCost } : i; }) };
            }
          }
          if (d.coll === 'wa_out' && !can('manage-registers-and-sales-settings')) {
            // الكاشير: الرسالة تُبنى من نص الإعدادات ورقم عميل الفاتورة فقط (منع إرسال نص أو رقم عشوائي)
            const sid = String(data?.saleId || '');
            const { data: sr } = await db.from('fs_app_docs').select('data').eq('coll', 'sales').eq('id', sid).maybeSingle();
            const inv = sr?.data || docs.find((x: any) => x.coll === 'sales' && x.id === sid)?.data;
            if (!inv || !inv.customerId || old) { skipped.push('wa_out:' + d.id); continue; }
            const { data: cr } = await db.from('fs_app_docs').select('data').eq('coll', 'customers').eq('id', inv.customerId).maybeSingle();
            const cust = cr?.data || docs.find((x: any) => x.coll === 'customers' && x.id === inv.customerId)?.data;
            let ph = String(cust?.phone || '').replace(/\D/g, ''); if (ph.startsWith('00')) ph = ph.slice(2); if (ph.length === 8) ph = '968' + ph;
            if (ph.length < 10) { skipped.push('wa_out:' + d.id); continue; }
            const w = (metaRow?.settings?.wa) || {}; const kind = data.kind === 'repeat' ? 'repeat' : 'first';
            const br = (metaRow?.branches || []).find((b: any) => b.id === inv.branchId);
            const txt = String(w[kind] || '').replace(/\{الاسم\}/g, cust?.name || '').replace(/\{رقم_الفاتورة\}/g, inv.no || '').replace(/\{المبلغ\}/g, String(inv.total ?? '')).replace(/\{الفرع\}/g, br?.name || '');
            if (!txt.trim()) { skipped.push('wa_out:' + d.id); continue; }
            data = { ...data, to: ph + '@s.whatsapp.net', phone: cust.phone, text: txt, kind, status: 'pending' };
          }
        }
        rows.push({ coll: d.coll, id: d.id, data, deleted: false, updated_at: now, updated_by: who });
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('fs_app_docs').upsert(rows.slice(i, i + 500), { onConflict: 'coll,id' });
        if (error) return J({ error: error.message }, 500);
      }
      return J({ ok: true, n: rows.length, now, skipped });
    }
    if (body.action === 'del') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length > MAX_BATCH) return J({ error: 'too many' }, 400);
      const delPerm: Record<string, string> = { products: 'delete-products', customers: 'delete-customers', expenses: 'delete-expenses' };
      for (const it of items) {
        if (!COLLS.has(it?.coll) || typeof it?.id !== 'string') return J({ error: 'bad item' }, 400);
        if (!full && (it.coll === 'meta' || !canWrite(it.coll) || (delPerm[it.coll] && !can(delPerm[it.coll])))) continue;
        const { error } = await db.from('fs_app_docs').update({ deleted: true, data: {}, updated_at: now, updated_by: who }).eq('coll', it.coll).eq('id', it.id);
        if (error) return J({ error: error.message }, 500);
      }
      return J({ ok: true, n: items.length, now });
    }
    // 👥 مستخدمو فانسي (المالكة فقط): نفس جدول دخول نظام العز acc_staff_access — نضيف/نزيل تبويب "fancy" فقط ولا نلمس صلاحيات العز الأخرى
    if (body.action === 'staff_list' || body.action === 'staff_set' || body.action === 'device_list' || body.action === 'device_set' || body.action === 'staff_pin') {
      if (!owner) return J({ error: 'إدارة المستخدمين للمالكة فقط' }, 403);
      if (body.action === 'staff_list') {
        const { data, error } = await db.from('acc_staff_access').select('id,staff_name,is_owner,active,allowed_tabs,role');
        if (error) return J({ error: error.message }, 500);
        const { data: devs } = await db.from('acc_devices').select('staff_name,status,last_seen');
        const rows = (data || []).map((u: any) => {
          const tabs = Array.isArray(u.allowed_tabs) ? u.allowed_tabs : [];
          const d = (devs || []).filter((x: any) => x.staff_name === u.staff_name);
          return { id: u.id, staff_name: u.staff_name, is_owner: !!u.is_owner, active: u.active !== false, fancy: !!u.is_owner || tabs.includes('fancy'), fancy_only: tabs.length === 1 && tabs[0] === 'fancy', other_tabs: tabs.filter((t: string) => t !== 'fancy').length, devices: { approved: d.filter((x: any) => x.status === 'approved').length, pending: d.filter((x: any) => x.status === 'pending').length }, last_seen: d.map((x: any) => x.last_seen).filter(Boolean).sort().pop() || null };
        });
        return J({ ok: true, staff: rows });
      }
      if (body.action === 'staff_set') {
        const p = body.payload || {};
        const name = String(p.staff_name || '').trim().slice(0, 60);
        if (!name) return J({ error: 'الاسم مطلوب' }, 400);
        const { data: ex } = await db.from('acc_staff_access').select('id,allowed_tabs,is_owner,pin').eq('staff_name', name).maybeSingle();
        const pin = p.pin != null ? String(p.pin).trim() : '';
        if (pin && !/^\d{4,8}$/.test(pin)) return J({ error: 'الرمز (PIN) من 4 إلى 8 أرقام' }, 400);
        if (!ex) {
          if (p.fancy === false) return J({ ok: true });
          if (!pin) return J({ error: 'حدد رمز الدخول (PIN) للمستخدم الجديد' }, 400);
          const { error } = await db.from('acc_staff_access').insert({ staff_name: name, pin, is_owner: false, active: true, allowed_tabs: ['fancy'], role: 'fancy' });
          if (error) return J({ error: error.message }, 500);
          return J({ ok: true, created: true });
        }
        if (ex.is_owner) return J({ error: 'لا يمكن تعديل حساب المالكة من هنا' }, 400);
        const tabs: string[] = Array.isArray(ex.allowed_tabs) ? ex.allowed_tabs : [];
        const fancyOnly = tabs.length === 0 || (tabs.length === 1 && tabs[0] === 'fancy');
        const upd: any = {};
        if (p.fancy === true && !tabs.includes('fancy')) upd.allowed_tabs = [...tabs, 'fancy'];
        if (p.fancy === false && tabs.includes('fancy')) upd.allowed_tabs = tabs.filter(t => t !== 'fancy');
        if (pin) { if (!fancyOnly) return J({ error: 'هذا الموظف يستخدم نظام العز أيضاً — يُغيَّر رمزه من نظام العز' }, 400); upd.pin = pin; }
        if (typeof p.active === 'boolean' && fancyOnly) upd.active = p.active;
        if (Object.keys(upd).length) { const { error } = await db.from('acc_staff_access').update(upd).eq('id', ex.id); if (error) return J({ error: error.message }, 500); }
        return J({ ok: true, updated: Object.keys(upd) });
      }
      if (body.action === 'staff_pin') {
        // 🔑 المالكة فقط: عرض رمز موظف فانسي (حسابات فانسي فقط — لا نعرض رموز موظفي نظام العز)
        const { data: u } = await db.from('acc_staff_access').select('pin,allowed_tabs,is_owner').eq('staff_name', String(body.staff_name || '')).maybeSingle();
        const tabs: string[] = Array.isArray(u?.allowed_tabs) ? u!.allowed_tabs : [];
        if (!u || u.is_owner || !(tabs.length === 1 && tabs[0] === 'fancy')) return J({ error: 'هذا الحساب يستخدم نظام العز — رمزه يُدار من هناك' }, 400);
        return J({ ok: true, pin: String(u.pin || '') });
      }
      if (body.action === 'device_list') {
        const { data: st } = await db.from('acc_staff_access').select('staff_name,allowed_tabs');
        const names = new Set((st || []).filter((u: any) => Array.isArray(u.allowed_tabs) && u.allowed_tabs.includes('fancy')).map((u: any) => u.staff_name));
        const { data, error } = await db.from('acc_devices').select('device_token,staff_name,status,user_agent,requested_at,last_seen').order('requested_at', { ascending: false }).limit(300);
        if (error) return J({ error: error.message }, 500);
        return J({ ok: true, devices: (data || []).filter((d: any) => names.has(d.staff_name)).map((d: any) => ({ ...d, device_token: String(d.device_token).slice(0, 8) + '…', key: d.device_token })) });
      }
      if (body.action === 'device_set') {
        const p = body.payload || {};
        if (!['approved', 'rejected'].includes(p.status)) return J({ error: 'bad status' }, 400);
        const { data: st } = await db.from('acc_staff_access').select('allowed_tabs').eq('staff_name', String(p.staff_name || '')).maybeSingle();
        if (!st || !Array.isArray(st.allowed_tabs) || !st.allowed_tabs.includes('fancy')) return J({ error: 'ليس من مستخدمي فانسي' }, 400);
        const { error } = await db.from('acc_devices').update({ status: p.status }).eq('device_token', String(p.key || '')).eq('staff_name', String(p.staff_name));
        if (error) return J({ error: error.message }, 500);
        return J({ ok: true });
      }
    }
    // 🖼 نسخ صور المنتجات من رابط خارجي (رواء) إلى تخزين Supabase الخاص بنا — bucket عام للقراءة fs-products
    if (body.action === 'mirror_images') {
      if (!full && !can('edit-products') && !can('add-products')) return J({ error: 'forbidden' }, 403);
      const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
      const BUCKET = 'fs-products';
      const { data: b } = await db.storage.getBucket(BUCKET);
      if (!b) { const { error } = await db.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 5 * 1024 * 1024 }); if (error && !/exist/i.test(error.message)) return J({ error: 'bucket: ' + error.message }, 500); }
      const out: any[] = [];
      for (const it of items) {
        try {
          const src = String(it?.url || '');
          if (!/^https:\/\/s3\.[a-z0-9-]+\.amazonaws\.com\/prod-mims-service-any-item-image\./.test(src)) { out.push({ id: it?.id, error: 'source not allowed' }); continue; }
          const id = String(it.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
          const r = await fetch(src);
          if (!r.ok) { out.push({ id, error: 'fetch ' + r.status }); continue; }
          const type = r.headers.get('content-type') || 'image/jpeg';
          if (!type.startsWith('image/')) { out.push({ id, error: 'not image' }); continue; }
          const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
          const path = `products/${id}.${ext}`;
          const buf = new Uint8Array(await r.arrayBuffer());
          const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: true });
          if (error) { out.push({ id, error: error.message }); continue; }
          out.push({ id, url: db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, bytes: buf.length });
        } catch (e) { out.push({ id: it?.id, error: String(e) }); }
      }
      return J({ ok: true, results: out });
    }
    return J({ error: 'unknown action' }, 400);
  }
  return J({ error: 'method' }, 405);
});
