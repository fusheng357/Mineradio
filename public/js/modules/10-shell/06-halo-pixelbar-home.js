'use strict';

var haloHomeState = {
  enabled: false,
  color: 'white',
  restoreUiModel: 'clock',
  supported: true,
  connected: false,
  devTools: false,
  bound: false,
};

var HALO_THEME_LABELS = {
  clock: '时钟', game: '游戏', work: '工作', read: '阅读',
  cats: '猫咪', dogs: '狗狗', memes: '表情', cyber: '赛博', waves: '波浪',
};

function haloHomeApi() {
  return window.desktopWindow || null;
}

function haloHomeRender() {
  var sw = document.getElementById('halo-enable-switch');
  if (sw) {
    sw.classList.toggle('on', !!haloHomeState.enabled);
    sw.setAttribute('aria-checked', haloHomeState.enabled ? 'true' : 'false');
  }
  var status = document.getElementById('halo-status-text');
  if (status) {
    if (!haloHomeState.supported) status.textContent = '未检测到 node-hid 依赖，请先安装依赖后重启';
    else if (!haloHomeState.enabled) status.textContent = '已关闭';
    else if (haloHomeState.connected) status.textContent = '已连接，正在同步歌词';
    else status.textContent = '已开启，但未找到设备（请用 USB 声卡模式连接，并以管理员身份运行）';
  }
  var swatches = document.querySelectorAll('#halo-color-row .mr-color-swatch');
  for (var i = 0; i < swatches.length; i += 1) {
    swatches[i].classList.toggle('active', swatches[i].getAttribute('data-halo-color') === haloHomeState.color);
  }
  var dt = document.getElementById('devtools-switch');
  if (dt) {
    dt.classList.toggle('on', !!haloHomeState.devTools);
    dt.setAttribute('aria-checked', haloHomeState.devTools ? 'true' : 'false');
  }
  var themeSel = document.getElementById('halo-theme-select');
  if (themeSel) themeSel.value = haloHomeState.restoreUiModel || '';
}

function haloHomeApplyStatus(status) {
  if (!status) return;
  haloHomeState.enabled = !!status.enabled;
  haloHomeState.supported = !!status.supported;
  haloHomeState.connected = !!status.connected;
  if (status.settings && status.settings.color) haloHomeState.color = status.settings.color;
  if (status.settings && status.settings.restoreUiModel != null) {
    haloHomeState.restoreUiModel = status.settings.restoreUiModel || '';
  }
  haloHomeRender();
}

function haloHomeRefreshStatus() {
  var api = haloHomeApi();
  if (!api || typeof api.getHaloPixelBarStatus !== 'function') {
    haloHomeState.supported = false;
    haloHomeRender();
    return;
  }
  api.getHaloPixelBarStatus().then(function (res) {
    haloHomeApplyStatus(res && res.status);
  }).catch(function () { });
}

function haloHomeInitDevTools() {
  var api = haloHomeApi();
  if (!api || typeof api.getDevToolsEnabled !== 'function') return;
  api.getDevToolsEnabled().then(function (res) {
    haloHomeState.devTools = !!(res && res.enabled);
    haloHomeRender();
  }).catch(function () { });
}

function toggleHaloPixelBarFromHome() {
  var api = haloHomeApi();
  if (!api || typeof api.setHaloPixelBarEnabled !== 'function') {
    if (typeof showToast === 'function') showToast('当前环境不支持 Halo PixelBar');
    return;
  }
  var next = !haloHomeState.enabled;
  api.setHaloPixelBarEnabled(next, { color: haloHomeState.color }).then(function (res) {
    haloHomeApplyStatus(res && res.status);
  }).catch(function () { });
}

function selectHaloPixelBarColor(color) {
  haloHomeState.color = String(color || 'white');
  haloHomeRender();
  var api = haloHomeApi();
  if (api && typeof api.configureHaloPixelBar === 'function') {
    api.configureHaloPixelBar({ color: haloHomeState.color }).then(function (res) {
      haloHomeApplyStatus(res && res.status);
    }).catch(function () { });
  }
}

// 选择暂停/退出时切回的设备自带主题（UI 模式包：时钟/游戏/工作/阅读/猫咪/狗狗/表情/赛博/波浪；''=仅清屏）。
function selectHaloPixelBarTheme(model) {
  var next = String(model == null ? '' : model);
  haloHomeState.restoreUiModel = next;
  haloHomeRender();
  var api = haloHomeApi();
  if (api && typeof api.configureHaloPixelBar === 'function') {
    api.configureHaloPixelBar({ restoreUiModel: next }).then(function (res) {
      haloHomeApplyStatus(res && res.status);
      if (typeof showToast === 'function') {
        showToast(next ? ('已设置切回主题：' + (HALO_THEME_LABELS[next] || next)) : '已设置暂停/退出仅清屏');
      }
    }).catch(function () { });
  }
}

// ===== 顶部小音箱按钮 + 浮层面板（放在登录按钮旁，对齐 nxz1026/Mineradio 的交互） =====
function setHaloPanelOpen(open) {
  var panel = document.getElementById('halo-panel');
  var fab = document.getElementById('halo-fab');
  if (!panel) return;
  panel.classList.toggle('show', !!open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (fab) {
    fab.classList.toggle('active', !!open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // 打开时刷新一次状态，确保开关/颜色/连接信息与主进程一致。
  if (open) { haloHomeRefreshStatus(); haloHomeInitDevTools(); }
}

function toggleHaloPanel(evt) {
  if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
  var panel = document.getElementById('halo-panel');
  setHaloPanelOpen(!(panel && panel.classList.contains('show')));
}

function bindHaloPanelDismiss() {
  document.addEventListener('click', function (e) {
    var panel = document.getElementById('halo-panel');
    if (!panel || !panel.classList.contains('show')) return;
    var fab = document.getElementById('halo-fab');
    if (panel.contains(e.target) || (fab && fab.contains(e.target))) return;
    setHaloPanelOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var panel = document.getElementById('halo-panel');
    if (panel && panel.classList.contains('show')) setHaloPanelOpen(false);
  });
}

function toggleDevToolsShortcutFromHome() {
  var api = haloHomeApi();
  if (!api || typeof api.setDevToolsEnabled !== 'function') return;
  var next = !haloHomeState.devTools;
  api.setDevToolsEnabled(next).then(function (res) {
    haloHomeState.devTools = !!(res && res.enabled);
    haloHomeRender();
    if (typeof showToast === 'function') showToast(haloHomeState.devTools ? '已开启 F12 开发者工具' : '已关闭 F12 开发者工具');
  }).catch(function () { });
}

function bindHaloPixelBarHome() {
  if (haloHomeState.bound) return;
  haloHomeState.bound = true;
  bindHaloPanelDismiss();
  haloHomeInitDevTools();
  haloHomeRefreshStatus();
  var api = haloHomeApi();
  if (api && typeof api.onHaloPixelBarState === 'function') {
    try {
      api.onHaloPixelBarState(function (status) { haloHomeApplyStatus(status); });
    } catch (_) { /* noop */ }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindHaloPixelBarHome);
} else {
  bindHaloPixelBarHome();
}