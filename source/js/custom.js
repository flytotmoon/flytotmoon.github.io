/* ============================================================
   flytotmoon 博客自定义脚本（AnZhiYu 主题增强）
   通过主题 inject 在 </body> 前引入；兼容 pjax 页面切换。
   ============================================================ */
(function () {
  "use strict";

  /* 移动端给正文中的宽表格加横向滚动容器 */
  function wrapTables() {
    var container = document.getElementById("article-container");
    if (!container) return;
    var tables = container.querySelectorAll(".post-content table, .post-content .table-wrap");
    tables.forEach(function (table) {
      if (table.closest(".custom-table-scroll")) return;
      if (window.innerWidth > 768) return;
      var wrapper = document.createElement("div");
      wrapper.className = "custom-table-scroll";
      wrapper.style.cssText =
        "overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:10px;margin:1rem 0;";
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  /* 给正文图片补充失败兜底（主题 error_img 之外的本地兜底） */
  function bindImageFallback() {
    var container = document.getElementById("article-container");
    if (!container) return;
    container.querySelectorAll("img").forEach(function (img) {
      if (img.dataset.fallbackBound) return;
      img.dataset.fallbackBound = "1";
      img.addEventListener(
        "error",
        function handler() {
          if (img.dataset.fallbackDone) return;
          img.dataset.fallbackDone = "1";
          // 仅替换一次，避免递归
          img.removeEventListener("error", handler);
          var src = img.getAttribute("src");
          if (!src || src.indexOf("/img/404.jpg") !== -1) return;
          img.style.display = "none";
        },
        { once: true }
      );
    });
  }

  /* 外链（非本站、非锚点）统一新窗口打开并加 rel，避免 pjax 拦截 */
  function bindExternalLinks() {
    var host = location.hostname;
    document.querySelectorAll("a[href^='http']").forEach(function (a) {
      if (a.dataset.externalBound) return;
      a.dataset.externalBound = "1";
      try {
        var url = new URL(a.href, location.href);
        if (url.hostname && url.hostname !== host) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        }
      } catch (e) {
        /* ignore invalid urls */
      }
    });
  }

  /* 平滑滚动到锚点（抵消顶部导航高度） */
  function bindAnchorSmooth() {
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      if (a.dataset.anchorBound) return;
      a.dataset.anchorBound = "1";
      a.addEventListener("click", function (e) {
        var href = a.getAttribute("href");
        if (!href || href.length < 2) return;
        var target = null;
        try {
          target = document.querySelector(decodeURIComponent(href));
        } catch (err) {
          return;
        }
        if (!target) return;
        e.preventDefault();
        var top = target.getBoundingClientRect().top + window.pageYOffset - 72;
        window.scrollTo({ top: top, behavior: "smooth" });
      });
    });
  }

  /* 导航栏右上角「管理后台」入口按钮
     - 线上（部署后的博客）：指向 /admin/（GitHub 云端后台登录页）
     - 本地预览（localhost / 127.0.0.1）：指向本机后台服务 http://127.0.0.1:4321/ */
  function addAdminButton() {
    if (document.getElementById("ftm-admin-btn")) return; // 防 pjax 重复注入
    var navRight = document.getElementById("nav-right");
    if (!navRight) return;
    var isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    var adminUrl = isLocal ? "http://127.0.0.1:4321/" : "/admin/";
    var btn = document.createElement("div");
    btn.id = "ftm-admin-btn";
    btn.className = "nav-button ftm-admin-btn";
    btn.innerHTML =
      '<a class="site-page" href="' + adminUrl + '" target="_blank" rel="noopener" title="博客管理后台" aria-label="博客管理后台">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.07 7.07 0 0 0 .05-.94 7.07 7.07 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.69 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.03.31-.05.63-.05.94s.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.23.1.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/></svg>' +
      "</a>";
    var toggle = document.getElementById("toggle-menu");
    navRight.insertBefore(btn, toggle);
  }

  /* 「飞向月球」标题：云游君小站式竖排逐字动画（仅首页生效）
     - 竖排 + 衬线字重 900 + 随机字号 + 半透明白底
     - 上下竖线展开 → 每个字交替左右滑入 */
  function initYunTitle() {
    var isHome = location.pathname === "/" || location.pathname === "/index.html";
    if (!isHome) return;
    var title = document.getElementById("site-title");
    if (!title || title.dataset.yunDone) return;
    var text = title.textContent.trim();
    if (text !== "飞向月球") return;

    title.dataset.yunDone = "1";
    title.classList.add("yun-banner");
    title.textContent = "";

    var lineTop = document.createElement("div");
    lineTop.className = "yun-line";
    var lineBottom = document.createElement("div");
    lineBottom.className = "yun-line";
    var container = document.createElement("div");
    container.className = "yun-char-container";

    var chars = text.split("");
    var sumH = 0;
    var isMobile = window.innerWidth < 768;
    chars.forEach(function (ch, i) {
      var box = document.createElement("div");
      // 随机字号：移动端 1.35~2.45rem，桌面 1.75~3.3rem（还原云游君 banner 的随机感）
      var rn = isMobile ? 1.35 + Math.random() * 1.1 : 1.75 + Math.random() * 1.55;
      box.className = "yun-char-box " + (i % 2 === 0 ? "yun-char-left" : "yun-char-right");
      box.style.setProperty("--yun-char-size", rn.toFixed(2) + "rem");
      var span = document.createElement("span");
      span.className = "yun-char";
      span.textContent = ch;
      box.appendChild(span);
      container.appendChild(box);
      sumH += rn;
    });

    title.appendChild(lineTop);
    title.appendChild(container);
    title.appendChild(lineBottom);

    // 上下竖线高度：各填充到 50vh
    title.style.setProperty("--yun-line-h", "calc(50vh - " + (sumH / 2).toFixed(2) + "rem)");

    // 延迟一帧触发入场动画
    requestAnimationFrame(function () {
      lineTop.classList.add("yun-anim");
      lineBottom.classList.add("yun-anim");
    });
  }

  function initCustom() {
    wrapTables();
    bindImageFallback();
    bindExternalLinks();
    bindAnchorSmooth();
    addAdminButton();
    initYunTitle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCustom);
  } else {
    initCustom();
  }

  // pjax 页面切换后重新初始化
  document.addEventListener("pjax:complete", initCustom);
  document.addEventListener("pjax:success", initCustom);
})();
