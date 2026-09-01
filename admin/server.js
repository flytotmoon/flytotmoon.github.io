'use strict';
/* ============================================================================
 * flytotmoon 博客后台管理系统 —— 服务端
 * ----------------------------------------------------------------------------
 * 零第三方依赖（仅使用 Node.js 内置模块），单文件即可运行：
 *     node admin/server.js
 *
 * 功能：
 *   - 登录认证（scrypt 口令哈希 + HMAC 签名令牌，登录失败限流）
 *   - 文章 / 草稿的增删改查、发布（解析 / 回写 Markdown Front-matter）
 *   - 媒体库：上传 / 列表 / 删除图片（存至 source/img/upload/）
 *   - 站点设置：安全地读写 _config.yml 关键字段 + 原始配置文件编辑（自动备份）
 *   - 构建发布：执行 hexo clean / generate / deploy，SSE 实时推送日志，可取消
 *   - 统计信息：文章数、分类、标签、字数等
 *
 * 安全说明：
 *   - 默认只监听 127.0.0.1，仅本机可访问
 *   - 首次启动自动生成密钥与默认账号 admin / admin123，请登录后立即在
 *     「站点设置 → 修改密码」中更换，或使用 --reset-password 命令行重置
 *   - 如确需局域网访问，请将 config.json 中 host 改为 0.0.0.0 并设置强口令
 * ========================================================================== */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const FM = require('../source/admin/fm.js');

/* ------------------------------ 基础路径 ------------------------------ */

const ADMIN_DIR = __dirname;
const ROOT = path.resolve(ADMIN_DIR, '..');
const PUBLIC_DIR = path.join(ROOT, 'source', 'admin'); // 后台前端随博客发布（单一副本）
const CONFIG_FILE = path.join(ADMIN_DIR, 'config.json');
const TRASH_DIR = path.join(ADMIN_DIR, 'trash');
const BACKUP_DIR = path.join(ADMIN_DIR, 'backups');
const POSTS_DIR = path.join(ROOT, 'source', '_posts');
const DRAFTS_DIR = path.join(ROOT, 'source', '_drafts');
const IMG_DIR = path.join(ROOT, 'source', 'img', 'upload');
const HEXO_BIN = path.join(ROOT, 'node_modules', 'hexo', 'bin', 'hexo');

const MAX_BODY = 30 * 1024 * 1024; // 30MB
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|svg|avif|ico)$/i;
const LOG_LIMIT = 4000; // 构建日志最多保留行数

/* ------------------------------ 命令行参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
const FLAG_RESET_PASSWORD = argValue('--reset-password');
const FLAG_DEV = args.includes('--dev');
const FLAG_HELP = args.includes('--help') || args.includes('-h');

/* ------------------------------ 工具函数 ------------------------------ */

const log = (msg) => console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 当前时间格式化为 YYYY-MM-DD HH:mm:ss（本地时间） */
function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 安全的路径解析：rel 必须落在 base 内 */
function safeResolve(base, rel) {
  const p = path.resolve(base, rel || '.');
  const b = path.resolve(base);
  if (p !== b && !p.startsWith(b + path.sep)) {
    throw new HttpError(400, '非法路径');
  }
  return p;
}

/** 相对路径 <-> key（base64url，URL 安全） */
function keyEncode(rel) {
  return Buffer.from(rel.split(path.sep).join('/'), 'utf8').toString('base64url');
}
function keyDecode(key) {
  if (!key || typeof key !== 'string' || key.length > 500) throw new HttpError(400, '非法 key');
  let rel = key;
  try {
    rel = decodeURIComponent(key);
  } catch (e) {
    throw new HttpError(400, '非法 key');
  }
  rel = Buffer.from(rel, 'base64url').toString('utf8');
  if (!rel || rel.includes('\0') || rel.split('/').includes('..')) throw new HttpError(400, '非法 key');
  return rel;
}


/* ------------------------------ 配置管理 ------------------------------ */

const DEFAULT_CONFIG = () => ({
  host: '127.0.0.1',
  port: 4321,
  username: 'admin',
  salt: randomHex(16),
  passwordHash: null, // 首次生成时使用 admin123
  tokenSecret: randomHex(32),
  sessionTtlDays: 7,
  created: nowLocal(),
});

let cfg;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    cfg = Object.assign(DEFAULT_CONFIG(), JSON.parse(raw));
  } catch (e) {
    cfg = DEFAULT_CONFIG();
  }
  if (!cfg.passwordHash) {
    cfg.passwordHash = hashPassword('admin123');
    saveConfig();
    log('首次启动：已创建默认账号 admin / admin123，请尽快在后台「站点设置 → 修改密码」中更换！');
  }
}

function saveConfig() {
  fs.mkdirSync(ADMIN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function hashPassword(pw) {
  return crypto.scryptSync(String(pw), cfg.salt, 64).toString('hex');
}

function verifyPassword(pw) {
  const a = Buffer.from(hashPassword(pw), 'hex');
  const b = Buffer.from(cfg.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------ 令牌 ------------------------------ */

function signToken(username) {
  const ttl = (cfg.sessionTtlDays || 7) * 24 * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + ttl })).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.tokenSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', cfg.tokenSecret).update(payload).digest('base64url');
  if (sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.u || !data.exp || Date.now() > data.exp) return null;
    return data.u;
  } catch (e) {
    return null;
  }
}

function tokenFromReq(req, urlObj) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const q = urlObj.searchParams.get('token');
  return q || null;
}

/* ------------------------------ 登录限流 ------------------------------ */

const loginAttempts = new Map(); // ip -> {count, lockedUntil}
function checkLoginRate(ip) {
  const rec = loginAttempts.get(ip);
  if (rec && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}
function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.lockedUntil = Date.now() + 60 * 1000;
    rec.count = 0;
  }
  loginAttempts.set(ip, rec);
}
function recordLoginOk(ip) {
  loginAttempts.delete(ip);
}

/* ------------------------------ 文章存储 ------------------------------ */

async function walkMdFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await walkMdFiles(full);
      out.push(...sub);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}


/** 读取一篇文章：{ relPath, absPath, key, fm, data, body, title, ... } */
async function readPost(absPath, baseDir, scope) {
  const content = await fsp.readFile(absPath, 'utf8');
  const { data, body } = FM.parseFrontMatter(content);
  const relPath = path.relative(baseDir, absPath);
  const stat = await fsp.stat(absPath);
  return {
    relPath,
    key: keyEncode(relPath),
    scope,
    title: FM.fmGet(data, 'title') || path.basename(absPath, '.md'),
    date: FM.fmGet(data, 'date') || null,
    updated: FM.fmGet(data, 'updated') || null,
    tags: Array.isArray(FM.fmGet(data, 'tags')) ? FM.fmGet(data, 'tags') : [],
    categories: Array.isArray(FM.fmGet(data, 'categories')) ? FM.fmGet(data, 'categories') : [],
    cover: FM.fmGet(data, 'cover') || '',
    description: FM.fmGet(data, 'description') || '',
    sticky: Number(FM.fmGet(data, 'sticky')) || 0,
    mathjax: Boolean(FM.fmGet(data, 'mathjax')),
    comments: FM.fmGet(data, 'comments') !== false,
    top_img: FM.fmGet(data, 'top_img') || '',
    data,
    body,
    raw: content,
    words: FM.countWords(body),
    excerpt: FM.makeExcerpt(body),
    mtime: stat.mtimeMs,
  };
}

async function readPostByKey(key, scope) {
  const rel = keyDecode(key);
  const baseDir = scope === 'drafts' ? DRAFTS_DIR : POSTS_DIR;
  const absPath = safeResolve(baseDir, rel);
  const stat = await fsp.stat(absPath).catch(() => {
    throw new HttpError(404, '文章不存在');
  });
  if (!stat.isFile()) throw new HttpError(404, '文章不存在');
  return readPost(absPath, baseDir, scope);
}


/** 为新文章生成日期与文件名 */
async function ensureUniqueFile(dir, name) {
  const base = FM.sanitizeName(name);
  let candidate = `${base}.md`;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${n}.md`;
    n += 1;
  }
  return candidate;
}

async function targetDirForCategories(cats) {
  if (Array.isArray(cats) && cats.length && String(cats[0]).trim()) {
    const first = FM.sanitizeName(String(cats[0]).trim());
    const dir = path.join(POSTS_DIR, first);
    try {
      if ((await fsp.stat(dir)).isDirectory()) return dir;
    } catch (e) {
      /* 目录不存在则退回根目录 */
    }
  }
  return POSTS_DIR;
}

/* ------------------------------ 媒体库 ------------------------------ */

function parseMultipart(buffer, boundary) {
  const parts = [];
  const marker = Buffer.from('--' + boundary);
  let idx = buffer.indexOf(marker);
  while (idx !== -1) {
    const end = buffer.indexOf(marker, idx + marker.length);
    if (end === -1) break;
    const seg = buffer.slice(idx + marker.length, end);
    const headEnd = seg.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = seg.slice(0, headEnd).toString('utf8');
      let body = seg.slice(headEnd + 4);
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.slice(0, -2);
      }
      const nameMatch = /name="([^"]*)"/i.exec(head);
      const fileMatch = /filename="([^"]*)"/i.exec(head);
      const ct = /content-type\s*:[^\r\n]*/i.exec(head);
      parts.push({
        name: nameMatch ? nameMatch[1] : null,
        filename: fileMatch ? fileMatch[1] : null,
        contentType: ct ? ct[0].split(':')[1].trim() : 'application/octet-stream',
        data: body,
      });
    }
    idx = buffer.indexOf(marker, end + marker.length);
  }
  return parts;
}

async function listMediaFiles() {
  const out = [];
  const walk = async (dir, rel) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, relPath);
      } else if (ent.isFile() && MEDIA_EXT.test(ent.name)) {
        const stat = await fsp.stat(full);
        out.push({
          name: ent.name,
          rel: relPath,
          url: '/img/upload/' + relPath.split(path.sep).join('/'),
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  };
  await walk(IMG_DIR, '');
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/* ------------------------------ 构建任务 ------------------------------ */

let currentJob = null;
let lastJob = null;
const sseClients = new Set();

function notifySSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

function jobPublic(job) {
  if (!job) return null;
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    log: job.log.slice(-500),
  };
}

function startBuild(action) {
  if (currentJob) throw new HttpError(409, '已有构建任务在运行，请稍候');
  const map = {
    clean: ['clean'],
    // 生成前自动清理缓存：hexo 的 styl 渲染缓存会导致主题配置修改不生效
    generate: ['clean', 'generate'],
    deploy: ['clean', 'generate', '--deploy'],
  };
  const hexoArgs = map[action];
  if (!hexoArgs) throw new HttpError(400, '未知构建动作');

  const job = {
    id: randomHex(8),
    action,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    log: [],
    child: null,
  };
  currentJob = job;
  lastJob = job;
  job.log.push(`$ node ${path.basename(HEXO_BIN)} ${hexoArgs.join(' ')}`);
  notifySSE('start', { id: job.id, action, startedAt: job.startedAt });

  let child;
  try {
    child = spawn(process.execPath, [HEXO_BIN, ...hexoArgs], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
    });
  } catch (e) {
    job.status = 'error';
    job.exitCode = -1;
    job.finishedAt = Date.now();
    job.log.push(`[系统错误] 无法启动构建进程：${e.message}`);
    currentJob = null;
    notifySSE('done', jobPublic(job));
    return job;
  }
  job.child = child;

  let buf = '';
  const feed = (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      job.log.push(line);
      if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
      notifySSE('log', { id: job.id, line });
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('error', (e) => {
    job.log.push(`[进程错误] ${e.message}`);
    notifySSE('log', { id: job.id, line: `[进程错误] ${e.message}` });
  });
  child.on('close', (code) => {
    if (buf.trim()) {
      job.log.push(buf.trim());
      notifySSE('log', { id: job.id, line: buf.trim() });
    }
    job.exitCode = code;
    job.finishedAt = Date.now();
    job.status = code === 0 ? 'done' : 'error';
    job.child = null;
    currentJob = null;
    notifySSE('done', jobPublic(job));
    log(`构建 [${action}] 结束，exit=${code}`);
  });
  log(`构建 [${action}] 开始`);
  return job;
}

/* ------------------------------ 配置读写 ------------------------------ */

const SITE_KEYS = ['title', 'subtitle', 'description', 'keywords', 'author', 'url', 'language'];

async function readSiteConfig() {
  const text = await fsp.readFile(path.join(ROOT, '_config.yml'), 'utf8');
  const out = {};
  for (const key of SITE_KEYS) {
    const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
    const m = re.exec(text);
    if (m) out[key] = m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function writeSiteConfig(patch) {
  const file = path.join(ROOT, '_config.yml');
  let text = await fsp.readFile(file, 'utf8');
  const updated = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!SITE_KEYS.includes(key)) continue;
    const re = new RegExp(`^${key}\\s*:.*$`, 'm');
    const replacement = `${key}: ${String(value).trim()}`;
    if (re.test(text)) {
      text = text.replace(re, replacement);
      updated.push(key);
    } else {
      text += `\n${replacement}\n`;
      updated.push(key);
    }
  }
  await backupFile(file);
  await fsp.writeFile(file, text, 'utf8');
  return updated;
}

async function backupFile(file) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const name = path.basename(file);
  const bak = path.join(BACKUP_DIR, `${name}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  try {
    await fsp.copyFile(file, bak);
  } catch (e) {
    /* 源文件不存在则跳过备份 */
  }
}

/** 将 image/video 的标量写法规范为主题期望的列表写法（防止图片不显示） */
function normalizeImageFields(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => {
      const m = /^(\s{6})(image|video):\s*(\S+)\s*$/.exec(line);
      if (m && m[3]) {
        return `${m[1]}${m[2]}:\n${m[1]}  - ${m[3]}`;
      }
      return line;
    })
    .join('\n');
}

/** 为 album.yml 中缺少详情页的相册自动创建页面（type: album_detail） */
async function ensureAlbumPages(content) {
  const created = [];
  const lines = String(content || '').split(/\r?\n/);
  let className = '';
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const cm = /^-\s+class_name:\s*(.*)$/.exec(line);
    if (cm) {
      className = cm[1].trim();
      continue;
    }
    const pm = /^\s{2}path_name:\s*(\/\S+)\s*$/.exec(line);
    if (pm && pm[1] && pm[1] !== '/') {
      const dir = pm[1].replace(/^\/+|\/+$/g, '');
      if (!dir || dir.includes('..')) continue;
      const pageFile = path.join(ROOT, 'source', dir, 'index.md');
      try {
        await fsp.access(pageFile);
      } catch (e) {
        const fm = `---\ntitle: ${className || dir}\ndate: ${nowLocal()}\naside: false\ntop_img: false\ntype: "album_detail"\n---\n`;
        await fsp.mkdir(path.dirname(pageFile), { recursive: true });
        await fsp.writeFile(pageFile, fm, 'utf8');
        created.push(pm[1]);
      }
    }
  }
  return created;
}

const CONFIG_FILE_WHITELIST = ['_config.yml', '_config.anzhiyu.yml'];

/* ------------------------------ HTTP 辅助 ------------------------------ */

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : '服务器内部错误';
  if (status >= 500) log(`[error] ${err.stack || err.message}`);
  sendJSON(res, status, { ok: false, message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 按 Content-Type 的 charset 解码请求体，默认 UTF-8 */
function decodeBody(buffer, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  const cs = m ? m[1].toLowerCase() : 'utf-8';
  if (cs === 'latin1' || cs === 'iso-8859-1') return buffer.toString('latin1');
  return buffer.toString('utf8');
}

/** 读取并解析 JSON 请求体（自动处理 charset 与空体） */
async function readJSON(req) {
  const buffer = await readBody(req);
  const text = decodeBody(buffer, req.headers['content-type']).trim();
  if (!text) return {};
  return JSON.parse(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, urlObj) {
  let pathname = decodeURIComponent(urlObj.pathname);
  if (pathname === '/' || pathname === '/index.html') pathname = '/index.html';
  const filePath = safeResolve(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 后台前端文件不缓存，方便更新后刷新即可生效
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function serveMedia(req, res, urlObj) {
  const rel = urlObj.searchParams.get('path') || '';
  if (!rel) throw new HttpError(400, '缺少 path 参数');
  const abs = safeResolve(IMG_DIR, rel);
  const stat = await fsp.stat(abs).catch(() => {
    throw new HttpError(404, '文件不存在');
  });
  if (!stat.isFile() || !MEDIA_EXT.test(abs)) throw new HttpError(404, '文件不存在');
  const ext = path.extname(abs).toLowerCase();
  const mime = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
  };
  res.writeHead(200, {
    'Content-Type': mime[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(abs).pipe(res);
}

/* ------------------------------ 路由处理 ------------------------------ */

async function handleApi(req, res, urlObj, user) {
  const { pathname } = urlObj;
  const method = req.method;

  /* 无需登录 */
  if (pathname === '/api/ping') return sendJSON(res, 200, { ok: true, pong: Date.now(), time: nowLocal() });
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJSON(req);
    const ip = req.socket.remoteAddress || 'unknown';
    const lock = checkLoginRate(ip);
    if (lock > 0) return sendJSON(res, 429, { ok: false, message: `尝试次数过多，请 ${lock} 秒后再试` });
    if (body.username !== cfg.username || !verifyPassword(body.password || '')) {
      recordLoginFail(ip);
      return sendJSON(res, 401, { ok: false, message: '用户名或密码错误' });
    }
    recordLoginOk(ip);
    log(`用户 ${cfg.username} 登录成功（${ip}）`);
    return sendJSON(res, 200, { ok: true, token: signToken(cfg.username), username: cfg.username, expiresInDays: cfg.sessionTtlDays });
  }
  if (pathname === '/api/auth/check') {
    return sendJSON(res, 200, { ok: true, username: user });
  }

  /* 以下接口均需登录 */
  if (!user) {
    return sendJSON(res, 401, { ok: false, message: '未登录或登录已过期' });
  }

  /* ---- 修改密码 ---- */
  if (pathname === '/api/auth/password' && method === 'POST') {
    const body = await readJSON(req);
    if (!verifyPassword(body.old || '')) return sendJSON(res, 400, { ok: false, message: '原密码错误' });
    const np = String(body.new || '');
    if (np.length < 6) return sendJSON(res, 400, { ok: false, message: '新密码至少 6 位' });
    cfg.passwordHash = hashPassword(np);
    saveConfig();
    log('后台密码已修改');
    return sendJSON(res, 200, { ok: true, message: '密码修改成功' });
  }

  /* ---- 文章列表 ---- */
  if (pathname === '/api/posts' && method === 'GET') {
    const scope = urlObj.searchParams.get('scope') === 'drafts' ? 'drafts' : 'posts';
    const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
    const category = (urlObj.searchParams.get('category') || '').trim();
    const tag = (urlObj.searchParams.get('tag') || '').trim();
    const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1', 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get('size') || '20', 10) || 20));

    const baseDir = scope === 'drafts' ? DRAFTS_DIR : POSTS_DIR;
    const files = await walkMdFiles(baseDir);
    let posts = [];
    for (const f of files) {
      try {
        posts.push(await readPost(f, baseDir, scope));
      } catch (e) {
        /* 跳过解析失败的文件 */
      }
    }
    if (q) {
      posts = posts.filter((p) => {
        const hay = `${p.title} ${p.tags.join(' ')} ${p.categories.join(' ')} ${p.body}`.toLowerCase();
        return hay.includes(q);
      });
    }
    if (category) posts = posts.filter((p) => p.categories.includes(category));
    if (tag) posts = posts.filter((p) => p.tags.includes(tag));
    posts.sort((a, b) => {
      // 置顶优先级高的排在前面
      if ((b.sticky || 0) !== (a.sticky || 0)) return (b.sticky || 0) - (a.sticky || 0);
      const da = a.date ? String(a.date) : '';
      const db = b.date ? String(b.date) : '';
      if (da !== db) return da < db ? 1 : -1;
      return b.mtime - a.mtime;
    });
    const total = posts.length;
    const pagePosts = posts.slice((page - 1) * size, page * size).map((p) => ({
      key: p.key,
      title: p.title,
      date: p.date,
      updated: p.updated,
      tags: p.tags,
      categories: p.categories,
      cover: p.cover,
      sticky: p.sticky,
      mathjax: p.mathjax,
      words: p.words,
      excerpt: p.excerpt,
      mtime: p.mtime,
    }));
    return sendJSON(res, 200, { ok: true, total, page, size, posts: pagePosts });
  }

  /* ---- 元信息（分类 / 标签 / 统计） ---- */
  if (pathname === '/api/meta' && method === 'GET') {
    const cats = new Map();
    const tags = new Map();
    let wordsTotal = 0;
    let postCount = 0;
    let draftCount = 0;
    const recent = [];
    for (const scope of ['posts', 'drafts']) {
      const baseDir = scope === 'drafts' ? DRAFTS_DIR : POSTS_DIR;
      const files = await walkMdFiles(baseDir);
      for (const f of files) {
        try {
          const p = await readPost(f, baseDir, scope);
          wordsTotal += p.words;
          if (scope === 'drafts') draftCount += 1;
          else postCount += 1;
          for (const c of p.categories) cats.set(c, (cats.get(c) || 0) + 1);
          for (const t of p.tags) tags.set(t, (tags.get(t) || 0) + 1);
          if (scope === 'posts') recent.push(p);
        } catch (e) {
          /* skip */
        }
      }
    }
    recent.sort((a, b) => (String(a.date || '') < String(b.date || '') ? 1 : -1));
    return sendJSON(res, 200, {
      ok: true,
      posts: postCount,
      drafts: draftCount,
      categories: [...cats.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      tags: [...tags.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      wordsTotal,
      recent: recent.slice(0, 6).map((p) => ({ key: p.key, title: p.title, date: p.date, categories: p.categories })),
    });
  }

  /* ---- 单篇读取 ---- */
  if (pathname.startsWith('/api/posts/') && method === 'GET') {
    const key = pathname.slice('/api/posts/'.length);
    const scope = urlObj.searchParams.get('scope') === 'drafts' ? 'drafts' : 'posts';
    const post = await readPostByKey(key, scope);
    const { data, body, raw, ...pub } = post;
    return sendJSON(res, 200, { ok: true, post: { ...pub, body } });
  }

  /* ---- 新建文章 ---- */
  if (pathname === '/api/posts' && method === 'POST') {
    const body = await readJSON(req);
    if (!body.title || !String(body.title).trim()) return sendJSON(res, 400, { ok: false, message: '标题不能为空' });
    const scope = body.scope === 'drafts' ? 'drafts' : 'posts';
    const baseDir = scope === 'drafts' ? DRAFTS_DIR : POSTS_DIR;
    await fsp.mkdir(baseDir, { recursive: true });

    const title = String(body.title).trim();
    const content = String(body.content || '');
    const data = [];
    FM.fmSet(data, 'title', title);
    FM.fmSet(data, 'date', body.date || nowLocal());
    if (body.updated) FM.fmSet(data, 'updated', String(body.updated));
    if (Array.isArray(body.tags) && body.tags.length) FM.fmSet(data, 'tags', body.tags.map((t) => String(t).trim()).filter(Boolean), 'list');
    if (Array.isArray(body.categories) && body.categories.length) FM.fmSet(data, 'categories', body.categories.map((t) => String(t).trim()).filter(Boolean), 'list');
    if (body.cover) FM.fmSet(data, 'cover', String(body.cover).trim());
    if (body.description) FM.fmSet(data, 'description', String(body.description).trim());
    if (Number(body.sticky) > 0) FM.fmSet(data, 'sticky', Number(body.sticky) || 1);
    if (body.mathjax) FM.fmSet(data, 'mathjax', true);
    if (body.comments === false) FM.fmSet(data, 'comments', false);
    if (body.top_img) FM.fmSet(data, 'top_img', String(body.top_img).trim());

    const dir = scope === 'posts' ? await targetDirForCategories(data.find((e) => e.key === 'categories')?.value) : baseDir;
    const filename = await ensureUniqueFile(dir, title);
    await fsp.writeFile(path.join(dir, filename), FM.buildFrontMatter(data, content), 'utf8');
    log(`已创建${scope === 'drafts' ? '草稿' : '文章'}：${filename}`);
    return sendJSON(res, 200, { ok: true, key: keyEncode(path.relative(baseDir, path.join(dir, filename))) });
  }

  /* ---- 更新文章 ---- */
  if (pathname.startsWith('/api/posts/') && method === 'PUT') {
    const key = pathname.slice('/api/posts/'.length);
    const body = await readJSON(req);
    const scope = body.scope === 'drafts' ? 'drafts' : 'posts';
    const baseDir = scope === 'drafts' ? DRAFTS_DIR : POSTS_DIR;
    const rel = keyDecode(key);
    const absPath = safeResolve(baseDir, rel);
    const stat = await fsp.stat(absPath).catch(() => {
      throw new HttpError(404, '文章不存在');
    });
    if (!stat.isFile()) throw new HttpError(404, '文章不存在');

    const post = await readPost(absPath, baseDir, scope);
    FM.applyMeta(post.data, body);
    const newTitle = body.title ? String(body.title).trim() : post.title;
    FM.fmSet(post.data, 'title', newTitle);
    if (!FM.fmGet(post.data, 'date') && post.date) FM.fmSet(post.data, 'date', post.date);
    const newContent = FM.buildFrontMatter(post.data, body.content !== undefined ? String(body.content) : post.body);

    // 标题变化则重命名文件
    let finalAbs = absPath;
    const currentName = path.basename(absPath, '.md');
    if (newTitle && FM.sanitizeName(currentName) !== FM.sanitizeName(newTitle)) {
      const newName = await ensureUniqueFile(path.dirname(absPath), newTitle);
      finalAbs = path.join(path.dirname(absPath), newName);
    }

    if (finalAbs !== absPath) {
      await backupFile(absPath);
      await fsp.writeFile(finalAbs, newContent, 'utf8');
      await fsp.unlink(absPath);
      log(`已更新并重命名：${path.basename(absPath)} -> ${path.basename(finalAbs)}`);
    } else {
      await fsp.writeFile(absPath, newContent, 'utf8');
      log(`已更新文章：${path.basename(absPath)}`);
    }
    return sendJSON(res, 200, {
      ok: true,
      key: keyEncode(path.relative(baseDir, finalAbs)),
    });
  }

  /* ---- 删除文章（移入回收站） ---- */
  if (pathname.startsWith('/api/posts/') && method === 'DELETE') {
    const key = pathname.slice('/api/posts/'.length);
    const scope = urlObj.searchParams.get('scope') === 'drafts' ? 'drafts' : 'posts';
    const baseDir = scope === 'drafts' ? DRAFTS_DIR : POSTS_DIR;
    const rel = keyDecode(key);
    const absPath = safeResolve(baseDir, rel);
    const stat = await fsp.stat(absPath).catch(() => {
      throw new HttpError(404, '文章不存在');
    });
    if (!stat.isFile()) throw new HttpError(404, '文章不存在');
    await fsp.mkdir(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, `${Date.now()}-${FM.sanitizeName(rel.split(path.sep).join('_'))}`);
    await fsp.rename(absPath, dest);
    log(`已移入回收站：${rel}`);
    return sendJSON(res, 200, { ok: true, message: '已移入回收站' });
  }

  /* ---- 发布草稿 ---- */
  if (pathname.startsWith('/api/posts/') && pathname.endsWith('/publish') && method === 'POST') {
    const key = pathname.slice('/api/posts/'.length, -'/publish'.length);
    const rel = keyDecode(key);
    const absPath = safeResolve(DRAFTS_DIR, rel);
    const stat = await fsp.stat(absPath).catch(() => {
      throw new HttpError(404, '草稿不存在');
    });
    if (!stat.isFile()) throw new HttpError(404, '草稿不存在');
    const post = await readPost(absPath, DRAFTS_DIR, 'drafts');
    if (!FM.fmGet(post.data, 'date')) {
      FM.fmSet(post.data, 'date', nowLocal());
      await fsp.writeFile(absPath, FM.buildFrontMatter(post.data, post.body), 'utf8');
    }
    const dir = await targetDirForCategories(FM.fmGet(post.data, 'categories'));
    const filename = await ensureUniqueFile(dir, path.basename(absPath, '.md'));
    const dest = path.join(dir, filename);
    await fsp.rename(absPath, dest);
    log(`草稿已发布：${filename}`);
    return sendJSON(res, 200, { ok: true, key: keyEncode(path.relative(POSTS_DIR, dest)) });
  }

  /* ---- 媒体上传 ---- */
  if (pathname === '/api/media' && method === 'POST') {
    const ctype = req.headers['content-type'] || '';
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype);
    if (!bm) return sendJSON(res, 400, { ok: false, message: '请使用 multipart/form-data 上传' });
    const boundary = bm[1] || bm[2];
    const buffer = await readBody(req);
    const parts = parseMultipart(buffer, boundary);
    const filePart = parts.find((p) => p.filename);
    if (!filePart || !filePart.data.length) return sendJSON(res, 400, { ok: false, message: '未找到上传文件' });
    if (filePart.data.length > 20 * 1024 * 1024) return sendJSON(res, 413, { ok: false, message: '文件超过 20MB 限制' });
    const rawName = path.basename(filePart.filename);
    const ext = path.extname(rawName).toLowerCase();
    if (!MEDIA_EXT.test(ext)) return sendJSON(res, 400, { ok: false, message: '仅支持 jpg/png/gif/webp/svg/avif/ico 格式' });

    const d = new Date();
    const monthDir = path.join(IMG_DIR, `${d.getFullYear()}${pad(d.getMonth() + 1)}`);
    await fsp.mkdir(monthDir, { recursive: true });
    const name = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${randomHex(4)}-${FM.sanitizeName(rawName.slice(0, 40))}`;
    const dest = path.join(monthDir, name);
    await fsp.writeFile(dest, filePart.data);
    const rel = path.relative(IMG_DIR, dest).split(path.sep).join('/');
    log(`已上传图片：${rel}`);
    return sendJSON(res, 200, { ok: true, name, rel, url: `/img/upload/${rel}` });
  }

  /* ---- 媒体列表 ---- */
  if (pathname === '/api/media' && method === 'GET') {
    const files = await listMediaFiles();
    return sendJSON(res, 200, { ok: true, files });
  }

  /* ---- 媒体删除 ---- */
  if (pathname.startsWith('/api/media/') && method === 'DELETE') {
    let rel = pathname.slice('/api/media/'.length);
    try {
      rel = decodeURIComponent(rel);
    } catch (e) {
      return sendJSON(res, 400, { ok: false, message: '非法路径' });
    }
    if (rel.split('/').includes('..')) return sendJSON(res, 400, { ok: false, message: '非法路径' });
    const abs = safeResolve(IMG_DIR, rel);
    const stat = await fsp.stat(abs).catch(() => {
      throw new HttpError(404, '文件不存在');
    });
    if (!stat.isFile() || !MEDIA_EXT.test(abs)) throw new HttpError(404, '文件不存在');
    await fsp.unlink(abs);
    log(`已删除图片：${rel}`);
    return sendJSON(res, 200, { ok: true, message: '已删除' });
  }

  /* ---- 友链（link.yml） ---- */
  if (pathname === '/api/link' && method === 'GET') {
    const text = await fsp.readFile(path.join(ROOT, 'source', '_data', 'link.yml'), 'utf8');
    return sendJSON(res, 200, { ok: true, content: text });
  }
  if (pathname === '/api/link' && method === 'PUT') {
    const body = await readJSON(req);
    if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, message: '缺少内容' });
    const file = path.join(ROOT, 'source', '_data', 'link.yml');
    await backupFile(file);
    await fsp.writeFile(file, body.content, 'utf8');
    log('已保存友链（link.yml，已自动备份）');
    return sendJSON(res, 200, { ok: true, message: '保存成功，已自动备份原文件' });
  }

  /* ---- 装备（equipment.yml） ---- */
  if (pathname === '/api/equipment' && method === 'GET') {
    const text = await fsp.readFile(path.join(ROOT, 'source', '_data', 'equipment.yml'), 'utf8');
    return sendJSON(res, 200, { ok: true, content: text });
  }
  if (pathname === '/api/equipment' && method === 'PUT') {
    const body = await readJSON(req);
    if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, message: '缺少内容' });
    const file = path.join(ROOT, 'source', '_data', 'equipment.yml');
    await backupFile(file);
    await fsp.writeFile(file, body.content, 'utf8');
    log('已保存装备（equipment.yml，已自动备份）');
    return sendJSON(res, 200, { ok: true, message: '保存成功，已自动备份原文件' });
  }

  /* ---- 创意技能（creativity.yml） ---- */
  if (pathname === '/api/creativity' && method === 'GET') {
    const text = await fsp.readFile(path.join(ROOT, 'source', '_data', 'creativity.yml'), 'utf8');
    return sendJSON(res, 200, { ok: true, content: text });
  }
  if (pathname === '/api/creativity' && method === 'PUT') {
    const body = await readJSON(req);
    if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, message: '缺少内容' });
    const file = path.join(ROOT, 'source', '_data', 'creativity.yml');
    await backupFile(file);
    await fsp.writeFile(file, body.content, 'utf8');
    log('已保存创意技能（creativity.yml，已自动备份）');
    return sendJSON(res, 200, { ok: true, message: '保存成功，已自动备份原文件' });
  }

  /* ---- 自我介绍（about.yml） ---- */
  if (pathname === '/api/about' && method === 'GET') {
    const file = path.join(ROOT, 'source', '_data', 'about.yml');
    const text = await fsp.readFile(file, 'utf8');
    return sendJSON(res, 200, { ok: true, content: text });
  }
  if (pathname === '/api/about' && method === 'PUT') {
    const body = await readJSON(req);
    if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, message: '缺少内容' });
    const file = path.join(ROOT, 'source', '_data', 'about.yml');
    await backupFile(file);
    await fsp.writeFile(file, body.content, 'utf8');
    log('已保存自我介绍（about.yml，已自动备份）');
    return sendJSON(res, 200, { ok: true, message: '保存成功，已自动备份原文件' });
  }

  /* ---- 相册集（album.yml） ---- */
  if (pathname === '/api/album' && method === 'GET') {
    const file = path.join(ROOT, 'source', '_data', 'album.yml');
    const text = await fsp.readFile(file, 'utf8');
    return sendJSON(res, 200, { ok: true, content: text });
  }
  if (pathname === '/api/album' && method === 'PUT') {
    const body = await readJSON(req);
    if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, message: '缺少内容' });
    const content = normalizeImageFields(body.content);
    const file = path.join(ROOT, 'source', '_data', 'album.yml');
    await backupFile(file);
    await fsp.writeFile(file, content, 'utf8');
    // 自动为缺少详情页的相册创建页面（避免点击相册卡片 404）
    const createdPages = await ensureAlbumPages(content);
    log('已保存相册集（album.yml，已自动备份）' + (createdPages.length ? '，自动创建页面：' + createdPages.join(', ') : ''));
    return sendJSON(res, 200, { ok: true, message: '保存成功，已自动备份原文件', createdPages });
  }

  /* ---- 千言万语（essay.yml） ---- */
  if (pathname === '/api/essay' && method === 'GET') {
    const file = path.join(ROOT, 'source', '_data', 'essay.yml');
    const text = await fsp.readFile(file, 'utf8');
    return sendJSON(res, 200, { ok: true, content: text });
  }
  if (pathname === '/api/essay' && method === 'PUT') {
    const body = await readJSON(req);
    if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, message: '缺少内容' });
    const content = normalizeImageFields(body.content);
    const file = path.join(ROOT, 'source', '_data', 'essay.yml');
    await backupFile(file);
    await fsp.writeFile(file, content, 'utf8');
    log('已保存千言万语（essay.yml，已自动备份）');
    return sendJSON(res, 200, { ok: true, message: '保存成功，已自动备份原文件' });
  }

  /* ---- 站点配置 ---- */
  if (pathname === '/api/site-config' && method === 'GET') {
    const config = await readSiteConfig();
    return sendJSON(res, 200, { ok: true, config });
  }
  if (pathname === '/api/site-config' && method === 'PUT') {
    const body = await readJSON(req);
    const updated = await writeSiteConfig(body);
    log(`已更新站点配置：${updated.join(', ') || '无变化'}`);
    return sendJSON(res, 200, { ok: true, updated });
  }

  /* ---- 原始配置文件 ---- */
  if (pathname === '/api/config-file' && method === 'GET') {
    const name = urlObj.searchParams.get('file') || '';
    if (!CONFIG_FILE_WHITELIST.includes(name)) return sendJSON(res, 400, { ok: false, message: '不允许读取该文件' });
    const text = await fsp.readFile(path.join(ROOT, name), 'utf8');
    return sendJSON(res, 200, { ok: true, file: name, content: text });
  }
  if (pathname === '/api/config-file' && method === 'PUT') {
    const body = await readJSON(req);
    const name = body.file || '';
    if (!CONFIG_FILE_WHITELIST.includes(name)) return sendJSON(res, 400, { ok: false, message: '不允许修改该文件' });
    if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, message: '缺少内容' });
    const file = path.join(ROOT, name);
    await backupFile(file);
    await fsp.writeFile(file, body.content, 'utf8');
    log(`已保存配置文件：${name}（已自动备份）`);
    return sendJSON(res, 200, { ok: true, message: '保存成功，已自动备份原文件' });
  }

  /* ---- 构建 ---- */
  if (pathname === '/api/build' && method === 'POST') {
    const body = await readJSON(req);
    const job = startBuild(body.action || 'generate');
    return sendJSON(res, 200, { ok: true, job: jobPublic(job) });
  }
  if (pathname === '/api/build/cancel' && method === 'POST') {
    if (!currentJob) return sendJSON(res, 400, { ok: false, message: '没有正在运行的构建任务' });
    try {
      currentJob.child && currentJob.child.kill();
    } catch (e) {
      /* ignore */
    }
    return sendJSON(res, 200, { ok: true, message: '已发送取消指令' });
  }
  if (pathname === '/api/build/status' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, running: currentJob ? jobPublic(currentJob) : null, last: lastJob ? jobPublic(lastJob) : null });
  }
  if (pathname === '/api/build/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    if (currentJob) {
      res.write(`event: start\ndata: ${JSON.stringify({ id: currentJob.id, action: currentJob.action })}\n\n`);
      for (const line of currentJob.log) {
        res.write(`event: log\ndata: ${JSON.stringify({ id: currentJob.id, line })}\n\n`);
      }
    }
    req.on('close', () => sseClients.delete(res));
    return; // 长连接，不结束
  }

  return sendJSON(res, 404, { ok: false, message: '接口不存在' });
}

/* ------------------------------ 主服务器 ------------------------------ */

async function main() {
  if (FLAG_HELP) {
    console.log(`
flytotmoon 博客后台管理系统

用法:
  node admin/server.js                 启动后台（读取 admin/config.json 配置）
  node admin/server.js --dev           调试模式（打印请求日志）
  node admin/server.js --reset-password <新密码>   重置登录密码（需先停止服务）
  node admin/server.js --help          显示本帮助

默认地址: http://127.0.0.1:4321  （可在 admin/config.json 修改 host/port）
`);
    return;
  }

  loadConfig();

  if (FLAG_RESET_PASSWORD) {
    cfg.passwordHash = hashPassword(FLAG_RESET_PASSWORD);
    saveConfig();
    console.log('密码已重置为：' + FLAG_RESET_PASSWORD);
    return;
  }

  await fsp.mkdir(DRAFTS_DIR, { recursive: true });
  await fsp.mkdir(IMG_DIR, { recursive: true });

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = urlObj;

    try {
      /* 带鉴权的媒体图片访问（供后台 <img> 使用，token 走 query） */
      if (pathname.startsWith('/admin/media/') && req.method === 'GET') {
        const user = verifyToken(tokenFromReq(req, urlObj));
        if (!user) return sendJSON(res, 401, { ok: false, message: '未登录' });
        await serveMedia(req, res, urlObj);
        return;
      }

      if (pathname.startsWith('/api/')) {
        const user = verifyToken(tokenFromReq(req, urlObj));
        await handleApi(req, res, urlObj, user);
        if (FLAG_DEV) log(`[dev] ${req.method} ${pathname} ${Date.now() - start}ms`);
        return;
      }

      /* 静态页面（后台 UI） */
      const served = await serveStatic(req, res, urlObj);
      if (served) return;
      sendJSON(res, 404, { ok: false, message: 'Not Found' });
    } catch (e) {
      try {
        sendError(res, e);
      } catch (e2) {
        res.destroy();
      }
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (e) {
      /* ignore */
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });

  log('==============================================================');
  log('  flytotmoon 博客后台管理系统 已启动');
  log(`  后台地址: http://${cfg.host}:${cfg.port}/`);
  log(`  账号: ${cfg.username}   默认密码: admin123（请尽快修改）`);
  log(`  博客目录: ${ROOT}`);
  log('  Ctrl+C 停止服务');
  log('==============================================================');

  const shutdown = () => {
    log('正在关闭…');
    for (const c of sseClients) {
      try {
        c.end();
      } catch (e) {
        /* ignore */
      }
    }
    if (currentJob && currentJob.child) {
      try {
        currentJob.child.kill();
      } catch (e) {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`启动失败：端口 ${cfg && cfg.port} 已被占用。`);
    console.error('可能已有后台实例在运行。可执行以下命令排查/结束：');
    console.error(`  netstat -ano | findstr :${cfg && cfg.port}`);
    console.error('或修改 admin/config.json 中的 port 后重试。');
  } else {
    console.error('启动失败：', e);
  }
  process.exit(1);
});
