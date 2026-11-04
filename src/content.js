/*
 * 自动续播 · 智慧树 —— 内容脚本
 *
 * 只做两件事：
 *   1) 视频被暂停（缓冲、失焦、播放器自身暂停）时自动恢复播放；
 *   2) 视频播放结束后，点击页面上的「下一节 / 继续学习」入口。
 *
 * 明确不做的事：
 *   - 不改写 currentTime、不伪造进度上报、不调用平台的进度接口；
 *   - 不跳过弹题：检测到弹题浮层时主动停止续播，交给使用者作答；
 *   - 不规避平台的失焦 / 倍速 / 行为校验。
 */
(function () {
  'use strict';

  if (window.__zhsAutoPlayLoaded) return;
  window.__zhsAutoPlayLoaded = true;

  const DEFAULTS = {
    enabled: true,
    autoResume: true,
    autoNext: true,
    resumeDelayMs: 2000,
    playbackRate: 1.0,
    nextSelector: '',
    showBadge: true,
    nextStrategy: 'auto',      // auto | button | catalog
    catalogDryRun: true,       // 只提示「将点击第 N 项」，不真的点
    catalogItemSelector: '',   // 留空则自动识别左侧目录
    pptDwellMs: 8000,          // 没有视频的条目（PPT/文档）停留多久算"已打开"
    videoWaitMs: 12000,        // 点进去后等视频出现的上限
    openDocFirst: true,        // 视频播完后先打开同知识点的 PPT/PDF，再进下一个
    expandGroups: true         // 没有可见条目时，自动展开折叠的「知识单元 / 知识模块」
  };

  let VERSION = '';
  try {
    VERSION = chrome.runtime.getManifest().version || '';
  } catch (e) {
    VERSION = '';
  }

  const NEXT_TEXT = /^(下一(个|节|章|集|课|讲|步)?|下节|下章|继续学习|继续播放|下一个视频|next|continue|upnext)$/i;
  const QUIZ_HINT = '[class*="quiz" i],[class*="question" i],[class*="exam" i],[class*="popup" i],[id*="quiz" i],[id*="question" i],[id*="exam" i]';

  let cfg = Object.assign({}, DEFAULTS);

  const state = {
    video: null,
    resumeAttempts: 0,
    lastResumeAt: 0,
    playStartAt: 0,
    endedKey: '',
    endedAt: 0,
    dryRunKey: '',
    shadowRoots: [],
    lastScanAt: 0,
    /* 连续推进状态机：视频结束 → 点下一项 → 等视频 / PPT 停留 → 再下一项 */
    advance: { active: false, phase: 'idle', startedAt: 0, beforeSrc: '', label: '', index: -1 },
    lastCatalogKey: '',
    lastCatalogTop: 0,
    lastExpandAt: 0,
    chainVisited: new Set(),
    chainClicks: 0,
    lastDocKey: ''
  };

  /* ---------------------------------------------------------------- 工具 */

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    const a = r.width * r.height;
    if (a > 0) return a;
    return (el.videoWidth || 0) * (el.videoHeight || 0);
  }

  /* ------------------------------------------------------------ 找视频元素 */

  function collectShadowRoots() {
    const roots = [];
    const walk = (root, depth) => {
      if (depth > 5) return;
      let els;
      try {
        els = root.querySelectorAll('*');
      } catch (e) {
        return;
      }
      for (const el of els) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot, depth + 1);
        }
      }
    };
    walk(document, 0);
    return roots;
  }

  function allVideos() {
    const out = [];
    const push = (list) => {
      for (const v of list) if (v instanceof HTMLVideoElement && out.indexOf(v) === -1) out.push(v);
    };
    push(document.querySelectorAll('video'));
    for (const root of state.shadowRoots) {
      try {
        push(root.querySelectorAll('video'));
      } catch (e) {
        /* 跨域 shadow root 已失效，忽略 */
      }
    }
    return out;
  }

  /* 主播放器的最小面积（px²）。资源卡片的缩略图本身也可能是 <video>，
     不过尺寸远小于播放器，用面积阈值把它们排除掉——否则会误判"新视频已就绪"。 */
  const MIN_PLAYER_AREA = 120000;

  function pickVideo() {
    const list = allVideos();
    if (!list.length) return null;

    const sized = list
      .map((v) => ({ v, a: area(v) }))
      .sort((x, y) => y.a - x.a);

    const main = sized.filter((s) => s.a >= MIN_PLAYER_AREA).map((s) => s.v);
    if (!main.length) {
      /* 布局极端时退回最大的那个，避免完全失效 */
      return sized[0].a > 0 ? sized[0].v : null;
    }

    const playing = main.find((v) => !v.paused && !v.ended && v.readyState >= 2);
    if (playing) return playing;
    return main[0];
  }

  /* --------------------------------------------------------------- 弹题检测 */

  /**
   * 只做"检测"，不做任何作答或跳过。
   * 命中时暂停自动续播，避免在题目未答的情况下继续累积观看。
   */
  function quizOverlayVisible() {
    let nodes;
    try {
      nodes = document.querySelectorAll(QUIZ_HINT);
    } catch (e) {
      return false;
    }
    const vw = window.innerWidth * window.innerHeight;
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < vw * 0.12) continue;
      const text = (el.textContent || '').slice(0, 400);
      if (/请回答|单选题|多选题|判断题|正确答案|答题|作答|提交答案/.test(text)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ 播放控制 */

  function tryPlay(v) {
    state.lastResumeAt = Date.now();
    state.resumeAttempts += 1;
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        const name = err && err.name;
        if (name === 'NotAllowedError') {
          notify('浏览器拦截了自动播放，请在页面上点一下');
        } else if (name === 'NotSupportedError') {
          notify('视频源不受支持，无法自动续播');
        }
        /* AbortError：被新的播放请求打断，属正常情况，静默忽略 */
      });
    }
  }

  function applyRate(v) {
    const rate = Number(cfg.playbackRate) || 0;
    if (rate <= 0) return;
    if (v.paused || v.ended) return;
    if (Math.abs(v.playbackRate - rate) > 0.01) {
      try {
        v.playbackRate = rate;
      } catch (e) {
        /* 平台锁定倍速时会抛错，忽略 */
      }
    }
  }

  /* -------------------------------------------------------------- 找下一节 */

  function shortText(el) {
    const t = (el.textContent || '').replace(/\s+/g, '').replace(/[›»>→·]/g, '');
    return t.length > 0 && t.length <= 12 ? t : '';
  }

  function clickableAncestor(el) {
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i += 1, n = n.parentElement) {
      const tag = n.tagName;
      if (tag === 'A' || tag === 'BUTTON') return n;
      if (n.getAttribute && n.getAttribute('role') === 'button') return n;
      if (n.hasAttribute && n.hasAttribute('onclick')) return n;
    }
    return el;
  }

  function findNextControl(video) {
    const candidates = [];

    if (cfg.nextSelector) {
      try {
        for (const el of document.querySelectorAll(cfg.nextSelector)) {
          if (isVisible(el)) candidates.push(el);
        }
      } catch (e) {
        notify('自定义选择器无效：' + cfg.nextSelector);
      }
    }

    if (!candidates.length) {
      const nodes = document.querySelectorAll('a,button,[role="button"],li,span,div,i');
      const vRect = video ? video.getBoundingClientRect() : null;
      const vCx = vRect ? vRect.left + vRect.width / 2 : 0;
      const vCy = vRect ? vRect.top + vRect.height / 2 : 0;

      for (const el of nodes) {
        if (candidates.length > 40) break;
        const txt = shortText(el);
        if (!txt || !NEXT_TEXT.test(txt)) continue;
        if (!isVisible(el)) continue;
        const cls = (el.className || '') + ' ' + (el.getAttribute('class') || '');
        if (/disabled|forbid|ban/i.test(String(cls))) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        candidates.push(el);
      }

      /* 多个候选取离播放器中心最近的，避免点到侧边栏不相干的按钮 */
      if (candidates.length > 1 && vRect) {
        candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const da = Math.hypot(ra.left + ra.width / 2 - vCx, ra.top + ra.height / 2 - vCy);
          const db = Math.hypot(rb.left + rb.width / 2 - vCx, rb.top + rb.height / 2 - vCy);
          return da - db;
        });
      }
    }

    return candidates[0] || null;
  }

  function clickElement(el) {
    const target = clickableAncestor(el);
    /* 不做 scrollIntoView：滚动会让虚拟/重渲染的列表把节点换掉，
       紧接着的 click 就落在一个已脱离文档的节点上，什么都不会发生。 */
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    try {
      if (typeof PointerEvent === 'function') {
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
      }
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) {
      /* 派发失败时退回原生 click */
    }
    if (typeof target.click === 'function') target.click();
  }

  /* ------------------------------------------------------------ 左侧目录模式 */

  const parentIds = new WeakMap();
  let parentSeq = 0;

  function parentId(el) {
    if (!parentIds.has(el)) {
      parentSeq += 1;
      parentIds.set(el, parentSeq);
    }
    return parentIds.get(el);
  }

  /*
   * 目录项识别看三种证据，优先级从高到低：
   *   1) 百分比数字：<100% 一律视为"未学完"，避免 "已学 60%" 被误判成已完成；
   *   2) 明确的完成文案：已学完 / 已完成 / 已看完；
   *   3) 类名或图标类名里的 done / finish / complete。
   */
  const UNDONE_RE = /未学|未完成|未开始|未观看|未看|待学|待完成/;
  const DONE_TEXT_RE = /已学完|已完成|已看完|已观看完|学完了|已学过了/;
  const DONE_VAGUE_RE = /已学|已观看/;
  const DONE_SIG_RE = /(^|[^a-z])(done|finished|complete|learned|passed)([^a-z]|$)/i;
  const UNDONE_SIG_RE = /(undo|unlearn|notstart|incomplete|not-finish)/i;
  const CURRENT_RE = /学习中|正在学|当前播放|正在播放|active|current|playing/i;

  /**
   * 进度解析。本平台目录用的是 "必学 2/2"、"必学 1/2" 这种完成数比值，
   * 既不是"已学"也不是百分比，所以必须单独认这种格式。
   */
  function parseProgress(text) {
    const ab = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    if (ab) {
      const a = Number(ab[1]);
      const b = Number(ab[2]);
      if (b > 0 && a <= b) return { done: a >= b, a, b };
    }
    const pct = text.match(/(\d{1,3})\s*%/);
    if (pct) {
      const p = Number(pct[1]);
      return { done: p >= 100, a: p, b: 100 };
    }
    return null;
  }

  function classifyCatalogItem(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const sig = String(el.className || '') + ' ' + (el.innerHTML || '').slice(0, 800);
    const r = el.getBoundingClientRect();

    const prog = parseProgress(text);

    let done = false;
    if (prog) {
      done = prog.done;
    } else if (UNDONE_RE.test(text)) {
      done = false;
    } else if (DONE_TEXT_RE.test(text)) {
      done = true;
    } else if (DONE_VAGUE_RE.test(text)) {
      done = true;
    } else if (DONE_SIG_RE.test(sig) && !UNDONE_SIG_RE.test(sig)) {
      done = true;
    }

    const current = CURRENT_RE.test(sig) || /学习中|正在学/.test(text);

    /* key 用完整文本：展开折叠单元后条目顺序会变，按序号记账会错位 */
    return { el, top: r.top, done, current, prog, key: text.slice(0, 120), label: text.slice(0, 26) };
  }

  /**
   * 从页面里猜出"左侧目录"：同一父节点下、样式相同、纵向排列、贴左侧的一组元素。
   * 猜错也不会乱点——调用方在试运行模式下只提示不动作。
   */
  function candidateCatalogGroups() {
    const vw = window.innerWidth;
    const buckets = new Map();
    const nodes = document.querySelectorAll('li,a,div,span,p');

    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 60) continue;
      if (el.children.length > 6) continue;

      const parent = el.parentElement;
      if (!parent) continue;

      const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0] || '';
      const key = parentId(parent) + '|' + el.tagName + '|' + cls;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { els: [] };
        buckets.set(key, bucket);
      }
      bucket.els.push(el);
    }

    const groups = [];
    for (const bucket of buckets.values()) {
      if (bucket.els.length < 5) continue;

      const items = bucket.els
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .sort((a, b) => a.r.top - b.r.top);

      const avgLeft = items.reduce((s, it) => s + it.r.left, 0) / items.length;
      if (avgLeft > vw * 0.5) continue;

      let stacked = true;
      for (let i = 1; i < items.length; i += 1) {
        if (items[i].r.top <= items[i - 1].r.top + 2) {
          stacked = false;
          break;
        }
      }
      if (!stacked) continue;

      groups.push({
        score: items.length * 2 + (avgLeft < vw * 0.4 ? 12 : 0),
        items: items.map((it) => it.el)
      });
    }

    groups.sort((a, b) => b.score - a.score);
    return groups;
  }

  /**
   * 优先用"进度标记"认条目：凡是文本里带 `必学 a/b` 的元素，往上爬到
   * "标题 + 进度"那一行。这比按样式分组可靠得多——本平台每个知识单元下
   * 只有 2~3 个叶子，凑不够按样式分组要求的数量，而且知识模块/知识单元
   * 这类折叠标题会被自然排除（它们没有进度标记）。
   */
  function catalogRowsByProgress() {
    const rows = [];
    const nodes = document.querySelectorAll('div,li,a,span,p');

    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (raw.length > 120) continue;
      if (!/必学\s*\d{1,3}\s*\/\s*\d{1,3}/.test(raw)) continue;

      let row = el;
      for (let i = 0; i < 5 && row.parentElement; i += 1) {
        const parent = row.parentElement;
        const pt = (parent.textContent || '').replace(/\s+/g, ' ').trim();
        if (pt.length > 120) break;
        row = parent;
        if (pt.length >= raw.length + 4) break;
      }
      if (rows.indexOf(row) === -1) rows.push(row);
    }

    if (rows.length < 2) return null;

    /* 嵌套时只保留最内层那一行（外层往往是整个列表） */
    const leafRows = rows.filter((row) => !rows.some((other) => other !== row && row.contains(other)));
    return leafRows.length >= 2 ? leafRows : rows;
  }

  function catalogItems() {
    if (cfg.catalogItemSelector) {
      let els;
      try {
        els = Array.from(document.querySelectorAll(cfg.catalogItemSelector));
      } catch (e) {
        notify('目录选择器无效：' + cfg.catalogItemSelector);
        return null;
      }
      els = els.filter(isVisible);
      return els.length >= 2 ? els.map(classifyCatalogItem).sort((a, b) => a.top - b.top) : null;
    }

    const byProgress = catalogRowsByProgress();
    if (byProgress) return byProgress.map(classifyCatalogItem).sort((a, b) => a.top - b.top);

    const groups = candidateCatalogGroups();
    if (!groups.length) return null;
    return groups[0].items.map(classifyCatalogItem);
  }

  /* ------------------------------------------------------ 定位"当前正在学的知识点"

     不依赖「必学 a/b」——那个计数不实时刷新，靠它判断会一直读到旧值。
     改用三种信号定位当前项，任一命中即可：
       1) 主播放区顶部的大字号标题（与目录里的条目名做前缀比对）；
       2) 目录里被高亮的行（背景色与其它行不同）；
       3) 类名 / 文案里带 current / active / 学习中。
     定位到之后，直接取它的下一个条目，不做任何完成度过滤。
  */

  function normCore(t) {
    return String(t || '')
      .replace(/必学\s*\d+\s*\/\s*\d+/g, '')
      .replace(/[\s.…·。、，,：:]/g, '')
      .trim();
  }

  /** 主播放区顶部那个标题文字，认不出返回 '' */
  function mainHeadingText() {
    const vw = window.innerWidth;
    let best = null;
    const nodes = document.querySelectorAll('div,span,h1,h2,h3,p,a');

    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < vw * 0.25) continue;          /* 目录在左边，主区在右 3/4 */
      if (r.top < 0 || r.top > window.innerHeight * 0.5) continue;

      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 4 || t.length > 60) continue;
      if (/必学\s*\d+\s*\/\s*\d+/.test(t)) continue;

      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (!isFinite(fs) || fs < 18) continue;

      if (!best || fs > best.fs + 0.5 || (Math.abs(fs - best.fs) <= 0.5 && r.top < best.top - 4)) {
        best = { text: t, fs, top: r.top };
      }
    }
    return best ? best.text : '';
  }

  function headingCandidates(items, heading) {
    const head = normCore(heading);
    if (!head) return [];

    const scored = [];
    items.forEach((it, i) => {
      const core = normCore(it.key);
      const n = Math.min(core.length, head.length);
      let k = 0;
      while (k < n && core[k] === head[k]) k += 1;
      if (k >= 4) scored.push({ i, k });
    });
    if (!scored.length) return [];

    /* 目录名常被 CSS 截断，同一个单元里可能有两条同名条目，
       这时标题比对会给出多个等长候选，交给高亮/类名来消歧 */
    const maxK = Math.max(...scored.map((s) => s.k));
    return scored.filter((s) => s.k === maxK).map((s) => s.i);
  }

  function indexByHighlight(items) {
    const colors = items.map((it) =>
      (getComputedStyle(it.el).backgroundColor || '').replace(/\s+/g, '')
    );

    const counts = {};
    for (const c of colors) counts[c] = (counts[c] || 0) + 1;

    /* 选中行通常是"唯一那个跟多数行不同的底色" */
    const singles = [];
    colors.forEach((c, i) => {
      if (!c) return;
      if (counts[c] !== 1) return;
      if (c === 'rgba(0,0,0,0)' || c === 'transparent') return;
      if (c === 'rgb(255,255,255)' || c === 'rgba(255,255,255,1)') return;
      singles.push(i);
    });

    return singles.length === 1 ? singles[0] : -1;
  }

  function locateCurrentIndex(items) {
    const cands = headingCandidates(items, mainHeadingText());
    if (cands.length === 1) return cands[0];

    /* 标题有歧义（或认不出）时，优先相信界面自己的选中态 */
    const hl = indexByHighlight(items);
    if (hl >= 0 && (cands.length === 0 || cands.indexOf(hl) >= 0)) return hl;

    const cls = items.findIndex((it) => it.current);
    if (cls >= 0 && (cands.length === 0 || cands.indexOf(cls) >= 0)) return cls;

    if (cands.length > 1) return cands[cands.length - 1];
    return -1;
  }

  function planCatalogNext() {
    const items = catalogItems();
    if (!items || items.length < 2) return null;

    let idx = locateCurrentIndex(items);
    if (idx < 0 && state.lastCatalogKey) {
      idx = items.findIndex((it) => it.key === state.lastCatalogKey);
    }

    /* 认不出当前位置时按"从头开始"，而不是拒绝工作 */
    const next = idx + 1;
    if (next >= items.length) {
      return { none: true, index: -1, total: items.length, label: '', idx };
    }

    const it = items[next];
    return {
      el: it.el,
      index: next,
      total: items.length,
      key: it.key,
      top: it.top,
      label: it.label,
      currentIdx: idx,
      none: false
    };
  }

  /* -------------------------------------------------- 折叠的「知识模块 / 知识单元」

     层级是 知识模块 → 知识单元 → 知识点，折叠状态下子条目根本不在 DOM 里，
     所以"可见条目全学完"并不等于"整门课学完"。这里用几何关系判断某个分组
     是否处于折叠态：它下面直到下一个分组标题之间，既没有更深一层的标题，
     也没有带进度的条目 —— 那就是折叠的。
  */

  function groupHeaders() {
    const levelOf = (t) => (t.indexOf('知识模块') === 0 ? 1 : t.indexOf('知识单元') === 0 ? 2 : 0);
    const raw = [];
    const nodes = document.querySelectorAll('div,li,span,a,p');

    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (t.length < 3 || t.length > 80) continue;
      const level = levelOf(t);
      if (!level) continue;
      raw.push({ el, level, top: el.getBoundingClientRect().top, text: t });
    }

    /* 同一位置常有嵌套的多个元素命中，按 top 去重，保留文本最短的（最内层标题） */
    raw.sort((a, b) => a.top - b.top || a.text.length - b.text.length);
    const out = [];
    for (const h of raw) {
      const dup = out.find((o) => Math.abs(o.top - h.top) < 6);
      if (!dup) out.push(h);
    }
    return out.sort((a, b) => a.top - b.top);
  }

  function isCollapsedGroup(header, headers, leaves) {
    const next = headers.find((o) => o.top > header.top + 6);
    const bottom = next ? next.top : header.top + 500;

    const deeper = headers.some(
      (o) => o !== header && o.level > header.level && o.top > header.top + 2 && o.top < bottom - 2
    );
    if (deeper) return false;

    const leaf = leaves.some((l) => l.top > header.top + 2 && l.top < bottom - 2);
    return !leaf;
  }

  /** 展开一个折叠分组；返回是否真的点了 */
  function expandNextCollapsed() {
    const headers = groupHeaders();
    if (!headers.length) return false;

    const leaves = catalogItems() || [];
    const collapsed = headers.filter((h) => isCollapsedGroup(h, headers, leaves));
    if (!collapsed.length) return false;

    /* 优先展开当前位置之后的第一个，避免从头乱翻 */
    const after = collapsed.filter((h) => h.top > state.lastCatalogTop + 4);
    const target = after[0] || collapsed[0];

    state.lastExpandAt = Date.now();
    clickElement(target.el);
    notify('已展开折叠分组：' + target.text.slice(0, 12));
    return true;
  }

  /* -------------------------------------------------------------- 连续推进 */

  /**
   * 同一知识点下的文档资源卡片（.pptx/.pdf 之类），没有视频，打开即算。
   * 返回 { title, card }：title 是最内层带文件名的节点，card 是往上几层的卡片容器。
   * 点击时先点 title，没反应再点 card——本平台的卡片把事件绑在不同的层上。
   */
  function findDocResourceCard() {
    const nodes = document.querySelectorAll('div,a,li,p,span');
    let title = null;

    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 6 || t.length > 90) continue;
      if (!/\.(pptx|ppt|pdf|docx?|xlsx?)/i.test(t)) continue;
      /* 取最内层：文本最短的那个 */
      if (!title || t.length < (title.textContent || '').trim().length) title = el;
    }

    if (!title) return null;

    let card = title;
    for (let i = 0; i < 3 && card.parentElement; i += 1) card = card.parentElement;

    return { title, card };
  }

  /**
   * 视频播完后触发。点完下一项不等于"切好了"：
   * 下一个知识点可能是 PPT——它没有 video 元素，打开就算完成，
   * 所以必须进入"等待视频 → 判定为无视频 → 停留 → 继续"的状态机，
   * 否则流程会停在一个没有 video 的页面上再也不动。
   */
  function advanceFromVideo(v) {
    if (!cfg.autoNext) return;

    const key = v.currentSrc || v.src || 'ended';
    const now = Date.now();
    /* 同一集结束事件会重复触发，15 秒内只处理一次 */
    if (state.endedKey === key && now - state.endedAt < 15000) return;
    state.endedKey = key;
    state.endedAt = now;
    state.dryRunKey = '';

    if (quizOverlayVisible()) {
      notify('检测到弹题，未自动切换下一节');
      return;
    }

    const strategy = cfg.nextStrategy || 'auto';

    /* 第一步：同知识点的文档资源（PPT/PDF）先打开，再谈下一个条目。
       本平台一个知识点 = 视频 + PPT，跳过 PPT 那条就永远缺一半。
       这一步必须排在"点下一节/点目录"之前。 */
    if (cfg.openDocFirst) {
      const doc = findDocResourceCard();
      if (doc && state.lastDocKey !== key) {
        state.lastDocKey = key;
        clickElement(doc.title);
        beginAdvance(key, '文档资源', -1);
        /* 文档没有视频，直接进入停留阶段，不必空等 videoWaitMs */
        state.advance.phase = 'ppt';
        state.advance.startedAt = Date.now();
        state.advance.docCard = doc.card;
        state.advance.docRetried = false;
        notify('已打开同知识点的文档资源（PPT/PDF）');
        return;
      }
      if (!doc) notify('这一条没找到 PPT/PDF 资源卡片');
    }

    /* 第二步：找"下一节"按钮（多数课程页没有，只有目录） */
    if (strategy !== 'catalog') {
      const target = findNextControl(v);
      if (target) {
        const beforeSrc = v.currentSrc || v.src || '';
        clickElement(target);
        notify('已点击：' + shortText(target));
        beginAdvance(beforeSrc, shortText(target), -1);
        return;
      }
    }

    if (strategy === 'button') {
      notify('本集已结束，没找到「下一节」按钮');
      return;
    }

    /* 第三步：按"当前知识点"定位，点它后面那一条 */
    advanceByCatalog('本集结束');
  }

  function beginAdvance(beforeSrc, label, index) {
    state.advance = {
      active: true,
      phase: 'waiting-video',
      startedAt: Date.now(),
      beforeSrc,
      label,
      index,
      docCard: null,
      docRetried: false,
      rowEl: null,
      headingBefore: '',
      retried: false
    };
    state.resumeAttempts = 0;
  }

  function advanceByCatalog(reason) {
    if (state.chainClicks >= 40) {
      notify('连续推进次数过多，已停止（可能目录识别有误）');
      state.advance = { active: false, phase: 'idle', startedAt: 0, beforeSrc: '', label: '', index: -1 };
      return;
    }

    const plan = planCatalogNext();
    if (!plan) {
      notify('没能识别左侧目录结构');
      return;
    }
    if (plan.none) {
      /* 可见条目都学完了，但可能有折叠的知识单元还没展开 */
      if (cfg.expandGroups) {
        if (Date.now() - state.lastExpandAt < 600) return; /* 刚展开过，等下一轮再看 */
        if (expandNextCollapsed()) {
          /* 展开后条目变了，清掉去重键让下一轮重新规划 */
          state.endedKey = '';
          return;
        }
      }
      notify('已经是目录里最后一条了（折叠单元也展开过了）');
      return;
    }

    if (cfg.catalogDryRun) {
      const key = state.endedKey;
      if (state.dryRunKey === key && key) return;
      state.dryRunKey = key;
      const from = plan.currentIdx >= 0 ? '当前第 ' + (plan.currentIdx + 1) + ' 项' : '未定位到当前项';
      notify('试运行：' + from + '，将点击第 ' + (plan.index + 1) + '/' + plan.total + ' 项「' + plan.label + '」');
      return;
    }

    const v = pickVideo();
    const beforeSrc = v ? v.currentSrc || v.src || '' : '';

    /* 用 key 重新查一次节点再点：列表重渲染后旧节点可能已经脱离文档，
       点它没有任何效果——这很可能就是"点了目录没反应"的原因。 */
    const clicked = clickCatalogItemByKey(plan.key);
    if (!clicked) {
      clickElement(plan.el);
      notify('按 key 没找到条目节点，改点旧节点（可能列表已重渲染）');
    }

    state.lastCatalogKey = plan.key;
    state.lastCatalogTop = plan.top;
    state.chainVisited.add(plan.key);
    state.chainClicks += 1;

    beginAdvance(beforeSrc, plan.label, plan.index);
    state.advance.rowEl = plan.el;
    state.advance.headingBefore = normCore(mainHeadingText());
    state.advance.retried = false;
    notify(
      '已打开第 ' + (plan.index + 1) + '/' + plan.total + ' 项「' + plan.label + '」' +
        (reason ? ' · ' + reason : '')
    );
  }

  /** 在 root 里找最深的、以 core 开头的文本节点（事件常绑在内层标题上，不是整行） */
  function deepTitleNode(root, core) {
    if (!core) return null;
    let best = null;
    const walk = (el) => {
      const kids = el.children || [];
      for (const c of kids) {
        const t = (c.textContent || '').replace(/\s+/g, '').trim();
        if (!t) continue;
        if (t.indexOf(core) === 0) {
          best = c;
          walk(c);
        }
      }
    };
    walk(root);
    return best;
  }

  /** 按 key 重新取节点再点；先点最内层标题，再点整行（同一项点两次无副作用） */
  function clickCatalogItemByKey(key) {
    const items = catalogItems();
    if (!items) return false;
    const hit = items.find((it) => it.key === key);
    if (!hit) return false;

    const deep = deepTitleNode(hit.el, normCore(hit.key));
    if (deep) clickElement(deep);
    if (!deep || deep !== hit.el) clickElement(hit.el);
    return true;
  }

  /** 视频是否已经是"新视频且可播"——用来判断这一项到底有没有视频 */
  function readyForAdvance(v) {
    if (!v || v.readyState < 2) return false;
    /* 还是那个已经播完的旧视频，不算 */
    if (v.ended && (v.currentSrc || v.src || '') === state.advance.beforeSrc) return false;
    return true;
  }

  /**
   * 每轮 tick 调用。返回 true 表示"正在等待，本轮不要做别的事"。
   * waiting-video：等视频出现，超时则认定这一项没有视频
   * ppt：没有视频的条目停留一段时间（让它算作"已打开"），然后继续推进
   */
  function stepAdvance(now) {
    const a = state.advance;
    if (!a.active) return false;

    const v = pickVideo();
    if (v && readyForAdvance(v)) {
      a.active = false;
      a.phase = 'idle';
      state.chainVisited.clear();
      state.chainClicks = 0;
      state.lastDocKey = '';
      /* 保留 lastCatalogKey：新视频可播了，但目录的"当前项"标记未必同步，
         保留它才不会在下一集结束时又点回刚刚那一项 */
      return false;
    }

    if (a.phase === 'waiting-video') {
      /* 点了目录但主区标题没变 → 说明这一下没生效，换个目标再点一次，
         而不是当成"这一条没有视频"继续往后跳（那样会把整份目录空走一遍）。 */
      if (!a.retried && a.rowEl && a.headingBefore && now - a.startedAt > 4000) {
        const head = normCore(mainHeadingText());
        if (head && head === a.headingBefore) {
          a.retried = true;
          clickElement(a.rowEl);
          a.startedAt = now;
          notify('目录点击似乎没生效，换目标重试');
          return true;
        }
      }
      if (now - a.startedAt < cfg.videoWaitMs) return true;
      a.phase = 'ppt';
      a.startedAt = now;
      notify('这一项没有视频（可能是不需要看的 PPT/文档），停留后继续');
      return true;
    }

    if (a.phase === 'ppt') {
      /* 点了文档卡片但页面没换（视频元素还在）→ 说明点到的是无事件的外层，
         改点卡片容器再试一次。 */
      if (!a.docRetried && a.docCard && now - a.startedAt > 2500) {
        a.docRetried = true;
        if (pickVideo()) clickElement(a.docCard);
      }
      if (now - a.startedAt < cfg.pptDwellMs) return true;
      a.active = false;
      a.phase = 'idle';
      advanceByCatalog('上一项无视频');
      return true;
    }

    return false;
  }

  /* ---------------------------------------------------------------- 主循环 */

  function onNewVideo(v) {
    state.video = v;
    state.resumeAttempts = 0;
    state.lastResumeAt = 0;
    state.playStartAt = v.paused ? 0 : Date.now();

    v.addEventListener('playing', () => {
      if (!state.playStartAt) state.playStartAt = Date.now();
    });
    v.addEventListener('pause', () => {
      /* 暂停原因未知，交给主循环按退避策略处理 */
      state.playStartAt = 0;
    });
  }

  function tick() {
    const now = Date.now();

    if (now - state.lastScanAt > 5000) {
      state.lastScanAt = now;
      state.shadowRoots = collectShadowRoots();
    }

    if (!cfg.enabled) return;

    /* 正在"等视频出现 / PPT 停留"时不碰播放器，否则会把上一集重新拉起来 */
    if (stepAdvance(now)) return;

    const v = pickVideo();
    if (!v) return;
    if (v !== state.video) onNewVideo(v);

    if (!v.paused && !v.ended) {
      applyRate(v);
      if (!state.playStartAt) state.playStartAt = now;
      /* 连续播放满 20 秒，说明已经稳定，重置重试退避与推进链 */
      if (now - state.playStartAt > 20000) {
        state.resumeAttempts = 0;
        state.chainVisited.clear();
        state.chainClicks = 0;
      }
    }

    if (v.ended) {
      advanceFromVideo(v);
      return;
    }

    if (!v.paused) return;
    if (!cfg.autoResume) return;
    if (!isVisible(v)) return;

    /* 弹题期间不续播，交给使用者作答 */
    if (quizOverlayVisible()) return;

    /* 退避：多次立刻失败时逐步拉长间隔，避免和播放器抢控制权 */
    const delay = Math.min(cfg.resumeDelayMs * Math.pow(1.8, state.resumeAttempts), 30000);
    if (now - state.lastResumeAt < delay) return;

    tryPlay(v);
  }

  /* ---------------------------------------------------------------- 角标提示 */

  let badgeHost = null;
  let badgeTimer = 0;

  function notify(text) {
    if (!cfg.showBadge) return;
    try {
      if (!badgeHost) {
        badgeHost = document.createElement('div');
        badgeHost.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
          'pointer-events:none', 'opacity:0', 'transition:opacity .25s ease',
          'font:500 13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
          'color:#fff', 'background:rgba(17,24,39,.92)', 'padding:8px 14px',
          'border-radius:8px', 'box-shadow:0 6px 20px rgba(0,0,0,.28)',
          'max-width:min(320px,60vw)'
        ].join(';');
        (document.body || document.documentElement).appendChild(badgeHost);
      }
      badgeHost.textContent = text;
      badgeHost.style.opacity = '1';
      clearTimeout(badgeTimer);
      badgeTimer = setTimeout(() => {
        if (badgeHost) badgeHost.style.opacity = '0';
      }, 2600);
    } catch (e) {
      /* 页面不允许挂载时静默失败 */
    }
  }

  /* ------------------------------------------------------------ 配置与消息 */

  function loadConfig() {
    try {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        if (chrome.runtime.lastError) return;
        cfg = Object.assign({}, DEFAULTS, stored || {});
      });
    } catch (e) {
      /* 扩展上下文失效（重载/卸载后）时保持默认值 */
    }
  }

  loadConfig();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(changes)) {
        if (key in DEFAULTS) cfg[key] = changes[key].newValue;
      }
      if (!cfg.enabled && badgeHost) badgeHost.style.opacity = '0';
    });
  } catch (e) {
    /* 同上 */
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'zap:status') {
        const v = pickVideo();
        sendResponse({
          ok: true,
          hasVideo: !!v,
          paused: v ? v.paused : null,
          ended: v ? v.ended : null,
          time: v ? Math.round(v.currentTime) : 0,
          duration: v ? Math.round(v.duration || 0) : 0,
          quiz: quizOverlayVisible(),
          cfg
        });
      } else if (msg.type === 'zap:resume') {
        const v = pickVideo();
        if (v) tryPlay(v);
        sendResponse({ ok: !!v });
      }
    });
  } catch (e) {
    /* 同上 */
  }

  /* ------------------------------------------------------------------ 启动 */

  setInterval(tick, 1000);

  /* 启动角标：方便确认当前跑的是哪一版代码（改完扩展要刷新才生效） */
  setTimeout(() => {
    if (cfg.enabled && cfg.showBadge) notify('自动续播 v' + (VERSION || '?') + ' 已加载');
  }, 1200);

  /* 页面切回前台时立刻检查一次，减少等待感 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(tick, 300);
  });

  /* 播放器是 SPA 路由切换的，URL 变化后重新扫描 */
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      state.shadowRoots = collectShadowRoots();
      state.video = null;
    }
  }, 1500);
})();
