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
      // 知乎风格的「用户」图标：细圆环 + 人像剪影（替代原来的齿轮）
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9.3" style="fill:none;stroke:currentColor;stroke-width:1.5"></circle>' +
      '<path d="M12 12.6c1.82 0 3.3-1.48 3.3-3.3S13.82 6 12 6 8.7 7.48 8.7 9.3s1.48 3.3 3.3 3.3z"></path>' +
      '<path d="M12 14.1c-2.6 0-6.4 1.3-6.4 3.5v.8h12.8v-.8c0-2.2-3.8-3.5-6.4-3.5z"></path>' +
      '</svg>' +
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
    var isMobile = window.innerWidth < 768;
    chars.forEach(function (ch, i) {
      var box = document.createElement("div");
      // 随机字号：移动端 1.35~2.2rem，桌面 1.85~3.1rem（适配 AnZhiYu hero 高度）
      var rn = isMobile ? 1.35 + Math.random() * 0.85 : 1.85 + Math.random() * 1.25;
      box.className = "yun-char-box " + (i % 2 === 0 ? "yun-char-left" : "yun-char-right");
      box.style.setProperty("--yun-char-size", rn.toFixed(2) + "rem");
      var span = document.createElement("span");
      span.className = "yun-char";
      span.textContent = ch;
      box.appendChild(span);
      container.appendChild(box);
    });

    title.appendChild(lineTop);
    title.appendChild(container);
    title.appendChild(lineBottom);

    // 延迟一帧触发入场动画（竖线高度由 CSS 变量控制，见 custom.css）
    requestAnimationFrame(function () {
      lineTop.classList.add("yun-anim");
      lineBottom.classList.add("yun-anim");
    });
  }

  /* 首页置顶文章标记为通栏条形（配合 custom.css 的 .ftm-sticky-bar 样式） */
  function initStickyBars() {
    var list = document.getElementById("recent-posts");
    if (!list) return;
    var items = list.querySelectorAll(".recent-post-item");
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.classList.contains("ftm-sticky-bar")) continue;
      if (item.querySelector(".sticky-warp")) item.classList.add("ftm-sticky-bar");
    }
  }

  function initCustom() {
    wrapTables();
    bindImageFallback();
    bindExternalLinks();
    bindAnchorSmooth();
    addAdminButton();
    initYunTitle();
    initStickyBars();
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
