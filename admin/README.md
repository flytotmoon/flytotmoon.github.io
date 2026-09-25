# flytotmoon 博客后台管理系统

一个博客后台管理系统，支持两种使用方式：

- **本机模式**：零第三方依赖的 Node 服务（仅内置模块），本地管理文件
- **GitHub 云端模式（在线后台）**：后台页面随博客发布到 `/admin/`，通过 GitHub 仓库 API
  在线管理文章、上传图片，并触发 GitHub Actions 自动构建部署 —— 无需服务器

## 功能

| 模块 | 本机模式 | GitHub 云端 |
| --- | --- | --- |
| 登录认证 | 用户名 + scrypt 口令（限流防护） | GitHub 访问令牌（仅存浏览器本地） |
| 仪表盘 | ✓ | ✓ |
| 文章管理 | 新建 / 编辑 / 删除入回收站 | 新建 / 编辑 / 删除（Git 历史可找回） |
| 草稿箱 | ✓ 一键发布 | ✓ 一键发布 |
| Markdown 编辑器 | Typora 风格：源码 / 双栏 / 预览三种模式、大纲侧栏、状态栏、Tab 缩进、回车续写列表 | 同左 |
| 媒体库 | 上传到 `source/img/upload/` | 上传到 GitHub 仓库同路径 |
| 云图库（PicGo 风格） | 拖拽 / 点击 / Ctrl+V 粘贴上传，可切换图床并浏览云端相册 | 同左（浏览器直传 OSS / 自定义接口） |
| 站点设置 | 表单 + 原始配置编辑（自动备份） | 同左（Git 历史即备份） |
| 构建发布 | hexo clean/generate/deploy + SSE 实时日志 | 触发 GitHub Actions + 状态轮询 |

### 编辑器（Typora 风格）

文章编辑页按 Typora 的写作体验重做：

- **三种写作模式**（记忆上次选择）：`源码`（只留 Markdown 源码，居中单栏）、`双栏`（源码 + 实时预览）、`预览`（整洁排版的阅读/校对模式）
- **大纲侧栏**：自动列出各级标题（会跳过代码块里的 `#`），点击即可跳到源码对应行并滚动预览
- **状态栏**：字数 / 字符 / 行数 / 光标行列 + 「已保存 / 未保存」状态；右下角可折叠「文章属性」「大纲」
- **Typora 式排版**：标题带下边框、引用左侧细线、行内代码粉底、代码块带语言标签与复制按钮、表格斑马纹、图片居中带阴影、任务列表复选框
- **写作习惯**：`Tab` / `Shift+Tab` 缩进整段、回车自动续写 `-` / `1.` / `>` / `- [ ]`（空条目回车即退出列表）、`Ctrl+B` 加粗、`Ctrl+I` 斜体、`Ctrl+K` 链接、`Ctrl+E` 行内代码、`Ctrl+S` 保存

### 云图库（PicGo 风格的在线图床）

「媒体库」页面已升级为 PicGo 风格的**云图库**：

- **三种图床**随时切换：
  - `GitHub 仓库` —— 图片提交到 `source/img/upload/`，随站点一起发布，无需任何配置；
  - `阿里云 OSS` —— 填 AccessKey ID / Secret / Bucket / Endpoint（如 `xsxtk` + `oss-cn-beijing.aliyuncs.com`），支持自定义域名 / CDN；
  - `自定义接口` —— 任意 multipart 上传接口（Chevereto、EasyImages、自建服务），用正则从响应里提取图片地址。
- **多种上传方式**：拖拽到上传区、点击选择文件、直接 `Ctrl+V` 粘贴剪贴板截图，支持多选与进度条。
- **上传后自动复制 Markdown**（可关闭），复制内容形如 `![名字](地址)`，粘贴到文章即可。
- **云相册**：列出当前图床的图片（OSS 走 ListObjects，**自动翻页读取目录下的全部图片**，默认最多 2000 张，可按文件名搜索、分批渲染「显示更多」），支持悬停复制 Markdown / 复制链接 / 预览 / 删除。
  - 读取范围由「存储目录前缀」决定：填 `img` 即读取 `img/` 下所有图片（上传也放到 `img/` 下）；留空读取整个 Bucket。
  - 「上传时按月建子目录」可关闭，让新图与已有的 `img/xxx.jpg` 保持同一层。
- **最近上传记录**：保存在本浏览器，自定义图床无法远程列举时也能找回地址。
- **一键测试上传**：图床设置面板中点击「测试上传」，会用一张 1×1 测试图验证配置是否可用。

> ⚠️ 云端模式下浏览器直传 OSS 需要先给 Bucket 配置跨域规则（CORS）：来源填站点域名、
> 允许方法 `PUT, POST, GET, HEAD`、允许 Headers `*`。本机模式由后台服务代签名上传，无需 CORS。
> AccessKey 只保存在本机 `admin/config.json`（本机模式）或浏览器 localStorage（云端模式），不会写进仓库。

---

## 一、本机模式

```bash
# 在博客根目录启动后台
npm run admin
# 或
node admin/server.js
```

浏览器打开 <http://127.0.0.1:4321/> 即可（登录页选择「🖥️ 本机服务」）。

> **首次启动**会自动生成 `admin/config.json` 并创建默认账号：
> 用户名 `admin`，密码 `admin123`。
> ⚠️ 登录后请立刻在「站点设置 → 修改密码」中更换密码。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run admin` | 启动后台 |
| `npm run admin:dev` | 调试模式（打印请求日志） |
| `npm run admin:reset-password -- 新密码` | 重置密码（需先停止服务） |
| `node admin/server.js --help` | 帮助信息 |
| `node admin/test-api.js` | API 自测脚本（先启动服务） |

> 忘记密码时，也可以直接删除 `admin/config.json` 后重启（重置为默认密码）。

### 本机模式配置

`admin/config.json`（自动生成，已加入 .gitignore，**不要提交到仓库**）：

```json
{
  "host": "127.0.0.1",   // 默认仅本机可访问
  "port": 4321,          // 端口，可修改
  "username": "admin",
  "salt": "…",           // 口令加盐（自动生成）
  "passwordHash": "…",   // scrypt 口令哈希
  "tokenSecret": "…",    // 会话签名密钥（自动生成）
  "sessionTtlDays": 7    // 登录有效期
}
```

---

## 二、GitHub 云端模式（在线后台）

后台前端位于 `source/admin/`，`hexo generate` 时会原样发布到博客的 **/admin/** 路径。
访问 <https://blog.flytotmoon.cn/admin/>，选择「☁️ GitHub 云端」，填入 GitHub 访问令牌即可在线管理。

### 一次性初始化步骤

1. **把博客源码推送到 GitHub 仓库的分支**（例如 `source` 分支；`master` 留给构建产物）：

   ```bash
   # Windows PowerShell（本机 themes/anzhiyu 是独立 git 仓库，需先去掉嵌套 .git 才能整体提交）
   Remove-Item themes\anzhiyu\.git -Recurse -Force

   git init
   git add .
   git commit -m "init blog"
   git branch -M source
   git remote add origin git@github.com:flytotmoon/flytotmoon.github.io.git
   git push -u origin source
   ```

   > `master` 分支为 Pages 分支（flytotmoon.github.io 默认分支），由 Actions 自动覆盖，
   > **不要**把源码推到 master，也不要手动编辑 master。
   >
   > 主题已改为随源码提交（vendoring）。若日后想更新主题，重新从
   > [anzhiyu-c/hexo-theme-anzhiyu](https://github.com/anzhiyu-c/hexo-theme-anzhiyu) 下载覆盖即可；
   > 若主题没有随源码提交成功，工作流会自动从官方仓库克隆主题作为兜底。

2. **创建 GitHub 访问令牌（PAT）**：
   GitHub → Settings → Developer settings → Personal access tokens：
   - Fine-grained token：仓库权限勾选 **Contents: Read and write** 与 **Workflows: Read and write**
   - 或 Classic token：勾选 **repo** 与 **workflow** 权限

3. **打开在线后台**：<https://blog.flytotmoon.cn/admin/> → 「GitHub 云端」→ 填入：
   - 访问令牌：刚创建的 PAT
   - 仓库 Owner / 仓库名：`flytotmoon` / `flytotmoon.github.io`
   - 源码分支：`source`（第 1 步推送的分支）
   - 源码目录：`source`（source/ 目录所在层级，一般不用改）

   点「🔌 连接测试」确认三项检查通过（账号 / 文章目录 / 自动构建工作流），然后「进入后台」。

### 博客导航栏入口按钮

博客导航栏**右上角**已加入一个齿轮图标「管理后台」入口按钮（由 `source/js/custom.js` 注入，无需修改主题）：

- **线上博客**：点击后新标签打开 `/admin/`（GitHub 云端后台登录页）
- **本地预览**（localhost/127.0.0.1）：自动指向 `http://127.0.0.1:4321/`（本机后台服务）

> 提示：线上 `/admin/` 页面由构建产物提供，在完成上面的源码推送与首次 Actions 构建后即可访问。

### 在线构建如何工作

`.github/workflows/auto-deploy.yml` 已在源码中：当 `source` 分支有推送，或在线后台点击
「构建并部署」时触发，自动执行 `npm ci → hexo generate → 推送 public 到 master`，
博客在 2~5 分钟内更新。构建状态在后台「构建发布」页自动轮询显示。

### 注意事项

- **令牌只保存在你自己的浏览器 localStorage 中**，不会上传到任何第三方服务器；请勿在公共电脑使用
- 本机 `hexo deploy` 与 Actions 都会向 master 推送构建产物，两者选其一即可，避免交替使用
- 主题目录 `themes/anzhiyu` 本地是独立 git 仓库，推送源码前请按上文先移除其嵌套 `.git`
  （工作流内置了「主题缺失时自动克隆官方主题」的兜底，构建不会因主题缺失而失败）

---

## 目录结构

```
admin/
├── server.js          # 本机模式后端服务（零依赖，单文件）
├── config.json        # 本机模式配置与凭据（自动生成，勿提交）
├── test-api.js        # 本机模式 API 自测脚本
├── backups/           # 本机模式：配置/文章改动的自动备份
└── trash/             # 本机模式：删除文章的回收站

source/admin/          # 后台前端（本机与 GitHub 云端共用，随博客发布到 /admin/）
├── index.html
├── app.js
├── style.css
├── storage.js         # 图床模块：OSS 直传签名 / 自定义接口 / 云相册列表（Node 与浏览器共用）
└── fm.js              # Front-matter 解析（Node 服务端与浏览器共用）

.github/workflows/
└── auto-deploy.yml    # GitHub Actions 自动构建部署（云端模式在线构建）
```

上传的图片保存在 `source/img/upload/`，构建后自动发布到 `/img/upload/`，可直接引用。

## 安全说明

- 本机模式默认只监听 `127.0.0.1`；令牌 HMAC 签名、登录限流、路径校验防目录穿越
- GitHub 云端模式：令牌仅存浏览器本地，页面公开但无令牌无法做任何操作；
  令牌泄露等同于仓库写权限，请使用 fine-grained token 并定期更换
