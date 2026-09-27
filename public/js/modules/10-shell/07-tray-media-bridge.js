// ============================================================
//  托盘媒体桥接
//  1. 把当前播放状态（曲目 / 歌手 / 播放中）同步到系统托盘
//  2. 响应托盘右键菜单发来的媒体控制命令（播放/暂停/上一首/下一首）
//  采用捕获阶段监听媒体事件，兼容音频元素被重建的情况，避免侵入播放核心逻辑
// ============================================================
(function initTrayMediaBridge() {
  var traySyncCache = { title: '', artist: '', playing: false, hasTrack: false };
  var traySyncScheduled = false;
  var traySyncBound = false;

  function trayBridgeApi() {
    return (window.desktopWindow && typeof window.desktopWindow.updateTrayPlaybackState === 'function')
      ? window.desktopWindow
      : null;
  }

  function trayBridgeCurrentSong() {
    try {
      if (typeof currentCoverSong === 'function') {
        var song = currentCoverSong();
        if (song) return song;
      }
    } catch (_) { /* noop */ }
    return null;
  }

  function trayBridgeIsPlaying() {
    try {
      return !!(audio && !audio.paused && !audio.ended && (audio.currentSrc || audio.src));
    } catch (_) {
      return !!playing;
    }
  }

  function pushTrayPlaybackState() {
    var api = trayBridgeApi();
    if (!api) return;
    var song = trayBridgeCurrentSong();
    var isPlaying = trayBridgeIsPlaying();
    var title = song ? String(song.name || song.title || '') : '';
    var artist = '';
    if (song) {
      artist = String(song.artist || '');
      if (!artist && typeof songSourceLabel === 'function') artist = String(songSourceLabel(song) || '');
    }
    var hasTrack = !!(song && title);
    if (traySyncCache.title === title && traySyncCache.artist === artist
      && traySyncCache.playing === isPlaying && traySyncCache.hasTrack === hasTrack) return;
    traySyncCache = { title: title, artist: artist, playing: isPlaying, hasTrack: hasTrack };
    try { api.updateTrayPlaybackState(traySyncCache); } catch (_) { /* noop */ }
  }

  function scheduleTrayPlaybackSync() {
    if (traySyncScheduled) return;
    traySyncScheduled = true;
    setTimeout(function () {
      traySyncScheduled = false;
      pushTrayPlaybackState();
    }, 120);
  }

  function handleTrayMediaCommand(payload) {
    var command = String((payload && payload.command) || '');
    try {
      if (command === 'next') {
        if (typeof nextTrack === 'function') nextTrack(true);
      } else if (command === 'prev') {
        if (typeof prevTrack === 'function') prevTrack(true);
      } else if (command === 'play') {
        if (!trayBridgeIsPlaying() && typeof togglePlay === 'function') togglePlay();
      } else if (command === 'pause') {
        if (trayBridgeIsPlaying() && typeof togglePlay === 'function') togglePlay();
      } else if (command === 'toggle') {
        if (typeof togglePlay === 'function') togglePlay();
      }
    } catch (err) {
      console.warn('[TrayMediaBridge] command failed:', command, err);
    }
    scheduleTrayPlaybackSync();
  }

  function bindTrayMediaBridge() {
    if (traySyncBound) return;
    traySyncBound = true;
    ['play', 'pause', 'ended', 'emptied', 'abort', 'error', 'loadeddata'].forEach(function (evt) {
      document.addEventListener(evt, scheduleTrayPlaybackSync, true);
    });
    var api = window.desktopWindow;
    if (api && typeof api.onTrayMediaCommand === 'function') {
      try { api.onTrayMediaCommand(handleTrayMediaCommand); } catch (_) { /* noop */ }
    }
    // 周期性兜底同步，覆盖队列推进等未触发媒体事件的变化
    setInterval(pushTrayPlaybackState, 2000);
    pushTrayPlaybackState();
  }

  window.syncTrayPlaybackState = pushTrayPlaybackState;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindTrayMediaBridge);
  } else {
    bindTrayMediaBridge();
  }
})();
