'use strict';
/* ============================================================
   flytotmoon 后台 API 自测脚本
   用法：先启动后台（node admin/server.js），再执行
       node admin/test-api.js
   ============================================================ */

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:4321';
const fs = require('fs');
const path = require('path');
let token = '';
let passed = 0;
let failed = 0;

function assert(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`);
  }
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, data };
}

async function main() {
  console.log(`\n== 测试目标：${BASE} ==\n`);

  // ping
  const ping = await api('/api/ping');
  assert('ping 可用', ping.status === 200 && ping.data.ok);

  // 错误密码
  const bad = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
  assert('错误密码被拒绝 (401)', bad.status === 401);

  // 正确登录
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  assert('默认账号登录成功', login.status === 200 && login.data.token);
  token = login.data.token;

  // 未登录访问受保护接口
  const noAuth = await fetch(BASE + '/api/meta');
  assert('未登录访问被拒绝 (401)', noAuth.status === 401);

  // meta
  const meta = await api('/api/meta');
  assert('统计接口正常', meta.status === 200 && typeof meta.data.posts === 'number');

  // 文章列表 + 筛选
  const list = await api('/api/posts?size=5');
  assert('文章列表正常', list.status === 200 && Array.isArray(list.data.posts));

  // 读取含无缩进列表的文章并做往返校验
  const q = await api('/api/posts?q=' + encodeURIComponent('阳痿'));
  const key = q.data.posts[0] && q.data.posts[0].key;
  assert('能搜索到目标文章', Boolean(key));
  if (key) {
    const one = await api('/api/posts/' + encodeURIComponent(key));
    assert('单篇读取正常', one.status === 200);
    const p = one.data.post;
    assert('无缩进列表解析正确（分类）', p.categories.join('/') === '哲学', JSON.stringify(p.categories));
    assert('无缩进列表解析正确（标签）', p.tags.join('/') === '哲学/马克思主义', JSON.stringify(p.tags));
    assert('mathjax 标记识别', p.mathjax === true);
    const rt = await api('/api/posts/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({
        scope: 'posts', title: p.title, content: p.body, date: p.date,
        categories: p.categories, tags: p.tags, cover: p.cover, sticky: p.sticky, mathjax: p.mathjax,
      }),
    });
    assert('更新（往返）成功', rt.status === 200);
    if (rt.status === 200) {
      const re = await api('/api/posts/' + encodeURIComponent(rt.data.key));
      assert('往返后分类保持', re.data.post.categories.join('/') === '哲学');
      assert('往返后标签保持', re.data.post.tags.join('/') === '哲学/马克思主义');
      assert('往返后正文保持', re.data.post.body === p.body);
    }
  }

  // 创建 / 改名 / 删除
  const created = await api('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      title: '后台测试文章', content: '## 测试\n\n这是后台创建的测试内容。', date: '2026-08-26 12:00:00',
      categories: ['杂文'], tags: ['测试'], cover: 'https://example.com/x.jpg', sticky: 3, mathjax: false, comments: true,
    }),
  });
  assert('创建文章成功', created.status === 200 && created.data.key);
  const cKey = created.data.key;
  if (cKey) {
    const got = await api('/api/posts/' + encodeURIComponent(cKey));
    assert('新文章分类正确', got.data.post.categories.join(',') === '杂文');
    assert('置顶优先级保留（sticky=3）', got.data.post.sticky === 3);
    const renamed = await api('/api/posts/' + encodeURIComponent(cKey), {
      method: 'PUT',
      body: JSON.stringify({ scope: 'posts', title: '后台测试文章-改', content: got.data.post.body + '\n\n追加一行', tags: ['测试', '改'] }),
    });
    assert('更新并重命名成功', renamed.status === 200 && renamed.data.key !== cKey);
    const del = await api('/api/posts/' + encodeURIComponent(renamed.data.key) + '?scope=posts', { method: 'DELETE' });
    assert('删除文章成功', del.status === 200);
  }

  // 草稿流程
  const d = await api('/api/posts', { method: 'POST', body: JSON.stringify({ scope: 'drafts', title: '草稿测试', content: '草稿内容' }) });
  assert('创建草稿成功', d.status === 200 && d.data.key);
  if (d.data.key) {
    const dlist = await api('/api/posts?scope=drafts');
    assert('草稿列表包含新草稿', dlist.data.posts.some((x) => x.key === d.data.key));
    const pub = await api('/api/posts/' + encodeURIComponent(d.data.key) + '/publish', { method: 'POST', body: '{}' });
    assert('草稿发布成功', pub.status === 200 && pub.data.key);
    const del2 = await api('/api/posts/' + encodeURIComponent(pub.data.key) + '?scope=posts', { method: 'DELETE' });
    assert('清理发布后的文章', del2.status === 200);
  }

  // 站点配置
  const cfg = await api('/api/site-config');
  assert('读取站点配置', cfg.status === 200 && typeof cfg.data.config.title === 'string');
  const cfgPut = await api('/api/site-config', { method: 'PUT', body: JSON.stringify({ title: cfg.data.config.title }) });
  assert('写回站点配置（触发备份）', cfgPut.status === 200);

  // 配置文件读取
  const raw = await api('/api/config-file?file=' + encodeURIComponent('_config.yml'));
  assert('读取 _config.yml 原文', raw.status === 200 && raw.data.content.includes('title:'));

  // 配置文件白名单
  const badFile = await api('/api/config-file?file=..%2Fpackage.json');
  assert('越权文件被拒绝', badFile.status === 400);

  // 千言万语（essay.yml）
  const essay = await api('/api/essay');
  assert('读取千言万语', essay.status === 200 && typeof essay.data.content === 'string' && essay.data.content.includes('essay_list'));
  const essayPut = await api('/api/essay', { method: 'PUT', body: JSON.stringify({ content: essay.data.content }) });
  assert('写回千言万语（触发备份）', essayPut.status === 200);

  // 相册集（album.yml）
  const album = await api('/api/album');
  assert('读取相册集', album.status === 200 && typeof album.data.content === 'string' && album.data.content.includes('album_list'));
  const albumPut = await api('/api/album', { method: 'PUT', body: JSON.stringify({ content: album.data.content }) });
  assert('写回相册集（触发备份）', albumPut.status === 200);

  // 自我介绍（about.yml）
  const about = await api('/api/about');
  assert('读取自我介绍', about.status === 200 && typeof about.data.content === 'string' && about.data.content.includes('class_name'));
  const aboutPut = await api('/api/about', { method: 'PUT', body: JSON.stringify({ content: about.data.content }) });
  assert('写回自我介绍（触发备份）', aboutPut.status === 200);

  // 友链 / 装备 / 创意技能
  const dataFiles = [
    ['/api/link', 'link_list', '友链'],
    ['/api/equipment', 'equipment_list', '装备'],
    ['/api/creativity', 'creativity_list', '创意技能'],
  ];
  for (const [endpoint, marker, label] of dataFiles) {
    const g = await api(endpoint);
    assert(`读取${label}`, g.status === 200 && typeof g.data.content === 'string' && g.data.content.includes(marker));
    const p2 = await api(endpoint, { method: 'PUT', body: JSON.stringify({ content: g.data.content }) });
    assert(`写回${label}（触发备份）`, p2.status === 200);
  }

  // 媒体上传（1x1 透明 PNG）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'test-upload.png');
  const upRes = await fetch(BASE + '/api/media', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const up = await upRes.json();
  assert('图片上传成功', upRes.status === 200 && up.url && up.url.startsWith('/img/upload/'));
  if (up.url) {
    const mlist = await api('/api/media');
    assert('媒体列表包含新图', mlist.data.files.some((f) => '/img/upload/' + f.rel === up.url));
    const thumbRes = await fetch(BASE + '/admin/media/?path=' + encodeURIComponent(up.rel) + '&token=' + encodeURIComponent(token));
    const ct = thumbRes.headers.get('content-type');
    assert('鉴权缩略图可访问', thumbRes.status === 200 && ct === 'image/png');
    const delMedia = await api('/api/media/' + encodeURIComponent(up.rel), { method: 'DELETE' });
    assert('删除图片成功', delMedia.status === 200);
  }

  // ---- 图床（云相册）配置 ----
  const stGet = await api('/api/storage');
  assert('读取图床配置', stGet.status === 200 && stGet.data.storage && typeof stGet.data.storage.backend === 'string');

  const stPut = await api('/api/storage', {
    method: 'PUT',
    body: JSON.stringify({
      backend: 'oss',
      oss: { accessKeyId: 'test-ak', accessKeySecret: 'test-sk', bucket: 'xsxtk-test', endpoint: 'oss-cn-beijing.aliyuncs.com', dirPrefix: 'img/upload' },
    }),
  });
  assert('保存图床配置（切到 OSS）', stPut.status === 200 && stPut.data.storage.backend === 'oss' && stPut.data.storage.oss.bucket === 'xsxtk-test');

  const stBack = await api('/api/storage', { method: 'PUT', body: JSON.stringify({ backend: 'github', oss: stGet.data.storage.oss }) });
  assert('图床切回 GitHub 仓库', stBack.status === 200 && stBack.data.storage.backend === 'github');

  // Endpoint / 目录前缀容错归一化
  const stSloppy = await api('/api/storage', {
    method: 'PUT',
    body: JSON.stringify({ backend: 'github', oss: { accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'xsxtk', endpoint: 'https://xsxtk.oss-cn-beijing/', dirPrefix: '/img/', customDomain: 'https://img.example.com/' } }),
  });
  assert('Endpoint 自动补全/纠错', stSloppy.data.storage.oss.endpoint === 'oss-cn-beijing.aliyuncs.com', stSloppy.data.storage.oss.endpoint);
  assert('目录前缀去除首尾斜杠', stSloppy.data.storage.oss.dirPrefix === 'img', stSloppy.data.storage.oss.dirPrefix);
  assert('自定义域名去掉尾部斜杠', stSloppy.data.storage.oss.customDomain === 'https://img.example.com', stSloppy.data.storage.oss.customDomain);
  const stRestore = await api('/api/storage', { method: 'PUT', body: JSON.stringify({ backend: 'github', oss: stGet.data.storage.oss }) });
  assert('恢复原始图床配置', stRestore.status === 200 && stRestore.data.storage.oss.endpoint === stGet.data.storage.oss.endpoint);

  // ---- 统一上传入口 + 云相册 ----
  const fd2 = new FormData();
  fd2.append('file', new Blob([png], { type: 'image/png' }), 'gallery-test.png');
  const upRes2 = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd2 });
  const up2 = await upRes2.json();
  assert('统一上传接口写入仓库', upRes2.status === 200 && up2.backend === 'github' && Boolean(up2.rel));

  const gal = await api('/api/gallery');
  assert('云相册列出新图', gal.status === 200 && gal.data.backend === 'github' && gal.data.files.some((f) => f.rel === up2.rel));
  const galDel = await api('/api/gallery?key=' + encodeURIComponent(up2.rel), { method: 'DELETE' });
  assert('云相册删除图片', galDel.status === 200);
  const galAfter = await api('/api/gallery');
  assert('删除后不再出现在相册', galAfter.status === 200 && !galAfter.data.files.some((f) => f.rel === up2.rel));

  // ---- 图床模块单元测试（source/admin/storage.js） ----
  const StorageMod = require('../source/admin/storage.js');
  const cryptoMod = require('crypto');
  const httpMod = require('http');

  const hmacVec = await StorageMod.hmacSha1Base64('key', 'The quick brown fox jumps over the lazy dog');
  assert('HMAC-SHA1 签名向量（RFC 2202）', hmacVec === '3nybhbi3iqa8ino29wqQcBydtNk=', hmacVec);

  const fnInfo = StorageMod.buildFileName('我的 照片.PNG');
  assert('上传文件名规范化', /^\d{8}-[0-9a-f]{8}-.+\.png$/.test(fnInfo.name), fnInfo.name);
  assert('目录拼接去掉多余斜杠', StorageMod.joinPrefix('/img/upload/', '/202601/x.png') === 'img/upload/202601/x.png', StorageMod.joinPrefix('/img/upload/', '/202601/x.png'));
  assert('URL 提取（自定义正则）', StorageMod.extractUrl('{"data":{"url":"https://cdn.x.com/a.png"}}', '"url"\\s*:\\s*"(.*?)"') === 'https://cdn.x.com/a.png');
  assert('URL 提取（默认第一个链接）', StorageMod.extractUrl('{"link":"https://cdn.x.com/b.jpg"}') === 'https://cdn.x.com/b.jpg');

  // Endpoint 归一化（常见错误写法）
  const ep = StorageMod.normalizeEndpoint;
  assert('Endpoint：只填 region 自动补全', ep('oss-cn-beijing', 'xsxtk') === 'oss-cn-beijing.aliyuncs.com', ep('oss-cn-beijing', 'xsxtk'));
  assert('Endpoint：带协议和斜杠被清理', ep('https://oss-cn-hangzhou.aliyuncs.com/', 'b') === 'oss-cn-hangzhou.aliyuncs.com', ep('https://oss-cn-hangzhou.aliyuncs.com/', 'b'));
  assert('Endpoint：误带 Bucket 前缀被去掉', ep('xsxtk.oss-cn-beijing.aliyuncs.com', 'xsxtk') === 'oss-cn-beijing.aliyuncs.com', ep('xsxtk.oss-cn-beijing.aliyuncs.com', 'xsxtk'));
  assert('Endpoint：完整域名原样保留', ep('oss-cn-beijing.aliyuncs.com', 'xsxtk') === 'oss-cn-beijing.aliyuncs.com');
  assert('Endpoint：空值返回空串', ep('', 'xsxtk') === '');

  // 自定义图床：上传到本地 mock 服务
  const mock = httpMod.createServer((req, res) => {
    let len = 0;
    req.on('data', (c) => { len += c.length; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { url: `https://cdn.mock.local/${len}.png` } }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  try {
    const customOut = await StorageMod.upload(
      { backend: 'custom', custom: { uploadUrl: `http://127.0.0.1:${mockPort}/upload`, fieldName: 'file', headers: [{ name: 'X-Test', value: '1' }], urlRegex: '' } },
      { filename: 'mock.png', contentType: 'image/png', bytes: png }
    );
    assert('自定义图床上传并解析地址', /^https:\/\/cdn\.mock\.local\/\d+\.png$/.test(customOut.url), customOut.url);
  } finally {
    mock.close();
  }

  // OSS 直传：拦截 fetch 校验 V1 签名
  const realFetch = global.fetch;
  let captured = null;
  let reqs = [];
  global.fetch = async (url, opts) => { captured = { url, opts }; reqs.push(captured); return { ok: true, status: 200, text: async () => '' }; };
  try {
    const ossCfg = { accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'bkt', endpoint: 'oss-cn-beijing.aliyuncs.com', dirPrefix: 'img/upload', customDomain: '' };
    const ossOut = await StorageMod.upload({ backend: 'oss', oss: ossCfg }, { filename: 'a.png', contentType: 'image/png', bytes: png });
    const date = captured.opts.headers['x-oss-date'];
    const expect = 'OSS ak:' + cryptoMod.createHmac('sha1', 'sk').update(`PUT\n\nimage/png\n${date}\nx-oss-date:${date}\n/bkt/${ossOut.key}`).digest('base64');
    assert('OSS 直传签名（V1，x-oss-date）正确', captured.opts.headers.Authorization === expect, captured.opts.headers.Authorization);
    assert('不再使用浏览器禁止的 Date 请求头', captured.opts.headers.Date === undefined && /^\w{3}, \d{2} \w{3} \d{4} [\d:]{8} GMT$/.test(date), String(date));
    assert('OSS 直传地址正确', captured.url === `https://bkt.oss-cn-beijing.aliyuncs.com/${ossOut.key}`, captured.url);
    assert('OSS 公共访问地址正确', ossOut.url === `https://bkt.oss-cn-beijing.aliyuncs.com/${ossOut.key}`, ossOut.url);
    assert('OSS 自定义域名优先生效', StorageMod.ossPublicUrl({ bucket: 'bkt', endpoint: 'oss-cn-beijing.aliyuncs.com', customDomain: 'https://img.example.com/' }, 'a/b.png') === 'https://img.example.com/a/b.png');

    // 签名变体自动重试：首次 SignatureDoesNotMatch → 第二次改用不计入 x-oss-date 的算法
    reqs = [];
    global.fetch = async (url, opts) => {
      reqs.push({ url, opts });
      return reqs.length === 1
        ? { ok: false, status: 403, text: async () => '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code></Error>' }
        : { ok: true, status: 200, text: async () => '' };
    };
    const fbOut = await StorageMod.upload({ backend: 'oss', oss: ossCfg }, { filename: 'b.png', contentType: 'image/png', bytes: png });
    assert('签名不匹配时自动重试一次', reqs.length === 2, reqs.length);
    const d2 = reqs[1].opts.headers['x-oss-date'];
    const expect2 = 'OSS ak:' + cryptoMod.createHmac('sha1', 'sk').update(`PUT\n\nimage/png\n${d2}\n/bkt/${fbOut.key}`).digest('base64');
    assert('重试改用不计入 x-oss-date 的签名', reqs[1].opts.headers.Authorization === expect2, reqs[1].opts.headers.Authorization);

    // 签名正确但服务端 403（如权限不足）时不应无限重试
    reqs = [];
    global.fetch = async (url, opts) => {
      reqs.push({ url, opts });
      return { ok: false, status: 403, text: async () => '<Error><Code>AccessDenied</Code></Error>' };
    };
    let denied = '';
    try {
      await StorageMod.upload({ backend: 'oss', oss: ossCfg }, { filename: 'c.png', contentType: 'image/png', bytes: png });
    } catch (e) {
      denied = e.message;
    }
    assert('AccessDenied 立即报错且不重试', reqs.length === 1 && /AccessDenied/.test(denied), `${reqs.length} / ${denied}`);
  } finally {
    global.fetch = realFetch;
  }

  // 回归防护：云端模式删除图片时只能取 sha，不能对图片二进制做文本解码
  // （否则 JSON→atob→decodeURIComponent(escape()) 会抛「URI malformed」，删除静默失败）
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'source', 'admin', 'app.js'), 'utf8');
  assert('云端媒体删除走 ghFileMeta（不解码二进制）', /const \{ sha \} = await ghFileMeta\(filePath\);/.test(appSrc));
  assert('b64decode 对二进制内容容错', /function b64decode[\s\S]{0,240}?return bin;/.test(appSrc));

  const pw = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ old: 'admin123', new: 'admin123' }) });
  assert('修改密码接口可用', pw.status === 200);

  // 构建状态
  const st = await api('/api/build/status');
  assert('构建状态接口', st.status === 200 && ('running' in st.data));

  console.log(`\n== 结果：通过 ${passed} 项，失败 ${failed} 项 ==\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试执行出错：', e);
  process.exit(1);
});
