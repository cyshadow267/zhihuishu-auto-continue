/*
 * 最小 fake DOM 测试：直接加载 src/content.js，验证四条核心行为。
 * 运行：node test/run.mjs
 * 不依赖 jsdom，只为在无浏览器环境下做逻辑回归。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* ------------------------------------------------------------------ fake DOM */

function parseSelector(sel) {
  return sel
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const tagMatch = part.match(/^([a-z0-9-]+|\*)/i);
      const tag = tagMatch ? tagMatch[1].toLowerCase() : null;
      const attrs = [];
      const re = /\[([\w-]+)(?:([*^$]?=)"([^"]*)"(?:\s+(i))?)?\]/g;
      let m;
      while ((m = re.exec(part))) attrs.push({ name: m[1], op: m[2], val: m[3], ci: !!m[4] });
      return { tag, attrs };
    });
}

function matchOne(el, rule) {
  if (rule.tag && rule.tag !== '*' && el.tagName.toLowerCase() !== rule.tag) return false;
  for (const a of rule.attrs) {
    let actual = el.getAttribute(a.name) ?? '';
    if (a.name === 'class') actual = el.className || '';
    if (!a.op) {
      if (!actual) return false;
      continue;
    }
    let want = a.val ?? '';
    let got = actual;
    if (a.ci) {
      want = want.toLowerCase();
      got = got.toLowerCase();
    }
    if (a.op === '*=' && !got.includes(want)) return false;
    if (a.op === '=' && got !== want) return false;
  }
  return true;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this._attrs = {};
    this._listeners = {};
    this._text = '';
    this.offsetParent = {}; // 非 null 表示可见
    this._rect = { left: 0, top: 0, width: 100, height: 30 };
    this.className = '';
    this.shadowRoot = null;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  get innerHTML() {
    return (
      this._text +
      this.children
        .map(
          (c) =>
            `<${c.tagName.toLowerCase()} class="${c.className}">${c.textContent}</${c.tagName.toLowerCase()}>`
        )
        .join('')
    );
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null;
  }
  hasAttribute(k) {
    return k in this._attrs;
  }
  appendChild(c) {
    c.parentElement = this;
    this.children.push(c);
    document._register(c);
    return c;
  }
  addEventListener(t, f) {
    (this._listeners[t] ||= []).push(f);
  }
  dispatchEvent(ev) {
    for (const f of this._listeners[ev.type] || []) f.call(this, ev);
    return true;
  }
  getBoundingClientRect() {
    return { ...this._rect };
  }
  scrollIntoView() {}
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  click() {
    this.clickCount = (this.clickCount || 0) + 1;
    this.dispatchEvent({ type: 'click' });
  }
}

class FakeVideo extends El {
  constructor() {
    super('video');
    this.paused = true;
    this.ended = false;
    this.readyState = 4;
    this.currentTime = 0;
    this.duration = 600;
    this.playbackRate = 1;
    this.currentSrc = 'https://x/lesson1.mp4';
    this.src = this.currentSrc;
    this.videoWidth = 1280;
    this.videoHeight = 720;
    this.playCalls = 0;
    this._rect = { left: 0, top: 0, width: 960, height: 540 };
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    this.dispatchEvent({ type: 'playing' });
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent({ type: 'pause' });
  }
}

class Doc extends El {
  constructor() {
    super('#document');
    this._nodes = [];
    this.hidden = false;
    this.body = new El('body');
    this.documentElement = new El('html');
    this._register(this.body);
    this._register(this.documentElement);
  }
  _register(el) {
    if (!this._nodes.includes(el)) this._nodes.push(el);
  }
  createElement(tag) {
    const el = new El(tag);
    this._register(el);
    return el;
  }
  querySelectorAll(sel) {
    const rules = parseSelector(sel);
    return this._nodes.filter((el) => rules.some((r) => matchOne(el, r)));
  }
  addEventListener() {}
}

const document = new Doc();
globalThis.document = document;
globalThis.window = globalThis;
globalThis.Element = El;
globalThis.HTMLVideoElement = FakeVideo;
globalThis.location = { href: 'https://studyvideoh5.zhihuishu.com/player' };
globalThis.getComputedStyle = (el) => ({
  position: 'static',
  fontSize: el && el._fontSize ? el._fontSize : '16px',
  backgroundColor: el && el._bg ? el._bg : 'rgba(0, 0, 0, 0)'
});
globalThis.PointerEvent = class {
  constructor(type, init) {
    Object.assign(this, init, { type });
  }
};
globalThis.MouseEvent = globalThis.PointerEvent;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;

/* ---------------------------------------------------------------- chrome stub */

const settings = { resumeDelayMs: 200, videoWaitMs: 500, pptDwellMs: 400 };
let storageListener = null;

globalThis.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener() {} }
  },
  storage: {
    sync: {
      get(defaults, cb) {
        cb({ ...defaults, ...settings });
      },
      set() {}
    },
    onChanged: {
      addListener(fn) {
        storageListener = fn;
      }
    }
  }
};

/* 模拟 popup 改设置：触发 content.js 的 storage.onChanged 监听 */
function setSetting(key, value) {
  settings[key] = value;
  if (storageListener) storageListener({ [key]: { newValue: value } }, 'sync');
}

/* --------------------------------------------------------------- 场景与断言 */

const video = new FakeVideo();
document._register(video);

const nextBtn = new El('button');
nextBtn.textContent = '下一节';
document._register(nextBtn);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
}

vm.runInThisContext(readFileSync(new URL('../src/content.js', import.meta.url), 'utf8'), {
  filename: 'content.js'
});

/* 1) 初始暂停状态应被自动播放 */
await sleep(1300);
check('初始暂停自动播放', video.paused === false && video.playCalls >= 1, `playCalls=${video.playCalls}`);

/* 2) 播放中被暂停（模拟缓冲/失焦）应自动恢复 */
video.pause();
await sleep(1400);
check('暂停后自动续播', video.paused === false, `playCalls=${video.playCalls}`);

/* 3) 弹题浮层存在时不得续播 */
const quiz = new El('div');
quiz.className = 'quiz-popup';
quiz.textContent = '请回答以下单选题';
quiz._rect = { left: 0, top: 0, width: 1100, height: 760 };
document._register(quiz);
video.pause();
const beforeQuiz = video.playCalls;
await sleep(1800);
check('弹题期间不续播', video.paused === true && video.playCalls === beforeQuiz, `playCalls=${video.playCalls}`);

/* 4) 移除弹题、视频结束后应点击「下一节」 */
document._nodes = document._nodes.filter((n) => n !== quiz);
video.paused = true;
video.ended = true;
await sleep(2600);
check('结束后自动切下一节', nextBtn.clickCount === 1, `clickCount=${nextBtn.clickCount || 0}`);

/* 5) 同一集结束事件重复触发只应点击一次 */
await sleep(2200);
check('结束事件去重', (nextBtn.clickCount || 0) === 1, `clickCount=${nextBtn.clickCount || 0}`);

/* 6) 目录模式：没有「下一节」按钮时，点左侧目录里下一讲未学的 */
setSetting('nextStrategy', 'catalog');
setSetting('catalogDryRun', false);

const catalog = new El('div');
catalog.className = 'catalog-list';
const LESSONS = [
  '第1讲 导论 必学 2/2',
  '第2讲 基本概念 必学 2/2',
  '第3讲 辩证关系 必学 1/2',
  '第4讲 学员须知 必学 0/2',
  '第5讲 小结 必学 0/2',
  '第6讲 习题 必学 0/2'
];
const items = LESSONS.map((t) => {
  const el = new El('div');
  el.className = t.includes('第3讲') ? 'chapter-item active' : 'chapter-item';
  el.textContent = t;
  return el;
});
items.forEach((el, i) => {
  el._rect = { left: 10, top: 100 + i * 48, width: 220, height: 40 };
  /* 模拟平台行为：点中哪条，高亮就移到哪条 */
  el.addEventListener('click', () => {
    items.forEach((o) => {
      o.className = 'chapter-item';
    });
    el.className = 'chapter-item active';
  });
  catalog.appendChild(el);
});

video.currentSrc = 'https://x/lesson2.mp4';
video.paused = true;
video.ended = true;
await sleep(2600);
check(
  '目录模式点下一讲',
  (items[3].clickCount || 0) === 1 && (items[2].clickCount || 0) === 0 && (items[0].clickCount || 0) === 0,
  `第4讲=${items[3].clickCount || 0} 第3讲=${items[2].clickCount || 0} 第1讲=${items[0].clickCount || 0}`
);

/* 模拟点进去后新视频加载完成：推进链应当结束，不再继续点 */
video.currentSrc = 'https://x/lesson3.mp4';
video.ended = false;
video.paused = false;
video.readyState = 4;
await sleep(1400);
check('进入新视频后停止连点', (items[4].clickCount || 0) === 0, `第5讲=${items[4].clickCount || 0}`);

/* 7) 下一个知识点是 PPT：没有新视频 → 停留后自动继续到再下一项 */
video.paused = true;
video.ended = true;
await sleep(4500);
check(
  '无视频项（PPT）自动跳过',
  (items[4].clickCount || 0) === 1 && (items[5].clickCount || 0) === 1,
  `第5讲=${items[4].clickCount || 0} 第6讲=${items[5].clickCount || 0}`
);

/* 第6讲是视频：加载完成后推进链结束，不许回头点第3讲 */
video.currentSrc = 'https://x/lesson6.mp4';
video.ended = false;
video.paused = false;
await sleep(1400);
check(
  'PPT 之后接上视频',
  (items[5].clickCount || 0) === 1 && (items[2].clickCount || 0) === 0,
  `第6讲=${items[5].clickCount || 0} 第3讲=${items[2].clickCount || 0}`
);

/* 8) 按"当前正在学的知识点"标题定位，再取它后面那一条 */
items.forEach((el) => {
  el.className = 'chapter-item';
});
const heading = new El('div');
heading.className = 'page-title';
heading.textContent = '第5讲 小结';
heading._fontSize = '26px';
heading._rect = { left: 700, top: 60, width: 320, height: 40 };
document._register(heading);

video.currentSrc = 'https://x/lesson9.mp4';
video.ended = true;
video.paused = true;
await sleep(2600);
check('按标题定位当前项', (items[5].clickCount || 0) === 2, `第6讲点击=${items[5].clickCount || 0}`);

document._nodes = document._nodes.filter((n) => n !== heading);

/* 8.5) 试运行开关打开时只提示、不点击 */
setSetting('catalogDryRun', true);
const clicksBefore = items.reduce((s, el) => s + (el.clickCount || 0), 0);
video.paused = true;
video.ended = true;
await sleep(2600);
const clicksAfter = items.reduce((s, el) => s + (el.clickCount || 0), 0);
check('试运行不点击', clicksAfter === clicksBefore, `${clicksBefore} → ${clicksAfter}`);

/* 9) 视频播完后先打开同知识点的 PPT，而不是直接跳下一个条目 */
setSetting('catalogDryRun', false);
setSetting('pptDwellMs', 6000);

const docCard = new El('div');
docCard.className = 'resource-card';
docCard.textContent = '3 专题三 辩证唯物主义认识论.pptx';
docCard._rect = { left: 400, top: 900, width: 600, height: 120 };
document._register(docCard);

video.currentSrc = 'https://x/lesson7.mp4';
video.ended = true;
video.paused = true;
const beforeDoc = items.reduce((s, el) => s + (el.clickCount || 0), 0);
await sleep(1600);
check(
  '先打开文档资源再切条目',
  (docCard.clickCount || 0) === 1 &&
    items.reduce((s, el) => s + (el.clickCount || 0), 0) === beforeDoc,
  `pptx=${docCard.clickCount || 0} 目录=${beforeDoc} → ${items.reduce((s, el) => s + (el.clickCount || 0), 0)}`
);

/* 10) 可见条目全学完后，应展开折叠的知识单元并继续 */
document._nodes = document._nodes.filter((n) => n !== docCard);
items.forEach((el) => {
  el.textContent = el.textContent.replace(/必学 \d+\/\d+/, '必学 2/2');
});

const newLeaves = [];
const groupHeader = new El('div');
groupHeader.className = 'group-title';
groupHeader.textContent = '知识单元 真理和价值的辩证关系';
groupHeader._rect = { left: 20, top: 1400, width: 300, height: 40 };
groupHeader.addEventListener('click', () => {
  if (newLeaves.length) return;
  ['真理的绝对性与相对性 必学 0/2', '价值评价的功能 必学 0/2'].forEach((t, i) => {
    const el = new El('div');
    el.className = 'chapter-item';
    el.textContent = t;
    el._rect = { left: 40, top: 1460 + i * 48, width: 260, height: 40 };
    /* 和真实平台一致：点中哪条，高亮就移到哪条。缺了这一步，
       推进一步后"当前项"不变，扩展会被判定为"还在同一条"而重复点击。 */
    el.addEventListener('click', () => {
      [...items, ...newLeaves].forEach((o) => {
        o.className = 'chapter-item';
      });
      el.className = 'chapter-item active';
    });
    catalog.appendChild(el);
    newLeaves.push(el);
  });
});
document._register(groupHeader);

video.currentSrc = 'https://x/lesson8.mp4';
video.ended = true;
video.paused = true;
await sleep(4500);
check(
  '折叠单元自动展开并继续',
  (groupHeader.clickCount || 0) === 1 && (newLeaves[0]?.clickCount || 0) === 1,
  `展开=${groupHeader.clickCount || 0} 新条目=${newLeaves[0]?.clickCount || 0}`
);

/* 11) 资源卡片的缩略图也是 <video>，不能被当成播放器提前结束推进 */
const thumb = new FakeVideo();
thumb._rect = { left: 400, top: 900, width: 200, height: 120 };
thumb.paused = false;
thumb.readyState = 4;
thumb.ended = false;
thumb.currentSrc = 'https://x/thumb.mp4';
document._register(thumb);

setSetting('pptDwellMs', 300);
setSetting('videoWaitMs', 500);

const totalBefore = [...items, ...newLeaves].reduce((s, el) => s + (el.clickCount || 0), 0);

video.currentSrc = 'https://x/lesson10.mp4';
video.ended = true;
video.paused = true;
await sleep(2600);
const totalAfter = [...items, ...newLeaves].reduce((s, el) => s + (el.clickCount || 0), 0);
check(
  '缩略图视频不算播放器',
  (thumb.playCalls || 0) === 0 && totalAfter === totalBefore + 1,
  `缩略图play=${thumb.playCalls || 0} 点击 ${totalBefore}→${totalAfter}`
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
