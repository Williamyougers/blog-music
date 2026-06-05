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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Visitor-Id, X-User-Token',
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

// ── Multi-role admin (super + sub) ──
const SUPER_ADMIN_EMAIL = '453203081@qq.com';

async function getSubAdmins(env) {
  const list = await env.BLOG.get('admin/subadmins', 'json');
  return Array.isArray(list) ? list : [];
}

async function isSubAdminEmail(env, email) {
  if (!email) return false;
  const list = await getSubAdmins(env);
  const e = String(email).toLowerCase();
  return list.some(s => s && s.email === e);
}

// Returns 'super' | 'sub' | 'user' | null
async function getRole(request, env) {
  if (isAdmin(request, env)) return 'super'; // password fallback
  const user = await getCurrentUser(request, env);
  if (!user) return null;
  if (user.email === SUPER_ADMIN_EMAIL) return 'super';
  if (await isSubAdminEmail(env, user.email)) return 'sub';
  return 'user';
}

async function isAdminOrSub(request, env) {
  const role = await getRole(request, env);
  return role === 'super' || role === 'sub';
}

async function isSuperRole(request, env) {
  const role = await getRole(request, env);
  return role === 'super';
}

// 新订单微信推送（Server 酱）
// 需要在 Worker Secret 里设置 SERVERCHAN_KEY；没设置则静默跳过
async function notifyNewOrder(env, order) {
  if (!env.SERVERCHAN_KEY) return;
  try {
    const desc = (order.description || '').trim();
    const descShort = desc.length > 100 ? desc.slice(0, 100) + '...' : desc;
    const isCommercial = /^\[商用\]/.test(desc);
    const isLongTerm = /^\[长期合作\]/.test(desc);
    const modeTag = isCommercial ? '🏢 商用' : (isLongTerm ? '📆 长期合作' : '🎵 非商');
    const showName = order.showName ? (order.clientName || '匿名') : '匿名';
    const seqStr = String(order.seq || 0).padStart(3, '0');
    const tierLabel = order.tierLabel || order.tier || '';
    const priceStr = order.priceMode === 'from' ? `${order.price} 元起` : `${order.price} 元`;
    const contact = order.contact || '（未留）';
    const timeStr = new Date(order.createdAt || Date.now())
      .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

    const title = `📢 新订单 #${seqStr} · ${tierLabel}`;
    const desp = [
      `### ${modeTag}`,
      '',
      `- **挂名**：${showName}`,
      `- **套餐**：${tierLabel}`,
      `- **价格**：${priceStr}`,
      `- **联系方式**：\`${contact}\``,
      '',
      `**描述**`,
      '',
      `> ${descShort || '（无）'}`,
      '',
      `---`,
      `🕐 ${timeStr}`,
      `🔗 https://weilingt.top`,
    ].join('\n');

    const apiUrl = `https://sctapi.ftqq.com/${env.SERVERCHAN_KEY}.send`;
    const body = new URLSearchParams({ title, desp });
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    // 推送失败不影响订单创建
    console.error('notifyNewOrder failed:', e && e.message);
  }
}

// 支付成功后给店主推送
async function notifyOrderPaid(env, order) {
  if (!env.SERVERCHAN_KEY) return;
  try {
    const seqStr = String(order.seq || 0).padStart(3, '0');
    const tierLabel = order.tierLabel || order.tier || '';
    const amount = order.paidAmount || order.price || 0;
    const method = order.payMethod === 'alipay' ? '支付宝' : (order.payMethod || '');
    const showName = order.showName ? (order.clientName || '匿名') : '匿名';
    const timeStr = new Date(order.paidAt || Date.now())
      .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const title = `💰 收款 ¥${amount} · 订单 #${seqStr}`;
    const desp = [
      `### 到账啦！`,
      '',
      `- **挂名**：${showName}`,
      `- **套餐**：${tierLabel}`,
      `- **实付**：¥${amount}（${method}）`,
      `- **交易号**：\`${order.tradeNo || '-'}\``,
      '',
      `---`,
      `🕐 ${timeStr}`,
      `🔗 https://weilingt.top`,
    ].join('\n');
    const apiUrl = `https://sctapi.ftqq.com/${env.SERVERCHAN_KEY}.send`;
    const body = new URLSearchParams({ title, desp });
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    console.error('notifyOrderPaid failed:', e && e.message);
  }
}

const DEFAULT_ABOUT = {
  intro: '',
  body1: '',
  quote: '',
  body2: '',
};

async function loadAll(env) {
  const [worksRaw, logsRaw, aboutRaw, commentsRaw, ordersRaw, logGroupsRaw] = await Promise.all([
    env.BLOG.get('works'),
    env.BLOG.get('logs'),
    env.BLOG.get('about'),
    env.BLOG.get('comments'),
    env.BLOG.get('orders'),
    env.BLOG.get('logGroups'),
  ]);
  return {
    works: JSON.parse(worksRaw || '[]'),
    logs: JSON.parse(logsRaw || '[]'),
    about: { ...DEFAULT_ABOUT, ...(JSON.parse(aboutRaw || 'null') || {}) },
    comments: JSON.parse(commentsRaw || '{}'),
    orders: JSON.parse(ordersRaw || '[]'),
    logGroups: JSON.parse(logGroupsRaw || '[]'),
    fetchedAt: Date.now(),
  };
}

function sanitizeStr(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

// ── 支付宝当面付（扫码支付）辅助函数 ────────────────────────────────
// 依赖 env: ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY (PKCS8 PEM) / ALIPAY_PUBLIC_KEY (SPKI PEM)
//          ALIPAY_GATEWAY (默认 https://openapi.alipay.com/gateway.do)
//          ALIPAY_NOTIFY_URL (默认 https://api.weilingt.top/api/pay/notify)
function _pemToBuffer(pem) {
  const body = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function _bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
async function alipaySign(content, privateKeyPem) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    _pemToBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(content));
  return _bufToBase64(sig);
}
async function alipayVerify(content, signBase64, publicKeyPem) {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      _pemToBuffer(publicKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBin = atob(signBase64);
    const sig = new Uint8Array(sigBin.length);
    for (let i = 0; i < sigBin.length; i++) sig[i] = sigBin.charCodeAt(i);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(content));
  } catch (_) { return false; }
}
// 拼接签名串：按 key 字典序排序，过滤 sign / sign_type / 空值
function _buildSignContent(params) {
  return Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}
function _alipayTimestamp() {
  // 北京时间 YYYY-MM-DD HH:mm:ss
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const iso = d.toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
}
// 调用支付宝 OpenAPI，自动处理签名 + 解析响应
async function alipayCall(method, bizContent, env, opts) {
  opts = opts || {};
  const gateway = env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do';
  const publicParams = {
    app_id: env.ALIPAY_APP_ID,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: _alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  if (opts.notifyUrl) publicParams.notify_url = opts.notifyUrl;
  const signContent = _buildSignContent(publicParams);
  const sign = await alipaySign(signContent, env.ALIPAY_PRIVATE_KEY);
  publicParams.sign = sign;
  // 发请求
  const formBody = Object.keys(publicParams)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(publicParams[k])}`)
    .join('&');
  const resp = await fetch(gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: formBody,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Alipay non-JSON: ' + text.slice(0, 200)); }
  // 响应字段：alipay_trade_precreate_response / alipay_trade_query_response 等
  const respKey = method.replace(/\./g, '_') + '_response';
  const body = data[respKey];
  if (!body) throw new Error('Alipay missing ' + respKey);
  return body;
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
// ── R2 file URL pattern ──
// 新订单图/音频走 R2，URL 形如：
//   https://api.weilingt.top/files/orders/xxx/yyy.jpg
//   https://blog-music-api.<acct>.workers.dev/files/orders/xxx/yyy.mp3
const SELF_FILES_URL_RE = /^https:\/\/(api\.weilingt\.top|blog-music-api\.[a-z0-9.-]+\.workers\.dev)\/files\/orders\/[a-z0-9_./-]+$/i;

// Whitelist order images: array of <=3 strings (R2 URL 或老 data URL)
const MAX_ORDER_IMAGES = 3;
function sanitizeOrderImages(imgs) {
  if (!Array.isArray(imgs)) return [];
  const out = [];
  for (const s of imgs) {
    if (typeof s !== 'string') continue;
    if (SELF_FILES_URL_RE.test(s) && s.length <= 500) {
      // 新格式：R2 反代 URL
      out.push(s);
    } else if (/^data:image\/(png|jpe?g|gif|webp);base64,/.test(s) && s.length <= 500000) {
      // 老格式：data URL（兼容旧订单）
      out.push(s);
    } else {
      continue;
    }
    if (out.length >= MAX_ORDER_IMAGES) break;
  }
  return out;
}
// Whitelist order audios: array of <=3 items
//   新格式：{ name, type, size, url }     -- R2 反代 URL
//   老格式：{ name, type, size, data }    -- data URL（兼容旧订单）
const MAX_ORDER_AUDIOS = 3;
const MAX_AUDIO_DATA_LEN = 12 * 1024 * 1024; // 老 data URL 上限放宽到 ~8.5MB 原始；新走 R2 不受限
function sanitizeOrderAudios(audios) {
  if (!Array.isArray(audios)) return [];
  const out = [];
  for (const a of audios) {
    if (!a || typeof a !== 'object') continue;
    const url = typeof a.url === 'string' ? a.url : '';
    const data = typeof a.data === 'string' ? a.data : '';
    let payload = null;
    if (url && SELF_FILES_URL_RE.test(url) && url.length <= 500) {
      payload = { url };
    } else if (data && data.length <= MAX_AUDIO_DATA_LEN && /^data:audio\/[a-z0-9.+-]+;base64,/i.test(data)) {
      payload = { data };
    } else {
      continue;
    }
    const name = sanitizeStr(a.name, 120) || 'audio';
    const type = sanitizeStr(a.type, 60) || 'audio/mpeg';
    let size = Number(a.size);
    if (!isFinite(size) || size < 0) size = 0;
    if (size > 50 * 1024 * 1024) size = 50 * 1024 * 1024;
    out.push({ name, type, size, ...payload });
    if (out.length >= MAX_ORDER_AUDIOS) break;
  }
  return out;
}

// data URL → bytes（Worker 端解 base64）
function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2].replace(/\s+/g, '');
  let bin;
  try { bin = atob(b64); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
    'audio/webm': 'webm',
  };
  return map[m] || (m.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '').slice(0, 6) || 'bin';
}

const ORDER_STEPS = ['接单中', '沟通中', '编曲中', '待交付', '完结'];
const ORDER_TYPES = ['古风', 'Lo-fi', 'Folk', '新古典', '流行', '电子', '摇滚', 'R&B', '说唱', '其他'];
const ORDER_TIERS = [
  { key: 'basic', label: '基础', price: 299 },
  { key: 'standard', label: '进阶', price: 599 },
  { key: 'full', label: '全包', price: 999 },
];

// =============================================================
//  Auth + DM utilities (email-code login + user-to-admin DM)
// =============================================================

// Lowercase + trim email, basic format check
function normalizeEmail(s) {
  if (typeof s !== 'string') return '';
  const e = s.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(e)) return '';
  if (e.length > 200) return '';
  return e;
}

// SHA-256 hex (truncated for userId)
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function emailToUserId(email) {
  const h = await sha256Hex('uid:' + email);
  return h.slice(0, 16);
}

// Generate 6-digit numeric verification code
function gen6Code() {
  const arr = new Uint8Array(3);
  crypto.getRandomValues(arr);
  const n = ((arr[0] << 16) | (arr[1] << 8) | arr[2]) % 1000000;
  return String(n).padStart(6, '0');
}

// Generate 64-hex session token
function genToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mask email for display: ab***@xx.com
function maskEmail(e) {
  if (!e || typeof e !== 'string') return '';
  const at = e.indexOf('@');
  if (at < 1) return '***';
  const local = e.slice(0, at);
  const domain = e.slice(at);
  if (local.length <= 2) return local[0] + '***' + domain;
  return local.slice(0, 2) + '***' + domain;
}

// Send verification code via Resend (or no-op if not configured)
async function sendVerifyEmail(env, email, code) {
  if (!env.RESEND_API_KEY) {
    console.log('[auth] RESEND_API_KEY missing, code for', email, '=', code);
    return { ok: false, dev: true, code }; // dev mode: caller may surface
  }
  const from = env.MAIL_FROM || 'noreply@weilingt.top';
  const fromName = env.MAIL_FROM_NAME || '威灵T · Tracks & Notes';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,'Segoe UI',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#16140f;border:1px solid #322d25;border-radius:8px;overflow:hidden;">
    <tr><td style="background:#0a0a0a;padding:32px 32px 24px;text-align:center;border-bottom:3px solid #b8884a;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;color:#fefdfb;font-weight:900;letter-spacing:-1px;">威灵<em style="color:#e8654a;font-style:italic;">T</em></div>
      <div style="font-size:11px;color:#b8884a;letter-spacing:4px;text-transform:uppercase;margin-top:6px;">Tracks · Notes</div>
    </td></tr>
    <tr><td style="padding:32px;color:#e8e2d6;font-size:15px;line-height:1.7;">
      <p style="margin:0 0 16px;">你好，</p>
      <p style="margin:0 0 24px;">这是你登录 <a href="https://weilingt.top" style="color:#b8884a;text-decoration:none;">weilingt.top</a> 的验证码：</p>
      <div style="background:#0a0a0a;border:1px dashed #b8884a;border-radius:6px;padding:24px;text-align:center;margin:0 0 24px;">
        <div style="font-family:'SF Mono','Courier New',monospace;font-size:34px;color:#b8884a;letter-spacing:10px;font-weight:700;">${code}</div>
      </div>
      <p style="margin:0 0 8px;color:#9b9280;font-size:13px;">验证码 5 分钟内有效，请勿告诉他人。</p>
      <p style="margin:0;color:#9b9280;font-size:13px;">如果不是你本人操作，忽略此邮件即可。</p>
    </td></tr>
    <tr><td style="padding:16px 32px;border-top:1px solid #322d25;text-align:center;color:#5d574a;font-size:11px;letter-spacing:2px;">
      凡所听过 · 终将回响
    </td></tr>
  </table>
</td></tr></table></body></html>`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${from}>`,
      to: [email],
      subject: `威灵T · 登录验证码 ${code}`,
      html,
      text: `你的登录验证码：${code}\n5 分钟内有效，请勿告诉他人。\n\nweilingt.top`,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.log('[auth] resend failed', resp.status, t);
    return { ok: false, error: 'mail_send_failed' };
  }
  return { ok: true };
}

// Resolve current user from Bearer token (X-User-Token header for clarity)
async function getCurrentUser(request, env) {
  const h = request.headers.get('X-User-Token') || '';
  if (!h || h.length !== 64) return null;
  const raw = await env.BLOG.get('session/' + h, 'json');
  if (!raw || !raw.email) return null;
  const user = await env.BLOG.get('user/' + raw.email, 'json');
  if (!user) return null;
  return { ...user, token: h };
}

function sanitizeNickname(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 20);
  return t;
}

// Notify owner via Server Chan when user sends new DM
async function notifyNewDM(env, user, content) {
  if (!env.SERVERCHAN_KEY) return;
  // Skip push if admin is online (heartbeat within 90s)
  try {
    const online = await env.BLOG.get('admin/online', 'json');
    if (online && online.ts && Date.now() - online.ts < 90000) {
      console.log('[dm] admin online, skip serverchan');
      return;
    }
  } catch (e) { /* fall through and still notify */ }
  const title = `📨 新私信 · ${user.nickname || maskEmail(user.email)}`;
  const desp = [
    `**昵称**: ${user.nickname || '(未设置)'}`,
    `**邮箱**: ${maskEmail(user.email)}`,
    `**内容**:`,
    '',
    content.length > 300 ? content.slice(0, 300) + '...' : content,
    '',
    `---`,
    `时间: ${new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)} (Asia/Shanghai)`,
    `打开收件箱: https://weilingt.top/`,
  ].join('\n');
  try {
    await fetch('https://sctapi.ftqq.com/' + env.SERVERCHAN_KEY + '.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, desp }),
    });
  } catch (e) {
    console.log('[dm] serverchan failed', e);
  }
}

// Generate short message id
function genMsgId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// Update admin/threads index after a thread changes
async function updateAdminThreadsIndex(env, user, lastMsg, lastTs, unreadDelta) {
  const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
  const idx = list.findIndex(t => t.userId === user.userId);
  let item;
  if (idx >= 0) {
    item = list[idx];
    list.splice(idx, 1);
  } else {
    item = { userId: user.userId, email: user.email, nickname: user.nickname || '', unread: 0 };
  }
  // Always refresh email/nickname (nickname may change)
  item.email = user.email;
  item.nickname = user.nickname || '';
  item.lastMsg = (lastMsg || '').slice(0, 120);
  item.lastTs = lastTs;
  item.unread = Math.max(0, (item.unread || 0) + (unreadDelta || 0));
  list.unshift(item);
  // Cap at 500 threads (oldest dropped from KV index only; messages still in dm/thread/{userId})
  if (list.length > 500) list.length = 500;
  await env.BLOG.put('dm/admin/threads', JSON.stringify(list));
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request);
    try {
      return await handleRequest(request, env, ctx, cors);
    } catch (err) {
      // Catch-all: any uncaught exception still returns CORS headers
      // so browser can at least display the error instead of CORS-block.
      console.log('[fatal]', err && err.stack || err);
      return json({
        error: 'Internal Server Error',
        detail: (err && err.message) || String(err),
      }, 500, cors);
    }
  },
};

async function handleRequest(request, env, ctx, cors) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

    // ── R2 file reverse proxy ──
    // GET /files/orders/xxx/yyy.ext - 公开访问 R2 文件（订单图/音频）
    // 不在 /api 下，便于浏览器缓存；任意 Origin 都可 fetch（<img>/<audio> 直接拿）
    const filesMatch = path.match(/^\/files\/(.+)$/);
    if (filesMatch && method === 'GET') {
      if (!env.R2) return new Response('R2 not configured', { status: 500 });
      const key = decodeURIComponent(filesMatch[1]);
      // 安全校验：只允许 orders/ 前缀，禁止 .. 和过长 key
      if (key.length > 300 || /\.\./.test(key) || !/^orders\//.test(key)) {
        return new Response('Bad key', { status: 400 });
      }
      const obj = await env.R2.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      const headers = {
        'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      };
      if (obj.size != null) headers['Content-Length'] = String(obj.size);
      return new Response(obj.body, { status: 200, headers });
    }

    // ── R2 upload ──
    // POST /api/upload
    //   方式 A (推荐，新前端)：multipart/form-data，字段 file + kind + visitorId
    //   方式 B (兼容旧前端)：application/json，{ kind, data: 'data:...;base64,...', visitorId }
    // 返回: { ok, url, key, size, mime }
    if (path === '/api/upload' && method === 'POST') {
      if (!env.R2) return json({ error: 'R2 not configured' }, 500, cors);

      const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
      const isMultipart = ctype.startsWith('multipart/form-data');

      let kind, visitorId, bytes, mime;

      if (isMultipart) {
        let form;
        try { form = await request.formData(); }
        catch { return json({ error: 'Invalid form data' }, 400, cors); }

        kind = sanitizeStr(form.get('kind'), 16);
        visitorId = sanitizeStr(form.get('visitorId'), 64);
        const file = form.get('file');
        if (!file || typeof file === 'string') return json({ error: 'file required' }, 400, cors);

        mime = (file.type || '').toLowerCase();
        const buf = await file.arrayBuffer();
        bytes = new Uint8Array(buf);
      } else {
        let body;
        try { body = await request.json(); }
        catch { return json({ error: 'Invalid JSON' }, 400, cors); }
        kind = body && body.kind;
        visitorId = sanitizeStr(body && body.visitorId, 64);
        const dataUrl = typeof body.data === 'string' ? body.data : '';
        if (!dataUrl) return json({ error: 'data required' }, 400, cors);
        if (dataUrl.length > 20 * 1024 * 1024) return json({ error: 'Payload too large' }, 413, cors);
        const parsed = dataUrlToBytes(dataUrl);
        if (!parsed) return json({ error: 'Invalid data URL' }, 400, cors);
        bytes = parsed.bytes;
        mime = parsed.mime;
      }

      if (kind !== 'image' && kind !== 'audio') return json({ error: 'Invalid kind' }, 400, cors);
      if (!visitorId) return json({ error: 'visitorId required' }, 400, cors);

      // Rate limit: 单 visitor 每 60s 最多 12 次上传
      const rlKey = 'ratelimit/upload/' + visitorId;
      const rl = await env.BLOG.get(rlKey, 'json');
      if (rl && rl.count >= 12) return json({ error: 'Too many uploads, please wait' }, 429, cors);

      // 按 kind 校验 MIME + 大小
      if (kind === 'image') {
        if (!/^image\/(jpeg|jpg|png|gif|webp)$/i.test(mime)) return json({ error: 'Invalid image type' }, 400, cors);
        if (bytes.length > 2 * 1024 * 1024) return json({ error: 'Image too large' }, 413, cors); // 2MB
      } else {
        if (!/^audio\/[a-z0-9.+-]+$/i.test(mime)) return json({ error: 'Invalid audio type' }, 400, cors);
        if (bytes.length > 15 * 1024 * 1024) return json({ error: 'Audio too large' }, 413, cors); // 15MB
      }

      // Key: orders/{visitorHash8}/{ts}_{rand}.{ext}
      const visHash = (await sha256Hex(visitorId)).slice(0, 8);
      const ext = mimeToExt(mime);
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const key = `orders/${visHash}/${ts}_${rand}.${ext}`;

      await env.R2.put(key, bytes, {
        httpMetadata: { contentType: mime },
      });

      const newCount = (rl && rl.count ? rl.count : 0) + 1;
      await env.BLOG.put(rlKey, JSON.stringify({ count: newCount }), { expirationTtl: 60 });

      const origin = new URL(request.url).origin;
      const fileUrl = `${origin}/files/${key}`;

      return json({ ok: true, url: fileUrl, key, size: bytes.length, mime }, 200, cors);
    }

    // GET /api/data - public read (works + logs + about + comments + orders)
    // Order privacy:
    //   - Admin (Authorization Bearer): raw orders (contact + clientName intact, visitorId stripped)
    //   - Owner (userId matches via X-User-Token, OR legacy visitorId matches): see own order in full, marked _isMine
    //   - Other visitors: contact masked, clientName masked to first-char + ***
    // visitorId is NEVER returned to clients.
    if (path === '/api/data' && method === 'GET') {
      const data = await loadAll(env);
      if (Array.isArray(data.orders)) {
        const admin = await isAdminOrSub(request, env);
        const viewerId = request.headers.get('X-Visitor-Id') || '';
        // 优先 userId 维度认领订单（跨设备 / 跨浏览器都能识别）
        const viewerUser = await getCurrentUser(request, env);
        const viewerUserId = (viewerUser && viewerUser.userId) || '';
        data.orders = data.orders.map(o => {
          if (!o) return o;
          const mineByUser = !!viewerUserId && o.userId === viewerUserId;
          const mineByVisitor = !!viewerId && o.visitorId === viewerId;
          const mine = mineByUser || mineByVisitor;
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
    // super: full access (works/logs/about/logGroups)
    // sub: works/logs/logGroups only; "about" (含套餐价格) is silently ignored
    if (path === '/api/data' && method === 'PUT') {
      const role = await getRole(request, env);
      if (role !== 'super' && role !== 'sub') return json({ error: 'Unauthorized' }, 401, cors);
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const { works = [], logs = [], about = null, logGroups = null } = body || {};
      if (!Array.isArray(works) || !Array.isArray(logs)) {
        return json({ error: 'works and logs must be arrays' }, 400, cors);
      }
      // Sanitize log groups: [{id, name}], cap 50 groups, name <= 20 chars
      const safeGroups = Array.isArray(logGroups) ? logGroups.slice(0, 50).map(g => ({
        id: String((g && g.id) || '').slice(0, 32),
        name: sanitizeStr(g && g.name, 20),
      })).filter(g => g.id && g.name) : null;
      // Sub admin: forcefully discard "about" (含套餐价格)
      const aboutInput = (role === 'sub') ? null : about;
      const safeAbout = aboutInput && typeof aboutInput === 'object' ? (() => {
        const allowed = pickAllowedKeys(aboutInput);
        const allowedPlans = pickAllowedPlanKeys(aboutInput);
        return {
          intro: sanitizeStr(aboutInput.intro, 500),
          body1: sanitizeStr(aboutInput.body1, 2000),
          quote: sanitizeStr(aboutInput.quote, 500),
          body2: sanitizeStr(aboutInput.body2, 2000),
          tierKeys: allowed,
          tierPrices: sanitizeTierPrices(aboutInput.tierPrices, allowed),
          tierPriceModes: sanitizeTierPriceModes(aboutInput.tierPriceModes, allowed),
          tierDescs: sanitizeTierDescs(aboutInput.tierDescs, allowed),
          tierLabels: sanitizeTierLabels(aboutInput.tierLabels, allowed),
          planKeys: allowedPlans,
          planPrices: sanitizePlanPrices(aboutInput.planPrices, allowedPlans),
          planPriceModes: sanitizePlanPriceModes(aboutInput.planPriceModes, allowedPlans),
          planDescs: sanitizePlanDescs(aboutInput.planDescs, allowedPlans),
          planLabels: sanitizePlanLabels(aboutInput.planLabels, allowedPlans),
          planPeriods: sanitizePlanPeriods(aboutInput.planPeriods, allowedPlans),
        };
      })() : null;
      const serialized = JSON.stringify({ works, logs, about: safeAbout, logGroups: safeGroups });
      // KV 单 value 上限 25MB，留余量到 10MB。
      // 日志含内联 base64 图（Word 导入 / 截图粘贴）时体积会快速增长，
      // 旧上限 1MB 一次导入十几张图就会超，导致前端"图片消失"假象。
      if (serialized.length > 10 * 1024 * 1024) {
        return json({ error: 'Payload too large', size: serialized.length, limit: 10 * 1024 * 1024 }, 413, cors);
      }
      const tasks = [
        env.BLOG.put('works', JSON.stringify(works)),
        env.BLOG.put('logs', JSON.stringify(logs)),
      ];
      if (safeAbout) tasks.push(env.BLOG.put('about', JSON.stringify(safeAbout)));
      if (safeGroups) tasks.push(env.BLOG.put('logGroups', JSON.stringify(safeGroups)));
      await Promise.all(tasks);
      return json({ ok: true, savedAt: Date.now(), works: works.length, logs: logs.length, about: !!safeAbout, logGroups: safeGroups ? safeGroups.length : null, role }, 200, cors);
    }

    // ── Orders API ──

    // POST /api/orders - submit order (LOGIN REQUIRED for visitors; admin may bypass with explicit fields)
    if (path === '/api/orders' && method === 'POST') {
      // admin 持 Bearer 时允许走 body 传入 contact / clientName（补录场景）
      const adminBypass = await isAdminOrSub(request, env);
      // 普通访客必须登录（contact = user.email；clientName = user.nickname || email 前缀）
      const orderUser = adminBypass ? null : await getCurrentUser(request, env);
      if (!adminBypass && !orderUser) return json({ error: 'Login required' }, 401, cors);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const type = sanitizeStr(body && body.type, 20);
      // tier: single key 'basic' or combined 'basic+full' (multi-select)
      const tier = sanitizeStr(body && body.tier, 200);
      const description = sanitizeStr(body && body.description, 1000);
      const showName = !!body.showName;
      const visitorId = sanitizeStr(body && body.visitorId, 64);
      // contact / clientName：访客模式从用户资料注入；admin 模式从 body 拿（兼容补录）
      let contact, clientName, orderUserId;
      if (orderUser) {
        contact = orderUser.email;
        const nickRaw = sanitizeStr(orderUser.nickname || '', 30);
        const fallbackNick = (orderUser.email || '').split('@')[0].slice(0, 30);
        clientName = nickRaw || fallbackNick;
        orderUserId = orderUser.userId;
      } else {
        // admin 补录
        contact = sanitizeStr(body && body.contact, 200);
        clientName = sanitizeStr(body && body.clientName, 30);
        orderUserId = sanitizeStr(body && body.userId, 64) || '';
      }
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
      // 访客必须带 visitorId（限速维度）；admin 补录可跳过
      if (!adminBypass && !visitorId) return json({ error: 'visitorId required' }, 400, cors);

      // Rate limit: same visitor max 5 pending orders（admin 补录不限速）
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      if (!adminBypass) {
        const pendingByVisitor = visitorId ? orders.filter(o => o.visitorId === visitorId && o.step < 4).length : 0;
        const pendingByUser = orderUserId ? orders.filter(o => o.userId === orderUserId && o.step < 4).length : 0;
        if (Math.max(pendingByVisitor, pendingByUser) >= 5) return json({ error: 'Too many pending orders' }, 429, cors);
      }

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
      // Reference audios (data URLs, max 2, each <=~4MB binary)
      const audios = sanitizeOrderAudios(body && body.audios);

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
        audios,
        clientName: showName ? clientName : '',
        showName,
        visitorId,
        userId: orderUserId,  // 关联登录用户，PUT/owner 判定优先用 userId
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
        // ── 支付相关 ──
        paid: false,         // 是否已支付
        paidAt: null,        // 支付成功时间
        paidAmount: 0,       // 实付金额（元，整数）
        outTradeNo: '',      // 商户订单号（发起支付时生成，传给支付宝）
        tradeNo: '',         // 支付宝交易号（异步通知回填）
        payMethod: '',       // alipay / wechat / offline / ''
      };

      orders.push(order);
      // Size guard after adding new order (accommodate images)
      const ordersJson = JSON.stringify(orders);
      if (ordersJson.length > 20 * 1024 * 1024) {
        return json({ error: 'Orders storage full' }, 413, cors);
      }
      await env.BLOG.put('orders', ordersJson);
      // 异步推送微信通知，不阻塞响应（Server 酱挂了也不影响下单）
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(notifyNewOrder(env, order));
      } else {
        notifyNewOrder(env, order).catch(() => {});
      }
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
      const admin = await isAdminOrSub(request, env);
      const viewerId = request.headers.get('X-Visitor-Id') || '';
      // Owner 判定：优先 userId 维度（新订单都有 userId），其次回退老 visitorId 维度（老订单兼容）
      const ownerUser = await getCurrentUser(request, env);
      const matchUser = !!ownerUser && !!order.userId && order.userId === ownerUser.userId;
      const matchVisitor = !!viewerId && order.visitorId === viewerId;
      const isOwner = !admin && (matchUser || matchVisitor);

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
        // Admin 可手动标记/取消支付状态（线下收款 / 退款场景）
        if (body.paid !== undefined) {
          if (body.paid) {
            order.paid = true;
            order.paidAt = order.paidAt || Date.now();
            order.paidAmount = order.paidAmount || (order.price || 0);
            order.payMethod = order.payMethod || 'offline';
          } else {
            order.paid = false;
            order.paidAt = null;
            order.paidAmount = 0;
            order.tradeNo = '';
            order.payMethod = '';
          }
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

      // Owner — in-progress order: description / showName 仅可改这两项
      // contact / clientName 由用户资料自动关联，不允许在订单上手动改
      if (isOwner && order.step !== 4) {
        if (body.description !== undefined) order.description = sanitizeStr(body.description, 1000);
        if (body.showName !== undefined) order.showName = !!body.showName;
      }

      await env.BLOG.put('orders', JSON.stringify(orders));
      // Strip visitorId from response; caller already knows their own scope
      const { visitorId: _vid, ...safeOrder } = order;
      return json({ ok: true, order: safeOrder }, 200, cors);
    }

    // DELETE /api/orders/:orderId - admin delete order
    if (orderPutMatch && method === 'DELETE') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const orderId = orderPutMatch[1];
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx < 0) return json({ error: 'Order not found' }, 404, cors);
      orders.splice(idx, 1);
      await env.BLOG.put('orders', JSON.stringify(orders));
      return json({ ok: true }, 200, cors);
    }

    // ── 支付 API ──────────────────────────────────────────
    // POST /api/pay/create —— 客户为某订单发起支付，返回二维码 URL
    if (path === '/api/pay/create' && method === 'POST') {
      if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY) {
        return json({ error: '支付未配置（缺少 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY）' }, 503, cors);
      }
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const orderId = sanitizeStr(body && body.orderId, 80);
      if (!orderId) return json({ error: 'orderId required' }, 400, cors);
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx < 0) return json({ error: 'Order not found' }, 404, cors);
      const order = orders[idx];

      // owner 鉴权：必须是订单本人或 admin
      const admin = await isAdminOrSub(request, env);
      const viewerId = request.headers.get('X-Visitor-Id') || '';
      const ownerUser = await getCurrentUser(request, env);
      const matchUser = !!ownerUser && !!order.userId && order.userId === ownerUser.userId;
      const matchVisitor = !!viewerId && order.visitorId === viewerId;
      if (!admin && !matchUser && !matchVisitor) return json({ error: '请先登录后再支付' }, 401, cors);

      if (order.paid) return json({ error: '该订单已支付' }, 400, cors);
      if (!order.price || order.price <= 0) return json({ error: '订单金额未确定，请联系店主报价' }, 400, cors);
      if (order.priceMode === 'from') return json({ error: '起步价订单需要店主确认最终价格后才能支付' }, 400, cors);

      // 商户订单号：每次发起支付都新生成（用户多次扫码不冲突；老的会自动失效）
      const outTradeNo = 'BMP' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const subject = `编曲订单 #${String(order.seq || 0).padStart(3, '0')} - ${order.tierLabel || order.tier || ''}`.slice(0, 60);
      const notifyUrl = env.ALIPAY_NOTIFY_URL || 'https://api.weilingt.top/api/pay/notify';
      try {
        const resp = await alipayCall('alipay.trade.precreate', {
          out_trade_no: outTradeNo,
          total_amount: Number(order.price).toFixed(2),
          subject,
          timeout_express: '15m',
        }, env, { notifyUrl });
        if (resp.code !== '10000') {
          return json({ error: '支付宝下单失败', detail: resp.sub_msg || resp.msg || JSON.stringify(resp).slice(0, 200) }, 502, cors);
        }
        // 回写订单：记录本次商户订单号（多次发起会覆盖）
        order.outTradeNo = outTradeNo;
        await env.BLOG.put('orders', JSON.stringify(orders));
        return json({ ok: true, qrCode: resp.qr_code, outTradeNo, amount: order.price, subject }, 200, cors);
      } catch (e) {
        return json({ error: '支付宝调用异常', detail: String(e).slice(0, 200) }, 502, cors);
      }
    }

    // GET /api/pay/query?orderId=xxx —— 前端轮询订单支付状态（仅本人/admin）
    if (path === '/api/pay/query' && method === 'GET') {
      const orderId = url.searchParams.get('orderId') || '';
      if (!orderId) return json({ error: 'orderId required' }, 400, cors);
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const order = orders.find(o => o.id === orderId);
      if (!order) return json({ error: 'Order not found' }, 404, cors);
      const admin = await isAdminOrSub(request, env);
      const viewerId = request.headers.get('X-Visitor-Id') || '';
      const ownerUser = await getCurrentUser(request, env);
      const matchUser = !!ownerUser && !!order.userId && order.userId === ownerUser.userId;
      const matchVisitor = !!viewerId && order.visitorId === viewerId;
      if (!admin && !matchUser && !matchVisitor) return json({ error: 'Unauthorized' }, 401, cors);
      // 主动查支付宝（应对异步通知未送达 / 延迟的兜底）
      let synced = false;
      if (!order.paid && order.outTradeNo && env.ALIPAY_APP_ID && env.ALIPAY_PRIVATE_KEY) {
        try {
          const resp = await alipayCall('alipay.trade.query', { out_trade_no: order.outTradeNo }, env);
          if (resp.code === '10000' && (resp.trade_status === 'TRADE_SUCCESS' || resp.trade_status === 'TRADE_FINISHED')) {
            order.paid = true;
            order.paidAt = Date.now();
            order.paidAmount = Math.floor(Number(resp.total_amount) || order.price || 0);
            order.tradeNo = resp.trade_no || '';
            order.payMethod = 'alipay';
            await env.BLOG.put('orders', JSON.stringify(orders));
            synced = true;
          }
        } catch (_) { /* 查询失败不阻塞 */ }
      }
      return json({
        ok: true,
        paid: !!order.paid,
        paidAt: order.paidAt || null,
        paidAmount: order.paidAmount || 0,
        payMethod: order.payMethod || '',
        synced,
      }, 200, cors);
    }

    // POST /api/pay/notify —— 支付宝异步通知回调（form-urlencoded）
    if (path === '/api/pay/notify' && method === 'POST') {
      if (!env.ALIPAY_PUBLIC_KEY) return new Response('failure', { status: 200, headers: cors });
      let formText;
      try { formText = await request.text(); }
      catch { return new Response('failure', { status: 200, headers: cors }); }
      const params = {};
      formText.split('&').forEach(kv => {
        const i = kv.indexOf('=');
        if (i < 0) return;
        const k = decodeURIComponent(kv.slice(0, i));
        const v = decodeURIComponent(kv.slice(i + 1));
        params[k] = v;
      });
      const sign = params.sign || '';
      const signType = params.sign_type || 'RSA2';
      // 验签内容：排除 sign / sign_type，剩余按 key 字典序拼接（注意保留原始值，不再 urlencode）
      const verifyParams = { ...params };
      delete verifyParams.sign;
      delete verifyParams.sign_type;
      const verifyContent = Object.keys(verifyParams)
        .filter(k => verifyParams[k] !== undefined && verifyParams[k] !== null && verifyParams[k] !== '')
        .sort()
        .map(k => `${k}=${verifyParams[k]}`)
        .join('&');
      const ok = await alipayVerify(verifyContent, sign, env.ALIPAY_PUBLIC_KEY);
      if (!ok) return new Response('failure', { status: 200, headers: cors });
      // 校验 app_id
      if (env.ALIPAY_APP_ID && params.app_id !== env.ALIPAY_APP_ID) {
        return new Response('failure', { status: 200, headers: cors });
      }
      // 状态校验
      const tradeStatus = params.trade_status || '';
      if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
        return new Response('success', { status: 200, headers: cors }); // 非成功也回 success 防重推
      }
      const outTradeNo = params.out_trade_no || '';
      if (!outTradeNo) return new Response('failure', { status: 200, headers: cors });
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const order = orders.find(o => o.outTradeNo === outTradeNo);
      if (!order) return new Response('success', { status: 200, headers: cors }); // 找不到也回 success（已被 admin 删）
      if (!order.paid) {
        order.paid = true;
        order.paidAt = Date.now();
        order.paidAmount = Math.floor(Number(params.total_amount) || order.price || 0);
        order.tradeNo = params.trade_no || '';
        order.payMethod = 'alipay';
        await env.BLOG.put('orders', JSON.stringify(orders));
        // 异步推送通知（不阻塞回调响应；支付宝 3 秒不返回 success 会重推）
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(notifyOrderPaid(env, order).catch(() => {}));
        }
      }
      return new Response('success', { status: 200, headers: cors });
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
      const admin = await isAdminOrSub(request, env);
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

    // =============================================================
    //  Auth endpoints (email verification code login)
    // =============================================================

    // POST /api/auth/send-code — send 6-digit code to email
    if (path === '/api/auth/send-code' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const email = normalizeEmail(body.email);
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      // Rate limit: 60s between sends per email
      const rl = await env.BLOG.get('ratelimit/code/' + email, 'json');
      if (rl && Date.now() - rl.ts < 60000) {
        return json({ error: 'Too frequent, try later', retryAfter: Math.ceil((60000 - (Date.now() - rl.ts)) / 1000) }, 429, cors);
      }
      const code = gen6Code();
      const mailResult = await sendVerifyEmail(env, email, code);
      // Store code with 5-min TTL
      await env.BLOG.put('code/' + email, JSON.stringify({ code, attempts: 0, ts: Date.now() }), { expirationTtl: 300 });
      // Store rate limit marker (90s TTL, slightly longer than cooldown)
      await env.BLOG.put('ratelimit/code/' + email, JSON.stringify({ ts: Date.now() }), { expirationTtl: 90 });
      // In dev mode (no Resend key), surface code so frontend can show it
      if (mailResult.dev) {
        return json({ ok: true, dev: true, code }, 200, cors);
      }
      if (!mailResult.ok) {
        return json({ error: 'Failed to send email' }, 500, cors);
      }
      return json({ ok: true }, 200, cors);
    }

    // POST /api/auth/login — verify code, create session
    if (path === '/api/auth/login' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const email = normalizeEmail(body.email);
      const code = String(body.code || '').trim();
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      if (!/^\d{6}$/.test(code)) return json({ error: 'Code must be 6 digits' }, 400, cors);
      const stored = await env.BLOG.get('code/' + email, 'json');
      if (!stored) return json({ error: 'Code expired or not sent' }, 400, cors);
      if (stored.attempts >= 5) return json({ error: 'Too many attempts, please request new code' }, 429, cors);
      stored.attempts++;
      if (stored.code !== code) {
        await env.BLOG.put('code/' + email, JSON.stringify(stored), { expirationTtl: 300 });
        return json({ error: 'Wrong code', attemptsLeft: 5 - stored.attempts }, 400, cors);
      }
      // Code correct — delete it
      await env.BLOG.delete('code/' + email);
      // Upsert user
      const userId = await emailToUserId(email);
      let user = await env.BLOG.get('user/' + email, 'json');
      if (!user) {
        user = { email, userId, nickname: '', createdAt: Date.now(), lastLogin: Date.now() };
      } else {
        user.lastLogin = Date.now();
      }
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      // Create session (30-day TTL)
      const token = genToken();
      await env.BLOG.put('session/' + token, JSON.stringify({ email }), { expirationTtl: 30 * 86400 });
      // Determine role
      let role = 'user';
      if (email === SUPER_ADMIN_EMAIL) role = 'super';
      else if (await isSubAdminEmail(env, email)) role = 'sub';
      return json({ ok: true, token, user: { email: user.email, userId: user.userId, nickname: user.nickname }, role }, 200, cors);
    }

    // GET /api/auth/me — get current user info
    if (path === '/api/auth/me' && method === 'GET') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      let role = 'user';
      if (user.email === SUPER_ADMIN_EMAIL) role = 'super';
      else if (await isSubAdminEmail(env, user.email)) role = 'sub';
      return json({ email: user.email, userId: user.userId, nickname: user.nickname, role }, 200, cors);
    }

    // POST /api/auth/logout — invalidate session
    if (path === '/api/auth/logout' && method === 'POST') {
      const h = request.headers.get('X-User-Token') || '';
      if (h) await env.BLOG.delete('session/' + h);
      return json({ ok: true }, 200, cors);
    }

    // PUT /api/auth/profile — update nickname
    if (path === '/api/auth/profile' && method === 'PUT') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const nickname = sanitizeNickname(body.nickname);
      user.nickname = nickname;
      await env.BLOG.put('user/' + user.email, JSON.stringify(user));
      return json({ ok: true, nickname }, 200, cors);
    }

    // =============================================================
    //  DM endpoints (user ↔ admin private messaging)
    // =============================================================

    // POST /api/dm/send — user sends message to admin
    if (path === '/api/dm/send' && method === 'POST') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      // Rate limit: 1 message per 3s per user
      const rl = await env.BLOG.get('ratelimit/dm/' + user.userId, 'json');
      if (rl && Date.now() - rl.ts < 3000) {
        return json({ error: 'Too frequent' }, 429, cors);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const content = sanitizeStr(body.content, 2000);
      const imageUrl = sanitizeStr(body.imageUrl, 500);
      // 至少要有文本或图片之一
      if (!content && !imageUrl) return json({ error: 'Message cannot be empty' }, 400, cors);
      // 安全：imageUrl 必须是同源 /files/ 或允许的反代域
      if (imageUrl && !/^https?:\/\/[^/]+\/files\//.test(imageUrl)) {
        return json({ error: 'Invalid imageUrl' }, 400, cors);
      }
      const threadKey = 'dm/thread/' + user.userId;
      const thread = (await env.BLOG.get(threadKey, 'json')) || [];
      const msg = { id: genMsgId(), from: 'user', content, ts: Date.now() };
      if (imageUrl) msg.imageUrl = imageUrl;
      thread.push(msg);
      // Cap thread at 1000 messages (drop oldest)
      if (thread.length > 1000) thread.splice(0, thread.length - 1000);
      await env.BLOG.put(threadKey, JSON.stringify(thread));
      // KV expirationTtl minimum is 60s; rate limit logic still uses 3s window via ts
      await env.BLOG.put('ratelimit/dm/' + user.userId, JSON.stringify({ ts: Date.now() }), { expirationTtl: 60 });
      // Update admin index (+1 unread)
      const preview = content || '[图片]';
      await updateAdminThreadsIndex(env, user, preview, Date.now(), 1);
      // Notify admin via Server Chan
      ctx.waitUntil(notifyNewDM(env, user, preview));
      return json({ ok: true, msg }, 200, cors);
    }

    // GET /api/dm/thread — user gets own conversation thread
    if (path === '/api/dm/thread' && method === 'GET') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      const thread = (await env.BLOG.get('dm/thread/' + user.userId, 'json')) || [];
      return json({ messages: thread }, 200, cors);
    }

    // GET /api/dm/unread — user checks unread count (admin replies)
    if (path === '/api/dm/unread' && method === 'GET') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      const thread = (await env.BLOG.get('dm/thread/' + user.userId, 'json')) || [];
      // Count admin messages newer than last user message (or all if user never sent)
      let lastUserTs = 0;
      for (let i = thread.length - 1; i >= 0; i--) {
        if (thread[i].from === 'user') { lastUserTs = thread[i].ts; break; }
      }
      const unread = thread.filter(m => m.from === 'admin' && m.ts > lastUserTs).length;
      return json({ unread }, 200, cors);
    }

    // POST /api/dm/recall — user recalls own message (within 2 min window)
    // body: { msgId }
    if (path === '/api/dm/recall' && method === 'POST') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const msgId = String(body.msgId || '').trim();
      if (!msgId) return json({ error: 'Invalid msgId' }, 400, cors);
      const threadKey = 'dm/thread/' + user.userId;
      const thread = (await env.BLOG.get(threadKey, 'json')) || [];
      const target = thread.find(m => m.id === msgId);
      if (!target) return json({ error: '消息不存在' }, 404, cors);
      if (target.recalled) return json({ error: '已撤回' }, 400, cors);
      if (target.from !== 'user') return json({ error: '只能撤回自己的消息' }, 403, cors);
      if (Date.now() - target.ts > 120000) return json({ error: '超过 2 分钟，无法撤回' }, 400, cors);
      target.recalled = true;
      target.content = '';
      await env.BLOG.put(threadKey, JSON.stringify(thread));
      // 若撤回的是最后一条 → 更新索引 lastMsg
      if (thread[thread.length - 1] && thread[thread.length - 1].id === msgId) {
        const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
        const item = list.find(t => t.userId === user.userId);
        if (item) { item.lastMsg = '[消息已撤回]'; await env.BLOG.put('dm/admin/threads', JSON.stringify(list)); }
      }
      return json({ ok: true, msg: target }, 200, cors);
    }

    // =============================================================
    //  Admin DM endpoints (admin reads/replies to user conversations)
    // =============================================================

    // GET /api/admin/dm/threads — list all DM threads (super + sub)
    if (path === '/api/admin/dm/threads' && method === 'GET') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
      return json({ threads: list }, 200, cors);
    }

    // GET /api/admin/dm/thread/:userId — get a specific user's conversation (super + sub)
    if (path.startsWith('/api/admin/dm/thread/') && method === 'GET') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const targetUserId = path.slice('/api/admin/dm/thread/'.length);
      if (!targetUserId || targetUserId.length > 32) return json({ error: 'Invalid userId' }, 400, cors);
      const thread = (await env.BLOG.get('dm/thread/' + targetUserId, 'json')) || [];
      return json({ messages: thread }, 200, cors);
    }

    // POST /api/admin/dm/reply — admin replies to a user (super + sub)
    if (path === '/api/admin/dm/reply' && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const targetUserId = String(body.userId || '').trim();
      const content = sanitizeStr(body.content, 2000);
      const imageUrl = sanitizeStr(body.imageUrl, 500);
      if (!targetUserId || targetUserId.length > 32) return json({ error: 'Invalid userId' }, 400, cors);
      if (!content && !imageUrl) return json({ error: 'Message cannot be empty' }, 400, cors);
      if (imageUrl && !/^https?:\/\/[^/]+\/files\//.test(imageUrl)) {
        return json({ error: 'Invalid imageUrl' }, 400, cors);
      }
      const threadKey = 'dm/thread/' + targetUserId;
      const thread = (await env.BLOG.get(threadKey, 'json')) || [];
      // 当前管理员身份（用于撤回时校验"只能撤回自己的"）
      const me = await getCurrentUser(request, env);
      const byEmail = (me && me.email) ? me.email : 'admin';
      const msg = { id: genMsgId(), from: 'admin', byEmail, content, ts: Date.now() };
      if (imageUrl) msg.imageUrl = imageUrl;
      thread.push(msg);
      if (thread.length > 1000) thread.splice(0, thread.length - 1000);
      await env.BLOG.put(threadKey, JSON.stringify(thread));
      // Update admin index: clear unread for this thread (admin just replied)
      const userStub = { userId: targetUserId, email: '', nickname: '' };
      // Try to get real user info from existing index
      const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
      const existing = list.find(t => t.userId === targetUserId);
      if (existing) { userStub.email = existing.email; userStub.nickname = existing.nickname; }
      const preview = content || '[图片]';
      await updateAdminThreadsIndex(env, userStub, preview, Date.now(), 0);
      // Reset unread to 0 since admin just replied
      const list2 = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
      const item = list2.find(t => t.userId === targetUserId);
      if (item) { item.unread = 0; await env.BLOG.put('dm/admin/threads', JSON.stringify(list2)); }
      return json({ ok: true, msg }, 200, cors);
    }

    // POST /api/admin/dm/mark-read — mark a thread as read (super + sub)
    if (path === '/api/admin/dm/mark-read' && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const targetUserId = String(body.userId || '').trim();
      if (!targetUserId) return json({ error: 'Invalid userId' }, 400, cors);
      const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
      const item = list.find(t => t.userId === targetUserId);
      if (item) { item.unread = 0; await env.BLOG.put('dm/admin/threads', JSON.stringify(list)); }
      return json({ ok: true }, 200, cors);
    }

    // POST /api/admin/dm/recall — admin recalls own admin-message (within 2 min)
    // body: { userId, msgId }
    // 只能撤回自己发的：msg.byEmail === 当前管理员 email；若 msg 无 byEmail（历史数据）默认允许 admin 组互撤
    if (path === '/api/admin/dm/recall' && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const targetUserId = String(body.userId || '').trim();
      const msgId = String(body.msgId || '').trim();
      if (!targetUserId || targetUserId.length > 32) return json({ error: 'Invalid userId' }, 400, cors);
      if (!msgId) return json({ error: 'Invalid msgId' }, 400, cors);
      const threadKey = 'dm/thread/' + targetUserId;
      const thread = (await env.BLOG.get(threadKey, 'json')) || [];
      const target = thread.find(m => m.id === msgId);
      if (!target) return json({ error: '消息不存在' }, 404, cors);
      if (target.recalled) return json({ error: '已撤回' }, 400, cors);
      if (target.from !== 'admin') return json({ error: '只能撤回自己的消息' }, 403, cors);
      // 校验"只能撤自己的"：若有 byEmail，必须匹配当前操作者；否则放行（兼容历史无 byEmail 的旧消息）
      if (target.byEmail) {
        const me = await getCurrentUser(request, env);
        const myEmail = me && me.email;
        if (!myEmail || myEmail !== target.byEmail) return json({ error: '只能撤回自己的消息' }, 403, cors);
      }
      if (Date.now() - target.ts > 120000) return json({ error: '超过 2 分钟，无法撤回' }, 400, cors);
      target.recalled = true;
      target.content = '';
      await env.BLOG.put(threadKey, JSON.stringify(thread));
      if (thread[thread.length - 1] && thread[thread.length - 1].id === msgId) {
        const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
        const item = list.find(t => t.userId === targetUserId);
        if (item) { item.lastMsg = '[消息已撤回]'; await env.BLOG.put('dm/admin/threads', JSON.stringify(list)); }
      }
      return json({ ok: true, msg: target }, 200, cors);
    }

    // POST /api/admin/dm/thread/:userId/clear — clear messages but keep thread entry (super + sub)
    // 仅清空消息内容（dm/thread/{id} 置空数组），保留 dm/admin/threads 中的索引条目并把 lastMsg 清掉
    if (path.startsWith('/api/admin/dm/thread/') && path.endsWith('/clear') && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const targetUserId = path.slice('/api/admin/dm/thread/'.length, -'/clear'.length);
      if (!targetUserId || targetUserId.length > 32) return json({ error: 'Invalid userId' }, 400, cors);
      await env.BLOG.put('dm/thread/' + targetUserId, JSON.stringify([]));
      const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
      const item = list.find(t => t.userId === targetUserId);
      if (item) {
        item.lastMsg = '';
        item.unread = 0;
        item.lastTs = Date.now();
        await env.BLOG.put('dm/admin/threads', JSON.stringify(list));
      }
      return json({ ok: true }, 200, cors);
    }

    // DELETE /api/admin/dm/thread/:userId — delete an entire conversation (super + sub)
    // 删除消息历史 + 从 dm/admin/threads 索引数组移除该 userId
    if (path.startsWith('/api/admin/dm/thread/') && method === 'DELETE') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const targetUserId = path.slice('/api/admin/dm/thread/'.length);
      if (!targetUserId || targetUserId.length > 32) return json({ error: 'Invalid userId' }, 400, cors);
      await env.BLOG.delete('dm/thread/' + targetUserId);
      const list = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
      const filtered = list.filter(t => t.userId !== targetUserId);
      if (filtered.length !== list.length) {
        await env.BLOG.put('dm/admin/threads', JSON.stringify(filtered));
      }
      return json({ ok: true }, 200, cors);
    }

    // POST /api/admin/heartbeat — admin (super or sub) pings to mark "店主侧在线"
    // notifyNewDM skips Server Chan push when admin/online is fresh (TTL 90s)
    // 副管理员在线也算"店主侧"——可以代为响应，无需打扰主人微信
    if (path === '/api/admin/heartbeat' && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const ts = Date.now();
      await env.BLOG.put('admin/online', JSON.stringify({ ts }), { expirationTtl: 90 });
      return json({ ok: true, ts }, 200, cors);
    }

    // =============================================================
    //  Sub-admin management (super only)
    // =============================================================

    // GET /api/admin/subadmins — list sub admins (super only)
    if (path === '/api/admin/subadmins' && method === 'GET') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const list = await getSubAdmins(env);
      return json({ subadmins: list }, 200, cors);
    }

    // POST /api/admin/subadmins — add a sub admin (super only)
    if (path === '/api/admin/subadmins' && method === 'POST') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const email = normalizeEmail(body.email);
      const note = sanitizeStr(body.note, 50);
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      if (email === SUPER_ADMIN_EMAIL) return json({ error: '不能把主管理员邮箱设为副管理员' }, 400, cors);
      const list = await getSubAdmins(env);
      if (list.some(s => s.email === email)) return json({ error: '该邮箱已是副管理员' }, 400, cors);
      if (list.length >= 20) return json({ error: '副管理员上限 20 个' }, 400, cors);
      list.push({ email, note, addedAt: Date.now() });
      await env.BLOG.put('admin/subadmins', JSON.stringify(list));
      return json({ ok: true, subadmins: list }, 200, cors);
    }

    // DELETE /api/admin/subadmins/:email — remove a sub admin (super only)
    const subDelMatch = path.match(/^\/api\/admin\/subadmins\/(.+)$/);
    if (subDelMatch && method === 'DELETE') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const email = normalizeEmail(decodeURIComponent(subDelMatch[1]));
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      const list = await getSubAdmins(env);
      const next = list.filter(s => s.email !== email);
      if (next.length === list.length) return json({ error: 'Not found' }, 404, cors);
      await env.BLOG.put('admin/subadmins', JSON.stringify(next));
      return json({ ok: true, subadmins: next }, 200, cors);
    }

    // =============================================================
    //  User management (super + sub)
    // =============================================================

    // GET /api/admin/users — list all registered users
    if (path === '/api/admin/users' && method === 'GET') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const users = [];
      let cursor;
      do {
        const r = await env.BLOG.list({ prefix: 'user/', cursor, limit: 1000 });
        for (const k of r.keys) {
          const u = await env.BLOG.get(k.name, 'json');
          if (u && u.email) users.push(u);
        }
        cursor = r.list_complete ? undefined : r.cursor;
      } while (cursor);
      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      // 标记角色
      const subList = await getSubAdmins(env);
      const subEmails = new Set(subList.map(s => s.email));
      for (const u of users) {
        u.role = u.email === SUPER_ADMIN_EMAIL ? 'super' : (subEmails.has(u.email) ? 'sub' : 'user');
      }
      return json({ users }, 200, cors);
    }

    // POST /api/admin/users — admin manually creates a user
    if (path === '/api/admin/users' && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const email = normalizeEmail(body.email);
      const nickname = sanitizeNickname(body.nickname || '');
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      const existing = await env.BLOG.get('user/' + email, 'json');
      if (existing) return json({ error: '该邮箱已注册' }, 400, cors);
      const userId = await emailToUserId(email);
      const user = { email, userId, nickname, createdAt: Date.now(), lastLogin: 0 };
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      return json({ ok: true, user }, 200, cors);
    }

    // PATCH /api/admin/users/:email — update user nickname
    const userMgmtMatch = path.match(/^\/api\/admin\/users\/(.+)$/);
    if (userMgmtMatch && method === 'PATCH') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const email = normalizeEmail(decodeURIComponent(userMgmtMatch[1]));
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const user = await env.BLOG.get('user/' + email, 'json');
      if (!user) return json({ error: 'Not found' }, 404, cors);
      if (typeof body.nickname === 'string') user.nickname = sanitizeNickname(body.nickname);
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      return json({ ok: true, user }, 200, cors);
    }

    // DELETE /api/admin/users/:email — delete user and associated data
    if (userMgmtMatch && method === 'DELETE') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const email = normalizeEmail(decodeURIComponent(userMgmtMatch[1]));
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      if (email === SUPER_ADMIN_EMAIL) return json({ error: '不能删除主管理员账号' }, 400, cors);
      const me = await getCurrentUser(request, env);
      if (me && me.email === email) return json({ error: '不能删除自己的账号' }, 400, cors);
      if (await isSubAdminEmail(env, email)) return json({ error: '该邮箱是副管理员，请先在副管理员管理里移除' }, 400, cors);
      const user = await env.BLOG.get('user/' + email, 'json');
      if (!user) return json({ error: 'Not found' }, 404, cors);
      await env.BLOG.delete('user/' + email);
      if (user.userId) {
        await env.BLOG.delete('dm/thread/' + user.userId);
        const tlist = (await env.BLOG.get('dm/admin/threads', 'json')) || [];
        const filtered = tlist.filter(t => t.userId !== user.userId);
        if (filtered.length !== tlist.length) {
          await env.BLOG.put('dm/admin/threads', JSON.stringify(filtered));
        }
      }
      return json({ ok: true }, 200, cors);
    }

    if (path === '/' || path === '/health') {
      return json({ status: 'ok', service: 'blog-music-api' }, 200, cors);
    }

    return json({ error: 'Not Found' }, 404, cors);
}
