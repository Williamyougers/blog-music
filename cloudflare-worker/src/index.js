// blog-music-api - Cloudflare Worker
// Backend for weilingt.top blog: works/logs/about (admin write) + comments (public) + orders (public submit, admin manage)

const ALLOWED_ORIGINS = [
  'https://weilingt.top',
  'https://www.weilingt.top',
  'http://weilingt.top',
  'http://www.weilingt.top',
  'https://williamyougers.github.io',
  'http://localhost:8080',
  'http://localhost:5500',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5500',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Visitor-Id',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return !!env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`;
}

const DEFAULT_ABOUT = {
  intro: '',
  body1: '',
  quote: '',
  body2: '',
};

async function loadAll(env) {
  const [worksRaw, logsRaw, aboutRaw, commentsRaw, ordersRaw] = await Promise.all([
    env.BLOG.get('works'),
    env.BLOG.get('logs'),
    env.BLOG.get('about'),
    env.BLOG.get('comments'),
    env.BLOG.get('orders'),
  ]);
  return {
    works: JSON.parse(worksRaw || '[]'),
    logs: JSON.parse(logsRaw || '[]'),
    about: { ...DEFAULT_ABOUT, ...(JSON.parse(aboutRaw || 'null') || {}) },
    comments: JSON.parse(commentsRaw || '{}'),
    orders: JSON.parse(ordersRaw || '[]'),
    fetchedAt: Date.now(),
  };
}

function sanitizeStr(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

// Mask contact info for non-admin viewers.
// Keeps first/last chars, replaces middle with ****.
// Email: mask local part only, keep @domain.
function _maskCore(s) {
  const n = s.length;
  if (n <= 3) return '*'.repeat(n);
  if (n <= 6) return s[0] + '****' + s.slice(-1);
  return s.slice(0, 2) + '****' + s.slice(-2);
}
function maskContact(s) {
  if (!s) return '';
  const str = String(s);
  const at = str.indexOf('@');
  if (at > 0 && str.indexOf('.', at) > at) {
    return _maskCore(str.slice(0, at)) + str.slice(at);
  }
  return _maskCore(str);
}

// Mask client name for non-owner viewers: keep only the first char, append ***.
function maskName(s) {
  if (!s) return '';
  const str = String(s).trim();
  if (!str) return '';
  // Use Array.from to handle surrogate pairs (emoji etc.)
  const first = Array.from(str)[0] || '';
  return first + '***';
}

// Allowed tier key format
const TIER_KEY_RE = /^[a-zA-Z0-9_-]{1,20}$/;
const MAX_TIERS = 8;
const DEFAULT_TIER_KEYS = ['basic', 'standard', 'full'];

// Sanitize tier keys: array of unique short keys, max MAX_TIERS
function sanitizeTierKeys(tk) {
  if (!Array.isArray(tk)) return undefined;
  const seen = new Set();
  const out = [];
  for (const k of tk) {
    if (typeof k !== 'string') continue;
    if (!TIER_KEY_RE.test(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_TIERS) break;
  }
  return out.length ? out : undefined;
}

// Pick allowed key set: prefer tierKeys from `about`, else union of all tier dict keys, else defaults
function pickAllowedKeys(about) {
  let keys = sanitizeTierKeys(about && about.tierKeys);
  if (keys && keys.length) return keys;
  const union = new Set();
  ['tierPrices', 'tierDescs', 'tierLabels'].forEach(f => {
    const obj = about && about[f];
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(k => { if (TIER_KEY_RE.test(k)) union.add(k); });
    }
  });
  if (union.size) return Array.from(union).slice(0, MAX_TIERS);
  return DEFAULT_TIER_KEYS.slice();
}

// Tier prices: each 0..99999, only keys in allowedKeys
function sanitizeTierPrices(tp, allowedKeys) {
  if (!tp || typeof tp !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const n = Math.floor(Number(tp[k]));
    if (!isNaN(n) && n >= 0 && n <= 99999) out[k] = n;
  });
  return Object.keys(out).length ? out : undefined;
}
function sanitizeTierDescs(td, allowedKeys) {
  if (!td || typeof td !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const s = sanitizeStr(td[k], 60);
    if (s) out[k] = s;
  });
  return Object.keys(out).length ? out : undefined;
}
// Tier labels: each 1..10 chars, only keys in allowedKeys
function sanitizeTierLabels(tl, allowedKeys) {
  if (!tl || typeof tl !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const s = sanitizeStr(tl[k], 10);
    if (s) out[k] = s;
  });
  return Object.keys(out).length ? out : undefined;
}
// Tier price modes: each is 'fixed' or 'from', only keys in allowedKeys
function sanitizeTierPriceModes(tm, allowedKeys) {
  if (!tm || typeof tm !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const v = tm[k];
    if (v === 'from') out[k] = 'from';
    else if (v === 'fixed') out[k] = 'fixed';
  });
  return Object.keys(out).length ? out : undefined;
}
// Order tiers (multi-select snapshot): array of {key,label,price,mode}, max MAX_TIERS
function sanitizeOrderTiers(arr) {
  if (!Array.isArray(arr)) return undefined;
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const key = typeof item.key === 'string' && TIER_KEY_RE.test(item.key) ? item.key : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = sanitizeStr(item.label, 10) || key;
    const priceN = Math.floor(Number(item.price));
    const price = (!isNaN(priceN) && priceN >= 0 && priceN <= 99999) ? priceN : 0;
    const mode = item.mode === 'from' ? 'from' : 'fixed';
    out.push({ key, label, price, mode });
    if (out.length >= MAX_TIERS) break;
  }
  return out.length ? out : undefined;
}
// ── 长期合作（plans）：跟 tier 同样的清洗策略，独立字段 ──
const MAX_PLANS = 8;
const DEFAULT_PLAN_KEYS = ['monthly', 'quarterly', 'yearly', 'bulk'];
function sanitizePlanKeys(pk) {
  if (!Array.isArray(pk)) return undefined;
  const seen = new Set();
  const out = [];
  for (const k of pk) {
    if (typeof k !== 'string') continue;
    if (!TIER_KEY_RE.test(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_PLANS) break;
  }
  return out.length ? out : undefined;
}
function pickAllowedPlanKeys(about) {
  if (Array.isArray(about && about.planKeys)) {
    const sanitized = sanitizePlanKeys(about.planKeys);
    if (sanitized && sanitized.length) return sanitized;
  }
  const union = new Set();
  ['planPrices', 'planDescs', 'planLabels', 'planPeriods'].forEach(f => {
    const obj = about && about[f];
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(k => { if (TIER_KEY_RE.test(k)) union.add(k); });
    }
  });
  if (union.size) return Array.from(union).slice(0, MAX_PLANS);
  return DEFAULT_PLAN_KEYS.slice();
}
function sanitizePlanPrices(pp, allowedKeys) {
  if (!pp || typeof pp !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const n = Math.floor(Number(pp[k]));
    if (!isNaN(n) && n >= 0 && n <= 99999) out[k] = n;
  });
  return Object.keys(out).length ? out : undefined;
}
function sanitizePlanDescs(pd, allowedKeys) {
  if (!pd || typeof pd !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const s = sanitizeStr(pd[k], 60);
    if (s) out[k] = s;
  });
  return Object.keys(out).length ? out : undefined;
}
function sanitizePlanLabels(pl, allowedKeys) {
  if (!pl || typeof pl !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const s = sanitizeStr(pl[k], 10);
    if (s) out[k] = s;
  });
  return Object.keys(out).length ? out : undefined;
}
function sanitizePlanPeriods(pp, allowedKeys) {
  if (!pp || typeof pp !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const s = sanitizeStr(pp[k], 20);
    if (s) out[k] = s;
  });
  return Object.keys(out).length ? out : undefined;
}
function sanitizePlanPriceModes(pm, allowedKeys) {
  if (!pm || typeof pm !== 'object') return undefined;
  const out = {};
  allowedKeys.forEach(k => {
    const v = pm[k];
    if (v === 'from') out[k] = 'from';
    else if (v === 'fixed') out[k] = 'fixed';
  });
  return Object.keys(out).length ? out : undefined;
}
// Whitelist order images: array of <=3 strings, each <=500000 chars (data URL)
function sanitizeOrderImages(imgs) {
  if (!Array.isArray(imgs)) return [];
  const out = [];
  for (const s of imgs) {
    if (typeof s !== 'string') continue;
    if (s.length > 500000) continue; // single image too big, skip
    // Only accept data:image/... URLs or https URLs
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(s) && !/^https:\/\//.test(s)) continue;
    out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

const ORDER_STEPS = ['接单中', '沟通中', '编曲中', '待交付', '完结'];
const ORDER_TYPES = ['古风', 'Lo-fi', 'Folk', '新古典', '流行', '电子', '摇滚', 'R&B', '说唱', '其他'];
const ORDER_TIERS = [
  { key: 'basic', label: '基础', price: 299 },
  { key: 'standard', label: '进阶', price: 599 },
  { key: 'full', label: '全包', price: 999 },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET /api/data - public read (works + logs + about + comments + orders)
    // Order privacy:
    //   - Admin (Authorization Bearer): raw orders (contact + clientName intact, visitorId stripped)
    //   - Same visitor (X-Visitor-Id matches order.visitorId): see own order in full, marked _isMine
    //   - Other visitors: contact masked, clientName masked to first-char + ***
    // visitorId is NEVER returned to clients.
    if (path === '/api/data' && method === 'GET') {
      const data = await loadAll(env);
      if (Array.isArray(data.orders)) {
        const admin = isAdmin(request, env);
        const viewerId = request.headers.get('X-Visitor-Id') || '';
        data.orders = data.orders.map(o => {
          if (!o) return o;
          const mine = !!viewerId && o.visitorId === viewerId;
          const out = { ...o };
          delete out.visitorId; // never leak visitorId
          if (admin || mine) {
            if (mine && !admin) out._isMine = true;
            return out;
          }
          // Other visitors: mask sensitive fields
          out.contact = o.contact ? maskContact(o.contact) : '';
          out.clientName = o.clientName ? maskName(o.clientName) : '';
          return out;
        });
      }
      return json(data, 200, cors);
    }

    // PUT /api/data - admin overwrite for works/logs/about (NOT comments, NOT orders)
    if (path === '/api/data' && method === 'PUT') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const { works = [], logs = [], about = null } = body || {};
      if (!Array.isArray(works) || !Array.isArray(logs)) {
        return json({ error: 'works and logs must be arrays' }, 400, cors);
      }
      const safeAbout = about && typeof about === 'object' ? (() => {
        const allowed = pickAllowedKeys(about);
        const allowedPlans = pickAllowedPlanKeys(about);
        return {
          intro: sanitizeStr(about.intro, 500),
          body1: sanitizeStr(about.body1, 2000),
          quote: sanitizeStr(about.quote, 500),
          body2: sanitizeStr(about.body2, 2000),
          tierKeys: allowed,
          tierPrices: sanitizeTierPrices(about.tierPrices, allowed),
          tierPriceModes: sanitizeTierPriceModes(about.tierPriceModes, allowed),
          tierDescs: sanitizeTierDescs(about.tierDescs, allowed),
          tierLabels: sanitizeTierLabels(about.tierLabels, allowed),
          planKeys: allowedPlans,
          planPrices: sanitizePlanPrices(about.planPrices, allowedPlans),
          planPriceModes: sanitizePlanPriceModes(about.planPriceModes, allowedPlans),
          planDescs: sanitizePlanDescs(about.planDescs, allowedPlans),
          planLabels: sanitizePlanLabels(about.planLabels, allowedPlans),
          planPeriods: sanitizePlanPeriods(about.planPeriods, allowedPlans),
        };
      })() : null;
      const serialized = JSON.stringify({ works, logs, about: safeAbout });
      if (serialized.length > 1024 * 1024) {
        return json({ error: 'Payload too large' }, 413, cors);
      }
      const tasks = [
        env.BLOG.put('works', JSON.stringify(works)),
        env.BLOG.put('logs', JSON.stringify(logs)),
      ];
      if (safeAbout) tasks.push(env.BLOG.put('about', JSON.stringify(safeAbout)));
      await Promise.all(tasks);
      return json({ ok: true, savedAt: Date.now(), works: works.length, logs: logs.length, about: !!safeAbout }, 200, cors);
    }

    // ── Orders API ──

    // POST /api/orders - public submit order
    if (path === '/api/orders' && method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const type = sanitizeStr(body && body.type, 20);
      // tier: single key 'basic' or combined 'basic+full' (multi-select)
      const tier = sanitizeStr(body && body.tier, 200);
      const description = sanitizeStr(body && body.description, 1000);
      const clientName = sanitizeStr(body && body.clientName, 30);
      const showName = !!body.showName;
      const visitorId = sanitizeStr(body && body.visitorId, 64);
      const contact = sanitizeStr(body && body.contact, 200);
      // Multi-select tiers (authoritative) + price mode
      const safeTiers = sanitizeOrderTiers(body && body.tiers);
      const clientPriceMode = (body && body.priceMode === 'from') ? 'from'
        : (body && body.priceMode === 'fixed') ? 'fixed' : null;

      if (!tier) return json({ error: 'tier required' }, 400, cors);
      // type 已在前端移除（由套餐+描述代替）；保留字段兼容老订单/未来扩展，但不再强制校验
      // if (!ORDER_TYPES.includes(type)) return json({ error: 'Invalid type' }, 400, cors);
      // Tier key: allow single key or '+' joined combo; each segment must pass TIER_KEY_RE
      const tierSegments = tier.split('+').filter(Boolean);
      if (tierSegments.length === 0 || tierSegments.length > 8) return json({ error: 'Invalid tier' }, 400, cors);
      for (const seg of tierSegments) {
        if (!TIER_KEY_RE.test(seg)) return json({ error: 'Invalid tier' }, 400, cors);
      }
      // Backup fallback: legacy hard-coded tiers (used only if client doesn't supply price/label)
      const tierInfo = ORDER_TIERS.find(t => t.key === tier) || { key: tier, label: tier, price: 0 };
      if (!visitorId) return json({ error: 'visitorId required' }, 400, cors);

      // Rate limit: same visitor max 5 pending orders
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const pendingCount = orders.filter(o => o.visitorId === visitorId && o.step < 4).length;
      if (pendingCount >= 5) return json({ error: 'Too many pending orders' }, 429, cors);

      const now = Date.now();
      const seqNum = orders.length > 0 ? Math.max(...orders.map(o => o.seq || 0)) + 1 : 1;
      // Price: prefer client-supplied; fall back to safeTiers sum; finally to tierInfo.price
      let finalPrice = tierInfo.price;
      if (safeTiers && safeTiers.length) {
        finalPrice = safeTiers.reduce((s, t) => s + (Number(t.price) || 0), 0);
      }
      if (body.price !== undefined && body.price !== null && body.price !== '') {
        const p = Math.floor(Number(body.price));
        if (!isNaN(p) && p >= 0 && p <= 99999) finalPrice = p;
      }
      // Tier label: prefer client-supplied (admin may have renamed the tier, or it's a multi-select combo), fall back to default
      let finalTierLabel = tierInfo.label;
      const clientTierLabel = sanitizeStr(body && body.tierLabel, 100);
      if (clientTierLabel) finalTierLabel = clientTierLabel;
      // Price mode: prefer client; else infer from safeTiers (any 'from' → 'from'); default 'fixed'
      const finalPriceMode = clientPriceMode
        || (safeTiers && safeTiers.some(t => t.mode === 'from') ? 'from' : 'fixed');
      // Reference images (data URLs, max 3, each <=500KB)
      const images = sanitizeOrderImages(body && body.images);

      const order = {
        id: 'ord_' + now + '_' + Math.random().toString(36).slice(2, 8),
        seq: seqNum,
        type,
        tier,
        tierLabel: finalTierLabel,
        price: finalPrice,
        priceMode: finalPriceMode,
        tiers: safeTiers && safeTiers.length ? safeTiers : undefined,
        description,
        images,
        clientName: showName ? clientName : '',
        showName,
        visitorId,
        contact,
        step: 0,          // 0=接单中, 1=沟通中, 2=编曲中, 3=待交付, 4=完结
        createdAt: now,
        acceptedAt: null,
        completedAt: null,
        review: '',
        rating: 0,        // 0=未评分, 1-5=星级（客户在完结后自评）
        reviewAt: null,   // 客户首次提交评价的时间
        followupReview: '',  // 客户追评内容
        followupRating: 0,   // 客户追评星级
        followupAt: null,    // 追评提交时间
        reviewReply: '',  // 店主对客户评价的回复
        reviewReplyAt: null,
      };

      orders.push(order);
      // Size guard after adding new order (accommodate images)
      const ordersJson = JSON.stringify(orders);
      if (ordersJson.length > 20 * 1024 * 1024) {
        return json({ error: 'Orders storage full' }, 413, cors);
      }
      await env.BLOG.put('orders', ordersJson);
      return json({ ok: true, order: { ...order, visitorId: undefined } }, 200, cors);
    }

    // PUT /api/orders/:orderId - update order
    //   - Admin: step / price / description / contact / clientName / showName / reviewReply
    //            (admin CANNOT touch rating or review — those belong to the customer)
    //   - Owner (X-Visitor-Id matches order.visitorId):
    //       * step !== 4 (in-progress): description / contact / clientName / showName
    //       * step === 4 (completed):   rating / review only (customer self-review)
    const orderPutMatch = path.match(/^\/api\/orders\/([^/]+)$/);
    if (orderPutMatch && method === 'PUT') {
      const orderId = orderPutMatch[1];
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx < 0) return json({ error: 'Order not found' }, 404, cors);

      const order = orders[idx];
      const admin = isAdmin(request, env);
      const viewerId = request.headers.get('X-Visitor-Id') || '';
      const isOwner = !admin && !!viewerId && order.visitorId === viewerId;

      if (!admin && !isOwner) return json({ error: 'Unauthorized' }, 401, cors);

      // Admin-only fields
      if (admin) {
        // Update step
        if (body.step !== undefined) {
          const newStep = Math.floor(Number(body.step));
          if (newStep < 0 || newStep > 4) return json({ error: 'Invalid step' }, 400, cors);
          order.step = newStep;
          if (newStep >= 1 && !order.acceptedAt) order.acceptedAt = Date.now();
          if (newStep === 4 && !order.completedAt) order.completedAt = Date.now();
        }
        // Update price (admin can adjust custom pricing)
        if (body.price !== undefined) {
          order.price = Math.max(0, Math.floor(Number(body.price) || 0));
        }
        // Update review reply (admin replies to customer review; cannot touch rating/review itself)
        if (body.reviewReply !== undefined) {
          const rr = sanitizeStr(body.reviewReply, 200);
          order.reviewReply = rr;
          order.reviewReplyAt = rr ? Date.now() : null;
        }
        // Admin can also edit shared fields below
        if (body.description !== undefined) order.description = sanitizeStr(body.description, 1000);
        if (body.contact !== undefined) order.contact = sanitizeStr(body.contact, 200);
        if (body.showName !== undefined) order.showName = !!body.showName;
        if (body.clientName !== undefined) {
          const name = sanitizeStr(body.clientName, 30);
          order.clientName = order.showName ? name : '';
        }
      }

      // Owner (customer) — completed order: rating + review + followup (self-review)
      if (isOwner && order.step === 4) {
        if (body.rating !== undefined) {
          let r = Math.floor(Number(body.rating) || 0);
          if (r < 0) r = 0;
          if (r > 5) r = 5;
          order.rating = r;
        }
        if (body.review !== undefined) {
          order.review = sanitizeStr(body.review, 200);
        }
        if (body.followupRating !== undefined) {
          let r = Math.floor(Number(body.followupRating) || 0);
          if (r < 0) r = 0;
          if (r > 5) r = 5;
          order.followupRating = r;
        }
        if (body.followupReview !== undefined) {
          order.followupReview = sanitizeStr(body.followupReview, 200);
        }
        // Stamp initial review time
        if (body.rating !== undefined || body.review !== undefined) {
          const hasAny = (order.rating > 0) || !!order.review;
          if (hasAny && !order.reviewAt) order.reviewAt = Date.now();
          if (!hasAny) order.reviewAt = null;
        }
        // Stamp followup time
        if (body.followupRating !== undefined || body.followupReview !== undefined) {
          const hasFu = (order.followupRating > 0) || !!order.followupReview;
          if (hasFu && !order.followupAt) order.followupAt = Date.now();
          if (!hasFu) order.followupAt = null;
        }
      }

      // Owner — in-progress order: description / contact / clientName / showName
      if (isOwner && order.step !== 4) {
        if (body.description !== undefined) order.description = sanitizeStr(body.description, 1000);
        if (body.contact !== undefined) order.contact = sanitizeStr(body.contact, 200);
        if (body.showName !== undefined) order.showName = !!body.showName;
        if (body.clientName !== undefined) {
          const name = sanitizeStr(body.clientName, 30);
          order.clientName = order.showName ? name : '';
        }
      }

      await env.BLOG.put('orders', JSON.stringify(orders));
      // Strip visitorId from response; caller already knows their own scope
      const { visitorId: _vid, ...safeOrder } = order;
      return json({ ok: true, order: safeOrder }, 200, cors);
    }

    // DELETE /api/orders/:orderId - admin delete order
    if (orderPutMatch && method === 'DELETE') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
      const orderId = orderPutMatch[1];
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx < 0) return json({ error: 'Order not found' }, 404, cors);
      orders.splice(idx, 1);
      await env.BLOG.put('orders', JSON.stringify(orders));
      return json({ ok: true }, 200, cors);
    }

    // ── Comments API ──

    // POST /api/comments/:logId - public anonymous comment
    const postMatch = path.match(/^\/api\/comments\/([^/]+)$/);
    if (postMatch && method === 'POST') {
      const logId = postMatch[1];
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const nickname = sanitizeStr(body && body.nickname, 20) || '匿名乐迷';
      const content = sanitizeStr(body && body.content, 500);
      const visitorId = sanitizeStr(body && body.visitorId, 64);
      if (!content) return json({ error: 'Content required' }, 400, cors);
      if (!visitorId) return json({ error: 'visitorId required' }, 400, cors);

      const [logsRaw, commentsRaw] = await Promise.all([
        env.BLOG.get('logs'),
        env.BLOG.get('comments'),
      ]);
      const logs = JSON.parse(logsRaw || '[]');
      if (!logs.some(l => String(l.id) === String(logId))) {
        return json({ error: 'Log not found' }, 404, cors);
      }
      const comments = JSON.parse(commentsRaw || '{}');
      const list = Array.isArray(comments[logId]) ? comments[logId] : [];

      if (list.length >= 200) return json({ error: 'This log has too many comments' }, 429, cors);
      const visitorCount = list.filter(c => c.visitorId === visitorId).length;
      if (visitorCount >= 30) return json({ error: 'You have commented too many times here' }, 429, cors);

      const now = Date.now();
      const last = list.filter(c => c.visitorId === visitorId).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (last && now - last.createdAt < 5000) {
        return json({ error: 'Please wait a few seconds before posting again' }, 429, cors);
      }

      const item = {
        id: 'c_' + now + '_' + Math.random().toString(36).slice(2, 8),
        visitorId,
        nickname,
        content,
        createdAt: now,
      };
      list.push(item);
      comments[logId] = list;

      const serialized = JSON.stringify(comments);
      if (serialized.length > 1024 * 1024) {
        return json({ error: 'Comments storage full' }, 413, cors);
      }
      await env.BLOG.put('comments', serialized);
      return json({ ok: true, comment: item }, 200, cors);
    }

    // DELETE /api/comments/:logId/:commentId - admin or original visitor
    const delMatch = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)$/);
    if (delMatch && method === 'DELETE') {
      const logId = delMatch[1];
      const commentId = delMatch[2];
      const admin = isAdmin(request, env);
      const visitorId = sanitizeStr(request.headers.get('X-Visitor-Id'), 64);

      const commentsRaw = await env.BLOG.get('comments');
      const comments = JSON.parse(commentsRaw || '{}');
      const list = Array.isArray(comments[logId]) ? comments[logId] : [];
      const idx = list.findIndex(c => c.id === commentId);
      if (idx < 0) return json({ error: 'Comment not found' }, 404, cors);

      const target = list[idx];
      if (!admin) {
        if (!visitorId || target.visitorId !== visitorId) {
          return json({ error: 'Forbidden' }, 403, cors);
        }
      }
      list.splice(idx, 1);
      comments[logId] = list;
      await env.BLOG.put('comments', JSON.stringify(comments));
      return json({ ok: true }, 200, cors);
    }

    if (path === '/' || path === '/health') {
      return json({ status: 'ok', service: 'blog-music-api' }, 200, cors);
    }

    return json({ error: 'Not Found' }, 404, cors);
  },
};
