// 魔神ゆうとの笑ろてまうやろ！ 共通BGM管理モジュール(v10)
//
// ===== 設計方針 =====
// 1. 音量は「呼び出し側が数値を渡す」のではなく、この中の1つの表
//    (TRACKS)だけが持つ。各ページはトラック名(キー)を指定するだけで、
//    音量の値そのものを外部から渡す・書き換える手段を用意しない。
//    このgain値は生成時に一度だけ設定し、以後どのイベントが起きても
//    絶対に書き換えない(マイク使用・画面遷移・復帰等、一切無関係)。
// 2. 1ページ=1つのAudioContext=1つの音源、を厳守。同一ページ内で
//    init()が複数回呼ばれても2つ目以降は無視する(二重再生防止)。
// 3. <audio>要素・MediaSession API・navigator.audioSessionは
//    一切使用しない(iPhoneのロック画面/コントロールセンターに
//    メディア操作を出さないため。navigator.audioSessionは過去に
//    試して重大な副作用があったため使用しない方針を確定させている)。
// 4. AudioContextの一時停止/再開は、能動的に何度も制御しようとせず
//    最小限にしている。
//    【経緯】以前のバージョンでは、タブが非表示になった瞬間に
//    ctx.suspend()を呼ぶ処理や、bfcache(戻る操作でページの状態が
//    保持される仕組み)からの復帰時にctx.resume()を明示的に呼ぶ処理を
//    追加していたが、実機(iPhone Safari)でSafariの「戻る」操作/
//    スワイプ操作を行った後、BGM音量がゲーム全体で下がったまま
//    元に戻らなくなる重大な不具合が発生した。これらの能動的な
//    suspend/resume制御自体がiOS側の音声セッションに何らかの
//    悪影響を与えていた可能性が高いため、全て撤去した。
//    → 現在はページを「本当に離れる」場合(bfcacheへの一時退避ではなく
//      真の終了)にのみAudioContextを閉じる。それ以外の一時停止/再開は
//      ブラウザ自身の標準動作、および次にユーザーが操作した瞬間に
//      resume()を試みる既存の仕組み(自動再生制限の解錠処理)に委ねる。
//      能動的にstateを操作するコードを増やさないことを優先している。
(function (global) {
  // ----- 音量表(唯一の音量設定箇所。外部からはここを直接変更できない) -----
  // 各トラックの音量は、実測したRMS音量をもとに「ステージ2(仏音)を基準に
  // 聴感上の音量を揃える」よう正規化した値。ファイルはAAC(.m4a, 64kbps)
  // に統一し、読み込み待ち時間を短縮している。
  var TRACKS = {
    stage1: { url: 'bgm/stage1-my-precious.m4a', volume: 0.082 },
    stage2: { url: 'bgm/stage2-hotoke-no-ne.m4a', volume: 0.32 },
    stage3: { url: 'bgm/common-jiron-tetsugaku.m4a', volume: 0.214 },
    common: { url: 'bgm/common-jiron-tetsugaku.m4a', volume: 0.214 }
  };

  var initialized = false; // 同一ページでの誤った二重初期化(=二重再生)を防ぐ
  var singleton = null;

  // trackKey: 'stage1' | 'stage2' | 'stage3' | 'common'
  // basePath: ページの場所に応じた相対パスの接頭辞('' または '../')
  function initBgm(trackKey, basePath) {
    if (initialized) return singleton;
    initialized = true;

    var track = TRACKS[trackKey];
    if (!track) return null; // 未知のキーは何もしない(誤操作で無音量再生を防ぐ)

    var vol = track.volume; // ここで確定させた後は二度と書き換えない
    var trackUrl = (basePath || '') + track.url;

    var ctx = null;
    var gainNode = null;
    var sourceNode = null;
    var buffer = null;
    var isPlaying = false;
    var hasGesture = false; // ユーザー操作(タップ等)が一度でもあったか
    var closed = false;     // ページを本当に離れて終了したか(以後は何もしない)

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
          gainNode.gain.setValueAtTime(vol, ctx.currentTime); // ここ以外でgainを触るコードは存在しない
          gainNode.connect(ctx.destination);
        }
      }
      // 何らかの理由でsuspendされていた場合のみ、ユーザー操作をきっかけに
      // 再開を試みる(能動的な監視・強制操作はしない)
      if (ctx && ctx.state === 'suspended') {
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

    // ----- ページを本当に離れた場合にのみ、AudioContextごと確実に破棄する -----
    // gainを即座に0にしてから閉じる。close()は非同期のため、万一処理の
    // 途中でページが強制終了されても「最後に確定していた音量」がゼロに
    // なるようにする安全策(=閉じきれなくても音が残らない)。
    function shutdown() {
      if (closed) return;
      closed = true;
      try { if (gainNode) gainNode.gain.setValueAtTime(0, ctx.currentTime); } catch (e) {}
      try { if (sourceNode) sourceNode.stop(); } catch (e) {}
      try { if (ctx) ctx.close(); } catch (e) {}
    }

    // pagehideは「本当にページを離れる場合」と「bfcacheに一時保存される
    // だけの場合」の両方で発火し、event.persistedで区別できる。
    // bfcacheへの一時退避の場合は何もしない(ブラウザの標準動作に任せ、
    // こちらから能動的にsuspend/resumeは行わない)。本当に離れる場合
    // のみ完全に破棄する。
    window.addEventListener('pagehide', function (e) {
      if (!(e && e.persisted)) {
        shutdown();
      }
    });

    // ----- 音源の読み込み(ページ先頭で呼ぶことで、できるだけ早く開始する) -----
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

    // ----- モバイルの自動再生制限のための解錠。以後の操作でも自己修復の保険として使い続ける -----
    // (bfcacheから戻ってきた後も、この既存のリスナーがそのまま生きているため、
    //  次にユーザーが何かをタップした瞬間に自然にresume()が試みられる)
    function onUserGesture() {
      hasGesture = true;
      getCtx();
      maybeStart();
    }
    document.addEventListener('pointerdown', onUserGesture);
    document.addEventListener('touchstart', onUserGesture);
    document.addEventListener('keydown', onUserGesture);
    document.addEventListener('click', onUserGesture);
    document.addEventListener('touchend', onUserGesture);

    // 外部に公開するのは「今の再生状態を読み取る」ためのものだけにし、
    // 音量やAudioContextそのものへの書き込み手段は一切公開しない。
    singleton = {
      isPlaying: function () { return isPlaying; }
    };
    return singleton;
  }

  global.MajinBGM = { init: initBgm };
})(window);
