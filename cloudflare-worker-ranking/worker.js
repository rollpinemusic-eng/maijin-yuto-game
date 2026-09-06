// 魔神ゆうと ～大喜利ダンジョン～ オンラインランキング用Worker
// ・GitHub Pages(ゲーム本体)のみからのアクセスを許可(CORS完全ロック)
// ・秘密鍵やAPIキーは一切使用しない(D1バインディングのみ)
// ・1プレイヤー(player_id)につき1行のみ保持し、自己ベストを更新した時だけ上書きする

const ALLOWED_ORIGIN = 'https://rollpinemusic-eng.github.io';

const GRADE_ORDER = ['Dクラス', 'Cクラス', 'Bクラス', 'Aクラス', 'Sクラス', 'SSクラス', 'SSSクラス'];

function gradeWeight(grade) {
  const idx = GRADE_ORDER.indexOf(grade);
  return idx === -1 ? 0 : idx;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === '/submit' && request.method === 'POST') {
        return await handleSubmit(request, env);
      }
      if (url.pathname === '/leaderboard' && request.method === 'GET') {
        return await handleLeaderboard(url, env);
      }
    } catch (err) {
      return json({ error: 'internal error' }, 500);
    }

    return json({ error: 'not found' }, 404);
  },
};

async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }

  const playerId = String(body.playerId || '').slice(0, 64);
  const nickname = String(body.nickname || '名無し').slice(0, 10) || '名無し';
  const avgScore = Number(body.avgScore);
  const grade = String(body.grade || '');
  const gradeName = String(body.gradeName || '').slice(0, 30);
  const stage = Number(body.stage);

  if (
    !playerId ||
    !Number.isFinite(avgScore) || avgScore < 0 || avgScore > 100 ||
    !GRADE_ORDER.includes(grade) ||
    !Number.isInteger(stage) || stage < 1 || stage > 3
  ) {
    return json({ error: 'invalid payload' }, 400);
  }

  const existing = await env.DB.prepare('SELECT avg_score FROM scores WHERE player_id = ?')
    .bind(playerId)
    .first();

  let updated = false;
  if (!existing || avgScore > existing.avg_score) {
    await env.DB.prepare(
      `INSERT INTO scores (player_id, nickname, avg_score, grade, grade_name, stage, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         nickname = excluded.nickname,
         avg_score = excluded.avg_score,
         grade = excluded.grade,
         grade_name = excluded.grade_name,
         stage = excluded.stage,
         updated_at = excluded.updated_at`
    )
      .bind(playerId, nickname, avgScore, grade, gradeName, stage, new Date().toISOString())
      .run();
    updated = true;
  }

  return json({ updated: updated });
}

async function handleLeaderboard(url, env) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100);

  const { results } = await env.DB.prepare(
    'SELECT player_id, nickname, avg_score, grade, grade_name, stage FROM scores ORDER BY avg_score DESC LIMIT 500'
  ).all();

  const rows = (results || []).map((r) => ({
    playerId: r.player_id,
    nickname: r.nickname,
    avgScore: r.avg_score,
    grade: r.grade,
    gradeName: r.grade_name,
    stage: r.stage,
    weight: gradeWeight(r.grade),
  }));

  // ランキング順位は「獲得ランク」を優先し、同ランク内は「平均点」で並べる
  rows.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.avgScore - a.avgScore;
  });

  const top = rows.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname,
    avgScore: r.avgScore,
    grade: r.grade,
    gradeName: r.gradeName,
    stage: r.stage,
  }));

  const playerId = url.searchParams.get('playerId');
  let me = null;
  if (playerId) {
    const idx = rows.findIndex((r) => r.playerId === playerId);
    if (idx !== -1) {
      const r = rows[idx];
      me = {
        rank: idx + 1,
        nickname: r.nickname,
        avgScore: r.avgScore,
        grade: r.grade,
        gradeName: r.gradeName,
        stage: r.stage,
      };
    }
  }

  return json({ top: top, me: me, total: rows.length });
}
