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
  return combo;
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
    if (y) out += '<ruby class="rb-ja">' + buf + '<rt>' + y + '</rt></ruby>';
    else { window.READING_MISSING.ja.add(buf); out += '<span class="rb-missing">' + buf + '</span>'; }
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
  let out = '';
  for (const c of s) {
    if (!_isHanziCh(c)) { out += c; continue; }
    const p = (typeof CAM_CA_PY !== 'undefined') ? CAM_CA_PY[c] : null;
    if (!p) {
      window.READING_MISSING.ca.add(c);
      out += '<span class="rb-missing">' + c + '</span>';
      continue;
    }
    out += '<ruby class="rb-ca"><rt>' + p + '</rt>' + c + '</ruby>';
  }
  return out;
}
