/* 自动续播 · 智慧树 —— 弹窗逻辑 */
'use strict';

const DEFAULTS = {
  enabled: true,
  autoResume: true,
  autoNext: true,
  resumeDelayMs: 2000,
  playbackRate: 1.0,
  nextSelector: '',
  showBadge: true,
  nextStrategy: 'auto',
  catalogDryRun: true,
  catalogItemSelector: '',
  pptDwellMs: 8000,
  videoWaitMs: 12000
};

const $ = (id) => document.getElementById(id);

const ui = {
  enabled: $('enabled'),
  autoResume: $('autoResume'),
  autoNext: $('autoNext'),
  resumeDelay: $('resumeDelay'),
  delayLabel: $('delayLabel'),
  playbackRate: $('playbackRate'),
  nextSelector: $('nextSelector'),
  showBadge: $('showBadge'),
  nextStrategy: $('nextStrategy'),
  catalogDryRun: $('catalogDryRun'),
  catalogItemSelector: $('catalogItemSelector'),
  pptDwell: $('pptDwell'),
  pptDwellLabel: $('pptDwellLabel'),
  resumeNow: $('resumeNow'),
  dot: $('dot'),
  statusText: $('statusText')
};

/* ------------------------------------------------------------------ 读写配置 */

function render(cfg) {
  ui.enabled.checked = !!cfg.enabled;
  ui.autoResume.checked = !!cfg.autoResume;
  ui.autoNext.checked = !!cfg.autoNext;
  ui.resumeDelay.value = String(cfg.resumeDelayMs / 1000);
  ui.delayLabel.textContent = (cfg.resumeDelayMs / 1000).toFixed(1) + 's';
  ui.playbackRate.value = String(cfg.playbackRate);
  ui.nextSelector.value = cfg.nextSelector || '';
  ui.showBadge.checked = !!cfg.showBadge;
  ui.nextStrategy.value = cfg.nextStrategy || 'auto';
  ui.catalogDryRun.checked = !!cfg.catalogDryRun;
  ui.catalogItemSelector.value = cfg.catalogItemSelector || '';
  ui.pptDwell.value = String(cfg.pptDwellMs / 1000);
  ui.pptDwellLabel.textContent = Math.round(cfg.pptDwellMs / 1000) + 's';
}

function save(patch) {
  chrome.storage.sync.set(patch);
}

async function loadConfig() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  render(cfg);
  return cfg;
}

/* -------------------------------------------------------------------- 状态 */

function setStatus(text, kind) {
  ui.statusText.textContent = text;
  ui.dot.className = 'dot' + (kind ? ' ' + kind : '');
}

async function refreshStatus() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    setStatus('无法读取当前标签页', 'warn');
    return;
  }
  if (!tab || !tab.id) {
    setStatus('无法读取当前标签页', 'warn');
    return;
  }
  if (!/zhihuishu\.com/i.test(tab.url || '')) {
    setStatus('当前不是智慧树页面', 'warn');
    ui.resumeNow.disabled = true;
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'zap:status' });
    if (!res || !res.ok) throw new Error('no response');
    ui.resumeNow.disabled = !res.hasVideo;
    if (!res.hasVideo) {
      setStatus('页面里没找到 video 元素', 'warn');
    } else if (res.quiz) {
      setStatus('检测到弹题，续播已暂停', 'warn');
    } else if (res.ended) {
      setStatus('当前视频已结束', 'warn');
    } else if (res.paused) {
      setStatus('已暂停，等待自动续播', 'on');
    } else {
      setStatus(`播放中 ${fmt(res.time)} / ${fmt(res.duration)}`, 'on');
    }
  } catch (e) {
    setStatus('页面脚本未就绪，刷新页面后重试', 'warn');
    ui.resumeNow.disabled = true;
  }
}

function fmt(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

/* -------------------------------------------------------------------- 事件 */

ui.enabled.addEventListener('change', () => {
  save({ enabled: ui.enabled.checked });
  refreshStatus();
});

ui.autoResume.addEventListener('change', () => save({ autoResume: ui.autoResume.checked }));
ui.autoNext.addEventListener('change', () => save({ autoNext: ui.autoNext.checked }));
ui.showBadge.addEventListener('change', () => save({ showBadge: ui.showBadge.checked }));

ui.resumeDelay.addEventListener('input', () => {
  const seconds = Number(ui.resumeDelay.value);
  ui.delayLabel.textContent = seconds.toFixed(1) + 's';
  save({ resumeDelayMs: Math.round(seconds * 1000) });
});

ui.playbackRate.addEventListener('change', () => {
  save({ playbackRate: Number(ui.playbackRate.value) });
});

ui.nextSelector.addEventListener('change', () => {
  save({ nextSelector: ui.nextSelector.value.trim() });
});

ui.nextStrategy.addEventListener('change', () => save({ nextStrategy: ui.nextStrategy.value }));

ui.catalogDryRun.addEventListener('change', () => save({ catalogDryRun: ui.catalogDryRun.checked }));

ui.catalogItemSelector.addEventListener('change', () => {
  save({ catalogItemSelector: ui.catalogItemSelector.value.trim() });
});

ui.pptDwell.addEventListener('input', () => {
  const seconds = Number(ui.pptDwell.value);
  ui.pptDwellLabel.textContent = Math.round(seconds) + 's';
  save({ pptDwellMs: Math.round(seconds * 1000) });
});

ui.resumeNow.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'zap:resume' });
    }
  } catch (e) {
    setStatus('发送指令失败，刷新页面后重试', 'warn');
  }
  setTimeout(refreshStatus, 400);
});

/* -------------------------------------------------------------------- 启动 */

(async function init() {
  try {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {
    $('ver').textContent = '';
  }
  await loadConfig();
  await refreshStatus();
  setInterval(refreshStatus, 1000);
})();
