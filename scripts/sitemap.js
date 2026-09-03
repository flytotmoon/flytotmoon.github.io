'use strict';
/* ============================================================
   flytotmoon 博客 —— sitemap 生成脚本（零依赖）
   生成：
     - sitemap.xml        站点地图（文章/页面/分类/标签/归档）
     - sitemap_urls.txt   纯 URL 列表（用于百度主动推送）
   ============================================================ */

/** 转义 XML 特殊字符 */
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmtDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (!date || isNaN(date.getTime())) return '';
  return date.toISOString();
}

/** 去掉 index.html 后缀，得到目录形式 URL */
function normalizeLoc(p) {
  return String(p || '').replace(/index\.html$/, '');
}

hexo.extend.generator.register('sitemap', function (locals) {
  const config = hexo.config;
  const base = (config.url || '').replace(/\/+$/, '');
  if (!base) {
    hexo.log.warn('sitemap：未配置站点 url，已跳过生成');
    return { path: 'sitemap.xml', data: '' };
  }

  const urls = [];
  const add = (loc, lastmod, changefreq, priority) => {
    urls.push({
      loc: base + normalizeLoc(loc),
      lastmod: lastmod ? fmtDate(lastmod) : '',
      changefreq: changefreq || '',
      priority: priority || '',
    });
  };

  add('/', null, 'daily', '1.0');

  // 文章（排除草稿）
  if (locals.posts) {
    locals.posts.sort('-date').forEach((post) => {
      add(post.path, post.updated || post.date, 'weekly', '0.8');
    });
  }

  // 页面（about / album / essay / link / equipment 等）
  if (locals.pages) {
    locals.pages.forEach((page) => {
      add(page.path, page.updated || page.date, 'monthly', '0.6');
    });
  }

  // 分类 / 标签 索引页
  if (locals.categories) {
    locals.categories.forEach((cat) => add(cat.path, null, 'weekly', '0.5'));
  }
  if (locals.tags) {
    locals.tags.forEach((tag) => add(tag.path, null, 'weekly', '0.5'));
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => {
      let s = '  <url><loc>' + esc(u.loc) + '</loc>';
      if (u.lastmod) s += '<lastmod>' + u.lastmod + '</lastmod>';
      if (u.changefreq) s += '<changefreq>' + u.changefreq + '</changefreq>';
      if (u.priority) s += '<priority>' + u.priority + '</priority>';
      return s + '</url>';
    }),
    '</urlset>',
  ].join('\n');

  const txt = urls.map((u) => u.loc).join('\n') + '\n';

  return [
    { path: 'sitemap.xml', data: xml },
    { path: 'sitemap_urls.txt', data: txt },
  ];
});
