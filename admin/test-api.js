'use strict';
/* ============================================================
   flytotmoon 后台 API 自测脚本
   用法：先启动后台（node admin/server.js），再执行
       node admin/test-api.js
   ============================================================ */

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:4321';
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
    assert('无缩进列表解析正确（分类）', p.categories.join('/') === '哲学/杂文', JSON.stringify(p.categories));
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
      assert('往返后分类保持', re.data.post.categories.join('/') === '哲学/杂文');
      assert('往返后标签保持', re.data.post.tags.join('/') === '哲学/马克思主义');
      assert('往返后正文保持', re.data.post.body === p.body);
    }
  }

  // 创建 / 改名 / 删除
  const created = await api('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      title: '后台测试文章', content: '## 测试\n\n这是后台创建的测试内容。', date: '2026-08-26 12:00:00',
      categories: ['杂文'], tags: ['测试'], cover: 'https://example.com/x.jpg', sticky: 0, mathjax: false, comments: true,
    }),
  });
  assert('创建文章成功', created.status === 200 && created.data.key);
  const cKey = created.data.key;
  if (cKey) {
    const got = await api('/api/posts/' + encodeURIComponent(cKey));
    assert('新文章分类正确', got.data.post.categories.join(',') === '杂文');
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

  // 修改密码（改回默认，避免影响后续）
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
