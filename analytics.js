// 魔神ゆうとの笑ろてまうやろ！ 共通アクセス解析モジュール(v1)
//
// 管理者専用の統計ページ(admin.html)のためだけにイベントを収集する、
// 完全に独立したモジュール。ゲーム内容・BGM(bgm.js)・ランキング機能の
// ロジックには一切関与せず、失敗しても(通信エラー等)ゲーム側の動作には
// 何の影響も与えない(すべて例外を握りつぶすfire-and-forget方式)。
//
// 送信するのは匿名のplayer_id(ランキングと同じlocalStorageキーを再利用)・
// 閲覧ページ名・参照元URL・滞在時間など、集計用途の情報のみ。
(function (global) {
  var API = 'https://maijin-yuto-ranking.rollpinemusic-173.workers.dev';

  function getPlayerId() {
    try {
      var id = localStorage.getItem('majin_player_id');
      if (!id) {
        id = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('majin_player_id', id);
      }
      return id;
    } catch (e) {
      return 'p-' + Date.now().toString(36);
    }
  }

  function send(payload) {
    try {
      fetch(API + '/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  function init(page) {
    var playerId = getPlayerId();
    var startedAt = Date.now();
    var referrer = '';
    try { referrer = document.referrer || ''; } catch (e) {}
    var search = '';
    try { search = location.search || ''; } catch (e) {}

    send({
      type: 'pageview',
      playerId: playerId,
      page: page,
      referrer: referrer.slice(0, 300),
      search: search.slice(0, 200),
    });

    // 滞在時間(「平均プレイ時間」等の算出用)。ページを離れる/隠れる直前に1回だけ送る。
    var durationSent = false;
    function sendDuration() {
      if (durationSent) return;
      var durationMs = Date.now() - startedAt;
      if (durationMs < 500 || durationMs > 3 * 60 * 60 * 1000) return; // 異常値は送らない
      durationSent = true;
      send({
        type: 'duration',
        playerId: playerId,
        page: page,
        durationMs: durationMs,
      });
    }
    window.addEventListener('pagehide', sendDuration);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) sendDuration();
    });
  }

  function trackClick(page, target) {
    send({
      type: 'click',
      playerId: getPlayerId(),
      page: page,
      target: target,
    });
  }

  global.MajinAnalytics = { init: init, trackClick: trackClick };
})(window);
