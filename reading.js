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
  if (typeof CAM_JA_YOMI === 'undefined') return null;
  const n = _rdNorm(token);
  if (!n) return null;
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
  return s.split(/(\s+)/).map(tok => {
    if (!/\S/.test(tok)) return tok;
    let hasKana = false;
    for (const c of tok) if (_isKanaCh(c)) { hasKana = true; break; }
    if (!hasKana) return tok;
    const y = lookupYomi(tok);
    if (!y) {
      window.READING_MISSING.ja.add(tok);
      return '<span class="rb-missing">' + tok + '</span>';
    }
    return '<ruby class="rb-ja">' + tok + '<rt>' + y + '</rt></ruby>';
  }).join('');
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
