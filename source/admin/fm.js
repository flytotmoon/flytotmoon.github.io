/* ============================================================
   flytotmoon 博客后台 —— Front-matter / Markdown 工具（纯函数）
   浏览器与 Node 端共用：浏览器挂载到 window.FM，Node 通过 require 使用。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 文件名安全化（去除 Windows/Linux 非法字符） */
  function sanitizeName(name) {
    let s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (s === '.' || s === '..' || s === '') s = 'untitled';
    return s.slice(0, 120);
  }

  /** 统计字数：剔除代码块与 Markdown 语法后，按中文 / 英文单词混合统计 */
  function countWords(md) {
    const noCode = String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    const text = noCode
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_~>#|-]/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const words = (text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    return cjk + words;
  }

  /** 简单 Markdown 摘要 */
  function makeExcerpt(md, len = 120) {
    const text = String(md || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#>*`~_-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > len ? text.slice(0, len) + '…' : text;
  }

  /**
   * 解析 YAML 子集的 Front-matter。
   * 返回 { data: 有序条目数组, body: 正文, raw }；条目形如
   *   { key, type: 'scalar'|'list'|'object'|'block', value, children? }
   */
  function parseFrontMatter(content) {
    const result = { data: [], body: content, raw: null };
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(content));
    if (!m) return result;
    result.raw = m[1];
    // 剥离 --- 之后紧邻的空行，保证读写往返幂等（写回时统一补一个标准空行）
    result.body = String(content).slice(m[0].length).replace(/^[\r\n]+/, '');

    const lines = m[1].split(/\r?\n/);
    const rootEntry = { key: null, type: 'object', children: result.data };
    const stack = [{ indent: -1, entry: rootEntry }];

    // 块标量（| 或 >）状态
    let block = null; // { key, baseIndent, lines, indent }

    const flushBlock = () => {
      if (!block) return;
      const top = stack[stack.length - 1].entry;
      top.children.push({ key: block.key, type: 'block', value: block.lines.join('\n') });
      block = null;
    };

    const parseScalar = (raw) => {
      let v = raw.trim();
      if (v === '' || v === '~' || v === 'null') return null;
      if (v === 'true' || v === 'false') return v === 'true';
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
      if (/^"(.*)"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
      if (/^'(.*)'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
      return v;
    };

    for (const rawLine of lines) {
      /* 块标量模式 */
      if (block) {
        const ind = rawLine.match(/^[ \t]*/)[0].length;
        if (/^\s*$/.test(rawLine)) {
          block.lines.push('');
          continue;
        }
        if (ind > block.baseIndent) {
          if (block.indent === null) block.indent = ind;
          block.lines.push(rawLine.slice(block.indent));
          continue;
        }
        flushBlock();
        // 落入普通行处理
      }

      const line = rawLine.replace(/\t/g, '  ');
      if (/^\s*(#|$)/.test(line)) continue;
      const ind = line.match(/^\s*/)[0].length;
      const rest = line.slice(ind);

      /* 列表项 */
      if (/^-\s+/.test(rest)) {
        const item = parseScalar(rest.replace(/^-\s+/, ''));
        while (stack.length > 1 && stack[stack.length - 1].indent > ind) stack.pop();
        let top = stack[stack.length - 1];
        if (top.entry.type !== 'list') {
          const listEntry = { key: null, type: 'list', value: [] };
          top.entry.children.push(listEntry);
          stack.push({ indent: ind, entry: listEntry });
          top = stack[stack.length - 1];
        }
        top.entry.value.push(item);
        continue;
      }

      /* 键值对 */
      const kv = /^([A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff-]*)\s*:(.*)$/.exec(rest);
      if (!kv) continue;
      const key = kv[1];
      const valueRaw = kv[2].trim();

      while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
      let parent = stack[stack.length - 1].entry;
      if (parent.type !== 'object') {
        // 理论上不会发生：兜底转换为 object
        parent.children = [];
        parent.type = 'object';
      }

      if (valueRaw === '|' || valueRaw === '>') {
        block = { key, baseIndent: ind, indent: null, lines: [] };
        continue;
      }

      if (valueRaw === '') {
        // 空值：可能是列表或嵌套对象，由后续行决定类型
        const entry = { key, type: 'list', value: [] };
        parent.children.push(entry);
        stack.push({ indent: ind, entry });
        continue;
      }

      parent.children.push({ key, type: 'scalar', value: parseScalar(valueRaw) });
    }
    flushBlock();
    return result;
  }

  /** 把标量序列化为 YAML 字符串 */
  function serializeScalar(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    const s = String(v);
    if (s === '') return "''";
    const needsQuote =
      /^[\s#\-:>|&*!%@`"'{[\]},]/.test(s) ||
      /:\s/.test(s) ||
      /#/.test(s) ||
      /\s$/.test(s) ||
      /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) ||
      s.includes('\n');
    if (needsQuote) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    return s;
  }

  function serializeEntry(entry, indent = 0) {
    const pad = ' '.repeat(indent);
    if (entry.type === 'list') {
      const items = (entry.value || []).map((v) => `${pad}  - ${serializeScalar(v)}`);
      return `${pad}${entry.key}:\n${items.join('\n')}`;
    }
    if (entry.type === 'object') {
      const inner = (entry.children || []).map((c) => serializeEntry(c, indent + 2)).filter(Boolean);
      return `${pad}${entry.key}:\n${inner.join('\n')}`;
    }
    if (entry.type === 'block') {
      const lines = String(entry.value || '').split('\n').map((l) => `${pad}  ${l}`);
      return `${pad}${entry.key}: |\n${lines.join('\n')}`;
    }
    return `${pad}${entry.key}: ${serializeScalar(entry.value)}`;
  }

  function buildFrontMatter(data, body) {
    const lines = data.filter((e) => e && e.key).map((e) => serializeEntry(e)).filter(Boolean);
    return `---\n${lines.join('\n')}\n---\n\n${body || ''}`;
  }

  function fmGet(data, key) {
    const entry = data.find((e) => e && e.key === key);
    if (!entry) return undefined;
    if (entry.type === 'scalar' || entry.type === 'block') return entry.value;
    if (entry.type === 'list') return entry.value;
    if (entry.type === 'object') {
      const obj = {};
      for (const c of entry.children || []) if (c && c.key) obj[c.key] = c.value;
      return obj;
    }
    return undefined;
  }

  function fmSet(data, key, value, type) {
    const idx = data.findIndex((e) => e && e.key === key);
    const entry = { key, type: type || 'scalar', value };
    if (idx !== -1) data[idx] = entry;
    else data.push(entry);
  }

  /** 将编辑器表单字段应用到 front-matter（保持常用键顺序） */
  function applyMeta(data, meta) {
    if (meta && typeof meta === 'object') {
      if (typeof meta.title === 'string') fmSet(data, 'title', meta.title.trim());
      if (meta.date) fmSet(data, 'date', String(meta.date).trim());
      if (meta.updated !== undefined) {
        if (meta.updated) fmSet(data, 'updated', String(meta.updated).trim());
        else {
          const i = data.findIndex((e) => e && e.key === 'updated');
          if (i !== -1) data.splice(i, 1);
        }
      }
      if (Array.isArray(meta.tags)) fmSet(data, 'tags', meta.tags.map((t) => String(t).trim()).filter(Boolean), 'list');
      if (Array.isArray(meta.categories)) fmSet(data, 'categories', meta.categories.map((t) => String(t).trim()).filter(Boolean), 'list');
      if (meta.cover !== undefined) fmSet(data, 'cover', String(meta.cover || '').trim());
      if (meta.description !== undefined) fmSet(data, 'description', String(meta.description || '').trim());
      if (meta.sticky !== undefined) {
        if (Number(meta.sticky) > 0) fmSet(data, 'sticky', Number(meta.sticky) || 1);
        else {
          const i = data.findIndex((e) => e && e.key === 'sticky');
          if (i !== -1) data.splice(i, 1);
        }
      }
      if (meta.mathjax !== undefined) {
        if (meta.mathjax) fmSet(data, 'mathjax', true);
        else {
          const i = data.findIndex((e) => e && e.key === 'mathjax');
          if (i !== -1) data.splice(i, 1);
        }
      }
      if (meta.comments !== undefined) {
        if (meta.comments) {
          const i = data.findIndex((e) => e && e.key === 'comments');
          if (i !== -1) data.splice(i, 1);
        } else fmSet(data, 'comments', false);
      }
      if (meta.top_img !== undefined) {
        if (meta.top_img) fmSet(data, 'top_img', String(meta.top_img).trim());
        else {
          const i = data.findIndex((e) => e && e.key === 'top_img');
          if (i !== -1) data.splice(i, 1);
        }
      }
    }
    // 保持常用键顺序：title/date/updated/tags/categories/cover/description/sticky/mathjax/comments/top_img/其他
    const order = ['title', 'date', 'updated', 'tags', 'categories', 'cover', 'description', 'sticky', 'mathjax', 'comments', 'top_img'];
    data.sort((a, b) => {
      const ia = order.indexOf(a.key);
      const ib = order.indexOf(b.key);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return data;
  }

  return {
    sanitizeName,
    countWords,
    makeExcerpt,
    parseFrontMatter,
    serializeScalar,
    serializeEntry,
    buildFrontMatter,
    fmGet,
    fmSet,
    applyMeta,
  };
});
