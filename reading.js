/* ===========================================================
   reading.js — 일본어 독음 / 중국어 병음 루비 표기 레이어
   JA·CA Code 전용. reading-data.js → reading.js → main.js 순서로 로드.

   [원칙]
   교범(CAM Rev.23)에서 추출한 공식 독음/병음만 사용한다. 자동 생성은 하지 않는다.
   교범의 독음은 교관이 손으로 다듬은 것이라 규칙으로 재현하면 68% 수준에서
   어긋나며, 교범과 다른 독음으로 훈련시키면 평가 기준과 충돌하기 때문이다.

   사전에 없는 토큰은 독음을 비우고 점선 밑줄로 표시한다.
   관리자 콘솔에서 window.READING_MISSING 으로 누락 목록 확인 가능.

   [교범 개정 시] extract_cam.py 를 새 PDF로 다시 돌려 reading-data.js 교체.
   =========================================================== */

window.READING_MISSING = { ja: new Set(), ca: new Set() };

/* ── 문안 내장 독음 맵 ─────────────────────────────────────────────
   방송문 데이터에는 교범 그대로 '독음 줄 + 가나 줄'이 쌍으로 들어있다.
   두 줄을 구두점·공백 기준으로 같은 규칙으로 쪼개면 대부분 1:1로 맞는다.
   이 방식은 사전과 달리 문안이 개정돼도 함께 갱신되므로 유지보수가 필요 없다.
   맞지 않는 줄만 교범 사전(CAM_JA_YOMI)으로 보완한다.
─────────────────────────────────────────────────────────────────── */
let _SCRIPT_YOMI = {};   // 현재 방송문의 '가나 덩어리 → 독음'

const _RD_SEP = /[\s、。，．・「」/／\[\]（）()【】]+/;
// 조회 키: 가나(및 장음)만 남긴다. 숫자('10ねんの')·기호('ようこそ！') 차이를 흡수.
function _kanaKey(s) {
  let o = '';
  for (const c of String(s || '')) if (_isKanaCh(c)) o += c;
  return o;
}
function _rdUnits(s, isYomiSide) {
  // 대괄호 안이 중첩된 경우가 있어(예: '[가. ... [출발지/목적지]노 ...') 
  // 가장 안쪽 대괄호만 제거해야 내용이 통째로 사라지지 않는다.
  const t = String(s || '').replace(/\[[^\[\]]*\]/g, ' ');
  const re = isYomiSide ? /[가-힣]/ : /[\u3040-\u30ff]/;
  return t.split(_RD_SEP)
    .filter(x => re.test(x))
    // '가.' '나.' 같은 목록 표시는 독음이 아니므로 제외 (양쪽 토큰 수를 어긋나게 함)
    .filter(x => !/^[가-힣][.．]$/.test(x.trim()));
}
function _rdIsYomiLine(t) {
  const s = String(t || '').trim();
  if (!s || s.includes('|')) return false;
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(s)) return false;
  return (s.match(/[가-힣]/g) || []).length >= 3;
}

// 가나 덩어리의 박(拍) 수 — 요음은 앞 글자와 한 박, 장음·촉음은 각 1박
function _moraOf(s) {
  let n = 0;
  for (const c of s) if (!'ゃゅょャュョ'.includes(c)) n++;
  return n;
}
// 독음의 음절 수 — 한글 음절 + 장음 기호('-')
function _sylOf(s) {
  return (s.match(/[가-힣]/g) || []).length + (s.match(/-/g) || []).length;
}
// 개수가 다른 두 열을 박/음절 수가 가장 가깝게 대응시킨다 (1:1, 2:1, 1:2 허용).
function _alignByMora(kArr, yArr) {
  const K = kArr.length, Y = yArr.length;
  const INF = 1e9;
  const dp = Array.from({ length: K + 1 }, () => new Array(Y + 1).fill(INF));
  const bk = Array.from({ length: K + 1 }, () => new Array(Y + 1).fill(null));
  dp[0][0] = 0;
  const cost = (ks, ys) => Math.abs(_moraOf(ks) - _sylOf(ys));
  for (let i = 0; i <= K; i++) for (let j = 0; j <= Y; j++) {
    if (dp[i][j] === INF) continue;
    const steps = [[1, 1], [2, 1], [1, 2]];
    for (const [di, dj] of steps) {
      if (i + di > K || j + dj > Y) continue;
      const ks = kArr.slice(i, i + di).join('');
      const ys = yArr.slice(j, j + dj).join(' ');
      const c = dp[i][j] + cost(ks, ys) + (di + dj > 2 ? 1 : 0);
      if (c < dp[i + di][j + dj]) { dp[i + di][j + dj] = c; bk[i + di][j + dj] = [i, j, di, dj]; }
    }
  }
  if (dp[K][Y] === INF) return [];
  const out = [];
  let i = K, j = Y;
  while (i > 0 || j > 0) {
    const b = bk[i][j];
    if (!b) break;
    const [pi, pj, di, dj] = b;
    if (di === 1) {
      out.push([kArr[pi], yArr.slice(pj, pj + dj).join(' ')]);
    } else if (di === 2 && dj === 1) {
      // 독음 하나가 가나 둘에 걸친 경우(교범 띄어쓰기 차이) 박 수 비율로 나눈다.
      // 원본이 교범의 독음이므로 자르는 위치만 정하면 되고, 박 수 비례가 안정적이다.
      const k1 = kArr[pi], k2 = kArr[pi + 1], ys = yArr[pj];
      const m1 = _moraOf(k1), m2 = _moraOf(k2);
      const syl = [...ys];
      const cut = Math.round(syl.length * m1 / (m1 + m2));
      if (cut > 0 && cut < syl.length) {
        out.push([k1, syl.slice(0, cut).join('')]);
        out.push([k2, syl.slice(cut).join('')]);
      }
    }
    i = pi; j = pj;
  }
  return out.reverse();
}

// 방송문 원문(독음 줄 포함)에서 맵을 만든다. 언어 전환·방송문 전환 시 호출.
function buildScriptYomiMap(rawText) {
  const map = {};
  const lines = String(rawText || '').split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!_rdIsYomiLine(lines[i])) continue;
    if (!/[\u3040-\u30ff]/.test(lines[i + 1])) continue;
    const y = _rdUnits(lines[i], true);
    const k = _rdUnits(lines[i + 1], false);
    // 토큰 수가 다르면(교범과 띄어쓰기가 다른 경우) 음절 수 기준으로 정렬한다.
    const aligned = (y.length === k.length)
      ? k.map((kk, j) => [kk, y[j]])
      : _alignByMora(k, y);
    for (const [kk, yy] of aligned) {
      const key = _kanaKey(kk);
      // 독음 값 앞뒤의 숫자·기호는 원문에 그대로 노출되므로 독음에서는 제거한다.
      const val = String(yy).trim().replace(/^[^가-힣]+/, '').replace(/[^가-힣\-]+$/, '');
      if (key && val && !map[key]) map[key] = val;
    }
  }
  _SCRIPT_YOMI = map;
  for (const k in _RD_PART_CACHE) delete _RD_PART_CACHE[k];
  return Object.keys(map).length;
}


const _RD_PUNC = '、。，．「」/[]（）()　 ';
function _rdNorm(s) {
  let o = '';
  for (const c of s) if (!_RD_PUNC.includes(c)) o += c;
  return o;
}
function _isKanaCh(c) { return (c >= '\u3040' && c <= '\u30ff') || c === 'ー'; }
function _isHanziCh(c) { return c >= '\u4e00' && c <= '\u9fff'; }

// 일본어 토큰 → 독음 조회 (정확일치 → 정규화 → 구두점 분할)
function lookupYomi(token) {
  const n = _rdNorm(token);
  if (!n) return null;
  const kk = _kanaKey(token);                            // 문안 내장 독음 우선
  if (kk && _SCRIPT_YOMI[kk]) return _SCRIPT_YOMI[kk];
  if (typeof CAM_JA_YOMI === 'undefined') return null;
  if (CAM_JA_YOMI[n]) return CAM_JA_YOMI[n];
  const parts = token.split(/[、。/]/).map(_rdNorm).filter(Boolean);
  if (parts.length > 1) {
    const got = parts.map(p => CAM_JA_YOMI[p]);
    if (got.every(Boolean)) return got.join(' ');
  }
  // 마지막 수단: 사전 항목들의 조합으로 분해 (교범과 띄어쓰기가 다른 경우)
  // 예) 'また、でんしきき' → 'また' + 'でんしきき'
  const combo = _splitByDict(n);
  return combo || _partialYomi(token);
}

/* ── 문절 일부 독음 ──────────────────────────────────────────────
   AI 학습가이드가 끊어읽기 기호(∙ /)를 문절 '중간'에 넣으면
   'ゆきで∙ございます' 처럼 덩어리가 쪼개져 사전 조회가 실패한다.
   쪼개진 조각이 원래 문절의 일부라면, 원래 문절의 독음에서 그 부분만 잘라 쓴다.
   자르는 기준: 가나 1자 = 독음 1음절. 단 요음·촉음·ん은 앞 음절에 붙으므로 0으로 센다.
   이 기준이 원래 문절에서 정확히 맞아떨어질 때만 사용한다(어긋나면 잘라내지 않음).
─────────────────────────────────────────────────────────────── */
const _RD_ZERO_W = 'ゃゅょャュョっッんンぁぃぅぇぉァィゥェォ';
function _kanaWeight(s) {
  let n = 0;
  for (const c of s) if (_isKanaCh(c) && !_RD_ZERO_W.includes(c)) n++;
  return n;
}
function _yomiUnits(y) {
  return [...String(y || '')].filter(c => /[가-힣]/.test(c) || c === '-');
}
const _RD_PART_CACHE = {};
function _partialYomi(token) {
  const chunk = _kanaKey(token);
  if (!chunk) return null;
  if (chunk in _RD_PART_CACHE) return _RD_PART_CACHE[chunk];
  const w = _kanaWeight(chunk);
  let found = null;
  const tryDict = (dict, minLen) => {
    if (found || !dict || chunk.length < minLen) return;
    for (const key of Object.keys(dict)) {
      const k = _kanaKey(key);
      const pos = k.indexOf(chunk);
      if (pos < 0 || k === chunk) continue;
      const units = _yomiUnits(dict[key]);
      if (units.length !== _kanaWeight(k)) continue;      // 1:1 대응이 깨진 문절은 쓰지 않음
      const before = _kanaWeight(k.slice(0, pos));
      const part = units.slice(before, before + w).join('');
      if (part) { found = part; return; }
    }
  };
  if (w > 0) {
    tryDict(_SCRIPT_YOMI, 1);                                 // 현재 방송문 우선
    tryDict(typeof CAM_JA_YOMI !== 'undefined' ? CAM_JA_YOMI : null, 2);
  }
  _RD_PART_CACHE[chunk] = found;
  return found;
}

// 문자열을 사전 항목의 연속으로 분해한다. 최장 일치 우선, 실패 시 null.
const _RD_SPLIT_CACHE = {};
function _splitByDict(s) {
  if (s in _RD_SPLIT_CACHE) return _RD_SPLIT_CACHE[s];
  const MAXLEN = 24;
  const solve = (str) => {
    if (!str) return [];
    for (let L = Math.min(MAXLEN, str.length); L >= 2; L--) {
      const head = str.slice(0, L);
      if (!CAM_JA_YOMI[head]) continue;
      const rest = solve(str.slice(L));
      if (rest) return [CAM_JA_YOMI[head], ...rest];
    }
    return null;
  };
  const r = solve(s);
  const out = r && r.length ? r.join(' ') : null;
  _RD_SPLIT_CACHE[s] = out;
  return out;
}

// HTML 조각에 ruby 주석 부착. 태그 내부는 건드리지 않음.
function annotateReading(html, lang) {
  if (!html || (lang !== 'ja' && lang !== 'ca')) return html;
  return html.split(/(<[^>]+>)/).map(seg => {
    if (!seg || seg[0] === '<') return seg;
    return lang === 'ja' ? _rubyJa(seg) : _rubyCa(seg);
  }).join('');
}

// 일본어: 공백으로 나뉜 문절 단위로 아래에 한글 독음
function _rubyJa(s) {
  // 연속된 가나 덩어리 단위로 독음을 단다. 구두점·공백이 자연스러운 경계가 된다.
  let out = '', buf = '';
  const flush = () => {
    if (!buf) return;
    const y = lookupYomi(buf);
    const body = _showPronPoint ? _jaPronBody(buf) : buf;
    if (y) out += '<ruby class="rb-ja">' + body + '<rt>' + y + '</rt></ruby>';
    else { window.READING_MISSING.ja.add(buf); out += '<span class="rb-missing">' + body + '</span>'; }
    buf = '';
  };
  for (const c of s) {
    if (_isKanaCh(c)) buf += c;
    else { flush(); out += c; }
  }
  flush();
  return out;
}

// 중국어: 한자 한 글자마다 위에 병음
function _rubyCa(s) {
  const chars = [...s];
  const py = chars.map(c => (_isHanziCh(c) && typeof CAM_CA_PY !== 'undefined') ? (CAM_CA_PY[c] || null) : null);
  // 다음 한자의 성조를 알아야 변조 규칙을 적용할 수 있다.
  const nextToneAt = (i) => {
    for (let j = i + 1; j < chars.length; j++) {
      if (!_isHanziCh(chars[j])) {
        // 구두점을 만나면 끊어 읽으므로 변조가 일어나지 않는다.
        if (/[，。！？；：、]/.test(chars[j])) return -1;
        continue;
      }
      return py[j] ? toneOf(py[j]) : -1;
    }
    return -1;
  };

  let out = '';
  let phraseStart = true;      // 구두점 뒤 첫 글자는 선을 새로 시작한다
  let prevTone = 0;            // 앞 음절의 성조 (경성 높이 계산용)
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!_isHanziCh(c)) {
      if (/[，。！？；：、,.!?]/.test(c)) phraseStart = true;
      out += c; continue;
    }
    const p = py[i];
    if (!p) {
      window.READING_MISSING.ca.add(c);
      out += '<span class="rb-missing">' + c + '</span>';
      phraseStart = true;
      continue;
    }
    if (_showPronPoint) {
      const t = toneOf(p);
      const d = toneDisplay(c, p, nextToneAt(i));
      const tc = d.contour || _neutralContour(prevTone);
      prevTone = t;
      const cls = 'rb-ca tone-' + t + (d.changed ? ' tone-changed' : '') + (d.half4 ? ' tone-half4' : '');
      out += '<ruby class="' + cls + '" title="' + d.name + '" data-tc="' + tc.join(',') + '"'
           + (phraseStart ? ' data-ps="1"' : '') + '>'
           + c + '<rt>' + p + '</rt></ruby>';            // 루비는 반드시 '본문 → 주석' 순서
      phraseStart = false;
    } else {
      out += '<ruby class="rb-ca">' + c + '<rt>' + p + '</rt></ruby>';
    }
  }
  return out;
}

/* ===========================================================
   발음 포인트 표시 — AI가 아니라 표기에서 직접 판별한다.
   AI 생성물은 매번 달라지지만 이 규칙은 항상 같은 결과를 낸다.

   일본어: 장음(ー·독음의 '-')·촉음(っ)·撥音(ん)
   중국어: 병음 성조 → 화살표 (1성 →, 2성 ↗, 3성 ↘↗, 4성 ↘)
   =========================================================== */

let _showPronPoint = false;
function setPronPoint(on) {
  _showPronPoint = !!on;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('pp-on', _showPronPoint);
    schedulePitchDraw();
  }
}
function getPronPoint() { return _showPronPoint; }

// 성조 판별: 병음 음절에서 성조 부호를 찾아 1~4 반환 (없으면 0=경성)
const _TONE_TABLE = {
  1: 'āēīōūǖ', 2: 'áéíóúǘ', 3: 'ǎěǐǒǔǚ', 4: 'àèìòùǜ'
};
function toneOf(py) {
  for (const t of [1, 2, 3, 4]) {
    for (const ch of _TONE_TABLE[t]) if (py.includes(ch)) return t;
  }
  return 0;
}
const TONE_MARK = { 1: '→', 2: '↗', 3: '↘↗', 4: '↘', 0: '·' };
const TONE_NAME = { 1: '1성', 2: '2성', 3: '3성', 4: '4성', 0: '경성' };

// 일본어 한 덩어리에서 발음 포인트 구간을 표시용 HTML로 감싼다.
function markJaPoints(kana, yomi) {
  let out = '';
  for (let i = 0; i < kana.length; i++) {
    const c = kana[i], nx = kana[i + 1] || '';
    if (c === 'っ' || c === 'ッ') {
      out += '<span class="pp-soku" title="촉음 — 한 박 멈춤">' + c + '</span>';
    } else if (c === 'ー') {
      out += '<span class="pp-long" title="장음 — 두 박으로 끌기">' + c + '</span>';
    } else if (c === 'ん' || c === 'ン') {
      out += '<span class="pp-n" title="撥音 — 한 박 유지">' + c + '</span>';
    } else if (i > 0 && (c === 'う' || c === 'お') && 'おこそとのほもよろごどぼぽょ'.includes(kana[i - 1])) {
      out += '<span class="pp-long" title="장음(おう) — 두 박으로 끌기">' + c + '</span>';
    } else if (i > 0 && c === 'い' && 'えけせてねへめれげでべぺ'.includes(kana[i - 1])) {
      out += '<span class="pp-long" title="장음(えい) — 두 박으로 끌기">' + c + '</span>';
    } else {
      out += c;
    }
    void nx;
  }
  return out;
}


/* ── 성조 변화(变调) 규칙 ────────────────────────────────────────
   중국어는 표기된 성조와 실제 발음되는 성조가 다른 경우가 있다.
   비전공 학습자가 가장 많이 틀리는 지점이므로 화살표에 반영한다.

   ① 3성 + 3성      → 앞 글자를 2성으로   예) 你好 nǐ hǎo → ní hǎo
   ② 3성 + (1·2·4·경성) → 앞 글자는 반3성(내리기만)  예) 请坐 qǐng zuò
   ③ 4성 + 4성      → 앞 글자는 반4성(짧고 덜 내림)  예) 再见 zài jiàn
   ④ 一(yī)         → 4성 앞에서 2성(yí), 1·2·3성 앞에서 4성(yì)
   ⑤ 不(bù)         → 4성 앞에서 2성(bú)
   ※ ①④⑤는 실제 성조가 바뀌므로 반드시 지도해야 하고,
     ②③은 성조 자체는 유지되나 길이·폭이 달라지는 현상이다.
─────────────────────────────────────────────────────────────── */
const TONE_MARK_HALF3 = '↘';    // 반3성 — 내리기만
const TONE_MARK_HALF4 = '↘\u0323'; // 반4성 — 짧게 내림

// 표시용 성조 정보 계산. { mark, name, changed }
// 성조 곡선 — 조치(趙元任) 5도 표기. 1=가장 낮음, 5=가장 높음.
const TONE_CONTOUR = { 1: [5, 5], 2: [3, 5], 3: [2, 1, 4], 4: [5, 1] };
// 경성은 앞 음절의 성조에 따라 높이가 정해진다 (1성 뒤 2, 2성 뒤 3, 3성 뒤 4, 4성 뒤 1)
function _neutralContour(prevTone) {
  return [{ 1: 2, 2: 3, 3: 4, 4: 1 }[prevTone] || 3];
}
function toneDisplay(ch, py, nextTone) {
  const r = _toneDisplayBase(ch, py, nextTone);
  // 실제로 발음되는 곡선
  const t = toneOf(py);
  if (r.contour) return r;
  if (r.changed && r.mark === TONE_MARK[2]) r.contour = [3, 5];
  else if (r.changed && r.mark === TONE_MARK[4]) r.contour = [5, 1];
  else if (t === 3 && r.mark === TONE_MARK_HALF3) r.contour = [2, 1];   // ↘ 는 4성 기호와 같은 문자라 성조로 구분
  else if (r.half4) r.contour = [5, 3];
  else if (t === 0) r.contour = null;              // 경성 — 앞 음절 기준으로 계산
  else r.contour = TONE_CONTOUR[t];
  return r;
}
function _toneDisplayBase(ch, py, nextTone) {
  const t = toneOf(py);

  // ④ 一
  if (ch === '一') {
    if (nextTone === 4) return { mark: TONE_MARK[2], name: '一: 4성 앞 → 2성(yí)', changed: true };
    if (nextTone >= 1 && nextTone <= 3) return { mark: TONE_MARK[4], name: '一: 1·2·3성 앞 → 4성(yì)', changed: true };
  }
  // ⑤ 不
  if (ch === '不' && nextTone === 4) {
    return { mark: TONE_MARK[2], name: '不: 4성 앞 → 2성(bú)', changed: true };
  }
  // ① 3성 + 3성
  if (t === 3 && nextTone === 3) {
    return { mark: TONE_MARK[2], name: '3성+3성 → 앞을 2성으로', changed: true };
  }
  // ② 3성 + 그 밖 → 반3성
  if (t === 3 && nextTone >= 0 && nextTone !== 3) {        // 경성(0) 앞도 반3성
    return { mark: TONE_MARK_HALF3, name: '반3성 — 내리기만(올리지 않음)', changed: false };
  }
  // ③ 4성 + 4성 → 앞은 반4성
  if (t === 4 && nextTone === 4) {
    return { mark: TONE_MARK[4], name: '4성+4성 — 앞은 짧고 덜 내림', changed: false, half4: true };
  }
  return { mark: TONE_MARK[t], name: TONE_NAME[t], changed: false };
}


/* ===========================================================
   높낮이 선 그리기
   - 중국어: 음절마다 성조 곡선(5도)을 이어 붙여 '한 줄의 선'으로 그린다.
     구두점에서 끊고, 성조 변조(3+3, 一·不, 반3성 등)는 실제 발음 기준으로 그린다.
   - 일본어: 문절마다 글자 위에 높음/낮음 두 단계의 선을 그린다.
     악센트 데이터는 자동 분석 초안이라, JA_ACCENT_REVIEWED 가 true 가 되기 전까지는
     관리자(window.JA_ACCENT_PREVIEW)에게만 보인다.
   - 글자의 실제 화면 위치를 재서 그리므로 줄바꿈·글꼴 크기가 바뀌어도 맞는다.
   =========================================================== */

function _accentAllowed() {
  return (typeof JA_ACCENT_REVIEWED !== 'undefined' && JA_ACCENT_REVIEWED) || window.JA_ACCENT_PREVIEW === true;
}

// 문절의 악센트 — 정확히 일치하는 문절이 없으면, 이 조각을 포함하는 문절에서 해당 부분을 잘라 쓴다.
// (학습가이드가 기호를 문절 중간에 넣어 조각난 경우) 후보끼리 결과가 다르면 쓰지 않는다.
const _ACC_CACHE = {};
function lookupAccent(kana) {
  if (typeof CAM_JA_ACCENT === 'undefined' || !kana) return null;
  if (CAM_JA_ACCENT[kana]) return CAM_JA_ACCENT[kana];
  if (kana in _ACC_CACHE) return _ACC_CACHE[kana];
  let found = null, conflict = false;
  if ([...kana].length >= 2) {
    for (const k of Object.keys(CAM_JA_ACCENT)) {
      const pos = k.indexOf(kana);
      if (pos < 0) continue;
      const part = CAM_JA_ACCENT[k].slice(pos, pos + kana.length);
      if (found && found !== part) { conflict = true; break; }
      found = part;
    }
  }
  _ACC_CACHE[kana] = conflict ? null : found;
  return _ACC_CACHE[kana];
}

// 발음 포인트 모드의 일본어 본문 — 장음·촉음·撥音 색 + 글자별 높낮이
function _jaPronBody(kana) {
  const pat = _accentAllowed() ? lookupAccent(kana) : null;
  const chars = [...kana];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], prev = chars[i - 1] || '';
    let cls = '', tip = '';
    if (c === 'っ' || c === 'ッ') { cls = 'pp-soku'; tip = '촉음 — 한 박 멈춤'; }
    else if (c === 'ー') { cls = 'pp-long'; tip = '장음 — 두 박으로 끌기'; }
    else if (c === 'ん' || c === 'ン') { cls = 'pp-n'; tip = '撥音 — 한 박 유지'; }
    // 주의: ''.includes('') 는 true 이므로 문절 첫 글자(앞 글자 없음)는 반드시 제외한다
    else if (prev && (c === 'う' || c === 'お') && 'おこそとのほもよろごどぼぽょ'.includes(prev)) { cls = 'pp-long'; tip = '장음(おう) — 두 박으로 끌기'; }
    else if (prev && c === 'う' && 'うくすつぬふむゆるぐずづぶぷゅ'.includes(prev)) { cls = 'pp-long'; tip = '장음(うう) — 두 박으로 끌기'; }
    else if (prev && c === 'い' && 'えけせてねへめれげでべぺ'.includes(prev)) { cls = 'pp-long'; tip = '장음(えい) — 두 박으로 끌기'; }
    const attrs = (pat ? ' data-p="' + pat[i] + '"' : '') + (tip ? ' title="' + tip + '"' : '');
    if (cls || pat) out += '<span class="jm ' + cls + '"' + attrs + '>' + c + '</span>';
    else out += c;
  }
  return out;
}

const _SVGNS = 'http://www.w3.org/2000/svg';
let _pitchRaf = 0;
function schedulePitchDraw() {
  if (typeof requestAnimationFrame === 'undefined') return;
  if (_pitchRaf) cancelAnimationFrame(_pitchRaf);
  _pitchRaf = requestAnimationFrame(() => { _pitchRaf = 0; drawPitchLines(); });
}

function drawPitchLines() {
  document.querySelectorAll('svg.pitch-overlay').forEach(e => e.remove());
  if (!_showPronPoint) return;
  const items = document.querySelectorAll('ruby[data-tc], span.jm[data-p]');
  if (!items.length) return;

  // 가장 가까운 블록 단위로 묶어 그 위에 한 장의 선 레이어를 얹는다
  const groups = new Map();
  items.forEach(el => {
    if (!el.getClientRects().length) return;               // 화면에 없는 요소
    const box = el.closest('p, td, li, .break-script-line, .sg-tech-line, .sg-emphasis-badge, .tc-text, #live-text, div');
    if (!box) return;
    if (!groups.has(box)) groups.set(box, []);
    groups.get(box).push(el);
  });

  groups.forEach((els, box) => {
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const br = box.getBoundingClientRect();
    const svg = document.createElementNS(_SVGNS, 'svg');
    svg.setAttribute('class', 'pitch-overlay');
    svg.setAttribute('width', box.scrollWidth);
    svg.setAttribute('height', box.scrollHeight);
    // 각 선 = { pts: 점 목록, cls: 선 모양 }
    //  ''        기본 높낮이 선
    //  'pl-neu'  중국어 경성 — 점선 (약하고 짧게)
    //  'pl-long' 일본어 장음 — 굵게 (두 박으로 끌기)
    const segs = [], dots = [];
    let cur = null, lastTop = null, lastRuby = null, lastPt = null;
    let prevJa = null;        // 직전 일본어 박 { p, x1, yH, ruby }
    const newSeg = (cls) => { cur = { pts: [], cls: cls || '' }; segs.push(cur); return cur; };

    els.forEach(el => {
      if (el.tagName === 'RUBY') {
        // ── 중국어: 병음 위에 성조 곡선
        const rt = el.querySelector('rt');
        const r = (rt || el).getBoundingClientRect();
        const top = r.top - br.top;
        const brk = !cur || el.dataset.ps === '1' || Math.abs(top - lastTop) > 8;
        lastTop = top;
        const lv = el.dataset.tc.split(',').map(Number);
        const x0 = r.left - br.left + r.width * 0.18, x1 = r.right - br.left - r.width * 0.18;
        const base = top - 3, band = 18;                    // 5도 = 병음 위 18px 폭 (1도 = 4.5px)
        const y = v => base - (v - 1) / 4 * band;
        const pts = lv.length === 1 ? [[x0, y(lv[0])], [x1, y(lv[0])]]
                  : lv.map((v, k) => [x0 + (x1 - x0) * k / (lv.length - 1), y(v)]);
        if (el.classList.contains('tone-0')) {
          // 경성은 앞 음절에서 이어지는 부분까지 점선으로, 다음 음절은 새 실선으로 시작
          const sg = newSeg('pl-neu');
          if (!brk && lastPt) sg.pts.push(lastPt);
          sg.pts.push(...pts);
          cur = null; lastPt = pts[pts.length - 1];
          newSeg(''); cur.pts.push(lastPt);
          return;
        }
        if (brk) { newSeg(''); lastPt = null; }
        cur.pts.push(...pts);
        lastPt = pts[pts.length - 1];
      } else {
        // ── 일본어: 글자 위 높음/낮음 두 단계
        const ruby = el.closest('ruby, .rb-missing') || el.parentNode;
        const r = el.getBoundingClientRect();
        const top = r.top - br.top;
        const brk = !cur || ruby !== lastRuby || Math.abs(top - lastTop) > 8;
        if (brk) { newSeg(''); prevJa = null; }
        lastRuby = ruby; lastTop = top;
        const yH = top - 13, yL = top - 1;                  // 높음·낮음 간격 12px
        const yy = el.dataset.p === 'H' ? yH : yL;
        const x0 = r.left - br.left + 1, x1 = r.right - br.left - 1;
        const ch = el.textContent;

        // 악센트 핵 — 높았다가 떨어지는 바로 그 박(일본어에서 '강세'에 해당하는 자리)
        if (prevJa && prevJa.p === 'H' && el.dataset.p === 'L') dots.push([prevJa.x1, prevJa.yH]);

        if (ch === 'っ' || ch === 'ッ') {
          // 촉음 — 한 박 멈춤: 선을 끊어 빈칸으로 둔다
          newSeg('');
        } else {
          cur.pts.push([x0, yy], [x1, yy]);
          if (el.classList.contains('pp-long') || ch === 'ー') {
            // 장음 — 같은 높이로 두 박 끌기: 그 구간만 굵게 덧그린다
            segs.push({ pts: [[x0, yy], [x1, yy]], cls: 'pl-long' });
          }
        }
        prevJa = { p: el.dataset.p, x1, yH, ruby };
      }
    });

    segs.forEach(sg => {
      if (sg.pts.length < 2) return;
      const pl = document.createElementNS(_SVGNS, 'polyline');
      pl.setAttribute('points', sg.pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '));
      if (sg.cls) pl.setAttribute('class', sg.cls);
      svg.appendChild(pl);
    });
    dots.forEach(([x, y]) => {
      const c = document.createElementNS(_SVGNS, 'circle');
      c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1)); c.setAttribute('r', '3.6');
      c.setAttribute('class', 'pl-nucleus');
      svg.appendChild(c);
    });
    if (svg.childNodes.length) box.appendChild(svg);
  });
}

// 화면이 바뀌거나 크기가 바뀌면 다시 그린다 (모든 화면에 자동 적용)
if (typeof window !== 'undefined' && typeof MutationObserver !== 'undefined') {
  const _start = () => {
    new MutationObserver(muts => {
      if (!_showPronPoint && !document.querySelector('svg.pitch-overlay')) return;
      const onlyOverlay = muts.every(m =>
        [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.classList && n.classList.contains('pitch-overlay')));
      if (!onlyOverlay) schedulePitchDraw();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', schedulePitchDraw);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedulePitchDraw);
  };
  if (document.body) _start(); else document.addEventListener('DOMContentLoaded', _start);
}
