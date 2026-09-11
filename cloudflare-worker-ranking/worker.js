// 魔神ゆうと ～大喜利ダンジョン～ オンラインランキング用Worker
// ・GitHub Pages(ゲーム本体)のみからのアクセスを許可(CORS完全ロック)
// ・秘密鍵やAPIキーは一切使用しない(D1バインディングのみ、ADMIN_PASSWORDのみ例外)
// ・1プレイヤー(player_id)につき1行のみ保持し、自己ベストを更新した時だけ上書きする
//
// ----- 管理者専用アクセス解析(/track, /stats)について -----
// 既存のランキング機能(/submit, /leaderboard, scoresテーブル)とは
// 完全に別のテーブル(players, events)を使う独立した仕組みで、
// ランキングのロジックには一切手を加えていない。
// /track は誰でも呼べる(ゲーム側から自動送信される)が、収集するのは
// 匿名のplayer_id・閲覧ページ・端末種別・国/地域などの集計用途の情報のみ。
// /stats は管理者パスワード(ADMIN_PASSWORDシークレット)と一致した
// リクエストのみ集計結果を返す。

const ALLOWED_ORIGIN = 'https://rollpinemusic-eng.github.io';

const ANALYTICS_PAGES = ['home', 'stage1', 'stage2', 'stage3', 'ranking', 'zukan', 'radio', 'help'];
const ANALYTICS_TYPES = ['pageview', 'click', 'duration'];
const STAGE_PAGES = ['stage1', 'stage2', 'stage3'];

// 正式公開日時(2026-09-11 21:00 JST = UTC 12:00)。/stats の集計期間切替
// (「公開後」)でのみ使用する。データの削除・リセットは一切行わず、
// 既存のplayers/events/scoresテーブルはそのまま、集計時にこの時刻以降の
// 行だけを対象にするフィルタとして使う。
const LAUNCH_AT_ISO = '2026-09-11T12:00:00.000Z';
// 「全期間」表示用のダミー下限(実データより確実に古い日付なので、
// created_at >= EPOCH_ISO は常に真になり実質フィルタなしと同じになる)。
const EPOCH_ISO = '0001-01-01T00:00:00.000Z';

const GRADE_ORDER = ['Dクラス', 'Cクラス', 'Bクラス', 'Aクラス', 'Sクラス', 'SSクラス', 'SSSクラス'];

function gradeWeight(grade) {
  const idx = GRADE_ORDER.indexOf(grade);
  return idx === -1 ? 0 : idx;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
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
      if (url.pathname === '/track' && request.method === 'POST') {
        return await handleTrack(request, env);
      }
      if (url.pathname === '/stats' && request.method === 'GET') {
        return await handleStats(request, env);
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

// ===================================================================
// ここから下:管理者専用アクセス解析(/track, /stats)。
// ランキング(scoresテーブル・上記の関数群)には一切依存・干渉しない。
// ===================================================================

function classifyPlatform(ua) {
  const u = (ua || '').toLowerCase();
  if (u.includes('iphone') || u.includes('ipad') || u.includes('ipod')) return 'iphone';
  if (u.includes('android')) return 'android';
  return 'other';
}

function classifyBrowser(ua) {
  const u = (ua || '').toLowerCase();
  // Chrome(iOS版のCriOSも含む)はUAに'safari'も含むため、chrome判定を先に行う
  if (u.includes('crios') || (u.includes('chrome') && !u.includes('edg'))) return 'chrome';
  if (u.includes('safari') && !u.includes('chrome') && !u.includes('crios')) return 'safari';
  return 'other';
}

// Bot/クローラーと思われるUser-Agentのパターン。実際の人間が使うブラウザの
// UAには通常含まれない文字列のみを対象にしており、誤検知(実ユーザーを
// Bot扱いしてしまう)を避けるため保守的なリストにしている。
// 該当した記録はevents.is_bot=1で保存はするが、集計(/stats)からは除外する。
const BOT_UA_PATTERNS = [
  'bot', 'crawl', 'spider', 'slurp', 'facebookexternalhit', 'bingpreview',
  'lighthouse', 'headlesschrome', 'pingdom', 'uptimerobot', 'python-requests',
  'python-urllib', 'curl/', 'wget/', 'go-http-client', 'okhttp', 'axios/',
  'node-fetch', 'monitor', 'validator', 'discordbot', 'telegrambot',
  'whatsapp', 'linkedinbot', 'twitterbot', 'skypeuripreview', 'embedly',
];

function classifyIsBot(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return false;
  return BOT_UA_PATTERNS.some((p) => u.includes(p));
}

function classifySource(referrer, search) {
  const r = (referrer || '').toLowerCase();
  const s = (search || '').toLowerCase();
  if (s.includes('utm_source=tiktok') || r.includes('tiktok.com')) return 'TikTok';
  if (s.includes('utm_source=x') || r.includes('twitter.com') || r.includes('x.com') || r.includes('t.co/')) return 'X(Twitter)';
  if (r.includes('instagram.com')) return 'Instagram';
  if (r.includes('youtube.com') || r.includes('youtu.be')) return 'YouTube';
  if (r.includes('google.')) return 'Google';
  if (r.includes('rollpinemusic-eng.github.io')) return 'サイト内遷移';
  if (!r) return '直接アクセス/不明';
  try {
    return new URL(referrer).hostname || 'その他';
  } catch (e) {
    return 'その他';
  }
}

// JST(UTC+9)基準での「今日/今週(月曜始まり)/今月」の開始時刻を、
// 比較用にUTCのISO文字列で返す(created_atはUTCのISO文字列で保存しているため、
// 文字列比較のままで時系列比較が成立する)。
function startOfTodayISO() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth(), d = jst.getUTCDate();
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - 9 * 3600 * 1000).toISOString();
}
function startOfWeekISO() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth(), d = jst.getUTCDate();
  const dow = jst.getUTCDay(); // 0=日,1=月,...
  const backToMonday = (dow + 6) % 7;
  return new Date(Date.UTC(y, m, d - backToMonday, 0, 0, 0) - 9 * 3600 * 1000).toISOString();
}
function startOfMonthISO() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth();
  return new Date(Date.UTC(y, m, 1, 0, 0, 0) - 9 * 3600 * 1000).toISOString();
}

function checkAdminAuth(request, env) {
  const expected = env.ADMIN_PASSWORD || '';
  if (!expected) return false; // シークレット未設定時は安全側に倒して常に拒否する
  const provided = request.headers.get('X-Admin-Password') || '';
  return provided.length > 0 && provided === expected;
}

async function handleTrack(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }

  const playerId = String(body.playerId || '').slice(0, 64);
  const type = String(body.type || '');
  const page = String(body.page || '');
  const target = body.target ? String(body.target).slice(0, 40) : null;
  const referrer = body.referrer ? String(body.referrer).slice(0, 300) : '';
  const search = body.search ? String(body.search).slice(0, 200) : '';
  const durationMs = Number.isFinite(body.durationMs) ? Math.round(body.durationMs) : null;

  if (!playerId || !ANALYTICS_TYPES.includes(type) || !ANALYTICS_PAGES.includes(page)) {
    return json({ error: 'invalid payload' }, 400);
  }
  if (type === 'duration' && (durationMs == null || durationMs < 500 || durationMs > 3 * 60 * 60 * 1000)) {
    return json({ error: 'invalid duration' }, 400);
  }

  const ua = request.headers.get('User-Agent') || '';
  const platform = classifyPlatform(ua);
  const browser = classifyBrowser(ua);
  const country = (request.cf && request.cf.country) || null;
  const region = (request.cf && request.cf.region) || null;
  const source = classifySource(referrer, search);
  const isBot = classifyIsBot(ua);
  const now = new Date().toISOString();

  try {
    const writes = [
      env.DB.prepare(
        `INSERT INTO events (player_id, type, page, target, duration_ms, referrer, search, platform, browser, country, region, source, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(playerId, type, page, target, durationMs, referrer, search, platform, browser, country, region, source, isBot ? 1 : 0, now),
    ];
    // Botと判定した記録は、events(監査用の生ログ)には残すが、
    // players(新規/再訪問ユーザー判定の元になるテーブル)は更新しない。
    // これにより「新規ユーザー数」等の集計にBotが一切混ざらないようにする。
    if (!isBot) {
      writes.push(
        env.DB.prepare(
          `INSERT INTO players (player_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
           ON CONFLICT(player_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
        ).bind(playerId, now, now)
      );
    }
    await env.DB.batch(writes);
  } catch (e) {
    // 集計に失敗しても、ゲーム側の体験には一切影響させない
    return json({ ok: false }, 200);
  }

  return json({ ok: true }, 200);
}

function firstRow(batchResult) {
  return (batchResult && batchResult.results && batchResult.results[0]) || {};
}
function allRows(batchResult) {
  return (batchResult && batchResult.results) || [];
}

async function handleStats(request, env) {
  if (!checkAdminAuth(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);
  // 期間切替:「公開後」が指定された場合のみLAUNCH_AT_ISO以降に絞る。
  // 指定が無い(=「全期間」)場合はEPOCH_ISOを使い、実質フィルタなしにする。
  // データの削除・リセットは行わず、集計時の下限値を変えるだけ。
  const period = url.searchParams.get('period') === 'launch' ? 'launch' : 'all';
  const since = period === 'launch' ? LAUNCH_AT_ISO : EPOCH_ISO;

  const todayStart = startOfTodayISO();
  const weekStart = startOfWeekISO();
  const monthStart = startOfMonthISO();
  const stageList = STAGE_PAGES.map(() => '?').join(',');
  // Botと判定した記録(is_bot=1)は行として残しつつ、集計からは除外する。
  // 追加前の既存データはis_botカラムがデフォルト値の0として読めるため、
  // 過去データも「実ユーザー」として正しく扱われる(データの再集計・削除は不要)。
  const NB = `(is_bot IS NULL OR is_bot = 0)`;

  const stmts = [
    env.DB.prepare(`SELECT COUNT(DISTINCT player_id) c FROM events WHERE type='pageview' AND ${NB} AND page IN (${stageList}) AND created_at >= ?`).bind(...STAGE_PAGES, since),
    env.DB.prepare(`SELECT COUNT(DISTINCT player_id) c FROM events WHERE type='pageview' AND ${NB} AND page IN (${stageList}) AND created_at >= MAX(?, ?)`).bind(...STAGE_PAGES, todayStart, since),
    env.DB.prepare(`SELECT COUNT(DISTINCT player_id) c FROM events WHERE type='pageview' AND ${NB} AND page IN (${stageList}) AND created_at >= MAX(?, ?)`).bind(...STAGE_PAGES, weekStart, since),
    env.DB.prepare(`SELECT COUNT(DISTINCT player_id) c FROM events WHERE type='pageview' AND ${NB} AND page IN (${stageList}) AND created_at >= MAX(?, ?)`).bind(...STAGE_PAGES, monthStart, since),
    env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE type='pageview' AND ${NB} AND page IN (${stageList}) AND created_at >= ?`).bind(...STAGE_PAGES, since),
    env.DB.prepare(`SELECT page, COUNT(*) c FROM events WHERE type='pageview' AND ${NB} AND page IN (${stageList}) AND created_at >= ? GROUP BY page`).bind(...STAGE_PAGES, since),
    env.DB.prepare(`SELECT COUNT(*) c FROM players WHERE first_seen_at >= MAX(?, ?)`).bind(todayStart, since),
    env.DB.prepare(`SELECT COUNT(*) c FROM players WHERE last_seen_at >= ? AND first_seen_at < ? AND first_seen_at >= ?`).bind(todayStart, todayStart, since),
    env.DB.prepare(`SELECT platform, COUNT(*) c FROM events WHERE type='pageview' AND ${NB} AND created_at >= ? GROUP BY platform`).bind(since),
    env.DB.prepare(`SELECT browser, COUNT(*) c FROM events WHERE type='pageview' AND ${NB} AND created_at >= ? GROUP BY browser`).bind(since),
    env.DB.prepare(`SELECT country, COUNT(*) c, COUNT(DISTINCT player_id) u FROM events WHERE type='pageview' AND ${NB} AND country IS NOT NULL AND created_at >= ? GROUP BY country ORDER BY u DESC LIMIT 15`).bind(since),
    env.DB.prepare(`SELECT country, region, COUNT(*) c, COUNT(DISTINCT player_id) u FROM events WHERE type='pageview' AND ${NB} AND region IS NOT NULL AND region != '' AND created_at >= ? GROUP BY country, region ORDER BY u DESC LIMIT 15`).bind(since),
    env.DB.prepare(`SELECT AVG(duration_ms) a, COUNT(*) c FROM events WHERE type='duration' AND ${NB} AND page IN (${stageList}) AND created_at >= ?`).bind(...STAGE_PAGES, since),
    env.DB.prepare(`SELECT page, AVG(duration_ms) a, COUNT(*) c FROM events WHERE type='duration' AND ${NB} AND page IN (${stageList}) AND created_at >= ? GROUP BY page`).bind(...STAGE_PAGES, since),
    env.DB.prepare(`SELECT page, COUNT(*) c FROM events WHERE type='pageview' AND ${NB} AND created_at >= ? GROUP BY page ORDER BY c DESC`).bind(since),
    env.DB.prepare(`SELECT page, COUNT(DISTINCT player_id) c FROM events WHERE type='pageview' AND ${NB} AND created_at >= ? GROUP BY page`).bind(since),
    env.DB.prepare(`SELECT source, COUNT(*) c FROM events WHERE type='pageview' AND ${NB} AND created_at >= ? GROUP BY source ORDER BY c DESC LIMIT 15`).bind(since),
    env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE type='click' AND ${NB} AND page='radio' AND target='music' AND created_at >= ?`).bind(since),
    env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE type='click' AND ${NB} AND page='radio' AND target='homepage' AND created_at >= ?`).bind(since),
    env.DB.prepare(`SELECT COUNT(DISTINCT player_id) c FROM events WHERE type='click' AND ${NB} AND page='radio' AND target='homepage' AND created_at >= ?`).bind(since),
    // 「総アクセス数」= 全ページ合計のページビュー件数(Bot除外・重複アクセスも1件ずつ加算)。
    // ユニークユーザー数とは異なる指標であることを明確にするため別項目として返す。
    env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE type='pageview' AND ${NB} AND created_at >= ?`).bind(since),
    env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE is_bot = 1 AND created_at >= ?`).bind(since),
  ];

  const r = await env.DB.batch(stmts);

  const pageViewCounts = {};
  allRows(r[14]).forEach((row) => { pageViewCounts[row.page] = row.c; });
  const pageViewUniques = {};
  allRows(r[15]).forEach((row) => { pageViewUniques[row.page] = row.c; });
  const stagePlayCounts = {};
  allRows(r[5]).forEach((row) => { stagePlayCounts[row.page] = row.c; });
  const durationByStage = {};
  allRows(r[13]).forEach((row) => { durationByStage[row.page] = { avgMs: row.a || 0, count: row.c || 0 }; });

  return json({
    generatedAt: new Date().toISOString(),
    period: period, // 'all' | 'launch' (どちらもデータの削除・変更は伴わない集計時のフィルタ)
    launchAt: LAUNCH_AT_ISO,
    players: {
      totalPlayed: firstRow(r[0]).c || 0,
      playedToday: firstRow(r[1]).c || 0,
      playedThisWeek: firstRow(r[2]).c || 0,
      playedThisMonth: firstRow(r[3]).c || 0,
      newToday: firstRow(r[6]).c || 0,
      returningToday: firstRow(r[7]).c || 0,
    },
    plays: {
      total: firstRow(r[4]).c || 0,
      byStage: { stage1: stagePlayCounts.stage1 || 0, stage2: stagePlayCounts.stage2 || 0, stage3: stagePlayCounts.stage3 || 0 },
    },
    // 総アクセス数(全ページの合計ページビュー件数)。同一ユーザーの再アクセスも
    // 1件ずつ加算される「延べ数」で、ユニークユーザー数(players.totalPlayed等)
    // とは異なる指標。混同を避けるため必ず両方を返す。
    traffic: {
      totalPageviews: firstRow(r[20]).c || 0,
      botEventsExcluded: firstRow(r[21]).c || 0,
    },
    duration: {
      overallAvgMs: firstRow(r[12]).a || 0,
      overallCount: firstRow(r[12]).c || 0,
      byStage: durationByStage,
    },
    platform: allRows(r[8]).map((row) => ({ platform: row.platform || 'other', count: row.c })),
    browser: allRows(r[9]).map((row) => ({ browser: row.browser || 'other', count: row.c })),
    country: allRows(r[10]).map((row) => ({ country: row.country, count: row.c, uniquePlayers: row.u })),
    region: allRows(r[11]).map((row) => ({ country: row.country, region: row.region, count: row.c, uniquePlayers: row.u })),
    pageViews: ANALYTICS_PAGES.map((p) => ({ page: p, views: pageViewCounts[p] || 0, uniques: pageViewUniques[p] || 0 })),
    sources: allRows(r[16]).map((row) => ({ source: row.source || '不明', count: row.c })),
    radio: {
      views: pageViewCounts.radio || 0,
      uniqueViewers: pageViewUniques.radio || 0,
      musicClicks: firstRow(r[17]).c || 0,
      homepageClicks: firstRow(r[18]).c || 0,
      homepageUniqueClickers: firstRow(r[19]).c || 0,
    },
  });
}
