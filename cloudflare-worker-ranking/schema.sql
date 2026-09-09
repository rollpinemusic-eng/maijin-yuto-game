-- 魔神ゆうと ～大喜利ダンジョン～ オンラインランキング用テーブル
-- 1プレイヤー(player_id)につき1行のみ保持し、自己ベストを更新した時だけ書き換える。
CREATE TABLE IF NOT EXISTS scores (
  player_id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  avg_score REAL NOT NULL,
  grade TEXT NOT NULL,
  grade_name TEXT NOT NULL,
  stage INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_avg ON scores(avg_score DESC);

-- ----- 管理者専用アクセス解析(admin.html)のためのテーブル -----
-- ランキング機能(scoresテーブル)とは完全に独立しており、既存機能には影響しない。

-- プレイヤー(player_id)ごとの初回/最終アクセス日時。新規/再訪問ユーザーの判定に使う。
CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_first_seen ON players(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at);

-- ページ閲覧(pageview)・ボタンクリック(click)・滞在時間(duration)の1件ごとの記録。
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'pageview' | 'click' | 'duration'
  page TEXT NOT NULL,        -- 'home' | 'stage1' | 'stage2' | 'stage3' | 'ranking' | 'zukan' | 'radio' | 'help'
  target TEXT,               -- clickイベントの対象(例: 'music' | 'homepage')
  duration_ms INTEGER,       -- durationイベントの滞在時間(ミリ秒)
  referrer TEXT,
  search TEXT,
  platform TEXT,             -- 'iphone' | 'android' | 'other'
  browser TEXT,              -- 'safari' | 'chrome' | 'other'
  country TEXT,
  region TEXT,
  source TEXT,               -- 流入元の分類(TikTok/X(Twitter)/Google/直接アクセス等)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type_page ON events(type, page);
CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
