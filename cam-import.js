/* ===========================================================
   cam-import.js — 교범(PDF) 복사 텍스트 → 앱 방송문 형식 변환기

   [배경]
   교범 PDF에서 복사하면 다음과 같이 '원문 줄'과 '독음/병음 줄'이
   번갈아 나오고, 한 문장이 여러 조각으로 쪼개진다.
     みなさま / 미나사마 / 、[おはようございます / 오하요-고자이마스 / ...
   중국어는 병음 줄이 먼저 오고 한자 사이에 공백이 끼어든다.
     gèwèilǚkè nǐmenhǎo / 各位旅客，你 们 好 ！

   [변환 결과]
   앱이 쓰는 2행 구조로 되돌린다.
     독음 줄
     원문 줄
   조각 순서를 그대로 유지하므로 독음↔원문 토큰이 1:1로 맞아떨어지고,
   reading.js 의 정렬이 그대로 동작한다.

   [주의]
   원문을 임의로 수정하지 않는다. 붙이고 짝짓고 잡음을 걷어내기만 한다.
   =========================================================== */

(function (global) {
  'use strict';

  const RE_KANA  = /[\u3040-\u30ff]/;
  const RE_HANZI = /[\u4e00-\u9fff]/;
  const RE_HANGUL= /[가-힣]/;
  const RE_TONE  = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;
  const RE_LATIN = /[a-zA-Z]/;

  // 머리말·꼬리말·페이지 번호 등 잡음
  const NOISE = [
    /객실승무원\s*방송교범/, /Cabin\s*crew\s*Announcement/i,
    /Uncontrolled\s*when\s*not\s*printed/i,
    /제정일자/, /^REV[.:]/i, /^제\s*\d+\s*장/, /^\s*\d+\s*-\s*\d+\s*$/,
    /^(On Ground|En-Route|After Landing|Emergency)\s*$/i
  ];

  function classify(line) {
    const t = line.trim();
    if (!t) return 'BLANK';
    if (NOISE.some(re => re.test(t))) return 'NOISE';
    const kana = RE_KANA.test(t), hanzi = RE_HANZI.test(t);
    const hangul = RE_HANGUL.test(t), tone = RE_TONE.test(t);
    if (kana) return 'JA_SRC';                       // 가나 포함 → 일본어 원문
    if (hanzi) return 'CA_SRC';                      // 한자만 → 중국어 원문
    if (RE_LATIN.test(t) && !hangul && !tone) {
      // 성조 기호가 없는 짧은 영문 단어는 구간 태그로 본다 (예: General, Baggage)
      if (t.split(/\s+/).length <= 3 && t.length <= 20 && /^[A-Z]/.test(t)) return 'TAG';
    }
    if (tone || (RE_LATIN.test(t) && !hangul)) return 'CA_PY';  // 병음
    if (hangul) {
      // 한글만: 독음일 수도, 태그일 수도 있다.
      return 'KO';
    }
    // 구두점만 있는 줄('。]', '。/' 등)은 직전 원문 조각에 이어 붙인다.
    if (/^[、。，．！？：；/／\[\]（）()「」]+$/.test(t)) return 'PUNCT';
    return 'OTHER';
  }

  // 한자 사이 공백 제거 ('各位旅客，你 们 好' → '各位旅客，你们好')
  function squeezeHanzi(s) {
    return s.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
            .replace(/\s+([，。、！？：；）」])/g, '$1')
            .replace(/([（「])\s+/g, '$1')
            .replace(/\s{2,}/g, ' ')
            .trim();
  }

  // 조각을 이어붙일 때 공백을 넣을지 판단
  function joinFrag(acc, frag) {
    if (!acc) return frag;
    const noSpaceBefore = /^[、。，．！？：；/／\]）)」]/.test(frag);
    const noSpaceAfter  = /[（(「\[]$/.test(acc);
    return acc + (noSpaceBefore || noSpaceAfter ? '' : ' ') + frag;
  }

  /**
   * 교범 복사 텍스트를 앱 형식으로 변환한다.
   * @param {string} raw  붙여넣은 원문
   * @param {'ja'|'ca'} lang
   * @returns {{text:string, blocks:number, warnings:string[]}}
   */
  function convert(raw, lang) {
    const lines = String(raw || '').split(/\r?\n/);
    const warnings = [];
    const SRC = lang === 'ca' ? 'CA_SRC' : 'JA_SRC';
    const RDG = lang === 'ca' ? 'CA_PY'  : 'KO';

    // 1) 분류 후 잡음 제거
    const items = [];
    for (const l of lines) {
      const c = classify(l);
      if (c === 'NOISE' || c === 'OTHER') continue;
      items.push({ c, t: l.trim() });
    }

    // 2) 원문/독음 조각을 순서대로 짝짓는다.
    //    교범 복사 순서는 (원문→독음) 또는 (독음→원문) 둘 다 나타나므로
    //    '직전에 나온 반대 종류'와 짝짓는 방식으로 양쪽을 모두 수용한다.
    const blocks = [];         // { tag, src:[], rdg:[] }
    let cur = { tag: '', src: [], rdg: [] };
    let pending = null;        // 짝을 기다리는 조각
    let lastWasTag = false;    // 직전 줄이 태그였는지 (두 줄로 쪼개진 태그 병합용)

    const pushBlock = () => {
      if (cur.src.length || cur.rdg.length) blocks.push(cur);
      cur = { tag: '', src: [], rdg: [] };
    };

    for (let i = 0; i < items.length; i++) {
      const { c, t } = items[i];

      if (c === 'BLANK') { pending = null; continue; }

      if (c === 'PUNCT') {
        // 직전 원문 조각(대기 중이면 대기분)에 이어 붙인다.
        if (pending && pending.c === SRC) pending.t += t;
        else if (cur.src.length) cur.src[cur.src.length - 1] += t;
        continue;
      }

      // 태그 후보: 한글만이고, 앞뒤가 원문/독음 짝의 흐름을 끊는 짧은 라벨
      if (c === 'TAG' || (lang === 'ca' && c === 'KO')) {
        // 교범에서 태그가 두 줄로 쪼개지는 경우가 있어(예: '수하물' / '과다 반입')
        // 직전에도 태그였다면 이어 붙인다.
        if (lastWasTag && blocks.length && !blocks[blocks.length - 1].src.length) {
          blocks[blocks.length - 1].tag += ' ' + t;
        } else if (lastWasTag && !cur.src.length && cur.tag) {
          cur.tag += ' ' + t;
        } else {
          pushBlock();
          cur.tag = t;
        }
        lastWasTag = true;
        pending = null;
        continue;
      }
      lastWasTag = false;

      if (c === SRC) {
        if (pending && pending.c === RDG) {
          cur.rdg.push(pending.t); cur.src.push(t); pending = null;
        } else {
          if (pending && pending.c === SRC) { cur.src.push(pending.t); cur.rdg.push(''); }
          pending = { c, t };
        }
        continue;
      }
      if (c === RDG) {
        if (pending && pending.c === SRC) {
          cur.src.push(pending.t); cur.rdg.push(t); pending = null;
        } else {
          if (pending && pending.c === RDG) { cur.rdg.push(pending.t); cur.src.push(''); }
          pending = { c, t };
        }
        continue;
      }
    }
    if (pending) {
      if (pending.c === SRC) { cur.src.push(pending.t); cur.rdg.push(''); }
      else { cur.rdg.push(pending.t); cur.src.push(''); }
    }
    pushBlock();

    // 3) 블록별로 2행 구조로 조립
    const out = [];
    for (const b of blocks) {
      if (b.tag) out.push(`[${b.tag}]`);
      // 조각을 이어붙이되 문장 종결부호(。！？)에서 줄을 나눈다.
      // 단, 다음 조각이 '/'로 시작하면 선택 문안 구분이므로 이어간다.
      let src = '', rdg = '';
      const flushLine = () => {
        let s = lang === 'ca' ? squeezeHanzi(src) : src.trim();
        if (!s) { src = ''; rdg = ''; return; }
        if (rdg.trim()) out.push(rdg.trim());
        out.push(s);
        out.push('');
        src = ''; rdg = '';
      };
      for (let i = 0; i < b.src.length; i++) {
        const sf = b.src[i] || '';
        let rf = b.rdg[i] || '';
        // 원문 조각에 붙은 구조 기호([ ] /)를 독음 조각에도 그대로 반영한다.
        // 교범 원본이 양쪽 줄에 같은 기호를 쓰므로, 형식을 맞춰야 정렬이 어긋나지 않는다.
        if (rf) {
          const lead = (sf.match(/^[^\p{L}\p{N}]*/u) || [''])[0];
          const tail = (sf.match(/[^\p{L}\p{N}]*$/u) || [''])[0];
          const opens = (sf.match(/\[/g) || []).length;
          const closes = (sf.match(/\]/g) || []).length;
          if (lead.includes('/')) rf = '/ ' + rf;
          // 조각 안에서 짝이 맞지 않는 괄호만 미러링한다.
          // '[편명]'처럼 자체 완결된 변수는 독음 줄에 옮기면 안 된다.
          if (lead.includes('[') && opens > closes) rf = '[' + rf;
          if (tail.includes(']') && closes > opens) rf = rf + ']';
        }
        src = joinFrag(src, sf);
        rdg = joinFrag(rdg, rf);
        const nextFrag = b.src[i + 1] || '';
        const endsSentence = /[。！？][）)」\]】]*\s*$/.test(src);
        const contInSelect = /^[/／]/.test(nextFrag) || /[/／]\s*$/.test(src);
        if (endsSentence && !contInSelect) flushLine();
      }
      flushLine();
    }

    // 4) 검증 — 독음/원문 토큰 수가 맞는지
    const SEP = /[\s、。，．・「」/／\[\]（）()【】]+/;
    const units = (s, re) => s.replace(/\[[^\[\]]*\]/g, ' ').split(SEP).filter(x => re.test(x));
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      if (!a || !b) continue;
      const isR = lang === 'ca' ? (RE_TONE.test(a) && !RE_HANZI.test(a)) : (RE_HANGUL.test(a) && !RE_KANA.test(a));
      const isS = lang === 'ca' ? RE_HANZI.test(b) : RE_KANA.test(b);
      if (!isR || !isS) continue;
      const nr = units(a, lang === 'ca' ? /[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/ : /[가-힣]/).length;
      const ns = lang === 'ca'
        ? (b.replace(/\[[^\[\]]*\]/g, ' ').match(/[\u4e00-\u9fff]/g) || []).length
        : units(b, RE_KANA).length;
      if (lang === 'ja' && nr !== ns) {
        warnings.push(`독음 ${nr}개 vs 원문 ${ns}개 — "${b.slice(0, 24)}…"`);
      }
    }

    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
             blocks: blocks.length, warnings };
  }

  global.CamImport = { convert, classify, squeezeHanzi };
})(typeof window !== 'undefined' ? window : globalThis);
