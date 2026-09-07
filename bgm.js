// 魔神ゆうとの笑ろてまうやろ！ 共通BGM管理モジュール(v8)
//
// ===== 設計方針 =====
// 1. 音量は「呼び出し側が数値を渡す」のではなく、この中の1つの表
//    (TRACKS)だけが持つ。各ページはトラック名(キー)を指定するだけで、
//    音量の値そのものを外部から渡す・書き換える手段を用意しない。
// 2. マイク(音声入力)は別のAudioContextを使う既存の仕組みであり、
//    このモジュールは一切関知しない。BGM側のgain値は生成時に一度だけ
//    設定し、以後どのイベントが起きても絶対に書き換えない。
// 3. 1ページ=1つのAudioContext=1つの音源、を厳守。同一ページ内で
//    init()が複数回呼ばれても2つ目以降は無視する(二重再生防止)。
// 4. ページが見えなくなった瞬間(visibilitychange)に必ず一時停止し、
//    ページを離れる瞬間(pagehide/beforeunload)に必ずAudioContextを
//    完全に閉じる。BGMは「ゲーム画面が表示されている間だけ」再生し、
//    タブ・アプリを閉じれば確実に止まる。
// 5. <audio>要素・MediaSession API・navigator.audioSessionは
//    一切使用しない。
//    【重要な経緯】以前のバージョンで navigator.audioSession.type
//    = 'playback' を設定する対策を一時的に追加したが、これはiOSに
//    「バックグラウンド再生を行う音楽アプリ相当のセッション」と
//    認識させてしまい、その結果、
//    ・ページ/Safari/タブを閉じてもBGMが鳴り続ける
//    ・iPhoneのコントロールセンターに曲名・再生/停止/スキップ操作が
//      表示される
//    ・コントロールセンターから停止しても止まらない
//    という重大な不具合を実機で引き起こしたため、完全に撤去した。
//    (ネイティブアプリのAVAudioSessionCategoryPlaybackと同じ効果を
//    持つAPIで、バックグラウンド再生を明示的に許可する意味を持つ
//    ため、ゲーム内だけの音声にしたい今回の要件とは根本的に相容れない)。
//    マイク使用後の音量低下対策としてこのAPIを使うことは今後も行わない。
(function (global) {
  // ----- 音量表(唯一の音量設定箇所。外部からはここを直接変更できない) -----
  // 各トラックの音量は、実測したRMS音量をもとに「ステージ2(仏音)を基準に
  // 聴感上の音量を揃える」よう正規化した値。この値を書き換えられるのは
  // このファイルを直接編集する場合のみで、実行時に外部から変更する手段はない。
  var TRACKS = {
    stage1: { url: 'bgm/stage1-my-precious.mp3', volume: 0.082 },
    stage2: { url: 'bgm/stage2-hotoke-no-ne.mp3', volume: 0.32 },
    stage3: { url: 'bgm/common-jiron-tetsugaku.mp3', volume: 0.214 },
    common: { url: 'bgm/common-jiron-tetsugaku.mp3', volume: 0.214 }
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
          gainNode.gain.setValueAtTime(vol, ctx.currentTime); // ここ以外でgainを触るコードは存在しない
          gainNode.connect(ctx.destination);
          try {
            ctx.addEventListener('statechange', function () {
              if (closed) return;
              // 通話・Siri・マイク使用等でOSがcontextを一時停止させることがある
              // (WebKit独自の'interrupted'状態を含む)。音量には触れず、
              // ページが表示中の場合に限って再生状態だけを元に戻す。
              if (hasGesture && !document.hidden && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
                ctx.resume().catch(function () {});
              }
            });
          } catch (e) {}
        }
      }
      if (ctx && !document.hidden && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
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
      if (closed || isPlaying || !buffer || !hasGesture || document.hidden) return;
      startPlayback();
    }

    // ----- ページが見えなくなった瞬間、即座に一時停止する -----
    // (タブ切り替え・アプリ切り替え・画面ロック等。「ゲーム画面が
    //  表示されている間だけ再生する」を、unloadイベント任せにせず
    //  visibilitychangeでも二重に保証する)
    document.addEventListener('visibilitychange', function () {
      if (closed || !ctx) return;
      if (document.hidden) {
        if (ctx.state === 'running') ctx.suspend().catch(function () {});
      } else if (hasGesture && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
        ctx.resume().catch(function () {});
      }
    });

    // ----- ページを完全に離れた場合は、AudioContextごと確実に破棄する -----
    function shutdown() {
      if (closed) return;
      closed = true;
      try { if (sourceNode) sourceNode.stop(); } catch (e) {}
      try { if (ctx) ctx.close(); } catch (e) {}
    }
    window.addEventListener('pagehide', shutdown);
    window.addEventListener('beforeunload', shutdown);

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
        maybeStart(); // 既に操作済みで表示中なら、デコード完了と同時に再生開始
      })
      .catch(function () { /* 読み込み失敗時は無音のまま(ゲーム進行には影響させない) */ });

    // ----- モバイルの自動再生制限のための解錠。以後の操作でも自己修復の保険として使い続ける -----
    function onUserGesture() {
      hasGesture = true;
      getCtx();
      maybeStart();
    }
    document.addEventListener('pointerdown', onUserGesture);
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
