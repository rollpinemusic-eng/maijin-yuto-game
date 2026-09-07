// 魔神ゆうとの笑ろてまうやろ！ 共通BGM再生モジュール
// ・<audio>要素は一切使わず、Web Audio API(AudioBufferSourceNode)のみで再生する。
//   これにより、
//   　(1) スマホのロック画面/コントロールセンターにメディア操作パネルが出ない
//   　    (OSが「メディア再生」として認識するのはHTMLMediaElementの再生のみのため)
//   　(2) 音声入力(マイク)使用時のOS側の自動ダッキングの影響を受けにくい
//   というゲームBGMとして必要な挙動を実現している。
// ・iOS Safariでは、
//   　・AudioContextの生成/再開はユーザー操作(タップ等)の中で行う必要がある
//   　・通話やSiri、マイク使用による音声セッション切り替えで
//   　　contextが 'suspended'(や非標準の 'interrupted')になることがある
//   　・バックグラウンドから復帰した際も同様に止まっていることがある
//   ため、初回操作での解錠だけでなく、以後の操作・画面復帰のたびに
//   「止まっていたら再開する」自己修復を繰り返す設計にしている。
(function (global) {
  var STATE_KEY = 'majin_bgm_state';
  var SAVE_INTERVAL_MS = 1000;
  var initialized = false; // 同一ページでの誤った二重初期化(=二重再生)を防ぐ
  var singleton = null;

  function initBgm(trackUrl, volume) {
    if (initialized) return singleton;
    initialized = true;

    var vol = typeof volume === 'number' ? volume : 0.32;
    var ctx = null;
    var gainNode = null;
    var sourceNode = null;
    var buffer = null;
    var startedAtCtxTime = 0;   // 再生を開始した瞬間のctx.currentTime
    var offsetAtStart = 0;      // その時点での曲内再生位置(秒)
    var isPlaying = false;
    var hasGesture = false;     // ユーザー操作(タップ等)が一度でもあったか
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
          gainNode.gain.value = vol; // 以後この値を書き換えるのはsetVolume()のみ(音声入力等では触らない)
          gainNode.connect(ctx.destination);
          try {
            ctx.addEventListener('statechange', function () {
              if (ctx.state === 'running') {
                maybeStart();
              } else if (hasGesture && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
                // 通話・Siri・マイク使用等でOSに一時停止させられた場合、
                // 既に一度操作を受けているページなら自動で再開を試みる
                ctx.resume().catch(function () {});
              }
            });
          } catch (e) {}
        }
      }
      if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
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

    // 「音源の読み込み完了」と「ユーザー操作による解錠」は非同期に起こるため、
    // どちらが先に揃っても取りこぼさないよう、この関数を両方の完了地点から呼ぶ
    function maybeStart() {
      if (isPlaying || !buffer || !hasGesture) return;
      startPlayback();
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
    setInterval(saveState, SAVE_INTERVAL_MS);
    window.addEventListener('pagehide', saveState);
    window.addEventListener('beforeunload', saveState);

    // ----- バックグラウンド復帰・タブ復帰時に、止まっていれば再開する -----
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        saveState();
      } else if (hasGesture) {
        getCtx();
        maybeStart();
      }
    });
    window.addEventListener('pageshow', function () {
      if (hasGesture) {
        getCtx();
        maybeStart();
      }
    });
    window.addEventListener('focus', function () {
      if (hasGesture) {
        getCtx();
        maybeStart();
      }
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
        maybeStart(); // 既に操作済みなら、デコード完了と同時に再生開始
      })
      .catch(function () { /* 読み込み失敗時は無音のまま(ゲーム進行には影響させない) */ });

    // ----- モバイルの自動再生制限のための解錠 -----
    // 1回きりで監視をやめず、以後の操作でも「止まっていたら再開する」保険として使い続ける
    // (何度呼ばれても isPlaying / hasGesture の判定により二重再生はしない)
    function onUserGesture() {
      hasGesture = true;
      getCtx();
      maybeStart();
    }
    document.addEventListener('pointerdown', onUserGesture);
    document.addEventListener('keydown', onUserGesture);
    document.addEventListener('click', onUserGesture);
    document.addEventListener('touchend', onUserGesture);

    singleton = {
      setVolume: function (v) { if (gainNode) gainNode.gain.value = v; }
    };
    return singleton;
  }

  global.MajinBGM = { init: initBgm };
})(window);
