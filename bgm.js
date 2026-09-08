// 魔神ゆうとの笑ろてまうやろ！ 共通BGM管理モジュール(v14)
//
// ===== v12での修正(診断ログで実機から取得した実測値に基づく・現在も有効) =====
// 実機の診断ログにより、AudioContextが 'suspended' から
// 'interrupted'(WebKit独自の状態)へ遷移し、以後ずっとその状態のまま
// 一度も 'running' に戻らないケースを確認した。旧バージョンは
// resumeを試みる条件が「state === 'suspended'」のみだったため、
// 'interrupted' になった場合は一切resume()を試みておらず、
// 一度発生すると永久に無音のままになっていた。
// (実機確認により、本体のサイレントスイッチは着信モードであることを
//  確認済みのため、ハードウェアスイッチが原因ではないと判断している)
// → 'interrupted' もresumeの対象に加え、AudioContextのstatechange
//   イベントを監視して状態が変わるたびに回復を試みるよう修正した。
//
// ===== v13で追加し、v14で撤去した対策(重要な経緯) =====
// v13では「ページが非表示になった瞬間に即座にctx.suspend()する」処理を
// 追加した(フォースクォート後にBGMが重なる問題への対策として)。
// しかし実機で検証したところ、
// ・ホーム画面へ戻った瞬間に「ブー」という音が鳴る
// ・その後BGMだけでなく、効果音・キャラクターボイス(このモジュールとは
//   別のAudioContextを使っている)まで含めてゲーム全体が無音になり、
//   Safariを完全終了する以外に復旧手段がない
// という、以前より重大な不具合を引き起こした。BGM用ではない別の
// AudioContextにまで影響が及んだことから、単発のsuspend()呼び出しが
// ページ(タブ)全体の音声セッションに悪影響を与えていたと判断し、
// v13の変更は完全に撤去した。現在は「非表示になっても、こちらから
// 能動的にAudioContextへ何かを行うことは一切しない」方針に戻している
// (ページの状態変化はログにのみ記録する)。
//
// ===== 診断ログ機能について =====
// URLの末尾に ?bgmdebug=1 を付けて開くと、画面上部に半透明のログが
// 表示される(通常プレイ時は表示されない)。実機(iPhone Safari)でしか
// 再現しない不具合の原因を、推測ではなく実際の実行ログで特定するために
// 追加した診断専用の機能で、ゲームの見た目・動作には一切影響しない。
//
// ===== 設計方針 =====
// 1. 音量は「呼び出し側が数値を渡す」のではなく、この中の1つの表
//    (TRACKS)だけが持つ。gain値は生成時に一度だけ設定し、以後どの
//    イベントが起きても絶対に書き換えない。
// 2. 1ページ=1つのAudioContext=1つの音源、を厳守。二重初期化防止。
// 3. <audio>要素・MediaSession API・navigator.audioSessionは
//    一切使用しない(navigator.audioSessionは過去に試して重大な
//    副作用があったため使用しない方針を確定させている)。
// 4. AudioContextの一時停止/再開を能動的に制御することは一切行わない。
//    「本当にページを離れる場合」(pagehideでpersistedでない場合)にのみ
//    完全に閉じる。それ以外(非表示になった/戻ってきた等)は一切何も
//    しない。再開は必ず実際のユーザー操作(タップ等)をきっかけにした
//    resume()試行にのみ任せる。能動的な制御を追加するたびに実機で
//    新たな不具合(音量劣化・全音声の無音化)が発生した経緯があるため、
//    「本当に片付けが必要な時だけ片付け、それ以外は一切手を出さない」
//    という最小限の方針を徹底している。
(function (global) {
  // ----- 診断ログ(?bgmdebug=1 の時だけ画面上に表示する) -----
  var DEBUG = false;
  try { DEBUG = /(?:^|[?&])bgmdebug=1(?:&|$)/.test(location.search); } catch (e) {}
  var debugLines = [];
  var debugPanel = null;
  var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
  function dlog(msg) {
    if (!DEBUG) return;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var line = '[+' + Math.round(now - t0) + 'ms] ' + msg;
    debugLines.push(line);
    if (debugLines.length > 80) debugLines.shift();
    try {
      if (!debugPanel) {
        debugPanel = document.createElement('div');
        debugPanel.id = 'bgmDebugPanel';
        debugPanel.style.cssText = 'position:fixed;left:0;top:0;right:0;max-height:48vh;' +
          'overflow-y:auto;background:rgba(0,0,0,0.88);color:#7CFC7C;' +
          'font:10px/1.45 -apple-system,monospace;padding:6px 8px;z-index:2147483647;' +
          'white-space:pre-wrap;pointer-events:none;-webkit-user-select:text;user-select:text;';
        (document.body || document.documentElement).appendChild(debugPanel);
      }
      debugPanel.textContent = debugLines.join('\n');
    } catch (e) {}
  }
  global.__bgmDebugLog = debugLines;

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
    if (initialized) {
      dlog('init() called again for "' + trackKey + '" -> IGNORED(二重初期化防止, 既存: 前回のtrackKeyのまま)');
      return singleton;
    }
    initialized = true;

    var track = TRACKS[trackKey];
    if (!track) {
      dlog('init("' + trackKey + '") -> 未知のキー。何もしない');
      return null;
    }

    var vol = track.volume; // ここで確定させた後は二度と書き換えない
    var trackUrl = (basePath || '') + track.url;
    dlog('init trackKey=' + trackKey + ' url=' + trackUrl + ' vol(固定値)=' + vol +
      ' documentHidden=' + document.hidden + ' visibilityState=' + document.visibilityState);

    var ctx = null;
    var gainNode = null;
    var sourceNode = null;
    var buffer = null;
    var isPlaying = false;
    var hasGesture = false; // ユーザー操作(タップ等)が一度でもあったか
    var closed = false;     // ページを本当に離れて終了したか(以後は何もしない)

    // resumeを試みる。'suspended'だけでなく、WebKit独自の'interrupted'
    // 状態(実機ログで確認済み:電話・Siri・他アプリの音声等との衝突で
    // 発生し、これまでのバージョンではこの状態からの回復を一切試みて
    // いなかったため、一度発生すると永久に無音のままになっていた)
    // からも回復を試みる。
    function attemptResume() {
      if (!ctx || closed) return;
      dlog('resume() 試行 state=' + ctx.state);
      ctx.resume().then(function () {
        dlog('resume() 成功後 state=' + ctx.state + ' gain.value=' + (gainNode ? gainNode.gain.value : 'null'));
      }).catch(function (e) {
        dlog('resume() 失敗: ' + e);
      });
    }

    function getCtx() {
      if (closed) return null;
      if (!ctx) {
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
          ctx = null;
          dlog('new AudioContext() 失敗: ' + e);
        }
        if (ctx) {
          gainNode = ctx.createGain();
          gainNode.gain.setValueAtTime(vol, ctx.currentTime); // ここ以外でgainを触るコードは存在しない
          gainNode.connect(ctx.destination);
          dlog('AudioContext生成 state=' + ctx.state + ' sampleRate=' + ctx.sampleRate +
            ' gain.value(設定直後の読み取り)=' + gainNode.gain.value);
          // stateが変化するたびに監視し、suspended/interruptedになっていたら
          // (操作済みのページに限り)回復を試みる。ctx.suspend()を能動的に
          // 呼ぶ処理は一切無く、ここは「回復を試みる」だけの受動的な処理。
          try {
            ctx.addEventListener('statechange', function () {
              if (closed) return;
              dlog('statechange -> state=' + ctx.state);
              if (hasGesture && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
                attemptResume();
              }
            });
          } catch (e) {}
        }
      }
      if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
        attemptResume();
      }
      return ctx;
    }

    function startPlayback() {
      var c = getCtx();
      if (!c || !buffer || isPlaying) {
        dlog('startPlayback() 見送り: ctx=' + !!c + ' buffer=' + !!buffer + ' isPlaying=' + isPlaying);
        return;
      }
      sourceNode = c.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.loop = true; // 曲の終わりに来たら無音を挟まず先頭へ戻る(途切れなしループ)
      sourceNode.connect(gainNode);
      sourceNode.start(0);
      isPlaying = true;
      dlog('startPlayback() 実行 state=' + c.state + ' gain.value=' + gainNode.gain.value);
      schedulePeriodicCheck();
    }

    // ----- 診断用:再生中、実際のgain値/state/表示状態を定期的に読み取って記録する -----
    // (「gainは変わっていないはずなのに音が小さく聞こえる」場合、原因が
    //  このコードの外側(iOS側の出力音量そのもの)にあることを裏付けるため)
    var periodicTimer = null;
    function schedulePeriodicCheck() {
      if (!DEBUG || periodicTimer) return;
      periodicTimer = setInterval(function () {
        if (closed) { clearInterval(periodicTimer); return; }
        dlog('periodic: isPlaying=' + isPlaying + ' ctxState=' + (ctx ? ctx.state : 'null') +
          ' gain.value=' + (gainNode ? gainNode.gain.value : 'null') +
          ' hidden=' + document.hidden);
      }, 4000);
    }

    // 「音源の読み込み完了」と「ユーザー操作による解錠」は非同期に起こるため、
    // どちらが先に揃っても取りこぼさないよう、この関数を両方の完了地点から呼ぶ
    function maybeStart() {
      if (closed || isPlaying || !buffer || !hasGesture) return;
      startPlayback();
    }

    // ----- ページを本当に離れた場合にのみ、AudioContextごと確実に破棄する -----
    function shutdown() {
      if (closed) return;
      closed = true;
      dlog('shutdown() 実行(ページを本当に離れる) gain->0, close()');
      try { if (gainNode) gainNode.gain.setValueAtTime(0, ctx.currentTime); } catch (e) {}
      try { if (sourceNode) sourceNode.stop(); } catch (e) {}
      try { if (ctx) ctx.close(); } catch (e) {}
    }

    window.addEventListener('pagehide', function (e) {
      dlog('pagehide event persisted=' + (e && e.persisted));
      if (!(e && e.persisted)) {
        shutdown();
      }
    });
    // ページの表示状態はログ記録のみ行い、ctx.suspend()は呼ばない。
    // 【経緯】v13でここに「非表示になった瞬間に即座にsuspend()する」
    // 処理を追加したが、実機で「ホーム画面へ戻った際にブツッという
    // 音が鳴り、その後BGMだけでなく効果音・キャラクターボイス
    // (このモジュールとは別のAudioContextを使っている)まで含めて
    // ゲーム全体が無音になり、Safariの完全終了以外では復旧しない」
    // という、以前より重大な不具合を引き起こしたため撤去した。
    // 効果音側のAudioContextにまで影響したことから、単発のsuspend()
    // 呼び出しがページ(タブ)全体の音声セッションに悪影響を与えていた
    // 可能性が高いと判断し、能動的なsuspend()は今後も行わない方針に戻す。
    document.addEventListener('visibilitychange', function () {
      dlog('visibilitychange -> hidden=' + document.hidden + ' ctxState=' + (ctx ? ctx.state : 'null') +
        ' gain.value=' + (gainNode ? gainNode.gain.value : 'null'));
    });

    // ----- 音源の読み込み(ページ先頭で呼ぶことで、できるだけ早く開始する) -----
    dlog('fetch開始: ' + trackUrl);
    var fetchStartedAt = (window.performance && performance.now) ? performance.now() : Date.now();
    fetch(trackUrl)
      .then(function (res) {
        var now = (window.performance && performance.now) ? performance.now() : Date.now();
        dlog('fetch応答受信 status=' + res.status + ' (' + Math.round(now - fetchStartedAt) + 'ms)');
        return res.arrayBuffer();
      })
      .then(function (arrayBuffer) {
        dlog('arrayBuffer取得完了 bytes=' + arrayBuffer.byteLength);
        var c = getCtx();
        if (!c) return null;
        return new Promise(function (resolve, reject) {
          var maybePromise = c.decodeAudioData(arrayBuffer, resolve, reject);
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(resolve, reject);
          }
        });
      })
      .then(function (decoded) {
        if (!decoded || closed) {
          dlog('decode完了だが decoded=' + !!decoded + ' closed=' + closed + ' のため再生しない');
          return;
        }
        buffer = decoded;
        dlog('decodeAudioData完了 duration=' + decoded.duration.toFixed(2) + 's hasGesture=' + hasGesture);
        maybeStart();
      })
      .catch(function (e) {
        dlog('読み込み/デコード失敗: ' + e);
      });

    // ----- モバイルの自動再生制限のための解錠。以後の操作でも自己修復の保険として使い続ける -----
    function onUserGesture(e) {
      var already = hasGesture;
      hasGesture = true;
      if (!already) dlog('初回ユーザー操作検知: ' + e.type);
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
