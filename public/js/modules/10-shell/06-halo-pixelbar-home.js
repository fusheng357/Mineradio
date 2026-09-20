'use strict';

var haloHomeState = {
  enabled: false,
  color: 'white',
  supported: true,
  connected: false,
  devTools: false,
  bound: false,
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
}

function haloHomeApplyStatus(status) {
  if (!status) return;
  haloHomeState.enabled = !!status.enabled;
  haloHomeState.supported = !!status.supported;
  haloHomeState.connected = !!status.connected;
  if (status.settings && status.settings.color) haloHomeState.color = status.settings.color;
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