// 魔神ゆうとの笑ろてまうやろ！ 共通BGM再生モジュール
// ・<audio>要素ではなくWeb Audio API(AudioBufferSourceNode)で再生する。
//   これにより、
//   　(1) スマホのロック画面/コントロールセンターに曲名入り
//   　    メディアコントロール(再生・一時停止・スキップ)が出ない
//   　(2) 音声入力(マイク)使用時にOS側の音声セッション切り替えで
//   　    音量が変わったり止まったりする(HTMLMediaElementで起きがちな
//   　    自動ダッキング)現象を避けやすい
//   というゲームBGMとして必要な挙動を実現している。
// ・各トラックは元音源の音量差が大きいため、あらかじめ実測したRMS音量を
//   もとに正規化した音量(volume引数)を呼び出し側から渡す想定。
(function (global) {
  var STATE_KEY = 'majin_bgm_state';
  var SAVE_INTERVAL_MS = 1000;

  function initBgm(trackUrl, volume) {
    var vol = typeof volume === 'number' ? volume : 0.32;
    var ctx = null;
    var gainNode = null;
    var sourceNode = null;
    var buffer = null;
    var startedAtCtxTime = 0;   // 再生を開始した瞬間のctx.currentTime
    var offsetAtStart = 0;      // その時点での曲内再生位置(秒)
    var isPlaying = false;
    var pendingResumeOffset = null;

    // ----- 同じ曲を再生していた別ページから移動してきた場合、続きの位置を先に読んでおく -----
    try {
      var raw = sessionStorage.getItem(STATE_KEY);
      if (raw) {
        var state = JSON.parse(raw);
        if (state && state.track === trackUrl && typeof state.time === 'number' && typeof state.ts === 'number') {
          var elapsedSec = Math.max(0, (Date.now() - state.ts) / 1000);
          pendingResumeOffset = state.time + elapsedSec;
        }
      }
    } catch (e) {}

    function getCtx() {
      if (!ctx) {
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
          ctx = null;
        }
        if (ctx) {
          gainNode = ctx.createGain();
          gainNode.gain.value = vol;
          gainNode.connect(ctx.destination);
        }
      }
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(function () {});
      }
      return ctx;
    }

    function startPlayback() {
      var c = getCtx();
      if (!c || !buffer || isPlaying) return;
      var offset = 0;
      if (pendingResumeOffset != null && buffer.duration > 0) {
        offset = pendingResumeOffset % buffer.duration;
        pendingResumeOffset = null;
      }
      sourceNode = c.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.loop = true; // 曲の終わりに来たら無音を挟まず先頭へ戻る(途切れなしループ)
      sourceNode.connect(gainNode);
      sourceNode.start(0, offset);
      startedAtCtxTime = c.currentTime;
      offsetAtStart = offset;
      isPlaying = true;
    }

    function currentPlaybackTime() {
      if (!isPlaying || !ctx || !buffer || buffer.duration <= 0) {
        return pendingResumeOffset != null ? pendingResumeOffset : offsetAtStart;
      }
      var elapsed = ctx.currentTime - startedAtCtxTime;
      return (offsetAtStart + elapsed) % buffer.duration;
    }

    function saveState() {
      try {
        sessionStorage.setItem(STATE_KEY, JSON.stringify({
          track: trackUrl,
          time: currentPlaybackTime(),
          ts: Date.now()
        }));
      } catch (e) {}
    }
    // unload系イベントの発火が不確実な端末もあるため、定期保存も併用する
    var saveTimer = setInterval(saveState, SAVE_INTERVAL_MS);
    window.addEventListener('pagehide', saveState);
    window.addEventListener('beforeunload', saveState);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveState();
    });

    // ----- 音源の読み込み(Web Audio APIでデコード) -----
    fetch(trackUrl)
      .then(function (res) { return res.arrayBuffer(); })
      .then(function (arrayBuffer) {
        var c = getCtx();
        if (!c) return null;
        return new Promise(function (resolve, reject) {
          // decodeAudioDataは新旧2種類のコールバック形式があるため両対応させる
          var maybePromise = c.decodeAudioData(arrayBuffer, resolve, reject);
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(resolve, reject);
          }
        });
      })
      .then(function (decoded) {
        if (!decoded) return;
        buffer = decoded;
        if (ctx && ctx.state === 'running') startPlayback();
      })
      .catch(function () { /* 読み込み失敗時は無音のまま(ゲーム進行には影響させない) */ });

    function unlockOnce() {
      getCtx();
      if (buffer) startPlayback();
      document.removeEventListener('pointerdown', unlockOnce);
      document.removeEventListener('keydown', unlockOnce);
      document.removeEventListener('click', unlockOnce);
      document.removeEventListener('touchend', unlockOnce);
    }
    // モバイルの自動再生制限のため、ページ内で最初に操作された瞬間に再生を試みる
    document.addEventListener('pointerdown', unlockOnce);
    document.addEventListener('keydown', unlockOnce);
    document.addEventListener('click', unlockOnce);
    document.addEventListener('touchend', unlockOnce);

    return {
      setVolume: function (v) { if (gainNode) gainNode.gain.value = v; }
    };
  }

  global.MajinBGM = { init: initBgm };
})(window);
