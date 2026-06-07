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

// 客户声明已付款（线下扫码转账模式），推送 Server 酱通知店主到 admin 端核对到账后确认
async function notifyOrderClaimed(env, order) {
  if (!env.SERVERCHAN_KEY) return;
  try {
    const seqStr = String(order.seq || 0).padStart(3, '0');
    const tierLabel = order.tierLabel || order.tier || '';
    const amount = order.claimedAmount || order.price || 0;
    const showName = order.showName ? (order.clientName || '匿名') : '匿名';
    const note = order.claimNote ? `\n- **客户备注**：${order.claimNote}` : '';
    const timeStr = new Date(order.claimedAt || Date.now())
      .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const title = `⏳ 待确认收款 ¥${amount} · 订单 #${seqStr}`;
    const desp = [
      `### 客户声明已付款，请去 admin 端核对支付宝/微信到账后点「确认收款」`,
      '',
      `- **挂名**：${showName}`,
      `- **套餐**：${tierLabel}`,
      `- **声明金额**：¥${amount}`,
      `- **联系方式**：${order.contact || '-'}` + note,
      '',
      `---`,
      `🕐 ${timeStr}`,
      `🔗 https://weilingt.top （登录 admin 后到工坊确认收款）`,
    ].join('\n');
    const apiUrl = `https://sctapi.ftqq.com/${env.SERVERCHAN_KEY}.send`;
    const body = new URLSearchParams({ title, desp });
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    console.error('notifyOrderClaimed failed:', e && e.message);
  }
}

const DEFAULT_ABOUT = {
  intro: '',
  body1: '',
  quote: '',
  body2: '',
  // ── 个人收款码（线下扫码转账模式，bb7d19d 之外的兜底支付方案，2026-06-05 加） ──
  qrAlipay: '',     // 支付宝个人收款码图片 URL / dataURL
  qrWechat: '',     // 微信个人收款码图片 URL / dataURL
  qrPayNote: '',    // 收款提示文案（如「请备注订单号」）
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

// Whitelist order deliverables: 接单成品交付文件白名单
//   仅新格式：{ name, type, size, key, url, uploadedAt, lastDownloadAt }
//   admin 上传后写入；客户付款后可下载；不限格式/不限次数，单文件 ≤ 200MB
const MAX_ORDER_DELIVERABLES = 8;
function sanitizeOrderDeliverables(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    const key = typeof a.key === 'string' ? a.key : '';
    if (!key || key.length > 300 || !/^orders\/[a-zA-Z0-9_\-./]+$/.test(key)) continue;
    const url = typeof a.url === 'string' && a.url.length <= 500 ? a.url : '';
    const name = sanitizeStr(a.name, 200) || 'deliverable';
    const type = sanitizeStr(a.type, 100) || 'application/octet-stream';
    let size = Number(a.size);
    if (!isFinite(size) || size < 0) size = 0;
    if (size > 500 * 1024 * 1024) size = 500 * 1024 * 1024;
    let uploadedAt = Number(a.uploadedAt);
    if (!isFinite(uploadedAt) || uploadedAt <= 0) uploadedAt = Date.now();
    let lastDownloadAt = Number(a.lastDownloadAt);
    if (!isFinite(lastDownloadAt) || lastDownloadAt <= 0) lastDownloadAt = 0;
    out.push({ name, type, size, key, url, uploadedAt, lastDownloadAt });
    if (out.length >= MAX_ORDER_DELIVERABLES) break;
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

// ── Password hashing (PBKDF2-SHA256, 100k iterations) ──
// Stored format: "pbkdf2$100000$<salt_hex>$<hash_hex>"; salt 16B, hash 32B
const PBKDF2_ITER = 100000;
const PBKDF2_SALT_LEN = 16;
const PBKDF2_HASH_LEN = 32;

function _bytesToHex(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
function _hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function _pbkdf2(password, salt, iter, hashLen) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    key, hashLen * 8
  );
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = new Uint8Array(PBKDF2_SALT_LEN);
  crypto.getRandomValues(salt);
  const hash = await _pbkdf2(password, salt, PBKDF2_ITER, PBKDF2_HASH_LEN);
  return `pbkdf2$${PBKDF2_ITER}$${_bytesToHex(salt)}$${_bytesToHex(hash)}`;
}
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const salt = _hexToBytes(parts[2]);
  const expected = _hexToBytes(parts[3]);
  if (!iter || salt.length === 0 || expected.length === 0) return false;
  const got = await _pbkdf2(password, salt, iter, expected.length);
  // 常量时间比较
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  return diff === 0;
}
// 生成 10 位安全可读临时密码（避开易混淆字符）
function genTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}
// 密码强度校验：≥ 6 位、≤ 64 位、不能含空白；返回 '' 表示通过，否则返回错误描述
function validatePassword(pw) {
  if (typeof pw !== 'string') return '密码格式错误';
  if (pw.length < 6) return '密码至少 6 位';
  if (pw.length > 64) return '密码最多 64 位';
  if (/\s/.test(pw)) return '密码不能包含空格';
  return '';
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

// ==========================================================================
// 昵称违禁词审核（色情/伪色情/生殖器/侮辱/违禁词）
// 仅用于「昵称」等公开标识字段；不做正文内容过滤。
// 双端同步：前端 index.html 内同名函数必须与本处保持一致。
// ==========================================================================
const BANNED_NICK_PHRASES = [
  // —— 色情 / 性 —— //
  '色情','黄色片','三级片','成人片','约炮','卖淫','嫖娼','一夜情','打飞机','撸管','自慰',
  '口交','肛交','做爱','性交','射精','潮吹','调教','sm调教','3p','群p','女优','男优','av女','av男',
  '阴道','阴茎','龟头','睾丸','乳房','乳头','奶子','屁眼','菊花','后庭','咪咪',
  'jb','jiba','jber','jbr','jjb','jiwawa','jiwbb',
  '小鸡鸡','鸡巴','鸡儿','鸡掰','大屌','屌爆','大鸡儿','大棒子',
  // —— 中文侮辱 —— //
  '傻逼','傻b','傻屄','煞笔','沙比','傻屌','二逼','装逼','牛逼','操你妈','艹你妈','日你妈',
  '婊子','贱人','贱货','畜生','畜牲','王八蛋','混蛋','滚蛋','去死','死全家',
  '你妈逼','尼玛','你妹','妈的','他妈','妈逼','搞你妈','操你','艹你','干你','日你',
  '智障','弱智','蠢货','白痴','低能','脑残','残废','瞎子聋子',
  // —— 政治敏感（克制核心词） —— //
  '法轮功','轮子功','达赖喇嘛','藏独','疆独','台独','港独','反共产党','颠覆国家','分裂国家',
  '六四事件','64事件','天安门事件',
  // —— 涉毒 / 涉恐 —— //
  '海洛因','冰毒','大麻','摇头丸','可卡因','贩毒','吸毒','制毒','枪支','炸药','炸弹',
  // —— 英文 —— //
  'fuck','shit','bitch','sex','porn','dick','cock','pussy','cunt','asshole','nigger',
  'penis','vagina','boobs','tits','blowjob','handjob','nsfw','xxx','milf','bdsm',
];
// 单字模式：trim 去分隔符后整体由这些字符组成才拒（防止误伤"操作员"等正常词）
const BANNED_NICK_SOLO = /^[\s·•・\-_]*[操艹肏屌逼屄嫖奸淫][\s·•・\-_]*$/;
function _normalizeForBan(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\.\-_·•・*\\\/|]+/g, '');  // 去空白/常见分隔符防绕过
}
function checkBannedNickname(s) {
  const raw = String(s || '');
  if (!raw) return false;
  if (BANNED_NICK_SOLO.test(raw)) return true;
  const n = _normalizeForBan(raw);
  if (!n) return false;
  for (const w of BANNED_NICK_PHRASES) {
    if (n.includes(w.toLowerCase())) return true;
  }
  return false;
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
      // 安全校验：允许 orders/ 与 arrangements/trial/ 前缀（试听公开），
      // 付费 arrangements/paid/ 与 productions/paid/ 严禁直链 — 走 /api/.../download 校验路由
      if (key.length > 300 || /\.\./.test(key) || !/^(orders\/|arrangements\/trial\/|productions\/trial\/)/.test(key)) {
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

      if (kind !== 'image' && kind !== 'audio' && kind !== 'deliverable') return json({ error: 'Invalid kind' }, 400, cors);
      if (!visitorId) return json({ error: 'visitorId required' }, 400, cors);

      // deliverable 必须 admin
      if (kind === 'deliverable') {
        if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      }

      // Rate limit: 单 visitor 每 60s 最多 12 次上传
      const rlKey = 'ratelimit/upload/' + visitorId;
      const rl = await env.BLOG.get(rlKey, 'json');
      if (rl && rl.count >= 12) return json({ error: 'Too many uploads, please wait' }, 429, cors);

      // 按 kind 校验 MIME + 大小
      if (kind === 'image') {
        if (!/^image\/(jpeg|jpg|png|gif|webp)$/i.test(mime)) return json({ error: 'Invalid image type' }, 400, cors);
        if (bytes.length > 2 * 1024 * 1024) return json({ error: 'Image too large' }, 413, cors); // 2MB
      } else if (kind === 'audio') {
        if (!/^audio\/[a-z0-9.+-]+$/i.test(mime)) return json({ error: 'Invalid audio type' }, 400, cors);
        if (bytes.length > 15 * 1024 * 1024) return json({ error: 'Audio too large' }, 413, cors); // 15MB
      } else {
        // deliverable: 不限 MIME（音频/zip/工程文件等），单文件 ≤ 80MB（给 Worker payload 100MB 留 20MB 缓冲）
        if (bytes.length > 80 * 1024 * 1024) return json({ error: 'Deliverable too large (>80MB, please use wrangler)' }, 413, cors);
        if (!mime) mime = 'application/octet-stream';
      }

      // Key: orders/{visitorHash8}/{ts}_{rand}.{ext}
      // deliverable 走 orders/{visitorHash8}/deliver/{ts}_{rand}.{ext}，与参考音频分离
      const visHash = (await sha256Hex(visitorId)).slice(0, 8);
      const ext = mimeToExt(mime);
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const key = kind === 'deliverable'
        ? `orders/${visHash}/deliver/${ts}_${rand}.${ext}`
        : `orders/${visHash}/${ts}_${rand}.${ext}`;

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
          // visitorId 同浏览器跨账号会复用，严禁作为"我"的回退；仅对完全没 userId 的老订单兜底
          const mineByVisitor = !o.userId && !!viewerId && o.visitorId === viewerId;
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
          // 个人收款码（dataURL 或外链）— 50 万字符上限够容纳 1 张 300KB 以内的 base64 图（前端会再压缩）
          qrAlipay: sanitizeStr(aboutInput.qrAlipay, 500000),
          qrWechat: sanitizeStr(aboutInput.qrWechat, 500000),
          qrPayNote: sanitizeStr(aboutInput.qrPayNote, 200),
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

      // ── 共享编曲订单：客户从「共享编曲」详情页发起的订单会带 arrangementId
      //    校验：arrangementId 必须真实存在；价格强制从后端 arrangement.price 取（防前端篡价）
      const rawArrangementId = sanitizeStr(body && body.arrangementId, 32);
      let arrangementId = '';
      let arrangementPrice = null;
      let arrangementTitle = '';
      if (rawArrangementId) {
        const arrsRaw = await env.BLOG.get('arrangements');
        const arrs = JSON.parse(arrsRaw || '[]');
        const arr = arrs.find(a => a.id === rawArrangementId);
        if (!arr) return json({ error: 'arrangement not found' }, 404, cors);
        arrangementId = arr.id;
        arrangementPrice = Number(arr.price) || 0;
        arrangementTitle = arr.title || '';
        // 强制：共享编曲订单价格只能由主管理员设定的 arrangement.price 决定
        // 不接受前端任何 price / tier / tierLabel / priceMode 改动
        finalPrice = arrangementPrice;
      }

      // ── 成品编曲订单（2026-06-07 加）：客户从「成品编曲」详情页发起，带 productionId
      //    与共享编曲的关键区别：每个成品只能被卖出一次
      //    校验：production 必须存在 + 未售出（未被 sold 锁定）；价格强制从后端 production.price 取
      //    锁定时机：admin「✓ 确认收款」时（避免下单不付款占坑）
      const rawProductionId = sanitizeStr(body && body.productionId, 32);
      let productionId = '';
      let productionTitle = '';
      if (rawProductionId) {
        const prodsRaw = await env.BLOG.get('productions');
        const prods = JSON.parse(prodsRaw || '[]');
        const prod = prods.find(p => p.id === rawProductionId);
        if (!prod) return json({ error: 'production not found' }, 404, cors);
        if (prod.soldOrderId) return json({ error: 'production already sold' }, 410, cors);
        if (prod.fileDeletedAt) return json({ error: 'production file already delivered' }, 410, cors);
        productionId = prod.id;
        productionTitle = prod.title || '';
        finalPrice = Number(prod.price) || 0;
      }

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
        payMethod: '',       // alipay / wechat / offline / qrpay / ''
        pendingAmount: 0,    // 起步价订单：客户自填的待付款金额（付款成功后会写入 price 并改 priceMode='fixed'）
        // ── 线下扫码转账模式（2026-06-05 加） ──
        claimedAt: null,     // 客户声明"我已付款"的时间戳
        claimedAmount: 0,    // 客户声明的付款金额（元）
        claimNote: '',       // 客户备注（可选，如"已用花呗付，备注 #007"）
        claimRejectedAt: 0,  // admin 驳回客户声明的时间戳（>0 时客户端显示"❌ 付款已被驳回，请重新付款"，客户再次声明时清零）
        // ── 共享编曲订单（2026-06-07 加） ──
        arrangementId,                 // 关联 arrangements.id（非共享编曲订单为空串）
        arrangementTitle,              // 下单瞬时快照标题（即使作品被删/改名也保留）
        downloadedAt: null,            // 客户首次下载付费文件的时间戳（单次下载锁）
        // ── 成品编曲订单（2026-06-07 加） ──
        productionId,                  // 关联 productions.id（非成品订单为空串）
        productionTitle,               // 下单瞬时快照标题
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
      // visitorId 同浏览器跨账号会复用，严禁作为"我"的回退；仅对完全没 userId 的老订单兜底
      const matchVisitor = !order.userId && !!viewerId && order.visitorId === viewerId;
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
        // Admin 可维护成品交付文件列表（接单做完后上传成品 → 客户付款后下载）
        if (body.deliverables !== undefined) {
          order.deliverables = sanitizeOrderDeliverables(body.deliverables);
        }
        if (body.clientName !== undefined) {
          const name = sanitizeStr(body.clientName, 30);
          order.clientName = order.showName ? name : '';
        }
        // Admin 可手动标记/取消支付状态（线下收款 / 退款场景）
        // 2026-06-05：加上 claim 状态升级 + 起步价订单 price 升级（与 /api/pay/notify 对齐）
        if (body.paid !== undefined) {
          if (body.paid) {
            order.paid = true;
            order.paidAt = order.paidAt || Date.now();
            // 优先用客户声明金额 → 已记录的实付 → 订单价
            const finalAmt = order.claimedAmount > 0
              ? order.claimedAmount
              : (order.paidAmount || order.price || 0);
            order.paidAmount = finalAmt;
            order.payMethod = order.payMethod || (order.claimedAt ? 'qrpay' : 'offline');
            // 起步价订单付款成功后升级为已定价
            if (order.priceMode === 'from' && finalAmt > 0) {
              order.price = finalAmt;
              order.priceMode = 'fixed';
            }
            // 清除 pending / claim 中间状态
            order.pendingAmount = 0;
            order.claimedAt = null;
            order.claimedAmount = 0;
            order.claimNote = '';
            order.claimRejectedAt = 0;
            // ── 成品编曲：admin 确认收款时锁定 production（独占售出）──
            // 由于 PUT /api/orders 此处无法 await 二次 KV write（已在最外层 write orders），
            // 这里同步读 productions、改字段、写回 KV；如果 production 已被并发锁定则报错回滚 paid 状态
            if (order.productionId) {
              const prodsRaw = await env.BLOG.get('productions');
              const prods = JSON.parse(prodsRaw || '[]');
              const pIdx = prods.findIndex(p => p.id === order.productionId);
              if (pIdx < 0) {
                // 成品已被删，admin 仍可强制确认，但提示该订单失去成品关联
                // 不阻塞确认流程
              } else {
                const prod = prods[pIdx];
                if (prod.soldOrderId && prod.soldOrderId !== order.id) {
                  // 已被其他订单抢先锁定 → 回滚 paid，让 admin 知道
                  order.paid = false;
                  order.paidAt = null;
                  order.paidAmount = 0;
                  order.payMethod = '';
                  return json({ error: 'Production already sold by another order: ' + prod.soldOrderId }, 409, cors);
                }
                prod.sold = true;
                prod.soldOrderId = order.id;
                prod.soldAt = Date.now();
                prod.buyerUserId = order.userId || '';
                prod.buyerVisitorId = order.visitorId || '';
                prod.buyerEmail = order.contact || '';
                prod.buyerName = order.clientName || '';
                prods[pIdx] = prod;
                await env.BLOG.put('productions', JSON.stringify(prods));
              }
            }
          } else {
            order.paid = false;
            order.paidAt = null;
            order.paidAmount = 0;
            order.tradeNo = '';
            order.payMethod = '';
            // ── 成品编曲：admin 撤销 paid 时同步解锁 production（如未交付）──
            if (order.productionId) {
              const prodsRaw = await env.BLOG.get('productions');
              const prods = JSON.parse(prodsRaw || '[]');
              const pIdx = prods.findIndex(p => p.id === order.productionId);
              if (pIdx >= 0 && prods[pIdx].soldOrderId === order.id && !prods[pIdx].fileDeletedAt) {
                prods[pIdx].sold = false;
                prods[pIdx].soldOrderId = '';
                prods[pIdx].soldAt = null;
                prods[pIdx].buyerUserId = '';
                prods[pIdx].buyerVisitorId = '';
                prods[pIdx].buyerEmail = '';
                prods[pIdx].buyerName = '';
                await env.BLOG.put('productions', JSON.stringify(prods));
              }
            }
          }
        }
        // Admin 可单独驳回客户的"已付款声明"（清除 claim 字段，不动 paid 状态；标记 claimRejectedAt 让客户端看到"已被驳回"）
        if (body.rejectClaim === true && order.claimedAt) {
          order.claimedAt = null;
          order.claimedAmount = 0;
          order.claimNote = '';
          order.claimRejectedAt = Date.now();
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

    // POST /api/orders/:orderId/claim-pay —— 客户声明"我已付款"（线下扫码转账模式，2026-06-05 加）
    //   必须登录 + 必须是订单 owner；写入 claimedAt/claimedAmount/claimNote，推送 Server 酱通知店主到 admin 端确认
    const claimPayMatch = path.match(/^\/api\/orders\/([^/]+)\/claim-pay$/);
    if (claimPayMatch && method === 'POST') {
      const orderId = claimPayMatch[1];
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const order = orders.find(o => o.id === orderId);
      if (!order) return json({ error: '订单不存在' }, 404, cors);

      // owner 鉴权：必须是订单本人（admin 走 PUT 直接改 paid，不需走这条）
      const viewerId = request.headers.get('X-Visitor-Id') || '';
      const ownerUser = await getCurrentUser(request, env);
      const matchUser = !!ownerUser && !!order.userId && order.userId === ownerUser.userId;
      // visitorId 同浏览器跨账号会复用，严禁作为"我"的回退；仅对完全没 userId 的老订单兜底
      const matchVisitor = !order.userId && !!viewerId && order.visitorId === viewerId;
      if (!matchUser && !matchVisitor) return json({ error: '请先登录后再操作' }, 401, cors);

      if (order.paid) return json({ error: '订单已付款' }, 400, cors);
      if (order.claimedAt) return json({ error: '已声明付款，请等店主确认' }, 400, cors);

      // 金额校验：起步价订单 ≥price；定价订单必须等于 price
      const amount = Math.floor(Number(body && body.amount) || 0);
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: '金额无效' }, 400, cors);
      if (amount > 50000) return json({ error: '单笔金额不能超过 ¥50000' }, 400, cors);
      const basePrice = Number(order.price) || 0;
      if (order.priceMode === 'from') {
        if (basePrice > 0 && amount < basePrice) {
          return json({ error: `金额不能低于起步价 ¥${basePrice}` }, 400, cors);
        }
      } else {
        if (basePrice > 0 && amount !== basePrice) {
          return json({ error: `请按订单金额 ¥${basePrice} 付款` }, 400, cors);
        }
      }

      order.claimedAt = Date.now();
      order.claimedAmount = amount;
      order.claimNote = sanitizeStr(body && body.note, 100);
      order.claimRejectedAt = 0; // 客户重新声明 → 清掉历史驳回标记

      await env.BLOG.put('orders', JSON.stringify(orders));
      if (typeof ctx !== 'undefined' && ctx.waitUntil) {
        ctx.waitUntil(notifyOrderClaimed(env, order).catch(() => {}));
      } else {
        notifyOrderClaimed(env, order).catch(() => {});
      }

      return json({ ok: true, claimedAt: order.claimedAt, claimedAmount: order.claimedAmount }, 200, cors);
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
      // 客户自定义金额（仅起步价订单可用；必须 >= order.price 起步价）
      const customAmountRaw = body && body.customAmount;
      const customAmount = (customAmountRaw === undefined || customAmountRaw === null || customAmountRaw === '')
        ? null : Math.floor(Number(customAmountRaw));
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
      // visitorId 同浏览器跨账号会复用，严禁作为"我"的回退；仅对完全没 userId 的老订单兜底
      const matchVisitor = !order.userId && !!viewerId && order.visitorId === viewerId;
      if (!admin && !matchUser && !matchVisitor) return json({ error: '请先登录后再支付' }, 401, cors);

      if (order.paid) return json({ error: '该订单已支付' }, 400, cors);
      if (!order.price || order.price <= 0) return json({ error: '订单金额未确定，请联系店主报价' }, 400, cors);

      // 计算实际支付金额 + 是否需要在付款成功后把订单从起步价升级为已定价
      let payAmount = order.price;
      let pendingUpgrade = 0; // 大于 0 表示付款成功后要把 price 升级到此值
      if (order.priceMode === 'from') {
        // 起步价订单：必须传 customAmount，且 >= 起步价
        if (customAmount === null || !Number.isFinite(customAmount)) {
          return json({ error: '起步价订单请输入实际支付金额（≥ ¥' + order.price + '）' }, 400, cors);
        }
        if (customAmount < order.price) {
          return json({ error: '支付金额不能低于起步价 ¥' + order.price }, 400, cors);
        }
        if (customAmount > 50000) {
          return json({ error: '单笔支付不能超过 ¥50000' }, 400, cors);
        }
        payAmount = customAmount;
        pendingUpgrade = customAmount;
      }

      // 商户订单号：每次发起支付都新生成（用户多次扫码不冲突；老的会自动失效）
      const outTradeNo = 'BMP' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const subject = `编曲订单 #${String(order.seq || 0).padStart(3, '0')} - ${order.tierLabel || order.tier || ''}`.slice(0, 60);
      const notifyUrl = env.ALIPAY_NOTIFY_URL || 'https://api.weilingt.top/api/pay/notify';
      try {
        const resp = await alipayCall('alipay.trade.precreate', {
          out_trade_no: outTradeNo,
          total_amount: Number(payAmount).toFixed(2),
          subject,
          timeout_express: '15m',
        }, env, { notifyUrl });
        if (resp.code !== '10000') {
          return json({ error: '支付宝下单失败', detail: resp.sub_msg || resp.msg || JSON.stringify(resp).slice(0, 200) }, 502, cors);
        }
        // 回写订单：记录本次商户订单号（多次发起会覆盖）+ pendingAmount（付款成功后升级 price）
        order.outTradeNo = outTradeNo;
        if (pendingUpgrade > 0) order.pendingAmount = pendingUpgrade;
        else if ('pendingAmount' in order) order.pendingAmount = 0;
        await env.BLOG.put('orders', JSON.stringify(orders));
        return json({ ok: true, qrCode: resp.qr_code, outTradeNo, amount: payAmount, subject }, 200, cors);
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
      // visitorId 同浏览器跨账号会复用，严禁作为"我"的回退；仅对完全没 userId 的老订单兜底
      const matchVisitor = !order.userId && !!viewerId && order.visitorId === viewerId;
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
            // 起步价订单付款成功后升级为已定价：price 改为实际付款金额，priceMode 改为 fixed
            if (order.pendingAmount && order.pendingAmount > 0) {
              order.price = order.pendingAmount;
              order.priceMode = 'fixed';
              order.pendingAmount = 0;
            }
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
        // 起步价订单付款成功后升级为已定价
        if (order.pendingAmount && order.pendingAmount > 0) {
          order.price = order.pendingAmount;
          order.priceMode = 'fixed';
          order.pendingAmount = 0;
        }
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
      const content = sanitizeStr(body && body.content, 500);
      const visitorId = sanitizeStr(body && body.visitorId, 64);
      if (!content) return json({ error: 'Content required' }, 400, cors);
      if (!visitorId) return json({ error: 'visitorId required' }, 400, cors);

      // 登录用户 → 昵称锁定为账号昵称（兜底用邮箱 @ 前缀）；未登录 → 用前端传入或匿名乐迷
      const commentUser = await getCurrentUser(request, env);
      let nickname;
      if (commentUser) {
        nickname = sanitizeStr(commentUser.nickname, 20) || ((commentUser.email || '').split('@')[0]) || '乐迷';
      } else {
        nickname = sanitizeStr(body && body.nickname, 20) || '匿名乐迷';
        // 访客昵称违禁词审核（登录用户的昵称已在改资料时审过，这里只查访客现场输入）
        if (checkBannedNickname(nickname)) {
          return json({ error: '昵称含违禁内容（色情/侮辱/违禁词等），请修改后再试' }, 400, cors);
        }
      }

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
      // 登录用户额外记录 userId / email，便于后续追溯与权限判定
      if (commentUser) {
        item.userId = commentUser.userId;
        item.userEmail = commentUser.email;
      }
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
      return json({ email: user.email, userId: user.userId, nickname: user.nickname, role, hasPassword: !!user.passwordHash }, 200, cors);
    }

    // POST /api/auth/logout — invalidate session
    if (path === '/api/auth/logout' && method === 'POST') {
      const h = request.headers.get('X-User-Token') || '';
      if (h) await env.BLOG.delete('session/' + h);
      return json({ ok: true }, 200, cors);
    }

    // POST /api/auth/password-login — login with email + password
    //   失败次数限制：5 次 / 15 分钟（按 email 聚合），超限锁定
    //   故意对「user 不存在」与「密码错」返回一致提示，避免邮箱探测
    if (path === '/api/auth/password-login' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!email || !password) return json({ error: '邮箱或密码错误' }, 401, cors);
      const rlKey = 'ratelimit/pwlogin/' + email;
      const rl = await env.BLOG.get(rlKey, 'json');
      if (rl && rl.fails >= 5 && Date.now() - rl.firstAt < 15 * 60 * 1000) {
        return json({ error: '密码错误次数过多，请 15 分钟后再试，或改用验证码登录' }, 429, cors);
      }
      const user = await env.BLOG.get('user/' + email, 'json');
      const ok = user && user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
      if (!ok) {
        const next = (rl && Date.now() - rl.firstAt < 15 * 60 * 1000)
          ? { fails: rl.fails + 1, firstAt: rl.firstAt }
          : { fails: 1, firstAt: Date.now() };
        await env.BLOG.put(rlKey, JSON.stringify(next), { expirationTtl: 15 * 60 });
        return json({ error: '邮箱或密码错误' }, 401, cors);
      }
      // 登录成功，清掉限速
      await env.BLOG.delete(rlKey);
      user.lastLogin = Date.now();
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      const token = genToken();
      await env.BLOG.put('session/' + token, JSON.stringify({ email }), { expirationTtl: 30 * 86400 });
      let role = 'user';
      if (email === SUPER_ADMIN_EMAIL) role = 'super';
      else if (await isSubAdminEmail(env, email)) role = 'sub';
      return json({ ok: true, token, user: { email: user.email, userId: user.userId, nickname: user.nickname }, role }, 200, cors);
    }

    // POST /api/auth/set-password — current user sets / changes own password
    //   首次设置：body = { newPassword }
    //   修改密码：body = { currentPassword, newPassword }（已设过密码者必须验证旧密码）
    if (path === '/api/auth/set-password' && method === 'POST') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const newPassword = String(body.newPassword || '');
      const err = validatePassword(newPassword);
      if (err) return json({ error: err }, 400, cors);
      if (user.passwordHash) {
        // 已设过密码 → 必须验证旧密码（或走 admin 重置 / 自己清除后重设）
        const currentPassword = String(body.currentPassword || '');
        if (!currentPassword) return json({ error: '请输入原密码' }, 400, cors);
        const ok = await verifyPassword(currentPassword, user.passwordHash);
        if (!ok) return json({ error: '原密码错误' }, 400, cors);
      }
      user.passwordHash = await hashPassword(newPassword);
      user.passwordSetAt = Date.now();
      await env.BLOG.put('user/' + user.email, JSON.stringify(user));
      // 清掉密码登录限速
      await env.BLOG.delete('ratelimit/pwlogin/' + user.email);
      return json({ ok: true }, 200, cors);
    }

    // POST /api/auth/clear-password — current user clears own password (回到只能验证码登录)
    if (path === '/api/auth/clear-password' && method === 'POST') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      if (!user.passwordHash) return json({ ok: true, alreadyEmpty: true }, 200, cors);
      delete user.passwordHash;
      delete user.passwordSetAt;
      await env.BLOG.put('user/' + user.email, JSON.stringify(user));
      await env.BLOG.delete('ratelimit/pwlogin/' + user.email);
      return json({ ok: true }, 200, cors);
    }

    // POST /api/auth/register — 一步注册：邮箱 + 验证码 + 密码
    //   - 复用 code/<email>（与 send-code 共用）
    //   - 邮箱已注册且有密码 → 提示已注册请直接登录（409）
    //   - 邮箱已存在但无密码（之前走过验证码登录） → 允许补设密码并登录（友好降级）
    //   - 邮箱不存在 → 新建账号 + 设密码 + 颁 session
    if (path === '/api/auth/register' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const email = normalizeEmail(body.email);
      const code = String(body.code || '').trim();
      const password = String(body.password || '');
      if (!email) return json({ error: '邮箱无效' }, 400, cors);
      if (!/^\d{6}$/.test(code)) return json({ error: '验证码必须是 6 位数字' }, 400, cors);
      const pwErr = validatePassword(password);
      if (pwErr) return json({ error: pwErr }, 400, cors);
      // 验码（沿用 /api/auth/login 的逻辑）
      const stored = await env.BLOG.get('code/' + email, 'json');
      if (!stored) return json({ error: '验证码已过期，请重新发送' }, 400, cors);
      if (stored.attempts >= 5) return json({ error: '尝试次数过多，请重新发送' }, 429, cors);
      stored.attempts++;
      if (stored.code !== code) {
        await env.BLOG.put('code/' + email, JSON.stringify(stored), { expirationTtl: 300 });
        return json({ error: '验证码错误', attemptsLeft: 5 - stored.attempts }, 400, cors);
      }
      await env.BLOG.delete('code/' + email);
      // upsert user
      let user = await env.BLOG.get('user/' + email, 'json');
      if (user && user.passwordHash) {
        return json({ error: '该邮箱已注册，请直接登录' }, 409, cors);
      }
      const userId = await emailToUserId(email);
      if (!user) {
        user = { email, userId, nickname: '', createdAt: Date.now(), lastLogin: Date.now() };
      } else {
        user.lastLogin = Date.now();
      }
      user.passwordHash = await hashPassword(password);
      user.passwordSetAt = Date.now();
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      await env.BLOG.delete('ratelimit/pwlogin/' + email);
      const token = genToken();
      await env.BLOG.put('session/' + token, JSON.stringify({ email }), { expirationTtl: 30 * 86400 });
      let role = 'user';
      if (email === SUPER_ADMIN_EMAIL) role = 'super';
      else if (await isSubAdminEmail(env, email)) role = 'sub';
      return json({ ok: true, token, user: { email: user.email, userId: user.userId, nickname: user.nickname }, role }, 200, cors);
    }

    // PUT /api/auth/profile — update nickname
    if (path === '/api/auth/profile' && method === 'PUT') {
      const user = await getCurrentUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const nickname = sanitizeNickname(body.nickname);
      if (nickname && checkBannedNickname(nickname)) {
        return json({ error: '昵称含违禁内容（色情/侮辱/违禁词等），请修改' }, 400, cors);
      }
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
      // 标记角色 + 密码状态（不返回 hash 本身）
      const subList = await getSubAdmins(env);
      const subEmails = new Set(subList.map(s => s.email));
      for (const u of users) {
        u.role = u.email === SUPER_ADMIN_EMAIL ? 'super' : (subEmails.has(u.email) ? 'sub' : 'user');
        u.hasPassword = !!u.passwordHash;
        delete u.passwordHash;
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
      if (nickname && checkBannedNickname(nickname)) {
        return json({ error: '昵称含违禁内容' }, 400, cors);
      }
      const existing = await env.BLOG.get('user/' + email, 'json');
      if (existing) return json({ error: '该邮箱已注册' }, 400, cors);
      const userId = await emailToUserId(email);
      const user = { email, userId, nickname, createdAt: Date.now(), lastLogin: 0 };
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      return json({ ok: true, user }, 200, cors);
    }

    // POST /api/admin/users/:email/set-password — admin sets / resets user password
    //   body 可选 newPassword：传则用该密码，不传则系统生成 10 位临时密码返回给 admin
    //   返回 { ok, password? } —— 仅当系统生成时才返回明文密码（只此一次）
    const adminSetPwMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/set-password$/);
    if (adminSetPwMatch && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const email = normalizeEmail(decodeURIComponent(adminSetPwMatch[1]));
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      const user = await env.BLOG.get('user/' + email, 'json');
      if (!user) return json({ error: 'Not found' }, 404, cors);
      let body = {};
      try { body = await request.json(); } catch (_) { body = {}; }
      let plain = String(body.newPassword || '');
      let generated = false;
      if (!plain) {
        plain = genTempPassword();
        generated = true;
      } else {
        const err = validatePassword(plain);
        if (err) return json({ error: err }, 400, cors);
      }
      user.passwordHash = await hashPassword(plain);
      user.passwordSetAt = Date.now();
      user.passwordSetByAdmin = true;  // 标记由 admin 设置（用户首次登录后建议改密码）
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      await env.BLOG.delete('ratelimit/pwlogin/' + email);
      // 仅当系统生成时回传明文（让 admin 复制告诉用户）；admin 自定义的不回传
      return json({ ok: true, generated, password: generated ? plain : undefined }, 200, cors);
    }

    // POST /api/admin/users/:email/clear-password — admin clears user password
    const adminClearPwMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/clear-password$/);
    if (adminClearPwMatch && method === 'POST') {
      if (!(await isAdminOrSub(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const email = normalizeEmail(decodeURIComponent(adminClearPwMatch[1]));
      if (!email) return json({ error: 'Invalid email' }, 400, cors);
      const user = await env.BLOG.get('user/' + email, 'json');
      if (!user) return json({ error: 'Not found' }, 404, cors);
      if (!user.passwordHash) return json({ ok: true, alreadyEmpty: true }, 200, cors);
      delete user.passwordHash;
      delete user.passwordSetAt;
      delete user.passwordSetByAdmin;
      await env.BLOG.put('user/' + email, JSON.stringify(user));
      await env.BLOG.delete('ratelimit/pwlogin/' + email);
      return json({ ok: true }, 200, cors);
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
      if (typeof body.nickname === 'string') {
        const nn = sanitizeNickname(body.nickname);
        if (nn && checkBannedNickname(nn)) {
          return json({ error: '昵称含违禁内容' }, 400, cors);
        }
        user.nickname = nn;
      }
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

    // ── 笔记点赞 + 阅读量 ──
    // GET /api/notes/stats?ids=id1,id2,...&visitorId=xxx
    // 批量取多笔记 stats（likes/views）；可选 visitorId 同时返回我点过哪些
    if (path === '/api/notes/stats' && method === 'GET') {
      const idsParam = url.searchParams.get('ids') || '';
      const visitorId = sanitizeStr(url.searchParams.get('visitorId'), 64);
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
      const statsRaw = await env.BLOG.get('note/stats');
      const allStats = JSON.parse(statsRaw || '{}');
      const stats = {};
      ids.forEach(id => {
        stats[id] = allStats[id] || { likes: 0, views: 0 };
      });
      let liked = [];
      if (visitorId && ids.length > 0) {
        const checks = await Promise.all(ids.map(id =>
          env.BLOG.get(`note/liked/${id}/${visitorId}`)
        ));
        liked = ids.filter((id, i) => checks[i] != null);
      }
      return json({ ok: true, stats, liked }, 200, cors);
    }

    // POST /api/notes/:id/like  body: { visitorId } —— toggle 点赞
    const likeMatch = path.match(/^\/api\/notes\/([^/]+)\/like$/);
    if (likeMatch && method === 'POST') {
      const logId = likeMatch[1];
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const visitorId = sanitizeStr(body && body.visitorId, 64);
      if (!visitorId || visitorId.length < 8) {
        return json({ error: 'visitorId required' }, 400, cors);
      }
      // 校验 logId 真实存在
      const logsRaw = await env.BLOG.get('logs');
      const logs = JSON.parse(logsRaw || '[]');
      if (!logs.some(l => String(l.id) === String(logId))) {
        return json({ error: 'Log not found' }, 404, cors);
      }
      const likedKey = `note/liked/${logId}/${visitorId}`;
      const wasLiked = (await env.BLOG.get(likedKey)) != null;
      const statsRaw = await env.BLOG.get('note/stats');
      const allStats = JSON.parse(statsRaw || '{}');
      const cur = allStats[logId] || { likes: 0, views: 0 };
      if (wasLiked) {
        await env.BLOG.delete(likedKey);
        cur.likes = Math.max(0, (cur.likes || 0) - 1);
      } else {
        await env.BLOG.put(likedKey, '1');
        cur.likes = (cur.likes || 0) + 1;
      }
      allStats[logId] = cur;
      await env.BLOG.put('note/stats', JSON.stringify(allStats));
      return json({ ok: true, liked: !wasLiked, stats: cur }, 200, cors);
    }

    // POST /api/notes/:id/view  body: { visitorId } —— 阅读量 +1（同访客同日仅计一次）
    const viewMatch = path.match(/^\/api\/notes\/([^/]+)\/view$/);
    if (viewMatch && method === 'POST') {
      const logId = viewMatch[1];
      let body;
      try { body = await request.json(); }
      catch { body = {}; }
      const visitorId = sanitizeStr(body && body.visitorId, 64);
      if (!visitorId || visitorId.length < 8) {
        return json({ error: 'visitorId required' }, 400, cors);
      }
      const logsRaw = await env.BLOG.get('logs');
      const logs = JSON.parse(logsRaw || '[]');
      if (!logs.some(l => String(l.id) === String(logId))) {
        return json({ error: 'Log not found' }, 404, cors);
      }
      // 同访客同日仅计一次（北京时区按天）
      const beijing = new Date(Date.now() + 8 * 3600 * 1000);
      const dateStr = beijing.toISOString().slice(0, 10);
      const viewedKey = `note/viewed/${logId}/${visitorId}/${dateStr}`;
      const alreadyViewed = (await env.BLOG.get(viewedKey)) != null;
      const statsRaw = await env.BLOG.get('note/stats');
      const allStats = JSON.parse(statsRaw || '{}');
      const cur = allStats[logId] || { likes: 0, views: 0 };
      if (!alreadyViewed) {
        await env.BLOG.put(viewedKey, '1', { expirationTtl: 86400 });
        cur.views = (cur.views || 0) + 1;
        allStats[logId] = cur;
        await env.BLOG.put('note/stats', JSON.stringify(allStats));
      }
      return json({ ok: true, stats: cur, counted: !alreadyViewed }, 200, cors);
    }

    // ── 共享编曲（arrangements）— 2026-06-07 加 ──
    // KV 'arrangements' = JSON array of:
    //   { id, title, desc, price, tags, trialUrl, trialKey, trialSize, trialMime,
    //     paidKey, paidSize, paidMime, paidExt, createdAt, updatedAt }
    // 客户公开字段（剥离 paidKey/paidSize/paidMime，仅暴露 hasPaidFile 布尔）
    function publicArrangement(a) {
      return {
        id: a.id,
        title: a.title,
        desc: a.desc,
        price: a.price,
        tags: a.tags || '',
        trialUrl: a.trialUrl || '',
        trialSize: a.trialSize || 0,
        trialMime: a.trialMime || '',
        paidExt: a.paidExt || '',
        paidSize: a.paidSize || 0,         // 让客户看到文件大小（决策用）
        hasPaidFile: !!a.paidKey,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
    }
    function adminArrangement(a) {
      // admin 视角额外暴露 paidKey + trialKey 便于编辑器回填
      return {
        ...publicArrangement(a),
        trialKey: a.trialKey || '',
        paidKey: a.paidKey || '',
        paidMime: a.paidMime || '',
      };
    }

    // GET /api/arrangements - 公开列表（按 createdAt 倒序）
    //   默认：publicArrangement（仅 hasPaidFile 布尔）
    //   admin 加 ?all=1：adminArrangement（含 paidKey/trialKey/paidMime，供编辑器回填）
    if (path === '/api/arrangements' && method === 'GET') {
      const arrsRaw = await env.BLOG.get('arrangements');
      const arrs = JSON.parse(arrsRaw || '[]');
      arrs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const wantAll = url.searchParams.get('all') === '1';
      const admin = wantAll && (await isAdminOrSub(request, env));
      if (admin) {
        return json({ ok: true, arrangements: arrs.map(adminArrangement), isAdmin: true }, 200, cors);
      }
      return json({ ok: true, arrangements: arrs.map(publicArrangement) }, 200, cors);
    }

    // POST /api/arrangements - 创建（super admin only）
    if (path === '/api/arrangements' && method === 'POST') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const title = sanitizeStr(body && body.title, 100);
      const desc = sanitizeStr(body && body.desc, 1000);
      const price = Math.max(0, Math.floor(Number(body && body.price) || 0));
      const tags = sanitizeStr(body && body.tags, 100);
      const trialUrl = sanitizeStr(body && body.trialUrl, 500);
      const trialKey = sanitizeStr(body && body.trialKey, 200);
      const trialSize = Math.max(0, Math.floor(Number(body && body.trialSize) || 0));
      const trialMime = sanitizeStr(body && body.trialMime, 100);
      const paidKey = sanitizeStr(body && body.paidKey, 200);
      const paidSize = Math.max(0, Math.floor(Number(body && body.paidSize) || 0));
      const paidMime = sanitizeStr(body && body.paidMime, 100);
      const paidExt = sanitizeStr(body && body.paidExt, 16);

      if (!title) return json({ error: 'title required' }, 400, cors);
      if (price > 99999) return json({ error: 'price too large' }, 400, cors);
      // 大小硬上限：试听 20MB / 付费 200MB（meta 校验，实际上传走 /api/upload + R2）
      if (trialSize > 20 * 1024 * 1024) return json({ error: 'trial too large (>20MB)' }, 400, cors);
      if (paidSize > 200 * 1024 * 1024) return json({ error: 'paid too large (>200MB)' }, 400, cors);
      // 付费文件扩展名白名单
      if (paidExt && !/^(zip|wav|mp3|midi|mid)$/i.test(paidExt)) {
        return json({ error: 'paidExt must be zip/wav/mp3/midi' }, 400, cors);
      }

      const arrsRaw = await env.BLOG.get('arrangements');
      const arrs = JSON.parse(arrsRaw || '[]');
      const now = Date.now();
      const item = {
        id: 'arr_' + now + '_' + Math.random().toString(36).slice(2, 8),
        title, desc, price, tags,
        trialUrl, trialKey, trialSize, trialMime,
        paidKey, paidSize, paidMime, paidExt,
        createdAt: now, updatedAt: now,
      };
      arrs.push(item);
      await env.BLOG.put('arrangements', JSON.stringify(arrs));
      return json({ ok: true, arrangement: item }, 200, cors);  // 创建者是 super admin，可返回完整对象
    }

    // PUT /api/arrangements/:id - 修改（super admin only）
    const arrPutMatch = path.match(/^\/api\/arrangements\/([^/]+)$/);
    if (arrPutMatch && method === 'PUT') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      const arrId = arrPutMatch[1];
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const arrsRaw = await env.BLOG.get('arrangements');
      const arrs = JSON.parse(arrsRaw || '[]');
      const idx = arrs.findIndex(a => a.id === arrId);
      if (idx < 0) return json({ error: 'Not found' }, 404, cors);
      const item = arrs[idx];

      if (body.title !== undefined) item.title = sanitizeStr(body.title, 100);
      if (body.desc !== undefined) item.desc = sanitizeStr(body.desc, 1000);
      if (body.price !== undefined) {
        const p = Math.max(0, Math.floor(Number(body.price) || 0));
        if (p > 99999) return json({ error: 'price too large' }, 400, cors);
        item.price = p;
      }
      if (body.tags !== undefined) item.tags = sanitizeStr(body.tags, 100);
      if (body.trialUrl !== undefined) item.trialUrl = sanitizeStr(body.trialUrl, 500);
      if (body.trialKey !== undefined) item.trialKey = sanitizeStr(body.trialKey, 200);
      if (body.trialSize !== undefined) {
        const s = Math.max(0, Math.floor(Number(body.trialSize) || 0));
        if (s > 20 * 1024 * 1024) return json({ error: 'trial too large (>20MB)' }, 400, cors);
        item.trialSize = s;
      }
      if (body.trialMime !== undefined) item.trialMime = sanitizeStr(body.trialMime, 100);
      if (body.paidKey !== undefined) item.paidKey = sanitizeStr(body.paidKey, 200);
      if (body.paidSize !== undefined) {
        const s = Math.max(0, Math.floor(Number(body.paidSize) || 0));
        if (s > 200 * 1024 * 1024) return json({ error: 'paid too large (>200MB)' }, 400, cors);
        item.paidSize = s;
      }
      if (body.paidMime !== undefined) item.paidMime = sanitizeStr(body.paidMime, 100);
      if (body.paidExt !== undefined) {
        const e = sanitizeStr(body.paidExt, 16);
        if (e && !/^(zip|wav|mp3|midi|mid)$/i.test(e)) {
          return json({ error: 'paidExt must be zip/wav/mp3/midi' }, 400, cors);
        }
        item.paidExt = e;
      }
      item.updatedAt = Date.now();
      arrs[idx] = item;
      await env.BLOG.put('arrangements', JSON.stringify(arrs));
      return json({ ok: true, arrangement: item }, 200, cors);
    }

    // DELETE /api/arrangements/:id - 删除（super admin only，仅删元数据，R2 文件不动手）
    if (arrPutMatch && method === 'DELETE') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      const arrId = arrPutMatch[1];
      const arrsRaw = await env.BLOG.get('arrangements');
      const arrs = JSON.parse(arrsRaw || '[]');
      const next = arrs.filter(a => a.id !== arrId);
      if (next.length === arrs.length) return json({ error: 'Not found' }, 404, cors);
      await env.BLOG.put('arrangements', JSON.stringify(next));
      return json({ ok: true }, 200, cors);
    }

    // POST /api/arrangements/upload-trial - 上传试听文件（super admin only，≤20MB）
    //   form-data: file
    //   返回: { ok, url, key, size, mime }
    if (path === '/api/arrangements/upload-trial' && method === 'POST') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      if (!env.R2) return json({ error: 'R2 not configured' }, 500, cors);
      let form;
      try { form = await request.formData(); }
      catch { return json({ error: 'Invalid form data' }, 400, cors); }
      const file = form.get('file');
      if (!file || typeof file === 'string') return json({ error: 'file required' }, 400, cors);
      const mime = (file.type || '').toLowerCase();
      if (!/^audio\/[a-z0-9.+-]+$/i.test(mime)) return json({ error: 'Invalid audio type' }, 400, cors);
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length > 20 * 1024 * 1024) return json({ error: 'Trial too large (>20MB)' }, 413, cors);

      const ext = mimeToExt(mime);
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const key = `arrangements/trial/${ts}_${rand}.${ext}`;
      await env.R2.put(key, bytes, { httpMetadata: { contentType: mime } });
      const origin = new URL(request.url).origin;
      const url2 = `${origin}/files/${key}`;
      return json({ ok: true, url: url2, key, size: bytes.length, mime }, 200, cors);
    }

    // GET /api/arrangements/:id/download?orderId=&visitorId= - 客户下载付费文件
    //   客户：order 真实 + paid=true + arrangementId 匹配 + 属于该 visitor/user + 未下载过
    //         通过后标记 downloadedAt=now（单次下载锁），R2 stream 返回文件
    //   admin：可省略 orderId 直接拿文件（测试下载，不写入下载锁）
    const arrDlMatch = path.match(/^\/api\/arrangements\/([^/]+)\/download$/);
    if (arrDlMatch && method === 'GET') {
      const arrId = arrDlMatch[1];
      const orderId = sanitizeStr(url.searchParams.get('orderId'), 64);
      const viewerVisitor = sanitizeStr(url.searchParams.get('visitorId'), 64);
      const admin = await isAdminOrSub(request, env);
      // admin 测试下载：无 orderId 时短路（不校验订单 / 不写下载锁）
      if (!orderId) {
        if (!admin) return json({ error: 'orderId required' }, 400, cors);
        const arrsRaw0 = await env.BLOG.get('arrangements');
        const arrs0 = JSON.parse(arrsRaw0 || '[]');
        const arr0 = arrs0.find(a => a.id === arrId);
        if (!arr0 || !arr0.paidKey) return json({ error: 'Paid file not configured' }, 404, cors);
        if (!env.R2) return json({ error: 'R2 not configured' }, 500, cors);
        const obj0 = await env.R2.get(arr0.paidKey);
        if (!obj0) return json({ error: 'Paid file missing in R2' }, 404, cors);
        const safeTitle0 = (arr0.title || 'arrangement').replace(/[^\w\u4e00-\u9fa5._-]+/g, '_').slice(0, 60);
        const filename0 = `${safeTitle0}.${arr0.paidExt || mimeToExt(arr0.paidMime || '') || 'bin'}`;
        const headers0 = {
          ...cors,
          'Content-Type': arr0.paidMime || obj0.httpMetadata?.contentType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(filename0)}"; filename*=UTF-8''${encodeURIComponent(filename0)}`,
          'Cache-Control': 'no-store',
        };
        if (obj0.size != null) headers0['Content-Length'] = String(obj0.size);
        return new Response(obj0.body, { status: 200, headers: headers0 });
      }

      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const orderIdx = orders.findIndex(o => o.id === orderId);
      if (orderIdx < 0) return json({ error: 'Order not found' }, 404, cors);
      const order = orders[orderIdx];

      // 验证 1：订单是这个 arrangement 的
      if (order.arrangementId !== arrId) return json({ error: 'Order mismatch' }, 403, cors);
      // 验证 2：订单已付款
      if (!order.paid) return json({ error: 'Order not paid' }, 403, cors);
      // 验证 3：身份匹配（优先 userId，回退 visitorId）
      const viewerUser = await getCurrentUser(request, env);
      const matchUser = !!viewerUser && !!order.userId && order.userId === viewerUser.userId;
      const matchVisitor = !order.userId && !!viewerVisitor && order.visitorId === viewerVisitor;
      if (!admin && !matchUser && !matchVisitor) return json({ error: 'Forbidden' }, 403, cors);
      // 验证 4：未下载过（admin 不受此限）
      if (!admin && order.downloadedAt) return json({ error: '该订单已下载过 1 次，付费文件单次有效；如需重新下载请联系店主重置' }, 410, cors);

      // 找 arrangement 拿 paidKey
      const arrsRaw = await env.BLOG.get('arrangements');
      const arrs = JSON.parse(arrsRaw || '[]');
      const arr = arrs.find(a => a.id === arrId);
      if (!arr || !arr.paidKey) return json({ error: 'Paid file not configured' }, 404, cors);
      if (!env.R2) return json({ error: 'R2 not configured' }, 500, cors);
      const obj = await env.R2.get(arr.paidKey);
      if (!obj) return json({ error: 'Paid file missing in R2' }, 404, cors);

      // 标记单次下载锁（admin 跳过）
      if (!admin) {
        order.downloadedAt = Date.now();
        orders[orderIdx] = order;
        await env.BLOG.put('orders', JSON.stringify(orders));
      }

      // 拼下载文件名
      const safeTitle = (arr.title || 'arrangement').replace(/[^\w\u4e00-\u9fa5._-]+/g, '_').slice(0, 60);
      const filename = `${safeTitle}.${arr.paidExt || mimeToExt(arr.paidMime || '') || 'bin'}`;
      const headers = {
        ...cors,
        'Content-Type': arr.paidMime || obj.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      };
      if (obj.size != null) headers['Content-Length'] = String(obj.size);
      return new Response(obj.body, { status: 200, headers });
    }

    // ── 成品编曲（productions）— 2026-06-07 加 ──
    // 与共享编曲（arrangements）思路一致，但每个 production 只能售卖一次：
    //   下单：worker 校验 production.soldOrderId 必须为空（未售）→ 价格强制 production.price
    //   锁定：admin「✓ 确认收款」(PUT /api/orders body.paid=true) 时 sold=true + 记买家信息
    //   下载：客户单次下载后立即删 R2 文件 + 标记 fileDeletedAt（"售出即下架"）
    // KV 'productions' = JSON array of:
    //   { id, title, desc, price, tags, trialUrl, trialKey, trialSize, trialMime,
    //     paidKey, paidSize, paidMime, paidExt, createdAt, updatedAt,
    //     sold, soldOrderId, soldAt, buyerUserId, buyerVisitorId, buyerEmail, buyerName,
    //     fileDeletedAt }
    function publicProduction(p) {
      return {
        id: p.id,
        title: p.title,
        desc: p.desc,
        price: p.price,
        tags: p.tags || '',
        trialUrl: p.trialUrl || '',
        trialSize: p.trialSize || 0,
        trialMime: p.trialMime || '',
        paidExt: p.paidExt || '',
        paidSize: p.paidSize || 0,
        hasPaidFile: !!p.paidKey && !p.fileDeletedAt,
        sold: !!p.sold,
        soldAt: p.soldAt || null,
        // 客户端不暴露 buyer 详情（admin 用 ?all=1 看完整）
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    }
    function adminProduction(p) {
      // admin 视角下额外暴露交易信息（不暴露 paidKey）
      return {
        ...publicProduction(p),
        paidKey: p.paidKey || '',
        soldOrderId: p.soldOrderId || '',
        buyerUserId: p.buyerUserId || '',
        buyerVisitorId: p.buyerVisitorId || '',
        buyerEmail: p.buyerEmail || '',
        buyerName: p.buyerName || '',
        fileDeletedAt: p.fileDeletedAt || null,
      };
    }

    // GET /api/productions - 列表
    //   默认：仅返回未售出 + 文件未删除的 production（客户视角）
    //   admin 加 ?all=1：返回全部（含已售记录）
    if (path === '/api/productions' && method === 'GET') {
      const prodsRaw = await env.BLOG.get('productions');
      const prods = JSON.parse(prodsRaw || '[]');
      prods.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const wantAll = url.searchParams.get('all') === '1';
      const admin = wantAll && (await isAdminOrSub(request, env));
      if (admin) {
        return json({ ok: true, productions: prods.map(adminProduction), isAdmin: true }, 200, cors);
      }
      const visible = prods.filter(p => !p.sold && !p.fileDeletedAt);
      return json({ ok: true, productions: visible.map(publicProduction) }, 200, cors);
    }

    // POST /api/productions - 创建（super admin only）
    if (path === '/api/productions' && method === 'POST') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const title = sanitizeStr(body && body.title, 100);
      const desc = sanitizeStr(body && body.desc, 1000);
      const price = Math.max(0, Math.floor(Number(body && body.price) || 0));
      const tags = sanitizeStr(body && body.tags, 100);
      const trialUrl = sanitizeStr(body && body.trialUrl, 500);
      const trialKey = sanitizeStr(body && body.trialKey, 200);
      const trialSize = Math.max(0, Math.floor(Number(body && body.trialSize) || 0));
      const trialMime = sanitizeStr(body && body.trialMime, 100);
      const paidKey = sanitizeStr(body && body.paidKey, 200);
      const paidSize = Math.max(0, Math.floor(Number(body && body.paidSize) || 0));
      const paidMime = sanitizeStr(body && body.paidMime, 100);
      const paidExt = sanitizeStr(body && body.paidExt, 16);

      if (!title) return json({ error: 'title required' }, 400, cors);
      if (price > 99999) return json({ error: 'price too large' }, 400, cors);
      if (trialSize > 20 * 1024 * 1024) return json({ error: 'trial too large (>20MB)' }, 400, cors);
      if (paidSize > 200 * 1024 * 1024) return json({ error: 'paid too large (>200MB)' }, 400, cors);
      if (paidExt && !/^(zip|wav|mp3|midi|mid)$/i.test(paidExt)) {
        return json({ error: 'paidExt must be zip/wav/mp3/midi' }, 400, cors);
      }

      const prodsRaw = await env.BLOG.get('productions');
      const prods = JSON.parse(prodsRaw || '[]');
      const now = Date.now();
      const item = {
        id: 'prod_' + now + '_' + Math.random().toString(36).slice(2, 8),
        title, desc, price, tags,
        trialUrl, trialKey, trialSize, trialMime,
        paidKey, paidSize, paidMime, paidExt,
        createdAt: now, updatedAt: now,
        sold: false, soldOrderId: '', soldAt: null,
        buyerUserId: '', buyerVisitorId: '', buyerEmail: '', buyerName: '',
        fileDeletedAt: null,
      };
      prods.push(item);
      await env.BLOG.put('productions', JSON.stringify(prods));
      return json({ ok: true, production: adminProduction(item) }, 200, cors);
    }

    // PUT /api/productions/:id - 修改（super admin only；已售出的不允许改 price/paidKey）
    const prodPutMatch = path.match(/^\/api\/productions\/([^/]+)$/);
    if (prodPutMatch && method === 'PUT') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      const prodId = prodPutMatch[1];
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const prodsRaw = await env.BLOG.get('productions');
      const prods = JSON.parse(prodsRaw || '[]');
      const idx = prods.findIndex(p => p.id === prodId);
      if (idx < 0) return json({ error: 'Not found' }, 404, cors);
      const item = prods[idx];
      const locked = !!item.sold || !!item.fileDeletedAt;

      if (body.title !== undefined) item.title = sanitizeStr(body.title, 100);
      if (body.desc !== undefined) item.desc = sanitizeStr(body.desc, 1000);
      if (body.price !== undefined) {
        if (locked) return json({ error: 'Sold production cannot change price' }, 403, cors);
        const p = Math.max(0, Math.floor(Number(body.price) || 0));
        if (p > 99999) return json({ error: 'price too large' }, 400, cors);
        item.price = p;
      }
      if (body.tags !== undefined) item.tags = sanitizeStr(body.tags, 100);
      if (body.trialUrl !== undefined) item.trialUrl = sanitizeStr(body.trialUrl, 500);
      if (body.trialKey !== undefined) item.trialKey = sanitizeStr(body.trialKey, 200);
      if (body.trialSize !== undefined) {
        const s = Math.max(0, Math.floor(Number(body.trialSize) || 0));
        if (s > 20 * 1024 * 1024) return json({ error: 'trial too large (>20MB)' }, 400, cors);
        item.trialSize = s;
      }
      if (body.trialMime !== undefined) item.trialMime = sanitizeStr(body.trialMime, 100);
      if (body.paidKey !== undefined) {
        if (locked) return json({ error: 'Sold production cannot change paidKey' }, 403, cors);
        item.paidKey = sanitizeStr(body.paidKey, 200);
      }
      if (body.paidSize !== undefined) {
        const s = Math.max(0, Math.floor(Number(body.paidSize) || 0));
        if (s > 200 * 1024 * 1024) return json({ error: 'paid too large (>200MB)' }, 400, cors);
        item.paidSize = s;
      }
      if (body.paidMime !== undefined) item.paidMime = sanitizeStr(body.paidMime, 100);
      if (body.paidExt !== undefined) {
        const e = sanitizeStr(body.paidExt, 16);
        if (e && !/^(zip|wav|mp3|midi|mid)$/i.test(e)) {
          return json({ error: 'paidExt must be zip/wav/mp3/midi' }, 400, cors);
        }
        item.paidExt = e;
      }
      item.updatedAt = Date.now();
      prods[idx] = item;
      await env.BLOG.put('productions', JSON.stringify(prods));
      return json({ ok: true, production: adminProduction(item) }, 200, cors);
    }

    // DELETE /api/productions/:id - 删除（super admin only，仅删元数据，R2 文件不动手）
    if (prodPutMatch && method === 'DELETE') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      const prodId = prodPutMatch[1];
      const prodsRaw = await env.BLOG.get('productions');
      const prods = JSON.parse(prodsRaw || '[]');
      const next = prods.filter(p => p.id !== prodId);
      if (next.length === prods.length) return json({ error: 'Not found' }, 404, cors);
      await env.BLOG.put('productions', JSON.stringify(next));
      return json({ ok: true }, 200, cors);
    }

    // POST /api/productions/upload-trial - 上传试听文件（super admin only，≤20MB）
    if (path === '/api/productions/upload-trial' && method === 'POST') {
      if (!(await isSuperRole(request, env))) return json({ error: 'Super admin only' }, 401, cors);
      if (!env.R2) return json({ error: 'R2 not configured' }, 500, cors);
      let form;
      try { form = await request.formData(); }
      catch { return json({ error: 'Invalid form data' }, 400, cors); }
      const file = form.get('file');
      if (!file || typeof file === 'string') return json({ error: 'file required' }, 400, cors);
      const mime = (file.type || '').toLowerCase();
      if (!/^audio\/[a-z0-9.+-]+$/i.test(mime)) return json({ error: 'Invalid audio type' }, 400, cors);
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length > 20 * 1024 * 1024) return json({ error: 'Trial too large (>20MB)' }, 413, cors);

      const ext = mimeToExt(mime);
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const key = `productions/trial/${ts}_${rand}.${ext}`;
      await env.R2.put(key, bytes, { httpMetadata: { contentType: mime } });
      const origin = new URL(request.url).origin;
      const url2 = `${origin}/files/${key}`;
      return json({ ok: true, url: url2, key, size: bytes.length, mime }, 200, cors);
    }

    // GET /api/orders/:orderId/download-deliverable?fileIdx=N&visitorId=xxx
    //   接单订单成品交付下载：与「成品编曲售出即删」不同，此处是已付款的定制服务，客户重下合理诉求
    //   验证：order 真实 + paid=true + deliverables[idx] 存在 + 身份匹配 (userId 优先 / visitorId 兜底)
    //   通过后：返回文件流，记 lastDownloadAt，不删 R2，不限次数
    //   admin 可跳过 paid + 身份校验直接下载（测试用）
    const orderDlMatch = path.match(/^\/api\/orders\/([^/]+)\/download-deliverable$/);
    if (orderDlMatch && method === 'GET') {
      const orderId = orderDlMatch[1];
      const fileIdx = Math.floor(Number(url.searchParams.get('fileIdx') || '0'));
      const viewerVisitor = sanitizeStr(url.searchParams.get('visitorId'), 64);
      const admin = await isAdminOrSub(request, env);

      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const orderIdx = orders.findIndex(o => o.id === orderId);
      if (orderIdx < 0) return new Response('Order not found', { status: 404 });
      const order = orders[orderIdx];

      const dvs = Array.isArray(order.deliverables) ? order.deliverables : [];
      if (fileIdx < 0 || fileIdx >= dvs.length) return new Response('File not found', { status: 404 });
      const dv = dvs[fileIdx];
      if (!dv || !dv.key) return new Response('File key missing', { status: 404 });

      // 非 admin 必须 paid + 身份匹配
      if (!admin) {
        if (!order.paid) return new Response('Order not paid', { status: 403 });
        const viewerUser = await getCurrentUser(request, env);
        const matchUser = !!viewerUser && !!order.userId && order.userId === viewerUser.userId;
        const matchVisitor = !order.userId && !!viewerVisitor && order.visitorId === viewerVisitor;
        if (!matchUser && !matchVisitor) return new Response('Forbidden', { status: 403 });
      }

      if (!env.R2) return new Response('R2 not configured', { status: 500 });
      const obj = await env.R2.get(dv.key);
      if (!obj) return new Response('File missing in R2', { status: 404 });

      // 记 lastDownloadAt（仅客户下载时记，admin 测试下载不污染统计）
      if (!admin) {
        dv.lastDownloadAt = Date.now();
        orders[orderIdx].deliverables[fileIdx] = dv;
        await env.BLOG.put('orders', JSON.stringify(orders));
      }

      // RFC5987 文件名编码，确保中文名正常落盘
      const rawName = (dv.name || 'deliverable').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200);
      const headers = {
        ...cors,
        'Content-Type': dv.type || obj.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(rawName)}"; filename*=UTF-8''${encodeURIComponent(rawName)}`,
        'Cache-Control': 'no-store',
      };
      if (obj.size != null) headers['Content-Length'] = String(obj.size);
      return new Response(obj.body, { status: 200, headers });
    }

    // GET /api/productions/:id/download?orderId=&visitorId= - 客户下载付费文件（独占售出 + 售出即删）
    //   验证：order 真实 + paid=true + productionId 匹配 + 属于该 visitor/user + 文件未被删
    //   通过后：返回文件流，并立即异步删 R2 paidKey + KV 标记 fileDeletedAt（首次下载即下架）
    //   admin 可重复下载（不触发删除）
    const prodDlMatch = path.match(/^\/api\/productions\/([^/]+)\/download$/);
    if (prodDlMatch && method === 'GET') {
      const prodId = prodDlMatch[1];
      const orderId = sanitizeStr(url.searchParams.get('orderId'), 64);
      const viewerVisitor = sanitizeStr(url.searchParams.get('visitorId'), 64);
      const admin = await isAdminOrSub(request, env);

      const prodsRaw = await env.BLOG.get('productions');
      const prods = JSON.parse(prodsRaw || '[]');
      const prodIdx = prods.findIndex(p => p.id === prodId);
      if (prodIdx < 0) return json({ error: 'Production not found' }, 404, cors);
      const prod = prods[prodIdx];

      // admin 测试下载分支：不需 orderId，不删文件
      if (admin && !orderId) {
        if (!prod.paidKey) return json({ error: 'Paid file not configured' }, 404, cors);
        if (!env.R2) return json({ error: 'R2 not configured' }, 500, cors);
        const obj = await env.R2.get(prod.paidKey);
        if (!obj) return json({ error: 'Paid file missing in R2' }, 404, cors);
        const safeTitle = (prod.title || 'production').replace(/[^\w\u4e00-\u9fa5._-]+/g, '_').slice(0, 60);
        const filename = `${safeTitle}.${prod.paidExt || mimeToExt(prod.paidMime || '') || 'bin'}`;
        const headers = {
          ...cors,
          'Content-Type': prod.paidMime || obj.httpMetadata?.contentType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        };
        if (obj.size != null) headers['Content-Length'] = String(obj.size);
        return new Response(obj.body, { status: 200, headers });
      }

      if (!orderId) return json({ error: 'orderId required' }, 400, cors);
      const ordersRaw = await env.BLOG.get('orders');
      const orders = JSON.parse(ordersRaw || '[]');
      const orderIdx = orders.findIndex(o => o.id === orderId);
      if (orderIdx < 0) return json({ error: 'Order not found' }, 404, cors);
      const order = orders[orderIdx];

      if (order.productionId !== prodId) return json({ error: 'Order mismatch' }, 403, cors);
      if (!order.paid) return json({ error: 'Order not paid' }, 403, cors);
      const viewerUser = await getCurrentUser(request, env);
      const matchUser = !!viewerUser && !!order.userId && order.userId === viewerUser.userId;
      const matchVisitor = !order.userId && !!viewerVisitor && order.visitorId === viewerVisitor;
      if (!matchUser && !matchVisitor) return json({ error: 'Forbidden' }, 403, cors);
      if (prod.fileDeletedAt) return json({ error: '该成品付费文件已被首次下载并自动销毁；如需重新下载请联系店主' }, 410, cors);
      if (!prod.paidKey) return json({ error: 'Paid file not configured' }, 404, cors);
      if (!env.R2) return json({ error: 'R2 not configured' }, 500, cors);
      const obj = await env.R2.get(prod.paidKey);
      if (!obj) return json({ error: 'Paid file missing in R2' }, 404, cors);

      // 读取完整 buffer，确保返回给客户后才删（避免流中断丢文件）
      const buf = await obj.arrayBuffer();
      const bytes = new Uint8Array(buf);

      // 同步删 R2 + 标 fileDeletedAt（在响应前完成，确保删除真正成功）
      try {
        await env.R2.delete(prod.paidKey);
      } catch (_) { /* R2 删除失败不阻塞下载，下次客户重试时再删 */ }
      prod.fileDeletedAt = Date.now();
      prods[prodIdx] = prod;
      await env.BLOG.put('productions', JSON.stringify(prods));
      // 订单标记 downloadedAt（与共享编曲对齐）
      if (!order.downloadedAt) {
        order.downloadedAt = Date.now();
        orders[orderIdx] = order;
        await env.BLOG.put('orders', JSON.stringify(orders));
      }

      const safeTitle = (prod.title || 'production').replace(/[^\w\u4e00-\u9fa5._-]+/g, '_').slice(0, 60);
      const filename = `${safeTitle}.${prod.paidExt || mimeToExt(prod.paidMime || '') || 'bin'}`;
      const headers = {
        ...cors,
        'Content-Type': prod.paidMime || obj.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      };
      return new Response(bytes, { status: 200, headers });
    }

    // ── 星座运势（天行 API 代理 + KV 24h 缓存） ──
    if (path === '/api/horoscope' && method === 'GET') {
      const SIGNS = {
        aries: '白羊座', taurus: '金牛座', gemini: '双子座', cancer: '巨蟹座',
        leo: '狮子座', virgo: '处女座', libra: '天秤座', scorpio: '天蝎座',
        sagittarius: '射手座', capricorn: '摩羯座', aquarius: '水瓶座', pisces: '双鱼座',
      };
      const sign = (url.searchParams.get('sign') || '').toLowerCase().trim();
      if (!SIGNS[sign]) {
        return json({ error: 'invalid sign', allowed: Object.keys(SIGNS) }, 400, cors);
      }
      if (!env.TIANAPI_KEY) {
        return json({ error: 'TIANAPI_KEY not configured' }, 500, cors);
      }
      // 用北京时区当前日期做缓存 key（天行按天更新）
      const beijing = new Date(Date.now() + 8 * 3600 * 1000);
      const dateStr = beijing.toISOString().slice(0, 10);
      const cacheKey = `cache/horoscope/${dateStr}/${sign}`;
      // 命中缓存直接返回
      const cached = await env.BLOG.get(cacheKey, 'json');
      if (cached) {
        return json({ ok: true, sign, signName: SIGNS[sign], date: dateStr, list: cached, cached: true }, 200, cors);
      }
      // 回源天行
      try {
        const apiUrl = `https://apis.tianapi.com/star/index?key=${encodeURIComponent(env.TIANAPI_KEY)}&astro=${encodeURIComponent(sign)}`;
        const resp = await fetch(apiUrl);
        const data = await resp.json();
        if (data.code !== 200 || !data.result || !Array.isArray(data.result.list)) {
          return json({ error: 'tianapi upstream error', code: data.code, detail: data.msg || 'unknown' }, 502, cors);
        }
        // KV 缓存 24h
        await env.BLOG.put(cacheKey, JSON.stringify(data.result.list), { expirationTtl: 86400 });
        return json({ ok: true, sign, signName: SIGNS[sign], date: dateStr, list: data.result.list, cached: false }, 200, cors);
      } catch (e) {
        return json({ error: 'fetch failed', detail: String(e && e.message || e) }, 502, cors);
      }
    }

    if (path === '/' || path === '/health') {
      return json({ status: 'ok', service: 'blog-music-api' }, 200, cors);
    }

    return json({ error: 'Not Found' }, 404, cors);
}
