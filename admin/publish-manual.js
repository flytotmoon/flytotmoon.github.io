#!/usr/bin/env node
/**
 * 手动发布：把 public/ 的构建产物以「孤立提交」推到 Pages 分支（默认 master）
 *
 * 用途：GitHub Actions 抽风 / 账号额度或账单问题 / 工作流失败时，作为兜底一条命令完成发布。
 * 与 workflows/auto-deploy.yml 里的 peaceiris/actions-gh-pages 行为一致：
 *   - 全量覆盖目标分支（force push，孤儿提交）
 *   - 自动补 .nojekyll（否则 Pages 会用 Jekyll 处理产物）
 *
 * 注意：本文件放在 admin/ 而不是 scripts/，因为 Hexo 会把项目根目录的 scripts/
 * 当作插件目录自动 require，CLI 脚本放在那里会报 "Script load failed"。
 *
 * 用法：
 *   npm run publish:manual                 # 构建并发布
 *   npm run publish:manual -- --dry-run    # 只构建 + 打印将要发布的信息，不推送
 *   npm run publish:manual -- --skip-build # 直接用现有 public/ 发布
 *   npm run publish:manual -- --branch gh-pages   # 指定目标分支
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'public');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY_RUN = has('--dry-run');
const SKIP_BUILD = has('--skip-build');
const BRANCH = valueOf('--branch', 'master');

function git(args, opts = {}) {
  const out = execFileSync('git', ['-C', ROOT, ...args], {
    stdio: opts.stdio || ['ignore', 'pipe', 'inherit'],
    env: opts.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  // stdio 为 inherit 时 execFileSync 返回 null
  return out ? out.toString('utf8') : '';
}

function runBuild() {
  console.log('▸ 构建站点：hexo clean && hexo generate');
  const cli = path.join(ROOT, 'node_modules', 'hexo-cli', 'bin', 'hexo');
  execFileSync(process.execPath, [cli, 'clean'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [cli, 'generate'], { cwd: ROOT, stdio: 'inherit' });
}

function main() {
  if (!SKIP_BUILD) runBuild();

  if (!fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
    console.error('✗ public/index.html 不存在，构建似乎没有成功');
    process.exit(1);
  }

  // Pages 需要 .nojekyll，否则会走 Jekyll 处理（可能丢掉下划线开头的目录）
  const nojekyll = path.join(BUILD_DIR, '.nojekyll');
  if (!fs.existsSync(nojekyll)) fs.writeFileSync(nojekyll, '');

  // 用临时索引把 public/ 作为仓库根目录打包成 tree
  const indexFile = path.join(os.tmpdir(), `ftm-publish-${Date.now()}.idx`);
  const env = Object.assign({}, process.env, {
    GIT_INDEX_FILE: indexFile,
    GIT_WORK_TREE: BUILD_DIR,
  });

  let commit = '';
  try {
    git(['add', '-A', '-f'], { env });
    const tree = git(['write-tree'], { env }).trim();
    const message = `manual deploy: local build ${new Date().toISOString()}`;
    commit = git(['commit-tree', tree, '-m', message], { env }).trim();
    console.log(`▸ 产物已打包：tree ${tree.slice(0, 8)}，commit ${commit.slice(0, 8)}`);
  } finally {
    fs.rmSync(indexFile, { force: true });
  }

  if (DRY_RUN) {
    console.log(`▸ --dry-run：不推送。正式发布会执行 git push origin ${commit.slice(0, 8)}:refs/heads/${BRANCH} --force`);
    return;
  }

  console.log(`▸ 推送到 origin/${BRANCH}（force）`);
  execFileSync('git', ['-C', ROOT, 'push', 'origin', `${commit}:refs/heads/${BRANCH}`, '--force'], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('✓ 已发布。GitHub Pages 通常 1~2 分钟后生效（缓存最多 10 分钟）。');
  console.log('  提示：下次 Actions 成功时会自动覆盖本次发布的结果。');
}

main();
