'use strict';
/* ============================================================
   flytotmoon 博客后台管理系统 —— 前端应用
   原生 JS 单页应用，无第三方依赖。
   ============================================================ */

/* ------------------------------ 基础工具 ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function toast(msg, type = 'info', ms = 2600) {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, ms);
}

function confirmModal(title, message, danger = false) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-mask">
        <div class="modal">
          <h3>${esc(title)}</h3>
          <p>${esc(message)}</p>
          <div class="modal-actions">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">确定</button>
          </div>
        </div>
      </div>`;
    const close = (val) => { root.innerHTML = ''; resolve(val); };
    $('.modal-mask', root).addEventListener('click', (e) => { if (e.target === $('.modal-mask', root)) close(false); });
    $('[data-act="cancel"]', root).addEventListener('click', () => close(false));
    $('[data-act="ok"]', root).addEventListener('click', () => close(true));
  });
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板', 'ok')).catch(() => fallbackCopy(text));
  }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('已复制到剪贴板', 'ok');
  } catch (e) {
    toast('复制失败，请手动复制', 'error');
  }
  ta.remove();
}

/* ------------------------------ 认证与 API ------------------------------ */

let TOKEN = localStorage.getItem('ftm_token') || null;
let USER = localStorage.getItem('ftm_user') || '';

/* ------------------------------ 运行模式 ------------------------------
 * local  = 本机 Node 服务（node admin/server.js，默认 http://127.0.0.1:4321）
 * github = GitHub 云端模式：后台页面发布在博客 /admin/ 下，直接通过
 *          GitHub 仓库 REST API 管理文章、上传图片并触发 Actions 构建部署
 * --------------------------------------------------------------------- */
let MODE = localStorage.getItem('ftm_mode') || '';
if (!MODE) {
  MODE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'local' : 'github';
}
let GH = { token: '', owner: 'flytotmoon', repo: 'flytotmoon.github.io', branch: 'source', prefix: 'source' };
try {
  GH = Object.assign(GH, JSON.parse(localStorage.getItem('ftm_gh') || 'null') || {});
} catch (e) { /* ignore */ }
function saveGH() {
  localStorage.setItem('ftm_gh', JSON.stringify(GH));
  localStorage.setItem('ftm_mode', MODE);
}

/* ------------------------------ 图床（云相册）配置 ------------------------------ */

const DEFAULT_STORAGE_CFG = {
  backend: 'github', // github | oss | custom
  oss: {
    accessKeyId: '',
    accessKeySecret: '',
    bucket: '',
    endpoint: 'oss-cn-beijing.aliyuncs.com',
    dirPrefix: 'img/upload',
    customDomain: '',
  },
  custom: { uploadUrl: '', fieldName: 'file', headers: [], urlRegex: '' },
};

let STORAGE = JSON.parse(JSON.stringify(DEFAULT_STORAGE_CFG));
try {
  const saved = JSON.parse(localStorage.getItem('ftm_storage') || 'null');
  if (saved) STORAGE = Object.assign(STORAGE, saved, { oss: Object.assign({}, STORAGE.oss, saved.oss || {}), custom: Object.assign({}, STORAGE.custom, saved.custom || {}) });
} catch (e) { /* ignore */ }

function saveStorageCfg() {
  localStorage.setItem('ftm_storage', JSON.stringify(STORAGE));
}

/** 本地上传记录（自定义图床无法列举时尤为有用） */
function pushUploadRecord(rec) {
  try {
    const list = JSON.parse(localStorage.getItem('ftm_uploads') || '[]');
    list.unshift(Object.assign({ time: Date.now() }, rec));
    localStorage.setItem('ftm_uploads', JSON.stringify(list.slice(0, 60)));
  } catch (e) { /* ignore */ }
}
function getUploadRecords() {
  try {
    return JSON.parse(localStorage.getItem('ftm_uploads') || '[]');
  } catch (e) {
    return [];
  }
}

/* ------------------------------ GitHub REST 适配层 ------------------------------ */

const GH_API = 'https://api.github.com';

function ghRepo() {
  return `/repos/${encodeURIComponent(GH.owner)}/${encodeURIComponent(GH.repo)}`;
}

function ghPath(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/');
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  try {
    return decodeURIComponent(escape(bin));
  } catch (e) {
    // 图片等二进制内容无法按 UTF-8 解码，直接返回原始字节串（避免抛「URI malformed」）
    return bin;
  }
}

/** 与本地服务一致的 key 编解码（base64url） */
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return decodeURIComponent(escape(atob(t)));
}

function nowLocalStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function ghFetch(path, opts = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {}),
  };
  if (GH.token) headers.Authorization = 'Bearer ' + GH.token;
  let res;
  try {
    res = await fetch(GH_API + path, { ...opts, headers });
  } catch (e) {
    throw new Error('无法连接 GitHub，请检查网络');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 204 等无内容 */ }
  if (!res.ok) {
    const raw = data && (data.message || data.error) ? String(data.message || data.error) : '';
    // 限流错误给出友好提示
    if (res.status === 403 && /rate limit/i.test(raw)) {
      throw Object.assign(new Error('GitHub API 限流（请求过于频繁）：请稍等 1~2 分钟再操作'), { status: res.status });
    }
    const msg = raw || `GitHub 请求失败 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

let ghTreeCache = null;
let ghTreeTime = 0;

async function ghTree(force) {
  // 目录树缓存 2 分钟，减少 API 请求频率（后台写入时会 force 刷新）
  if (!force && ghTreeCache && Date.now() - ghTreeTime < 120000) return ghTreeCache;
  const data = await ghFetch(`${ghRepo()}/git/trees/${encodeURIComponent(GH.branch)}?recursive=1`);
  ghTreeCache = data;
  ghTreeTime = Date.now();
  return data;
}

/** 目录树失效（任何写入操作后调用，避免列表读到旧缓存） */
function ghTreeInvalidate() {
  ghTreeCache = null;
  ghTreeTime = 0;
}

/** 写入操作后统一失效缓存（目录树 + 统计信息） */
function invalidateCaches() {
  ghTreeInvalidate();
  window.__metaCache = null;
  window.__metaTime = 0;
}

/** 列出某目录下的 .md 文件（大仓库 truncated 时按目录递归抓取） */
async function ghListPathsUnder(dir) {
  const prefix = String(dir).replace(/\/+$/, '') + '/';
  const tree = await ghTree();
  let entries = (tree.tree || []).filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && e.path.endsWith('.md'));
  if (tree.truncated) {
    entries = [];
    const walk = async (nodePath) => {
      const list = await ghFetch(`${ghRepo()}/contents/${ghPath(nodePath)}?ref=${encodeURIComponent(GH.branch)}`);
      for (const it of list || []) {
        if (it.type === 'file' && it.name.endsWith('.md')) entries.push({ path: it.path, sha: it.sha, size: it.size });
        else if (it.type === 'dir') await walk(it.path);
      }
    };
    await walk(dir);
  }
  return entries;
}

async function ghReadFile(path) {
  const data = await ghFetch(`${ghRepo()}/contents/${ghPath(path)}?ref=${encodeURIComponent(GH.branch)}`);
  return {
    sha: data.sha,
    text: data.encoding === 'base64' && data.content ? b64decode(data.content) : (data.content || ''),
  };
}

/**
 * 只取文件元信息（sha / 大小），不解码内容。
 * 图片等二进制文件用文本方式解码会抛「URI malformed」，删除/覆盖时必须用它。
 */
async function ghFileMeta(path) {
  const data = await ghFetch(`${ghRepo()}/contents/${ghPath(path)}?ref=${encodeURIComponent(GH.branch)}`);
  return { sha: data.sha, size: data.size || 0, encoding: data.encoding || '' };
}

async function ghWriteFile(path, text, sha, message) {
  await ghFetch(`${ghRepo()}/contents/${ghPath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: message || `admin: 更新 ${path}`,
      content: b64encode(text),
      branch: GH.branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

async function ghDeleteFile(path, sha, message) {
  await ghFetch(`${ghRepo()}/contents/${ghPath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message: message || `admin: 删除 ${path}`, branch: GH.branch, sha }),
  });
}

async function ghListMedia() {
  const dir = (GH.prefix || 'source').replace(/\/+$/, '') + '/img/upload';
  const tree = await ghTree();
  const prefix = dir + '/';
  return (tree.tree || [])
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && /\.(jpe?g|png|gif|webp|svg|avif|ico)$/i.test(e.path))
    .map((e) => {
      const rel = e.path.slice(prefix.length);
      return { name: rel.split('/').pop(), rel, url: '/img/upload/' + rel, size: e.size || 0, mtime: 0 };
    })
    .sort((a, b) => (a.rel < b.rel ? 1 : -1));
}

async function ghLoadPosts(scope) {
  const dir = (GH.prefix || 'source').replace(/\/+$/, '') + (scope === 'drafts' ? '/_drafts' : '/_posts');
  const entries = await ghListPathsUnder(dir);
  const posts = [];
  for (const en of entries) {
    try {
      const { text } = await ghReadFile(en.path);
      const { data, body } = FM.parseFrontMatter(text);
      const relPath = en.path.slice(dir.length + 1);
      posts.push({
        key: b64urlEncode(relPath),
        relPath,
        scope,
        sha: en.sha,
        title: FM.fmGet(data, 'title') || relPath.split('/').pop().replace(/\.md$/, ''),
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
        words: FM.countWords(body),
        excerpt: FM.makeExcerpt(body),
        mtime: 0,
        body,
      });
    } catch (e) { /* 跳过读取失败的文件 */ }
  }
  return posts;
}

/** 上传图片到 GitHub 仓库（返回与本地服务一致的形状） */
async function githubUpload(formData) {
  const file = formData.get('file');
  if (!file || !file.size) throw new Error('未找到上传文件');
  if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB 限制');
  const extMatch = file.name.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'ico'].includes(ext)) {
    throw new Error('仅支持 jpg/png/gif/webp/svg/avif/ico 格式');
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const month = `${d.getFullYear()}${p(d.getMonth() + 1)}`;
  const rand = Math.random().toString(16).slice(2, 10);
  const base = FM.sanitizeName(file.name.replace(/\.[^.]+$/, '').slice(0, 40));
  const name = `${month}${p(d.getDate())}-${rand}-${base}.${ext}`;
  const rel = `${month}/${name}`;
  const filePath = (GH.prefix || 'source').replace(/\/+$/, '') + '/img/upload/' + rel;
  await ghFetch(`${ghRepo()}/contents/${ghPath(filePath)}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `admin: 上传图片 ${rel}`, content: btoa(bin), branch: GH.branch }),
  });
  invalidateCaches();
  return { ok: true, name, rel, url: '/img/upload/' + rel };
}

/**
 * GitHub 模式下的接口适配器：把本地服务的 REST 语义
 * 映射到 GitHub 仓库 API，前端各视图无需感知差异。
 */
async function githubApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const u = new URL(path, location.origin);
  const p = u.pathname;
  const q = u.searchParams;
  let body = {};
  if (opts.body) {
    try { body = JSON.parse(opts.body); } catch (e) { /* ignore */ }
  }
  const prefix = (GH.prefix || 'source').replace(/\/+$/, '');
  const postsDir = prefix + '/_posts';
  const draftsDir = prefix + '/_drafts';
  const mediaDir = prefix + '/img/upload';
  const SITE_KEYS = ['title', 'subtitle', 'description', 'keywords', 'author', 'url', 'language'];
  const wrap = (obj) => ({ ok: true, ...obj });

  try {
    /* ---- 登录 / 校验 ---- */
    if (p === '/api/auth/login') {
      const me = await ghFetch('/user');
      return wrap({ token: 'gh-' + Date.now(), username: me.login, expiresInDays: null });
    }
    if (p === '/api/auth/check') {
      const me = await ghFetch('/user');
      return wrap({ username: me.login });
    }
    if (p === '/api/auth/password') {
      throw new Error('GitHub 模式没有本地密码；如需更换，请更新访问令牌后重新连接');
    }

    /* ---- 统计 ---- */
    if (p === '/api/meta' && method === 'GET') {
      const [posts, drafts] = await Promise.all([ghLoadPosts('posts'), ghLoadPosts('drafts')]);
      const cats = new Map();
      const tags = new Map();
      let wordsTotal = 0;
      for (const pp of posts) {
        wordsTotal += pp.words;
        for (const c of pp.categories) cats.set(c, (cats.get(c) || 0) + 1);
        for (const t of pp.tags) tags.set(t, (tags.get(t) || 0) + 1);
      }
      for (const pp of drafts) wordsTotal += pp.words;
      return wrap({
        posts: posts.length,
        drafts: drafts.length,
        categories: [...cats.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        tags: [...tags.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        wordsTotal,
        recent: posts.slice(0, 6).map((pp) => ({ key: pp.key, title: pp.title, date: pp.date, categories: pp.categories })),
      });
    }

    /* ---- 文章列表 ---- */
    if (p === '/api/posts' && method === 'GET') {
      const scope = q.get('scope') === 'drafts' ? 'drafts' : 'posts';
      const qq = (q.get('q') || '').trim().toLowerCase();
      const category = (q.get('category') || '').trim();
      const tag = (q.get('tag') || '').trim();
      const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
      const size = Math.min(100, Math.max(1, parseInt(q.get('size') || '20', 10) || 20));
      let posts = await ghLoadPosts(scope);
      if (qq) {
        posts = posts.filter((pp) => `${pp.title} ${pp.tags.join(' ')} ${pp.categories.join(' ')} ${pp.body}`.toLowerCase().includes(qq));
      }
      if (category) posts = posts.filter((pp) => pp.categories.includes(category));
      if (tag) posts = posts.filter((pp) => pp.tags.includes(tag));
      posts.sort((a, b) => {
        // 置顶优先级高的排在前面
        if ((b.sticky || 0) !== (a.sticky || 0)) return (b.sticky || 0) - (a.sticky || 0);
        const da = String(a.date || '');
        const db = String(b.date || '');
        if (da === db) return 0;
        return da < db ? 1 : -1;
      });
      const total = posts.length;
      const pagePosts = posts.slice((page - 1) * size, page * size).map((pp) => ({
        key: pp.key, title: pp.title, date: pp.date, updated: pp.updated, tags: pp.tags,
        categories: pp.categories, cover: pp.cover, sticky: pp.sticky, mathjax: pp.mathjax,
        words: pp.words, excerpt: pp.excerpt, mtime: 0,
      }));
      return wrap({ total, page, size, posts: pagePosts });
    }

    /* ---- 新建文章 ---- */
    if (p === '/api/posts' && method === 'POST') {
      if (!body.title || !String(body.title).trim()) throw new Error('标题不能为空');
      const scope = body.scope === 'drafts' ? 'drafts' : 'posts';
      const dir = scope === 'drafts' ? draftsDir : postsDir;
      const title = String(body.title).trim();
      const content = String(body.content || '');
      const data = [];
      FM.fmSet(data, 'title', title);
      FM.fmSet(data, 'date', body.date || nowLocalStr());
      if (body.updated) FM.fmSet(data, 'updated', String(body.updated));
      if (Array.isArray(body.tags) && body.tags.length) FM.fmSet(data, 'tags', body.tags.map((t) => String(t).trim()).filter(Boolean), 'list');
      if (Array.isArray(body.categories) && body.categories.length) FM.fmSet(data, 'categories', body.categories.map((t) => String(t).trim()).filter(Boolean), 'list');
      if (body.cover) FM.fmSet(data, 'cover', String(body.cover).trim());
      if (body.description) FM.fmSet(data, 'description', String(body.description).trim());
      if (Number(body.sticky) > 0) FM.fmSet(data, 'sticky', Number(body.sticky) || 1);
      if (body.mathjax) FM.fmSet(data, 'mathjax', true);
      if (body.comments === false) FM.fmSet(data, 'comments', false);
      if (body.top_img) FM.fmSet(data, 'top_img', String(body.top_img).trim());

      const tree = await ghTree(true);
      const existing = new Set((tree.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));
      let subdir = '';
      if (scope === 'posts') {
        const cat = (FM.fmGet(data, 'categories') || [])[0];
        if (cat) {
          const catPath = postsDir + '/' + FM.sanitizeName(String(cat)) + '/';
          if ((tree.tree || []).some((e) => e.type === 'blob' && e.path.startsWith(catPath))) {
            subdir = FM.sanitizeName(String(cat)) + '/';
          }
        }
      }
      const base = FM.sanitizeName(title);
      let name = base + '.md';
      let n = 2;
      while (existing.has(dir + '/' + subdir + name)) { name = `${base}-${n}.md`; n++; }
      const relPath = subdir + name;
      await ghWriteFile(dir + '/' + relPath, FM.buildFrontMatter(data, content), null, `admin: 新建文章「${title}」`);
      invalidateCaches();
      return wrap({ key: b64urlEncode(relPath) });
    }

    /* ---- 单篇：读取 / 发布 / 更新 / 删除 ---- */
    const mSingle = p.match(/^\/api\/posts\/(.+)$/);
    if (mSingle) {
      const rest = decodeURIComponent(mSingle[1]);

      if (rest.endsWith('/publish') && method === 'POST') {
        const relPath = b64urlDecode(rest.slice(0, -'/publish'.length));
        const filePath = draftsDir + '/' + relPath;
        const { text, sha } = await ghReadFile(filePath);
        const { data, body: oldBody } = FM.parseFrontMatter(text);
        if (!FM.fmGet(data, 'date')) FM.fmSet(data, 'date', nowLocalStr());
        const content = FM.buildFrontMatter(data, oldBody);
        const tree = await ghTree(true);
        const existing = new Set((tree.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));
        const cat = (FM.fmGet(data, 'categories') || [])[0];
        let subdir = '';
        if (cat) {
          const catPath = postsDir + '/' + FM.sanitizeName(String(cat)) + '/';
          if ((tree.tree || []).some((e) => e.type === 'blob' && e.path.startsWith(catPath))) subdir = FM.sanitizeName(String(cat)) + '/';
        }
        const base = FM.sanitizeName(relPath.split('/').pop().replace(/\.md$/, ''));
        let name = base + '.md';
        let n = 2;
        while (existing.has(postsDir + '/' + subdir + name)) { name = `${base}-${n}.md`; n++; }
        const newRel = subdir + name;
        await ghWriteFile(postsDir + '/' + newRel, content, null, `admin: 发布草稿「${FM.fmGet(data, 'title')}」`);
        await ghDeleteFile(filePath, sha, `admin: 发布后删除草稿 ${relPath}`);
        invalidateCaches();
        return wrap({ key: b64urlEncode(newRel) });
      }

      if (method === 'GET') {
        const scope = q.get('scope') === 'drafts' ? 'drafts' : 'posts';
        const dir = scope === 'drafts' ? draftsDir : postsDir;
        const relPath = b64urlDecode(rest);
        const { text, sha } = await ghReadFile(dir + '/' + relPath);
        const { data, body: postBody } = FM.parseFrontMatter(text);
        return wrap({
          post: {
            key: b64urlEncode(relPath),
            relPath,
            scope,
            sha,
            title: FM.fmGet(data, 'title') || relPath.split('/').pop().replace(/\.md$/, ''),
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
            words: FM.countWords(postBody),
            excerpt: FM.makeExcerpt(postBody),
            mtime: 0,
            body: postBody,
          },
        });
      }

      if (method === 'PUT') {
        const scope = body.scope === 'drafts' ? 'drafts' : 'posts';
        const dir = scope === 'drafts' ? draftsDir : postsDir;
        const relPath = b64urlDecode(rest);
        const filePath = dir + '/' + relPath;
        const { text, sha } = await ghReadFile(filePath);
        const { data, body: oldBody } = FM.parseFrontMatter(text);
        const origDate = FM.fmGet(data, 'date');
        FM.applyMeta(data, body);
        const newTitle = body.title ? String(body.title).trim() : FM.fmGet(data, 'title');
        FM.fmSet(data, 'title', newTitle);
        if (!FM.fmGet(data, 'date') && origDate) FM.fmSet(data, 'date', origDate);
        const newContent = FM.buildFrontMatter(data, body.content !== undefined ? String(body.content) : oldBody);

        const curBase = FM.sanitizeName(relPath.split('/').pop().replace(/\.md$/, ''));
        const newBase = FM.sanitizeName(newTitle);
        if (newBase !== curBase) {
          const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '';
          const tree = await ghTree(true);
          const existing = new Set((tree.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));
          let name = newBase + '.md';
          let n = 2;
          while (existing.has(dir + '/' + parent + name)) { name = `${newBase}-${n}.md`; n++; }
          const newRel = parent + name;
          await ghWriteFile(dir + '/' + newRel, newContent, null, `admin: 更新并重命名「${newTitle}」`);
          await ghDeleteFile(filePath, sha, `admin: 删除旧文件 ${relPath}`);
          invalidateCaches();
          return wrap({ key: b64urlEncode(newRel) });
        }
        await ghWriteFile(filePath, newContent, sha, `admin: 更新「${newTitle}」`);
        invalidateCaches();
        return wrap({ key: b64urlEncode(relPath) });
      }

      if (method === 'DELETE') {
        const scope = q.get('scope') === 'drafts' ? 'drafts' : 'posts';
        const dir = scope === 'drafts' ? draftsDir : postsDir;
        const relPath = b64urlDecode(rest);
        const filePath = dir + '/' + relPath;
        const { sha } = await ghFileMeta(filePath);
        await ghDeleteFile(filePath, sha, `admin: 删除「${relPath}」`);
        invalidateCaches();
        return wrap({ message: '已从仓库删除（可通过 Git 历史找回）' });
      }
    }

    /* ---- 图床配置（浏览器本地保存） ---- */
    if (p === '/api/storage' && method === 'GET') {
      return wrap({ storage: STORAGE });
    }
    if (p === '/api/storage' && method === 'PUT') {
      STORAGE = Object.assign(STORAGE, body, {
        oss: Object.assign({}, STORAGE.oss, body.oss || {}),
        custom: Object.assign({}, STORAGE.custom, body.custom || {}),
      });
      if (!Array.isArray(STORAGE.custom.headers)) STORAGE.custom.headers = [];
      saveStorageCfg();
      return wrap({ storage: STORAGE, message: '图床配置已保存（仅存于本浏览器）' });
    }

    /* ---- 云相册（按当前图床） ---- */
    if (p === '/api/gallery' && method === 'GET') {
      if ((STORAGE.backend || 'github') === 'github') {
        return wrap({ backend: 'github', files: await ghListMedia() });
      }
      const files = await FTMStorage.list(STORAGE, 200);
      return wrap({ backend: STORAGE.backend, files });
    }
    if (p === '/api/gallery' && method === 'DELETE') {
      const key = q.get('key') || '';
      if (!key) throw new Error('缺少 key 参数');
      if ((STORAGE.backend || 'github') === 'github') {
        const filePath = mediaDir + '/' + key;
        const { sha } = await ghFileMeta(filePath);
        await ghDeleteFile(filePath, sha, `admin: 删除图片 ${key}`);
        invalidateCaches();
        return wrap({ message: '已从仓库删除' });
      }
      await FTMStorage.remove(STORAGE, key);
      return wrap({ message: '已删除' });
    }

    /* ---- 媒体 ---- */
    if (p === '/api/media' && method === 'GET') {
      return wrap({ files: await ghListMedia() });
    }
    const mMedia = p.match(/^\/api\/media\/(.+)$/);
    if (mMedia && method === 'DELETE') {
      const rel = decodeURIComponent(mMedia[1]);
      const filePath = mediaDir + '/' + rel;
      const { sha } = await ghFileMeta(filePath);
      await ghDeleteFile(filePath, sha, `admin: 删除图片 ${rel}`);
      invalidateCaches();
      return wrap({ message: '已删除' });
    }

    /* ---- 站点配置 ---- */
    if (p === '/api/site-config' && method === 'GET') {
      const { text } = await ghReadFile('_config.yml');
      const cfg = {};
      for (const key of SITE_KEYS) {
        const m = new RegExp('^' + key + '\\s*:\\s*(.*)$', 'm').exec(text);
        if (m) cfg[key] = m[1].trim().replace(/^['"]|['"]$/g, '');
      }
      return wrap({ config: cfg });
    }
    if (p === '/api/site-config' && method === 'PUT') {
      const { text, sha } = await ghReadFile('_config.yml');
      let next = text;
      const updated = [];
      for (const key of SITE_KEYS) {
        if (!(key in body)) continue;
        const re = new RegExp('^' + key + '\\s*:.*$', 'm');
        const replacement = `${key}: ${String(body[key]).trim()}`;
        if (re.test(next)) next = next.replace(re, replacement);
        else next += `\n${replacement}\n`;
        updated.push(key);
      }
      await ghWriteFile('_config.yml', next, sha, 'admin: 更新站点配置');
      return wrap({ updated });
    }

    /* ---- 友链 / 装备 / 创意技能（data yml） ---- */
    const DATA_MAP = {
      '/api/link': 'link.yml',
      '/api/equipment': 'equipment.yml',
      '/api/creativity': 'creativity.yml',
    };
    if (DATA_MAP[p] && method === 'GET') {
      const { text } = await ghReadFile(prefix + '/_data/' + DATA_MAP[p]);
      return wrap({ content: text });
    }
    if (DATA_MAP[p] && method === 'PUT') {
      if (typeof body.content !== 'string') throw new Error('缺少内容');
      const filePath = prefix + '/_data/' + DATA_MAP[p];
      const { sha } = await ghReadFile(filePath);
      await ghWriteFile(filePath, body.content, sha, `admin: 更新 ${DATA_MAP[p]}`);
      return wrap({ message: '保存成功（Git 历史即备份，约 2~5 分钟后自动上线）' });
    }

    /* ---- 自我介绍（about.yml） ---- */
    if (p === '/api/about' && method === 'GET') {
      const { text } = await ghReadFile(prefix + '/_data/about.yml');
      return wrap({ content: text });
    }
    if (p === '/api/about' && method === 'PUT') {
      if (typeof body.content !== 'string') throw new Error('缺少内容');
      const filePath = prefix + '/_data/about.yml';
      const { sha } = await ghReadFile(filePath);
      await ghWriteFile(filePath, body.content, sha, 'admin: 更新自我介绍');
      return wrap({ message: '保存成功（Git 历史即备份，约 2~5 分钟后自动上线）' });
    }

    /* ---- 相册集（album.yml） ---- */
    if (p === '/api/album' && method === 'GET') {
      const { text } = await ghReadFile(prefix + '/_data/album.yml');
      return wrap({ content: text });
    }
    if (p === '/api/album' && method === 'PUT') {
      if (typeof body.content !== 'string') throw new Error('缺少内容');
      const content = normalizeImageFields(body.content);
      const filePath = prefix + '/_data/album.yml';
      const { sha } = await ghReadFile(filePath);
      await ghWriteFile(filePath, content, sha, 'admin: 更新相册集');
      // 自动为缺少详情页的相册创建页面（避免点击相册卡片 404）
      const tree = await ghTree(true);
      const existing = new Set((tree.tree || []).map((e) => e.path));
      const createdPages = [];
      let className = '';
      for (const raw of String(content).split(/\r?\n/)) {
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
          const pagePath = prefix + '/' + dir + '/index.md';
          if (existing.has(pagePath)) continue;
          const fm = `---\ntitle: ${className || dir}\ndate: ${nowLocalStr()}\naside: false\ntop_img: false\ntype: "album_detail"\n---\n`;
          await ghWriteFile(pagePath, fm, null, `admin: 自动创建相册页面 ${pm[1]}`);
          existing.add(pagePath);
          createdPages.push(pm[1]);
        }
      }
      return wrap({
        message: '保存成功（Git 历史即备份，约 2~5 分钟后自动上线）',
        createdPages,
      });
    }

    /* ---- 千言万语（essay.yml） ---- */
    if (p === '/api/essay' && method === 'GET') {
      const { text } = await ghReadFile(prefix + '/_data/essay.yml');
      return wrap({ content: text });
    }
    if (p === '/api/essay' && method === 'PUT') {
      if (typeof body.content !== 'string') throw new Error('缺少内容');
      const content = normalizeImageFields(body.content);
      const filePath = prefix + '/_data/essay.yml';
      const { sha } = await ghReadFile(filePath);
      await ghWriteFile(filePath, content, sha, 'admin: 更新千言万语');
      return wrap({ message: '保存成功（Git 历史即备份，约 2~5 分钟后自动上线）' });
    }

    /* ---- 原始配置文件 ---- */
    if (p === '/api/config-file' && method === 'GET') {
      const name = q.get('file') || '';
      if (!['_config.yml', '_config.anzhiyu.yml'].includes(name)) throw new Error('不允许读取该文件');
      const { text } = await ghReadFile(name);
      return wrap({ file: name, content: text });
    }
    if (p === '/api/config-file' && method === 'PUT') {
      const name = body.file || '';
      if (!['_config.yml', '_config.anzhiyu.yml'].includes(name)) throw new Error('不允许修改该文件');
      if (typeof body.content !== 'string') throw new Error('缺少内容');
      const { sha } = await ghFileMeta(name);
      await ghWriteFile(name, body.content, sha, `admin: 更新 ${name}`);
      return wrap({ message: '保存成功（Git 历史即备份）' });
    }

    /* ---- 构建 ---- */
    if (p === '/api/build' && method === 'POST') {
      await ghFetch(`${ghRepo()}/actions/workflows/auto-deploy.yml/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: GH.branch }),
      });
      return wrap({ job: { id: 'dispatch', action: 'deploy', status: 'running', startedAt: Date.now(), log: [] } });
    }
    if (p === '/api/build/status' && method === 'GET') {
      const runs = await ghFetch(`${ghRepo()}/actions/workflows/auto-deploy.yml/runs?per_page=1&branch=${encodeURIComponent(GH.branch)}`);
      const run = (runs.workflow_runs || [])[0];
      if (!run) return wrap({ running: null, last: null });
      const mapped = {
        id: run.id,
        action: 'deploy',
        status: run.status === 'completed' ? (run.conclusion === 'success' ? 'done' : 'error') : 'running',
        startedAt: Date.parse(run.created_at) || 0,
        finishedAt: run.status === 'completed' ? (Date.parse(run.updated_at) || Date.now()) : null,
        exitCode: run.conclusion === 'success' ? 0 : run.conclusion ? 1 : null,
        log: [],
        htmlUrl: run.html_url,
      };
      if (run.status === 'completed') return wrap({ running: null, last: mapped });
      return wrap({ running: mapped, last: mapped });
    }
    if (p === '/api/build/events') {
      throw new Error('GitHub 模式无实时日志流，请在「构建发布」页查看状态或前往 GitHub Actions');
    }

    throw new Error('接口不存在：' + p);
  } catch (e) {
    if (e && e.status === 401) {
      logout(false);
      throw new Error('GitHub 令牌无效或已过期，请重新连接');
    }
    // 构建相关接口的权限错误给出明确指引
    if (e && e.status === 403 && (p.includes('/api/build') || p === '/api/build/status')) {
      throw new Error('令牌缺少 Workflows 权限（403）：请到 GitHub → Settings → Developer settings → Personal access tokens，给令牌的仓库权限勾选 Workflows: Read and write，保存后重新连接');
    }
    if (e && e.status === 422 && p === '/api/build') {
      throw new Error('工作流不支持手动触发（422）：请确认 .github/workflows/auto-deploy.yml 已推送到源码分支且包含 workflow_dispatch');
    }
    if (e && e.status === 404 && p === '/api/build') {
      throw new Error('未找到构建工作流（404）：请确认 .github/workflows/auto-deploy.yml 在源码分支上');
    }
    throw e;
  }
}

async function api(path, opts = {}) {
  if (MODE === 'github') return githubApi(path, opts);
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (e) {
    throw new Error('无法连接后台服务，请确认 server.js 已启动');
  }
  if (res.status === 401 && !path.includes('/auth/login')) {
    logout(false);
    throw new Error('登录已过期，请重新登录');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error((data && data.message) || `请求失败 (${res.status})`);
  // 写入类请求成功后失效统计缓存，保证列表/仪表盘显示最新数据
  if ((opts.method || 'GET').toUpperCase() !== 'GET') invalidateCaches();
  return data;
}

async function apiUpload(formData) {
  // GitHub 云端模式：按图床配置在浏览器侧直接上传
  if (MODE === 'github') {
    const file = formData.get('file');
    if (!file) throw new Error('未找到上传文件');
    const backend = STORAGE.backend || 'github';
    if (backend === 'github') return githubUpload(formData);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await FTMStorage.upload(STORAGE, {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      bytes,
    });
    invalidateCaches();
    return { ok: true, backend, name: out.key.split('/').pop(), key: out.key, url: out.url };
  }
  // 本机模式：交给服务端按图床配置上传
  let res;
  try {
    res = await fetch('/api/upload', {
      method: 'POST',
      headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
      body: formData,
    });
  } catch (e) {
    throw new Error('无法连接后台服务');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error((data && data.message) || '上传失败');
  invalidateCaches();
  return data;
}

function mediaSrc(rel) {
  if (MODE === 'github') {
    const segs = [(GH.prefix || 'source'), 'img/upload', ...String(rel).split('/')].map(encodeURIComponent);
    return `https://raw.githubusercontent.com/${encodeURIComponent(GH.owner)}/${encodeURIComponent(GH.repo)}/${encodeURIComponent(GH.branch)}/${segs.join('/')}`;
  }
  return `/admin/media/?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(TOKEN || '')}`;
}

/* ------------------------------ 登录 / 登出 ------------------------------ */

function showLogin(errorMsg) {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  const err = $('#login-error');
  if (errorMsg) {
    err.textContent = errorMsg;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
}

function setGhError(msg) {
  const err = $('#github-error');
  if (msg) {
    err.textContent = msg;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
}

function setupLoginTabs() {
  const setTab = (m) => {
    $('#tab-local').classList.toggle('active', m === 'local');
    $('#tab-github').classList.toggle('active', m === 'github');
    $('#login-form').classList.toggle('hidden', m !== 'local');
    $('#github-panel').classList.toggle('hidden', m !== 'github');
  };
  $('#tab-local').addEventListener('click', () => setTab('local'));
  $('#tab-github').addEventListener('click', () => setTab('github'));
  // 支持 ?mode=github / ?mode=local 直接定位标签页
  const qm = new URLSearchParams(location.search).get('mode');
  if (qm === 'github' || qm === 'local') setTab(qm);
  else setTab(MODE);
  // 预填 GitHub 配置
  $('#gh-token').value = GH.token || '';
  $('#gh-owner').value = GH.owner || '';
  $('#gh-repo').value = GH.repo || '';
  $('#gh-branch').value = GH.branch || '';
  $('#gh-prefix').value = GH.prefix || '';
}

/** 从表单读取并保存 GitHub 连接配置 */
function readGhForm() {
  GH.token = $('#gh-token').value.trim();
  GH.owner = $('#gh-owner').value.trim().replace(/\/.*$/, '');
  GH.repo = $('#gh-repo').value.trim();
  GH.branch = $('#gh-branch').value.trim() || 'source';
  GH.prefix = $('#gh-prefix').value.trim() || 'source';
  if (!GH.token) throw new Error('请填写 GitHub 访问令牌（PAT）');
  if (!GH.owner || !GH.repo) throw new Error('请填写仓库 Owner 与仓库名');
  saveGH();
}

/** 连接测试：验证令牌、仓库、分支、源码目录与构建工作流 */
async function ghVerify() {
  readGhForm();
  // 1) 令牌有效性
  let me;
  try {
    me = await ghFetch('/user');
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      throw new Error('令牌无效或已过期（请确认复制了完整的 github_pat_ 开头字符串）');
    }
    throw new Error('无法连接 GitHub：' + e.message);
  }
  // 2) 仓库访问
  let repo;
  try {
    repo = await ghFetch(ghRepo());
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`仓库 ${GH.owner}/${GH.repo} 不存在，或令牌没有该仓库的访问权限（Repository access 需勾选这个仓库）`);
    }
    if (e.status === 403) {
      throw new Error(`没有权限访问仓库 ${GH.owner}/${GH.repo}（请检查令牌的 Repository access 设置）`);
    }
    throw new Error('读取仓库失败：' + e.message);
  }
  // 3) 分支是否存在
  let tree;
  try {
    tree = await ghFetch(`${ghRepo()}/git/trees/${encodeURIComponent(GH.branch)}?recursive=1`);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`分支「${GH.branch}」在仓库中不存在——源码还没有推送到 GitHub。请先按 admin/README.md 的步骤执行 git push -u origin ${GH.branch}`);
    }
    throw new Error('读取分支失败：' + e.message);
  }
  const prefix = (GH.prefix || 'source').replace(/\/+$/, '');
  const hasPosts = (tree.tree || []).some((en) => en.type === 'blob' && en.path.startsWith(prefix + '/_posts/'));
  const hasWorkflow = (tree.tree || []).some((en) => en.type === 'blob' && en.path === '.github/workflows/auto-deploy.yml');
  return { login: me.login, hasPosts, hasWorkflow, defaultBranch: repo.default_branch };
}

function setupGithubPanel() {
  $('#gh-test').addEventListener('click', async () => {
    const btn = $('#gh-test');
    btn.disabled = true;
    try {
      const info = await ghVerify();
      setGhError(null);
      const hints = [];
      if (!info.hasPosts) hints.push('文章目录未找到（源码未推送？）');
      if (!info.hasWorkflow) hints.push('自动构建工作流未配置');
      if (info.defaultBranch && info.defaultBranch === GH.branch) hints.push('当前分支是默认分支，建议源码放在 source 分支');
      let msg = `连接成功：账号 ${info.login}；仓库访问 ✓；分支 ${GH.branch} ✓`;
      if (info.hasPosts && info.hasWorkflow) msg += '；文章目录 ✓；构建工作流 ✓';
      else msg += '；' + hints.join('；');
      toast(msg, info.hasPosts && info.hasWorkflow ? 'ok' : 'warn', 6000);
    } catch (e) {
      setGhError(e.message);
      toast(e.message, 'error', 5000);
    } finally {
      btn.disabled = false;
    }
  });

  $('#gh-connect').addEventListener('click', async () => {
    const btn = $('#gh-connect');
    btn.disabled = true;
    try {
      readGhForm();
      const data = await githubApi('/api/auth/login', { method: 'POST', body: '{}' });
      TOKEN = data.token;
      USER = data.username;
      localStorage.setItem('ftm_token', TOKEN);
      localStorage.setItem('ftm_user', USER);
      localStorage.setItem('ftm_mode', 'github');
      MODE = 'github';
      enterApp();
    } catch (e) {
      setGhError(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/** 登录 / 连接成功后进入应用 */
function enterApp() {
  $('#topbar-username').textContent = USER;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#login-password').value = '';
  toast(`欢迎回来，${USER}`, 'ok');
  location.hash = '#/dashboard';
  route();
}

function logout(clearSession = true) {
  if (clearSession) {
    TOKEN = null;
    USER = '';
    localStorage.removeItem('ftm_token');
    localStorage.removeItem('ftm_user');
  }
  closeBuildSSE();
  showLogin(null);
}

async function doLogin(e) {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#login-username').value.trim(),
        password: $('#login-password').value,
      }),
    });
    TOKEN = data.token;
    USER = data.username;
    localStorage.setItem('ftm_token', TOKEN);
    localStorage.setItem('ftm_user', USER);
    localStorage.setItem('ftm_mode', 'local');
    MODE = 'local';
    enterApp();
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '登 录';
  }
}

async function initAuth() {
  if (!TOKEN) { showLogin(null); return; }
  try {
    const data = await api('/api/auth/check');
    USER = data.username || USER;
    $('#topbar-username').textContent = USER;
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    route();
  } catch (e) {
    showLogin(e.message);
  }
}

/* ------------------------------ 路由 ------------------------------ */

const PAGE_TITLES = {
  dashboard: '仪表盘',
  posts: '文章管理',
  drafts: '草稿箱',
  essay: '千言万语',
  album: '相册集',
  about: '自我介绍',
  flink: '友链管理',
  equipment: '我的装备',
  creativity: '创意技能',
  editor: '编辑文章',
  media: '媒体库',
  settings: '站点设置',
  build: '构建发布',
};

let lastRoute = null;
/** 离开当前视图时需要解绑的事件（如媒体库的粘贴上传），由各视图自行登记 */
let VIEW_CLEANUP = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qIdx = raw.indexOf('?');
  const path = (qIdx === -1 ? raw : raw.slice(0, qIdx)) || 'dashboard';
  const params = new URLSearchParams(qIdx === -1 ? '' : raw.slice(qIdx + 1));
  return { path, params };
}

function route() {
  const { path, params } = parseHash();
  if (path === lastRoute) { /* 相同路由不重渲染（列表筛选等走内部状态） */ }
  lastRoute = path;

  // 切换视图前先解绑上一个视图登记的全局事件
  if (typeof VIEW_CLEANUP === 'function') {
    try { VIEW_CLEANUP(); } catch (e) { /* ignore */ }
  }
  VIEW_CLEANUP = null;

  $('#page-title').textContent = PAGE_TITLES[path] || '仪表盘';
  const activeRoute = path === 'editor' ? (params.get('scope') === 'drafts' ? 'drafts' : 'posts') : path;
  $$('#sidebar-nav .nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === activeRoute));
  closeSidebar();

  if (path !== 'build') closeBuildSSE();

  const container = $('#page-container');
  switch (path) {
    case 'dashboard': renderDashboard(container); break;
    case 'posts': renderPosts(container, 'posts'); break;
    case 'drafts': renderPosts(container, 'drafts'); break;
    case 'essay': renderEssay(container); break;
    case 'album': renderAlbum(container); break;
    case 'about': renderAbout(container); break;
    case 'flink': renderFlink(container); break;
    case 'equipment': renderEquipment(container); break;
    case 'creativity': renderCreativity(container); break;
    case 'editor': renderEditor(container, params); break;
    case 'media': renderMedia(container); break;
    case 'settings': renderSettings(container); break;
    case 'build': renderBuild(container); break;
    default: renderDashboard(container);
  }
  loadNavBadges();
  refreshBuildChip();
}

function navigate(hash) {
  location.hash = hash;
}

/* ------------------------------ 侧边栏（移动端） ------------------------------ */

function setupSidebar() {
  $('#sidebar-toggle').addEventListener('click', () => {
    $('#sidebar').classList.add('open');
    let mask = $('#sidebar-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'sidebar-mask';
      mask.className = 'sidebar-mask';
      document.body.appendChild(mask);
      mask.addEventListener('click', closeSidebar);
    }
    mask.classList.add('show');
  });
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  const mask = $('#sidebar-mask');
  if (mask) mask.classList.remove('show');
}

/* ------------------------------ 顶部状态 ------------------------------ */

async function loadNavBadges() {
  try {
    // meta 缓存 60 秒，减少 GitHub API 调用频率
    const now = Date.now();
    if (!window.__metaCache || !window.__metaTime || now - window.__metaTime > 60000) {
      window.__metaCache = await api('/api/meta');
      window.__metaTime = now;
    }
    const meta = window.__metaCache;
    const badge = $('#draft-count-badge');
    if (meta.drafts > 0) {
      badge.textContent = meta.drafts;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) {
    /* ignore */
  }
}

async function refreshBuildChip() {
  try {
    const st = await api('/api/build/status');
    const chip = $('#topbar-build-chip');
    const dot = $('#build-status-dot');
    const job = st.running || st.last;
    if (st.running) {
      chip.textContent = `正在构建：${job.action}`;
      chip.className = 'build-chip running';
      chip.classList.remove('hidden');
      dot.classList.remove('hidden');
    } else if (job) {
      chip.textContent = job.status === 'done' ? '上次构建成功' : '上次构建失败';
      chip.className = `build-chip ${job.status}`;
      chip.classList.remove('hidden');
      dot.classList.add('hidden');
    } else {
      chip.classList.add('hidden');
      dot.classList.add('hidden');
    }
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------ 仪表盘 ------------------------------ */

async function renderDashboard(container) {
  container.innerHTML = `
    <div class="grid dash-grid">
      <div>
        <div class="grid stat-grid" id="stat-grid">
          <div class="stat-card"><div class="stat-icon red">📝</div><div><div class="stat-value">…</div><div class="stat-label">文章</div></div></div>
          <div class="stat-card"><div class="stat-icon amber">📄</div><div><div class="stat-value">…</div><div class="stat-label">草稿</div></div></div>
          <div class="stat-card"><div class="stat-icon blue">🗂️</div><div><div class="stat-value">…</div><div class="stat-label">分类</div></div></div>
          <div class="stat-card"><div class="stat-icon green">🏷️</div><div><div class="stat-value">…</div><div class="stat-label">标签</div></div></div>
          <div class="stat-card"><div class="stat-icon violet">📊</div><div><div class="stat-value">…</div><div class="stat-label">总字数</div></div></div>
        </div>
        <div class="card" style="margin-top:18px">
          <div class="card-head"><h3>最近文章</h3><a class="btn btn-sm" href="#/posts">全部文章</a></div>
          <div class="card-body" style="padding:8px 20px" id="recent-list"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="card-head"><h3>快捷操作</h3></div>
          <div class="card-body quick-actions">
            <a class="btn btn-primary" href="#/editor">✍️ 写新文章</a>
            <button class="btn" id="quick-build">⚡ 立即构建</button>
            <a class="btn" href="https://blog.flytotmoon.cn" target="_blank" rel="noopener">🌐 打开博客</a>
          </div>
        </div>
        <div class="card" style="margin-top:18px">
          <div class="card-head"><h3>分类分布</h3></div>
          <div class="card-body" id="category-bars"></div>
        </div>
        <div class="card" style="margin-top:18px">
          <div class="card-head"><h3>标签云</h3></div>
          <div class="card-body tag-cloud" id="tag-cloud"></div>
        </div>
      </div>
    </div>`;

  $('#quick-build').addEventListener('click', async () => {
    try {
      await api('/api/build', { method: 'POST', body: JSON.stringify({ action: 'generate' }) });
      toast(MODE === 'github' ? '已触发 GitHub Actions 构建，可在「构建发布」页查看状态' : '已开始构建，可在「构建发布」页查看日志', 'ok');
      refreshBuildChip();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  try {
    const meta = window.__metaCache || await api('/api/meta');
    window.__metaCache = meta;
    const values = $('#stat-grid').querySelectorAll('.stat-value');
    values[0].textContent = meta.posts;
    values[1].textContent = meta.drafts;
    values[2].textContent = meta.categories.length;
    values[3].textContent = meta.tags.length;
    values[4].textContent = meta.wordsTotal.toLocaleString();

    const bars = $('#category-bars');
    const max = Math.max(1, ...meta.categories.map((c) => c.count));
    if (!meta.categories.length) {
      bars.innerHTML = '<div class="empty-state">暂无分类</div>';
    } else {
      bars.innerHTML = meta.categories.slice(0, 8).map((c) => `
        <div class="bar-row">
          <span class="bar-label" title="${esc(c.name)}">${esc(c.name)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(c.count / max) * 100}%"></div></div>
          <span class="bar-count">${c.count}</span>
        </div>`).join('');
    }

    const cloud = $('#tag-cloud');
    if (!meta.tags.length) {
      cloud.innerHTML = '<div class="empty-state">暂无标签</div>';
    } else {
      cloud.innerHTML = meta.tags.slice(0, 30).map((t) => `<span class="chip" title="${esc(t.name)}">${esc(t.name)} ${t.count}</span>`).join('');
    }

    const recent = $('#recent-list');
    if (!meta.recent.length) {
      recent.innerHTML = '<div class="empty-state">还没有文章，快去写第一篇吧</div>';
    } else {
      recent.innerHTML = `<ul class="recent-list">${meta.recent.map((p) => `
        <li class="recent-item" data-key="${esc(p.key)}">
          <span class="recent-title">${esc(p.title)}</span>
          <span class="recent-date">${esc(String(p.date || '').slice(0, 10))}</span>
        </li>`).join('')}</ul>`;
      $$('.recent-item', recent).forEach((li) => {
        li.addEventListener('click', () => navigate(`#/editor?key=${encodeURIComponent(li.dataset.key)}&scope=posts`));
      });
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ------------------------------ 文章 / 草稿列表 ------------------------------ */

const LIST_STATE = { q: '', category: '', tag: '', page: 1 };

async function renderPosts(container, scope) {
  const isDraft = scope === 'drafts';
  const meta = window.__metaCache || {};
  const cats = meta.categories || [];
  const tags = meta.tags || [];

  container.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>${isDraft ? '草稿箱' : '文章管理'} <span class="chip gray" id="post-total">共 0 篇</span></h3>
        <div style="display:flex;gap:8px">
          <a class="btn btn-sm" href="#/editor${isDraft ? '?scope=drafts' : ''}">＋ 新建${isDraft ? '草稿' : '文章'}</a>
        </div>
      </div>
      <div class="toolbar">
        <div class="field search-input">
          <input type="text" id="list-q" placeholder="搜索标题 / 标签 / 内容…" value="${esc(LIST_STATE.q)}" />
        </div>
        <div class="field">
          <select id="list-category">
            <option value="">全部分类</option>
            ${cats.map((c) => `<option value="${esc(c.name)}" ${LIST_STATE.category === c.name ? 'selected' : ''}>${esc(c.name)} (${c.count})</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <select id="list-tag">
            <option value="">全部标签</option>
            ${tags.map((t) => `<option value="${esc(t.name)}" ${LIST_STATE.tag === t.name ? 'selected' : ''}>${esc(t.name)} (${t.count})</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width:34%">标题</th>
              <th>日期</th>
              <th>分类</th>
              <th>标签</th>
              <th>字数</th>
              <th style="text-align:right">操作</th>
            </tr>
          </thead>
          <tbody id="post-rows"></tbody>
        </table>
      </div>
      <div class="pagination" id="post-pagination"></div>
    </div>`;

  const load = async () => {
    const params = new URLSearchParams({ scope, page: LIST_STATE.page, size: 20 });
    if (LIST_STATE.q) params.set('q', LIST_STATE.q);
    if (LIST_STATE.category) params.set('category', LIST_STATE.category);
    if (LIST_STATE.tag) params.set('tag', LIST_STATE.tag);
    try {
      const data = await api(`/api/posts?${params}`);
      $('#post-total').textContent = `共 ${data.total} 篇`;
      const rows = $('#post-rows');
      if (!data.posts.length) {
        rows.innerHTML = '<tr><td colspan="6"><div class="empty-state">没有找到文章</div></td></tr>';
      } else {
        rows.innerHTML = data.posts.map((p) => `
          <tr>
            <td class="post-title-cell" title="${esc(p.title)}">
              ${p.sticky ? `<span class="sticky-flag">📌${p.sticky > 1 ? p.sticky : ''}</span>` : ''}${esc(p.title)}
            </td>
            <td class="meta-cell">${esc(String(p.date || '').slice(0, 16))}</td>
            <td class="meta-cell">${p.categories.map((c) => `<span class="chip blue">${esc(c)}</span>`).join('')}</td>
            <td class="meta-cell">${p.tags.slice(0, 3).map((t) => `<span class="chip gray">${esc(t)}</span>`).join('')}${p.tags.length > 3 ? `<span class="chip gray">+${p.tags.length - 3}</span>` : ''}</td>
            <td>${p.words}</td>
            <td>
              <div class="row-actions">
                ${isDraft ? `<button class="btn btn-sm btn-primary" data-act="publish" data-key="${esc(p.key)}">发布</button>` : ''}
                <button class="btn btn-sm" data-act="edit" data-key="${esc(p.key)}">编辑</button>
                <button class="btn btn-sm btn-danger" data-act="del" data-key="${esc(p.key)}" data-title="${esc(p.title)}">删除</button>
              </div>
            </td>
          </tr>`).join('');
      }

      // 分页
      const totalPages = Math.max(1, Math.ceil(data.total / data.size));
      $('#post-pagination').innerHTML = `
        <span class="page-info">第 ${data.page} / ${totalPages} 页</span>
        <button class="btn btn-sm" id="pg-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn btn-sm" id="pg-next" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button>`;
      $('#pg-prev').addEventListener('click', () => { LIST_STATE.page -= 1; load(); });
      $('#pg-next').addEventListener('click', () => { LIST_STATE.page += 1; load(); });

      // 行操作
      $$('#post-rows [data-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.key;
          if (btn.dataset.act === 'edit') {
            navigate(`#/editor?key=${encodeURIComponent(key)}&scope=${scope}`);
          } else if (btn.dataset.act === 'del') {
            const ok = await confirmModal('删除确认', `确定删除「${btn.dataset.title}」吗？${MODE === 'github' ? '该文件将从 GitHub 仓库删除（可通过 Git 历史找回）。' : '文章将移入 admin/trash 回收站。'}`, true);
            if (!ok) return;
            try {
              await api(`/api/posts/${encodeURIComponent(key)}?scope=${scope}`, { method: 'DELETE' });
              toast(MODE === 'github' ? '已从仓库删除' : '已移入回收站', 'ok');
              load();
              loadNavBadges();
            } catch (e) { toast(e.message, 'error'); }
          } else if (btn.dataset.act === 'publish') {
            try {
              await api(`/api/posts/${encodeURIComponent(key)}/publish`, { method: 'POST', body: '{}' });
              toast('发布成功', 'ok');
              load();
              loadNavBadges();
            } catch (e) { toast(e.message, 'error'); }
          }
        });
      });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#list-q').addEventListener('input', debounce((e) => {
    LIST_STATE.q = e.target.value.trim();
    LIST_STATE.page = 1;
    load();
  }, 350));
  $('#list-category').addEventListener('change', (e) => {
    LIST_STATE.category = e.target.value;
    LIST_STATE.page = 1;
    load();
  });
  $('#list-tag').addEventListener('change', (e) => {
    LIST_STATE.tag = e.target.value;
    LIST_STATE.page = 1;
    load();
  });

  load();
}

/* ------------------------------ chips 输入组件 ------------------------------ */

function chipsInput(container, initial = [], placeholder = '输入后回车', suggestions = []) {
  const items = [...initial];
  const render = (keepFocus = false) => {
    container.innerHTML = `
      ${items.map((it, i) => `<span class="chip">${esc(it)}<span class="chip-x" data-i="${i}">×</span></span>`).join('')}
      <input type="text" placeholder="${esc(placeholder)}" />
      <div class="chips-suggest hidden"></div>`;
    const input = $('input', container);
    const suggest = $('.chips-suggest', container);
    if (keepFocus) input.focus();

    // 已有条目建议面板
    const renderSuggest = (keyword) => {
      const kw = String(keyword || '').trim().toLowerCase();
      const pool = suggestions.filter((s) => !items.includes(s));
      const list = kw ? pool.filter((s) => s.toLowerCase().includes(kw)) : pool;
      if (!list.length) {
        suggest.innerHTML = `<div class="suggest-empty">${pool.length ? '没有匹配的已有条目，回车可新建' : '暂无已有条目，输入后回车新建'}</div>`;
      } else {
        suggest.innerHTML = list.slice(0, 12)
          .map((s) => `<div class="suggest-item" data-value="${esc(s)}">${esc(s)}</div>`)
          .join('');
      }
      suggest.classList.remove('hidden');
    };
    const closeSuggest = () => suggest.classList.add('hidden');

    input.addEventListener('focus', () => renderSuggest(input.value));
    input.addEventListener('input', () => renderSuggest(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSuggest();
        input.blur();
        return;
      }
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        const v = input.value.trim().replace(/,|，/g, '');
        if (v && !items.includes(v)) items.push(v);
        input.value = '';
        render(true);
      } else if (e.key === 'Backspace' && !input.value && items.length) {
        items.pop();
        render(true);
      }
    });
    // 失焦只处理未确认的输入，绝不抢焦点（这是「光标总跳回标签框」的根源）
    input.addEventListener('blur', () => {
      setTimeout(closeSuggest, 180);
      const v = input.value.trim();
      input.value = '';
      if (v && !items.includes(v)) {
        items.push(v);
        render(false);
      }
    });
    $$('.chip-x', container).forEach((x) => {
      x.addEventListener('click', () => {
        items.splice(Number(x.dataset.i), 1);
        render(false);
      });
    });
  };
  render(false);
  // 点击建议项：mousedown 阻止输入框失焦（否则面板先被销毁，点击落空）
  container.addEventListener('mousedown', (e) => {
    const it = e.target && e.target.closest ? e.target.closest('.suggest-item') : null;
    if (!it) return;
    e.preventDefault();
    const v = it.dataset.value;
    if (v && !items.includes(v)) items.push(v);
    render(true);
  });
  // 点击容器空白区域时才聚焦输入框（不影响其他字段）
  container.addEventListener('click', (e) => {
    if (e.target === container) {
      const input = $('input', container);
      if (input) input.focus();
    }
  });
  return {
    get: () => [...items],
    set: (arr) => { items.length = 0; items.push(...(arr || [])); render(false); },
  };
}

/* ------------------------------ Markdown 渲染器（预览用） ------------------------------ */

function inlineMd(t) {
  let s = esc(t);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => {
    codes.push('<code>' + c + '</code>');
    return '\x00C' + (codes.length - 1) + '\x00';
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy" />`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, src) => `<a href="${src}" target="_blank" rel="noopener">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\x00C(\d+)\x00/g, (m, i) => codes[Number(i)]);
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return s;
}

function mdRender(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  const isFence = (l) => /^\s*(```|~~~)/.test(l);
  const ulRe = /^\s*[-*+]\s+(.*)$/;
  const olRe = /^\s*\d+[.)]\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (isFence(line)) {
      const lang = (line.trim().match(/^\s*(?:```|~~~)\s*([\w-]*)/) || [])[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { html.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html.push('<hr />'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html.push('<blockquote>' + buf.map(inlineMd).join('<br />') + '</blockquote>');
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = parseRow(line);
      const aligns = parseRow(lines[i + 1]).map((c) => {
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      const th = header.map((c, idx) => `<th${aligns[idx] !== 'left' ? ` style="text-align:${aligns[idx]}"` : ''}>${inlineMd(c)}</th>`).join('');
      const trs = rows.map((r) => '<tr>' + r.map((c, idx) => `<td${aligns[idx] !== 'left' ? ` style="text-align:${aligns[idx]}"` : ''}>${inlineMd(c)}</td>`).join('') + '</tr>').join('');
      html.push('<table><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table>');
      continue;
    }

    if (ulRe.test(line) || olRe.test(line)) {
      const ordered = olRe.test(line);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = ordered ? olRe.exec(l) : ulRe.exec(l);
        if (!m) break;
        items.push(m[1]);
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !ulRe.test(lines[i]) && !olRe.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>` + items.map((it) => '<li>' + inlineMd(it) + '</li>').join('') + `</${tag}>`);
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !ulRe.test(lines[i]) && !olRe.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    html.push('<p>' + buf.map(inlineMd).join('<br />') + '</p>');
  }
  return html.join('\n');
}

/* ------------------------------ 编辑器 ------------------------------ */

const EDITOR_STATE = { key: null, scope: 'posts', loaded: null, chipsTags: null, chipsCats: null };

function toLocalInput(dateStr) {
  if (!dateStr) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(dateStr));
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

function fromLocalInput(v) {
  if (!v) return '';
  return v.replace('T', ' ') + ':00';
}

async function renderEditor(container, params) {
  const key = params.get('key');
  const scope = params.get('scope') === 'drafts' ? 'drafts' : 'posts';
  EDITOR_STATE.key = key;
  EDITOR_STATE.scope = scope;
  EDITOR_STATE.loaded = null;

  container.innerHTML = `
    <div class="card">
      <div class="editor-head">
        <a class="btn btn-sm" href="#/${scope === 'drafts' ? 'drafts' : 'posts'}">← 返回</a>
        <h3 id="editor-title-text">${key ? '编辑文章' : '新建文章'}</h3>
        <div style="display:flex;gap:8px">
          ${key && scope === 'drafts' ? '<button class="btn btn-primary" id="ed-publish">🚀 发布到博客</button>' : ''}
          ${!key ? '<button class="btn" id="ed-save-draft">存为草稿</button>' : ''}
          <button class="btn btn-primary" id="ed-save">保存</button>
        </div>
      </div>
      <div class="editor-body">
        <div class="editor-side">
          <label class="field"><span>标题 *</span><input id="ed-title" placeholder="文章标题" /></label>
          <label class="field"><span>发布日期</span><input id="ed-date" type="datetime-local" /></label>
          <label class="field"><span>更新日期（留空则无）</span><input id="ed-updated" type="datetime-local" /></label>
          <div class="field"><span>分类</span><div class="chips-input" id="ed-categories"></div></div>
          <div class="field"><span>标签</span><div class="chips-input" id="ed-tags"></div></div>
          <label class="field"><span>封面图片 URL</span><input id="ed-cover" placeholder="https://…" /></label>
          <img id="ed-cover-preview" style="display:none;width:100%;border-radius:9px;margin-top:6px" alt="封面预览" />
          <label class="field"><span>文章摘要 description</span><textarea id="ed-description" rows="3" placeholder="留空则自动截取"></textarea></label>
          <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
            <label class="field" style="margin:0;flex:1;min-width:150px"><span>置顶优先级</span>
              <select id="ed-sticky">
                <option value="0">不置顶</option>
                <option value="1">置顶 · 普通</option>
                <option value="2">置顶 · 较高</option>
                <option value="3">置顶 · 最高</option>
              </select>
            </label>
            <label class="check-row"><input type="checkbox" id="ed-comments" checked /> 允许评论</label>
            <label class="check-row"><input type="checkbox" id="ed-mathjax" /> 数学公式</label>
          </div>
        </div>
        <div class="editor-main">
          <div class="editor-toolbar">
            <button class="toolbar-btn" data-t="h2" title="二级标题">H2</button>
            <button class="toolbar-btn" data-t="h3" title="三级标题">H3</button>
            <button class="toolbar-btn" data-t="bold" title="加粗"><b>B</b></button>
            <button class="toolbar-btn" data-t="italic" title="斜体"><i>I</i></button>
            <button class="toolbar-btn" data-t="strike" title="删除线"><s>S</s></button>
            <button class="toolbar-btn" data-t="quote" title="引用">❝</button>
            <button class="toolbar-btn" data-t="code" title="行内代码">&lt;/&gt;</button>
            <button class="toolbar-btn" data-t="fence" title="代码块">🧱</button>
            <button class="toolbar-btn" data-t="link" title="链接">🔗</button>
            <button class="toolbar-btn" data-t="image" title="图片">🖼️</button>
            <button class="toolbar-btn" data-t="ul" title="无序列表">• 列表</button>
            <button class="toolbar-btn" data-t="ol" title="有序列表">1. 列表</button>
            <button class="toolbar-btn" data-t="table" title="表格">▦ 表格</button>
            <button class="toolbar-btn" data-t="hr" title="分割线">─</button>
            <button class="toolbar-btn" data-t="upload" title="上传图片">📤 上传图片</button>
            <label class="check-row" style="margin-left:auto"><input type="checkbox" id="ed-preview-toggle" checked /> 实时预览</label>
          </div>
          <div class="editor-area">
            <textarea id="ed-content" placeholder="在这里用 Markdown 写作…" spellcheck="false"></textarea>
            <div class="editor-preview" id="ed-preview"></div>
          </div>
          <div class="word-count" id="ed-word-count">0 字</div>
        </div>
      </div>
    </div>
    <input type="file" id="ed-file-input" accept="image/*" style="display:none" multiple />`;

  // 已有分类/标签建议（读取统计信息，缓存 60 秒）
  let metaCache = window.__metaCache;
  if (!metaCache || !window.__metaTime || Date.now() - window.__metaTime > 60000) {
    try {
      metaCache = await api('/api/meta');
      window.__metaCache = metaCache;
      window.__metaTime = Date.now();
    } catch (e) {
      metaCache = null;
    }
  }
  const catSuggest = metaCache ? (metaCache.categories || []).map((c) => c.name) : [];
  const tagSuggest = metaCache ? (metaCache.tags || []).map((t) => t.name) : [];

  EDITOR_STATE.chipsCats = chipsInput($('#ed-categories'), [], '分类：输入或从已有选择', catSuggest);
  EDITOR_STATE.chipsTags = chipsInput($('#ed-tags'), [], '标签：输入或从已有选择', tagSuggest);

  const ta = $('#ed-content');
  const preview = $('#ed-preview');
  const renderPreview = () => {
    preview.innerHTML = mdRender(ta.value);
    $('#ed-word-count').textContent = ta.value.length.toLocaleString() + ' 字符';
  };
  ta.addEventListener('input', debounce(renderPreview, 200));
  renderPreview();
  $('#ed-preview-toggle').addEventListener('change', () => {
    preview.classList.toggle('hidden', !$('#ed-preview-toggle').checked);
  });

  /* 工具栏 */
  const surround = (before, after) => {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || '文字';
    ta.setRangeText(before + sel + after, s, e, 'end');
    ta.focus();
    renderPreview();
  };
  const prefixLines = (prefix) => {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    const lines = (sel || '列表项').split('\n').map((l) => prefix + l).join('\n');
    ta.setRangeText(lines, s, e, 'end');
    ta.focus();
    renderPreview();
  };
  $$('.toolbar-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.t) {
        case 'h2': prefixLines('## '); break;
        case 'h3': prefixLines('### '); break;
        case 'bold': surround('**', '**'); break;
        case 'italic': surround('*', '*'); break;
        case 'strike': surround('~~', '~~'); break;
        case 'quote': prefixLines('> '); break;
        case 'code': surround('`', '`'); break;
        case 'fence': surround('\n```\n', '\n```\n'); break;
        case 'link': surround('[', '](https://)'); break;
        case 'image': surround('![', '](https://)'); break;
        case 'ul': prefixLines('- '); break;
        case 'ol': prefixLines('1. '); break;
        case 'table': surround('\n| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |\n', ''); break;
        case 'hr': surround('\n---\n\n', ''); break;
        case 'upload': $('#ed-file-input').click(); break;
        default: break;
      }
    });
  });

  $('#ed-file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        toast(`正在上传 ${file.name}…`);
        const data = await apiUpload(fd);
        const md = `![${data.name}](${data.url})`;
        const s = ta.selectionStart;
        ta.setRangeText(md + '\n', s, s, 'end');
        toast('上传成功，已插入图片', 'ok');
        renderPreview();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    e.target.value = '';
  });

  $('#ed-cover').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    const img = $('#ed-cover-preview');
    if (v) {
      img.src = v;
      img.style.display = 'block';
    } else {
      img.style.display = 'none';
    }
  });

  /* 加载已有文章 */
  if (key) {
    try {
      const data = await api(`/api/posts/${encodeURIComponent(key)}?scope=${scope}`);
      const p = data.post;
      EDITOR_STATE.loaded = p;
      $('#editor-title-text').textContent = '编辑文章';
      $('#ed-title').value = p.title || '';
      $('#ed-date').value = toLocalInput(p.date);
      $('#ed-updated').value = toLocalInput(p.updated);
      EDITOR_STATE.chipsCats.set(p.categories || []);
      EDITOR_STATE.chipsTags.set(p.tags || []);
      $('#ed-cover').value = p.cover || '';
      if (p.cover) {
        $('#ed-cover-preview').src = p.cover;
        $('#ed-cover-preview').style.display = 'block';
      }
      $('#ed-description').value = p.description || '';
      $('#ed-sticky').value = String(p.sticky || 0);
      $('#ed-comments').checked = p.comments !== false;
      $('#ed-mathjax').checked = Boolean(p.mathjax);
      ta.value = p.body || '';
      renderPreview();
    } catch (e) {
      toast(e.message, 'error');
      navigate(`#/${scope === 'drafts' ? 'drafts' : 'posts'}`);
    }
  } else {
    $('#ed-date').value = new Date().toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T');
  }

  /* 保存 */
  const collect = () => {
    const title = $('#ed-title').value.trim();
    if (!title) throw new Error('标题不能为空');
    return {
      title,
      content: ta.value,
      date: fromLocalInput($('#ed-date').value) || undefined,
      updated: fromLocalInput($('#ed-updated').value) || undefined,
      categories: EDITOR_STATE.chipsCats.get(),
      tags: EDITOR_STATE.chipsTags.get(),
      cover: $('#ed-cover').value.trim(),
      description: $('#ed-description').value.trim(),
      sticky: parseInt($('#ed-sticky').value, 10) || 0,
      comments: $('#ed-comments').checked,
      mathjax: $('#ed-mathjax').checked,
    };
  };

  const GH_HINT = MODE === 'github' ? '（已自动触发构建，约 2~5 分钟后上线）' : '';
  const save = async (asDraft = false) => {
    try {
      const payload = collect();
      const scopeNow = asDraft ? 'drafts' : EDITOR_STATE.scope;
      if (EDITOR_STATE.key) {
        await api(`/api/posts/${encodeURIComponent(EDITOR_STATE.key)}`, {
          method: 'PUT',
          body: JSON.stringify({ ...payload, scope: scopeNow }),
        });
        toast('保存成功' + GH_HINT, 'ok');
        navigate(`#/${scopeNow === 'drafts' ? 'drafts' : 'posts'}`);
      } else {
        const data = await api('/api/posts', {
          method: 'POST',
          body: JSON.stringify({ ...payload, scope: asDraft ? 'drafts' : 'posts' }),
        });
        toast((asDraft ? '已保存为草稿' : '文章创建成功') + GH_HINT, 'ok');
        loadNavBadges();
        navigate(`#/${asDraft ? 'drafts' : 'posts'}`);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#ed-save').addEventListener('click', () => save(false));
  const draftBtn = $('#ed-save-draft');
  if (draftBtn) draftBtn.addEventListener('click', () => save(true));
  const pubBtn = $('#ed-publish');
  if (pubBtn) {
    pubBtn.addEventListener('click', async () => {
      try {
        await save(false); // 先保存草稿内容
      } catch (e) { return; }
      try {
        await api(`/api/posts/${encodeURIComponent(EDITOR_STATE.key)}/publish`, { method: 'POST', body: '{}' });
        toast('发布成功', 'ok');
        loadNavBadges();
        navigate('#/posts');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  if (window.__editorHotkey) document.removeEventListener('keydown', window.__editorHotkey);
  window.__editorHotkey = function editorHotkey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save(false);
    }
  };
  document.addEventListener('keydown', window.__editorHotkey);
}

/* ------------------------------ 友链 / 装备 / 创意技能 ------------------------------ */

/** 友链 link.yml：分组 + link_list */
function parseLinkYaml(text) {
  const groups = [];
  let current = null;
  let entry = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const gm = /^-\s+class_name:\s*(.*)$/.exec(line);
    if (gm) {
      current = { class_name: cleanScalar(gm[1]), flink_style: '', class_desc: '', links: [] };
      groups.push(current);
      entry = null;
      continue;
    }
    if (!current) continue;
    const em = /^\s{4}-\s+name:\s*(.*)$/.exec(line);
    if (em) {
      entry = { name: cleanScalar(em[1]), link: '', avatar: '', descr: '', siteshot: '', color: '', tag: '', recommend: false };
      current.links.push(entry);
      continue;
    }
    if (entry) {
      const ef = /^\s{6}([\w-]+):\s*(.*)$/.exec(line);
      if (ef) {
        const k = ef[1];
        const v = cleanScalar(ef[2]);
        if (k === 'recommend') entry.recommend = v === 'true';
        else entry[k] = v;
        continue;
      }
    }
    const gf = /^\s{2}([\w-]+):\s*(.*)$/.exec(line);
    if (gf && gf[1] !== 'link_list') current[gf[1]] = cleanScalar(gf[2]);
  }
  return groups;
}

/** 装备 equipment.yml：分组 + good_things + equipment_list */
function parseEquipmentYaml(text) {
  const groups = [];
  let current = null;
  let good = null;
  let item = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const gm = /^-\s+class_name:\s*(.*)$/.exec(line);
    if (gm) {
      current = { class_name: cleanScalar(gm[1]), description: '', tip: '', goods: [] };
      groups.push(current);
      good = null;
      item = null;
      continue;
    }
    if (!current) continue;
    const gtm = /^\s{4}-\s+title:\s*(.*)$/.exec(line);
    if (gtm) {
      good = { title: cleanScalar(gtm[1]), description: '', items: [] };
      current.goods.push(good);
      item = null;
      continue;
    }
    const itm = /^\s{6}-\s+name:\s*(.*)$/.exec(line);
    if (itm && good) {
      item = { name: cleanScalar(itm[1]), specification: '', description: '', image: '', link: '' };
      good.items.push(item);
      continue;
    }
    if (item) {
      const ef = /^\s{8}([\w-]+):\s*(.*)$/.exec(line);
      if (ef) {
        item[ef[1]] = cleanScalar(ef[2]);
        continue;
      }
    }
    const gf = /^\s{2}([\w-]+):\s*(.*)$/.exec(line);
    if (gf && gf[1] !== 'good_things') current[gf[1]] = cleanScalar(gf[2]);
  }
  return groups;
}

/** 创意技能 creativity.yml：分组 + creativity_list */
function parseCreativityYaml(text) {
  const groups = [];
  let current = null;
  let entry = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const gm = /^-\s+class_name:\s*(.*)$/.exec(line);
    if (gm) {
      current = { class_name: cleanScalar(gm[1]), items: [] };
      groups.push(current);
      entry = null;
      continue;
    }
    if (!current) continue;
    const em = /^\s{4}-\s+name:\s*(.*)$/.exec(line);
    if (em) {
      entry = { name: cleanScalar(em[1]), icon: '' };
      current.items.push(entry);
      continue;
    }
    if (entry) {
      const ef = /^\s{6}([\w-]+):\s*(.*)$/.exec(line);
      if (ef) {
        entry[ef[1]] = cleanScalar(ef[2]);
      }
    }
  }
  return groups;
}

/** 通用数据页骨架：编辑器 + 预览 + 添加模板 + 保存 */
async function renderDataYamlPage(container, cfg) {
  container.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>${esc(cfg.title)}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${cfg.addLabel ? `<button class="btn btn-sm" id="data-add">＋ ${esc(cfg.addLabel)}</button>` : ''}
          <button class="btn btn-primary btn-sm" id="data-save">💾 保存</button>
        </div>
      </div>
      <div class="card-body data-grid">
        <div>
          <textarea class="code-editor" id="data-editor" style="min-height:520px" spellcheck="false"></textarea>
          <p class="hint">${esc(cfg.hint)}</p>
        </div>
        <div>
          <div class="hint" style="margin:0 0 10px">实时预览</div>
          <div id="data-preview"></div>
        </div>
      </div>
    </div>`;

  const ta = $('#data-editor');
  const preview = $('#data-preview');
  const renderPreview = () => cfg.render(preview, ta.value);
  ta.addEventListener('input', debounce(renderPreview, 250));

  try {
    const data = await api(cfg.apiPath);
    ta.value = data.content || '';
    renderPreview();
  } catch (e) {
    toast(e.message, 'error');
  }

  const addBtn = $('#data-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      ta.value = ta.value.replace(/\s*$/, '') + cfg.addTemplate();
      renderPreview();
      ta.scrollTop = ta.scrollHeight;
      toast('已在末尾添加模板，替换内容后保存即可', 'ok');
    });
  }

  $('#data-save').addEventListener('click', async () => {
    if (cfg.validate && !cfg.validate(ta.value)) {
      const ok = await confirmModal('格式检查未通过', 'YAML 缩进似乎有误或没有解析到任何内容，确定仍要保存吗？（缩进错误会导致博客构建失败）', true);
      if (!ok) return;
    }
    try {
      const data = await api(cfg.apiPath, { method: 'PUT', body: JSON.stringify({ content: ta.value }) });
      toast(data.message || '保存成功', 'ok', 3200);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

function renderFlink(container) {
  renderDataYamlPage(container, {
    title: '友链管理 · 好伙伴',
    apiPath: '/api/link',
    addLabel: '新建分组',
    hint: `编辑的是 source/_data/link.yml（YAML 格式）。支持 flink_style: flexcard / telescopic / anzhiyu 三种样式。${MODE === 'github' ? '保存即自动触发构建，约 2~5 分钟上线。' : '保存前自动备份原文件。'}`,
    addTemplate: () => '\n- class_name: 新分组\n  flink_style: anzhiyu\n  link_list:\n    - name: 站点名\n      link: https://\n      avatar: https://头像地址\n      descr: 站点描述\n      recommend: true\n',
    validate: (v) => !yamlHasBadIndent(v) && parseLinkYaml(v).length > 0,
    render: (preview, text) => {
      const groups = parseLinkYaml(text);
      if (!groups.length) {
        preview.innerHTML = '<div class="empty-state">未解析到友链分组<br>请检查 YAML 格式</div>';
        return;
      }
      preview.innerHTML = groups.map((g) => `
        <div class="data-group">
          <div class="data-group-head">
            <b>${esc(g.class_name || '未命名分组')}</b>
            <span class="chip gray">${esc(g.flink_style || '默认样式')}</span>
            ${g.class_desc ? `<span class="data-group-desc">${esc(g.class_desc)}</span>` : ''}
          </div>
          <div class="data-group-body">
            ${g.links.length ? g.links.map((l) => `
              <div class="flink-item">
                ${l.avatar ? `<img class="flink-avatar" src="${esc(l.avatar)}" onerror="this.style.display='none'" alt="" />` : ''}
                <div class="flink-meta">
                  <b>${esc(l.name)}</b>
                  <span>${esc(l.descr || '')}</span>
                </div>
                <div class="data-badges">
                  ${l.recommend ? '<span class="chip">⭐ 推荐</span>' : ''}
                  ${l.tag ? `<span class="chip blue">${esc(l.tag)}</span>` : ''}
                  ${l.color ? `<span class="chip gray">${esc(l.color)}</span>` : ''}
                  ${l.link ? '<span class="chip blue">🔗 链接</span>' : ''}
                </div>
              </div>`).join('') : '<div class="empty-state">该分组暂无友链</div>'}
          </div>
        </div>`).join('');
    },
  });
}

function renderEquipment(container) {
  renderDataYamlPage(container, {
    title: '我的装备 · 好物推荐',
    apiPath: '/api/equipment',
    addLabel: '新建分类',
    hint: `编辑的是 source/_data/equipment.yml（YAML 格式）。分组下可有多个 good_things 分类，每个分类下是 equipment_list。${MODE === 'github' ? '保存即自动触发构建，约 2~5 分钟上线。' : '保存前自动备份原文件。'}`,
    addTemplate: () => '\n- class_name: 新分类\n  description: 装备推荐\n  tip: \n  good_things:\n    - title: 生产力\n      description: \n      equipment_list:\n        - name: 设备名\n          specification: \n          description: \n          image: https://图片地址\n          link: https://\n',
    validate: (v) => !yamlHasBadIndent(v) && parseEquipmentYaml(v).length > 0,
    render: (preview, text) => {
      const groups = parseEquipmentYaml(text);
      if (!groups.length) {
        preview.innerHTML = '<div class="empty-state">未解析到装备分类<br>请检查 YAML 格式</div>';
        return;
      }
      preview.innerHTML = groups.map((g) => `
        <div class="data-group">
          <div class="data-group-head">
            <b>${esc(g.class_name || '未命名分类')}</b>
            ${g.tip ? `<span class="data-group-desc">${esc(g.tip)}</span>` : ''}
          </div>
          <div class="data-group-body">
            ${g.goods.length ? g.goods.map((gt) => `
              <div class="equip-sec">
                <div class="equip-sec-head">${esc(gt.title || '未命名')}<span>${esc(gt.description || '')}</span></div>
                ${gt.items.length ? gt.items.map((it) => `
                  <div class="equip-item">
                    ${it.image ? `<span class="equip-img" style="background-image:url('${esc(it.image)}')"></span>` : ''}
                    <div class="equip-meta">
                      <b>${esc(it.name)}</b>
                      ${it.specification ? `<span class="chip gray">${esc(it.specification)}</span>` : ''}
                      <p>${esc(it.description || '')}</p>
                    </div>
                  </div>`).join('') : '<div class="empty-state">该分类暂无装备</div>'}
              </div>`).join('') : '<div class="empty-state">暂无好物分类</div>'}
          </div>
        </div>`).join('');
    },
  });
}

function renderCreativity(container) {
  renderDataYamlPage(container, {
    title: '创意技能 · 音乐墙',
    apiPath: '/api/creativity',
    addLabel: '新建分组',
    hint: `编辑的是 source/_data/creativity.yml（YAML 格式）。每项为 name + icon（图标地址）。${MODE === 'github' ? '保存即自动触发构建，约 2~5 分钟上线。' : '保存前自动备份原文件。'}`,
    addTemplate: () => '\n- class_name: 新分组\n  creativity_list:\n    - name: 名字\n      icon: https://图标地址\n',
    validate: (v) => !yamlHasBadIndent(v) && parseCreativityYaml(v).length > 0,
    render: (preview, text) => {
      const groups = parseCreativityYaml(text);
      if (!groups.length) {
        preview.innerHTML = '<div class="empty-state">未解析到分组<br>请检查 YAML 格式</div>';
        return;
      }
      preview.innerHTML = groups.map((g) => `
        <div class="data-group">
          <div class="data-group-head"><b>${esc(g.class_name || '未命名分组')}</b><span class="chip gray">${g.items.length} 项</span></div>
          <div class="data-group-body">
            <div class="creative-grid">
              ${g.items.length ? g.items.map((it) => `
                <div class="creative-item">
                  ${it.icon ? `<img src="${esc(it.icon)}" onerror="this.style.display='none'" alt="" />` : ''}
                  <span>${esc(it.name)}</span>
                </div>`).join('') : '<div class="empty-state">暂无项目</div>'}
            </div>
          </div>
        </div>`).join('');
    },
  });
}

/* ------------------------------ 自我介绍（about.yml） ------------------------------ */

/** 轻量解析 about.yml（预览用）：提取顶部信息与分区概览 */
function parseAboutYaml(text) {
  const info = { className: '', name: '', description: '', subtitle: '', avatarImg: '', helloAbout: '', sections: [] };
  let current = null;
  const lines = String(text || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const gm = /^-\s+class_name:\s*(.*)$/.exec(line);
    if (gm) {
      info.className = cleanScalar(gm[1]);
      continue;
    }
    // 顶层 2 空格分区
    const sec = /^\s{2}([\w-]+):\s*(.*)$/.exec(line);
    if (sec) {
      current = { key: sec[1], value: cleanScalar(sec[2]), subCount: 0 };
      info.sections.push(current);
      continue;
    }
    // 更深层级：计入所属分区的子项行数
    if (current && /^\s{4,}\S/.test(line)) current.subCount += 1;
  }

  const pick = (key) => {
    const s = info.sections.find((x) => x.key === key);
    return s ? s.value : '';
  };
  info.name = pick('name');
  info.description = pick('description');
  info.subtitle = pick('subtitle');
  info.avatarImg = pick('avatarImg');
  info.helloAbout = pick('helloAbout');
  return info;
}

async function renderAbout(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>自我介绍 · 关于页</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" id="about-save">💾 保存</button>
        </div>
      </div>
      <div class="card-body about-grid">
        <div>
          <textarea class="code-editor" id="about-editor" style="min-height:540px" spellcheck="false"></textarea>
          <p class="hint">
            编辑的是 source/_data/about.yml（YAML 格式），包含 20 个板块：基本信息、avatarSkills 技能、
            aboutsiteTips、careers 书本、statistic、map、selfInfo、personalities 人格、maxim 座右铭、
            buff 特长、game 游戏、comic 读书、like、music、reward_list 打赏等。
            ${MODE === 'github' ? '保存即自动触发构建，约 2~5 分钟上线。' : '保存前自动备份原文件。'}
          </p>
        </div>
        <div>
          <div class="hint" style="margin:0 0 10px">实时预览（博客「关于」页效果概览）</div>
          <div id="about-preview"></div>
        </div>
      </div>
    </div>`;

  const ta = $('#about-editor');
  const preview = $('#about-preview');

  const renderPreview = () => {
    const info = parseAboutYaml(ta.value);
    if (!info.sections.length) {
      preview.innerHTML = '<div class="empty-state">未解析到内容<br>请检查 YAML 格式</div>';
      return;
    }
    preview.innerHTML = `
      <div class="about-preview-head">
        ${info.avatarImg ? `<img src="${esc(info.avatarImg)}" alt="头像" />` : '<div class="about-noavatar"></div>'}
        <div>
          <b>${esc(info.name || '（未设置名字）')}</b>
          <span>${esc(info.description || '')}</span>
        </div>
      </div>
      ${info.subtitle ? `<div class="about-slogan">「${esc(info.subtitle)}」</div>` : ''}
      ${info.helloAbout ? `<div class="about-slogan dim">${esc(info.helloAbout)}</div>` : ''}
      <div class="about-sections">
        ${info.sections.map((s) => `
          <div class="about-sec">
            <span class="about-sec-key">${esc(s.key)}</span>
            <span class="about-sec-val">${s.value ? esc(s.value) : (s.subCount ? `复合结构 · ${s.subCount} 行` : '—')}</span>
          </div>`).join('')}
      </div>`;
  };

  ta.addEventListener('input', debounce(renderPreview, 250));

  try {
    const data = await api('/api/about');
    ta.value = data.content || '';
    renderPreview();
  } catch (e) {
    toast(e.message, 'error');
  }

  $('#about-save').addEventListener('click', async () => {
    const info = parseAboutYaml(ta.value);
    if (yamlHasBadIndent(ta.value) || !info.sections.length) {
      const ok = await confirmModal('格式检查未通过', 'YAML 缩进似乎有误或没有解析到任何内容，确定仍要保存吗？（缩进错误会导致博客构建失败）', true);
      if (!ok) return;
    }
    try {
      const data = await api('/api/about', { method: 'PUT', body: JSON.stringify({ content: ta.value }) });
      toast(data.message || '保存成功', 'ok', 3200);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

/* ------------------------------ 相册集（album.yml） ------------------------------ */

/** 轻量解析 album.yml（预览用）：返回 [{ class_name, cover, description, type, entries: [...] }] */
function parseAlbumYaml(text) {
  const groups = [];
  let current = null;
  let entry = null;
  let arrKey = null;
  const lines = String(text || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // 分组起始：- class_name: xxx
    const gm = /^-\s+class_name:\s*(.*)$/.exec(line);
    if (gm) {
      current = { class_name: cleanScalar(gm[1]), cover: '', description: '', type: '1', entries: [] };
      groups.push(current);
      entry = null;
      arrKey = null;
      continue;
    }
    if (!current) continue;

    // 条目起始：    - date: xxx 或    - content: xxx（4 空格）
    const em = /^\s{4}-\s+(date|content):\s*(.*)$/.exec(line);
    if (em) {
      entry = { date: '', content: '', address: '', from: '', link: '', image: [], video: [], aplayer: null };
      entry[em[1]] = cleanScalar(em[2]);
      current.entries.push(entry);
      arrKey = null;
      continue;
    }

    if (entry) {
      // 8 空格：数组项（- url）或 aplayer 字段
      const arrItem = /^\s{8}-\s+(.*)$/.exec(line);
      if (arrItem) {
        if (arrKey === 'image' || arrKey === 'video') entry[arrKey].push(cleanScalar(arrItem[1]));
        continue;
      }
      const ap = /^\s{8}([\w-]+):\s*(.*)$/.exec(line);
      if (ap && arrKey === 'aplayer') {
        entry.aplayer = entry.aplayer || {};
        entry.aplayer[ap[1]] = cleanScalar(ap[2]);
        continue;
      }
      // 6 空格：条目字段
      const ef = /^\s{6}([\w-]+):\s*(.*)$/.exec(line);
      if (ef) {
        const key = ef[1];
        const val = ef[2].trim();
        if (key === 'date' || key === 'content' || key === 'address' || key === 'from' || key === 'link') entry[key] = cleanScalar(val);
        else if (key === 'image' || key === 'video') { arrKey = key; if (val) entry[key].push(cleanScalar(val)); }
        else if (key === 'aplayer') { arrKey = 'aplayer'; entry.aplayer = {}; }
        continue;
      }
    }

    // 2 空格：分组字段
    const gf = /^\s{2}([\w-]+):\s*(.*)$/.exec(line);
    if (gf && gf[1] !== 'album_list') {
      const key = gf[1];
      current[key] = cleanScalar(gf[2]);
    }
  }
  return groups;
}

async function renderAlbum(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>相册集 · 每一张照片都是一次美好的记忆</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" id="album-add">＋ 新建相册</button>
          <button class="btn btn-primary btn-sm" id="album-save">💾 保存</button>
        </div>
      </div>
      <div class="card-body album-grid">
        <div>
          <textarea class="code-editor" id="album-editor" style="min-height:520px" spellcheck="false"></textarea>
          <p class="hint">编辑的是 source/_data/album.yml（YAML 格式）。${MODE === 'github' ? '保存即自动触发构建，约 2~5 分钟上线。' : '保存前自动备份原文件。'}</p>
        </div>
        <div>
          <div class="hint" style="margin:0 0 10px">实时预览（博客「相册集」页效果）</div>
          <div id="album-preview"></div>
        </div>
      </div>
    </div>`;

  const ta = $('#album-editor');
  const preview = $('#album-preview');

  const renderPreview = () => {
    const groups = parseAlbumYaml(ta.value);
    if (!groups.length) {
      preview.innerHTML = '<div class="empty-state">未解析到相册分组<br>请检查 YAML 格式</div>';
      return;
    }
    preview.innerHTML = groups.map((g) => `
      <div class="album-group">
        <div class="album-group-head">
          <div class="album-cover" ${g.cover ? `style="background-image:url('${esc(g.cover)}')"` : ''}></div>
          <div class="album-group-meta">
            <b>${esc(g.class_name || '未命名相册')}</b>
            <span>${esc(g.description || '')}</span>
            <span class="chip gray">${g.entries.length} 张照片 · ${g.type === '2' ? '画廊模式' : '瀑布流模式'}</span>
          </div>
        </div>
        <div class="album-group-body">
          ${g.entries.length ? g.entries.map((e) => `
            <div class="album-item-row">
              <div class="album-item-text">
                <p>${esc(e.content || '（无说明）')}</p>
                <div class="essay-item-foot">
                  <span class="chip gray">🕐 ${esc(e.date || '无日期')}</span>
                  ${e.address ? `<span class="chip gray">📍 ${esc(e.address)}</span>` : ''}
                  ${e.link ? `<span class="chip blue">🔗 链接</span>` : ''}
                </div>
              </div>
              <div class="album-thumbs">
                ${(e.image || []).slice(0, 3).map((u) => `<span class="album-thumb" style="background-image:url('${esc(u)}')"></span>`).join('')}
                ${(e.image || []).length > 3 ? `<span class="chip gray">+${e.image.length - 3}</span>` : ''}
              </div>
            </div>`).join('') : '<div class="empty-state">该相册暂无照片</div>'}
        </div>
      </div>`).join('');
  };

  ta.addEventListener('input', debounce(renderPreview, 250));

  try {
    const data = await api('/api/album');
    ta.value = data.content || '';
    renderPreview();
  } catch (e) {
    toast(e.message, 'error');
  }

  // 新建相册：文末追加模板
  $('#album-add').addEventListener('click', () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const tpl = `\n- class_name: 新相册\n  path_name: /new-album\n  type: 1\n  description: 这里存放的是……\n  top_link: /album\n  top_btn_text: 返回\n  cover: https://封面图地址\n  album_list:\n    - date: ${today}\n      content: 照片说明\n      address: \n      image:\n        - https://图片地址\n`;
    ta.value = ta.value.replace(/\s*$/, '') + tpl;
    renderPreview();
    ta.scrollTop = ta.scrollHeight;
    toast('已在末尾添加新相册模板，替换文字与图片地址后保存即可', 'ok');
  });

  // 保存
  $('#album-save').addEventListener('click', async () => {
    const groups = parseAlbumYaml(ta.value);
    if (yamlHasBadIndent(ta.value) || !groups.length) {
      const ok = await confirmModal('格式检查未通过', 'YAML 缩进似乎有误或没有解析到任何相册分组，确定仍要保存吗？（缩进错误会导致博客构建失败）', true);
      if (!ok) return;
    }
    try {
      const data = await api('/api/album', { method: 'PUT', body: JSON.stringify({ content: ta.value }) });
      const extra = (data.createdPages && data.createdPages.length)
        ? '，已自动创建相册页面：' + data.createdPages.join('、')
        : '';
      toast((data.message || '保存成功') + extra, 'ok', 4200);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

/* ------------------------------ 千言万语（essay.yml） ------------------------------ */

/** 去除 YAML 标量两端的引号 */
function cleanScalar(v) {
  let s = String(v == null ? '' : v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

/** 检测明显缩进错误：行首恰好 1 个空格（常见于手工修改 YAML 时） */
function yamlHasBadIndent(text) {
  return String(text || '').split(/\r?\n/).some((l) => /^ [^ ]/.test(l));
}

/** 将 image/video 的标量写法规范为主题期望的列表写法（防止图片不显示） */
function normalizeImageFields(text) {
  return String(text || '')
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

/** 轻量解析 essay.yml（预览用）：返回 [{ title, subTitle, tips, limit, entries: [...] }] */
function parseEssayYaml(text) {
  const groups = [];
  let current = null;
  let entry = null;
  let arrKey = null; // 正在填充的数组字段（image/video）或 aplayer 对象
  const lines = String(text || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // 分组起始：- title: xxx
    const gm = /^-\s+title:\s*(.*)$/.exec(line);
    if (gm) {
      current = { title: cleanScalar(gm[1]), subTitle: '', tips: '', limit: 30, entries: [] };
      groups.push(current);
      entry = null;
      arrKey = null;
      continue;
    }
    if (!current) continue;

    // 条目起始：    - content: xxx（4 空格）
    const em = /^\s{4}-\s+content:\s*(.*)$/.exec(line);
    if (em) {
      entry = { content: cleanScalar(em[1]), date: '', image: [], video: [], aplayer: null, link: '', from: '', address: '' };
      current.entries.push(entry);
      arrKey = null;
      continue;
    }

    // 8 空格：数组项（- url）或 aplayer 字段（id: / server:）
    if (entry) {
      const arrItem = /^\s{8}-\s+(.*)$/.exec(line);
      if (arrItem) {
        if (arrKey === 'image' || arrKey === 'video') entry[arrKey].push(cleanScalar(arrItem[1]));
        continue;
      }
      const ap = /^\s{8}([\w-]+):\s*(.*)$/.exec(line);
      if (ap && arrKey === 'aplayer') {
        entry.aplayer = entry.aplayer || {};
        entry.aplayer[ap[1]] = cleanScalar(ap[2]);
        continue;
      }
      // 6 空格：条目字段
      const ef = /^\s{6}([\w-]+):\s*(.*)$/.exec(line);
      if (ef) {
        const key = ef[1];
        const val = ef[2].trim();
        if (key === 'date' || key === 'link' || key === 'from' || key === 'address') entry[key] = cleanScalar(val);
        else if (key === 'image' || key === 'video') { arrKey = key; if (val) entry[key].push(cleanScalar(val)); }
        else if (key === 'aplayer') { arrKey = 'aplayer'; entry.aplayer = {}; }
        continue;
      }
    }

    // 2 空格：分组字段
    const gf = /^\s{2}([\w-]+):\s*(.*)$/.exec(line);
    if (gf && gf[1] !== 'essay_list') {
      const key = gf[1];
      if (key === 'limit') current.limit = parseInt(gf[2], 10) || 30;
      else if (key === 'home_essay') current.home_essay = cleanScalar(gf[2]);
      else current[key] = cleanScalar(gf[2]);
    }
  }
  return groups;
}

async function renderEssay(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>千言万语 · 即刻短文</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" id="essay-add">＋ 添加新条目</button>
          <button class="btn btn-primary btn-sm" id="essay-save">💾 保存</button>
        </div>
      </div>
      <div class="card-body essay-grid" id="essay-grid">
        <div>
          <textarea class="code-editor" id="essay-editor" style="min-height:520px" spellcheck="false"></textarea>
          <p class="hint" id="essay-hint">编辑的是 source/_data/essay.yml（YAML 格式）。${MODE === 'github' ? '保存即自动触发构建，约 2~5 分钟上线。' : '保存前自动备份原文件。'}</p>
        </div>
        <div>
          <div class="hint" style="margin:0 0 10px">实时预览（博客「千言万语」页效果）</div>
          <div id="essay-preview"></div>
        </div>
      </div>
    </div>`;

  const ta = $('#essay-editor');
  const preview = $('#essay-preview');

  const renderPreview = () => {
    const groups = parseEssayYaml(ta.value);
    if (!groups.length) {
      preview.innerHTML = '<div class="empty-state">未解析到条目<br>请检查 YAML 格式</div>';
      return;
    }
    preview.innerHTML = groups.map((g) => `
      <div class="essay-group">
        <div class="essay-group-head">
          <b>${esc(g.title || '未命名分组')}</b>
          <span>${esc(g.subTitle || '')}</span>
        </div>
        <div class="essay-group-body">
          ${g.entries.length ? g.entries.map((e) => `
            <div class="essay-item">
              <p>${esc(e.content)}</p>
              <div class="essay-item-foot">
                <span class="chip gray">🕐 ${esc(e.date || '无日期')}</span>
                ${e.link ? `<span class="chip blue">🔗 链接</span>` : ''}
                ${e.from ? `<span class="chip gray">🔥 ${esc(e.from)}</span>` : ''}
                ${e.address ? `<span class="chip gray">📍 ${esc(e.address)}</span>` : ''}
                ${e.image.length ? `<span class="chip blue">🖼️ ${e.image.length} 图</span>` : ''}
                ${e.video.length ? `<span class="chip blue">🎬 ${e.video.length} 视频</span>` : ''}
              </div>
            </div>`).join('') : '<div class="empty-state">该分组暂无短文</div>'}
        </div>
      </div>`).join('');
  };

  ta.addEventListener('input', debounce(renderPreview, 250));

  // 加载
  try {
    const data = await api('/api/essay');
    ta.value = data.content || '';
    renderPreview();
  } catch (e) {
    toast(e.message, 'error');
  }

  // 添加新条目：在文末追加模板
  $('#essay-add').addEventListener('click', () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
    const tpl = `\n    - content: 写点什么吧…\n      date: ${today}\n      # image:\n      #   - https://图片地址（图片请用列表格式，一行一个）\n`;
    ta.value = ta.value.replace(/\s*$/, '') + tpl;
    renderPreview();
    ta.scrollTop = ta.scrollHeight;
    toast('已在末尾添加新条目，替换文字后保存即可', 'ok');
  });

  // 保存
  $('#essay-save').addEventListener('click', async () => {
    const groups = parseEssayYaml(ta.value);
    if (yamlHasBadIndent(ta.value) || !groups.length) {
      const ok = await confirmModal('格式检查未通过', 'YAML 缩进似乎有误或没有解析到任何条目，确定仍要保存吗？（缩进错误会导致博客构建失败）', true);
      if (!ok) return;
    }
    try {
      const data = await api('/api/essay', { method: 'PUT', body: JSON.stringify({ content: ta.value }) });
      toast(data.message || '保存成功', 'ok', 3200);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

/* ------------------------------ 媒体库 · 云图床（PicGo 风格） ------------------------------ */

/** 支持的图床类型 */
const BACKENDS = {
  github: { name: 'GitHub 仓库', tip: '图片提交进博客仓库 source/img/upload/，随站点一起发布' },
  oss: { name: '阿里云 OSS', tip: '上传到自己的 OSS Bucket，可绑定自定义域名 / CDN' },
  custom: { name: '自定义接口', tip: '任意 multipart 上传接口（Chevereto、EasyImages、自建服务）' },
};

const MEDIA_ACCEPT = /\.(jpe?g|png|gif|webp|svg|avif|ico)$/i;
const TEST_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** 上传成功后自动复制 Markdown */
let AUTO_COPY = localStorage.getItem('ftm_autocopy') !== '0';

function currentBackend() {
  return STORAGE.backend || 'github';
}

function backendInfo() {
  return BACKENDS[currentBackend()] || BACKENDS.github;
}

/** 条目的最终访问地址（用于「复制链接」） */
function galleryUrl(f) {
  if (f.url) return f.url;
  if (currentBackend() === 'github') {
    return MODE === 'github' ? location.origin + '/img/upload/' + f.rel : '/img/upload/' + f.rel;
  }
  return '';
}

/** 条目在文章中的 Markdown 引用 */
function galleryMarkdown(f) {
  const name = String(f.name || f.rel || 'image').replace(/\.[^.]+$/, '');
  if (currentBackend() === 'github') return `![${name}](/img/upload/${f.rel})`;
  return `![${name}](${f.url || ''})`;
}

/** 缩略图地址（仓库模式走本地代理接口，云端直连） */
function galleryThumb(f) {
  if (f.url) return f.url;
  return mediaSrc(f.rel);
}

/** 统一各图床返回的字段 */
function normalizeGalleryFile(f) {
  const rel = f.rel || f.key || '';
  return {
    key: f.key || f.rel || '',
    rel,
    name: f.name || String(rel).split('/').pop(),
    url: f.url || '',
    size: Number(f.size || 0),
    mtime: Number(f.mtime || 0),
  };
}

/** 图床设置面板 */
function mediaSettingsHTML() {
  const backend = currentBackend();
  const oss = STORAGE.oss || {};
  const cu = STORAGE.custom || {};
  const headerLines = (cu.headers || []).map((h) => `${h.name}: ${h.value}`).join('\n');
  const corsTip = MODE === 'github'
    ? `<p class="hint">浏览器直传 OSS 需先给 Bucket 配置跨域规则（CORS）：来源 <code>${esc(location.origin)}</code>、允许方法 <code>PUT, POST, GET, HEAD</code>、允许 Headers <code>*</code>。未配置会提示跨域失败。Bucket 设为公共读后图片可直接外链。</p>`
    : '<p class="hint">本机模式由后台服务代签名直传 OSS，无需配置 CORS。</p>';
  const tabs = Object.keys(BACKENDS)
    .map((k) => `<button class="picgo-tab ${backend === k ? 'active' : ''}" data-backend="${k}">${esc(BACKENDS[k].name)}</button>`)
    .join('');
  return `
    <div class="picgo-tabs" id="st-tabs">${tabs}</div>

    <div class="picgo-panel ${backend === 'github' ? '' : 'hidden'}" data-panel="github">
      <p class="hint">GitHub 图床无需配置：图片按 <code>source/img/upload/年月/</code> 结构提交到博客仓库，随 Actions 自动部署；文章内用 <code>/img/upload/xxx.png</code> 引用。适合图片不多、希望和文章一起做版本管理的场景。</p>
    </div>

    <div class="picgo-panel ${backend === 'oss' ? '' : 'hidden'}" data-panel="oss">
      <div class="picgo-grid2">
        <label class="field"><span>AccessKey ID</span><input id="st-oss-key" value="${esc(oss.accessKeyId || '')}" placeholder="LTAI..." autocomplete="off" /></label>
        <label class="field"><span>AccessKey Secret</span><input id="st-oss-secret" type="password" value="${esc(oss.accessKeySecret || '')}" placeholder="******" autocomplete="off" /></label>
        <label class="field"><span>Bucket</span><input id="st-oss-bucket" value="${esc(oss.bucket || '')}" placeholder="xsxtk" /></label>
        <label class="field"><span>Endpoint</span><input id="st-oss-endpoint" value="${esc(oss.endpoint || '')}" placeholder="oss-cn-beijing.aliyuncs.com" /></label>
        <label class="field"><span>存储目录前缀</span><input id="st-oss-prefix" value="${esc(oss.dirPrefix || '')}" placeholder="img/upload" /></label>
        <label class="field"><span>自定义域名 / CDN（可选）</span><input id="st-oss-domain" value="${esc(oss.customDomain || '')}" placeholder="https://img.example.com" /></label>
      </div>
      ${corsTip}
      <p class="hint">填成与博客现有图片相同的 Bucket 就能统一管理，例如 Bucket <code>xsxtk</code> + Endpoint <code>oss-cn-beijing.aliyuncs.com</code>。密钥只保存在本机 / 本浏览器，不会写进仓库。</p>
    </div>

    <div class="picgo-panel ${backend === 'custom' ? '' : 'hidden'}" data-panel="custom">
      <label class="field"><span>上传接口地址</span><input id="st-cu-url" value="${esc(cu.uploadUrl || '')}" placeholder="https://example.com/api/upload" /></label>
      <div class="picgo-grid2">
        <label class="field"><span>文件字段名</span><input id="st-cu-field" value="${esc(cu.fieldName || 'file')}" placeholder="file" /></label>
        <label class="field"><span>URL 提取正则（可选）</span><input id="st-cu-regex" value="${esc(cu.urlRegex || '')}" placeholder="&quot;url&quot;\\s*:\\s*&quot;(.*?)&quot;" /></label>
      </div>
      <label class="field"><span>附加请求头（每行一个，Name: Value）</span><textarea id="st-cu-headers" rows="3" placeholder="Authorization: Bearer xxx">${esc(headerLines)}</textarea></label>
      <p class="hint">接口返回里只要包含图片地址即可；留空正则时会自动抓取响应中第一个 <code>http(s)</code> 链接。该图床无法远程列举图片，下方「最近上传」会帮你留着记录。</p>
    </div>

    <div class="picgo-settings-foot">
      <button class="btn btn-primary" id="media-settings-save">保存图床配置</button>
      ${backend === 'github' ? '' : '<button class="btn btn-ghost" id="media-settings-test">测试上传</button>'}
      <span class="hint" style="margin:0">${MODE === 'github' ? '配置仅保存在本浏览器，不会提交到服务器。' : '配置保存在后台服务的 admin/config.json 中。'}</span>
    </div>`;
}

async function renderMedia(container) {
  // 读取图床配置（本机模式配置在服务端，云端模式在浏览器本地）
  try {
    const s = await api('/api/storage');
    if (s && s.storage) {
      STORAGE = Object.assign(STORAGE, s.storage, {
        oss: Object.assign({}, STORAGE.oss, s.storage.oss || {}),
        custom: Object.assign({}, STORAGE.custom, s.storage.custom || {}),
      });
    }
  } catch (e) { /* 读取失败则沿用本地缓存配置 */ }

  const info = backendInfo();
  container.innerHTML = `
    <div class="picgo">
      <div class="card">
        <div class="card-head">
          <h3>云图库 <span class="picgo-chip">${esc(info.name)}</span></h3>
          <div class="picgo-head-actions">
            <button class="btn btn-ghost btn-sm" id="media-refresh">刷新相册</button>
            <button class="btn btn-ghost btn-sm" id="media-settings-toggle">图床设置</button>
          </div>
        </div>
        <div class="card-body">
          <div class="picgo-drop" id="media-dropzone">
            <svg viewBox="0 0 24 24" fill="currentColor" width="34" height="34"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
            <div class="picgo-drop-title">拖拽图片到这里，或点击选择文件</div>
            <div class="picgo-drop-sub">也可以直接按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴剪贴板中的截图</div>
            <div class="picgo-drop-tags"><span>JPG</span><span>PNG</span><span>GIF</span><span>WEBP</span><span>SVG</span><span>AVIF</span><span class="picgo-drop-limit">单张 ≤ 20MB</span></div>
            <div class="picgo-drop-tip">当前图床：${esc(info.name)} · ${esc(info.tip)}</div>
          </div>
          <input type="file" id="media-file-input" accept="image/*" multiple hidden />
          <div class="picgo-progress hidden" id="media-progress">
            <div class="picgo-progress-track"><i id="media-progress-inner"></i></div>
            <div class="picgo-progress-text" id="media-progress-text"></div>
          </div>
          <div class="picgo-toolbar">
            <label class="picgo-switch">
              <input type="checkbox" id="media-autocopy" ${AUTO_COPY ? 'checked' : ''} />
              <span>上传后自动复制 Markdown</span>
            </label>
            <span class="hint" style="margin:0">图片存入「${esc(info.name)}」，上传成功即可直接粘贴到文章里</span>
          </div>
        </div>
      </div>

      <div class="card hidden" id="media-settings-card">
        <div class="card-head">
          <h3>图床设置</h3>
          <button class="btn btn-ghost btn-sm" id="media-settings-close">收起</button>
        </div>
        <div class="card-body">${mediaSettingsHTML()}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>云相册 <span class="hint" id="media-count" style="margin:0"></span></h3>
          <input class="picgo-search" id="media-search" placeholder="搜索文件名…" />
        </div>
        <div class="card-body">
          <div id="media-recent"></div>
          <div class="picgo-grid" id="media-grid"></div>
        </div>
      </div>
    </div>`;

  const dropzone = $('#media-dropzone');
  const fileInput = $('#media-file-input');
  let items = [];
  let keyword = '';

  /* ---------- 相册列表 ---------- */

  const renderGrid = () => {
    const grid = $('#media-grid');
    const list = keyword
      ? items.filter((f) => f.name.toLowerCase().includes(keyword))
      : items;
    $('#media-count').textContent = items.length ? `共 ${items.length} 张` : '';
    if (!list.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${
        items.length ? '没有匹配的图片' : (currentBackend() === 'custom'
          ? '该图床无法远程列举图片，可参考上方「最近上传」记录'
          : '相册还是空的，上传第一张图片试试')
      }</div>`;
      return;
    }
    grid.innerHTML = list.map((f, i) => `
      <div class="picgo-item" data-idx="${i}">
        <div class="picgo-thumb">
          <img src="${esc(galleryThumb(f))}" alt="${esc(f.name)}" loading="lazy" />
          <div class="picgo-hover">
            <button class="picgo-act" data-act="md" title="复制 Markdown 引用">MD</button>
            <button class="picgo-act" data-act="url" title="复制图片链接">URL</button>
            <button class="picgo-act" data-act="open" title="新窗口预览">预览</button>
            <button class="picgo-act picgo-act-del" data-act="del" title="删除这张图片">删除</button>
          </div>
        </div>
        <div class="picgo-meta">
          <div class="picgo-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="picgo-sub"><span>${fmtBytes(f.size)}</span>${f.mtime ? `<span>${fmtDate(f.mtime).slice(0, 10)}</span>` : ''}</div>
        </div>
      </div>`).join('');

    $$('img', grid).forEach((img) => img.addEventListener('error', () => img.classList.add('broken')));
    $$('.picgo-act', grid).forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.picgo-item');
      const f = list[Number(item.dataset.idx)];
      const act = btn.dataset.act;
      if (act === 'md') { copyText(galleryMarkdown(f)); return; }
      if (act === 'url') { copyText(galleryUrl(f)); return; }
      if (act === 'open') { window.open(galleryThumb(f), '_blank'); return; }
      if (act === 'del') {
        const ok = await confirmModal('删除图片', `确定要删除「${f.name}」吗？此操作不可恢复。`, true);
        if (!ok) return;
        btn.disabled = true;
        try {
          await api('/api/gallery?key=' + encodeURIComponent(f.key), { method: 'DELETE' });
          item.remove();
          items = items.filter((x) => x.key !== f.key);
          renderGrid();
          toast(currentBackend() === 'github' && MODE === 'github'
            ? '已从仓库删除（1~2 分钟后自动部署生效）' : '已删除', 'ok', 3200);
        } catch (err) {
          btn.disabled = false;
          toast(err.message, 'error', 4200);
        }
      }
    }));
  };

  const load = async () => {
    const grid = $('#media-grid');
    grid.innerHTML = '<div class="picgo-loading">正在读取云相册…</div>';
    try {
      const data = await api('/api/gallery');
      items = (data.files || []).map(normalizeGalleryFile);
      renderGrid();
    } catch (e) {
      items = [];
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">读取失败：${esc(e.message)}</div>`;
    }
  };

  /* ---------- 最近上传记录 ---------- */

  const renderRecent = () => {
    const box = $('#media-recent');
    const recs = getUploadRecords().slice(0, 12);
    if (!recs.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="picgo-recent-head">最近上传<span class="hint" style="margin:0">（记录保存在本浏览器）</span></div>
      <div class="picgo-recent-list">
        ${recs.map((r) => `
          <div class="picgo-recent-item" data-md="${esc(r.markdown || `![](${r.url})`)}" title="${esc(r.name || r.url)} · 点击复制 Markdown">
            <img src="${esc(r.url)}" alt="" loading="lazy" />
            <span>复制</span>
          </div>`).join('')}
      </div>`;
    $$('.picgo-recent-item', box).forEach((el) => {
      el.addEventListener('click', () => copyText(el.dataset.md));
    });
  };

  /* ---------- 上传 ---------- */

  const uploadFiles = async (files) => {
    const list = Array.from(files || []).filter((f) => {
      if (!MEDIA_ACCEPT.test(f.name || '')) {
        toast(`跳过不支持的文件：${f.name || '未命名'}`, 'warn');
        return false;
      }
      return true;
    });
    if (!list.length) return;
    const prog = $('#media-progress');
    prog.classList.remove('hidden');
    let done = 0;
    const okItems = [];
    for (const file of list) {
      const label = file.name || `剪贴板图片-${Date.now()}.png`;
      $('#media-progress-inner').style.width = `${Math.round((done / list.length) * 100)}%`;
      $('#media-progress-text').textContent = `正在上传 ${done + 1}/${list.length} · ${label}（${fmtBytes(file.size)}）`;
      const fd = new FormData();
      fd.append('file', file, label);
      try {
        const out = await apiUpload(fd);
        okItems.push(out);
        const rec = { name: out.name || label, rel: out.rel, url: out.url };
        pushUploadRecord({
          name: rec.name,
          url: out.url,
          rel: out.rel || '',
          backend: out.backend || currentBackend(),
          markdown: galleryMarkdown(rec),
        });
        toast(`${label} 上传成功`, 'ok');
      } catch (e) {
        toast(`${label} 上传失败：${e.message}`, 'error', 6000);
      }
      done += 1;
      $('#media-progress-inner').style.width = `${Math.round((done / list.length) * 100)}%`;
      $('#media-progress-text').textContent = `已完成 ${done}/${list.length}`;
    }
    if (AUTO_COPY && okItems.length) {
      copyText(okItems.map((r) => galleryMarkdown({ name: r.name, rel: r.rel, url: r.url })).join('\n'));
    }
    setTimeout(() => prog.classList.add('hidden'), 900);
    renderRecent();
    load();
  };

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    uploadFiles(Array.from(e.dataTransfer.files || []));
  });
  fileInput.addEventListener('change', (e) => {
    uploadFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });

  $('#media-refresh').addEventListener('click', () => { toast('正在刷新…'); load(); });
  $('#media-autocopy').addEventListener('change', (e) => {
    AUTO_COPY = e.target.checked;
    localStorage.setItem('ftm_autocopy', AUTO_COPY ? '1' : '0');
    toast(AUTO_COPY ? '上传后将自动复制 Markdown' : '已关闭自动复制', 'ok');
  });
  $('#media-search').addEventListener('input', (e) => {
    keyword = e.target.value.trim().toLowerCase();
    renderGrid();
  });

  /* ---------- 图床设置 ---------- */

  const settingsCard = $('#media-settings-card');
  const toggleSettings = (show) => {
    settingsCard.classList.toggle('hidden', !show);
    if (show) settingsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  $('#media-settings-toggle').addEventListener('click', () => toggleSettings(settingsCard.classList.contains('hidden')));
  $('#media-settings-close').addEventListener('click', () => toggleSettings(false));

  $$('#st-tabs .picgo-tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('#st-tabs .picgo-tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.picgo-panel', settingsCard).forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.backend));
  }));

  $('#media-settings-save').addEventListener('click', async () => {
    const activeTab = $('#st-tabs .picgo-tab.active');
    const headers = $('#st-cu-headers').value.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':');
        return i === -1 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
      });
    const next = {
      backend: activeTab ? activeTab.dataset.backend : currentBackend(),
      oss: {
        accessKeyId: $('#st-oss-key').value.trim(),
        accessKeySecret: $('#st-oss-secret').value.trim(),
        bucket: $('#st-oss-bucket').value.trim(),
        endpoint: $('#st-oss-endpoint').value.trim() || 'oss-cn-beijing.aliyuncs.com',
        dirPrefix: $('#st-oss-prefix').value.trim(),
        customDomain: $('#st-oss-domain').value.trim(),
      },
      custom: {
        uploadUrl: $('#st-cu-url').value.trim(),
        fieldName: $('#st-cu-field').value.trim() || 'file',
        headers,
        urlRegex: $('#st-cu-regex').value.trim(),
      },
    };
    if (next.backend === 'oss' && (!next.oss.accessKeyId || !next.oss.accessKeySecret || !next.oss.bucket)) {
      const go = await confirmModal('配置不完整', 'OSS 图床缺少 AccessKeyId / AccessKeySecret / Bucket，确定仍要保存吗？', true);
      if (!go) return;
    }
    if (next.backend === 'custom' && !next.custom.uploadUrl) {
      const go = await confirmModal('配置不完整', '自定义图床还没有填写上传接口地址，确定仍要保存吗？', true);
      if (!go) return;
    }
    try {
      const out = await api('/api/storage', { method: 'PUT', body: JSON.stringify(next) });
      STORAGE = Object.assign(STORAGE, (out && out.storage) || next);
      saveStorageCfg();
      toast((out && out.message) || '图床配置已保存', 'ok');
      route();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  const testBtn = $('#media-settings-test');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const raw = testBtn.textContent;
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      try {
        const bin = atob(TEST_PNG_B64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const fd = new FormData();
        fd.append('file', new Blob([bytes], { type: 'image/png' }), `test-${Date.now()}.png`);
        const out = await apiUpload(fd);
        toast(`上传成功：${out.url}`, 'ok', 6000);
      } catch (e) {
        toast(`测试失败：${e.message}`, 'error', 6000);
      }
      testBtn.disabled = false;
      testBtn.textContent = raw;
    });
  }

  /* ---------- 粘贴上传 / 拖拽防护（离开视图时自动解绑） ---------- */

  const onPaste = (e) => {
    const clip = e.clipboardData;
    if (!clip) return;
    const files = [];
    Array.from(clip.items || []).forEach((it) => {
      if (it.kind === 'file' && /^image\//i.test(it.type)) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    });
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  };
  const preventDrop = (e) => e.preventDefault();
  document.addEventListener('paste', onPaste);
  window.addEventListener('dragover', preventDrop);
  window.addEventListener('drop', preventDrop);
  VIEW_CLEANUP = () => {
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('dragover', preventDrop);
    window.removeEventListener('drop', preventDrop);
  };

  renderRecent();
  load();
}

/* ------------------------------ 站点设置 ------------------------------ */

async function renderSettings(container) {
  container.innerHTML = `
    <div class="grid settings-grid">
      <div>
        <div class="card">
          <div class="card-head"><h3>站点信息</h3></div>
          <div class="card-body">
            <label class="field"><span>网站标题</span><input id="cfg-title" /></label>
            <label class="field"><span>副标题</span><input id="cfg-subtitle" /></label>
            <label class="field"><span>站点描述</span><textarea id="cfg-description" rows="2"></textarea></label>
            <label class="field"><span>关键词（逗号分隔）</span><input id="cfg-keywords" /></label>
            <label class="field"><span>作者</span><input id="cfg-author" /></label>
            <label class="field"><span>站点 URL</span><input id="cfg-url" /></label>
            <label class="field"><span>语言</span><input id="cfg-language" /></label>
            <button class="btn btn-primary" id="cfg-save">保存站点信息</button>
            <span class="hint">修改的是根目录 _config.yml。${MODE === 'github' ? 'Git 提交历史即备份。' : '保存前会自动备份原文件。'}</span>
          </div>
        </div>
        <div class="card" style="margin-top:18px">
          ${MODE === 'local' ? `
          <div class="card-head"><h3>修改密码</h3></div>
          <div class="card-body">
            <label class="field"><span>原密码</span><input type="password" id="pw-old" /></label>
            <label class="field"><span>新密码（至少 6 位）</span><input type="password" id="pw-new" /></label>
            <label class="field"><span>确认新密码</span><input type="password" id="pw-confirm" /></label>
            <button class="btn btn-primary" id="pw-save">修改密码</button>
          </div>` : `
          <div class="card-head"><h3>GitHub 连接设置</h3></div>
          <div class="card-body">
            <label class="field"><span>访问令牌（PAT）</span><input type="password" id="ghs-token" /></label>
            <div class="field-row">
              <label class="field"><span>仓库 Owner</span><input id="ghs-owner" /></label>
              <label class="field"><span>仓库名</span><input id="ghs-repo" /></label>
            </div>
            <div class="field-row">
              <label class="field"><span>源码分支</span><input id="ghs-branch" /></label>
              <label class="field"><span>源码目录</span><input id="ghs-prefix" /></label>
            </div>
            <button class="btn btn-primary" id="ghs-save">保存连接设置</button>
            <p class="hint">令牌只保存在浏览器本地。修改后下次连接生效。</p>
          </div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="tab-bar" style="padding:0;border:none">
            <button class="tab-btn active" data-file="_config.yml">_config.yml</button>
            <button class="tab-btn" data-file="_config.anzhiyu.yml">_config.anzhiyu.yml</button>
          </div>
        </div>
        <div class="card-body">
          <textarea class="code-editor" id="raw-config" spellcheck="false"></textarea>
          <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
            <button class="btn btn-primary" id="raw-save">保存配置文件</button>
            <span class="hint" style="margin:0" id="raw-file-hint">当前文件：_config.yml</span>
          </div>
          <p class="hint">⚠️ 高级编辑：直接修改站点/主题配置文件。${MODE === 'github' ? 'Git 提交历史即备份。' : '保存时自动备份到 admin/backups/。'}配置格式错误可能导致博客无法构建。</p>
        </div>
      </div>
    </div>`;

  try {
    const data = await api('/api/site-config');
    const cfg = data.config || {};
    $('#cfg-title').value = cfg.title || '';
    $('#cfg-subtitle').value = cfg.subtitle || '';
    $('#cfg-description').value = cfg.description || '';
    $('#cfg-keywords').value = cfg.keywords || '';
    $('#cfg-author').value = cfg.author || '';
    $('#cfg-url').value = cfg.url || '';
    $('#cfg-language').value = cfg.language || '';
  } catch (e) {
    toast(e.message, 'error');
  }

  $('#cfg-save').addEventListener('click', async () => {
    try {
      await api('/api/site-config', {
        method: 'PUT',
        body: JSON.stringify({
          title: $('#cfg-title').value.trim(),
          subtitle: $('#cfg-subtitle').value.trim(),
          description: $('#cfg-description').value.trim(),
          keywords: $('#cfg-keywords').value.trim(),
          author: $('#cfg-author').value.trim(),
          url: $('#cfg-url').value.trim(),
          language: $('#cfg-language').value.trim(),
        }),
      });
      toast('站点信息已保存', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  if (MODE === 'local') {
    $('#pw-save').addEventListener('click', async () => {
      const oldP = $('#pw-old').value;
      const newP = $('#pw-new').value;
      if (newP.length < 6) return toast('新密码至少 6 位', 'warn');
      if (newP !== $('#pw-confirm').value) return toast('两次输入的新密码不一致', 'warn');
      try {
        await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ old: oldP, new: newP }) });
        toast('密码修改成功', 'ok');
        $('#pw-old').value = $('#pw-new').value = $('#pw-confirm').value = '';
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  } else {
    $('#ghs-token').value = GH.token || '';
    $('#ghs-owner').value = GH.owner || '';
    $('#ghs-repo').value = GH.repo || '';
    $('#ghs-branch').value = GH.branch || '';
    $('#ghs-prefix').value = GH.prefix || '';
    $('#ghs-save').addEventListener('click', () => {
      GH.token = $('#ghs-token').value.trim();
      GH.owner = $('#ghs-owner').value.trim();
      GH.repo = $('#ghs-repo').value.trim();
      GH.branch = $('#ghs-branch').value.trim() || 'source';
      GH.prefix = $('#ghs-prefix').value.trim() || 'source';
      saveGH();
      toast('GitHub 连接设置已保存', 'ok');
    });
  }

  /* 原始配置编辑 */
  let currentFile = '_config.yml';
  const loadRaw = async () => {
    try {
      const data = await api(`/api/config-file?file=${encodeURIComponent(currentFile)}`);
      $('#raw-config').value = data.content;
      $('#raw-file-hint').textContent = `当前文件：${currentFile}`;
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      currentFile = btn.dataset.file;
      loadRaw();
    });
  });
  $('#raw-save').addEventListener('click', async () => {
    try {
      await api('/api/config-file', {
        method: 'PUT',
        body: JSON.stringify({ file: currentFile, content: $('#raw-config').value }),
      });
      toast('配置文件已保存（已自动备份）', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  loadRaw();
}

/* ------------------------------ 构建发布 ------------------------------ */

let buildSSE = null;

function closeBuildSSE() {
  if (buildSSE) {
    buildSSE.close();
    buildSSE = null;
  }
  if (window.__buildPollGh) {
    clearInterval(window.__buildPollGh);
    window.__buildPollGh = null;
  }
}

function logLineClass(line) {
  if (/error|错误|fatal|failed|✖|失败/i.test(line)) return 'c-err';
  if (/warn|警告/i.test(line)) return 'c-warn';
  if (/info|success|完成|生成|✓|done/i.test(line)) return 'c-ok';
  return '';
}

async function renderBuild(container) {
  /* ================= GitHub 云端模式 ================= */
  if (MODE === 'github') {
    container.innerHTML = `
      <div class="grid">
        <div class="card">
          <div class="card-head">
            <h3>构建与部署（GitHub Actions）</h3>
            <span id="build-state-badge" class="build-chip hidden"></span>
          </div>
          <div class="card-body">
            <p class="hint" style="margin:0 0 14px">
              保存文章/草稿发布时会自动触发 GitHub Actions 构建（约 2~5 分钟上线），无需手动操作；
              下方按钮用于未自动触发时的兜底或立即部署。
            </p>
            <div class="build-actions">
              <button class="btn btn-primary" id="b-deploy">🚀 构建并部署</button>
              <button class="btn" id="b-refresh">🔄 刷新状态</button>
              <a class="btn" id="b-actions-link" target="_blank" rel="noopener">查看 GitHub Actions ↗</a>
            </div>
            <div class="build-meta" id="build-meta" style="margin-top:14px"></div>
            <div class="console" id="build-console"><span class="c-dim">点击「构建并部署」触发工作流，状态会自动轮询显示在这里。</span></div>
          </div>
        </div>
      </div>`;

    const consoleEl = $('#build-console');
    let hasContent = false;
    const appendLog = (line, cls) => {
      if (!hasContent) {
        consoleEl.innerHTML = '';
        hasContent = true;
      }
      const div = document.createElement('div');
      div.className = cls || '';
      div.textContent = line;
      consoleEl.appendChild(div);
      consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    let lastKey = '';
    const updateStatus = async () => {
      try {
        const st = await api('/api/build/status');
        const badge = $('#build-state-badge');
        const meta = $('#build-meta');
        const link = $('#b-actions-link');
        const job = st.running || st.last;
        if (st.running) {
          badge.textContent = '正在构建…';
          badge.className = 'build-chip running';
          badge.classList.remove('hidden');
          $('#b-deploy').disabled = true;
        } else if (job) {
          badge.textContent = job.status === 'done' ? '构建成功' : '构建失败';
          badge.className = `build-chip ${job.status}`;
          badge.classList.remove('hidden');
          $('#b-deploy').disabled = false;
        } else {
          badge.classList.add('hidden');
          $('#b-deploy').disabled = false;
        }
        if (job) {
          meta.innerHTML = `<span>Run #${esc(job.id)}</span><span>开始：${fmtDate(job.startedAt)}</span>${job.finishedAt ? `<span>结束：${fmtDate(job.finishedAt)}</span>` : ''}`;
          if (job.htmlUrl) link.href = job.htmlUrl;
          const key = job.status + '-' + job.id;
          if (key !== lastKey) {
            lastKey = key;
            if (job.status === 'running') appendLog(`⏳ GitHub Actions 运行中（Run #${job.id}）…`, 'c-warn');
            else if (job.status === 'done') appendLog('✓ 构建部署完成，博客已更新', 'c-ok');
            else appendLog('✗ 构建失败，请点击「查看 GitHub Actions」排查', 'c-err');
          }
          // 构建结束后停止轮询，避免持续消耗 API 配额
          if (!st.running && job.status !== 'running' && window.__buildPollGh) {
            clearInterval(window.__buildPollGh);
            window.__buildPollGh = null;
          }
        }
      } catch (e) { /* 轮询失败忽略 */ }
    };

    $('#b-deploy').addEventListener('click', async () => {
      try {
        await api('/api/build', { method: 'POST', body: JSON.stringify({ action: 'deploy' }) });
        appendLog('🚀 已触发 GitHub Actions 工作流（约 2~5 分钟完成）', 'c-ok');
        // 确保轮询开启（若上次构建结束后已停止）
        if (!window.__buildPollGh) window.__buildPollGh = setInterval(updateStatus, 5000);
        updateStatus();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#b-refresh').addEventListener('click', () => updateStatus());
    updateStatus();
    if (window.__buildPollGh) clearInterval(window.__buildPollGh);
    window.__buildPollGh = setInterval(updateStatus, 5000);
    return;
  }

  /* ================= 本机模式 ================= */
  container.innerHTML = `
    <div class="grid">
      <div class="card">
        <div class="card-head">
          <h3>构建与发布</h3>
          <span id="build-state-badge" class="build-chip hidden"></span>
        </div>
        <div class="card-body">
          <div class="build-actions">
            <button class="btn" id="b-clean" title="清除 public 缓存">🧹 清理缓存</button>
            <button class="btn btn-primary" id="b-generate" title="生成静态文件">⚡ 生成静态文件</button>
            <button class="btn btn-primary" id="b-deploy" title="生成并推送部署">🚀 生成并部署</button>
            <button class="btn btn-danger hidden" id="b-cancel">停止</button>
          </div>
          <div class="build-meta" id="build-meta" style="margin-top:14px"></div>
          <div class="console" id="build-console"><span class="c-dim">还没有构建记录。点击上方按钮开始构建，日志将实时显示在这里。</span></div>
        </div>
      </div>
    </div>`;

  const consoleEl = $('#build-console');
  const appendLog = (line, cls) => {
    if (consoleEl.dataset.hasContent !== '1') {
      consoleEl.innerHTML = '';
      consoleEl.dataset.hasContent = '1';
    }
    const div = document.createElement('div');
    div.className = cls || '';
    div.textContent = line;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  };

  const updateStatus = async () => {
    try {
      const st = await api('/api/build/status');
      const badge = $('#build-state-badge');
      const cancel = $('#b-cancel');
      const meta = $('#build-meta');
      if (st.running) {
        badge.textContent = `正在构建：${st.running.action}`;
        badge.className = 'build-chip running';
        badge.classList.remove('hidden');
        cancel.classList.remove('hidden');
        meta.innerHTML = `<span>任务 ID：${esc(st.running.id)}</span><span>开始：${fmtDate(st.running.startedAt)}</span>`;
      } else if (st.last) {
        badge.textContent = st.last.status === 'done' ? '上次构建成功' : '上次构建失败';
        badge.className = `build-chip ${st.last.status}`;
        badge.classList.remove('hidden');
        cancel.classList.add('hidden');
        meta.innerHTML = `<span>动作：${esc(st.last.action)}</span><span>状态：${st.last.status === 'done' ? '成功' : '失败'}</span><span>耗时：${((st.last.finishedAt - st.last.startedAt) / 1000).toFixed(1)}s</span><span>结束：${fmtDate(st.last.finishedAt)}</span>`;
      } else {
        badge.classList.add('hidden');
        cancel.classList.add('hidden');
        meta.innerHTML = '';
      }
      refreshBuildChip();
    } catch (e) {
      /* ignore */
    }
  };

  const startBuild = async (action) => {
    try {
      await api('/api/build', { method: 'POST', body: JSON.stringify({ action }) });
      toast('构建任务已开始', 'ok');
      appendLog(`$ 开始执行 ${action}`, 'c-dim');
      updateStatus();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#b-clean').addEventListener('click', () => startBuild('clean'));
  $('#b-generate').addEventListener('click', () => startBuild('generate'));
  $('#b-deploy').addEventListener('click', async () => {
    const ok = await confirmModal('部署确认', '将执行 hexo generate --deploy，构建后推送到 GitHub 仓库。确定继续吗？');
    if (!ok) return;
    startBuild('deploy');
  });
  $('#b-cancel').addEventListener('click', async () => {
    try {
      await api('/api/build/cancel', { method: 'POST', body: '{}' });
      toast('已发送停止指令', 'warn');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  /* 载入上次日志 */
  try {
    const st = await api('/api/build/status');
    const job = st.running || st.last;
    if (job && job.log && job.log.length) {
      consoleEl.innerHTML = '';
      consoleEl.dataset.hasContent = '1';
      job.log.forEach((l) => appendLog(l, logLineClass(l)));
    }
  } catch (e) {
    /* ignore */
  }
  updateStatus();

  /* SSE 实时日志 */
  closeBuildSSE();
  buildSSE = new EventSource(`/api/build/events?token=${encodeURIComponent(TOKEN || '')}`);
  buildSSE.addEventListener('start', () => updateStatus());
  buildSSE.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendLog(data.line, logLineClass(data.line));
    } catch (err) { /* ignore */ }
  });
  buildSSE.addEventListener('done', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendLog(data.status === 'done' ? '✓ 构建完成' : '✗ 构建失败（exit ' + data.exitCode + '）', data.status === 'done' ? 'c-ok' : 'c-err');
    } catch (err) { /* ignore */ }
    updateStatus();
  });
  buildSSE.onerror = () => { /* EventSource 自动重连 */ };
}

/* ------------------------------ 启动 ------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  $('#login-form').addEventListener('submit', doLogin);
  $('#logout-btn').addEventListener('click', () => logout(true));
  setupSidebar();
  setupLoginTabs();
  setupGithubPanel();
  window.addEventListener('hashchange', route);
  $('#topbar-username').textContent = USER;
  initAuth();
});
