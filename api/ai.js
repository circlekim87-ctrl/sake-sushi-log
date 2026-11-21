/* =====================================================================
   api/ai.js — 사케 노트 AI 라벨 인식 프록시 (Vercel 서버리스 함수)
   ---------------------------------------------------------------------
   POST /api/ai
     body : { imageBase64, mimeType, prompt, lang }
            · imageBase64  라벨 사진의 base64 (data: 접두어 없이)
            · mimeType     image/jpeg · image/png 등 (사진이 있으면 필수)
            · prompt       모델에 보낼 지시문 (선택, 기본 프롬프트가 있다)
            · lang         앱 언어 'ko' | 'en' | 'ja' (선택, 기본 ko)
                           — 모든 값이 이 언어로만 나오게 서버가 규칙을 건다
     env  : GEMINI_API_KEY  (Vercel 대시보드 › Settings › Environment Variables)
   ---------------------------------------------------------------------
   · 키는 절대 코드에 넣지 않는다. process.env.GEMINI_API_KEY 만 쓴다.
   · 키가 없으면 503 { error: 'not_configured' } — 앱은 이때 개인 키 안내로 넘어간다.
   · 프론트엔드(app.js)와 같은 무료 Gemini 모델 체인을 순서대로 시도하고,
     400·404·429·500·502·503·504 는 다음 모델로 넘어간다.
   · 브라우저에서 오는 값은 라벨 사진과 지시문뿐이다(기록·좌표·개인정보 없음).
   ===================================================================== */
'use strict';

var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
/* app.js 의 GEMINI_MODELS 와 같은 순서 — 두 곳이 어긋나면 라벨 인식 품질이 달라진다 */
var GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-4-hydrogen'
];
var RETRY_STATUS = [400, 404, 429, 500, 502, 503, 504];
/* Vercel 서버리스 함수의 요청 본문 상한은 4.5MB 다. 그보다 조금 낮게 잡아
   플랫폼이 먼저 413 을 돌려주는 일 없이 우리가 읽을 수 있는 크기만 받는다. */
var MAX_BODY_BYTES = 4 * 1024 * 1024;
var MAX_IMAGE_CHARS = 3.4 * 1024 * 1024;     // base64 문자 수(원본 약 2.5MB)
var MAX_PROMPT_CHARS = 4000;
var MODEL_TIMEOUT_MS = 20000;                // 모델 한 번의 상한
var TOTAL_BUDGET_MS = 50000;                 // 함수 전체 상한(maxDuration 60초)
var RATE_PER_MIN = 12;
var RATE_PER_HOUR = 60;

var DEFAULT_PROMPT = '이 사진은 주류(사케·와인·전통주·위스키) 병·라벨입니다. 사진에 병이 1병이면 1개, 여러 병이면 보이는 모든 병을 왼쪽부터 순서대로 빠짐없이 담아 JSON 하나로만 답하세요. ' +
  '병마다 어느 주종인지 따로 판단하고(한 사진에 사케와 샴페인이 섞여 있어도 각각 맞게), 읽을 수 있는 정보만 골라 채우세요. 모르면 빈 문자열. ' +
  '형식: {"items":[{"category":"sake|wine|traditional|whisky","name":"","brewery":"생산자·양조장·증류소","grade":"사케 등급 또는 와인·전통주·위스키 종류","vintage":"와인 빈티지 연도","polish":"사케 정미보합 숫자","rice":"사케 주조미·와인 품종·전통주 원료","hiire":"hiire|namachozo|nama|yamahai","age":"위스키 숙성연수","cask":"위스키 캐스크","abv":"도수 숫자","memo":"한 줄 메모"}]}';

/* -------------------------- 출력 언어 강제 --------------------------
   라벨에는 일본어 한자·가나·영문이 그대로 적혀 있어서, 그대로 두면 한국어 화면에서
   브랜드가 田酒/덴슈 처럼 갈라지고 등급·주조미가 원문으로 섞인다. 앱은 요청 본문에
   lang(ko·en·ja)을 싣고, 여기서도 같은 규칙을 프롬프트 끝에 한 번 더 건다 —
   예전 화면(캐시된 JS)이나 lang 없이 온 요청도 한국어로 나오게 하기 위해서다.
   프롬프트에 이미 언어 규칙이 들어 있으면(새 화면) 두 번 붙이지 않는다. */
var LANG_RULES = {
  ko: '반드시 한국어(한글)로만 답하세요. name·brewery·grade·rice·cask·memo 같은 모든 글자 값은 ' +
    '라벨에 일본어(한자·히라가나·가타카나)나 영어·프랑스어가 적혀 있어도 원문을 그대로 옮기지 말고, ' +
    '한국 주류 애호가들이 쓰는 한국어 표기(음차 또는 번역)로 바꿔 쓰세요. ' +
    '같은 브랜드는 사진 안에서 표기를 하나로 통일하세요(田酒와 田酒 純米大吟醸는 모두 덴슈). ' +
    '예: 田酒→덴슈, 而今→지콘, 新政→아라마사, 信州亀齢→신슈키레이, 黒龍→코쿠류, 十四代→주욘다이, ' +
    '獺祭→닷사이, 久保田→쿠보타, 鍋島→나베시마, 純米大吟醸→준마이 다이긴조, 純米吟醸→준마이긴조, ' +
    '特別純米→특별준마이, 山田錦→야마다니시키, 八反錦→핫타니시키, 雄町→오마치, 火入れ→히이레, ' +
    '生酛→기모토, 山廃→야마하이, Barrat Masson Les Margannes→바라 마송 레 마르간. ' +
    '위 예시는 표기 방식만 보여 주는 것입니다. 사진에 실제로 보이지 않는 브랜드는 절대 쓰지 마세요. ' +
    '단, category와 hiire는 정해진 영문 코드(sake·wine·traditional·whisky, hiire·namachozo·nama·yamahai) ' +
    '그대로 쓰고, polish·abv·vintage·age는 숫자만 쓰세요.',
  en: 'Write every text value (name, brewery, grade, rice, cask, memo) in English. ' +
    'Even when the label is in Japanese (kanji, hiragana, katakana), Korean or French, ' +
    'do not copy the original script: use the romanized brand and brewery names and English style names. ' +
    'Use one spelling per brand across the photo (田酒 and 田酒 純米大吟醸 are both Denshu). ' +
    'Examples: 田酒→Denshu, 而今→Jikon, 新政→Aramasa, 信州亀齢→Shinshu Kirei, 黒龍→Kokuryu, ' +
    '十四代→Juyondai, 純米大吟醸→Junmai Daiginjo, 純米吟醸→Junmai Ginjo, 特別純米→Tokubetsu Junmai, ' +
    '山田錦→Yamadanishiki, 八反錦→Hattanishiki, 火入れ→Hi-ire. ' +
    'These examples only show the spelling style: never output a brand that is not visible in the photo. ' +
    'Keep category and hiire as the given codes (sake·wine·traditional·whisky, hiire·namachozo·nama·yamahai) ' +
    'and write polish·abv·vintage·age as digits only.',
  ja: 'すべての文字列（name・brewery・grade・rice・cask・memo など）は日本語で書いてください。' +
    'ラベルが英語・ハングル・フランス語でも原語のまま写さず、日本語の表記に直してください。' +
    '同じ銘柄は写真の中で表記を一つに統一してください（例：Denshu→田酒、Jikon→而今、' +
    'Junmai Daiginjo→純米大吟醸、Yamadanishiki→山田錦、Hi-ire→火入れ）。' +
    '上の例は表記のしかたを示すだけです。写真に写っていない銘柄は書かないでください。' +
    'ただし category と hiire は指定のコード（sake・wine・traditional・whisky、' +
    'hiire・namachozo・nama・yamahai）のまま、polish・abv・vintage・age は数字のみで書いてください。'
};
/* 새 화면(aiLangInstruction)이 이미 넣은 규칙인지 보는 표식 — 있으면 다시 붙이지 않는다 */
var LANG_MARKERS = ['반드시 한국어(한글)로만', 'Write every text value', 'すべての文字列'];
function normalizeLang(v) {
  var l = String(v == null ? '' : v).trim().toLowerCase();
  return (l === 'en' || l === 'ja' || l === 'ko') ? l : 'ko';   // 기본값 한국어
}
function hasLangRule(prompt) {
  var p = String(prompt || '');
  for (var i = 0; i < LANG_MARKERS.length; i++) {
    if (p.indexOf(LANG_MARKERS[i]) >= 0) return true;
  }
  return false;
}
function withLangRule(prompt, lang) {
  var p = String(prompt == null ? '' : prompt).trim();
  var rule = LANG_RULES[normalizeLang(lang)];
  if (!p) return rule;
  if (hasLangRule(p)) return p;
  return p + ' ' + rule;
}

/* ------------------------------ 응답 도우미 ------------------------------ */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, status, body) {
  cors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/* ------------------------------ 입력 검증 ------------------------------ */
function clientIp(req) {
  var fwd = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  var ip = Array.isArray(fwd) ? fwd[0] : String(fwd || '');
  ip = ip.split(',')[0].trim();
  return ip || 'unknown';
}

/* 서버리스 인스턴스 안에서만 쓰는 가벼운 남용 방지. 인스턴스가 새로 뜨면 초기화된다. */
var _hits = new Map();
function rateLimited(ip, now) {
  var t = now || Date.now();
  var list = _hits.get(ip) || [];
  list = list.filter(function (ts) { return t - ts < 3600 * 1000; });
  var lastMin = list.filter(function (ts) { return t - ts < 60 * 1000; }).length;
  if (lastMin >= RATE_PER_MIN || list.length >= RATE_PER_HOUR) {
    _hits.set(ip, list);
    return true;
  }
  list.push(t);
  _hits.set(ip, list);
  if (_hits.size > 2000) {                        // 메모리 누수 방지
    _hits.forEach(function (v, k) {
      if (!v.some(function (ts) { return t - ts < 3600 * 1000; })) _hits.delete(k);
    });
  }
  return false;
}

function readStream(req) {
  return new Promise(function (resolve) {
    var chunks = [], size = 0, done = false;
    function finish(v) { if (done) return; done = true; resolve(v); }
    req.on('data', function (c) {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { finish(null); return; }
      chunks.push(c);
    });
    req.on('end', function () { finish(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', function () { finish(null); });
  });
}

async function readJson(req) {
  var raw = req.body;
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  var text;
  if (typeof raw === 'string') text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else text = await readStream(req);
  if (text == null) return null;                  // 너무 큼 / 읽기 실패
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) { return null; }
}

function validate(body) {
  if (!body || typeof body !== 'object') return 'bad_body';
  var prompt = (body.prompt == null) ? '' : String(body.prompt);
  if (prompt.length > MAX_PROMPT_CHARS) return 'prompt_too_long';
  var b64 = (body.imageBase64 == null) ? '' : String(body.imageBase64);
  if (b64) {
    if (b64.length > MAX_IMAGE_CHARS) return 'image_too_large';
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) return 'bad_image';
    var mime = String(body.mimeType || '').trim();
    if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return 'bad_mime';
  } else if (!prompt.trim()) {
    return 'no_input';                            // 사진도 지시문도 없다
  }
  return '';
}

/* ------------------------------ Gemini 호출 ------------------------------ */
function geminiBody(mime, b64, prompt) {
  var parts = [{ text: prompt }];
  if (b64) parts.push({ inlineData: { mimeType: mime, data: b64 } });
  return {
    contents: [{ role: 'user', parts: parts }],
    /* 여러 병(9~12병)의 JSON 이 잘리지 않게 넉넉히 — 응답은 JSON 이라 길어도 몇 KB 다 */
    generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 2048 }
  };
}

function geminiText(json) {
  var cands = (json && json.candidates) || [];
  if (!cands.length) {
    var why = json && json.promptFeedback && json.promptFeedback.blockReason;
    if (why) {
      var blocked = new Error('사진이 안전 필터에 걸렸어요 (' + why + ')');
      blocked.status = 400;
      blocked.blocked = true;
      throw blocked;
    }
    return '';
  }
  var parts = (cands[0].content && cands[0].content.parts) || [];
  return parts.filter(function (p) { return p && p.text && !p.thought; })
    .map(function (p) { return p.text; }).join('').trim();
}

async function geminiOnce(model, key, body, timeoutMs) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) { /* noop */ } }, timeoutMs);
  try {
    var res = await fetch(GEMINI_ENDPOINT + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    });
    var txt = await res.text();
    var json = null;
    try { json = JSON.parse(txt); } catch (e) { json = null; }
    return { status: res.status, ok: res.ok, json: json };
  } catch (e) {
    var err = new Error('network');
    err.status = 0;                                // 시간 초과·연결 실패
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function retryable(status) { return RETRY_STATUS.indexOf(status) >= 0; }
function busyStatus(status) { return status === 429 || (status >= 500 && status <= 504); }

async function generate(key, mime, b64, prompt) {
  var body = geminiBody(mime, b64, prompt);
  var t0 = Date.now();
  var last = { status: 0, message: '알 수 없는 오류' };
  var tried = [];
  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    var model = GEMINI_MODELS[i];
    var left = TOTAL_BUDGET_MS - (Date.now() - t0);
    if (left < 2000) break;                        // 남은 시간이 없으면 새 모델을 걸지 않는다
    tried.push(model);
    try {
      var r = await geminiOnce(model, key, body, Math.min(MODEL_TIMEOUT_MS, left));
      if (r.ok) {
        var text = geminiText(r.json);
        if (text) return { text: text, model: model };
        last = { status: 200, message: '빈 응답' };  // 빈 답은 다음 모델로
      } else {
        var detail = (r.json && r.json.error && r.json.error.message) || '';
        last = { status: r.status, message: String(detail).slice(0, 200) || ('HTTP ' + r.status) };
        if (!retryable(r.status)) break;
      }
    } catch (e) {
      last = { status: (e && e.status) || 0, message: (e && e.message) || 'network' };
      if (e && e.blocked) break;                     // 안전 필터는 모델을 바꿔도 같다
    }
  }
  var out = new Error(last.message);
  out.status = last.status;
  out.tried = tried;
  throw out;
}

/* ------------------------------ 핸들러 ------------------------------ */
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    send(res, 405, { error: 'method_not_allowed' });
    return;
  }
  var key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    send(res, 503, { error: 'not_configured' });
    return;
  }
  if (rateLimited(clientIp(req))) {
    send(res, 429, { error: 'rate_limited', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    return;
  }
  var len = Number(req.headers && req.headers['content-length']);
  if (len && len > MAX_BODY_BYTES) {
    send(res, 413, { error: 'too_large', message: '사진이 너무 커요. 조금 작은 사진으로 다시 시도해 주세요.' });
    return;
  }
  var body = await readJson(req);
  var bad = validate(body);
  if (bad) {
    var status = (bad === 'image_too_large') ? 413 : 400;
    send(res, status, { error: bad });
    return;
  }
  var mime = String(body.mimeType || '').trim();
  var b64 = String(body.imageBase64 || '');
  var lang = normalizeLang(body.lang);
  /* 사진만 왔을 때는 기본 프롬프트, 지시문이 왔으면 앱 언어 규칙을 보태거나 그대로 쓴다 */
  var prompt = withLangRule(String(body.prompt || '').trim() || DEFAULT_PROMPT, lang);
  try {
    var out = await generate(key, mime, b64, prompt);
    send(res, 200, { ok: true, model: out.model, text: out.text });
  } catch (e) {
    var st = (e && e.status) || 0;
    if (st === 400 && e && String(e.message).indexOf('안전 필터') >= 0) {
      send(res, 400, { error: 'blocked', message: e.message });
      return;
    }
    if (st === 401 || st === 403) {
      send(res, 502, { error: 'upstream_auth', message: '서버 AI 키를 확인해 주세요.' });
      return;
    }
    if (busyStatus(st)) {
      send(res, 503, { error: 'busy', message: 'AI 서버가 일시적으로 혼잡해요. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    if (String(e && e.message) === '빈 응답') {
      send(res, 502, { error: 'empty', message: '라벨을 읽지 못했어요.' });
      return;
    }
    send(res, 502, { error: 'upstream', status: st, message: (e && e.message) || 'unknown' });
  }
};

/* 테스트용(운영 동작에는 영향 없음) */
module.exports.__resetRateLimit = function () { _hits.clear(); };
module.exports.__rateLimited = rateLimited;
module.exports.__validate = validate;
module.exports.__geminiBody = geminiBody;
module.exports.__geminiText = geminiText;
module.exports.__normalizeLang = normalizeLang;
module.exports.__withLangRule = withLangRule;
module.exports.__hasLangRule = hasLangRule;
module.exports.LANG_RULES = LANG_RULES;
module.exports.DEFAULT_PROMPT = DEFAULT_PROMPT;
module.exports.GEMINI_MODELS = GEMINI_MODELS;
