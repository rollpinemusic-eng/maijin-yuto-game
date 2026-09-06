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
