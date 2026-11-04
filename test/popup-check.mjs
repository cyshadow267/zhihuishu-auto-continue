/* popup.html 的结构自检：确认每个开关的点击层都能收到事件 */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/popup.html', import.meta.url), 'utf8');

let failed = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
};

/* 1) 每个开关块都要同时有 checkbox 和 .slider，否则 visually 有、逻辑上没有 */
const switchBlocks = [...html.matchAll(/<div class="switch">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
check('switch 块数量 > 0', switchBlocks.length > 0, `${switchBlocks.length} 个`);

const broken = switchBlocks.filter(
  (b) => !/type="checkbox"/.test(b) || !/class="slider"/.test(b)
);
check('每个开关都含 checkbox + slider', broken.length === 0, `异常 ${broken.length} 个`);

/* 2) input 必须铺满、置顶，否则点到的是下面的 span */
const inputRule = html.match(/\.switch input\s*\{([\s\S]*?)\}/);
check('.switch input 规则存在', !!inputRule);
if (inputRule) {
  const r = inputRule[1];
  check('input 宽度铺满', /width:\s*100%/.test(r));
  check('input 高度铺满', /height:\s*100%/.test(r));
  check('input 铺满定位', /inset:\s*0/.test(r));
  check('input 压在视觉层之上', /z-index:\s*2/.test(r));
  check('input 仍可点击', !/pointer-events:\s*none/.test(r));
}

/* 3) 视觉层不能吃点击（只认独立的 .slider 规则，别抓到 ".xx + .slider" 那种） */
const sliderRule = html.match(/^[ \t]*\.slider\s*\{([\s\S]*?)\}/m);
check('.slider 不吃点击', !!sliderRule && /pointer-events:\s*none/.test(sliderRule[1]));

/* 4) popup.js 引用的 id 必须在 html 里存在，否则脚本会在 render 处抛错 */
const js = readFileSync(new URL('../src/popup.js', import.meta.url), 'utf8');
const ids = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
const missing = [...new Set(ids)].filter((id) => !new RegExp(`id="${id}"`).test(html));
check('popup.js 引用的 id 都存在', missing.length === 0, missing.join(', ') || '全部命中');

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed ? 1 : 0);
