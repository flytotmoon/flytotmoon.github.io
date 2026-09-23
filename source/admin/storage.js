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

  function ossHost(cfg) {
    const endpoint = String(cfg.endpoint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `${cfg.bucket}.${endpoint}`;
  }

  function ossPublicUrl(cfg, key) {
    const domain = String(cfg.customDomain || '').replace(/\/+$/, '');
    if (domain) return `${domain}/${encodeKeyPath(key)}`;
    return `https://${ossHost(cfg)}/${encodeKeyPath(key)}`;
  }

  /** OSS 签名 V1（PUT/DELETE 等无 subresource 请求） */
  async function ossSign(cfg, method, contentType, date, resource) {
    const stringToSign = `${method}\n\n${contentType}\n${date}\n${resource}`;
    const sig = await hmacSha1Base64(cfg.accessKeySecret, stringToSign);
    return `OSS ${cfg.accessKeyId}:${sig}`;
  }

  /** 上传对象到 OSS */
  async function ossPut(cfg, key, bytes, contentType) {
    const date = new Date().toUTCString();
    const resource = `/${cfg.bucket}/${key}`;
    const auth = await ossSign(cfg, 'PUT', contentType || 'application/octet-stream', date, resource);
    const res = await fetch(`https://${ossHost(cfg)}/${encodeKeyPath(key)}`, {
      method: 'PUT',
      headers: {
        Date: date,
        'Content-Type': contentType || 'application/octet-stream',
        Authorization: auth,
      },
      body: bytes,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`OSS 上传失败：HTTP ${res.status} ${txt.slice(0, 180)}`);
    }
    return { url: ossPublicUrl(cfg, key), key };
  }

  /**
   * 列出 OSS 对象（ListObjects V1）
   * 签名时子资源 prefix 的编码方式各端实现不一致（URL 编码 / 原文），
   * 因此这里先按 URL 编码签名，若返回 SignatureDoesNotMatch 再用原文重试一次。
   */
  async function ossList(cfg, prefix, max) {
    const keys = max || 200;
    const enc = encodeURIComponent(prefix || '');
    const raw = prefix || '';
    const query = `max-keys=${keys}&prefix=${enc}`;
    const resources = [`/${cfg.bucket}/?${query}`];
    if (raw && raw !== enc) resources.push(`/${cfg.bucket}/?max-keys=${keys}&prefix=${raw}`);

    let text = '';
    let lastErr = '';
    for (const resource of resources) {
      const date = new Date().toUTCString();
      const auth = await ossSign(cfg, 'GET', '', date, resource);
      const res = await fetch(`https://${ossHost(cfg)}/?${query}`, {
        method: 'GET',
        headers: { Date: date, Authorization: auth },
      });
      text = await res.text();
      if (res.ok) { lastErr = ''; break; }
      lastErr = `HTTP ${res.status} ${text.slice(0, 180)}`;
      if (!/SignatureDoesNotMatch/i.test(text)) break;
    }
    if (lastErr) throw new Error(`OSS 列表获取失败：${lastErr}`);
    const files = [];
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m;
    while ((m = re.exec(text))) {
      const block = m[1];
      const key = (/<Key>([\s\S]*?)<\/Key>/.exec(block) || [])[1] || '';
      if (!key || key.endsWith('/')) continue;
      if (!/\.(jpe?g|png|gif|webp|svg|avif|ico)$/i.test(key)) continue;
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
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
  }

  /** 删除 OSS 对象 */
  async function ossDelete(cfg, key) {
    const date = new Date().toUTCString();
    const resource = `/${cfg.bucket}/${key}`;
    const auth = await ossSign(cfg, 'DELETE', '', date, resource);
    const res = await fetch(`https://${ossHost(cfg)}/${encodeKeyPath(key)}`, {
      method: 'DELETE',
      headers: { Date: date, Authorization: auth },
    });
    if (!res.ok && res.status !== 404) {
      const txt = await res.text().catch(() => '');
      throw new Error(`OSS 删除失败：HTTP ${res.status} ${txt.slice(0, 180)}`);
    }
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
    const res = await fetch(cfg.uploadUrl, { method: 'POST', headers, body: fd });
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
      const cfg = (storage && storage.oss) || {};
      if (!cfg.accessKeyId || !cfg.accessKeySecret || !cfg.bucket || !cfg.endpoint) {
        throw new Error('阿里云 OSS 配置不完整（需要 AccessKeyId / AccessKeySecret / Bucket / Endpoint）');
      }
      const info = buildFileName(file.filename);
      const key = joinPrefix(cfg.dirPrefix, `${info.month}/${info.name}`);
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

  /** 列出云端图片 */
  async function list(storage, max) {
    const backend = (storage && storage.backend) || 'github';
    if (backend === 'oss') {
      const cfg = (storage && storage.oss) || {};
      return ossList(cfg, cfg.dirPrefix || '', max);
    }
    return [];
  }

  /** 删除云端图片 */
  async function remove(storage, key) {
    const backend = (storage && storage.backend) || 'github';
    if (backend === 'oss') {
      return ossDelete((storage && storage.oss) || {}, key);
    }
    throw new Error('该图床不支持删除操作');
  }

  return {
    IS_NODE,
    hmacSha1Base64,
    buildFileName,
    joinPrefix,
    extractUrl,
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
