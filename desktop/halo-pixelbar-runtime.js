'use strict';

/**
 * 漫步者花再 Halo PixelBar（增强版 / 26 年新款）USB-HID 歌词屏运行时。
 *
 * 协议移植自：
 *  - nxz1026/HaloLyricSync (Python)
 *  - XFEstudio/HaloPixelToolBox (C#)
 *
 * 关键点（增强版能正常推送的原因）：
 *  1. 固定 64 字节裸包，写入时 **不额外添加 report id 前缀**（首字节 0x2E 即魔数）。
 *  2. 文本包魔数 2E AA EC E8 + 颜色字节 + uint16LE(总长) + 文本长度 + UTF-8 文本 + 校验和。
 *  3. 校验和: acc = 128; 每字节 acc += b + 2; 结果 % 256。
 *  4. 通过设备名关键字自动发现，并用“写入探测包”找到可写的 HID 接口。
 */

const fs = require('fs');
const path = require('path');

const PACKET_LENGTH = 64;
// 文本包固定 64 字节：魔数(4)+颜色(1)+总长(2)+文本长(1)+文本(N)+校验和(1)=9+N，
// 故文本字节数硬上限为 55；此处留 1 字节余量取 54，避免边界挤掉校验和（对齐 nxz1026/Mineradio）。
const MAX_TEXT_BYTES = 54;
// 旧版本默认按 20 显示宽度截断（仅 10 个中文字）。设备实际支持 16 个中文字（32 显示宽度），
// 加载旧配置时把该遗留默认值迁移到新默认，确保已开启功能的用户也能显示满 16 字。
const LEGACY_DEFAULT_MAX_LENGTH = 20;
const DEVICE_KEYWORDS = ['halo', 'pixel', '花再', 'pixelbar', 'edifier'];

const TEXT_COLOR = {
  white: 0, red: 1, green: 2, blue: 3, yellow: 4, cyan: 5, magenta: 6,
};

const LAYOUT_HEADER = Buffer.from([0x2E, 0xAA, 0xEC, 0xEF, 0x00, 0x09, 0x01, 0xF0, 0xB4, 0xC8, 0x00, 0x02, 0x00]);
const LAYOUT_BYTES = {
  left: Buffer.from([0x00, 0xFF, 0xFC, 0x00]),
  center: Buffer.from([0x01, 0xFF, 0xFD, 0x00]),
  right: Buffer.from([0x02, 0xFF, 0xFE, 0x00]),
  stretch: Buffer.from([0x03, 0xFF, 0xFF, 0x00]),
  scroll_left_to_right: Buffer.from([0x00, 0xFF, 0xFD, 0x00]),
  scroll_right_to_left: Buffer.from([0x01, 0xFF, 0xFE, 0x00]),
};
const UI_MODEL_HEADER = Buffer.from([0x2E, 0xAA, 0xEC, 0xEF, 0x00, 0x09, 0x02, 0xF0, 0xB4, 0xC8, 0x00, 0x01]);
const UI_MODEL_BYTES = {
  clock: Buffer.from([0x00, 0xFF, 0xFF, 0xFB, 0x00]),
  game: Buffer.from([0x01, 0xFF, 0xFF, 0xFC, 0x00]),
  work: Buffer.from([0x02, 0xFF, 0xFF, 0xFD, 0x00]),
  read: Buffer.from([0x03, 0xFF, 0xFF, 0xFE, 0x00]),
  cats: Buffer.from([0x04, 0xFF, 0xFF, 0xFF, 0x00]),
  dogs: Buffer.from([0x05, 0xFF, 0xFF, 0x00, 0x00]),
  memes: Buffer.from([0x06, 0xFF, 0xFF, 0x01, 0x00]),
  cyber: Buffer.from([0x07, 0xFF, 0xFF, 0x02, 0x00]),
  waves: Buffer.from([0x08, 0xFF, 0xFF, 0x03, 0x00]),
};

// 校验是否是设备支持的自带主题（clock=时间 / game / work / read / cats / dogs / memes / cyber / waves）。
function isValidUiModel(model) {
  return Object.prototype.hasOwnProperty.call(UI_MODEL_BYTES, String(model == null ? '' : model));
}

// HID 写入探测包（与 Python _WRITE_TEST_PKT 一致）
const WRITE_TEST_PKT = Buffer.concat([
  Buffer.from([0x2E, 0xAA, 0xEC, 0xE8, 0x00, 0x06, 0x00, 0x04]),
  Buffer.alloc(PACKET_LENGTH - 8),
]);

const DEFAULT_SETTINGS = {
  enabled: false,
  color: 'white',
  maxLength: 32,          // 按“显示宽度”截断（CJK 记 2）→ 最多 16 个中文字（设备官方上限）
  scrollThreshold: 15,    // 超过此显示宽度切换到右滚布局（超出屏幕静态可视宽度即滚动展示整行）
  showSongInfo: true,
  songInfoDurationMs: 3000,
  showProgress: false,
  devicePath: '',
  idleClockAfterMs: 30000, // 长时间无歌词切回时钟主题（0 = 关闭）
  pauseClockAfterMs: 1200, // 暂停持续多久后切回时钟主题（0 = 立即；用于过滤切歌/缓冲的瞬时暂停）
  restoreOnPause: true,    // 歌曲暂停时把像素屏切回设备自带主题（如时钟），而非停留在歌词
  restoreUiModel: 'clock', // 退出/关闭/暂停时把设备恢复到此自带主题（clock/game/work/read/cats/dogs/memes/cyber/waves；'' = 仅清屏，不切主题）
  restoreOnExit: true,     // 退出 APP 时把像素屏交还给用户之前设置的内容，而非停留在歌词
  pauseClockRetryMs: 1500, // 暂停后“建立期”内重复下发切主题指令的间隔（设备需静默期才接受，故需重试）
  pauseClockMaxMs: 60000,  // 暂停后的“建立期”时长：此窗口内用较快间隔完整重试切主题，确保被设备接收
  pauseClockMaintainMs: 5000, // 建立期结束后的“维持期”间隔：只要仍暂停就持续补发主题包，直到恢复播放（不再中途放弃）
  exitClockAttempts: 3,    // 退出时下发“切时钟”指令的次数（配合静默间隔，确保被设备接收）
  exitClockIntervalMs: 600,// 退出切时钟每次下发之间的静默间隔（兼作写入刷新等待）
};

function checksum(textBuf) {
  let acc = 128;
  for (let i = 0; i < textBuf.length; i += 1) acc += textBuf[i] + 2;
  return acc % 256;
}

function padPacket(buf) {
  if (buf.length >= PACKET_LENGTH) return Buffer.from(buf.subarray(0, PACKET_LENGTH));
  const out = Buffer.alloc(PACKET_LENGTH);
  buf.copy(out, 0);
  return out;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });

// 同步等待：Node 主线程允许 Atomics.wait。仅用于退出/重启等即将结束进程的极短阻塞，
// 目的是在断开 HID 前给设备留出“文本静默 + 写入刷新”的时间，避免切时钟指令被忽略或丢包。
function sleepSync(ms) {
  const wait = Math.max(0, Number(ms) || 0);
  if (!wait) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch (_) {
    const end = Date.now() + wait;
    while (Date.now() < end) { /* busy wait fallback */ }
  }
}

function charWidth(code) {
  if (
    (code >= 0x1100 && code <= 0x115F)
    || (code >= 0x2E80 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE6F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1FAFF)
    || (code >= 0x20000 && code <= 0x3FFFD)
  ) return 2;
  return 1;
}

function displayWidth(str) {
  let w = 0;
  for (const ch of String(str == null ? '' : str)) w += charWidth(ch.codePointAt(0));
  return w;
}

function truncateByWidth(str, maxWidth) {
  let out = '';
  let w = 0;
  for (const ch of String(str == null ? '' : str)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * 同时按“显示宽度”（CJK 记 2）与 UTF-8 字节数截断文本。
 *  - 显示宽度决定最多显示多少字：maxLength=32 → 16 个中文字（设备官方上限）。
 *  - 字节数保证不撑破 64 字节裸包：emoji 等“宽度 2 却占 4 字节”的字符需额外约束。
 * 两者任一先到上限即停止，确保既能显示满 16 字，又不会因超长而丢校验和。
 */
function fitText(str, maxWidth, maxBytes) {
  const widthLimit = Number.isFinite(Number(maxWidth)) ? Number(maxWidth) : DEFAULT_SETTINGS.maxLength;
  const byteLimit = Number.isFinite(Number(maxBytes)) ? Number(maxBytes) : MAX_TEXT_BYTES;
  let out = '';
  let w = 0;
  let bytes = 0;
  for (const ch of String(str == null ? '' : str)) {
    const cw = charWidth(ch.codePointAt(0));
    const cb = Buffer.byteLength(ch, 'utf8');
    if (w + cw > widthLimit || bytes + cb > byteLimit) break;
    out += ch;
    w += cw;
    bytes += cb;
  }
  return out;
}

function buildTextPacket(text, colorName) {
  const colorValue = Object.prototype.hasOwnProperty.call(TEXT_COLOR, String(colorName || 'white').toLowerCase())
    ? TEXT_COLOR[String(colorName).toLowerCase()] : 0;
  // 防御：绝不允许文本字节超出裸包容量，否则 64 字节截断会挤掉校验和导致设备拒收/乱码。
  let textStr = String(text == null ? '' : text);
  while (Buffer.byteLength(textStr, 'utf8') > MAX_TEXT_BYTES && textStr.length) textStr = textStr.slice(0, -1);
  const textBuf = Buffer.from(textStr, 'utf8');
  const textLen = textBuf.length;
  const totalLen = 1 + textLen + 1;
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(totalLen & 0xFFFF, 0);
  const body = Buffer.concat([
    Buffer.from([0x2E, 0xAA, 0xEC, 0xE8, colorValue & 0xFF]),
    lenBuf,
    Buffer.from([textLen & 0xFF]),
    textBuf,
    Buffer.from([checksum(textBuf)]),
  ]);
  return padPacket(body);
}

function buildLayoutPacket(layout) {
  const bytes = LAYOUT_BYTES[layout] || LAYOUT_BYTES.center;
  return padPacket(Buffer.concat([LAYOUT_HEADER, bytes]));
}

function buildUiModelPacket(model) {
  const bytes = UI_MODEL_BYTES[model] || UI_MODEL_BYTES.clock;
  return padPacket(Buffer.concat([UI_MODEL_HEADER, bytes]));
}

// 切回设备自带主题统一走 buildUiModelPacket（UI 模式包：cmd 0xEF、byte[6]=02、子命令 00 01），
// 与 HaloLyricSync 的 set_ui_mode / build_ui_model 字节完全一致，是设备“专属的切主题指令”。

class HaloPixelBarRuntime {
  constructor(options = {}) {
    this.userDataPath = options.userDataPath || '';
    this.settingsFile = this.userDataPath ? path.join(this.userDataPath, 'halo-pixelbar-settings.json') : '';
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.hid = null;
    this.hidAvailable = false;
    this.hidError = '';
    this.device = null;
    this.deviceInfo = null;
    this.connected = false;
    this.lastText = '';
    this.lastSongKey = '';
    this.scrollMode = false;
    this.clockMode = false;
    this.transitionUntil = 0;
    this.lastLyricAt = 0;
    this.lastTextPushAt = 0;
    this.pausedAt = 0;
    this.lastClockAttemptAt = 0;
    this.disposed = false;
    this.exiting = false;
    this.exitRestored = false;
    this.lastError = '';
    this.onState = typeof options.onState === 'function' ? options.onState : null;
    this._loadHid();
    this._loadSettings();
  }

  _loadHid() {
    try {
      // eslint-disable-next-line global-require
      this.hid = require('node-hid');
      this.hidAvailable = true;
    } catch (e) {
      this.hidAvailable = false;
      this.hidError = (e && e.message) ? e.message : String(e);
    }
  }

  _loadSettings() {
    if (!this.settingsFile) return;
    try {
      if (fs.existsSync(this.settingsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
        // 迁移遗留默认：旧版 maxLength=20（仅 10 个中文字）升级到 32（16 个中文字）。
        if (raw && Number(raw.maxLength) === LEGACY_DEFAULT_MAX_LENGTH) {
          this.settings.maxLength = DEFAULT_SETTINGS.maxLength;
        }
      }
    } catch (e) {
      this.lastError = 'SETTINGS_LOAD_FAILED: ' + ((e && e.message) || e);
    }
  }

  _saveSettings() {
    if (!this.settingsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8');
    } catch (e) {
      this.lastError = 'SETTINGS_SAVE_FAILED: ' + ((e && e.message) || e);
    }
  }

  _emitState() {
    if (this.onState) {
      try { this.onState(this.getStatus()); } catch (_) { /* noop */ }
    }
  }

  listDevices() {
    if (!this.hidAvailable) return { ok: false, supported: false, error: this.hidError || 'NODE_HID_UNAVAILABLE', devices: [] };
    try {
      const devices = this.hid.devices().map((d) => {
        const name = `${d.product || ''} ${d.manufacturer || ''}`.toLowerCase();
        return {
          path: d.path,
          vendorId: d.vendorId,
          productId: d.productId,
          product: d.product || '',
          manufacturer: d.manufacturer || '',
          release: d.release,
          interface: d.interface,
          usagePage: d.usagePage,
          usage: d.usage,
          matched: DEVICE_KEYWORDS.some((k) => name.indexOf(k) >= 0),
        };
      });
      return { ok: true, supported: true, devices };
    } catch (e) {
      return { ok: false, supported: true, error: (e && e.message) || String(e), devices: [] };
    }
  }

  _findHaloDevices() {
    const result = this.listDevices();
    if (!result.ok) return [];
    return result.devices.filter((d) => d.matched);
  }

  connect(forcedPath) {
    if (!this.hidAvailable) {
      this.lastError = this.hidError || 'NODE_HID_UNAVAILABLE';
      this._emitState();
      return false;
    }
    if (this.connected && this.device) return true;

    let candidates = [];
    const wanted = forcedPath || this.settings.devicePath || '';
    if (wanted) {
      const all = this.listDevices();
      candidates = (all.devices || []).filter((d) => d.path === wanted);
      if (!candidates.length) candidates = this._findHaloDevices();
    } else {
      candidates = this._findHaloDevices();
    }
    if (!candidates.length) {
      this.lastError = 'DEVICE_NOT_FOUND';
      this.connected = false;
      this._emitState();
      return false;
    }

    for (const cand of candidates) {
      let dev = null;
      try {
        dev = new this.hid.HID(cand.path);
        // 非阻塞写入：与参考实现一致，避免设备忙时写入阻塞主进程。
        try { if (typeof dev.setNonBlocking === 'function') dev.setNonBlocking(1); } catch (_) { /* noop */ }
        // 写入探测：验证该接口可写（增强版会暴露多个 HID 接口）
        dev.write(WRITE_TEST_PKT);
        this.device = dev;
        this.deviceInfo = cand;
        this.connected = true;
        this.lastError = '';
        this.lastText = '';
        this.scrollMode = false;
        this.clockMode = false;
        this._emitState();
        return true;
      } catch (e) {
        this.lastError = 'WRITE_PROBE_FAILED: ' + ((e && e.message) || e);
        try { if (dev) dev.close(); } catch (_) { /* noop */ }
      }
    }
    this.connected = false;
    this._emitState();
    return false;
  }

  disconnect() {
    if (this.device) {
      try { this.device.close(); } catch (_) { /* noop */ }
    }
    this.device = null;
    this.deviceInfo = null;
    this.connected = false;
    this.lastText = '';
    this.scrollMode = false;
    this.clockMode = false;
  }

  _sendPacket(buf) {
    if (!this.connected || !this.device) return false;
    try {
      this.device.write(buf);
      return true;
    } catch (e) {
      // 写入异常（设备重置 / 瞬时 I/O 0x3E5）：重开句柄并重试一次，避免一次失败就永久掉线，
      // 导致暂停/退出的切时钟指令再也发不出去（对齐 nxz1026/Mineradio 的 reopen 重试）。
      if (this._reopenDevice()) {
        try {
          this.device.write(buf);
          return true;
        } catch (_) { /* 落到下方失败处理 */ }
      }
      this.lastError = 'WRITE_FAILED: ' + ((e && e.message) || e);
      this.connected = false;
      try { if (this.device) this.device.close(); } catch (_) { /* noop */ }
      this.device = null;
      this._emitState();
      return false;
    }
  }

  // 关闭旧句柄并按已发现设备路径重新打开，用于写入失败后的自愈重试。
  _reopenDevice() {
    if (!this.hidAvailable) return false;
    try { if (this.device) this.device.close(); } catch (_) { /* noop */ }
    this.device = null;
    const wanted = (this.deviceInfo && this.deviceInfo.path) || this.settings.devicePath || '';
    if (!wanted) return false;
    try {
      const dev = new this.hid.HID(wanted);
      try { if (typeof dev.setNonBlocking === 'function') dev.setNonBlocking(1); } catch (_) { /* noop */ }
      this.device = dev;
      this.connected = true;
      return true;
    } catch (_) {
      this.device = null;
      return false;
    }
  }

  sendText(text, colorName) {
    const width = Number(this.settings.maxLength) || DEFAULT_SETTINGS.maxLength;
    const clipped = fitText(text, width, MAX_TEXT_BYTES);
    const packet = buildTextPacket(clipped, colorName || this.settings.color);
    const ok = this._sendPacket(packet);
    if (ok) { this.lastLyricAt = Date.now(); this.lastTextPushAt = this.lastLyricAt; }
    return ok;
  }

  setLayout(layout) {
    return this._sendPacket(buildLayoutPacket(layout));
  }

  setUiMode(model) {
    return this._sendPacket(buildUiModelPacket(model));
  }

  clearDisplay() {
    return this.sendText(' ');
  }

  /**
   * 单次下发“切回设备自带主题”指令：只发 UI 模式包（set_ui_mode）+ 复位居中布局，
   * 与 HaloLyricSync 的 _switch_to_clock_ui 完全一致（增强版实测可立即从歌词切回主题）。
   * UI 模式包（0xEF 02 子命令 00 01）就是设备“专属的切主题指令”，可选
   * clock/game/work/read/cats/dogs/memes/cyber/waves；不再发无效的空格清屏或混合“时钟/图案包”。
   */
  _sendClockOnce() {
    const model = isValidUiModel(this.settings.restoreUiModel) ? this.settings.restoreUiModel : 'clock';
    const ok = this.setUiMode(model);
    this.setLayout('center');
    this.scrollMode = false;
    this.clockMode = true;
    return ok;
  }

  /**
   * 暂停“维持期”补发主题：只发 UI 模式包（set_ui_mode），不再发居中布局包（set_text_layout）。
   * 布局包属于文本层指令，暂停期间反复下发会把设备重新拉回文本层、盖回最后一行歌词
   * （表现为“时钟闪一下又变回歌词”）。故建立期完整切一次主题后，维持期仅补发主题包保活。
   */
  _reassertClockTheme() {
    const model = isValidUiModel(this.settings.restoreUiModel) ? this.settings.restoreUiModel : 'clock';
    const ok = this.setUiMode(model);
    this.scrollMode = false;
    this.clockMode = true;
    return ok;
  }

  /**
   * 切回设备自带主题（默认 clock=时钟）。用于暂停 / 长时间无歌词。
   * 不发 clear_display——空格本身也是一层文本，会盖住主题（实测屏幕变空白却不显示时钟）。
   */
  enterClockMode(reason = 'idle') {
    const ok = this._sendClockOnce();
    this.lastText = '';
    this.transitionUntil = 0;
    return ok;
  }

  /**
   * 推送一行歌词（带去重、切歌过渡、长文本滚动布局、暂停/闲置回时钟）。
   * payload: { text, title, artist, playing, index, total }
   * playing === false 表示播放器已暂停（由渲染层随每次推送带上）。
   */
  pushLyric(payload = {}) {
    // 退出流程已 dispose：拒绝任何迟到推送，避免重新连接设备并覆盖已下发的时钟。
    if (this.disposed) return { ok: false, skipped: 'disposed' };
    // 退出静默期：before-quit 已请求停止推送，任何迟到推送都不得再刷新文本层，
    // 否则设备会一直停留在歌词、无法接受切时钟指令。
    if (this.exiting) return { ok: false, skipped: 'exiting' };
    if (!this.settings.enabled) return { ok: false, skipped: 'disabled' };
    if (!this.connected && !this.connect()) return { ok: false, error: this.lastError || 'CONNECT_FAILED' };

    const now = Date.now();
    const title = String(payload.title || '').trim();
    const artist = String(payload.artist || '').trim();
    const songKey = `${title}::${artist}`;

    // 暂停：切回设备自带主题（默认时钟），并一直维持到用户恢复播放，不要停留在最后一行歌词。
    // 设备只在“文本静默期”才接受切主题指令，且单次下发可能被忽略——因此停止推文本后按间隔重试下发。
    // 分两阶段：建立期（pauseClockMaxMs 内）用较快间隔完整切主题（UI 模式包 + 居中布局复位）；
    // 建立期后转入维持期，用较慢间隔“仅补发 UI 模式包”保活主题——绝不重复发居中布局包，
    // 因为布局包是文本层指令，会把设备重新拉回文本层、盖回歌词（表现为“时钟闪一下又变回歌词”）。
    // 维持期不再有硬上限：只要仍处于暂停就持续保活，直到恢复播放（对齐“暂停一直显示主题”的预期）。
    if (payload.playing === false && this.settings.restoreOnPause !== false) {
      if (!this.pausedAt) this.pausedAt = now;
      const settle = Number(this.settings.pauseClockAfterMs) || 0;
      const retryGap = Math.max(400, Number(this.settings.pauseClockRetryMs) || 1500);
      const establishWindow = Number(this.settings.pauseClockMaxMs) || 60000;
      const maintainGap = Math.max(retryGap, Number(this.settings.pauseClockMaintainMs) || 5000);
      const pausedFor = now - this.pausedAt;
      const gap = pausedFor <= establishWindow ? retryGap : maintainGap;
      const silence = this.lastTextPushAt ? (now - this.lastTextPushAt) : (now - this.pausedAt);
      if (silence >= settle) {
        if (!this.lastClockAttemptAt || now - this.lastClockAttemptAt >= gap) {
          this.lastClockAttemptAt = now;
          // 已建立主题则仅补发 UI 模式包保活；否则完整切一次主题（含居中布局复位）。
          if (this.clockMode) this._reassertClockTheme();
          else this.enterClockMode('paused');
        }
        return { ok: true, mode: 'paused-clock' };
      }
      // 文本静默不足（刚暂停、去抖窗口内）：保留当前画面，不刷歌词也不切主题
      return { ok: true, mode: 'pausing' };
    }
    // 播放中（含从暂停恢复）：清除暂停计时与重试计时
    this.pausedAt = 0;
    this.lastClockAttemptAt = 0;

    // 切歌检测：显示 "歌名 - 歌手" 过渡
    if (songKey && songKey !== this.lastSongKey) {
      this.lastSongKey = songKey;
      this.lastText = '';
      if (this.settings.showSongInfo && (title || artist)) {
        const info = artist ? `${title} - ${artist}` : title;
        this.setLayout('center');
        this.scrollMode = false;
        this.sendText(info);
        this.transitionUntil = now + Math.max(1000, Number(this.settings.songInfoDurationMs) || 3000);
        return { ok: true, mode: 'song-info' };
      }
      this.transitionUntil = now + 1000;
    }

    // 过渡期内不刷歌词，避免闪现旧行
    if (now < this.transitionUntil) return { ok: true, mode: 'transition' };

    let text = String(payload.text || '').replace(/\s+/g, ' ').trim();

    // 长时间无歌词 -> 时钟主题
    const idleMs = Number(this.settings.idleClockAfterMs) || 0;
    if (!text) {
      if (idleMs > 0 && this.lastLyricAt && now - this.lastLyricAt > idleMs && !this.clockMode) {
        this.enterClockMode('idle');
      }
      return { ok: true, mode: 'empty' };
    }

    // 有歌词了：若正处于时钟主题（暂停恢复 / 闲置恢复），退出并强制重绘当前行
    if (this.clockMode) {
      this.clockMode = false;
      this.lastText = '';
      this.transitionUntil = 0;
    }

    // 可选进度后缀 [当前行/总行数]
    if (this.settings.showProgress && Number(payload.total) > 1 && Number.isFinite(Number(payload.index))) {
      text = `${text}[${Number(payload.index) + 1}/${Number(payload.total)}]`;
    }

    text = fitText(text, Number(this.settings.maxLength) || DEFAULT_SETTINGS.maxLength, MAX_TEXT_BYTES);

    // 去重：暂停/进度停滞时避免刷屏
    if (text === this.lastText) return { ok: true, mode: 'dedup' };
    this.lastText = text;

    // 根据宽度决定布局：长文本右滚，短文本居中
    const w = displayWidth(text);
    if (w > (Number(this.settings.scrollThreshold) || 15)) {
      if (!this.scrollMode) { this.setLayout('scroll_right_to_left'); this.scrollMode = true; }
    } else if (this.scrollMode) {
      this.setLayout('center');
      this.scrollMode = false;
    }

    const ok = this.sendText(text);
    return { ok, mode: 'lyric' };
  }

  setEnabled(enabled, opts) {
    const next = !!enabled;
    this.settings = Object.assign({}, this.settings, opts || {}, { enabled: next });
    this._saveSettings();
    if (next) {
      this.connect();
      if (this.connected) {
        this.setLayout('center');
        this.scrollMode = false;
        this.lastText = '';
      }
    } else {
      // 关闭功能时把设备交还给用户之前设置的内容（如时钟主题），
      // 而不是停留在最后一行歌词；未指定主题则退回清屏。
      this.restoreUserContent('disable');
      this.disconnect();
    }
    this._emitState();
    return this.getStatus();
  }

  configure(opts = {}) {
    const clean = {};
    if (Object.prototype.hasOwnProperty.call(opts, 'color')) {
      const c = String(opts.color).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(TEXT_COLOR, c)) clean.color = c;
    }
    ['maxLength', 'scrollThreshold', 'songInfoDurationMs', 'idleClockAfterMs', 'pauseClockAfterMs'].forEach((k) => {
      if (opts[k] != null && Number.isFinite(Number(opts[k]))) clean[k] = Math.max(0, Number(opts[k]));
    });
    ['showSongInfo', 'showProgress', 'restoreOnPause'].forEach((k) => {
      if (opts[k] != null) clean[k] = !!opts[k];
    });
    if (typeof opts.devicePath === 'string') clean.devicePath = opts.devicePath;
    if (opts.restoreUiModel != null) {
      const model = String(opts.restoreUiModel).toLowerCase();
      clean.restoreUiModel = isValidUiModel(model) ? model : '';
    }
    if (opts.restoreOnExit != null) clean.restoreOnExit = !!opts.restoreOnExit;
    this.settings = Object.assign({}, this.settings, clean);
    this._saveSettings();
    // 颜色/布局即时生效
    if (this.connected) {
      if (clean.color) { this.lastText = ''; }
    }
    this._emitState();
    return this.getStatus();
  }

  getStatus() {
    return {
      supported: this.hidAvailable,
      hidError: this.hidError,
      enabled: !!this.settings.enabled,
      connected: !!this.connected,
      deviceName: this.deviceInfo ? (this.deviceInfo.product || 'Halo PixelBar') : '',
      devicePath: this.deviceInfo ? this.deviceInfo.path : (this.settings.devicePath || ''),
      vendorId: this.deviceInfo ? this.deviceInfo.vendorId : 0,
      productId: this.deviceInfo ? this.deviceInfo.productId : 0,
      lastError: this.lastError,
      settings: Object.assign({}, this.settings),
    };
  }

  /**
   * 退出前立即停止歌词推送，使像素屏进入“文本静默”，随后的切时钟指令才会被设备接受。
   * 由 main.js 的 before-quit 在做异步清理前同步调用。
   */
  suspendPushesForExit() {
    this.exiting = true;
  }

  // 恢复前确保设备在线：退出流程中可能已掉线，功能仍开启时尝试重连，保证恢复包能真正下发。
  _ensureConnectedForRestore() {
    if ((!this.connected || !this.device) && this.settings.enabled) {
      try { this.connect(); } catch (_) { /* noop */ }
    }
    return !!(this.connected && this.device);
  }

  // 根据设置生成恢复方案：是否切主题、重试次数、静默间隔。
  _clockRestorePlan() {
    const wantClock = isValidUiModel(this.settings.restoreUiModel);
    const attempts = wantClock ? Math.max(1, Number(this.settings.exitClockAttempts) || 3) : 1;
    const gap = wantClock ? Math.max(0, Number(this.settings.exitClockIntervalMs) || 0) : 0;
    return { wantClock, attempts, gap };
  }

  /**
   * 退出 APP 时把像素屏切回设备自带主题（默认时钟）。异步版：用于 before-quit 的清理阶段，
   * 与其他清理并行。先静默一小段（让设备退出文本模式），再按间隔多次下发切主题包，
   * 确保至少有一次落在设备可接受的窗口内；最后一次间隔兼作写入刷新等待，避免断开时丢包。
   *
   * 对齐 HaloLyricSync 的 stop()/_switch_to_clock_ui：UI 模式包（0xEF 02 子命令 00 01）是设备
   * “专属的切主题指令”；设备切回主题后仍展示用户在该主题下选定的分支样式（一个主题有多个分支）。
   * 增强版实测：空格清屏只会把屏幕盖成空白、甚至残留歌词，绝不能用它代替切主题；
   * 仅当用户选择“仅清屏”（restoreUiModel=''）时才发空格文本包。
   */
  async restoreClockForExit(opts = {}) {
    if (this.disposed) return false;
    this.exiting = true;
    if (this.settings.restoreOnExit === false) return false;
    if (!this._ensureConnectedForRestore()) return false;
    const plan = this._clockRestorePlan();
    const gap = Math.max(0, Number(opts.intervalMs != null ? opts.intervalMs : plan.gap) || 0);
    const attempts = Math.max(1, Number(opts.attempts != null ? opts.attempts : plan.attempts) || 1);
    let ok = false;
    if (!plan.wantClock) {
      // 未指定主题时至少清屏，避免退出后残留歌词。
      ok = this.clearDisplay();
      this.clockMode = false;
      this.scrollMode = false;
    } else {
      // 先复位一次居中布局（退出后不再显示歌词，故布局只需发一次），再按间隔多次补发 UI 模式包。
      // 关键：最后一个包必须是 UI 模式包（主题包）——布局包属于文本层指令，若尾随在主题包之后，
      // 会把设备重新拉回文本层、盖回最后一行歌词（表现为“退出后音响仍停留在歌词、不切回主题”）。
      // 每次 UI 模式包之前都保持静默间隔，让设备在“文本静默期”接受切主题（与暂停维持期同一原理）。
      this._ensureConnectedForRestore();
      this.setLayout('center');
      this.scrollMode = false;
      for (let i = 0; i < attempts; i += 1) {
        if (this.disposed) break;
        if (gap > 0) await sleep(gap);
        this._ensureConnectedForRestore();
        ok = this._reassertClockTheme() || ok;
      }
      if (gap > 0) await sleep(gap); // 末次下发后兼作写入刷新等待，避免断开时丢包
      this.exitRestored = true;
    }
    this.lastText = '';
    this.lastSongKey = '';
    this.transitionUntil = 0;
    return ok;
  }

  /**
   * 把像素屏切回设备自带主题（同步版）：用于 dispose / 关闭功能 / 重启（app.exit 绕过 before-quit）。
   * 与异步版同理：先静默、再按间隔多次下发切主题包（同步阻塞，时间很短）。
   */
  restoreUserContent(reason = 'restore') {
    if (!this._ensureConnectedForRestore()) return false;
    const plan = this._clockRestorePlan();
    let ok = false;
    if (!plan.wantClock) {
      ok = this.clearDisplay();
      this.clockMode = false;
      this.scrollMode = false;
    } else {
      // 同异步版：先复位一次居中布局，再多次补发 UI 模式包，且以 UI 模式包（主题包）收尾，
      // 绝不把布局包留在最后——否则设备会被拉回文本层、停留在歌词（“退出后不切回主题”）。
      this._ensureConnectedForRestore();
      this.setLayout('center');
      this.scrollMode = false;
      for (let i = 0; i < plan.attempts; i += 1) {
        if (plan.gap > 0) sleepSync(plan.gap);
        this._ensureConnectedForRestore();
        ok = this._reassertClockTheme() || ok;
      }
      if (plan.gap > 0) sleepSync(plan.gap);
      this.exitRestored = true;
    }
    this.lastText = '';
    this.lastSongKey = '';
    this.transitionUntil = 0;
    return ok;
  }

  dispose() {
    if (this.disposed) { try { this.disconnect(); } catch (_) { /* noop */ } return; }
    // 先置 disposed/exiting：before-quit 有最长 15s 异步清理，其间渲染层仍会每 320ms 推歌词。
    // 若不加标志，dispose 断开后迟到的 pushLyric 会重连并覆盖刚下发的时钟。
    this.disposed = true;
    this.exiting = true;
    try {
      // 正常退出已在 before-quit 异步切回时钟（exitRestored=true）；此处兜底同步恢复后断开。
      if (!this.exitRestored && this.settings.restoreOnExit !== false) this.restoreUserContent('dispose');
    } catch (_) { /* noop */ }
    try { this.disconnect(); } catch (_) { /* noop */ }
  }
}

module.exports = {
  HaloPixelBarRuntime,
  // 便于单元测试
  buildTextPacket,
  buildLayoutPacket,
  buildUiModelPacket,
  checksum,
  displayWidth,
  truncateByWidth,
  fitText,
  MAX_TEXT_BYTES,
};