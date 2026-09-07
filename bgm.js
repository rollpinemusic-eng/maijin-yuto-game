// 魔神ゆうとの笑ろてまうやろ！ 共通BGM再生モジュール
// ・全ページ共通で読み込み、MajinBGM.init(トラックURL) を呼ぶだけで
//   「ループ再生・効果音より控えめな音量・初回操作での解錠」を統一的に行う
// ・同じ曲を使うページ間を移動した場合は、離脱時刻からの経過時間を
//   計算して再生位置を合わせ、できるだけ自然に(曲の途中から)繋げる
(function (global) {
  var STATE_KEY = 'majin_bgm_state';
  var VOLUME = 0.32; // 効果音・キャラクターボイスより少し小さめの音量

  function initBgm(trackUrl) {
    var audio = new Audio(trackUrl);
    audio.loop = true;
    audio.volume = VOLUME;
    audio.preload = 'auto';

    // ----- 同じ曲を再生していた別ページから移動してきた場合、続きから再生する -----
    try {
      var raw = sessionStorage.getItem(STATE_KEY);
      if (raw) {
        var state = JSON.parse(raw);
        if (state && state.track === trackUrl && typeof state.time === 'number' && typeof state.ts === 'number') {
          var elapsedSec = Math.max(0, (Date.now() - state.ts) / 1000);
          audio.addEventListener('loadedmetadata', function () {
            if (audio.duration > 0) {
              audio.currentTime = (state.time + elapsedSec) % audio.duration;
            }
          }, { once: true });
        }
      }
    } catch (e) {}

    function saveState() {
      try {
        sessionStorage.setItem(STATE_KEY, JSON.stringify({
          track: trackUrl,
          time: audio.currentTime,
          ts: Date.now()
        }));
      } catch (e) {}
    }
    window.addEventListener('pagehide', saveState);
    window.addEventListener('beforeunload', saveState);

    function tryPlay() {
      audio.play().catch(function () { /* 自動再生制限で失敗した場合は初回操作を待つ */ });
    }

    // モバイルの自動再生制限のため、ページ内で最初に操作された瞬間に再生を試みる
    function unlockOnce() {
      tryPlay();
      document.removeEventListener('pointerdown', unlockOnce);
      document.removeEventListener('keydown', unlockOnce);
      document.removeEventListener('click', unlockOnce);
      document.removeEventListener('touchend', unlockOnce);
    }
    document.addEventListener('pointerdown', unlockOnce);
    document.addEventListener('keydown', unlockOnce);
    document.addEventListener('click', unlockOnce);
    document.addEventListener('touchend', unlockOnce);

    tryPlay(); // 既に操作済みの状態で遷移してきた場合はここで再生が始まる

    return audio;
  }

  global.MajinBGM = { init: initBgm };
})(window);
