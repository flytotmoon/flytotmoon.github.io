/* ============================================================
   flytotmoon 博客后台 —— 图床（云相册）模块
   浏览器与 Node 端共用：浏览器挂载 window.FTMStorage（避免覆盖浏览器原生 Storage 接口），
   Node 通过 require 使用。
   支持后端：github（仓库内 /img/upload）、oss（阿里云 OSS）、custom（自定义上传接口）
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('crypto'));
  else root.FTMStorage = factory(null);
})(typeof self !== 'undefined' ? self : this, function (nodeCrypto) {
  'use strict';

  /* ------------------------------ 基础工具 ------------------------------ */

  const IS_NODE = Boolean(nodeCrypto);

  function base64FromBuffer(buf) {
    if (IS_NODE) return Buffer.from(buf).toString('base64');
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /** HMAC-SHA1 → base64（Node 用 crypto，浏览器用 WebCrypto） */
  async function hmacSha1Base64(secret, message) {
    if (IS_NODE) {
      return nodeCrypto.createHmac('sha1', secret).update(message, 'utf8').digest('base64');
    }
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return base64FromBuffer(sig);
  }

  function encodeKeyPath(key) {
    return String(key).split('/').map(encodeURIComponent).join('/');
  }

  /** URL 查询串：键按字典序，值 URL 编码 */
  function buildOssQuery(params) {
    return Object.keys(params).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');
  }

  /**
   * CanonicalizedResource 的子资源串：键按字典序升序
   * 签名时子资源值要用原值（与 ali-oss 一致），encodeValues=true 时用编码值
   */
  function buildOssResource(bucket, params, encodeValues) {
    const sub = Object.keys(params).sort()
      .map((k) => `${k}=${encodeValues ? encodeURIComponent(params[k]) : params[k]}`)
      .join('&');
    return `/${bucket}/?${sub}`;
  }

  /** 生成上传文件名：YYYYMMDD-随机-名字.ext */
  function buildFileName(originalName) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ext = ((String(originalName).match(/\.([a-z0-9]+)$/i) || [])[1] || 'png').toLowerCase();
    const base = String(originalName)
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .slice(0, 40) || 'image';
    const rand = Math.random().toString(16).slice(2, 10);
    return {
      name: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${rand}-${base}.${ext}`,
      month: `${d.getFullYear()}${p(d.getMonth() + 1)}`,
      ext,
    };
  }

  function joinPrefix(prefix, rest) {
    const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
    const r = String(rest || '').replace(/^\/+/g, '');
    return p ? `${p}/${r}` : r;
  }

  /* ------------------------------ 阿里云 OSS ------------------------------ */

  /**
   * 归一化 OSS Endpoint，容忍常见填法：
   *   oss-cn-beijing                        → oss-cn-beijing.aliyuncs.com
   *   https://oss-cn-beijing.aliyuncs.com/  → oss-cn-beijing.aliyuncs.com
   *   xsxtk.oss-cn-beijing.aliyuncs.com     → oss-cn-beijing.aliyuncs.com（误把 Bucket 带进来）
   *   xsxtk.oss-cn-beijing                  → oss-cn-beijing.aliyuncs.com（漏了 aliyuncs.com）
   */
  function normalizeEndpoint(endpoint, bucket) {
    let e = String(endpoint || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!e) return '';
    const b = String(bucket || '').trim();
    if (b && e.toLowerCase().startsWith(`${b.toLowerCase()}.`)) e = e.slice(b.length + 1);
    const parts = e.split('.');
    const ossIdx = parts.findIndex((p) => /^oss-[a-z0-9-]+$/i.test(p));
    if (ossIdx >= 0) {
      if (ossIdx > 0) parts.splice(0, ossIdx); // 丢掉误带进来的 Bucket 段
      const rest = parts.join('.');
      return /\.aliyuncs\.com(\.cn)?$/i.test(rest) ? rest : `${rest}.aliyuncs.com`;
    }
    if (!e.includes('.')) return `${e}.aliyuncs.com`;
    return e;
  }

  /** 统一的网络错误提示：把浏览器的 "Failed to fetch" 翻译成可排查的原因 */
  async function fetchOrExplain(url, opts) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      const msg = (e && e.message) || '';
      const host = String(url).replace(/^https?:\/\//, '').split('/')[0];
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        throw new Error(`无法连接 ${host}：可能是 Bucket 未配置跨域(CORS)、Endpoint 填错或本机网络不通。`
          + '浏览器直传 OSS 需在 OSS 控制台给 Bucket 添加跨域规则（来源填站点域名、方法 PUT/POST/GET/HEAD/DELETE、允许 Headers 全部）。');
      }
      throw new Error(`请求 ${host} 失败：${msg || '未知网络错误'}`);
    }
  }

  function ossHost(cfg) {
    const endpoint = normalizeEndpoint(cfg.endpoint, cfg.bucket);
    return `${cfg.bucket}.${endpoint}`;
  }

  /**
   * 清洗 OSS 配置：密钥里常见的手滑（空格、换行、引号、粘贴成两行）会直接导致
   * SignatureDoesNotMatch，这里统一去掉空白与引号。
   */
  function sanitizeOss(cfg) {
    const c = cfg || {};
    const bucket = String(c.bucket || '').trim();
    return Object.assign({}, c, {
      accessKeyId: String(c.accessKeyId || '').replace(/[\s"']/g, ''),
      accessKeySecret: String(c.accessKeySecret || '').replace(/[\s"']/g, ''),
      bucket,
      endpoint: normalizeEndpoint(c.endpoint, bucket),
      dirPrefix: String(c.dirPrefix || '').replace(/^\/+|\/+$/g, ''),
      customDomain: String(c.customDomain || '').replace(/\/+$/, ''),
      monthDir: c.monthDir !== false,
    });
  }

  /** 解析 OSS 的错误 XML，SignatureDoesNotMatch 时把 OSS 期望的签名串带出来 */
  function explainOssError(status, xml, ours) {
    const text = String(xml || '');
    const code = (/<Code>([\s\S]*?)<\/Code>/.exec(text) || [])[1] || '';
    const message = (/<Message>([\s\S]*?)<\/Message>/.exec(text) || [])[1] || '';
    const requestId = (/<RequestId>([\s\S]*?)<\/RequestId>/.exec(text) || [])[1] || '';
    if (code === 'SignatureDoesNotMatch' && ours) {
      const expected = (/<StringToSign>([\s\S]*?)<\/StringToSign>/.exec(text) || [])[1] || '';
      return `OSS 签名不匹配（HTTP ${status}）
· 本机签名串：${JSON.stringify(ours)}
${expected ? `· OSS 期望串：${JSON.stringify(expected)}\n` : ''}· 请重点检查 AccessKey Secret 是否复制完整（应为 30 位、无空格换行），以及它与 AccessKey ID 是否属于同一个账号${requestId ? `\n· RequestId：${requestId}` : ''}`;
    }
    return `OSS 请求失败：HTTP ${status} ${code ? `<${code}> ` : ''}${message || text.slice(0, 200)}${requestId ? `（RequestId ${requestId}）` : ''}`;
  }

  function ossPublicUrl(cfg, key) {
    const domain = String(cfg.customDomain || '').replace(/\/+$/, '');
    if (domain) return `${domain}/${encodeKeyPath(key)}`;
    return `https://${ossHost(cfg)}/${encodeKeyPath(key)}`;
  }

  /**
   * OSS 签名 V1
   * 用 x-oss-date 而不是 Date：浏览器的 fetch 禁止脚本设置 Date 请求头（会被静默丢弃，
   * 导致 OSS 返回 403 AccessDenied "requires a valid Date"）。
   * 按规范，x-oss-date 既是 StringToSign 里的时间戳，也要计入 CanonicalizedOSSHeaders。
   */
  async function ossSign(cfg, method, contentType, date, resource, includeOssHeaders = true) {
    const ossHeaders = includeOssHeaders ? `x-oss-date:${date}\n` : '';
    const stringToSign = `${method}\n\n${contentType}\n${date}\n${ossHeaders}${resource}`;
    const sig = await hmacSha1Base64(cfg.accessKeySecret, stringToSign);
    return `OSS ${cfg.accessKeyId}:${sig}`;
  }

  /**
   * 发送一次 OSS 请求；若 OSS 返回 SignatureDoesNotMatch，则自动换一种
   * 「x-oss-date 是否计入签名头」的算法重试（不同实现/区域存在差异）。
   */
  async function ossSend(cfg, { method, url, resource, contentType = '', body }) {
    let out = null;
    for (const includeOssHeaders of [true, false]) {
      const date = new Date().toUTCString();
      const ossHeaders = includeOssHeaders ? `x-oss-date:${date}\n` : '';
      const stringToSign = `${method}\n\n${contentType}\n${date}\n${ossHeaders}${resource}`;
      const sig = await hmacSha1Base64(cfg.accessKeySecret, stringToSign);
      const headers = { 'x-oss-date': date, Authorization: `OSS ${cfg.accessKeyId}:${sig}` };
      if (contentType) headers['Content-Type'] = contentType;
      const res = await fetchOrExplain(url, { method, headers, body });
      const text = await res.text().catch(() => '');
      out = { res, text, stringToSign };
      if (res.ok || !/SignatureDoesNotMatch/i.test(text)) return out;
    }
    return out;
  }

  /** 上传对象到 OSS */
  async function ossPut(cfg, key, bytes, contentType) {
    const type = contentType || 'application/octet-stream';
    const { res, text, stringToSign } = await ossSend(cfg, {
      method: 'PUT',
      url: `https://${ossHost(cfg)}/${encodeKeyPath(key)}`,
      resource: `/${cfg.bucket}/${key}`,
      contentType: type,
      body: bytes,
    });
    if (!res.ok) throw new Error(explainOssError(res.status, text, stringToSign));
    return { url: ossPublicUrl(cfg, key), key };
  }

  /**
   * 列出 OSS 对象（ListObjects V1，自动翻页取全）
   * - 子资源按字典序排序；URL 用编码值、签名用原值（与 ali-oss 官方实现一致），
   *   若 OSS 返回 SignatureDoesNotMatch 则换另一种编码方式重试
   * - V1 不带 delimiter 时不返回 NextMarker，用本页最后一个 Key 作为下一页的 marker
   * @param {string} prefix 目录前缀，非空时按目录语义补 `/`（img → img/）
   */
  async function ossList(cfg, prefix, max) {
    const limit = Math.max(1, Math.min(Number(max) || 1000, 10000));
    let dir = String(prefix || '').trim();
    if (dir) dir = `${dir.replace(/\/+$/, '')}/`;

    const files = [];
    const seen = {};
    let marker = '';
    let truncated = false;

    for (let page = 0; page < 20 && files.length < limit; page += 1) {
      const params = { 'max-keys': Math.min(1000, limit - files.length) };
      if (dir) params.prefix = dir;
      if (marker) params.marker = marker;
      const query = buildOssQuery(params);
      const url = `https://${ossHost(cfg)}/?${query}`;

      let out = null;
      let lastErr = '';
      for (const encodeValues of [false, true]) {
        out = await ossSend(cfg, {
          method: 'GET',
          url,
          resource: buildOssResource(cfg.bucket, params, encodeValues),
        });
        if (out.res.ok) { lastErr = ''; break; }
        lastErr = explainOssError(out.res.status, out.text, out.stringToSign);
        if (!/SignatureDoesNotMatch/i.test(out.text)) break;
      }
      if (lastErr) throw new Error(lastErr);

      const text = out.text;
      let lastKey = '';
      const re = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m;
      while ((m = re.exec(text))) {
        const block = m[1];
        const key = (/<Key>([\s\S]*?)<\/Key>/.exec(block) || [])[1] || '';
        if (!key) continue;
        lastKey = key;
        if (key.endsWith('/') || seen[key]) continue;
        if (!/\.(jpe?g|png|gif|webp|svg|avif|ico)$/i.test(key)) continue;
        seen[key] = true;
        const size = Number((/<Size>(\d+)<\/Size>/.exec(block) || [])[1] || 0);
        const lastMod = (/<LastModified>([\s\S]*?)<\/LastModified>/.exec(block) || [])[1] || '';
        files.push({
          key,
          name: key.split('/').pop(),
          rel: key,
          url: ossPublicUrl(cfg, key),
          size,
          mtime: lastMod ? Date.parse(lastMod) || 0 : 0,
        });
      }

      truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text);
      if (!truncated || !lastKey || lastKey === marker) break;
      marker = lastKey;
    }

    files.sort((a, b) => b.mtime - a.mtime);
    files.truncated = truncated && files.length >= limit;
    files.limit = limit;
    return files;
  }

  /** 删除 OSS 对象 */
  async function ossDelete(cfg, key) {
    const { res, text, stringToSign } = await ossSend(cfg, {
      method: 'DELETE',
      url: `https://${ossHost(cfg)}/${encodeKeyPath(key)}`,
      resource: `/${cfg.bucket}/${key}`,
    });
    if (!res.ok && res.status !== 404) throw new Error(explainOssError(res.status, text, stringToSign));
    return true;
  }

  /* ------------------------------ 自定义上传接口 ------------------------------ */

  function extractUrl(text, regex) {
    const raw = String(text || '');
    if (regex) {
      try {
        const m = new RegExp(regex).exec(raw);
        if (m) return m[1] || m[0];
      } catch (e) {
        /* 正则非法则回退默认匹配 */
      }
    }
    const m = /https?:\/\/[^\s"'<>\\)]+/.exec(raw);
    return m ? m[0] : '';
  }

  /** 通过自定义接口上传（POST multipart） */
  async function customUpload(cfg, filename, contentType, bytes) {
    if (!cfg.uploadUrl) throw new Error('尚未配置自定义上传接口地址');
    const fd = new FormData();
    const blob = new Blob([bytes], { type: contentType || 'application/octet-stream' });
    fd.append(cfg.fieldName || 'file', blob, filename);
    const headers = {};
    (cfg.headers || []).forEach((h) => {
      if (h && h.name) headers[h.name] = h.value;
    });
    const res = await fetchOrExplain(cfg.uploadUrl, { method: 'POST', headers, body: fd });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`自定义图床上传失败：HTTP ${res.status} ${text.slice(0, 180)}`);
    const url = extractUrl(text, cfg.urlRegex);
    if (!url) throw new Error(`未能从响应中解析出图片地址：${text.slice(0, 180)}`);
    return { url, key: url };
  }

  /* ------------------------------ 统一入口 ------------------------------ */

  /**
   * 上传图片
   * @param {object} storage 图床配置 { backend, oss:{...}, custom:{...} }
   * @param {{filename:string, contentType:string, bytes:Buffer|Uint8Array}} file
   * @returns {Promise<{url:string, key:string, backend:string}>}
   */
  async function upload(storage, file) {
    const backend = (storage && storage.backend) || 'github';
    if (backend === 'oss') {
      const cfg = sanitizeOss((storage && storage.oss) || {});
      if (!cfg.accessKeyId || !cfg.accessKeySecret || !cfg.bucket || !cfg.endpoint) {
        throw new Error('阿里云 OSS 配置不完整（需要 AccessKeyId / AccessKeySecret / Bucket / Endpoint）');
      }
      const info = buildFileName(file.filename);
      // monthDir 为 false 时不上传月份子目录（与已存在的 img/xxx.jpg 布局保持一致）
      const key = joinPrefix(cfg.dirPrefix, cfg.monthDir ? `${info.month}/${info.name}` : info.name);
      const out = await ossPut(cfg, key, file.bytes, file.contentType);
      return { url: out.url, key: out.key, backend: 'oss' };
    }
    if (backend === 'custom') {
      const cfg = (storage && storage.custom) || {};
      const out = await customUpload(cfg, file.filename, file.contentType, file.bytes);
      return { url: out.url, key: out.key, backend: 'custom' };
    }
    throw new Error('github 图床由各端自行处理（仓库内 /img/upload）');
  }

  /** 列出云端图片（OSS 会自动翻页，默认最多 2000 张） */
  async function list(storage, max) {
    const backend = (storage && storage.backend) || 'github';
    if (backend === 'oss') {
      const cfg = sanitizeOss((storage && storage.oss) || {});
      return ossList(cfg, cfg.dirPrefix || '', max || 2000);
    }
    return [];
  }

  /** 删除云端图片 */
  async function remove(storage, key) {
    const backend = (storage && storage.backend) || 'github';
    if (backend === 'oss') {
      return ossDelete(sanitizeOss((storage && storage.oss) || {}), key);
    }
    throw new Error('该图床不支持删除操作');
  }

  return {
    IS_NODE,
    hmacSha1Base64,
    buildFileName,
    joinPrefix,
    extractUrl,
    normalizeEndpoint,
    sanitizeOss,
    explainOssError,
    ossHost,
    ossPublicUrl,
    ossPut,
    ossList,
    ossDelete,
    customUpload,
    upload,
    list,
    remove,
  };
});
