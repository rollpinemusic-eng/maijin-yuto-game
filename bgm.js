// 魔神ゆうとの笑ろてまうやろ！ 共通BGM再生モジュール
// ・<audio>要素は使わずWeb Audio API(AudioBufferSourceNode)のみで再生する
//   (iPhoneのロック画面/コントロールセンターにメディア操作が出ないようにするため)。
// ・1ページ=1つのAudioContext=1つの音源、という単純な構造に統一している。
//   複数のBGMが同時に鳴る・音量が不安定に変化するという不具合は、
//   ページを離れた後も古いAudioContextが生き残ってしまうこと
//   (特にブラウザのbfcacheでページのJS状態がそのまま保持され、
//    古いページに戻った際に再開してしまうこと)が主な原因だったため、
//   ページを離れる瞬間に必ずAudioContextを完全に閉じる(close)ようにし、
//   二度と音が出ないことを保証している。
(function (global) {
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
    var isPlaying = false;
    var hasGesture = false; // ユーザー操作(タップ等)が一度でもあったか
    var closed = false;     // ページを離れて完全終了したか(以後は何もしない)

    function getCtx() {
      if (closed) return null;
      if (!ctx) {
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
          ctx = null;
        }
        if (ctx) {
          gainNode = ctx.createGain();
          gainNode.gain.value = vol; // この値を書き換えるのはsetVolume()のみ。音声入力等では一切触らない
          gainNode.connect(ctx.destination);
          try {
            ctx.addEventListener('statechange', function () {
              if (closed) return;
              // 通話・Siri・マイク使用等でOSがcontextを一時停止させることがある
              // (WebKit独自の'interrupted'状態を含む)ため、操作済みのページであれば
              // 音量やトラックはそのままに、再生状態だけを自動で復帰させる
              if (hasGesture && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
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
      sourceNode = c.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.loop = true; // 曲の終わりに来たら無音を挟まず先頭へ戻る(途切れなしループ)
      sourceNode.connect(gainNode);
      sourceNode.start(0);
      isPlaying = true;
    }

    // 「音源の読み込み完了」と「ユーザー操作による解錠」は非同期に起こるため、
    // どちらが先に揃っても取りこぼさないよう、この関数を両方の完了地点から呼ぶ
    function maybeStart() {
      if (closed || isPlaying || !buffer || !hasGesture) return;
      startPlayback();
    }

    // ページを離れる瞬間に必ず完全停止・破棄する(二重再生・音量の不安定さの根絶)
    function shutdown() {
      if (closed) return;
      closed = true;
      try { if (sourceNode) sourceNode.stop(); } catch (e) {}
      try { if (ctx) ctx.close(); } catch (e) {}
    }
    window.addEventListener('pagehide', shutdown);
    window.addEventListener('beforeunload', shutdown);

    // ----- 音源の読み込み(できるだけ早く開始する。呼び出し側はページ先頭付近でinit()すること) -----
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
        if (!decoded || closed) return;
        buffer = decoded;
        maybeStart(); // 既に操作済みなら、デコード完了と同時に再生開始
      })
      .catch(function () { /* 読み込み失敗時は無音のまま(ゲーム進行には影響させない) */ });

    // ----- モバイルの自動再生制限のための解錠。以後の操作でも自己修復の保険として使う -----
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
