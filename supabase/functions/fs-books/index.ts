// 🛍️ Fancy Sense — نظام المصروفات والمنتجات (fancy-books.html)
// 🔐 نفس دخول نظام العز: مفتاح النظام (متغيّر بيئة سرّي) أو جلسة من acc_sessions (المالكة أو موظف عنده تبويب "fancy")
// 💾 التخزين: جدول fs_app_docs (coll, id, data jsonb) — مستند لكل مصروف/منتج + مستند meta للإعدادات والقوائم
import { createClient } from 'jsr:@supabase/supabase-js@2';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

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
      out.push(...(data || []));
      if (!data || data.length < page) break;
    }
    return J({ user: who, owner, now: new Date().toISOString(), docs: out });
  }

  // ===== POST: حفظ / حذف =====
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
    if (body.action === 'whoami') return J({ user: who });
    const now = new Date().toISOString();
    if (body.action === 'put') {
      const docs = Array.isArray(body.docs) ? body.docs : [];
      if (docs.length > MAX_BATCH) return J({ error: 'too many docs' }, 400);
      const rows = [];
      for (const d of docs) {
        if (!COLLS.has(d?.coll) || typeof d?.id !== 'string' || !d.id || d.id.length > 80) return J({ error: 'bad doc' }, 400);
        if (JSON.stringify(d.data ?? null).length > MAX_DOC) return J({ error: 'doc too large: ' + d.id }, 413);
        rows.push({ coll: d.coll, id: d.id, data: d.data, deleted: false, updated_at: now, updated_by: who });
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('fs_app_docs').upsert(rows.slice(i, i + 500), { onConflict: 'coll,id' });
        if (error) return J({ error: error.message }, 500);
      }
      return J({ ok: true, n: rows.length, now });
    }
    if (body.action === 'del') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length > MAX_BATCH) return J({ error: 'too many' }, 400);
      for (const it of items) {
        if (!COLLS.has(it?.coll) || typeof it?.id !== 'string') return J({ error: 'bad item' }, 400);
        const { error } = await db.from('fs_app_docs').update({ deleted: true, data: {}, updated_at: now, updated_by: who }).eq('coll', it.coll).eq('id', it.id);
        if (error) return J({ error: error.message }, 500);
      }
      return J({ ok: true, n: items.length, now });
    }
    // 👥 مستخدمو فانسي (المالكة فقط): نفس جدول دخول نظام العز acc_staff_access — نضيف/نزيل تبويب "fancy" فقط ولا نلمس صلاحيات العز الأخرى
    if (body.action === 'staff_list' || body.action === 'staff_set' || body.action === 'device_list' || body.action === 'device_set') {
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
