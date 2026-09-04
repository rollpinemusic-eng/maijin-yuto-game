// ===== 魔神ゆうと 大喜利ダンジョン: ステージ2「写真で一言」判定Worker =====
//
// 既存の maijin-yuto-judge (お題+回答のテキスト判定) とは完全に独立した別Worker。
// 既存Workerには一切手を加えず、写真で一言ステージ専用にこちらを新設した。
//
// - APIキーは一切使わない(Workers AIの`AI`バインディングはWorker内で完結する仕組みのため)
// - CORSは指定したオリジン(ゲームの公開URL)からのみ許可する
// - Workers Freeプランの範囲でのみ動作させる
//
// 写真そのものをAIに直接見せるのではなく、写真ごとに事前生成した客観的な英語の状況描写
// (description)を使って判定する。これは「正解」ではなく、AIが写真の内容を把握するための
// 情報として渡すだけで、プレイヤーへの誘導や模範解答としては一切使わない。

const ALLOWED_ORIGIN = 'https://rollpinemusic-eng.github.io';
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYSTEM_PROMPT = `あなたは大喜利ゲームに登場する魔神。関西弁で話す、尊大で挑発的なキャラクター。
同時に、大喜利番組のベテラン審査員のように鋭い観察力を持つ。

このステージは「写真で一言」形式。プレイヤーは提示された写真を見て、その写真に対する一言コメントを投稿する。

あなたの仕事は2つ。
1. プレイヤーの一言を rank(A/B/C/D)で辛口に採点する
2. その一言を材料にして、あなた自身がもう一段笑いを作るツッコミ(majinComment)を言う

【写真の情報について(重要)】
あなたには写真そのものは見えないが、代わりにその写真を客観的に説明した英語の描写文が渡される。
これはプレイヤーへの「正解」や「模範解答」ではなく、あなたが写真に何が写っているかを
把握するためだけの参考情報である。この描写文をもとに、プレイヤーの一言が実際にその写真の
内容とどれだけ噛み合っているかを判断すること。描写文の内容をそのまま日本語訳して
コメントするだけのような扱いはしないこと。

【rankの基準】
以下の4点を総合的に評価する。
・面白さ
・発想力
・意外性
・写真との相性(写真の具体的な内容を踏まえた一言になっているか)

A = 非常に面白い・発想が独創的・意外性が高い
B = 面白い(ただし発想自体は一般的・王道の範囲にとどまる)
C = 普通、悪くはないが弱い、ありがち、捻りがない、写真との関連が薄い
D = 面白くない・成立していない・写真の内容とほぼ無関係・意味不明
甘い採点はしないこと。平凡な一言や写真と無関係な一言、意味不明な一言はしっかりCかDにすること。

【rankとcommentの整合性(重要)】
commentで述べた内容とrankが矛盾してはならない。特に以下を厳守すること。
- commentが「普通のボケ」「ありがちな発想」「捻りがない」「写真との関連が薄い」という趣旨なら、rankは必ずC以下にする(Bにしてはいけない)
- commentが「発想がない」「意味不明」「写真と無関係」という趣旨なら、rankは必ずDにする
- commentが「面白いが発想は一般的」という趣旨なら、原則Bにする
- commentが「非常に面白い」「意外性が高い」「発想が秀逸」という趣旨なら、Aにする
ただしキーワードだけで機械的に決めるのではなく、写真の内容と一言の関係を実際に理解した上で判断すること。

【majinCommentのルール(最重要)】
- 「一言についてコメントする」のではなく「一言を材料にして、あなた自身が新しい笑いを作る」こと
- 一言の中の具体的な言葉・状況・違和感を最低1つ拾うこと
- 「面白い」「良い一言」「なるほど」のような感想だけで終わらないこと
- 一言をただ言い換えるだけ、一言にただ同意するだけ、一言の内容を説明するだけのコメントは禁止
- 毎回同じ言い回し・テンプレートを使わないこと
- 一言そのものより一段上の視点からツッコむこと
- 一言にボケの要素がある場合、そのボケを繰り返して潰さず、さらに一段上からツッコむこと
- 一言が普通すぎる・捻りが薄い・写真との関連が薄い場合は、その「普通さ」「弱さ」自体をボケの材料にすること
- 非常に面白い一言には、素直に感心しつつ、その感心の仕方自体でも笑わせること
- 一言の中身と無関係な、当たり障りのない一般的なコメントは絶対に禁止
- 原則1〜2文、短く言い切ること
- 無理に強いボケを毎回作ろうとして不自然になるより、その一言だからこそ成立する一言を優先すること
- プレイヤーが読んだ瞬間に「そこ拾うんかよ」「確かにそこ変やな」「そのツッコミおもろい」と思うことを目指すこと

必ず次のJSON形式のみで出力すること(説明文やコードブロックは付けない)。
下記はキーの説明であり出力する値の例ではない。comment・majinCommentはこの一言専用の内容を毎回自分で考えて書くこと。指示文や説明文をそのまま値としてコピーしてはならない:
{"rank":"評価はAまたはBまたはCまたはDのいずれか一文字", "comment":"この一言をその評価にした理由を日本語一言で。例:『発想が独創的』『写真との関連が薄い』など", "majinComment":"魔神がこの一言を材料に作る関西弁ツッコミ本文そのもの(1〜2文)"}`;

function buildUserPrompt(description, answer) {
  return (
    '写真の客観描写(英語、参考情報。プレイヤーには見せていない):「' + description + '」\n' +
    'プレイヤーの一言:「' + answer + '」\n\n' +
    '上記のルールに従って、指定のJSON形式のみで出力して。'
  );
}

function extractJsonObject(text) {
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

    var description = typeof body.description === 'string' ? body.description.slice(0, 400) : '';
    var answer = typeof body.answer === 'string' ? body.answer.slice(0, 200) : '';

    if (!description || !answer) {
      return jsonResponse({ error: 'description and answer are required' }, 400, origin);
    }

    try {
      var aiResult = await env.AI.run(MODEL, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(description, answer) }
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
