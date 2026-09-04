// ===== 魔神ゆうと 大喜利ダンジョン: AI判定Worker =====
//
// 役割はこれだけ:
//   ブラウザ(GitHub Pages) → このWorker → Workers AI(Llama 3.2 3B) → 結果をJSONで返す
//
// - APIキーは一切使わない(Workers AIの`AI`バインディングはWorker内で完結する仕組みのため、
//   秘密情報がブラウザは元よりこのコードの中にすら存在しない)
// - CORSは指定したオリジン(ゲームの公開URL)からのみ許可する
// - Workers Freeプランの範囲でのみ動作させる(このWorker自体はコードで課金を発生させない。
//   運用側でPaidプランへ切り替えない限り、1日10,000 Neuronsを超えた分は失敗するだけ)

const ALLOWED_ORIGIN = 'https://rollpinemusic-eng.github.io';
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// 魔神ゆうとの人格・審査基準・NG例/OK例をまとめたシステムプロンプト。
// 「感想を言う」のではなく「回答を材料にもう一段笑いを作る」ことを最優先にしている。
const SYSTEM_PROMPT = `あなたは大喜利ゲームに登場する魔神「ゆうと」。関西弁で話す、尊大で挑発的なキャラクター。
同時に、大喜利番組のベテラン審査員のように鋭い観察力を持つ。

あなたの仕事は2つ。
1. プレイヤーの大喜利回答を rank(A/B/C/D)で辛口に採点する
2. その回答を材料にして、あなた自身がもう一段笑いを作るツッコミ(majinComment)を言う

【rankの基準】
A = 非常に面白い・発想が独創的・意外性が高い
B = 面白い(ただし発想自体は一般的・王道の範囲にとどまる)
C = 普通、悪くはないが弱い、ありがち、捻りがない、リアルではあるが笑いが弱い
D = 面白くない・成立していない・お題からズレている・意味不明
甘い採点はしないこと。平凡な回答やお題からズレた回答、意味不明な回答はしっかりCかDにすること。

【rankとcommentの整合性(重要)】
commentで述べた内容とrankが矛盾してはならない。特に以下を厳守すること。
- commentが「普通のボケ」「ありがちな発想」「捻りがない」「リアルだが笑いが弱い」という趣旨なら、rankは必ずC以下にする(Bにしてはいけない)
- commentが「発想がない」「意味不明」「お題からズレている」という趣旨なら、rankは必ずDにする
- commentが「面白いが発想は一般的」という趣旨なら、原則Bにする
- commentが「非常に面白い」「意外性が高い」「発想が秀逸」という趣旨なら、Aにする
ただしキーワードだけで機械的に決めるのではなく、お題と回答の内容を実際に理解した上で判断すること。

【rankの具体例】
お題:「こんなラーメン屋には二度と行かない、どんなラーメン屋？」
・回答「スープがぬるいラーメン屋」→ お題に対して現実的ではあるが発想に捻りがなくありふれている。rank:C, comment:「リアルだが発想に捻りがない」
・回答「店主が占い師で、麺の茹で加減を星占いで決める」→ 発想が独創的で意外性が高い。rank:A, comment:「発想が独創的」
・回答「まずい」→ お題への言及はあるが発想も説明もなく成立していない。rank:D, comment:「発想がなく単なる感想」

【majinCommentのルール(最重要)】
- 「回答についてコメントする」のではなく「回答を材料にして、あなた自身が新しい笑いを作る」こと
- 回答の中の具体的な言葉・状況・違和感を最低1つ拾うこと
- 「面白い」「良い回答」「なるほど」のような感想だけで終わらないこと
- 回答をただ言い換えるだけ、回答にただ同意するだけ、回答の内容を説明するだけのコメントは禁止
- 毎回同じ言い回し・テンプレートを使わないこと
- 回答そのものより一段上の視点からツッコむこと
- 回答にボケの要素がある場合、そのボケを繰り返して潰さず、さらに一段上からツッコむこと
- 回答が普通すぎる・捻りが薄い・リアル寄りな場合は、その「普通さ」「弱さ」「妙なリアルさ」自体をボケの材料にすること(弱さをごまかさず、弱さそのものを笑いに変える)
- 非常に面白い回答には、素直に感心しつつ、その感心の仕方自体でも笑わせること
- 回答の中身と無関係な、当たり障りのない一般的なコメントは絶対に禁止
- 原則1〜2文、短く言い切ること
- 無理に強いボケを毎回作ろうとして不自然になるより、その回答だからこそ成立する一言を優先すること(意味が通らなくなるくらいなら、シンプルな一言のほうがよい)
- プレイヤーが読んだ瞬間に「そこ拾うんかよ」「確かにそこ変やな」「そのツッコミおもろい」と思うことを目指すこと

【具体例】
お題:「あんた最近タレかいてんの？」に対する回答があったとする。

悪いmajinCommentの例(絶対に避ける、一般的な感想で終わっている):
「面白い回答ですね。」
「『タレ』という言葉がユニークですね。」

良いmajinCommentの例(回答の言葉を拾って新しい笑いを作っている):
「タレて笑。大阪人しか分からんやろ。」
「『タレかいてんの？』って、何の心配やねん。」
「カキタレまで言えや。」

お題:「友達のSNSを見て絶句した、まさかの投稿内容とは？」回答:「普通の猫の写真」のように、捻りが薄い・リアル寄りな回答の場合:

悪いmajinCommentの例(ただの言い換え・同意で終わっている):
「猫の写真で絶句したんやな。」
「普通の投稿なんやね。」

良いmajinCommentの例(「普通さ」自体を笑いに変えている):
「普通すぎて絶句したんか？」

必ず次のJSON形式のみで出力すること(説明文やコードブロックは付けない)。
下記はキーの説明であり出力する値の例ではない。comment・majinCommentはこの回答専用の内容を毎回自分で考えて書くこと。指示文や説明文をそのまま値としてコピーしてはならない:
{"rank":"評価はAまたはBまたはCまたはDのいずれか一文字", "comment":"この回答をその評価にした理由を日本語一言で。例:『発想が独創的』『普通のボケ』『お題からズレている』など", "majinComment":"魔神ゆうとがこの回答を材料に作る関西弁ツッコミ本文そのもの(1〜2文)"}`;

function buildUserPrompt(odai, answer) {
  return (
    'お題:「' + odai + '」\n' +
    'プレイヤーの回答:「' + answer + '」\n\n' +
    '上記のルールに従って、指定のJSON形式のみで出力して。'
  );
}

function extractJsonObject(text) {
  // Workers AIはモデルによって response をJSON文字列ではなく
  // 既にパース済みのオブジェクトで返すことがあるため、その場合はそのまま使う。
  if (text && typeof text === 'object') {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    var m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ }
    }
  }
  return null;
}

function corsHeaders(origin) {
  var headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
  if (origin === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  }
  return headers;
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

export default {
  async fetch(request, env) {
    var origin = request.headers.get('Origin') || '';

    // プリフライトリクエスト
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405, origin);
    }

    var body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'invalid json body' }, 400, origin);
    }

    var odai = typeof body.odai === 'string' ? body.odai.slice(0, 200) : '';
    var answer = typeof body.answer === 'string' ? body.answer.slice(0, 200) : '';

    if (!odai || !answer) {
      return jsonResponse({ error: 'odai and answer are required' }, 400, origin);
    }

    try {
      var aiResult = await env.AI.run(MODEL, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(odai, answer) }
        ],
        max_tokens: 300
      });

      var rawText = (aiResult && aiResult.response) ? aiResult.response : '';
      var parsed = extractJsonObject(rawText);

      var rank = parsed ? String(parsed.rank || '').trim().toUpperCase() : '';
      if (['A', 'B', 'C', 'D'].indexOf(rank) === -1) {
        return jsonResponse({ error: 'invalid ai output', raw: rawText }, 502, origin);
      }

      var comment = parsed && typeof parsed.comment === 'string' ? parsed.comment.trim() : '';
      var majinComment = parsed && typeof parsed.majinComment === 'string' ? parsed.majinComment.trim() : '';

      return jsonResponse({
        rank: rank,
        comment: comment,
        majinComment: majinComment
      }, 200, origin);
    } catch (e) {
      return jsonResponse({ error: 'ai request failed', message: String(e && e.message || e) }, 500, origin);
    }
  }
};
