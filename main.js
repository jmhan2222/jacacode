// ===== 설문 URL (소프트 페이월) =====
const SURVEY_URL = 'https://works.do/xVpdWbl';

// ===== FIREBASE =====
// Gemini 모델명 — 여기 한 곳만 바꾸면 앱 전체에 반영된다.
// 주의: Google이 모델을 예고보다 앞당겨 퇴역시키는 경우가 있다.
//   2026-07-09 gemini-2.5-flash 가 공식 종료일(10/16)보다 먼저 404 처리됨.
//   특히 신규 프로젝트/신규 API 키는 구모델 접근이 즉시 차단된다.
// 404 "no longer available" 이 뜨면 아래 값을 최신 모델로 교체할 것.
//   최신 모델 확인: https://ai.google.dev/gemini-api/docs/models
const GEMINI_MODEL = 'gemini-3.6-flash';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA2rfs2oY80xb374uyYdc5dVlMgac08OWo",
  authDomain: "voicepro-18888.firebaseapp.com",
  projectId: "voicepro-18888",
  storageBucket: "voicepro-18888.firebasestorage.app",
  messagingSenderId: "991357763010",
  appId: "1:991357763010:web:ec0a5d7ee55752b5a1aa5b"
};

var _db = null;
var _storage = null;
let _geminiModel = null;
var auth = null;
const _mvUrlCache = {}; // { "scriptId_lang": url }

// ===== JA·CA Code 전용 Firestore 저장공간 (운영 중인 Voice Pro와 분리) =====
// 두 앱이 같은 Firebase 프로젝트를 쓰므로, JA·CA Code의 "쓰기"는 반드시 jaca_ 전용
// 저장공간에만 한다. "읽기"는 전용 저장공간을 먼저 보고, 아직 비어 있으면 Voice Pro와
// 함께 쓰던 기존 저장공간을 읽기만 해서 이어 쓴다(기존 일본어·중국어 학습가이드와
// 음성 연결 정보를 다시 만들 필요 없음). 사번 계정(allowedUsers)과 AI 채점 일일
// 한도(dailyUsage)는 계속 공용.
const JACA_DB = {
  manual:      'jaca_cabinManual',
  scripts:     'jaca_scripts',
  accessLogs:  'jaca_accessLogs',
  appLaunches: 'jaca_appLaunches',
  guide:       'jaca_guide',
};
const SHARED_DB = { manual: 'cabinManual', scripts: 'scripts', guide: 'guide' };
const JACA_ACCOUNT_MSG = '사번 계정은 Voice Pro와 함께 쓰므로 Voice Pro 관리자 화면에서 등록·삭제해 주세요. (JA·CA Code에도 자동 반영됩니다)';

// 사번별 학습 통계(접속일수·학습시간·낭독시간·AI평가횟수)는 Voice Pro와 같은 방식으로
// 같은 사번 기록(allowedUsers)에 쌓되, 필드 이름 앞에 jaca_를 붙여 앱별로 따로 집계한다.
const JACA_STAT_PREFIX = 'jaca_';
const _STAT_KEY_RE = /^(jaca_|lastAccessAt$|totalLoginDays$|loginDays_|totalPracticeSeconds$|lastPracticeAt$|practiceSec_|totalEvalCount$|lastEvalAt$|evalCount_|totalStudySeconds$|lastStudyAt$|studySec_)/;
// 저장할 때: 통계 필드 이름을 JA·CA 전용(jaca_...)으로 바꿈
function _jacaStatFields(obj) {
  const o = {};
  Object.keys(obj).forEach(k => { o[JACA_STAT_PREFIX + k] = obj[k]; });
  return o;
}
// 읽을 때: Voice Pro 통계는 빼고, JA·CA 전용 통계만 원래 이름으로 돌려놓음
// (화면·CSV 코드는 Voice Pro와 동일하게 그대로 사용)
function _jacaUserView(data) {
  const o = {};
  Object.keys(data).forEach(k => { if (!_STAT_KEY_RE.test(k)) o[k] = data[k]; });
  Object.keys(data).forEach(k => {
    if (k.startsWith(JACA_STAT_PREFIX)) o[k.slice(JACA_STAT_PREFIX.length)] = data[k];
  });
  return o;
}
let _guideUpdateNeededIds = new Set(); // guideUpdateNeeded: true 인 방송문 IDs

function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    _db = firebase.firestore();
    _storage = firebase.storage();
    auth = firebase.auth();
    auth.onAuthStateChanged(user => {
      console.log('[Auth 상태변경]', user ? user.email : '미로그인');
      const el = $('admin-auth-status');
      if (!el) return;
      el.textContent = user
        ? `✅ 관리자: ${user.email || '익명 (' + user.uid.slice(0, 8) + ')'}`
        : '❌ 로그인 필요';
      el.style.color = user ? 'var(--color-success, #16a34a)' : 'var(--color-error, #dc2626)';
    });
    return true;
  } catch { return false; }
}

// 언어 코드 → 로컬 정적 폴더명 (ko/en만 지원)
const _MV_LOCAL_FOLDERS = {
  ja: '일본어(남)', ca: '중국어(남)',
};
const _MV_LOCAL_FOLDERS_F = {
  ja: '일본어(여)', ca: '중국어(여)',
};

// [DISABLED] 언어 코드 → Firebase Storage 폴더명 (남성 우선, 없으면 여성)
// const _MV_FOLDERS = {
//   ko: ['한국어(남)', '한국어(여)'],
//   en: ['영어(남)',   '영어(여)'],
//   ja: ['일본어(남)', '일본어(여)'],
//   ca: ['중국어(남)', '중국어(여)'],
// };

// 현재 선택된 성별 ('M' | 'F')
let _currentGender = 'M';

// 로컬 정적 파일 URL 생성 (한글/공백 encodeURIComponent 처리)
function _buildLocalModelVoiceUrl(fileName, lang, gender = 'M') {
  const folderMap = gender === 'F' ? _MV_LOCAL_FOLDERS_F : _MV_LOCAL_FOLDERS;
  const folder = folderMap[lang];
  if (!folder || !fileName) return null;
  return './' +
    encodeURIComponent('cabinvoice pro') + '/' +
    encodeURIComponent(folder) + '/' +
    encodeURIComponent(fileName);
}

// 방송문 ID에서 섹션 번호 추출 → 점(.) 구분 형식으로 반환 (예: "2.1.1")
// Firestore ID는 하이픈 형식("2-1-1")이므로 점 형식으로 변환
function _extractScriptNum(script) {
  const id = script.id || '';
  // 하이픈 형식 Firestore ID (예: "2-1-1" → "2.1.1")
  const hyphenMatch = id.match(/^(\d+(?:-\d+)+)/);
  if (hyphenMatch) return hyphenMatch[1].replace(/-/g, '.');
  // 점 형식 (예: "2.1.1")
  const numMatch = id.match(/^(\d+(?:\.\d+)*)/);
  if (numMatch) return numMatch[1];
  // 별표 패턴 — ID는 '별표3-분실물' 형식이지만 파일명은 '[별표 3] 분실물...' 형식이다.
  // 대괄호·공백 유무에 상관없이 번호만 뽑아 파일명 접두사로 정규화한다.
  const byeolMatch = id.match(/^\[?\s*별표\s*(\d+)/);
  if (byeolMatch) return `[별표 ${byeolMatch[1]}]`;
  // 제목에서 추출 시도
  const titleNum = (script.title || '').match(/^(\d+(?:\.\d+)*)/);
  if (titleNum) return titleNum[1];
  return null;
}

// ===== COMMON MODEL VOICE PLAYER =====
// containerId: 렌더링할 컨테이너 DOM ID
// opts.onAvailable(bool): 음성 가용 여부 콜백 (드릴 버튼 활성화 등)
// 반환: { stop() } 컨트롤 객체
function createModelVoicePlayer(containerId, opts = {}) {
  const container = $(containerId);
  if (!container) return { stop: () => {} };
  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  container.innerHTML = `<div class="mvp-wrap" id="${containerId}-mvp">
    <button class="mvp-play-btn" id="${containerId}-play" disabled>▶ 재생</button>
    <div class="mvp-scrub-wrap">
      <input type="range" class="mvp-scrub" id="${containerId}-scrub" min="0" max="100" value="0" step="0.1" disabled>
      <span class="mvp-time" id="${containerId}-time">0:00 / 0:00</span>
    </div>
    ${!opts.noGender ? `<div class="mvp-gender-wrap">
      <button class="mvp-gender-btn${_currentGender === 'M' ? ' active' : ''}" data-g="M">남</button>
      <button class="mvp-gender-btn${_currentGender === 'F' ? ' active' : ''}" data-g="F">여</button>
    </div>` : ''}
  </div>`;

  const playBtn  = $(`${containerId}-play`);
  const scrub    = $(`${containerId}-scrub`);
  const timeEl   = $(`${containerId}-time`);
  let _playerAudio = null;

  const setAvailable = (ok) => {
    playBtn.disabled = !ok;
    scrub.disabled = !ok;
    if (!ok) { playBtn.textContent = '모델 음성 미등록'; scrub.value = 0; timeEl.textContent = '0:00 / 0:00'; }
    else if (playBtn.textContent === '모델 음성 미등록') playBtn.textContent = '▶ 재생';
    if (opts.onAvailable) opts.onAvailable(ok);
  };

  const stopPlayer = () => {
    if (_currentModelAudio) { _currentModelAudio.pause(); _currentModelAudio.currentTime = 0; }
    _currentModelAudio = null;
    _playerAudio = null;
    playBtn.textContent = '▶ 재생';
    scrub.value = 0;
    timeEl.textContent = '0:00 / 0:00';
  };

  const attachHandlers = () => {
    _currentModelAudio.ontimeupdate = () => {
      if (!_currentModelAudio) return;
      const dur = _currentModelAudio.duration || 0;
      const cur = _currentModelAudio.currentTime || 0;
      if (dur > 0) scrub.value = (cur / dur) * 100;
      timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`;
    };
    const onEnd = () => {
      playBtn.textContent = '▶ 재생';
      scrub.value = 0;
      timeEl.textContent = '0:00 / 0:00';
      _playerAudio = null;
    };
    _currentModelAudio.onended = onEnd;
    _currentModelAudio.onerror = onEnd;
  };

  const doPlay = async () => {
    try {
      const s = state.currentScript;
      if (!s) return;
      // 토글: 이 플레이어가 재생 중이면 일시정지
      if (_playerAudio && _playerAudio === _currentModelAudio && !_currentModelAudio.paused) {
        _currentModelAudio.pause();
        playBtn.textContent = '▶ 재생';
        return;
      }
      const _safePlay = async (audio) => {
        try {
          // iOS PWA 감지
          const isIOSPWA = 
            window.navigator.standalone === true ||
            window.matchMedia('(display-mode: standalone)').matches;

          if (audio.readyState < 2) audio.load();

          if (isIOSPWA) {
            // iOS PWA: async 없이 즉시 동기 play() 호출
            audio.muted = false;
            audio.volume = 1.0;
            const p = audio.play();
            if (p) p.catch(e => {
              console.warn('[iOS PWA 재생 실패]', e.name);
              showToast('재생 버튼을 다시 눌러주세요.', 2000);
            });
          } else {
            await resumeAudioContext();
            await audio.play();
          }
        } catch(err) {
          console.error('[모델음성] 재생 실패:', err.name, err.message);
          showToast('모델 음성 재생에 실패했습니다. 다시 시도해 주세요.', 3000);
          if (typeof stopPlayer === 'function') stopPlayer();
        }
      };

      // _currentModelAudio 없으면 동기 캐시에서 즉시 생성 시도 (await 없음 → iOS 제스처 유지)
      // initState()가 이미 _preload()로 생성했으면 이 분기는 건너뜀
      if (!_currentModelAudio?.src) {
        const syncUrl = _getCachedModelVoiceUrl(s.id, state.selectedLang);
        if (syncUrl) {
          _currentModelAudio = new Audio(syncUrl);
          _currentModelAudio.setAttribute('playsinline', '');
          window._modelAudioKeepAlive = _currentModelAudio;
        }
      }

      // 일시정지 상태면 현재 위치에서 재개
      if (_playerAudio && _playerAudio === _currentModelAudio && _currentModelAudio?.paused) {
        _safePlay(_currentModelAudio);
        playBtn.textContent = '⏸ 일시정지';
        return;
      }
      // _currentModelAudio가 있으면 재사용 (initState/_preload 또는 위 동기 생성)
      // — await가 없으므로 iOS 사용자 제스처 컨텍스트 완전 유지
      if (_currentModelAudio?.src) {
        _playerAudio = _currentModelAudio;
        attachHandlers();
        _safePlay(_currentModelAudio);
        playBtn.textContent = '⏸ 일시정지';
        return;
      }
      // 캐시 완전 미스(홈 화면 추가 앱에서는 매 실행마다 자주 발생) —
      // 클릭 즉시(await 전) 빈 Audio로 재생을 먼저 "시도"해 iOS 재생 권한을
      // 선점해둔 다음, URL을 비동기로 확보해서 같은 엘리먼트에 재생한다.
      console.warn('[모델음성] 캐시 미스 — unlock 선(先)적용 후 URL 비동기 조회');
      const _unlocked = _createUnlockedAudio();
      const url = await _resolveModelVoiceUrl(s.id, state.selectedLang);
      if (!url) { setAvailable(false); return; }
      let _playOk = true;
      try {
        await _playUnlockedAudio(_unlocked, url);
      } catch (e) {
        _playOk = false;
        console.warn('[모델음성] unlock 재생 실패, 재시도 유도:', e.name);
        showToast('재생 버튼을 다시 눌러주세요.', 2500);
      }
      _unlocked.setAttribute('playsinline', '');
      _currentModelAudio = _unlocked;
      window._modelAudioKeepAlive = _currentModelAudio;
      _playerAudio = _currentModelAudio;
      attachHandlers();
      // 실패 시 "▶ 재생"으로 유지해 사용자가 재시도해야 함을 명확히 인지하게 함
      // (다음 클릭은 "일시정지 상태에서 재개" 분기를 타므로 정상적으로 재생 재시도됨)
      playBtn.textContent = _playOk ? '⏸ 일시정지' : '▶ 재생';
    } catch (e) {
      console.error('[모델음성] 재생 핸들러 오류:', e);
      showToast('오류가 발생했습니다.', 2000);
      stopPlayer();
    }
  };

  playBtn.addEventListener('click', doPlay);

  scrub.addEventListener('input', () => {
    if (_currentModelAudio && _currentModelAudio.duration) {
      _currentModelAudio.currentTime = (parseFloat(scrub.value) / 100) * _currentModelAudio.duration;
    }
  });

  // 성별 토글
  container.querySelectorAll('.mvp-gender-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.g;
      if (!g || _currentGender === g) return;
      _currentGender = g;
      container.querySelectorAll('.mvp-gender-btn').forEach(b => b.classList.toggle('active', b.dataset.g === g));
      stopPlayer();
      initState();
    });
  });

  // URL 확보 즉시 Audio 객체 미리 생성 + 실제 재생 가능(canplay) 상태까지 대기
  // → doPlay() 클릭 시 await 없이 _currentModelAudio.src 경로로 직행 (iOS 제스처 유지)
  // → 버튼을 "URL 준비됨"이 아니라 "실제 재생 가능"할 때 활성화해, 네트워크
  //   버퍼링이 안 끝난 상태에서 재생을 시도하다 iOS에 막히는 상황을 방지
  const _preload = (url) => {
    if (!url || (_currentModelAudio && _currentModelAudio.src)) return Promise.resolve();
    return new Promise(resolve => {
      const audio = new Audio();
      audio.setAttribute('playsinline', '');
      audio.preload = 'auto';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        _currentModelAudio = audio;
        window._modelAudioKeepAlive = audio;
        resolve();
      };
      audio.addEventListener('canplaythrough', finish, { once: true });
      audio.addEventListener('loadeddata', finish, { once: true });
      audio.addEventListener('error', finish, { once: true }); // 실패해도 진행(기존 폴백 경로가 처리)
      // 네트워크 지연 대비 상한 — 3초 내 로드 안 되면 그냥 진행 (다음 클릭 시 재시도됨)
      setTimeout(finish, 3000);
      audio.src = url;
      audio.load();
    });
  };

  // 가용성 초기 확인 (기존 _currentModelAudio 있으면 현재 상태 즉시 반영)
  const initState = () => {
    if (_currentModelAudio && _currentModelAudio.src) {
      setAvailable(true);
      const dur = _currentModelAudio.duration || 0;
      const cur = _currentModelAudio.currentTime || 0;
      if (dur > 0) scrub.value = (cur / dur) * 100;
      if (cur > 0 || dur > 0) timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`;
      playBtn.textContent = _currentModelAudio.paused ? '▶ 재생' : '⏸ 일시정지';
      _playerAudio = _currentModelAudio;
      attachHandlers(); // 화면 전환 후 새 DOM에 이벤트 재등록 (모바일 scrubbar 유지)
      return;
    }
    const s = state.currentScript;
    if (!s) { setAvailable(false); return; }
    const local  = loadModelVoice(s.id, state.selectedLang);
    const cached = _getCachedModelVoiceUrl(s.id, state.selectedLang);
    if (local || cached) {
      _preload(local || cached).then(() => setAvailable(true)); // 실제 재생 가능 확인 후 버튼 활성화
      return;
    }
    // 비동기: Firestore에서 URL 확보 후 Audio 미리 생성
    _resolveModelVoiceUrl(s.id, state.selectedLang).then(async url => {
      if (!url) { setAvailable(false); return; }
      await _preload(url);
      setAvailable(true);
    });
  };
  initState();

  console.log('[완료] 모델 음성 플레이어 생성:', containerId);
  return { stop: stopPlayer };
}

// ===== MODEL VOICE SCAN =====
// 핵심 스캔 로직 (버튼 관리 없이 순수 매핑만 처리)
// 스캔 결과 누락 목록 (관리자 확인용)
let _mvMissing = [];
let _mvNoFile  = [];

async function _doScanLocalModelVoices() {
  const res = await fetch('./cabinvoice%20pro/manifest.json');
  if (!res.ok) throw new Error(`manifest.json 로드 실패 (${res.status})`);
  const manifest = await res.json();
  if (!_db) throw new Error('Firebase 연결이 필요합니다');

  let matched = 0;
  _mvMissing = [];   // 일부 언어 음성 누락
  _mvNoFile  = [];   // 음성 파일 자체가 없음
  const batch = _db.batch();

  for (const script of _allScripts) {
    const num = _extractScriptNum(script);
    if (!num) continue;

    const firestoreId = num.replace(/\./g, '-');
    const modelFiles = {};

    for (const [lang, folder] of Object.entries(_MV_LOCAL_FOLDERS)) {
      const files = manifest[folder] || [];
      const file = files.find(f => f.startsWith(num + ' ') || f.startsWith(num + '_'));
      if (file) modelFiles[lang] = file;
    }
    for (const [lang, folder] of Object.entries(_MV_LOCAL_FOLDERS_F)) {
      const files = manifest[folder] || [];
      const file = files.find(f => f.startsWith(num + ' ') || f.startsWith(num + '_'));
      if (file) modelFiles[`${lang}_F`] = file;
    }

    // 방송문이 실제로 보유한 언어에 대해서만 음성 유무를 따진다.
    const need = ['ja', 'ca'].filter(l => script.langs?.[l]?.text);
    const lack = [];
    for (const l of need) {
      if (!modelFiles[l])        lack.push(`${l}(남)`);
      if (!modelFiles[`${l}_F`]) lack.push(`${l}(여)`);
    }
    if (lack.length) _mvMissing.push({ num, title: script.title, lack });

    if (Object.keys(modelFiles).length > 0) {
      batch.set(_db.collection(JACA_DB.scripts).doc(firestoreId), { modelFiles }, { merge: true });
      matched++;
    } else {
      _mvNoFile.push({ num, title: script.title });
    }
  }

  await batch.commit();
  Object.keys(_mvUrlCache).forEach(k => delete _mvUrlCache[k]);
  if (_mvMissing.length) {
    console.warn('[스캔] 음성이 없는 언어 —', _mvMissing.length + '편');
    _mvMissing.forEach(m => console.warn(`   ${m.num} ${m.title} : ${m.lack.join(', ')}`));
  }
  if (_mvNoFile.length) {
    console.warn('[스캔] 음성 파일이 하나도 없는 방송문 —', _mvNoFile.map(m => `${m.num} ${m.title}`).join(' | '));
  }
  return matched;
}

// 로컬 정적 파일 → 모델 음성 URL 조회
// 우선순위: 1) localStorage base64  2) 메모리 캐시  3) Firestore modelFiles → 로컬 URL
// gender: 'M'(남) | 'F'(여) — 기본값은 현재 선택 성별
async function _resolveModelVoiceUrl(scriptId, lang, gender = _currentGender) {
  // 1. 직접 업로드된 base64 (localStorage, gender 무관)
  const local = loadModelVoice(scriptId, lang);
  if (local) return local;

  // 2. 메모리 캐시 (gender 포함 키)
  const cacheKey = `${scriptId}_${lang}_${gender}`;
  if (_mvUrlCache[cacheKey]) return _mvUrlCache[cacheKey];

  // 3. Firestore scripts/{num}.modelFiles — M: lang, F: lang_F
  if (_db) {
    try {
      const numMatch = scriptId.match(/^(\d+(?:[.\-]\d+)*)/);
      const num = numMatch ? numMatch[1] : scriptId;
      const firestoreId = num.replace(/\./g, '-');
      console.log('[모델음성] num:', num, 'firestoreId:', firestoreId);
      const fsKey = gender === 'F' ? `${lang}_F` : lang;
      // 전용 저장공간 먼저, 연결 정보가 없으면 기존 공용 저장공간을 읽기만 함
      let doc = await _db.collection(JACA_DB.scripts).doc(firestoreId).get();
      if (!doc.exists || !doc.data().modelFiles?.[fsKey]) {
        doc = await _db.collection(SHARED_DB.scripts).doc(firestoreId).get();
      }
      if (!doc.exists) {
        console.warn('[모델음성] 문서 없음:', firestoreId);
        return null;
      }
      const fileName = doc.data().modelFiles?.[fsKey];
      console.log('[모델음성] num:', num, '파일:', fileName);
      if (fileName) {
        const url = _buildLocalModelVoiceUrl(fileName, lang, gender);
        if (url) {
          _mvUrlCache[cacheKey] = url;
          return url;
        }
      }
    } catch {}
  }

  /*
  // [DISABLED] Firebase Storage listAll 방식 (필요 시 주석 해제)
  if (!_db || !_storage) return null;
  // Firestore modelVoices 캐시 확인
  try {
    const doc = await _db.collection('modelVoices').doc(scriptId).get();
    if (doc.exists) {
      const url = doc.data()[lang];
      if (url) { _mvUrlCache[cacheKey] = url; return url; }
    }
  } catch {}
  // Firebase Storage 폴더 탐색 (남 → 여 순서)
  const folders = _MV_FOLDERS[lang];
  if (!folders) return null;
  for (const folder of folders) {
    try {
      const listResult = await _storage.ref(`cabinvoice pro/${folder}`).listAll();
      const match = listResult.items.find(item =>
        item.name.startsWith(scriptId) && /\.(wav|mp3)$/i.test(item.name)
      );
      if (match) {
        const url = await match.getDownloadURL();
        _mvUrlCache[cacheKey] = url;
        try {
          await _db.collection('modelVoices').doc(scriptId).set({ [lang]: url }, { merge: true });
        } catch {}
        console.log(`[모델음성] ${scriptId} ${lang} → Storage 연결 완료 (${folder}/${match.name})`);
        return url;
      }
    } catch {}
  }
  */

  return null;
}

function _getCachedModelVoiceUrl(scriptId, lang, gender = _currentGender) {
  return loadModelVoice(scriptId, lang) || _mvUrlCache[`${scriptId}_${lang}_${gender}`] || null;
}

// ===== GEMINI (Cloudflare Pages Function 프록시 경유) =====
function _showRetryToast(msg) {
  let el = document.getElementById('_gemini-retry-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '_gemini-retry-toast';
    el.style.cssText = [
      'position:fixed', 'bottom:28px', 'left:50%', 'transform:translateX(-50%)',
      'background:#1e293b', 'color:#fff', 'padding:12px 22px', 'border-radius:12px',
      'font-size:14px', 'z-index:9999', 'pointer-events:none',
      'transition:opacity .25s', 'white-space:nowrap'
    ].join(';');
    document.body.appendChild(el);
  }
  if (msg) {
    el.textContent = msg;
    el.style.opacity = '1';
  } else {
    el.style.opacity = '0';
  }
}

function _isRetryable(status, errorMsg) {
  if (status === 429) return true;
  return /high.demand|overload|quota|rate.limit|503|resource.exhaust/i.test(errorMsg || '');
}

async function getGeminiModel() {
  if (_geminiModel) return _geminiModel;
  _geminiModel = {
    async generateContent(input) {
      let contents;
      if (typeof input === 'string') {
        contents = [{ parts: [{ text: input }] }];
      } else if (Array.isArray(input)) {
        const parts = input.map(p => typeof p === 'string' ? { text: p } : p);
        contents = [{ parts }];
      } else {
        contents = [input];
      }

      const MAX_RETRIES = 3;
      let lastErr;
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          const res = await fetch('/api/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: GEMINI_MODEL, contents })
          });
          const data = await res.json();
          if (!res.ok) {
            const err = new Error(data.error || `Gemini 오류 (HTTP ${res.status})`);
            err.status = res.status;
            throw err;
          }
          _showRetryToast(null);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          return { response: { text: () => text } };
        } catch(e) {
          lastErr = e;
          if (i < MAX_RETRIES - 1 && _isRetryable(e.status, e.message)) {
            _showRetryToast(`⏳ 잠시 후 재시도 중... (${i + 2}/${MAX_RETRIES})`);
            await new Promise(r => setTimeout(r, 3000 * (i + 1)));
          } else {
            _showRetryToast(null);
            if (i === MAX_RETRIES - 1 && _isRetryable(e.status, e.message)) {
              throw new Error('잠시 후 다시 시도해주세요. (서버 과부하)');
            }
            throw e;
          }
        }
      }
      _showRetryToast(null);
      throw lastErr;
    }
  };
  return _geminiModel;
}

async function firestoreLoadLatest() {
  if (!_db) return null;
  try {
    const snap = await _db.collection(JACA_DB.manual).doc('latest').get();
    if (snap.exists) return snap.data();
    // 전용 저장공간이 아직 비어 있으면 기존 공용 방송문을 읽기만 함
    const shared = await _db.collection(SHARED_DB.manual).doc('latest').get();
    return shared.exists ? shared.data() : null;
  } catch { return null; }
}
async function firestoreSaveLatest(data) {
  if (!_db) throw new Error('Firebase 미설정');
  await _db.collection(JACA_DB.manual).doc('latest').set(data);
  await _db.collection(JACA_DB.manual).doc('history').collection('versions').doc(data.revVersion).set(data);
}
async function firestoreLoadHistory() {
  if (!_db) return [];
  try {
    const snap = await _db.collection(JACA_DB.manual).doc('history').collection('versions')
      .orderBy('updatedAt','desc').limit(5).get();
    return snap.docs.map(d => d.data());
  } catch { return []; }
}
async function firestoreRollback(revVersion) {
  if (!_db) throw new Error('Firebase 미설정');
  const snap = await _db.collection(JACA_DB.manual).doc('history').collection('versions').doc(revVersion).get();
  if (!snap.exists) throw new Error('버전을 찾을 수 없습니다');
  await _db.collection(JACA_DB.manual).doc('latest').set(snap.data());
}

// ===== 실제 체크리스트 정의 (JA/CA Code 평가표 rev.3 기준) =====
// 주의: 카테고리 키(fluency/voice/intonation/pronunciation)와 items 순서는
// 로컬 점수 산출(computeLocalItems)·CAT_TIPS·Gemini 프롬프트와 1:1 대응됨.
// 평가표 개정 시 이 상수 → CAT_TIPS → criteriaMap 순으로 함께 수정할 것.
const CHECKLIST_BY_LANG = {
  // JA코드: 유창성25 / 분위기·목소리25 / 억양25 / 발음25
  ja: {
    fluency: {
      label: '유창성', max: 25, color: '#10b981', icon: '💨',
      items: [
        { label: '끊어 읽기',       max: 5,  desc: '의미상 자연스러운 곳에서 끊어 읽기 (잦음/생략/Pause 부정확)' },
        { label: '문안 숙지',       max: 5,  desc: '문안 숙지 상태 (버벅거림 주의)' },
        { label: '속도 연출',       max: 5,  desc: '(전체/부분) 적절한 속도 연출 (빠름/느림/일정하지 않음)' },
        { label: '말하는 듯한 연출', max: 10, desc: '일본어로 말하는 듯한 방송연출 (또박또박 지양)' }
      ]
    },
    voice: {
      label: '분위기/목소리', max: 25, color: '#f59e0b', icon: '🎙',
      items: [
        { label: '자연스러운 톤',   max: 10, desc: '음성에 어울리는 자연스러운 톤 연출 (지나치게 높음/낮음)' },
        { label: '안정적인 발성',   max: 5,  desc: '안정적인 발성 연출 (음량/비음/아성/갈라짐/불안정)' },
        { label: '친절한 분위기',   max: 5,  desc: '친절한 분위기 연출 (차가움/성의 부족)' },
        { label: '과장·단조 지양',  max: 5,  desc: '(과장된/단조로운) 연출 지양' }
      ]
    },
    intonation: {
      label: '억양', max: 25, color: '#8b5cf6', icon: '〰️',
      items: [
        { label: '일본어다운 억양', max: 10, desc: '일본어 특성을 살린 자연스러운 억양 (높낮이 변화 적음 주의)' },
        { label: '고른 억양',      max: 5,  desc: '고른 억양 사용 (상승/하향/동일 반복)' },
        { label: '장음 연출',      max: 5,  desc: '장음 연출 (불필요한 억양 사용)' },
        { label: '어미·조사 처리', max: 5,  desc: '(어미/조사) 처리 (짧게 끊음/길게 끎/불필요한 억양)' }
      ]
    },
    pronunciation: {
      label: '발음', max: 25, color: '#3b82f6', icon: '🗣',
      items: [
        { label: '장음',           max: 5, desc: '장음 (생략/불필요한 장음/긺/짧음)' },
        { label: '히라가나 발음',   max: 5, desc: '히라가나 고유의 발음 준수 (표기 독음 미준수, 된소리 주의)' },
        { label: 'ん·촉음',        max: 5, desc: '(ん발음/촉음) (생략/박자 미준수/불필요한 삽입)' },
        { label: '모음',           max: 5, desc: '모음 (부정확/과장)' },
        { label: '오발음',         max: 5, desc: '오발음 (틀린 발음/조사 생략/조사 오발음/뭉개짐)' }
      ]
    }
  },
  // CA코드: 유창성30 / 분위기·목소리25 / 성조·억양25 / 발음20
  ca: {
    fluency: {
      label: '유창성', max: 30, color: '#10b981', icon: '💨',
      items: [
        { label: '끊어 읽기',       max: 5,  desc: '의미상 자연스러운 곳에서 끊어읽기 (잦음/생략/Pause 지나치게 긴 경우)' },
        { label: '말하는 듯한 연출', max: 10, desc: '말하는 듯한 방송 연출 (스타카토식 지양)' },
        { label: '강조 표현',       max: 5,  desc: '의미전달력을 높이기 위해 강조 표현 사용' },
        { label: '속도 연출',       max: 5,  desc: '전체/어절 간 적절한 속도 연출 (빠름/느림/특정 부분 빨라짐)' },
        { label: '문안 숙지',       max: 5,  desc: '문안 숙지 상태 (버벅거림·잘못읽음 주의)' }
      ]
    },
    voice: {
      label: '분위기/목소리', max: 25, color: '#f59e0b', icon: '🎙',
      items: [
        { label: '친근한 분위기',   max: 10, desc: '친근한 분위기 연출 (성의 부족/차가움)' },
        { label: '음량·발성',      max: 5,  desc: '적절한 음량과 안정적인 발성 유지 (힘없는 발성/갈라짐/비음)' },
        { label: '자연스러운 톤',   max: 10, desc: '음성에 어울리는 자연스러운 톤 연출 (지나치게 높음/낮음)' }
      ]
    },
    intonation: {
      label: '성조/억양', max: 25, color: '#8b5cf6', icon: '〰️',
      items: [
        { label: '1성·4성',        max: 5,  desc: '1성, 4성 (미준수/구분 모호)' },
        { label: '2성·3성',        max: 5,  desc: '2성, 3성 (미준수/구분 모호)' },
        { label: '성조 변화규칙',   max: 5,  desc: '성조의 변화규칙 준수 / 성조 간 자연스러운 연결' },
        { label: '중국어다운 억양', max: 10, desc: '중국어의 특성을 살린 억양 구사 (한국어식 억양/부자연)' }
      ]
    },
    pronunciation: {
      label: '발음', max: 20, color: '#3b82f6', icon: '🗣',
      items: [
        { label: '권설음·설치음',   max: 5, desc: '권설음(zh/ch/sh/r) · 설치음(z/c/s) 구분' },
        { label: '단운모',         max: 5, desc: '단운모 (a/o/e/i/u/ü)' },
        { label: '복운모',         max: 5, desc: '복운모 (ai/ei/ao/ou/ian/uang 등)' },
        { label: '오발음',         max: 5, desc: '위 항목 외 오발음' }
      ]
    }
  }
};

// 합격 기준: 85점 이상 PASS (JA/CA 공통)
const PASS_SCORE = 85;

// 현재 언어의 체크리스트 반환 (미지정 시 state 기준)
function getChecklist(lang) {
  return CHECKLIST_BY_LANG[lang || state.selectedLang] || CHECKLIST_BY_LANG.ja;
}

// ===== STATE =====
let state = {
  currentScript: null,
  selectedLang: 'ja',
  mediaRecorder: null,
  audioContext: null,
  analyser: null,
  sourceNode: null,
  stream: null,
  pitchSamples: [],
  amplitudeSamples: [],
  pauseSamples: [],
  recordingStart: null,
  recordTimerInterval: null,
  prepTimerInterval: null,
  prepTimeLeft: 30,
  transcript: '',
  recognition: null,
  animFrameId: null,
  radarChartInstance: null,
  audioChunks: [],
  audioBlob: null,
  _sampleInterval: null
};

// ===== 오디오 세션 공통 헬퍼 (iOS 마이크 사용 후 재생 볼륨 저하 방지) =====
// 마이크 스트림 종료 공통 처리 — 모든 녹음 종료 시점에서 호출
function stopMicStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
}

// AudioContext.resume()이 iOS(특히 PWA)에서 간혹 영원히 응답하지 않는
// WebKit 버그가 보고되어 있음 — 최대 2초만 기다리고, 응답이 없으면 그냥
// 진행한다. 이 함수를 안 쓰고 audioContext.resume()을 직접 호출하면
// 화면이 무한정 멈출 수 있으므로, resume이 필요한 모든 곳에서 반드시 재사용할 것.
function _resumeCtxWithTimeout(ctx, timeoutMs = 2000) {
  if (!ctx || ctx.state !== 'suspended') return Promise.resolve();
  return Promise.race([
    ctx.resume().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}

// 오디오 재생 전 공통 복원 — 모든 audio.play() 호출 직전에 호출
async function resumeAudioContext() {
  await _resumeCtxWithTimeout(state.audioContext);
}

// ─── iOS PWA(홈 화면 추가 앱) 오디오 재생 안정화 공용 헬퍼 ──────────────────
// 문제: 홈 화면에서 실행한 앱은 열 때마다 메모리 캐시가 비어있어, 재생 버튼을
//       누른 뒤 URL을 서버에서 비동기로 가져와야 하는 경우가 잦다. 이때
//       "await 이후에" audio.play()를 호출하면, iOS가 이를 "사용자 클릭과
//       무관하게 코드가 임의로 실행한 재생"으로 간주해 차단할 수 있다.
// 해결: 사용자가 버튼을 누른 바로 그 순간(await 전, 동기적으로) 아직 src가
//       없는 빈 Audio 엘리먼트로 play()를 한 번 "시도"해서 iOS에 이 엘리먼트를
//       미리 등록해둔다. src가 없어 이 시도 자체는 실패하지만, 이후 같은
//       엘리먼트에 src를 넣고 다시 play()를 호출하면(비동기 이후라도) 정상
//       재생된다. → 새로운 오디오 재생 기능을 추가할 때도 아래 두 함수를
//       그대로 재사용하면 이 문제가 재발하지 않는다.
// 녹음 가능한 MediaRecorder mimeType 탐지 — 전역 함수로 선언해 모든 녹음 관련
// 기능(연습하기/드릴모드 등)이 하나의 정의를 공유하게 함. 함수 내부에 지역으로
// 중복 선언하면, 다른 녹음 기능에서 같은 이름으로 호출 시 스코프 밖이라
// ReferenceError가 나므로 반드시 이 전역 함수 하나만 사용할 것.
function _getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=aac',
    'audio/mp4',
    'audio/aac',
    ''
  ];
  for (const type of types) {
    if (!type || MediaRecorder.isTypeSupported(type)) {
      return type ? { mimeType: type } : {};
    }
  }
  return {};
}

// 오디오 재생 권한을 선점(unlock)하기 위한 최소 크기 무음 WAV (44바이트 헤더 + 짧은 무음).
// 빈 Audio()로 play()를 시도하면 브라우저에 따라 "재생 시도"로 인정 안 되는 경우가 있어
// 실제 재생 가능한 무음 오디오를 넣어 더 폭넓은 브라우저에서 안정적으로 unlock되게 함.
const _SILENT_AUDIO_SRC = 'data:audio/wav;base64,UklGRuwAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YcgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
function _createUnlockedAudio() {
  const audio = new Audio(_SILENT_AUDIO_SRC);
  audio.setAttribute('playsinline', '');
  audio.muted = false;
  const p = audio.play();
  if (p && p.catch) p.catch(() => {}); // unlock 목적의 무음 재생, 실패해도 무시
  return audio;
}
// 미리 unlock해둔 audio 엘리먼트에 실제 URL을 넣고 재생 (URL을 비동기로
// 확보해야 하는 모든 재생 로직에서 이 두 함수를 짝으로 사용할 것)
async function _playUnlockedAudio(audio, url) {
  audio.pause();
  audio.src = url;
  audio.load();
  const p = audio.play();
  if (p && p.catch) {
    await p.catch(err => {
      console.warn('[오디오 unlock 재생 실패]', err.name);
      throw err;
    });
  }
}

// 공유 AudioContext 확보 — 마이크를 쓰는 모든 녹음 플로우(연습하기/드릴 모드)에서
// 호출해야 resumeAudioContext()가 실제로 복원할 대상을 가짐
function _ensureAudioContext() {
  if (state.audioContext) return state.audioContext;
  const AudioCtx = /** @type {any} */ (window).AudioContext || /** @type {any} */ (window).webkitAudioContext;
  state.audioContext = new AudioCtx();
  return state.audioContext;
}

// 녹음 종료 직후 공통 시퀀스: iOS 오디오 세션 전환 대기 후 AudioContext 복원
async function _releaseAudioSession() {
  await _audioSessionDelay();
  await resumeAudioContext();
}

// 마이크 종료 후 오디오 재생 사이 대기 (iOS 오디오 세션 전환 대기)
function _audioSessionDelay() {
  return new Promise(resolve => setTimeout(resolve, 300));
}

// ===== DOM =====
const $ = id => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  $(id).scrollTop = 0;
  // .screen 요소 자체가 아니라 페이지(window/body)가 스크롤되는 구조라,
  // 위 scrollTop 초기화만으로는 실제 스크롤 위치가 안 바뀜 — 창 스크롤을 직접 리셋
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  _applyAdminVisibility();
}

// ===== BUILTIN OVERRIDES (localStorage) =====
function loadOverrides() {
  try { return JSON.parse(localStorage.getItem('cabinvoice_overrides') || '{}'); }
  catch { return {}; }
}
function saveOverrides(obj) { localStorage.setItem('cabinvoice_overrides', JSON.stringify(obj)); }
function getEffectiveScript(id) {
  const overrides = loadOverrides();
  const base = _allScripts.find(s => s.id === id);
  if (!base) return null;
  return overrides[id] ? { ...base, ...overrides[id], langs: { ...base.langs, ...overrides[id].langs } } : base;
}
function restoreBuiltIn(id) {
  const overrides = loadOverrides();
  delete overrides[id];
  saveOverrides(overrides);
  renderHome();
}

// ===== MODAL STATE =====
const _modalState = { mode: 'add', editId: null, editSource: null };

// ===== AUTH =====
const EDIT_PW = 'jmhan2222';
function isEditUnlocked() { return sessionStorage.getItem('cvp_edit_unlocked') === '1'; }

// 로그인 세션(vp_s)의 isAdmin 플래그 확인 (현재는 1603064 사번만 true)
// ※ 버튼 노출 여부만 제어할 뿐, 실제 편집 실행은 기존 requireEditAuth(비밀번호 확인)를 그대로 거침
function _isAdminSession() {
  try {
    return JSON.parse(localStorage.getItem('vp_s') || '{}').isAdmin === true;
  } catch (e) { return false; }
}
// 관리자 전용 UI(⚙ 관리자 패널 버튼, ✏️ 편집 버튼)를 관리자 세션에서만 보이게 처리.
// showScreen()에서 화면 전환마다 항상 호출되므로, 로그인 직후/세션 복원/화면 이동
// 등 어떤 경로로 진입해도 빠짐없이 적용됨.
function _applyAdminVisibility() {
  const admin = _isAdminSession();
  const adminBtn = document.getElementById('btn-open-admin');
  if (adminBtn) adminBtn.style.display = admin ? '' : 'none';
  const guideEditBtn = document.getElementById('btn-guide-edit');
  if (guideEditBtn) guideEditBtn.style.display = admin ? '' : 'none';
  const detailEditBtn = document.getElementById('detail-edit-btn');
  if (detailEditBtn && !admin) detailEditBtn.classList.add('hidden');
}
function unlockEdit() {
  sessionStorage.setItem('cvp_edit_unlocked', '1');
  _updateProtectionState(); // 관리자 인증 즉시 콘텐츠 보호 해제
}
let _authCallback = null;
function requireEditAuth(cb, opts = {}) {
  if (isEditUnlocked() && !opts.forcePrompt) { cb(); return; }
  _authCallback = cb;
  $('auth-pw-input').value = '';
  $('auth-error').classList.add('hidden');
  $('auth-modal').classList.remove('hidden');
  setTimeout(() => $('auth-pw-input').focus(), 60);
}
function _confirmAuth() {
  if ($('auth-pw-input').value === EDIT_PW) {
    unlockEdit();
    $('auth-modal').classList.add('hidden');
    if (_authCallback) { _authCallback(); _authCallback = null; }
  } else {
    $('auth-error').classList.remove('hidden');
    $('auth-pw-input').value = '';
    $('auth-pw-input').focus();
  }
}

// ===== EMPLOYEE LOGIN AUTH =====
const EMP_STORAGE_KEY = 'cvp_employee_id';

function getStoredEmployeeId() {
  return localStorage.getItem(EMP_STORAGE_KEY) || sessionStorage.getItem(EMP_STORAGE_KEY) || null;
}
function isLoggedIn() { return !!getStoredEmployeeId(); }

// 한국 표준시(KST) 기준 YYYY-MM-DD (접속 로그 "당일" 판정용)
function _kstDateStr(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

async function _checkAllowedEmployee(empId) {
  const doc = await _db.collection('allowedUsers').doc(empId).get();
  return doc.exists;
}

async function _recordAccessLog(empId) {
  console.log('[접속로그] _recordAccessLog 호출됨, empId:', empId, '| _db 존재:', !!_db);
  if (!_db) { console.warn('[접속로그] _db가 없어서 기록 중단'); return; }
  try {
    const dateStr = _kstDateStr();
    const yearStr = dateStr.slice(0, 4);
    const monthStr = dateStr.slice(0, 7).replace('-', '_');
    const logId = `${empId}_${dateStr}`;
    console.log('[접속로그] 기록 시도, logId:', logId);
    const ref = _db.collection(JACA_DB.accessLogs).doc(logId);
    const snap = await ref.get();
    if (snap.exists) { console.log('[접속로그] 오늘 이미 기록됨, 스킵'); return; }
    await ref.set({
      employeeId: empId,
      date: dateStr,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      device: navigator.userAgent,
    });
    console.log('[접속로그] accessLogs 기록 성공:', logId);
    // allowedUsers에 마지막 접속 시각 및 접속 일수(연간/월간/총) 누적
    const updatePayload = {
      lastAccessAt: firebase.firestore.FieldValue.serverTimestamp(),
      totalLoginDays: firebase.firestore.FieldValue.increment(1),
    };
    updatePayload[`loginDays_${yearStr}`] = firebase.firestore.FieldValue.increment(1);
    updatePayload[`loginDays_${monthStr}`] = firebase.firestore.FieldValue.increment(1);
    await _db.collection('allowedUsers').doc(empId).set(_jacaStatFields(updatePayload), { merge: true });
    console.log('[접속로그] allowedUsers 접속 통계 갱신 성공');
  } catch (e) { console.error('[접속로그] 기록 실패:', e.code || '', e.message); }
}

// 현재 로그인한 사번 가져오기 유틸
function _getCurrentEmpId() {
  try {
    const s = localStorage.getItem('vp_s');
    if (s) {
      const parsed = JSON.parse(s);
      if (parsed.empId) return String(parsed.empId).padStart(7, '0');
    }
  } catch {}
  const raw = getStoredEmployeeId();
  return raw ? String(raw).padStart(7, '0') : null;
}

// 초 단위 시간을 "X시간 Y분 Z초" 문자열로 포맷
function _formatSeconds(sec) {
  if (!sec || sec <= 0) return '0분';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const remS = s % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${remS}초`;
  return `${remS}초`;
}

// 낭독 / 드릴 연습 시간 누적 (초 단위)
async function _recordPracticeTime(durationSec) {
  if (!durationSec || durationSec < 1) return;
  const empId = _getCurrentEmpId();
  if (!empId || !_db) return;
  try {
    const dateStr = _kstDateStr();
    const yearStr = dateStr.slice(0, 4);
    const monthStr = dateStr.slice(0, 7).replace('-', '_');
    const sec = Math.round(durationSec);

    const updatePayload = {
      totalPracticeSeconds: firebase.firestore.FieldValue.increment(sec),
      lastPracticeAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    updatePayload[`practiceSec_${yearStr}`] = firebase.firestore.FieldValue.increment(sec);
    updatePayload[`practiceSec_${monthStr}`] = firebase.firestore.FieldValue.increment(sec);

    await _db.collection('allowedUsers').doc(empId).set(_jacaStatFields(updatePayload), { merge: true });
    console.log(`[연습기록] 사번 ${empId} 연습시간 +${sec}초 누적 완료`);
  } catch (e) {
    console.warn('[연습기록] 누적 실패:', e.message);
  }
}

// AI 평가 완료 횟수 누적
async function _recordAiEvaluation() {
  const empId = _getCurrentEmpId();
  if (!empId || !_db) return;
  try {
    const dateStr = _kstDateStr();
    const yearStr = dateStr.slice(0, 4);
    const monthStr = dateStr.slice(0, 7).replace('-', '_');

    const updatePayload = {
      totalEvalCount: firebase.firestore.FieldValue.increment(1),
      lastEvalAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    updatePayload[`evalCount_${yearStr}`] = firebase.firestore.FieldValue.increment(1);
    updatePayload[`evalCount_${monthStr}`] = firebase.firestore.FieldValue.increment(1);

    await _db.collection('allowedUsers').doc(empId).set(_jacaStatFields(updatePayload), { merge: true });
    console.log(`[평가기록] 사번 ${empId} AI 평가 횟수 +1 누적 완료`);
  } catch (e) {
    console.warn('[평가기록] 누적 실패:', e.message);
  }
}

// 화면 노출 체류 학습 시간 누적 (초 단위)
async function _recordStudyTime(durationSec) {
  if (!durationSec || durationSec < 1) return;
  const empId = _getCurrentEmpId();
  if (!empId || !_db) return;
  try {
    const dateStr = _kstDateStr();
    const yearStr = dateStr.slice(0, 4);
    const monthStr = dateStr.slice(0, 7).replace('-', '_');
    const sec = Math.round(durationSec);

    const updatePayload = {
      totalStudySeconds: firebase.firestore.FieldValue.increment(sec),
      lastStudyAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    updatePayload[`studySec_${yearStr}`] = firebase.firestore.FieldValue.increment(sec);
    updatePayload[`studySec_${monthStr}`] = firebase.firestore.FieldValue.increment(sec);

    await _db.collection('allowedUsers').doc(empId).set(_jacaStatFields(updatePayload), { merge: true });
    console.log(`[체류학습] 사번 ${empId} 화면 체류 학습시간 +${sec}초 누적 완료`);
  } catch (e) {
    console.warn('[체류학습] 누적 실패:', e.message);
  }
}

// 체류 학습 시간 및 낭독 시간을 종합 포맷팅
function _formatPracticeTimeDisplay(studySec, practiceSec) {
  const study = studySec || 0;
  const practice = practiceSec || 0;
  if (study <= 0 && practice <= 0) return '0분';

  if (study > 0) {
    const studyStr = _formatSeconds(study);
    if (practice > 0) {
      return `${studyStr} (낭독 ${Math.round(practice / 60)}분)`;
    }
    return studyStr;
  }
  return `낭독 ${_formatSeconds(practice)}`;
}

// 화면 노출 체류 학습 시간 실시간 측정기 (스마트 활성 시간 추적)
// 1) 화면이 켜져 있고 보고 있을 때만 측정
// 2) 5분 이상 무동작(방치) 시 자리비움으로 판단하여 측정 일시정지 (유령 시간 차단)
// 3) 60초마다 Firestore에 자동 동기화
let _studyTrackerInitialized = false;
let _pendingStudySec = 0;
let _lastUserInteractionTime = Date.now();

function _initStudyTimeTracker() {
  if (_studyTrackerInitialized) return;
  _studyTrackerInitialized = true;

  const onUserActivity = () => { _lastUserInteractionTime = Date.now(); };
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
    window.addEventListener(evt, onUserActivity, { passive: true });
  });

  // 10초마다 활성 상태 점검
  setInterval(() => {
    const empId = _getCurrentEmpId();
    if (!empId) return; // 미로그인 상태는 측정하지 않음

    const isVisible = !document.hidden;
    const isRecentlyActive = (Date.now() - _lastUserInteractionTime) < 5 * 60 * 1000; // 5분 이내 활동

    if (isVisible && isRecentlyActive) {
      _pendingStudySec += 10;
      // 60초 쌓이면 서버로 전송
      if (_pendingStudySec >= 60) {
        const toSend = _pendingStudySec;
        _pendingStudySec = 0;
        _recordStudyTime(toSend);
      }
    }
  }, 10000);

  // 창 닫거나 백그라운드 전환 시 남은 초 즉시 플러시
  const flushPending = () => {
    if (_pendingStudySec >= 5) {
      const toSend = _pendingStudySec;
      _pendingStudySec = 0;
      _recordStudyTime(toSend);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushPending();
    else _lastUserInteractionTime = Date.now();
  });
  window.addEventListener('beforeunload', flushPending);
}

// 로그인 여부와 무관하게 "기기당 고유 ID"를 부여 (최초 실행 시 1회 생성 후 계속 재사용)
function _getOrCreateDeviceId() {
  const KEY = 'vp_device_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2));
    localStorage.setItem(KEY, id);
  }
  return id;
}

// 로그인 성공 여부와 무관하게 "앱이 실행됐다"는 사실 자체를 하루 1회 기록
// (로그인 화면만 보고 나간 사람까지 포함해서 "오늘 총 실행 인원"을 집계하기 위함)
// 기존 accessLogs(로그인 기반)와는 완전히 별개의 컬렉션을 사용해 서로 영향 없음
async function _recordAppLaunch() {
  if (!_db && !initFirebase()) return; // 로그인 전이라 Firebase가 아직 초기화 안 됐을 수 있음
  try {
    const key = getStoredEmployeeId() || _getOrCreateDeviceId();
    const dateStr = _kstDateStr();
    const ref = _db.collection(JACA_DB.appLaunches).doc(`${key}_${dateStr}`);
    const snap = await ref.get();
    if (snap.exists) return; // 당일 이미 기록됨
    await ref.set({
      key,
      isLoggedIn: !!getStoredEmployeeId(),
      date: dateStr,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('[앱실행기록] 기록 실패:', e.message); }
}

async function attemptLogin() {
  const input = $('login-empid-input');
  const btn = $('login-submit-btn');
  const errorEl = $('login-error');
  const empId = input.value.trim();
  errorEl.classList.add('hidden');
  if (!empId) {
    errorEl.textContent = '사번을 입력해 주세요.';
    errorEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = '확인 중...';
  try {
    if (!_db) initFirebase();
    const allowed = await _checkAllowedEmployee(empId);
    if (!allowed) {
      errorEl.textContent = '등록되지 않은 사번입니다.';
      errorEl.classList.remove('hidden');
      return;
    }
    if ($('login-auto-checkbox').checked) {
      localStorage.setItem(EMP_STORAGE_KEY, empId);
      sessionStorage.removeItem(EMP_STORAGE_KEY);
    } else {
      sessionStorage.setItem(EMP_STORAGE_KEY, empId);
      localStorage.removeItem(EMP_STORAGE_KEY);
    }
    _recordAccessLog(empId);
    // 보안 팝업 표시 후 메인 화면 진입
    showSecurityPopup(empId, () => {
      const _vpSession = localStorage.getItem('vp_s');
      if (!_vpSession) {
        console.log('[Auth] 세션 없음 - 로그인 필요');
        return;
      }
      enterApp();
    });
  } catch (e) {
    console.error('[로그인] 오류:', e);
    errorEl.textContent = '로그인 중 오류가 발생했습니다. 다시 시도해 주세요.';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
  }
}

function logout() {
  localStorage.removeItem(EMP_STORAGE_KEY);
  sessionStorage.removeItem(EMP_STORAGE_KEY);
  localStorage.removeItem('vp_s');
  localStorage.removeItem('vp_session');
  removeWatermark();
  document.body.classList.remove('cvp-protected');
  $('login-empid-input').value = '';
  $('login-error').classList.add('hidden');
  
  // 로그인 화면 표시
  if (typeof showLogin === 'function') {
    showLogin();
  } else {
    location.reload();
  }
}

function enterApp() {
  initFirebase();
  renderHome();
  showScreen('screen-home'); updateAIUsageBadge();
  const empId = getStoredEmployeeId();
  if (empId) _startWatermarkGuard(empId);
  // 접속 기록: 실제 로그인(login.js)은 사번을 'vp_s' 세션에만 저장하므로,
  // 구버전 키(cvp_employee_id)가 비어있으면 vp_s에서 읽는다. (이 불일치로
  // 지금까지 접속 기록이 전혀 남지 않았음)
  const _sessEmpId = _getEmpId();
  const _logEmpId = empId || (_sessEmpId !== 'guest' ? _sessEmpId : null);
  if (_logEmpId) _recordAccessLog(_logEmpId); // 하루 1회만 저장 (함수 내부 중복 방지)
  _initContentProtection();
  _initStudyTimeTracker(); // 스마트 화면 체류 학습시간 자동 측정 시작
}

// ===== 보안 안내 팝업 =====
function showSecurityPopup(empId, onAgree) {
  // 기존 오버레이 제거 (중복 방지)
  document.getElementById('security-popup-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'security-popup-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 99998;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  `;

  overlay.innerHTML = `
    <div style="
      background: white;
      border-radius: 16px;
      padding: 28px 24px;
      max-width: 360px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    ">
      <div style="
        text-align: center;
        margin-bottom: 20px;
      ">
        <div style="font-size:32px;margin-bottom:8px">⚠️</div>
        <h2 style="
          font-size: 16px;
          font-weight: 700;
          color: #C0392B;
          line-height: 1.4;
          margin: 0;
        ">보안 안내 및 무단 배포 금지</h2>
      </div>

      <p style="
        font-size: 13px;
        color: #333;
        line-height: 1.7;
        margin-bottom: 16px;
      ">본 플랫폼은 당사 임직원의 교육 및 훈련을 위해
운영되는 <strong>사내 자산</strong>입니다.</p>

      <div style="
        background: #FFF5F5;
        border-left: 3px solid #C0392B;
        border-radius: 0 8px 8px 0;
        padding: 12px 14px;
        margin-bottom: 16px;
      ">
        <p style="
          font-size: 13px;
          color: #003479;
          font-weight: 600;
          line-height: 1.8;
          margin: 0;
        ">▶ 개인 사번/비밀번호 공유 금지<br>
▶ 사이트 내 모든 자료의 외부 유출 및 무단 배포 금지</p>
      </div>

      <p style="
        font-size: 12px;
        color: #666;
        line-height: 1.7;
        margin-bottom: 20px;
      ">위 사항을 위반할 경우, 당사 보안
규정 위반으로 개인 정보 관리에
만전을 기해 주시기 바랍니다.<br><br>
본 시스템에 로그인하는 것은 위
보안 사항을 준수할 것에 <strong>동의하는 것으로 간주</strong>됩니다.</p>

      <button id="security-agree-btn" style="
        width: 100%;
        padding: 14px;
        background: #FF6B00;
        color: white;
        border: none;
        border-radius: 10px;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        letter-spacing: 1px;
      ">동의합니다</button>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('security-agree-btn').addEventListener('click', () => {
    overlay.remove();
    localStorage.setItem('securityAgreed', JSON.stringify({ agreed: true, agreedAt: Date.now(), empId }));
    console.log('[보안팝업] 동의:', empId);
    if (typeof onAgree === 'function') onAgree();
  });

  console.log('[완료] 보안 안내 팝업 표시');
}

// ===== 동적 워터마크 =====
let _wmGuardStarted = false;

function applyWatermark(employeeId) {
  const existing = document.getElementById('wm-layer');
  if (existing) existing.remove();

  const layer = document.createElement('div');
  layer.id = 'wm-layer';

  const today = new Date().toLocaleDateString('ko-KR');
  const text = `${employeeId}  ${today}`;

  // 캔버스로 워터마크 패턴 생성
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 150;
  const ctx = canvas.getContext('2d');
  ctx.rotate(-30 * Math.PI / 180);
  ctx.font = '600 13px Arial';
  ctx.fillStyle = 'rgba(128,128,128,0.08)';
  ctx.fillText(text, 10, 100);

  layer.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background-image: url(${canvas.toDataURL()});
    background-repeat: repeat;
    pointer-events: none;
    z-index: 9999;
    user-select: none;
  `;
  document.body.appendChild(layer);
}

function removeWatermark() {
  document.getElementById('wm-layer')?.remove();
}

// 워터마크 레이어를 지우거나 숨겨도 500ms마다 감시해 자동 복원
function _startWatermarkGuard(employeeId) {
  applyWatermark(employeeId);
  if (_wmGuardStarted) return;
  _wmGuardStarted = true;
  setInterval(() => {
    const currentEmpId = getStoredEmployeeId();
    if (!currentEmpId) return; // 로그아웃 상태면 감시 중단
    if (!document.getElementById('wm-layer')) {
      applyWatermark(currentEmpId);
    }
  }, 500);
}

// ===== 콘텐츠 보호 (일반 학습자 전용, 관리자는 미적용) =====
let _protectionInitialized = false;

function _updateProtectionState() {
  document.body.classList.toggle('cvp-protected', isLoggedIn() && !isEditUnlocked());
}

function _initContentProtection() {
  _updateProtectionState();
  if (_protectionInitialized) return;
  _protectionInitialized = true;

  document.addEventListener('copy', e => { if (!isEditUnlocked()) e.preventDefault(); });
  document.addEventListener('selectstart', e => { if (!isEditUnlocked()) e.preventDefault(); });
  document.addEventListener('contextmenu', e => { if (!isEditUnlocked()) e.preventDefault(); });
  document.addEventListener('dragstart', e => { if (!isEditUnlocked()) e.preventDefault(); });

  document.addEventListener('keydown', e => {
    if (isEditUnlocked()) return;
    if (e.ctrlKey && e.shiftKey && e.key === 'I') e.preventDefault();
    if (e.ctrlKey && e.shiftKey && e.key === 'J') e.preventDefault();
    if (e.ctrlKey && e.key === 'U') e.preventDefault();
  });

  window.addEventListener('beforeprint', e => { if (!isEditUnlocked()) e.preventDefault(); });
}

// ===== MODEL VOICE (localStorage) =====
let _mvAudioUrl = null;
let _modalMvLang = 'ja'; // 모달에서 현재 선택된 언어 탭

function base64ToBlob(base64) {
  const parts = base64.split(',');
  const mime = (parts[0].match(/:(.*?);/)||['','audio/mpeg'])[1];
  const bin = atob(parts[1]||parts[0]);
  const arr = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr],{type:mime});
}

// 언어별 로드: lang 지정 시 lang 키 우선, 없으면 레거시 단일 키 폴백
function loadModelVoice(scriptId, lang) {
  if (lang) {
    const v = localStorage.getItem(`cabinvoice_voice_${scriptId}_${lang}`);
    if (v) return v;
  }
  return localStorage.getItem(`cabinvoice_voice_${scriptId}`) || null;
}
function saveModelVoiceLang(scriptId, lang, base64, name) {
  localStorage.setItem(`cabinvoice_voice_${scriptId}_${lang}`, base64);
  if (name) localStorage.setItem(`cabinvoice_voice_${scriptId}_${lang}_name`, name);
}
function deleteModelVoiceLang(scriptId, lang) {
  localStorage.removeItem(`cabinvoice_voice_${scriptId}_${lang}`);
  localStorage.removeItem(`cabinvoice_voice_${scriptId}_${lang}_name`);
}
function getModelVoiceKey(lang) {
  const id = _modalState.mode === 'edit' ? _modalState.editId : '_pending';
  return `cabinvoice_voice_${id}_${lang}`;
}
function _refreshMvUI() {
  ['ja','ca'].forEach(lang => {
    const key = getModelVoiceKey(lang);
    const stored = localStorage.getItem(key);
    const el = document.getElementById(`mv-current-${lang}`);
    const nameEl = document.getElementById(`mv-name-${lang}`);
    if (el) el.classList.toggle('hidden', !stored);
    if (nameEl) nameEl.textContent = stored ? (localStorage.getItem(key + '_name') || '등록됨') : '';
  });
}

// ===== PRACTICE COUNT =====
function getPracticeCount(scriptId) {
  return parseInt(localStorage.getItem(`practiceCount_${scriptId}`) || '0', 10);
}
function incPracticeCount(scriptId) {
  const count = getPracticeCount(scriptId) + 1;
  localStorage.setItem(`practiceCount_${scriptId}`, count);
  localStorage.setItem(`practiceLastDate_${scriptId}`, new Date().toISOString().slice(0, 10));
  console.log(`[연습카운터] ${scriptId} → ${count}회`);
  return count;
}
function getLastPracticeLabel(scriptId) {
  const stored = localStorage.getItem(`practiceLastDate_${scriptId}`);
  if (!stored) return null;
  const diffDays = Math.floor((Date.now() - new Date(stored).getTime()) / 86400000);
  if (diffDays === 0) return '오늘';
  if (diffDays === 1) return '어제';
  return `${diffDays}일 전`;
}

// ===== TOAST =====
let _toastTimer = null;
function showToast(msg, duration = 2200) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), duration);
}

// ===== SENTENCE SPLIT & CLICKABLE RENDER =====
function splitSentences(text) {
  return text
    .split(/(?<=\.)\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
}

function renderClickableScript(text, lang) {
  return _renderKoEnText(text, lang || state.selectedLang);
}

// ===== HTML ESCAPING & SCRIPT TEXT RENDERING =====
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
// 데이터에 포함된 기존 독음 줄 제거
// (교범 레이아웃을 그대로 옮긴 흔적. 루비 주석이 같은 정보를 문절 단위로 더 정확히
//  보여주므로 중복 표기를 막는다. 원본 데이터는 건드리지 않고 렌더 시점에만 숨김.)
// 판정: 가나·한자가 하나도 없고 한글 3자 이상 + 바로 다음 줄에 가나가 있는 줄
function _stripYomiLines(text, lang) {
  if (lang !== 'ja' || !text) return text;
  const lines = String(text).split('\n');
  const hasKana = s => /[\u3040-\u30ff]/.test(s);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], t = L.trim();
    const koCount = (t.match(/[가-힣]/g) || []).length;
    const nxt = (lines[i+1] || '').trim();
    const bracketed = t.startsWith('[') && t.endsWith(']');
    // 일반 독음 줄: 대괄호 아님 + 다음 줄에 가나
    // 선택 문안 독음 줄: 대괄호로 감쌈 + 다음 줄도 대괄호이면서 가나 포함
    //   예) [오하요-고자이마스 / 곤니치와] ↔ [おはようございます。/ こんにちは。]
    const isYomi = t && !hasKana(t) && !/[\u4e00-\u9fff]/.test(t) && koCount >= 3
                   && !t.includes('|')
                   && (bracketed
                        ? (nxt.startsWith('[') && nxt.endsWith(']') && hasKana(nxt))
                        : hasKana(nxt));
    if (!isYomi) out.push(L);
  }
  return out.join('\n');
}

// 독음(일본어)·병음(중국어)은 항상 표시한다.
// 교범 자체가 독음을 병기하므로 앱도 같은 형태로 보여주는 것이 기준이다.
// 과거의 ON/OFF 는 OFF 일 때 데이터 속 독음 줄이 그대로 드러나 일본어·한글이 섞여 보였고,
// 화면마다 표시가 달라지는 문제가 있어 폐지했다.
const _showReading = true;
function _withReading(html, lang) {
  if (typeof annotateReading !== 'function') return html;
  try { return annotateReading(html, lang); } catch { return html; }
}
function _renderKoEnText(text, lang) {
  // 독음 맵은 '독음 줄이 제거되기 전' 원문에서 만들어야 한다.
  if (lang === 'ja' && typeof buildScriptYomiMap === 'function') {
    try { buildScriptYomiMap(text); } catch {}
  }
  text = _showReading ? _stripYomiLines(text, lang) : text;
  const hv = s => _withReading(escHtml(s).replace(/\[([^\]]+)\]/g, (match, inner) => {
    if (/^(General|수하물|필요|생략|군사)/.test(inner)) return match;
    return `<span class="script-var">[${inner}]</span>`;
  }), lang);
  const lines = text.split('\n');
  let html = '';
  let tableRows = [];  // markdown pipe tables
  let taggedRows = []; // [TAG] content section lines
  let pendingTagRow = false; // 단독 태그 줄이 다음 본문 줄을 기다리는 중
  let pendingInline = null;  // '생략 가능'/'필요 시' 배지가 본문을 기다리는 중

  const flushTable = () => {
    if (!tableRows.length) return;
    let t = '<table class="script-table"><thead><tr>';
    t += tableRows[0].map(c => `<th>${escHtml(c)}</th>`).join('');
    t += '</tr></thead><tbody>';
    for (let i = 1; i < tableRows.length; i++) {
      t += '<tr>' + tableRows[i].map(c => `<td>${escHtml(c)}</td>`).join('') + '</tr>';
    }
    t += '</tbody></table>';
    html += t;
    tableRows = [];
  };

  const flushTaggedRows = () => {
    if (!taggedRows.length) return;
    if (taggedRows.length === 1) {
      const { tag, content } = taggedRows[0];
      html += `<div class="script-section-card"><span class="tag-cell">${escHtml(tag)}</span><span>${content ? hv(content) : ''}</span></div>`;
    } else {
      let t = '<table class="script-section-table">';
      for (const { tag, content } of taggedRows) {
        t += `<tr><td class="tag-cell">${escHtml(tag)}</td><td>${hv(content)}</td></tr>`;
      }
      t += '</table>';
      html += t;
    }
    taggedRows = [];
  };

  for (const line of lines) {
    const tr = line.trim();

    // Markdown pipe table (existing feature)
    if (/^\|.+\|$/.test(tr)) {
      flushTaggedRows();
      if (/^\|[\s\-|:]+\|$/.test(tr)) continue;
      tableRows.push(tr.slice(1, -1).split('|').map(c => c.trim()));
      continue;
    }

    // Section tag line: [TAG] content  OR  [TAG] alone on line
    // 태그는 한국어 라벨([General], [목적지], [10분 초과 지연 시] 등)만 해당.
    // 대괄호 안에 가나·한자가 들어있으면 선택 문안(본문)이므로 태그로 보지 않는다.
    const _isScriptBracket = s => /[\u3040-\u30ff\u4e00-\u9fff]/.test(s);
    let tagMatch = tr.match(/^\[([^\]]+)\]\s+(.*)/);
    if (tagMatch && _isScriptBracket(tagMatch[1])) tagMatch = null;
    let soloTagMatch = !tagMatch && tr.match(/^\[([^\]]+)\]$/);
    if (soloTagMatch && _isScriptBracket(soloTagMatch[1])) soloTagMatch = null;

    if (tagMatch || soloTagMatch) {
      flushTable();
      const tag = tagMatch ? tagMatch[1] : soloTagMatch[1];
      const content = tagMatch ? tagMatch[2] : '';
      if (tag === '생략 가능' || tag === '필요 시') {
        flushTaggedRows();
        const cls = tag === '생략 가능' ? 'script-optional' : 'script-conditional';
        if (content) {
          html += `<div class="${cls}"><span class="script-section-badge">${tag}</span>${hv(content)}</div>`;
        } else {
          // 배지만 있는 줄 — 본문은 다음 줄에 온다. 지금 닫으면 배지만 덩그러니 남고
          // 본문이 블록 밖으로 빠져 어느 구간이 '생략 가능'인지 알 수 없게 된다.
          pendingInline = { cls, tag };
        }
      } else {
        taggedRows.push({ tag, content });
        // 단독 태그 줄([10분 초과 지연 시] 등)은 본문이 다음 줄에 온다.
        // 표시하지 않으면 빈 행이 생기고 본문이 표 밖으로 밀려난다.
        if (!content) pendingTagRow = true;
      }
      continue;
    }

    // Regular text line
    if (pendingInline) {
      if (!tr) continue;
      html += `<div class="${pendingInline.cls}"><span class="script-section-badge">${pendingInline.tag}</span>${hv(tr)}</div>`;
      pendingInline = null;
      continue;
    }
    if (pendingTagRow) {
      if (!tr) continue;                       // 태그와 본문 사이 빈 줄은 건너뜀
      taggedRows[taggedRows.length - 1].content = tr;
      pendingTagRow = false;
      continue;
    }
    flushTable();
    flushTaggedRows();
    if (!tr) {
      html += '<div style="height:8px"></div>';
    } else {
      html += `<p style="margin:0 0 8px 0;line-height:1.8;">${hv(tr)}</p>`;
    }
  }
  pendingTagRow = false;
  pendingInline = null;

  flushTable();
  flushTaggedRows();
  return `<div class="script-text-rendered">${html}</div>`;
}

// ===== CUSTOM SCRIPTS (localStorage) =====
function loadCustomScripts() {
  try { return JSON.parse(localStorage.getItem('cabinvoice_custom_scripts') || '[]'); }
  catch { return []; }
}
function saveCustomScripts(arr) {
  localStorage.setItem('cabinvoice_custom_scripts', JSON.stringify(arr));
}
function deleteCustomScript(id) {
  const arr = loadCustomScripts().filter(s => s.id !== id);
  saveCustomScripts(arr);
  renderHome();
}
function extractKeyPhrases(text, lang) {
  const stopKo = new Set(['그리고','하지만','또한','이제','잠시','이후','때까지','위해','대해','것을','있는','있습니다','합니다','주시기','바랍니다','하여','되었습니다','드리겠습니다','주세요','감사합니다','안녕하십니까','승객여러분','저희','현재','대한']);
  const words = text.replace(/[.,!?。、，！？：；·\n]/g,' ').split(/\s+/).filter(w => w.length >= (lang==='en'?4:2) && !stopKo.has(w));
  const result = [];
  const step = Math.max(1, Math.floor(words.length / 6));
  for (let i = 0; i < words.length && result.length < 6; i += step) result.push(words[i]);
  return result.length ? result : ['방송'];
}
function buildCustomLang(text, cpStr, langCode) {
  const sttMap = { ja:'ja-JP', ca:'zh-CN' };
  // 적정 속도: 교관 모델음성 실측 기준 (선택 문안 없는 방송문 표본)
  //   JA 중앙값 279 모라/분 (n=8, SD 19) / CA 중앙값 151 자/분 (n=6, SD 14)
  //   허용폭(Tolerance)은 실측 SD의 약 4배 — 이 범위를 벗어나면 속도 점수 0
  const speedMap      = { ja:279, ca:151 };
  const speedUnitMap  = { ja:'모라/분', ca:'자/분' };
  const speedTolMap   = { ja:80, ca:55 };
  const checkpoints = cpStr ? cpStr.split(',').map(s=>s.trim()).filter(Boolean) : [];
  return {
    sttLang:       sttMap[langCode] || 'ja-JP',
    idealSpeed:    speedMap[langCode] || 279,
    speedUnit:     speedUnitMap[langCode] || '모라/분',
    speedTolerance: speedTolMap[langCode] || 80,
    text: text.trim(),
    checkpoints: checkpoints.length ? checkpoints : ['방송 내용'],
    keyPhrases: extractKeyPhrases(text, langCode),
    tips: ['실제 방송문으로 연습합니다', '밝고 명확한 목소리로', '방송문을 충분히 숙지한 후 시작하세요']
  };
}

// ===== HOME / SIDEBAR =====
// 일일 AI 채점 한도(5회) — Firestore를 서버 기준 저장소로 사용해 PC/모바일 등
// 어떤 기기·브라우저로 접속해도 동일한 사번(empId)이면 같은 카운트를 공유하게 함.
// (기존에는 localStorage에만 저장되어 기기별로 카운트가 따로 놀았음)
function _getEmpId() {
  try {
    return JSON.parse(localStorage.getItem('vp_s') || '{}').empId || 'guest';
  } catch (e) { return 'guest'; }
}
function _getLocalDateKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function _getDailyUsageCount(empId) {
  const localKey = 'vp_daily3_' + empId + '_' + _getLocalDateKey();
  if (!_db && !initFirebase()) {
    // Firestore 연결 불가(오프라인 등) 시에만 로컬 값으로 대체
    return parseInt(localStorage.getItem(localKey) || '0');
  }
  try {
    const docId = empId + '_' + _getLocalDateKey();
    const snap = await _db.collection('dailyUsage').doc(docId).get();
    return snap.exists ? (snap.data().count || 0) : 0;
  } catch (e) {
    console.warn('[일일한도] Firestore 조회 실패, 로컬 값으로 대체:', e);
    return parseInt(localStorage.getItem(localKey) || '0');
  }
}
async function _incrementDailyUsage(empId) {
  const localKey = 'vp_daily3_' + empId + '_' + _getLocalDateKey();
  const prevLocal = parseInt(localStorage.getItem(localKey) || '0');
  localStorage.setItem(localKey, prevLocal + 1); // 오프라인 폴백용 로컬 백업
  if (!_db && !initFirebase()) return;
  try {
    const docId = empId + '_' + _getLocalDateKey();
    await _db.collection('dailyUsage').doc(docId).set({
      count: firebase.firestore.FieldValue.increment(1),
      empId,
      date: _getLocalDateKey(),
      lastUpdate: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('[일일한도] Firestore 기록 실패(로컬에는 반영됨):', e);
  }
}

function updateAIUsageBadge() {
  const badge = document.getElementById('ai-usage-badge');
  const usedEl = document.getElementById('ai-used-count');
  const remainEl = document.getElementById('ai-remaining-count');
  if (!badge || !usedEl || !remainEl) return;

  const empId = _getEmpId();
  _getDailyUsageCount(empId).then(used => {
    const remaining = Math.max(0, 5 - used);
    usedEl.textContent = used;
    remainEl.textContent = remaining;
    remainEl.style.color = remaining <= 1 ? '#FF3B30' : '#003479';
    remainEl.style.fontWeight = '700';
    badge.style.cssText =
      'display:flex!important;background:#F5F5F7;' +
      'color:#6E6E73;border:1px solid #E5E5EA;' +
      'border-radius:8px;padding:4px 10px;' +
      'font-size:12px;align-items:center;gap:4px;';
  });
}

// ===== HOME / SIDEBAR =====
async function loadAndRenderHome() {
  updateAIUsageBadge();
  _renderSidebarLoading();

  let firestoreScripts = [];
  const cached = (() => { try { return JSON.parse(localStorage.getItem('cabinvoice_scripts_cache')||'null'); } catch { return null; } })();
  if (cached && cached.announcements && (Date.now()-cached.ts < 3600000)) {
    firestoreScripts = _mapAnnouncementsToScripts(cached.announcements);
    if ($('rev-badge')) $('rev-badge').textContent = cached.rev || 'OPIc 방식';
    console.log('[초기로딩] 소스: localStorage cache, 방송문 수:', cached.announcements.length);
  } else if (initFirebase()) {
    try {
      const latest = await firestoreLoadLatest();
      if (latest && latest.announcements) {
        firestoreScripts = _mapAnnouncementsToScripts(latest.announcements);
        localStorage.setItem('cabinvoice_scripts_cache', JSON.stringify({
          rev: latest.revVersion, announcements: latest.announcements, ts: Date.now()
        }));
        if ($('rev-badge')) $('rev-badge').textContent = latest.revVersion || 'OPIc 방식';
        console.log('[초기로딩] 소스: cabinManual/latest, 방송문 수:', latest.announcements.length);
      }
    } catch {}
  }

  const customScripts = loadCustomScripts();
  _allScripts = [...firestoreScripts, ...customScripts];

  renderSidebar(_allScripts);
  if (_db) _fetchGuideUpdateFlags().then(() => renderSidebar(_allScripts)).catch(() => {});
}

function _renderSidebarLoading() {
  const tree = $('sidebar-tree');
  if (tree) tree.innerHTML = '<div style="padding:32px 16px;text-align:center;color:var(--gray-400);font-size:14px">방송문 로딩 중...</div>';
}

function _mapAnnouncementsToScripts(announcements) {
  return announcements.map(a => ({
    id: a.id || a.section,
    icon: a.icon || '✈️',
    colorClass: 'c-blue',
    difficulty: '기본', difficultyClass: '',
    title: `${a.section || a.id} ${a.title}`,
    _chapter: a.chapterName || `${a.chapter}장`,
    _section: a.section || a.id,
    _chapterNum: a.chapter || 0,
    _evalLang: (a.evalLang || ['ja','ca']).filter(l => l === 'ja' || l === 'ca'),
    langs: {
      ...(a.ja ? { ja: buildCustomLang(a.ja, (a.checkpoints||[]).join(','), 'ja') } : {}),
      ...(a.ca ? { ca: buildCustomLang(a.ca, '', 'ca') } : {}),
    }
  })).filter(s => s.langs.ja || s.langs.ca);
}

function renderSidebar(scripts) {
  const tree = $('sidebar-tree');
  if (!tree) return;

  if (!scripts.length) {
    tree.innerHTML = '<div style="padding:32px 16px;text-align:center;color:var(--gray-400);font-size:13px">방송문 데이터가 없습니다.<br>관리자 패널에서 JSON을 업로드해 주세요.</div>';
    return;
  }

  // 챕터별 그룹핑
  const chapters = new Map();
  const customGroup = [];

  for (const s of scripts) {
    if (s._custom) {
      customGroup.push(s);
    } else {
      const chKey = s._chapter || '기타';
      if (!chapters.has(chKey)) chapters.set(chKey, []);
      chapters.get(chKey).push(s);
    }
  }

  let html = '';

  // 챕터 아코디언
  for (const [chapterName, items] of chapters) {
    html += `
    <div class="sidebar-chapter">
      <button class="sidebar-chapter-btn" data-chapter="${escHtml(chapterName)}">
        <span class="sidebar-chapter-name">${escHtml(chapterName)}</span>
        <span class="sidebar-chapter-count">${items.length}</span>
        <span class="sidebar-chapter-arrow">▾</span>
      </button>
      <div class="sidebar-chapter-items">
        ${items.map(s => _sidebarItemHtml(s)).join('')}
      </div>
    </div>`;
  }

  // 내 방송문
  if (customGroup.length) {
    html += `
    <div class="sidebar-chapter">
      <button class="sidebar-chapter-btn" data-chapter="__custom">
        <span class="sidebar-chapter-name">📋 내 방송문</span>
        <span class="sidebar-chapter-count">${customGroup.length}</span>
        <span class="sidebar-chapter-arrow">▾</span>
      </button>
      <div class="sidebar-chapter-items">
        ${customGroup.map(s => _sidebarItemHtml(s)).join('')}
      </div>
    </div>`;
  }

  tree.innerHTML = html;

  // 아코디언 토글
  tree.querySelectorAll('.sidebar-chapter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = btn.closest('.sidebar-chapter');
      ch.classList.toggle('open');
    });
  });
  // 첫 챕터 자동 열기
  const first = tree.querySelector('.sidebar-chapter');
  if (first) first.classList.add('open');

  // 항목 클릭
  tree.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      selectScript(id);
    });
  });
}

function _sidebarItemHtml(s) {
  const evalLangs = s._evalLang || ['ja','ca'];
  const langDots = evalLangs.filter(l => s.langs?.[l]?.text)
    .map(l => `<span class="lang-dot lang-dot-${l}"></span>`).join('');
  const cnt = getPracticeCount(s.id);
  const badge = cnt >= 20
    ? `<span class="practice-badge pb-gold">👑 ${cnt}회</span>`
    : cnt >= 10
      ? `<span class="practice-badge pb-hot">⭐ ${cnt}회</span>`
      : cnt >= 5
        ? `<span class="practice-badge pb-blue">🔥 ${cnt}회</span>`
        : cnt >= 1
          ? `<span class="practice-badge pb-gray">🌱 ${cnt}회</span>`
          : '';
  const updateBadge = _guideUpdateNeededIds.has(s.id)
    ? '<span class="update-needed-badge">🔄 업데이트</span>' : '';
  return `<div class="sidebar-item${_selectedScriptId===s.id?' selected':''}" data-id="${s.id}">
    <span class="sidebar-item-section">${s._section||''}</span>
    <span class="sidebar-item-title">${escHtml(s.title)}${updateBadge}</span>
    <span class="sidebar-item-langs">${langDots}${badge}</span>
  </div>`;
}

function selectScript(id) {
  _selectedScriptId = id;
  const s = getEffectiveScript(id);  // override 적용
  if (!s) return;

  // 사이드바 선택 표시
  document.querySelectorAll('.sidebar-item').forEach(el =>
    el.classList.toggle('selected', el.dataset.id === id));

  $('detail-empty').classList.add('hidden');
  $('detail-content').classList.remove('hidden');

  // 챕터 배지
  const badge = $('detail-chapter-badge');
  badge.textContent = s._chapter || '';
  badge.style.display = s._chapter ? '' : 'none';

  $('detail-section-num').textContent = s._section || '';
  $('detail-title').textContent = s.title;

  // 편집 버튼 (인증된 경우)
  const editBtn = $('detail-edit-btn');
  editBtn.classList.toggle('hidden', !_isAdminSession());
  editBtn.dataset.id = id;
  editBtn.dataset.source = s._custom ? 'custom' : 'builtin';

  // 언어 탭 표시
  _detailLang = Object.keys(s.langs).find(l => s.langs[l]?.text) || 'ja';
  _renderDetailLangTabs(s);
  _renderDetailContent(s, _detailLang);


  // 모바일: 사이드바 닫기
  if (window.innerWidth <= 768) closeSidebar();
}

function _renderDetailLangTabs(s) {
  const evalLangs = s._evalLang || ['ja','ca'];
  const tabs = $('detail-lang-tabs');
  tabs.querySelectorAll('.detail-lang-tab').forEach(tab => {
    const lang = tab.dataset.lang;
    const inEval = evalLangs.includes(lang);
    const hasLang = s.langs[lang]?.text;
    tab.style.display = (inEval && hasLang) ? '' : 'none';
    tab.classList.toggle('active', lang === _detailLang);
  });
}

function _renderDetailContent(s, lang) {
  _lastDetailScript = s;
  if (window._syncPronBtn) window._syncPronBtn();
  const langData = s.langs[lang];
  if (!langData) return;

  renderScriptText(s, lang, $('detail-script-box'));

  // 체크포인트
  const cpEl = $('detail-checkpoints');
  if (langData.checkpoints?.length) {
    cpEl.classList.remove('hidden');
    cpEl.innerHTML = `<div class="checkpoints-label">✅ 핵심 체크포인트</div>
      <div class="checkpoints-list">${langData.checkpoints.map(c=>`<span class="checkpoint-item">✓ ${c}</span>`).join('')}</div>`;
  } else {
    cpEl.classList.add('hidden');
  }

  // detail-voice-btn 제거됨

  // 연습 횟수 + 마지막 날짜
  const practiceEl = $('detail-practice-info');
  if (practiceEl) {
    const cnt = getPracticeCount(s.id);
    const lastLabel = getLastPracticeLabel(s.id);
    const emoji = cnt >= 20 ? '👑' : cnt >= 10 ? '⭐' : cnt >= 5 ? '🔥' : cnt >= 1 ? '🌱' : '';
    practiceEl.innerHTML = cnt > 0
      ? `<span class="practice-count-info">${emoji} <strong>${cnt}회</strong> 연습 · 마지막: ${lastLabel} <span class="practice-count-device">(이 기기)</span></span>`
      : '';
  }

  // 연습 시작 버튼
  $('detail-start-btn').dataset.id = s.id;
  $('detail-start-btn').dataset.lang = lang;
}

function renderHome() {
  loadAndRenderHome();
}

function openSidebar() {
  $('nav-sidebar').classList.add('open');
  $('sidebar-overlay').classList.remove('hidden');
}
function closeSidebar() {
  $('nav-sidebar').classList.remove('open');
  $('sidebar-overlay').classList.add('hidden');
}

function _setupSidebarSearch() {
  const input = $('sidebar-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    document.querySelectorAll('.sidebar-item').forEach(item => {
      const title = item.querySelector('.sidebar-item-title')?.textContent.toLowerCase()||'';
      const sec = item.querySelector('.sidebar-item-section')?.textContent.toLowerCase()||'';
      const match = !q || title.includes(q) || sec.includes(q);
      item.style.display = match ? '' : 'none';
    });
    if (q) {
      document.querySelectorAll('.sidebar-chapter').forEach(ch => {
        const visible = [...ch.querySelectorAll('.sidebar-item')].some(i => i.style.display !== 'none');
        ch.classList.toggle('open', visible);
      });
    }
  });
}

// ─── 통합 방송문 렌더링 함수 (ko/en) ─────────────────────────────────────
function renderScriptText(script, langCode, targetEl) {
  if (!targetEl) return;
  const text = script?.langs?.[langCode]?.text || '';
  targetEl.innerHTML = _renderKoEnText(text, langCode);
}

// ===== PREP =====
function startPrep(script, lang) {
  state.currentScript = script;
  if (lang) state.selectedLang = lang;
  clearInterval(state.prepTimerInterval);
  updatePrepContent();
  showScreen('screen-prep');
}

function updatePrepContent() {
  const s = state.currentScript;
  const evalLangs = s._evalLang || ['ja','ca'];

  // 언어 탭: evalLang에 포함되고 데이터 있는 탭만 표시
  $('lang-tabs').querySelectorAll('.lang-tab').forEach(tab => {
    const lang = tab.dataset.lang;
    const inEval = evalLangs.includes(lang);
    const hasLang = s.langs[lang]?.text;
    tab.style.display = (inEval && hasLang) ? '' : 'none';
  });
  // 선택된 언어가 evalLang에 없거나 데이터 없으면 fallback
  if (!evalLangs.includes(state.selectedLang) || !s.langs[state.selectedLang]?.text) {
    state.selectedLang = evalLangs.find(l => s.langs[l]?.text) || 'ja';
    $('lang-tabs').querySelectorAll('.lang-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.lang === state.selectedLang);
    });
  }

  const lang = s.langs[state.selectedLang];

  if ($('prep-title-bar')) $('prep-title-bar').textContent = s.title;

  const prepTextEl = $('prep-text');
  const _langCode  = state.selectedLang;

  renderScriptText(s, _langCode, prepTextEl);

  // 준비 화면 — 모델 음성 플레이어 제거됨, 드릴/학습은 각 화면에서 관리

  $('prep-checkpoints').innerHTML = lang.checkpoints.map(c =>
    `<span class="checkpoint-item">✓ ${c}</span>`).join('');

  $('tips-box').innerHTML = `
    <div class="tips-box-label">💡 연습 팁</div>
    ${lang.tips.map(t => `<div class="tip-item">${t}</div>`).join('')}`;
}

function startPrepTimer() { /* 타이머 제거됨 */ }

// ===== RECORDING =====
async function startRecording() {
  clearInterval(state.prepTimerInterval);
  if (_currentModelAudio) { _currentModelAudio.pause(); _currentModelAudio.currentTime = 0; _currentModelAudio = null; }

  const isPWA = window.matchMedia('(display-mode: standalone)').matches
                || window.navigator.standalone === true;

  // 이전 스트림/AudioContext 정리 (백그라운드 복귀 시 stale 참조 방지)
  if (state.stream) {
    stopMicStream(state.stream);
    state.stream = null;
  }
  if (state.audioContext) {
    await state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }

  // iOS PWA: getUserMedia는 반드시 클릭 이벤트에서 첫 번째 await로 호출해야 함
  // 카운트다운(await) 이후에 호출하면 사용자 제스처 컨텍스트가 소멸되어 차단됨
  let _stream;
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 44100, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (e) {
    console.error('[마이크] 권한 오류:', e.name, e.message, '| PWA:', isPWA);
    alert(`마이크 접근 권한이 필요합니다.\n오류: ${e.name}`);
    return;
  }

  // 마이크 확보 후 카운트다운
  await new Promise(resolve => {
    const overlay = $('countdown-overlay');
    const numEl = $('countdown-number');
    overlay.classList.remove('hidden');
    let count = 3;
    numEl.textContent = count;
    const iv = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(iv);
        overlay.classList.add('hidden');
        resolve();
      } else {
        numEl.textContent = count;
      }
    }, 800);
  });

  const lang = state.currentScript.langs[state.selectedLang];

  state.transcript = '';
  state.pitchSamples = [];
  state.amplitudeSamples = [];
  state.pauseSamples = [];
  state.audioChunks = [];
  state.recordingStart = Date.now();
  state.stream = _stream;

  $('record-title').textContent = `${state.currentScript.title} · ${{ ja:'日本語', ca:'中文' }[state.selectedLang] || '日本語'}`;
  $('record-timer').textContent = '00:00';
  $('live-text').textContent = '말씀해 주세요...';
  renderScriptText(state.currentScript, state.selectedLang, $('script-peek-text'));
  $('script-peek-text').classList.add('hidden');
  showScreen('screen-record');

  const AudioCtx = /** @type {any} */ (window).AudioContext || /** @type {any} */ (window).webkitAudioContext;
  state.audioContext = new AudioCtx();
  // iOS는 AudioContext를 suspended 상태로 생성할 수 있음 — 명시적 resume (타임아웃 안전장치 포함)
  await _resumeCtxWithTimeout(state.audioContext);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 4096;
  state.analyser.smoothingTimeConstant = 0.6;
  state.sourceNode = state.audioContext.createMediaStreamSource(state.stream);
  state.sourceNode.connect(state.analyser);

  const _recOpts = _getSupportedMimeType();
  // 음성 채점용 비트레이트를 64kbps로 제한 (음질은 음성 인식/분석에 충분, 파일 용량은 크게 감소)
  // → 파일이 작을수록 Gemini 전송/분석 시간이 줄어 동시접속 시 타임아웃 확률이 낮아짐
  _recOpts.audioBitsPerSecond = 64000;
  console.log('[녹음] mimeType:', _recOpts.mimeType || '기본값', '| 비트레이트: 64kbps');
  state.mediaRecorder = new MediaRecorder(state.stream, _recOpts);
  state.mediaRecorder.ondataavailable = e => { 
    if (e.data && e.data.size > 0) {
      state.audioChunks.push(e.data);
      console.log('[녹음] 청크 수집:', 
        state.audioChunks.length, '개',
        (e.data.size/1024).toFixed(1) + 'KB');
    }
  };
  // iOS PWA: 250ms마다 청크 수집
  state.mediaRecorder.start(250);

  drawWaveform();
  startAudioSampling();

  state.recordTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.recordingStart) / 1000);
    $('record-timer').textContent = `${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
  }, 500);

  setupSpeechRecognition(lang.sttLang);
}

function drawWaveform() {
  const canvas = $('waveform-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth || 800;
  const H = canvas.height = 140;
  const bufLen = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufLen);

  function draw() {
    state.animFrameId = requestAnimationFrame(draw);
    state.analyser.getByteTimeDomainData(dataArray);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(59,130,246,.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#3b82f6'); grad.addColorStop(0.5, '#8b5cf6'); grad.addColorStop(1, '#3b82f6');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 8; ctx.shadowColor = '#3b82f6';
    ctx.beginPath();
    const sliceW = W / bufLen;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const y = ((dataArray[i] / 128.0) - 1) * H * 0.42 + H / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sliceW;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  draw();
}

function startAudioSampling() {
  const floatBuf = new Float32Array(state.analyser.fftSize);
  const freqBuf  = new Uint8Array(state.analyser.frequencyBinCount);
  const SILENCE_THRESH = 0.015;

  state._sampleInterval = setInterval(() => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;

    state.analyser.getFloatTimeDomainData(floatBuf);
    state.analyser.getByteFrequencyData(freqBuf);

    // RMS amplitude
    let sumSq = 0;
    for (let i = 0; i < floatBuf.length; i++) sumSq += floatBuf[i] * floatBuf[i];
    const rms = Math.sqrt(sumSq / floatBuf.length);
    state.amplitudeSamples.push(rms);

    // Silence flag for pause detection
    state.pauseSamples.push(rms < SILENCE_THRESH ? 0 : 1);

    // Pitch: autocorrelation on float data
    if (rms > SILENCE_THRESH) {
      const pitch = autoCorrelationPitch(floatBuf, state.audioContext.sampleRate);
      if (pitch > 75 && pitch < 520) state.pitchSamples.push(pitch);
    }
  }, 100);
}

// 자기상관 피치 검출 (FFT 피크보다 정밀)
function autoCorrelationPitch(buf, sampleRate) {
  const n = 1024; // 분석 구간 (성능 최적화)
  const minP = Math.floor(sampleRate / 520);
  const maxP = Math.floor(sampleRate / 75);
  let bestCorr = -1, bestPeriod = 0;

  for (let p = minP; p <= maxP; p++) {
    let corr = 0;
    for (let i = 0; i < n - p; i++) corr += buf[i] * buf[i + p];
    corr /= (n - p);
    if (corr > bestCorr) { bestCorr = corr; bestPeriod = p; }
  }
  return bestPeriod > 0 ? sampleRate / bestPeriod : 0;
}

function setupSpeechRecognition(langCode) {
  const SR = /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
  console.log('[STT] setupSpeechRecognition 호출, langCode:', langCode, '| SR 지원:', !!SR);
  if (!SR) { $('live-text').textContent = '⚠️ Chrome 브라우저에서만 음성 인식이 지원됩니다.'; return; }

  const recog = new SR();
  recog.lang = langCode;
  recog.continuous = true;
  recog.interimResults = true;

  recog.onstart = () => console.log('[STT] onstart 발생 — 인식 세션 정상 시작됨');
  recog.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      e.results[i].isFinal ? (state.transcript += t + ' ') : (interim = t);
    }
    console.log('[STT] onresult 발생 — interim:', interim, '| final 누적길이:', state.transcript.length);
    // 인식된 발화에도 독음/병음을 붙여 학습자가 즉시 대조할 수 있게 한다.
    const _lt = (state.transcript + interim).trim();
    if (_lt) $('live-text').innerHTML = _withReading(escHtml(_lt), state.selectedLang);
    else $('live-text').textContent = '말씀해 주세요...';
  };
  recog.onerror = e => {
    console.warn('[STT] onerror 발생 —', e.error); // no-speech 포함 전부 기록 (진단용)
  };
  recog.onend = () => {
    console.log('[STT] onend 발생 | 녹음상태:', state.mediaRecorder?.state);
    if (state.mediaRecorder?.state === 'recording') {
      try { recog.start(); } catch(e) { console.warn('[STT] 재시작 실패:', e.name, e.message); }
    }
  };
  try {
    recog.start();
    console.log('[STT] recog.start() 호출 성공 (동기적으로 에러 없음)');
  } catch(e) {
    console.warn('[STT] 최초 시작 실패:', e.name, e.message);
  }
  state.recognition = recog;
}

async function stopRecording() {
  clearInterval(state.recordTimerInterval);
  clearInterval(state._sampleInterval);
  cancelAnimationFrame(state.animFrameId);
  try { state.recognition?.abort(); } catch(e){}
  state.recognition = null;

  // 연습 횟수 카운터 + 축하 토스트
  if (state.currentScript?.id) {
    const count = incPracticeCount(state.currentScript.id);
    renderSidebar(_allScripts);
    if      (count === 1)  showToast('첫 번째 연습 완료! 🌱', 3000);
    else if (count === 5)  showToast('5회 달성! 🔥 꾸준히 하고 있어요', 3000);
    else if (count === 10) showToast('10회 달성! ⭐ 정말 열심히 하시네요', 3000);
    else if (count === 20) showToast('20회 달성! 👑 당신은 방송 마스터', 3000);
    else                   showToast(`${count}회째 연습 완료! 잘하고 있어요 ✈`, 2500);
  }

  const duration = (Date.now() - state.recordingStart) / 1000;
  $('loading-overlay').classList.remove('hidden');
  _startOverlayTimers();

  const finish = async () => {
    const mimeType = state.mediaRecorder?.mimeType || 'audio/mp4';
    console.log('[녹음완료] 총 청크수:', 
      state.audioChunks.length,
      '| mimeType:', mimeType);

    // iOS PWA: 청크가 없으면 잠시 대기
    if (state.audioChunks.length === 0) {
      await new Promise(r => setTimeout(r, 500));
    }

    state.audioBlob = new Blob(state.audioChunks, { type: mimeType });

    console.log('[녹음완료] Blob 크기:', 
      (state.audioBlob.size/1024/1024).toFixed(2) + 'MB');
    // ① 녹음 시간 3초 미만 차단
    if (duration < 3) {
      _completeOverlay();
      showToast('녹음 시간이 너무 짧습니다. 3초 이상 녹음해주세요.', 3000);
      return;
    }
    // ② 파일 크기 10KB 미만 차단
    if (state.audioBlob.size < 10000) {
      _completeOverlay();
      showToast('녹음 파일이 너무 작습니다. 마이크를 확인하고 다시 시도해주세요.', 3000);
      return;
    }
    _lastRecordingBlob = state.audioBlob;
    _aiAnalysisRetryCount = 0;
    if (_lastRecordingUrl) { URL.revokeObjectURL(_lastRecordingUrl); }
    _lastRecordingUrl = URL.createObjectURL(_lastRecordingBlob);
    if (_lastRecordingBlob.size > 500 * 1024) {
      showToast('음성 파일이 큽니다. 분석에 시간이 걸릴 수 있어요.', 3500);
    }
    _recordPracticeTime(duration); // 낭독 연습 시간 누적
    analyzeAndShow(duration);
  };

  if (state.mediaRecorder?.state !== 'inactive') {
    state.mediaRecorder.onstop = finish;
    state.mediaRecorder.stop();
  } else {
    finish();
  }

  stopMicStream(state.stream);
  state.stream = null;

  // AudioContext는 여기서 닫지 않고 유지 — 다음 startRecording()에서 정리됨
  await _releaseAudioSession();
}

// ===== 3단계 배점 =====
// 실제 평가(85점 PASS)를 대비하는 도구이므로 만점 문턱을 실측 기준에 맞춘다.
// 과거 0.72에서 만점을 주던 설정은 점수를 부풀려 응시자가 준비 상태를 오판하게 했다.
function tierScore(ratio, maxPt) {
  if (!ratio || ratio <= 0) return 0;
  ratio = Math.min(1, Math.max(0, ratio));
  if (ratio >= 0.85) return maxPt;
  if (ratio >= 0.42) {
    if (maxPt === 10) return Math.round(5 + (ratio - 0.42) / 0.43 * 5);
    if (maxPt === 5)  return Math.round(2 + (ratio - 0.42) / 0.43 * 3);
  }
  if (ratio >= 0.20) {
    if (maxPt === 10) return Math.round(2 + (ratio - 0.20) / 0.22 * 4);
    if (maxPt === 5)  return Math.round(1 + (ratio - 0.20) / 0.22 * 2);
  }
  if (maxPt === 10) return Math.round(ratio / 0.20 * 2);
  if (maxPt === 5)  return Math.round(ratio / 0.20);
  return 0;
}

// ===== STUDY MODE =====
const _studyGuideCache = {};  // key: `${scriptId}_${lang}`
let _prepRenderToken = 0;     // stale async 렌더 방지용 토큰

async function startStudyMode() {
  const s = state.currentScript;
  if (!s) return;
  const lang = s.langs[state.selectedLang];
  if (!lang) return;

  // PWA 백그라운드 복귀 시 모델음성이 작게 들리는 문제 방지
  resumeAudioContext();

  $('study-title-bar').textContent = s.title;
  const langCode = state.selectedLang;

  const studyEl = $('study-script-text');
  if (studyEl) {
    // 가이드 없는 초기 상태: 라벨 표시 + 기본 renderScriptText
    const _lbl = document.querySelector('.study-script-label');
    if (_lbl) _lbl.style.display = '';
    renderScriptText(s, langCode, studyEl);
    console.log('[학습모드 방송문]', { id: s.id, lang: langCode, text: lang.text?.substring(0, 50) });
  }

  ['M', 'F'].forEach(g => {
    const btn = $(`study-gender-${g.toLowerCase()}`);
    if (btn) btn.classList.toggle('active', g === _currentGender);
  });
  createModelVoicePlayer('study-model-player', { noGender: true });

  // 가이드 초기화
  $('study-guide-result').classList.add('hidden');
  $('study-guide-result').innerHTML = '';
  $('study-guide-status').classList.add('hidden');
  $('btn-gen-guide').disabled = false;
  $('btn-gen-guide').textContent = '가이드 생성하기';
  const _needsUpdate = _guideUpdateNeededIds.has(s.id) && isEditUnlocked();
  $('study-guide-update-notice')?.classList.toggle('hidden', !_needsUpdate);
  const _updateBtn = $('btn-guide-update');
  if (_updateBtn) { _updateBtn.classList.toggle('hidden', !_needsUpdate); _updateBtn.disabled = false; _updateBtn.textContent = '🔄 업데이트'; }

  showScreen('screen-study');

  // 캐시 → Firestore 순으로 가이드 조회
  const cacheKey = `${s.id}_${state.selectedLang}`;
  if (_studyGuideCache[cacheKey]) {
    const cached = _studyGuideCache[cacheKey];
    _renderStudyGuide(cached);
    $('btn-gen-guide').textContent = '✅ 가이드 완성';
  } else {
    const statusEl = $('study-guide-status');
    statusEl.textContent = '저장된 가이드 확인 중...';
    statusEl.className = 'study-guide-loading';
    statusEl.classList.remove('hidden');
    try {
      const saved = await _loadGuideFromFirestore(s.id, state.selectedLang);
      statusEl.classList.add('hidden');
      if (saved) {
        _studyGuideCache[cacheKey] = saved;
        _renderStudyGuide(saved);
        $('btn-gen-guide').textContent = '✅ 가이드 완성';
        console.log('[완료] Firestore 저장 가이드 로드');
      }
    } catch (e) {
      statusEl.classList.add('hidden');
    }
  }
  console.log('[완료] 학습 모드 화면 진입');
}

async function _retryGuideWithSimplePrompt(scriptText) {
  const simplePrompt = `아래 방송문의 핵심 포인트를 한국어로 설명해줘.
방송문 텍스트에 한글 독음이나 특수 기호가 포함되어 있어도 무시하고 분석해줘.
반드시 아래 JSON 형식으로만 반환:
{"summary":"...","tips":["팁1","팁2","팁3"]}
JSON 외 어떤 텍스트도 포함하지 말 것.
방송문: ${scriptText}`;

  const res = await fetchWithRetry('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      contents: [{ parts: [{ text: simplePrompt }] }]
    })
  }, { statusEl: $('study-guide-status') });
  if (!res.ok) throw new Error(await _describeApiError(res));
  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('단순화 재시도 JSON 파싱 실패');
  return JSON.parse(m[0]);
}

// ─── Gemini API fetch 재시도 유틸리티 ──────────────────────────────────────
// 503/429 발생 시 지수 백오프 재시도 (최대 3회)
async function fetchWithRetry(url, options, { maxRetries = 5, statusEl = null } = {}) {
  for (let i = 0; i < maxRetries; i++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      const delay = Math.min(Math.pow(2, i) * 1000, 8000); // 최대 8초로 상한
      console.log(`[재시도] 네트워크 오류, ${i + 1}번째 재시도 ${delay}ms 후`);
      if (statusEl) statusEl.textContent = `⏳ 연결 오류. 재시도 중... (${i + 1}/${maxRetries})`;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if ((res.status === 503 || res.status === 429) && i < maxRetries - 1) {
      const delay = Math.min(Math.pow(2, i) * 1000, 8000); // 최대 8초로 상한
      console.log(`[재시도] HTTP ${res.status}, ${i + 1}번째 재시도 ${delay}ms 후`);
      if (statusEl) statusEl.textContent = `⏳ 서버가 바쁩니다. 잠시 후 재시도합니다... (${i + 1}/${maxRetries})`;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return res;
  }
  throw new Error('최대 재시도 횟수 초과');
}

// API 응답 실패 원인을 구체적으로 해석한다.
// 404는 원인이 둘로 갈리므로 응답 본문으로 구분한다.
//  - Cloudflare가 HTML을 반환 → /api/gemini 함수 미배포 (functions/ 누락 또는 빌드 설정)
//  - Gemini가 JSON 오류 반환  → 모델명 미지원 또는 API 키 권한 문제
async function _describeApiError(res) {
  let body = '';
  try { body = await res.text(); } catch {}
  const isHtml = /^\s*<(!doctype|html)/i.test(body);
  if (res.status === 404) {
    return isHtml
      ? 'API 경로를 찾을 수 없습니다. Cloudflare Pages에 functions/api/gemini.js 가 배포됐는지 확인하세요.'
      : `Gemini 모델(${GEMINI_MODEL})을 사용할 수 없습니다. 모델이 퇴역했거나 API 키 권한 문제입니다. main.js 상단 GEMINI_MODEL 을 최신 모델로 교체하세요.`
        + (body ? ' | ' + body.slice(0, 160) : '');
  }
  let msg = '';
  try { msg = JSON.parse(body)?.error || ''; } catch {}
  return msg || `HTTP ${res.status}` + (body ? ' | ' + body.slice(0, 160) : '');
}

async function callGeminiGuide(scriptText, langCode) {
  const langName = { ja: '일본어', ca: '중국어' }[langCode] || '일본어';

  const langSpecific = {
    ja: `일본어 발음·억양 가이드 필수 포함 (비전공 학습자 대상):
- 장음(ー·おう·えい 등) 위치와 길이 유지 포인트 예) 'とうきょう → 토-쿄- (4박)'
- 촉음(っ) 앞 멈춤 표시 예) 'しゅっぱつ → 슛(멈춤)파츠'
- 청음/탁음 구분이 헷갈리는 단어 짚기

[일본어 억양 원칙 — 반드시 준수]
일본어는 강세(stress)가 아니라 고저 악센트(高低アクセント) 언어다.
- 주의를 끌기 위해 임의로 억양을 올리라고 지도하지 말 것.
  한국어식으로 음을 올리면 오히려 부자연스럽고 의미 전달을 해친다.
- 단어 본래의 고저 패턴(頭高·中高·尾高·平板)을 지키는 방향으로만 안내할 것.
- 문말 です·ます는 자연스럽게 내려서(↘) 마무리한다. 올리면 감점 요인이다.
- 승객 주의 환기가 필요한 구간은 '억양을 올린다'가 아니라
  '앞에 한 박 쉬고 또박또박, 조금 느리게' 처럼 pause·속도로 안내할 것.`,
    ca: `중국어 발음·성조 가이드 필수 포함 (비전공 학습자 대상):
- 핵심 단어의 병음과 성조 번호 표기 예) '旅客 lǚkè (3성+4성)'
- 3성+3성 연속 시 앞 글자 2성 변조 등 성조 변화 규칙 표시
- 권설음(zh/ch/sh/r)과 설치음(z/c/s) 구분 포인트
- 경성(轻声) 처리 단어 짚기

[중국어 억양 원칙 — 반드시 준수]
- 성조가 최우선이다. 강조를 위해 성조를 무시하고 음을 올리라고 지도하지 말 것.
- 강조는 성조를 지킨 상태에서 '속도를 늦추고 또렷하게' 로 안내할 것.
- 4성이 연속되는 구간(各位·再见 등)은 앞 글자를 짧게 처리해야 자연스럽다.
  기내방송은 4성 연속이 잦으므로 해당 구간이 있으면 반드시 짚어줄 것.
- 3성 연속, 3성 뒤 다른 성조가 오는 구간의 변조도 함께 안내할 것.`
  };

  const prompt = `당신은 항공사 기내방송 전문 교관입니다.
아래 방송문을 분석해서 JSON만 반환하세요 (설명·주석 없이).

방송문 텍스트에 한글 독음이나 특수 기호가 포함되어 있어도 무시하고 분석해줘.
반드시 유효한 JSON만 반환해야 해. JSON 외 어떤 텍스트도 포함하지 말 것.

방송문 (${langName}):
${scriptText}

[끊어읽기 개수 제한 — 반드시 준수]
breakPoints 는 '실제로 쉬어야 하는 곳'만 표시한다. 많을수록 좋은 것이 아니다.
- 한 문장에 마크는 최대 2개, 방송문 전체로 6개를 넘기지 말 것.
- 조사·접속사마다 기계적으로 넣지 말 것. 문장이 뚝뚝 끊겨 낭독체가 된다.
- 넣어야 할 곳: 문장 종결, 나열 항목 사이, 의미 단위가 크게 바뀌는 지점.
- 넣지 말 것: 한 호흡에 자연스럽게 이어지는 짧은 구, 수식어와 피수식어 사이.

[강조 연출은 Pause만이 아니다 — 반드시 준수]
강조를 전부 끊어읽기(pause)로 처리하면 방송이 부자연스러워진다.
emphasisTechniques 에 구간별로 아래 수단을 나눠 배정할 것 (pause 편중 금지):
- slow  : 속도를 늦춰 강조 (편명·목적지·시간·숫자에 적합)
- tone  : 톤을 살짝 낮추거나 차분하게 하여 무게를 실음 (안전·주의 사항에 적합)
- clear : 또렷한 발음으로 강조 (혼동되기 쉬운 단어에 적합)
- pause : 앞뒤에 쉼을 두어 강조 (문장 전환, 중요 안내 도입부에만 제한적으로)
pause 는 emphasisTechniques 전체의 1/3 이하로 유지할 것.

중요: 학습 가이드의 설명(summary, breakPoints의 reason, speedGuide, intonationGuide, tips)은 반드시 한국어로 작성하세요.

[원문 인용 규칙 — 반드시 준수]
emphasisWords, intonationDetails의 phrase/markedText, breakPoints의 text/position 에 들어가는 방송문 구간은
위에 주어진 방송문에서 **한 글자도 바꾸지 말고 그대로 복사**하세요.
- 히라가나로 적힌 것을 한자로 바꾸지 마세요. 예) ひこうき 를 飛行機 로 쓰면 안 됨
- 한자로 적힌 것을 히라가나로 바꾸지 마세요.
- 띄어쓰기·구두점·기호도 원문 그대로 유지하세요.
- 이 앱은 원문과 정확히 일치하는 구간에만 독음(후리가나)을 붙입니다.
  표기를 바꾸면 학습자에게 독음이 표시되지 않아 학습이 불가능해집니다.

끊어읽기 가이드 작성 규칙:
1. 각 문장마다 끊어읽기 기호를 삽입한 텍스트를 text 필드에 제공
   - ∙(반박자): 0.3초 짧게 쉬기 (쉼표 정도)
   - /(한박자): 0.7초 충분히 쉬기 (숨 한 번)
   예) '손님 여러분∙ 에어카페를/ 시작하겠습니다.'
2. 기호가 삽입된 각 위치마다 marks 배열에 position·type·reason 포함
   혼합 사용 시 각 기호의 위치와 이유를 개별 항목으로 설명
3. 절대 금지: '끊어읽기가 필요합니다' 같은 막연한 표현

억양 가이드 작성 규칙:
1. 문장 전체가 아닌 구간별로 억양 방향 표시 (markedText에 ↗↘→ 기호 직접 삽입)
   예) '구매를 원하는 분은↗ 승무원에게 말씀해 주세요.↘'
2. 각 구간의 억양 이유를 segments 배열에 개별 설명
3. 한국어 기준: 문장 끝 (~니다/~세요) 반드시 ↘, 나열 중간은 ↗, 강조 단어 앞 ↗
4. 영어 기준: 내용어 강세 ↑, 평서문 끝 ↘, 나열 마지막 ↘

${langSpecific[langCode] || langSpecific.ko}

반환 형식:
{
  "summary": "이 방송문의 핵심 특징 1-2문장 (한국어)",
  "breakPoints": [
    {
      "text": "방송문 구간에 ∙ / 기호 삽입 (원어)",
      "marks": [
        { "position": "기호 앞 단어/구 (원어)", "type": "half 또는 full", "reason": "이유 (한국어)" }
      ]
    }
  ],
  "emphasisWords": ["강조할 단어/구1 (원어)", "..."],
  "emphasisTechniques": [
    { "phrase": "강조 구간 (원어, 원문 그대로)", "how": "slow 또는 tone 또는 pause 또는 clear",
      "guide": "구체적 연출 지시 (한국어)" }
  ],
  "speedGuide": "속도 가이드 (한국어)",
  "intonationGuide": "전체 억양 개요 (한국어)",
  "intonationDetails": [
    {
      "markedText": "방송문 구간에 ↗↘→ 기호 삽입 (원어)",
      "phrase": "기호 없는 원문 구간 (원어)",
      "direction": "up 또는 down 또는 flat 또는 mixed",
      "symbol": "↗ 또는 ↘ 또는 → 또는 ↗↘",
      "guide": "전체 연출 요약 (한국어)",
      "segments": [
        { "text": "구간 텍스트 (원어)", "direction": "up 또는 down 또는 flat", "reason": "이유 (한국어)" }
      ]
    }
  ],
  "tips": ["실전 팁 1 (한국어)", "..."]
}`;

  const res = await fetchWithRetry('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      contents: [{ parts: [{ text: prompt }] }]
    })
  }, { statusEl: $('study-guide-status') });
  if (res.status === 501) throw new Error('로컬 환경에서는 배포 후 사용 가능합니다.');
  if (!res.ok) throw new Error(res.status === 503 ? '일시적인 서버 오류입니다. 잠시 후 다시 시도해주세요.' : await _describeApiError(res));
  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();

  // 1차: 직접 파싱
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 2차: JSON 블록 추출 후 파싱
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {
        // 3차: 단순화된 프롬프트로 재시도
        console.warn('[가이드] JSON 파싱 2회 실패 → 단순 프롬프트 재시도');
        return await _retryGuideWithSimplePrompt(scriptText);
      }
    }
    // JSON 블록 자체가 없으면 바로 단순 재시도
    console.warn('[가이드] JSON 블록 없음 → 단순 프롬프트 재시도');
    return await _retryGuideWithSimplePrompt(scriptText);
  }
}

console.log('[완료] 학습 가이드 JSON 파싱 재시도 로직');

// ─── Firestore studyGuide 저장/로드 ───────────────────────────────────────
async function _saveGuideToFirestore(scriptId, langCode, guide) {
  if (!_db) return;
  try {
    await _db.collection(JACA_DB.scripts).doc(scriptId).collection('studyGuide').doc(langCode).set(guide);
  } catch (e) { console.warn('[가이드 저장 실패]', e.message); }
}

// 전용 저장공간에 가이드가 없으면 기존 공용 저장공간의 가이드를 읽기만 함
async function _getGuideSnap(scriptId, langCode) {
  const own = await _db.collection(JACA_DB.scripts).doc(scriptId).collection('studyGuide').doc(langCode).get();
  if (own.exists) return own;
  return _db.collection(SHARED_DB.scripts).doc(scriptId).collection('studyGuide').doc(langCode).get();
}

async function _loadGuideFromFirestore(scriptId, langCode) {
  if (!_db) return null;
  try {
    const snap = await _getGuideSnap(scriptId, langCode);
    return snap.exists ? snap.data() : null;
  } catch (e) { console.warn('[가이드 로드 실패]', e.message); return null; }
}

// ─── 끊어읽기 텍스트 기호 변환 ────────────────────────────────────────────
// 신형: ∙(반박자→초록) /(한박자→파랑)  구형: ,(반박자) |(한박자) 호환
function _colorizeBreakText(text) {
  // 주의: 기호 치환을 먼저 끝낸 뒤 독음을 붙인다.
  // 순서가 바뀌면 </ruby>·</rt> 의 '/' 가 한박자 기호로 오인되어 마크업이 깨진다.
  const marked = escHtml(String(text || '')).replace(/,\(반박자\)|\|\(한박자\)|∙|\/|,|\|/g, m => {
    if (m === ',(반박자)') return '<span class="sg-bp-short">∙<small>(반박자)</small></span>';
    if (m === '|(한박자)') return '<span class="sg-bp-long">/<small>(한박자)</small></span>';
    if (m === '∙')         return '<span class="sg-bp-short">∙</span>';
    if (m === '/')         return '<span class="sg-bp-long">/</span>';
    if (m === ',')         return '<span class="sg-bp-short">∙</span>';
    if (m === '|')         return '<span class="sg-bp-long">/</span>';
    return m;
  });
  return _withReading(marked, state.selectedLang);
}

// ─── 억양 markedText 기호 착색 (↗→빨강, ↘→파랑, →→초록) ──────────────
function _colorizeIntonText(text) {
  const marked = escHtml(String(text || '')).replace(/↗|↘|→/g, m => {
    if (m === '↗') return '<sup class="sg-inton-arrow sg-inton-up">↗</sup>';
    if (m === '↘') return '<sup class="sg-inton-arrow sg-inton-down">↘</sup>';
    if (m === '→') return '<sup class="sg-inton-arrow sg-inton-flat">→</sup>';
    return m;
  });
  return _withReading(marked, state.selectedLang);
}

// ─── 끊어읽기 항목 렌더 ───────────────────────────────────────────────────
// 신형: { text, marks:[{position,type,reason}] }
// 구형: "방송문 — 설명" 문자열 (하위 호환)
function _renderBreakItem(b) {
  // 신형 object 포맷
  if (b && typeof b === 'object') {
    const scriptHtml = _colorizeBreakText(b.text || '');
    const marksHtml = (b.marks || []).map(m => {
      const badge = m.type === 'half'
        ? `<span class="sg-bp-short">∙ 반박자</span>`
        : `<span class="sg-bp-long">/ 한박자</span>`;
      return `<div class="break-guide-line">${badge} <strong>${_withReading(escHtml(m.position), state.selectedLang)}</strong> — ${escHtml(m.reason)}</div>`;
    }).join('');
    return `<div class="break-script-line">${scriptHtml}</div>${marksHtml}`;
  }
  // 구형 string 포맷
  const text = String(b || '');
  let scriptPart = text;
  let guidePart  = '';
  const sepIdx = text.indexOf(' — ');
  if (sepIdx !== -1) {
    scriptPart = text.slice(0, sepIdx).trim();
    guidePart  = text.slice(sepIdx + 3).trim();
  } else if (text.includes('\n')) {
    const parts = text.split('\n');
    scriptPart = parts[0].trim();
    guidePart  = parts.slice(1).join(' ').trim();
  }
  const scriptHtml = _colorizeBreakText(scriptPart);
  return guidePart
    ? `<div class="break-script-line">${scriptHtml}</div><div class="break-guide-line">💬 ${escHtml(guidePart)}</div>`
    : `<div class="break-script-line">${scriptHtml}</div>`;
}

console.log('[완료] 끊어읽기 기호 변환 및 레이아웃 분리');

// ─── 편집 모드 저장 처리 ───────────────────────────────────────────────────
async function _saveEditedGuide() {
  const s = state.currentScript;
  if (!s) return;
  const lang = state.selectedLang;
  const cacheKey = `${s.id}_${lang}`;
  const guide = _studyGuideCache[cacheKey];
  if (!guide) return;

  // summary
  const sumEl = document.querySelector('.sg-edit-summary');
  if (sumEl) guide.summary = sumEl.value.trim();
  // breakPoints (object 또는 string 모두 처리)
  const bpEls = document.querySelectorAll('.sg-edit-bp');
  if (bpEls.length) guide.breakPoints = Array.from(bpEls).map(t => {
    const val = t.value.trim();
    if (!val) return null;
    try { return JSON.parse(val); } catch (e) { return val; }
  }).filter(Boolean);
  // emphasisWords
  const ewEl = document.querySelector('.sg-edit-ew');
  if (ewEl) guide.emphasisWords = ewEl.value.split(',').map(w => w.trim()).filter(Boolean);
  // speedGuide
  const sgEl = document.querySelector('.sg-edit-speed');
  if (sgEl) guide.speedGuide = sgEl.value.trim();
  // intonationGuide
  const igEl = document.querySelector('.sg-edit-inton');
  if (igEl) guide.intonationGuide = igEl.value.trim();
  // intonationDetails
  document.querySelectorAll('.sg-edit-id-guide').forEach((el, i) => {
    if (guide.intonationDetails?.[i]) guide.intonationDetails[i].guide = el.value.trim();
  });
  // tips
  const tipEls = document.querySelectorAll('.sg-edit-tip');
  if (tipEls.length) guide.tips = Array.from(tipEls).map(t => t.value.trim()).filter(Boolean);

  _studyGuideCache[cacheKey] = guide;
  await _saveGuideToFirestore(s.id, lang, guide);
  _renderStudyGuide(guide);
  showToast('저장 완료');
}

// ─── 가이드 렌더링 ─────────────────────────────────────────────────────────
function _renderStudyGuide(guide) {
  const el = $('study-guide-result');
  const esc = s => escHtml(String(s || ''));
  // 원어(일본어/중국어) 구간용 — 독음/병음 루비 부착
  const escR = s => _withReading(escHtml(String(s || '')), state.selectedLang);
  const admin = isEditUnlocked();

  const editBtn = (sectionId) => admin
    ? `<button class="sg-edit-btn" data-section="${sectionId}" onclick="_sgToggleEdit('${sectionId}')">✏️</button>`
    : '';

  // [2] 끊어읽기 — , | 색상 구분 + 범례
  const breakPointsHtml = (guide.breakPoints?.length)
    ? `<div class="sg-section" id="sg-sec-break">
        <div class="sg-section-header">
          <span class="sg-section-title">끊어읽기 포인트</span>${editBtn('break')}
        </div>
        <div class="sg-bp-legend">
          <span><span class="sg-bp-short">∙</span> 반박자 — 짧게 쉬기 (0.3초)</span>
          <span><span class="sg-bp-long">/</span> 한박자 — 충분히 쉬기 (0.7초)</span>
        </div>
        <div id="sg-body-break">
          ${guide.breakPoints.map(b => `<div class="sg-break-item">${_renderBreakItem(b)}</div>`).join('')}
        </div>
       </div>` : '';

  const emphasisHtml = (guide.emphasisWords?.length)
    ? `<div class="sg-section" id="sg-sec-emphasis">
        <div class="sg-section-header">
          <span class="sg-section-title">강조 단어</span>${editBtn('emphasis')}
        </div>
        <div id="sg-body-emphasis" class="sg-emphasis-wrap">${guide.emphasisWords.map(w => `<span class="sg-emphasis-badge">${escR(w)}</span>`).join('')}</div>
        ${Array.isArray(guide.emphasisTechniques) && guide.emphasisTechniques.length ? `
        <div class="sg-tech-wrap">
          ${guide.emphasisTechniques.map(t => {
            const meta = { slow:  ['🐢', '천천히', 'tech-slow'],
                           tone:  ['🎚', '톤 조절', 'tech-tone'],
                           clear: ['🔎', '또렷하게', 'tech-clear'],
                           pause: ['⏸', '쉼', 'tech-pause'] }[t.how] || ['•', '강조', 'tech-clear'];
            return `<div class="sg-tech-line">
              <span class="sg-tech-badge ${meta[2]}">${meta[0]} ${meta[1]}</span>
              <span class="sg-tech-phrase">${escR(t.phrase || '')}</span>
              <span class="sg-tech-guide">${esc(t.guide || '')}</span>
            </div>`;
          }).join('')}
        </div>` : ''}
       </div>` : '';

  // [3] 억양 — markedText+segments(신형) 또는 phrase+guide(구형) 렌더
  const _dirSymbol = { up: '↗', down: '↘', flat: '→' };
  const intonDetailHtml = (guide.intonationDetails?.length)
    ? guide.intonationDetails.map((d) => {
        const dir = d.direction || 'flat';
        const sym = d.symbol || _dirSymbol[dir] || '→';

        // 신형: markedText (↗↘→ 기호 포함 텍스트)
        const textRow = d.markedText
          ? `<div class="sg-inton-marked-text">${_colorizeIntonText(d.markedText)}</div>`
          : `<div class="sg-inton-detail-top">
               <span class="sg-inton-symbol sg-inton-${dir}">${esc(sym)}</span>
               <span class="sg-inton-phrase">${escR(d.phrase || '')}</span>
             </div>`;

        // 신형: segments 구간별 설명
        const segmentsHtml = d.segments?.length
          ? `<div class="sg-inton-segments">${d.segments.map(seg => {
              const sd = seg.direction || 'flat';
              const sa = _dirSymbol[sd] || '→';
              return `<div class="sg-inton-segment">
                <span class="sg-inton-symbol sg-inton-${sd}">${sa}</span>
                <div class="sg-inton-seg-content">
                  <span class="sg-inton-phrase">${escR(seg.text || '')}</span>
                  <span class="sg-inton-guide">${esc(seg.reason || '')}</span>
                </div>
              </div>`;
            }).join('')}</div>`
          : (d.guide ? `<span class="sg-inton-guide">${esc(d.guide)}</span>` : '');

        // segments + guide 둘 다 있으면 guide는 전체 요약으로
        const overallGuide = d.segments?.length && d.guide
          ? `<div class="sg-inton-overall-guide">💬 ${esc(d.guide)}</div>`
          : '';

        return `<div class="sg-inton-detail">${textRow}${segmentsHtml}${overallGuide}</div>`;
      }).join('') : '';
  console.log('[완료] 억양 표시 색상 및 레이아웃 강화');

  const speedIntonHtml = (guide.speedGuide || guide.intonationGuide || guide.intonationDetails?.length)
    ? `<div class="sg-section" id="sg-sec-inton">
        <div class="sg-section-header">
          <span class="sg-section-title">속도 & 억양</span>${editBtn('inton')}
        </div>
        <div id="sg-body-inton">
          ${guide.speedGuide ? `<div class="sg-speed-row">🐢 속도: ${esc(guide.speedGuide)}</div>` : ''}
          ${guide.intonationGuide ? `<div class="sg-intonation-row">↗↘ 억양 개요: ${esc(guide.intonationGuide)}</div>` : ''}
          ${intonDetailHtml ? `<div class="sg-inton-details">${intonDetailHtml}</div>` : ''}
        </div>
       </div>` : '';

  const tipsHtml = (guide.tips?.length)
    ? `<div class="sg-section" id="sg-sec-tips">
        <div class="sg-section-header">
          <span class="sg-section-title">실전 팁</span>${editBtn('tips')}
        </div>
        <div id="sg-body-tips">
          ${guide.tips.map(t => `<div class="sg-tip-item">💡 ${esc(t)}</div>`).join('')}
        </div>
       </div>` : '';

  const saveBtn = admin
    ? `<button class="btn-primary sg-save-btn hidden" id="sg-save-btn" onclick="_saveEditedGuide()">💾 저장</button>` : '';

  el.innerHTML = `
    ${guide.summary ? `<div class="sg-summary-card" id="sg-sec-summary">
      <div class="sg-section-header" style="margin-bottom:4px">
        <span></span>${editBtn('summary')}
      </div>
      <div id="sg-body-summary">${esc(guide.summary)}</div>
    </div>` : ''}
    ${breakPointsHtml}
    ${emphasisHtml}
    ${speedIntonHtml}
    ${tipsHtml}
    ${saveBtn}
  `;
  el.classList.remove('hidden');

  // 마스터 방송문 카드 갱신
  const _ms = state.currentScript;
  if (_ms) _renderMasterScript(_ms, state.selectedLang, guide);
}

// ─── 마스터 방송문 합성 (ko/en) ───────────────────────────────────────────
// 핵심 원칙: replace(/\//g) 가 이미 삽입된 </b>, </span> 안의 / 를 건드리지 않도록
// ⟦word⟧ → @@PH0@@ 플레이스홀더로 격리 → / 치환 먼저 → PH 복원(마지막)
function buildMasterScript(scriptText, guideData, langCode) {
  if (langCode === 'ja' && typeof buildScriptYomiMap === 'function') {
    try { buildScriptYomiMap(scriptText); } catch {}
  }
  let text = _showReading ? _stripYomiLines(String(scriptText || ''), langCode) : String(scriptText || '');

  // 1단계: Firestore 데이터 HTML 태그 제거 후 기호 삽입 (순수 텍스트 유지)
  (guideData.breakPoints || []).forEach(bp => {
    if (typeof bp !== 'object' || !bp.text) return;
    const marked = bp.text.replace(/<[^>]*>/g, '');
    const clean  = marked.replace(/[∙\/,|]/g, '').replace(/\s{2,}/g, ' ').trim();
    if (clean && text.includes(clean)) text = text.replace(clean, marked);
  });

  (guideData.intonationDetails || []).forEach(item => {
    if (!item.markedText || !item.phrase) return;
    const markedClean = item.markedText.replace(/<[^>]*>/g, '');
    if (text.includes(item.phrase)) text = text.replace(item.phrase, markedClean);
  });

  // 2단계: 강조 단어를 충돌 없는 유니코드 마커로 표시
  (guideData.emphasisWords || []).filter(Boolean).forEach(word => {
    if (!text.includes(word)) return;
    const re = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(re, 'g'), `⟦${word}⟧`);
  });

  // 3단계: 줄 단위 변환
  const htmlLines = text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return '<div style="height:8px"></div>';

    // 섹션 태그 처리
    const soloTag = t.match(/^\[([^\]]+)\]$/);
    const tagLine  = !soloTag && t.match(/^\[([^\]]+)\]\s+(.*)/);
    if (soloTag) {
      const safe = soloTag[1].replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<div style="display:inline-block;font-size:12px;font-weight:700;color:#6E6E73;background:#F2F2F7;border-radius:5px;padding:2px 8px;margin:6px 0 2px">${safe}</div>`;
    }

    const prefixLabel = tagLine ? tagLine[1] : null;
    const content     = tagLine ? tagLine[2] : t;

    // HTML 이스케이프 (한 번만, 가장 먼저)
    let escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // 강조 단어 → 플레이스홀더 (/ 치환으로부터 <b>...</b> 보호)
    const placeholders = [];
    escaped = escaped.replace(/⟦([^⟧]+)⟧/g, (_, word) => {
      const idx = placeholders.length;
      placeholders.push(`<b style="color:#FF6B00;font-weight:700;">${word}</b>`);
      return `@@PH${idx}@@`;
    });

    // 기호 → HTML 변환 — / 를 반드시 최우선 처리
    // (이후 생성되는 </span> 의 / 는 더 이상 replace 대상이 아님)
    escaped = escaped
      .replace(/\//g,  '<span style="color:#3B82F6;font-weight:800;">/</span>')
      .replace(/∙/g,   '<span style="color:#22C55E;font-weight:800;">∙</span>')
      .replace(/↗/g,   '<span style="color:#EF4444;font-weight:700;">↗</span>')
      .replace(/↘/g,   '<span style="color:#3B82F6;font-weight:700;">↘</span>')
      .replace(/→/g,   '<span style="color:#22C55E;font-weight:700;">→</span>');

    // 플레이스홀더 복원 (마지막 — 이 시점엔 / 치환이 완료된 후)
    escaped = escaped.replace(/@@PH(\d+)@@/g, (_, i) => placeholders[+i]);

    const prefix = prefixLabel
      ? `<span style="font-size:11px;font-weight:700;color:#6E6E73;background:#F2F2F7;border-radius:4px;padding:1px 5px;margin-right:5px">[${prefixLabel.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}]</span>`
      : '';

    return `<p style="margin:0 0 10px 0;line-height:2.0;">${prefix}${_withReading(escaped, langCode)}</p>`;
  });

  const result = htmlLines.join('');
  console.log('[마스터방송문] 결과 미리보기:', result.substring(0, 200));
  return result;
}

// ─── 마스터 방송문 카드 렌더링 ────────────────────────────────────────────
function _renderMasterScript(script, langCode, guide) {
  const el = $('study-script-text');
  if (!el) return;
  const lang = script.langs[langCode];
  if (!lang?.text) return;

  // 마스터(annotated) HTML
  const masterHtml = buildMasterScript(lang.text, guide, langCode);

  // 원본(toggle) HTML
  const tmpO = document.createElement('div');
  renderScriptText(script, langCode, tmpO);
  const origHtml = tmpO.innerHTML;

  const subtitle = '<div class="master-script-subtitle">끊어읽기 · 억양 · 강조가 표시됩니다</div>';
  const legend = `
    <div class="master-script-legend">
      <span><b style="color:#22C55E;">∙</b> 반박자</span>
      <span><b style="color:#3B82F6;">/</b> 한박자</span>
      <span><b style="color:#EF4444;">↗</b> 올림</span>
      <span><b style="color:#3B82F6;">↘</b> 내림</span>
      <span><b style="color:#22C55E;">→</b> 평탄</span>
      <span><b style="color:#FF6B00;">단어</b> 강조</span>
    </div>`;

  el.innerHTML = `
    <div class="master-script-card" id="master-script-card">
      <div class="master-script-header">
        <span class="master-script-title">🗒️ 핵심 포인트 통합 방송문</span>
        <button class="master-toggle-btn" id="btn-master-toggle" onclick="toggleMasterView()">🔄 원본 보기</button>
      </div>
      ${subtitle}
      <div id="master-script-body" class="master-script-body">${masterHtml}</div>
      <div id="master-script-original" class="master-script-body hidden">${origHtml}</div>
      ${legend}
    </div>`;
  // 라벨("📄 방송문") 숨김 — 카드 자체 타이틀이 대신함
  const _lbl = document.querySelector('.study-script-label');
  if (_lbl) _lbl.style.display = 'none';
  console.log('[완료] 마스터방송문');
}

// 마스터 방송문 / 원본 토글
function toggleMasterView() {
  const body = $('master-script-body');
  const orig = $('master-script-original');
  const btn  = $('btn-master-toggle');
  if (!body || !orig || !btn) return;
  const showingMaster = !body.classList.contains('hidden');
  body.classList.toggle('hidden');
  orig.classList.toggle('hidden');
  btn.textContent = showingMaster ? '🗒️ 마스터 보기' : '🔄 원본 보기';
}

// ─── 관리자 인라인 편집 토글 ──────────────────────────────────────────────
function _sgToggleEdit(section) {
  const cacheKey = `${state.currentScript?.id}_${state.selectedLang}`;
  const guide = _studyGuideCache[cacheKey];
  if (!guide) return;
  const esc = s => escHtml(String(s || ''));
  const body = $(`sg-body-${section}`);
  if (!body) return;

  if (body.querySelector('textarea, input')) {
    // 이미 편집 중 → 보기 모드로 되돌리기
    _renderStudyGuide(guide);
    return;
  }

  let html = '';
  if (section === 'break') {
    html = (guide.breakPoints || []).map(b => {
      const val = (b && typeof b === 'object') ? JSON.stringify(b, null, 2) : String(b || '');
      return `<textarea class="sg-edit-bp sg-edit-area">${esc(val)}</textarea>`;
    }).join('');
  } else if (section === 'emphasis') {
    html = `<input class="sg-edit-ew sg-edit-input" value="${esc((guide.emphasisWords || []).join(', '))}">
            <div class="sg-edit-hint">쉼표(,)로 구분</div>`;
  } else if (section === 'inton') {
    html = `${guide.speedGuide !== undefined ? `<div class="sg-edit-label">속도</div><textarea class="sg-edit-speed sg-edit-area">${esc(guide.speedGuide)}</textarea>` : ''}
            ${guide.intonationGuide !== undefined ? `<div class="sg-edit-label">억양 개요</div><textarea class="sg-edit-inton sg-edit-area">${esc(guide.intonationGuide)}</textarea>` : ''}
            ${(guide.intonationDetails || []).map((d, i) =>
              `<div class="sg-edit-label">${esc(d.symbol || '')} ${esc(d.markedText || d.phrase || '')}</div>
               <textarea class="sg-edit-id-guide sg-edit-area" data-idx="${i}">${esc(d.guide || '')}</textarea>`
            ).join('')}`;
  } else if (section === 'tips') {
    html = (guide.tips || []).map(t =>
      `<textarea class="sg-edit-tip sg-edit-area">${esc(t)}</textarea>`).join('');
  } else if (section === 'summary') {
    html = `<textarea class="sg-edit-summary sg-edit-area">${esc(guide.summary)}</textarea>`;
  }

  body.innerHTML = html;
  const saveBtn = $('sg-save-btn');
  if (saveBtn) saveBtn.classList.remove('hidden');
}

// ===== DRILL MODE =====
// _prepSetMvState 제거됨 — 공통 플레이어(createModelVoicePlayer)가 상태 관리
let _currentModelAudio = null;
let _drill = { sentences: [], idx: 0, myBlob: null, myAudioUrl: null, modelAudio: null, mr: null, stream: null, chunks: [], recording: false };

// 드릴 모드 녹음 상태 완전 초기화 — 문장 전환, 드릴 진입/종료, 뒤로가기에서 공통 호출
// 진행 중이던 MediaRecorder/MediaStream을 확실히 정리해 스트림 누수를 막는다
function _resetDrillRecordingState() {
  if (_drill.mr) {
    // 이미 떠난 녹음의 onstop이 나중에 늦게 발동해 화면을 오염시키지 않도록 콜백 해제
    _drill.mr.onstop = null;
    _drill.mr.ondataavailable = null;
    if (_drill.mr.state !== 'inactive') _drill.mr.stop();
  }
  stopMicStream(_drill.stream);
  _drill.stream = null;
  _drill.mr = null;
  _drill.chunks = [];
  _drill.recording = false;

  const recBtn = $('btn-drill-record');
  if (recBtn) {
    recBtn.disabled = false;
    recBtn.textContent = '🎤 따라읽기 시작';
    recBtn.onclick = _drillStartRec;
  }
}

async function startDrillMode() {
  const s = state.currentScript;
  const lang = s?.langs[state.selectedLang];
  if (!lang) return;
  const url = await _resolveModelVoiceUrl(s.id, state.selectedLang);
  if (!url) { showToast('모델 음성이 없습니다. 학습 모드를 먼저 확인해주세요.', 3000); return; }
  const sentences = splitSentences(lang.text).filter(s => s.length > 2);
  if (!sentences.length) { showToast('방송문이 없습니다'); return; }
  _resetDrillRecordingState(); // 이전 드릴 세션의 녹음이 남아있다면 완전 정리
  _drill = { sentences, idx: 0, myBlob: null, myAudioUrl: null, modelAudio: null, mr: null, stream: null, chunks: [], recording: false };
  showScreen('screen-drill');
  _drillRender();
}

function _drillRender() {
  _resetDrillRecordingState();
  const { sentences, idx } = _drill;
  $('drill-progress-text').textContent = `${idx + 1} / ${sentences.length}`;
  $('drill-progress-fill').style.width = `${((idx + 1) / sentences.length) * 100}%`;
  $('drill-sentence-box').textContent = sentences[idx];
  $('drill-actions').classList.remove('hidden');
  $('drill-compare').classList.add('hidden');
  $('drill-complete').classList.add('hidden');
  // [2] 같은 방송문 내 문장 전환 시 audio 객체 유지 — URL 동일하므로 재사용
  // (새 URL이면 doPlay 첫 호출 시 createModelVoicePlayer 내부에서 자동 교체됨)
  if (_currentModelAudio) { _currentModelAudio.pause(); }
  createModelVoicePlayer('drill-model-player');
  console.log(`[드릴모드] 문장 ${idx + 1}/${sentences.length} 시작`);
}

async function _drillStartRec() {
  // 동기 작업 먼저 (await 없으므로 제스처 컨텍스트 유지)
  if (_currentModelAudio) { _currentModelAudio.pause(); }
  const mvpPlay = $('drill-model-player-play');
  if (mvpPlay) { mvpPlay.textContent = '▶ 재생'; }

  const recBtn = $('btn-drill-record');
  if (recBtn) recBtn.disabled = true; // 처리 중 중복 클릭 방지

  // 이전 녹음 잔여 상태 완전 정리 (백그라운드 복귀 시 stale 참조 및 스트림 누수 방지)
  _resetDrillRecordingState();

  // iOS PWA: getUserMedia는 반드시 첫 번째 await로 — 이 위치가 안전
  const isPWA = window.matchMedia('(display-mode: standalone)').matches
                || window.navigator.standalone === true;
  let stream;
  try {
    _drill.chunks = [];
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _drill.stream = stream;
    // 드릴 모드만 단독으로 사용해도 resumeAudioContext()가 동작하도록 공유 AudioContext 확보
    const ctx = _ensureAudioContext();
    await _resumeCtxWithTimeout(ctx);
    const _drillRecOpts = _getSupportedMimeType();
    console.log('[드릴녹음] mimeType:', _drillRecOpts.mimeType || '기본값');
    const mr = new MediaRecorder(stream, _drillRecOpts);
    _drill.mr = mr;
    mr.ondataavailable = e => { if (e.data.size > 0) _drill.chunks.push(e.data); };
    mr.onstop = async () => {
      _drill.stopHandled = true; // 워치독 타이머에게 "정상 처리됨"을 알림
      // Blob 생성이 끝난 뒤에만 마이크를 해제한다 — 조기 해제 시 마지막 데이터가 유실됨
      _drill.myBlob = new Blob(_drill.chunks, { type: mr.mimeType || 'audio/mp4' });
      if (_drill.myAudioUrl) URL.revokeObjectURL(_drill.myAudioUrl);
      _drill.myAudioUrl = URL.createObjectURL(_drill.myBlob);

      stopMicStream(_drill.stream);
      _drill.stream = null;
      await _releaseAudioSession(); // iOS 오디오 세션 전환 대기 후 복원

      // [1] 비교 화면은 0:00부터 새로 듣기 — currentTime만 초기화, 객체·src 유지
      if (_currentModelAudio) { _currentModelAudio.currentTime = 0; }
      $('drill-actions').classList.add('hidden');
      $('drill-compare').classList.remove('hidden');
      createModelVoicePlayer('drill-compare-player', { noGender: true });
      console.log(`[드릴모드] 문장 ${_drill.idx + 1} 녹음 완료`);
    };
    mr.start();
    _drill.recording = true;
    if (recBtn) {
      recBtn.disabled = false;
      recBtn.textContent = '⏹ 녹음 중지';
      recBtn.onclick = _drillStopRec;
    }
  } catch (e) {
    if (recBtn) recBtn.disabled = false;
    console.error('[마이크] 드릴 권한 오류:', e.name, e.message, '| PWA:', isPWA);
    alert(`마이크 접근 권한이 필요합니다.\n오류: ${e.name}`);
  }
}

function _drillStopRec() {
  if (!_drill.mr || _drill.mr.state === 'inactive') return;
  const recBtn = $('btn-drill-record');
  if (recBtn) { recBtn.disabled = true; recBtn.textContent = '⏳ 처리 중...'; }
  _drill.recording = false;
  _drill.stopHandled = false;
  _drill.mr.stop(); // 스트림 정리·오디오 세션 복원·화면 전환은 onstop에서 일괄 처리

  // 워치독: onstop 이벤트가 어떤 이유로든(브라우저 버그 등) 6초 내에 안 불리면
  // "처리 중..."에 무한정 멈춰있지 않도록 강제로 복구하고 재시도를 안내한다.
  setTimeout(() => {
    if (_drill.stopHandled) return; // 이미 정상 처리됨 — 아무것도 안 함
    console.warn('[드릴모드] onstop 미발생 — 워치독으로 강제 복구');
    stopMicStream(_drill.stream);
    _drill.stream = null;
    if (recBtn) { recBtn.disabled = false; recBtn.textContent = '🎤 따라읽기 시작'; recBtn.onclick = _drillStartRec; }
    showToast('녹음 처리가 지연되었습니다. 다시 시도해 주세요.', 3000);
  }, 6000);
}

function _drillNext() {
  if (_drill.myAudioUrl) { URL.revokeObjectURL(_drill.myAudioUrl); _drill.myAudioUrl = null; }
  _drill.myBlob = null;
  _drill.idx++;
  if (_drill.idx >= _drill.sentences.length) {
    $('drill-actions').classList.add('hidden');
    $('drill-compare').classList.add('hidden');
    $('drill-complete').classList.remove('hidden');
    console.log('[드릴모드] 드릴 완료!');
  } else {
    _drillRender();
  }
}

// ===== LOADING OVERLAY =====
const _LOADING_STEPS = [
  { from: 0,  msg: '🎤 음성을 업로드하고 있습니다...' },
  { from: 3,  msg: '🔍 발음과 억양을 분석하고 있습니다...' },
  { from: 6,  msg: '📊 채점 기준에 맞게 평가하고 있습니다...' },
  { from: 10, msg: '📝 맞춤 피드백을 작성하고 있습니다...' },
];
const _LOADING_TIPS = [
  '끊어읽기는 승객의 이해도를 높이는 핵심 기술입니다',
  '미소 띤 목소리는 승객에게 편안함을 줍니다',
  '문장 끝을 내려읽으면 더 안정적으로 들립니다',
  '강조할 단어 앞에서 살짝 멈춰보세요',
  '천천히 읽는 것이 빠르게 읽는 것보다 전달력이 높습니다',
];
let _overlayTimers = [];
let _overlayTipIdx = 0;
let _overlayStepStart = 0;

function _startOverlayTimers() {
  _overlayTimers.forEach(clearTimeout);
  _overlayTimers = [];
  _overlayTipIdx = 0;
  _overlayStepStart = Date.now();

  // 단계별 메시지
  _LOADING_STEPS.forEach(step => {
    const t = setTimeout(() => {
      const el = $('loading-step-msg');
      if (el) el.textContent = step.msg;
    }, step.from * 1000);
    _overlayTimers.push(t);
  });

  // 팁 순환 (3.8초마다)
  const cycleTip = () => {
    const el = $('loading-tip-text');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => {
      _overlayTipIdx = (_overlayTipIdx + 1) % _LOADING_TIPS.length;
      el.textContent = _LOADING_TIPS[_overlayTipIdx];
      el.style.opacity = '1';
    }, 300);
    _overlayTimers.push(setTimeout(cycleTip, 3800));
  };
  _overlayTimers.push(setTimeout(cycleTip, 3800));

  // 진행바 애니메이션 재시작
  const bar = $('loading-progress-bar');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '0%';
    requestAnimationFrame(() => {
      bar.style.transition = 'width 12s ease-out';
      bar.style.width = '85%';
    });
  }
}

function _completeOverlay() {
  _overlayTimers.forEach(clearTimeout);
  _overlayTimers = [];
  const bar = $('loading-progress-bar');
  if (bar) { bar.style.transition = 'width 0.3s ease'; bar.style.width = '100%'; }
  setTimeout(() => {
    const overlay = $('loading-overlay');
    if (!overlay) return;
    overlay.style.transition = 'opacity 0.35s';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.style.opacity = '';
      overlay.style.transition = '';
    }, 350);
  }, 300);
  console.log('[완료] 분석 오버레이 종료');
}

// ===== RESULT MODEL VOICE COMPARISON =====
let _lastRecordingBlob = null;
let _lastRecordingUrl  = null;
let _aiAnalysisRetryCount = 0;  // 재분석 시도 횟수 (최대 2회)
let _cmp = { active: false, audio: null, timeout: null, myUrl: null };
let _rvcModelAudio = null;   // 결과 화면 모델 음성 Audio 객체
let _rvcMyAudio    = null;   // 결과 화면 내 녹음 Audio 객체
let _rvcGender     = 'M';    // 결과 화면 모델 음성 성별 (M/F)

function _rvcFmt(s) { const m = Math.floor(s/60); return `${m}:${String(Math.floor(s%60)).padStart(2,'0')}`; }

function _rvcAttachScrub(audio, scrubId, timeId, btnId) {
  const scrub = $(scrubId), timeEl = $(timeId), btn = $(btnId);
  if (!scrub || !timeEl || !btn) return;
  scrub.disabled = false;
  audio.ontimeupdate = () => {
    const dur = audio.duration || 0, cur = audio.currentTime || 0;
    if (dur > 0) { scrub.max = dur; scrub.value = cur; }
    timeEl.textContent = `${_rvcFmt(cur)} / ${_rvcFmt(dur)}`;
  };
  audio.onended = () => {
    btn.textContent = '▶ 재생';
    scrub.value = 0; timeEl.textContent = `0:00 / ${_rvcFmt(audio.duration || 0)}`;
  };
  scrub.oninput = () => { if (!audio.paused || audio.readyState >= 2) audio.currentTime = parseFloat(scrub.value); };
}

function _cmpStop() {
  _cmp.active = false;
  _cmp.audio?.pause(); _cmp.audio = null;
  clearTimeout(_cmp.timeout); _cmp.timeout = null;
  if (_cmp.myUrl) { URL.revokeObjectURL(_cmp.myUrl); _cmp.myUrl = null; }
  const statusEl = $('compare-status-text');
  if (statusEl) { statusEl.classList.add('hidden'); statusEl.textContent = ''; }
  $('btn-compare-stop')?.classList.add('hidden');
  $('btn-compare-voice')?.classList.remove('hidden');
}

function stopModelComparison() { _cmpStop(); }

async function _rvcSetGender(g) {
  if (_rvcGender === g) return;
  _rvcGender = g;
  $('rvc-gender-m')?.classList.toggle('active', g === 'M');
  $('rvc-gender-f')?.classList.toggle('active', g === 'F');
  // 재생 중인 모델 음성 초기화
  if (_rvcModelAudio) { _rvcModelAudio.pause(); _rvcModelAudio = null; }
  const btn = $('btn-play-model'); if (btn) btn.textContent = '▶ 재생';
  const scrub = $('rvc-model-scrub'); if (scrub) { scrub.value = 0; scrub.disabled = true; }
  const timeEl = $('rvc-model-time'); if (timeEl) timeEl.textContent = '0:00 / 0:00';
}

async function playModelVoice() {
  _cmpStop();
  const btn = $('btn-play-model');
  // 토글
  if (_rvcModelAudio && !_rvcModelAudio.paused) {
    _rvcModelAudio.pause(); if (btn) btn.textContent = '▶ 재생'; return;
  }
  if (_rvcModelAudio && _rvcModelAudio.paused) {
    await resumeAudioContext();
    _rvcModelAudio.play().catch(()=>{}); if (btn) btn.textContent = '⏸ 일시정지'; return;
  }
  const s = state.currentScript;
  if (!s) return;
  // 캐시 미스 시 await 전에 먼저 unlock (문안별 재생 플레이어와 동일한 안전 패턴)
  const _unlocked = _createUnlockedAudio();
  const url = await _resolveModelVoiceUrl(s.id, state.selectedLang, _rvcGender);
  if (!url) { showToast('모델 음성 없음'); return; }
  if (_rvcModelAudio) { _rvcModelAudio.pause(); }
  _rvcModelAudio = _unlocked;
  let _playOk = true;
  try {
    await _playUnlockedAudio(_rvcModelAudio, url);
  } catch (e) {
    _playOk = false;
    console.warn('[모델음성 비교] unlock 재생 실패:', e.name);
    showToast('재생 버튼을 다시 눌러주세요.', 2500);
  }
  if (btn) btn.textContent = _playOk ? '⏸ 일시정지' : '▶ 재생';
  _rvcAttachScrub(_rvcModelAudio, 'rvc-model-scrub', 'rvc-model-time', 'btn-play-model');
  console.log('[완료] 모델 음성 재생');
}

async function playMyRecording() {
  _cmpStop();
  const btn = $('btn-play-my');
  // 토글
  if (_rvcMyAudio && !_rvcMyAudio.paused) {
    _rvcMyAudio.pause(); if (btn) btn.textContent = '▶ 재생'; return;
  }
  if (_rvcMyAudio && _rvcMyAudio.paused) {
    await resumeAudioContext();
    _rvcMyAudio.play().catch(()=>{}); if (btn) btn.textContent = '⏸ 일시정지'; return;
  }
  if (!_lastRecordingUrl) { showToast('녹음 파일 없음'); return; }
  _rvcMyAudio = new Audio(_lastRecordingUrl);
  _rvcMyAudio.setAttribute('playsinline', '');
  if (btn) btn.textContent = '⏸ 일시정지';
  _rvcAttachScrub(_rvcMyAudio, 'rvc-my-scrub', 'rvc-my-time', 'btn-play-my');
  _rvcMyAudio.onended = () => { if (btn) btn.textContent = '▶ 재생'; };
  await resumeAudioContext();
  _rvcMyAudio.play().catch(e => {
    console.error('[내음성] 재생 오류:', e);
    showToast('재생 실패. 브라우저 설정을 확인해주세요.', 'error');
  });
  console.log('[완료] 내 녹음 재생');
}

async function startModelComparison() {
  const s = state.currentScript;
  if (!s) return;
  const url = await _resolveModelVoiceUrl(s.id, state.selectedLang);
  if (!url) { showToast('모델 음성 없음'); return; }
  if (!_lastRecordingBlob) { showToast('내 녹음이 없습니다'); return; }
  _cmpStop();
  _cmp.active = true;
  $('compare-status-text').classList.remove('hidden');
  $('btn-compare-stop').classList.remove('hidden');
  $('btn-compare-voice').classList.add('hidden');
  console.log('[비교모드] 모델 vs 내 음성 비교 시작');
  await resumeAudioContext();
  _cmpCycle();
}

async function _cmpCycle() {
  if (!_cmp.active) return;
  const url = _getCachedModelVoiceUrl(state.currentScript.id, state.selectedLang)
    || _mvUrlCache[`${state.currentScript.id}_${state.selectedLang}_${_currentGender}`];
  $('compare-status-text').textContent = '🎵 모델 음성 재생 중...';
  await resumeAudioContext();
  const a = new Audio(url);
  _cmp.audio = a;
  a.play().catch(() => {});
  a.onended = () => {
    if (!_cmp.active) return;
    _cmp.timeout = setTimeout(async () => {
      if (!_cmp.active) return;
      $('compare-status-text').textContent = '🎤 내 녹음 재생 중...';
      await resumeAudioContext();
      const b = new Audio(_lastRecordingUrl);
      b.setAttribute('playsinline', '');
      _cmp.audio = b;
      b.play().catch(() => {});
      b.onended = () => {
        if (!_cmp.active) return;
        _cmp.timeout = setTimeout(_cmpCycle, 1000);
      };
    }, 1000);
  };
}

// ===== ANALYSIS =====
function analyzeAndShow(duration) {
  const s = state.currentScript;
  const lang = s.langs[state.selectedLang];
  const transcript = state.transcript.trim();
  const hasSpeech = transcript.length > 5;
  const hasAudio  = state.pitchSamples.length >= 8 && state.amplitudeSamples.length >= 10;

  // --- 내용 측정 (문안 일치) ---
  const wordMatch    = hasSpeech ? measureWordMatch(transcript, lang.text) : 0;
  const completeness = hasSpeech ? measureCompleteness(transcript, lang.keyPhrases) : 0;

  // ── 내용 일치율 게이트 (cG) ──────────────────────────────────────────────
  // 방송문과 얼마나 일치했는지를 0~1로 나타낸 값.
  // 이 값이 낮으면 음성 신호 기반 점수(강조·억양·발성 등)도 비례해서 낮아짐.
  // → "아~" 한 마디처럼 내용이 전혀 없을 때 음성 품질만으로 좋은 점수가 나오는
  //   오류를 방지한다.
  const contentQuality = Math.min(1, wordMatch * 0.55 + completeness * 0.45);
  const cGRaw = contentQuality >= 0.10 ? contentQuality : 0;
  // 목소리·억양 신호는 STT와 독립적으로 평가 → 최소 0.60 보장
  // (STT 부정확 → 목소리·억양 전체 0점 되는 연쇄 패널티 방지)
  const cG = hasAudio && cGRaw > 0 ? Math.max(0.60, cGRaw) : cGRaw;
  // ─────────────────────────────────────────────────────────────────────────

  // --- 음성 신호 측정 ---
  // 영어는 단어 수(WPM), 한·일·중은 음절 수(음절/분)
  const speedRaw = hasSpeech && duration > 3
    ? (state.selectedLang === 'en'
        ? transcript.split(' ').filter(Boolean).length
        : transcript.replace(/\s/g, '').length)
      / duration * 60
    : 0;
  const wpmRatio = speedRaw > 0
    ? Math.max(0, 1 - Math.abs(speedRaw - lang.idealSpeed) / lang.speedTolerance)
    : 0;
  const pitchCV    = hasAudio ? measurePitchCV(state.pitchSamples) : 0;
  const pitchRange = hasAudio ? measurePitchRange(state.pitchSamples) : 0;
  const ampStab    = hasAudio ? measureAmpStability(state.amplitudeSamples) : 0;
  const ampPeaks   = hasAudio ? measureAmpPeaks(state.amplitudeSamples) : 0;
  const meanPitch  = hasAudio ? state.pitchSamples.reduce((a,b)=>a+b,0)/state.pitchSamples.length : 0;
  const pauseRatio = state.pauseSamples.length > 0 ? state.pauseSamples.filter(v=>v===0).length / state.pauseSamples.length : 0;
  const naturalPause = pauseRatio >= 0.05 && pauseRatio <= 0.35 ? 1 - Math.abs(pauseRatio - 0.20) / 0.20 : 0;

  // 피치 대역 (150-300 Hz 여성, 100-200 Hz 남성)
  const pitchWarmth = meanPitch > 0
    ? (meanPitch >= 130 && meanPitch <= 320 ? Math.max(0, 1 - Math.abs(meanPitch - 225) / 95) : 0.1)
    : 0;

  // 억양 CV 정규화 (이상 CV: 0.05~0.20)
  const intonationCV = pitchCV > 0
    ? (pitchCV >= 0.05 && pitchCV <= 0.20
        ? 0.65 + (pitchCV - 0.05) / 0.15 * 0.35
        : pitchCV < 0.05 ? pitchCV / 0.05 * 0.65
        : Math.max(0.1, 1 - (pitchCV - 0.20) * 2.5))
    : 0;

  // ── cG 적용: 내용 일치율이 낮으면 음성 신호 지표도 낮아짐 ──────────────
  const gAmpPeaks    = ampPeaks    * cG;
  const gAmpStab     = ampStab     * (0.55 + 0.45 * cG); // 발성 안정성: 기본 55% 신호 반영
  const gPitchWarmth = pitchWarmth * cG;
  const gIntonCV     = intonationCV * cG;
  const gPitchRange  = pitchRange  * cG;
  // ─────────────────────────────────────────────────────────────────────────

  // ---- 언어별 항목 점수 산출 (CHECKLIST_BY_LANG의 items 순서와 1:1 대응) ----
  const _L = state.selectedLang === 'ca' ? 'ca' : 'ja';
  const _speak  = Math.min(1, wpmRatio * 0.3 + gIntonCV * 0.4 + gAmpStab * 0.3); // 말하는 듯한 연출
  const _pause  = Math.min(1, naturalPause * 0.5 + completeness * 0.5);          // 끊어읽기
  const _speed  = wpmRatio * (cG >= 0.3 ? 1 : cG / 0.3);                          // 속도
  const _memo   = completeness * 0.7 + wordMatch * 0.3;                           // 문안 숙지
  const _tone   = Math.min(1, gPitchWarmth * 0.5 + gAmpStab * 0.5);              // 톤
  const _warm   = Math.min(1, gPitchWarmth * 0.55 + gIntonCV * 0.25 + gAmpStab * 0.20); // 친근함
  const _even   = gIntonCV;                                                        // 고른 억양
  const _clear  = Math.min(1, wordMatch * 0.55 + completeness * 0.45);            // 명확성

  let fluencyItems, voiceItems, intonationItems, pronunciationItems;
  if (_L === 'ja') {
    // 유창성 25 / 분위기 25 / 억양 25 / 발음 25
    fluencyItems = [
      tierScore(_pause, 5), tierScore(_memo, 5), tierScore(_speed, 5), tierScore(_speak, 10)
    ];
    voiceItems = [
      tierScore(_tone, 10), tierScore(gAmpStab, 5), tierScore(_warm, 5), tierScore(gIntonCV, 5)
    ];
    intonationItems = [
      tierScore(gPitchRange, 10), tierScore(_even, 5),
      tierScore(Math.min(1, wpmRatio * 0.5 + gIntonCV * 0.5), 5),  // 장음 연출(속도·억양 대용)
      tierScore(Math.min(1, gIntonCV * 0.6 + wpmRatio * 0.4), 5)   // 어미·조사 처리
    ];
    pronunciationItems = [
      tierScore(Math.min(1, wpmRatio * 0.6 + wordMatch * 0.4), 5), // 장음
      tierScore(wordMatch, 5),                                      // 히라가나 발음
      tierScore(Math.min(1, naturalPause * 0.4 + wordMatch * 0.6), 5), // ん·촉음
      tierScore(_clear, 5),                                         // 모음
      tierScore(wordMatch, 5)                                       // 오발음
    ];
  } else {
    // 유창성 30 / 분위기 25 / 성조·억양 25 / 발음 20
    fluencyItems = [
      tierScore(_pause, 5), tierScore(_speak, 10), tierScore(gAmpPeaks, 5),
      tierScore(_speed, 5), tierScore(_memo, 5)
    ];
    voiceItems = [
      tierScore(_warm, 10), tierScore(gAmpStab, 5), tierScore(_tone, 10)
    ];
    intonationItems = [
      tierScore(gPitchRange, 5),                                    // 1성·4성
      tierScore(gIntonCV, 5),                                       // 2성·3성
      tierScore(Math.min(1, gIntonCV * 0.5 + gPitchRange * 0.5), 5),// 성조 변화규칙
      tierScore(Math.min(1, gPitchRange * 0.5 + gIntonCV * 0.5), 10)// 중국어다운 억양
    ];
    pronunciationItems = [
      tierScore(wordMatch, 5), tierScore(_clear, 5),
      tierScore(_clear, 5), tierScore(wordMatch, 5)
    ];
  }

  const total =
    fluencyItems.reduce((a,b)=>a+b,0) +
    voiceItems.reduce((a,b)=>a+b,0) +
    intonationItems.reduce((a,b)=>a+b,0) +
    pronunciationItems.reduce((a,b)=>a+b,0);

  const _CL = getChecklist(_L);
  const result = {
    total, pass: total >= PASS_SCORE, lang: _L,
    wpm: Math.round(speedRaw), speedUnit: lang.speedUnit, duration,
    wordMatch, completeness, contentQuality,
    categories: {
      fluency:       { score: fluencyItems.reduce((a,b)=>a+b,0),       max: _CL.fluency.max,       items: fluencyItems },
      voice:         { score: voiceItems.reduce((a,b)=>a+b,0),         max: _CL.voice.max,         items: voiceItems },
      intonation:    { score: intonationItems.reduce((a,b)=>a+b,0),    max: _CL.intonation.max,    items: intonationItems },
      pronunciation: { score: pronunciationItems.reduce((a,b)=>a+b,0), max: _CL.pronunciation.max, items: pronunciationItems }
    }
  };

  // 오버레이는 Gemini 완료 후 _completeOverlay()에서 제거
  showResults(result, transcript);
}

// ===== 측정 함수 (엄격) =====
function measureWordMatch(transcript, script) {
  const tW = normalize(transcript).split(' ').filter(Boolean);
  const sW = normalize(script).split(' ').filter(Boolean);
  if (!tW.length || !sW.length) return 0;
  let matches = 0; const used = new Set();
  for (const tw of tW) {
    for (let i = 0; i < sW.length; i++) {
      if (!used.has(i) && similarity(tw, sW[i]) > 0.72) { matches++; used.add(i); break; }
    }
  }
  const prec = matches / tW.length, rec = matches / sW.length;
  return prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0;
}

function measureCompleteness(transcript, keyPhrases) {
  const norm = normalize(transcript);
  let found = 0;
  for (const phrase of keyPhrases) {
    const np = normalize(phrase);
    if (norm.includes(np)) { found++; continue; }
    if (np.split(' ').some(w => w.length > 1 && norm.includes(w))) found += 0.6;
  }
  return Math.min(1, found / keyPhrases.length);
}

function measurePitchCV(samples) {
  if (samples.length < 8) return 0;
  const mean = samples.reduce((a,b)=>a+b,0) / samples.length;
  const variance = samples.reduce((a,b)=>a+(b-mean)**2,0) / samples.length;
  return mean > 0 ? Math.sqrt(variance) / mean : 0;
}

function measurePitchRange(samples) {
  if (samples.length < 8) return 0;
  const sorted = [...samples].sort((a,b)=>a-b);
  const p10 = sorted[Math.floor(samples.length*0.10)];
  const p90 = sorted[Math.floor(samples.length*0.90)];
  if (p10 === 0) return 0;
  const range = (p90 - p10) / p10;
  if (range >= 0.20 && range <= 0.80) return 0.65 + (range - 0.20) / 0.60 * 0.35;
  if (range < 0.20) return range / 0.20 * 0.65;
  return Math.max(0.1, 1 - (range - 0.80) * 0.6);
}

function measureAmpStability(samples) {
  if (samples.length < 10) return 0;
  const speaking = samples.filter(v => v > 0.018);
  if (speaking.length < 5) return 0;
  const mean = speaking.reduce((a,b)=>a+b,0) / speaking.length;
  if (mean === 0) return 0;
  const cv = Math.sqrt(speaking.reduce((a,b)=>a+(b-mean)**2,0)/speaking.length) / mean;
  return Math.max(0, Math.min(1, 1 - cv * 1.4));
}

function measureAmpPeaks(samples) {
  if (samples.length < 15) return 0;
  const mean = samples.reduce((a,b)=>a+b,0) / samples.length;
  if (mean < 0.005) return 0;
  const thresh = mean * 1.55;
  let peaks = 0;
  for (let i = 1; i < samples.length-1; i++) {
    if (samples[i] > thresh && samples[i] >= samples[i-1] && samples[i] >= samples[i+1]) peaks++;
  }
  const rate = peaks / (samples.length / 10);
  if (rate >= 0.4 && rate <= 2.2) return 0.65 + (rate / 2.2) * 0.35;
  if (rate < 0.4) return rate / 0.4 * 0.65;
  return Math.max(0.1, 1 - (rate - 2.2) * 0.2);
}

// ===== RESULTS =====
// eslint-disable-next-line no-unused-vars
function showResults(result, transcript) {
  showScreen('screen-result');
  // iOS 오디오 세션 복원 (녹음 직후 재생 볼륨 저하 방지)
  resumeAudioContext();
  stopModelComparison();
  // 결과 화면 진입 시 음성 객체 초기화
  if (_rvcModelAudio) { _rvcModelAudio.pause(); _rvcModelAudio = null; }
  if (_rvcMyAudio)    { _rvcMyAudio.pause();    _rvcMyAudio    = null; }
  const modelBtn = $('btn-play-model'); if (modelBtn) modelBtn.textContent = '▶ 재생';
  const myBtn    = $('btn-play-my');    if (myBtn)    myBtn.textContent    = '▶ 재생';
  // 성별 토글 초기화 (기본: 남)
  _rvcGender = 'M';
  $('rvc-gender-m')?.classList.add('active');
  $('rvc-gender-f')?.classList.remove('active');
  $('rvc-gender-m')?.removeAttribute('disabled');
  $('rvc-gender-f')?.removeAttribute('disabled');
  // 각 성별 가용성 확인 (비동기)
  const _rvcScript = state.currentScript;
  if (_rvcScript) {
    ['M', 'F'].forEach(async g => {
      const url = await _resolveModelVoiceUrl(_rvcScript.id, state.selectedLang, g);
      if (!url) $(`rvc-gender-${g === 'M' ? 'm' : 'f'}`)?.setAttribute('disabled', '');
    });
  }
  const mScrub   = $('rvc-model-scrub'); if (mScrub) { mScrub.value = 0; mScrub.disabled = true; }
  const yScrub   = $('rvc-my-scrub');   if (yScrub)  { yScrub.value = 0; yScrub.disabled = true; }
  const mTime    = $('rvc-model-time'); if (mTime)  mTime.textContent  = '0:00 / 0:00';
  const yTime    = $('rvc-my-time');    if (yTime)  yTime.textContent   = '0:00 / 0:00';

  const lang    = state.currentScript.langs[state.selectedLang];
  const isAdmin = isEditUnlocked();

  // (정식 배포: 소프트 페이월 블러 제거 — 바로 결과 확인 가능하도록)

  // 내 녹음 없으면 scrub 영역 메시지
  if (!_lastRecordingBlob) {
    const yTime2 = $('rvc-my-time'); if (yTime2) yTime2.textContent = '녹음 파일 없음';
  }

  renderTranscriptCompare(transcript, lang);

  // AI 상세 분석 섹션 — 스켈레톤 4개 표시
  const aiSec = $('ai-result-section');
  if (aiSec) {
    const skeletonCard = () => `
      <div class="ai-ske-card">
        <div class="ai-ske-header">
          <div class="skeleton-line" style="width:30%"></div>
          <div class="skeleton-line" style="width:18%"></div>
        </div>
        <div class="skeleton-line" style="width:90%"></div>
        <div class="skeleton-line" style="width:75%"></div>
        <div class="skeleton-line" style="width:85%"></div>
      </div>`;
    aiSec.innerHTML = skeletonCard() + skeletonCard() + skeletonCard() + skeletonCard();
  }
  console.log('[완료] 결과 화면 표시 (스켈레톤)');

  // AI 채점 — 완료 시 오버레이 종료 + 스켈레톤 교체
  if (firebase.apps.length && state.audioBlob) {
    callGeminiScoring(lang.text, state.audioBlob, state.selectedLang, lang.checkpoints).then(aiResult => {
      _completeOverlay();
      if (aiResult) {
        _recordAiEvaluation(); // AI 평가 완료 횟수 누적
        renderAiResult(aiResult, isAdmin);
        if (aiResult.transcript) renderTranscriptCompare(aiResult.transcript, lang);
      } else {
        if (aiSec) _showAiErrorWithRetry(aiSec);
      }
    }).catch((e) => {
      _completeOverlay();
      // 오류 상세 내용 토스트로 표시
      showToast('오류: ' + (e?.message || e?.status || JSON.stringify(e)).substring(0, 100), 8000);
      if (aiSec) _showAiErrorWithRetry(aiSec);
    });
  } else {
    // Firebase 없는 경우 즉시 오버레이 종료
    _completeOverlay();
    if (aiSec) aiSec.innerHTML = '<div class="ai-ske-error">AI 분석은 배포 환경에서 사용 가능합니다.</div>';
  }
}

function _showAiErrorWithRetry(aiSec) {
  const hasBlob = !!_lastRecordingBlob;
  const retryBtnHtml = hasBlob
    ? `<button class="ai-error-btn ai-error-btn-retry" onclick="_retryAiAnalysis()">🔄 다시 분석하기</button>
       <button class="ai-error-btn ai-error-btn-rerecord" onclick="_goRerecord()">🎤 다시 녹음하기</button>`
    : `<button class="ai-error-btn ai-error-btn-rerecord" onclick="_goRerecord()">🎤 다시 녹음하기</button>`;

  aiSec.innerHTML = `
    <div class="ai-error-card">
      <div class="ai-error-icon">⚠️</div>
      <div class="ai-error-title">분석 중 오류가 발생했습니다</div>
      ${hasBlob ? '<div class="ai-error-sub">녹음 파일은 보존되어 있습니다.<br>다시 분석을 시도해보세요.</div>' : ''}
      <div class="ai-error-actions">${retryBtnHtml}</div>
      <div class="ai-error-hint">💡 오류가 반복되면:<br>네트워크 상태를 확인하거나 잠시 후 다시 시도해주세요.</div>
    </div>`;
  console.log('[완료] AI 오류 화면 표시 (재시도 버튼 포함)');
}

async function _retryAiAnalysis() {
  if (!_lastRecordingBlob) {
    showToast('녹음 파일이 없습니다. 다시 녹음해주세요.', 3000);
    return;
  }

  _aiAnalysisRetryCount++;
  if (_aiAnalysisRetryCount > 2) {
    const aiSec = $('ai-result-section');
    if (aiSec) aiSec.innerHTML = `
      <div class="ai-error-card">
        <div class="ai-error-icon">⚠️</div>
        <div class="ai-error-title">네트워크 오류로 분석이 어렵습니다</div>
        <div class="ai-error-sub">다시 녹음 후 시도해주세요.</div>
        <div class="ai-error-actions">
          <button class="ai-error-btn ai-error-btn-rerecord" onclick="_goRerecord()">🎤 다시 녹음하기</button>
        </div>
      </div>`;
    return;
  }

  const aiSec = $('ai-result-section');
  const skeletonCard = () => `
    <div class="ai-ske-card">
      <div class="ai-ske-header">
        <div class="skeleton-line" style="width:30%"></div>
        <div class="skeleton-line" style="width:18%"></div>
      </div>
      <div class="skeleton-line" style="width:90%"></div>
      <div class="skeleton-line" style="width:75%"></div>
      <div class="skeleton-line" style="width:85%"></div>
    </div>`;
  if (aiSec) aiSec.innerHTML = skeletonCard() + skeletonCard() + skeletonCard() + skeletonCard();

  $('loading-overlay').classList.remove('hidden');
  _startOverlayTimers();

  const s = state.currentScript;
  const lang = s?.langs[state.selectedLang];
  const isAdmin = isEditUnlocked();

  try {
    const aiResult = await callGeminiScoring(lang.text, _lastRecordingBlob, state.selectedLang, lang.checkpoints);
    _completeOverlay();
    if (aiResult) {
      _recordAiEvaluation(); // AI 평가 완료 횟수 누적
      renderAiResult(aiResult, isAdmin);
      if (aiResult.transcript) renderTranscriptCompare(aiResult.transcript, lang);
    } else {
      if (aiSec) _showAiErrorWithRetry(aiSec);
    }
  } catch (e) {
    _completeOverlay();
    // 오류 상세 내용 토스트로 표시
    showToast('오류: ' + (e?.message || e?.status || JSON.stringify(e)).substring(0, 100), 8000);
    if (aiSec) _showAiErrorWithRetry(aiSec);
  }
  console.log(`[완료] AI 재분석 시도 ${_aiAnalysisRetryCount}회`);
}

function _goRerecord() {
  _lastRecordingBlob = null;
  if (_lastRecordingUrl) { URL.revokeObjectURL(_lastRecordingUrl); _lastRecordingUrl = null; }
  if (state.currentScript) startPrep(state.currentScript, state.selectedLang);
  console.log('[완료] 다시 녹음하기 → 준비 화면 복귀');
}

function renderRadar(result) {
  if (state.radarChartInstance) { state.radarChartInstance.destroy(); state.radarChartInstance = null; }
  const cats = Object.entries(getChecklist(result.lang));
  const myData = cats.map(([k,c]) => Math.round(result.categories[k].score / c.max * 100));
  const ctx = $('radar-chart').getContext('2d');
  state.radarChartInstance = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: cats.map(([,c]) => `${c.label}(${c.max}점)`),
      datasets: [
        {
          label: '내 점수(%)',
          data: myData,
          backgroundColor: 'rgba(123,30,58,.16)',
          borderColor: '#7B1E3A',
          borderWidth: 2.5, pointBackgroundColor: '#7B1E3A', pointRadius: 4
        },
        {
          label: '권장 수준',
          data: [75,75,75,75],
          backgroundColor: 'rgba(16,185,129,.05)',
          borderColor: 'rgba(16,185,129,.55)',
          borderWidth: 1.5, borderDash: [5,4],
          pointRadius: 2, pointBackgroundColor: '#10b981'
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        r: {
          beginAtZero: true, min: 0, max: 100,
          ticks: { display: false, stepSize: 25 },
          grid: { color: 'rgba(0,0,0,.07)' },
          pointLabels: { font: { size: 10, weight: '600' }, color: '#475569' }
        }
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } }
      }
    }
  });
}

function renderFeedback(result, transcript, lang, isAdmin) {
  const cats = result.categories;

  /* ── 카테고리별 개선 팁 정의 ──
     cq = content quality (0~1). 음성·억양 기반 팁은 방송 내용이 충분히 인식됐을 때만 유효.
     cq < 0.3 이면 행동 관련 팁 대신 "내용 인식 부족" 안내를 표시한다. */
  const cq = result.contentQuality ?? 0;
  const cqOk  = cq >= 0.30;  // 음성 분석 팁이 의미 있는 최소 임계값
  const cqFull= cq >= 0.50;  // 연출·억양 팁이 신뢰도 높은 임계값

  const _TIPS_JA = {
    fluency: [
      (v) => (v < 4 && cqOk) ? '의미 단위(문절)마다 슬래시(/)를 긋고 그 자리에서 0.5초씩 멈춰 읽는 연습을 5회 반복해보세요.' : null,
      (v) => v < 3 ? (cqOk
        ? '독음을 보지 않고 첫 두 문장만 외워서 말해보세요. 숙지도가 올라가면 억양·속도가 함께 안정됩니다.'
        : '방송문 전체를 큰 소리로 또렷하게 읽어 보세요. 내용 인식률이 낮으면 다른 항목 점수도 정확하지 않습니다.') : null,
      (v) => (v < 4 && cqOk) ? (result.wpm > 0
        ? `현재 약 ${result.wpm} ${result.speedUnit} — 적정 ${lang.idealSpeed} ${lang.speedUnit}. ${result.wpm > lang.idealSpeed ? '빨라지면 장음·촉음이 가장 먼저 사라집니다. 한 박씩 세듯 천천히 읽어보세요.' : '조금 더 자연스럽게 이어 읽어보세요.'}`
        : '방송문을 눈으로 3회 읽고 박자를 익힌 뒤 녹음하세요.') : null,
      (v) => (v < 7 && cqFull) ? '독음을 "읽는다"가 아니라 승객에게 "말한다"고 상상하세요. 또박또박 끊어 읽는 낭독체가 가장 큰 감점 요인입니다.' : null,
    ],
    voice: [
      (v) => (v < 7 && cqOk) ? '지금보다 약간 낮은 톤에서 시작해보세요. 낮고 차분한 톤이 일본어 기내방송에서 더 정중하게 들립니다.' : null,
      (v) => (v < 4 && cqOk) ? '녹음 전 복식호흡을 2~3회 하고 목을 풀어주세요. 음량이 흔들리면 전체 인상이 흐려집니다.' : null,
      (v) => (v < 4 && cqFull) ? '입꼬리를 살짝 올린 채로 방송하면 따뜻한 분위기가 목소리에 자연스럽게 실립니다.' : null,
      (v) => (v < 4 && cqFull) ? '문장마다 같은 억양 패턴을 반복하고 있지 않은지 들어보세요. 과장도 단조로움도 모두 감점 대상입니다.' : null,
    ],
    intonation: [
      (v) => (v < 7 && cqFull) ? '일본어는 강세가 아니라 고저(高低)로 구분됩니다. 단어 첫음절을 세게 누르는 한국어 습관을 빼고 평평하게 흘려보세요.' : null,
      (v) => (v < 4 && cqFull) ? '문장 끝마다 같은 방향으로 오르내리고 있지 않은지 확인하세요. 동일 패턴 반복은 감점입니다.' : null,
      (v) => (v < 4 && cqOk) ? '장음(ー·おう·えい)은 두 박으로 끌되 그 위에 억양을 얹지 마세요. とうきょう를 손가락으로 4박 세며 읽어보세요.' : null,
      (v) => (v < 4 && cqOk) ? '문말 です·ます를 한국어처럼 올리지 말고 자연스럽게 내려 마무리하세요.' : null,
    ],
    pronunciation: [
      (v) => (v < 4 && cqOk) ? '장음 탈락이 가장 잦은 감점입니다. ありがとうございます의 とう·ざい를 충분히 끌었는지 녹음을 다시 들어보세요.' : null,
      (v) => (v < 4 && cqOk) ? '표기된 독음 그대로 읽되 된소리(꼬·따·빠)로 새지 않게 주의하세요. ございます는 "고자이마스"입니다.' : null,
      (v) => (v < 4 && cqOk) ? '촉음(っ)은 한 박 멈춤입니다. しゅっぱつ를 "슛-파츠"처럼 사이를 두고 연습해보세요.' : null,
      (v) => (v < 4 && cqOk) ? 'う를 과하게 오므리거나 え/い를 섞지 않도록 모음만 따로 떼어 5회씩 읽어보세요.' : null,
      (v) => (v < 4 && cqOk) ? '조사(は·を·へ)의 발음이 표기와 다르다는 점을 확인하세요. は는 "와", を는 "오", へ는 "에"입니다.' : null,
    ]
  };
  const _TIPS_CA = {
    fluency: [
      (v) => (v < 4 && cqOk) ? '쉼표(，)와 의미 단위에서 0.5~1초 멈추는 연습을 해보세요. 단어(词) 중간에서 끊기지 않도록 주의하세요.' : null,
      (v) => (v < 7 && cqFull) ? '글자를 하나씩 끊어 읽는 스타카토식이 가장 큰 감점 요인입니다. 2~3글자 단어를 한 덩어리로 묶어 읽어보세요.' : null,
      (v) => (v < 4 && cqFull) ? '편명·목적지·안전 관련 단어 직전에 살짝 속도를 늦추면 자연스러운 강조가 됩니다.' : null,
      (v) => (v < 4 && cqOk) ? (result.wpm > 0
        ? `현재 약 ${result.wpm} ${result.speedUnit} — 적정 ${lang.idealSpeed} ${lang.speedUnit}. ${result.wpm > lang.idealSpeed ? '빨라지면 성조가 가장 먼저 뭉개집니다. 한 글자씩 성조를 그리며 천천히 읽어보세요.' : '조금 더 자연스럽게 이어 읽어보세요.'}`
        : '병음과 성조를 먼저 눈으로 익힌 뒤 녹음하세요.') : null,
      (v) => v < 3 ? (cqOk
        ? '병음을 보지 않고 첫 문장부터 말해보는 연습을 먼저 해보세요.'
        : '방송문 전체를 큰 소리로 또렷하게 읽어 보세요. 내용 인식률이 낮으면 다른 항목 점수도 정확하지 않습니다.') : null,
    ],
    voice: [
      (v) => (v < 7 && cqFull) ? '입꼬리를 살짝 올린 채로 방송해보세요. 성조에 집중하다 보면 표정과 온기가 사라지기 쉽습니다.' : null,
      (v) => (v < 4 && cqOk) ? '녹음 전 복식호흡을 2~3회 하고 목을 풀어주세요. 힘없는 발성이나 갈라짐은 바로 감점됩니다.' : null,
      (v) => (v < 7 && cqOk) ? '성조를 지키려다 톤이 과장되거나 경직되지 않았는지 들어보세요. 성조는 살리되 톤은 부드럽게가 목표입니다.' : null,
    ],
    intonation: [
      (v) => (v < 4 && cqFull) ? '1성은 높게 쭉 유지, 4성은 위에서 아래로 확실히 떨어뜨리세요. 飞(fēi)와 位(wèi)를 번갈아 5회 읽어보세요.' : null,
      (v) => (v < 4 && cqFull) ? '2성은 끝까지 올리고, 3성은 내렸다 다시 올립니다. 您(nín)과 好(hǎo)를 손으로 선을 그리며 연습해보세요.' : null,
      (v) => (v < 4 && cqFull) ? '3성+3성이 이어지면 앞 글자를 2성으로 바꿔 읽습니다. 你好는 "nǐ hǎo"가 아니라 "ní hǎo"입니다.' : null,
      (v) => (v < 7 && cqFull) ? '모든 글자를 같은 높이로 평탄하게 읽는 한국어식 억양이 가장 큰 감점 요인입니다. 문장마다 성조 곡선을 그려보며 연습하세요.' : null,
    ],
    pronunciation: [
      (v) => (v < 4 && cqOk) ? '권설음(zh/ch/sh/r)은 혀끝을 말아 올립니다. 中(zhōng)이 "종"처럼 들리지 않도록 座(zuò)와 번갈아 읽어보세요.' : null,
      (v) => (v < 4 && cqOk) ? 'ü는 "우"가 아니라 입을 오므린 "위"입니다. 旅(lǚ)를 "루"로 읽지 않도록 주의하세요.' : null,
      (v) => (v < 4 && cqOk) ? '복운모는 앞뒤 모음이 모두 살아야 합니다. 飞机(fēijī)·航班(hángbān)을 천천히 늘려 읽어보세요.' : null,
      (v) => (v < 4 && cqOk) ? 'f는 윗니를 아랫입술에 대고 냅니다. 飞(fēi)를 "훼이"가 아닌 "f-ei"로 발음해보세요.' : null,
    ]
  };
  const CAT_TIPS = result.lang === 'ca' ? _TIPS_CA : _TIPS_JA;

  /* ── 1. 연습 요약 배너 ──
     점수·PASS/FAIL 은 표시하지 않는다. 훈련 도구의 결과가 실제 평가 결과처럼
     오해되면 평가 문의·이의 제기로 이어지므로, '무엇을 다듬을지'만 안내한다.
     (내부 점수는 피드백 강도 결정에만 쓰인다) */
  const _catLabels = { fluency: '유창성', voice: '분위기·목소리',
                       intonation: result.lang === 'ca' ? '성조·억양' : '억양',
                       pronunciation: '발음' };
  const _catRatio = Object.entries(cats).map(([k, v]) => [k, v.max ? v.score / v.max : 1]);
  _catRatio.sort((a, b) => a[1] - b[1]);
  const _weakest = _catRatio.filter(x => x[1] < 0.8).slice(0, 2).map(x => _catLabels[x[0]]);
  const _allGood = _catRatio.every(x => x[1] >= 0.8);

  const overviewCls = _allGood ? 'ov-pass' : 'ov-practice';
  const overviewIcon = _allGood ? '🎯' : '🔍';
  const overviewLabel = _allGood ? '전 항목 안정' : '집중 연습';
  const overviewMsg = _allGood
    ? '모든 항목이 고르게 안정적입니다. 이 감각을 반복해서 굳혀보세요.'
    : `이번 연습에서 다듬을 부분: ${_weakest.join(' · ')} — 아래 상세 분석을 확인하세요.`;

  const noSpeech = (!transcript || transcript.length < 5)
    ? `<div class="fb-no-speech">⚠️ 음성이 인식되지 않았습니다 — Chrome 브라우저 + 마이크 허용 필요. 발음·완성도 점수가 0점 처리됩니다.</div>`
    : (cq < 0.20 && transcript && transcript.length >= 5)
    ? `<div class="fb-no-speech fb-low-content">⚠️ 방송문 내용 일치율이 낮아(${Math.round(cq*100)}%) 음성·억양 분석의 신뢰도가 제한됩니다. 방송문 전체를 또렷하게 읽은 후 다시 시도하세요.</div>`
    : '';

  const overviewHTML = `
  <div class="fb-overview ${overviewCls}">
    <div class="fb-ov-left">
      <div class="fb-ov-badge">${overviewIcon} ${overviewLabel}</div>
    </div>
    <div class="fb-ov-right">
      <div class="fb-ov-msg">${overviewMsg}</div>
      <div class="fb-ov-stats">
        <span class="fb-stat">⏱ ${Math.round(result.duration)}초</span>
        <span class="fb-stat">💬 ${result.wpm} ${result.speedUnit}</span>
        <span class="fb-stat">🔑 키워드 ${Math.round(result.completeness * 100)}%</span>
        <span class="fb-stat">📝 단어일치 ${Math.round(result.wordMatch * 100)}%</span>
      </div>
    </div>
  </div>${noSpeech}`;

  /* ── 2. 카테고리별 섹션 ── */
  const _RCL = getChecklist(result.lang);
  const groupsHTML = ['fluency','voice','intonation','pronunciation'].map(key => {
    const cat  = _RCL[key];
    const cr   = cats[key];
    const pct  = Math.round(cr.score / cat.max * 100);
    const grade = pct >= 87 ? 'good' : pct >= 60 ? 'mid' : 'low';
    const gradeLabel = pct >= 87 ? '우수' : pct >= 60 ? '보통' : '노력필요';
    const tips = CAT_TIPS[key];

    const subRows = cat.items.map((item, i) => {
      const got   = cr.items[i];
      const ratio = got / item.max;
      const iGood = ratio >= 0.87;
      const iMid  = ratio >= 0.60;
      const rowCls = iGood ? 'sr-good' : iMid ? 'sr-mid' : 'sr-low';
      const tagCls = iGood ? 'tag-good' : iMid ? 'tag-mid' : 'tag-low';
      const icon   = iGood ? '✓' : iMid ? '△' : '✕';
      const label  = iGood ? '우수' : iMid ? '보통' : '노력필요';
      const tip    = tips[i]?.(got);

      return `
      <div class="fb-sub-row ${rowCls}">
        <div class="fb-sub-main">
          <span class="fb-sub-icon">${icon}</span>
          <span class="fb-sub-name">${item.label}</span>
          ${isAdmin ? `<span class="fb-sub-score">${got}<span class="fb-sub-max">/${item.max}</span></span>` : ''}
          <span class="fb-sub-tag ${tagCls}">${label}</span>
        </div>
        ${tip ? `<div class="fb-tip ${iMid ? 'tip-mid' : 'tip-low'}"><span class="fb-tip-arrow">↳</span>${tip}</div>` : ''}
      </div>`;
    }).join('');

    return `
    <div class="fb-group">
      <div class="fb-group-hd grade-bg-${grade}">
        <div class="fb-gh-left">
          <span class="fb-gh-icon">${cat.icon}</span>
          <span class="fb-gh-name">${cat.label}</span>
        </div>
        <div class="fb-gh-right">
          <div class="fb-gh-bar-wrap">
            <div class="fb-gh-bar" style="width:${pct}%;background:${cat.color}"></div>
          </div>
          ${'' /* 항목별 점수는 표시하지 않는다. 숫자에 매몰되면 피드백 내용을 놓치게 된다. */}
          <span class="fb-gh-badge badge-${grade}">${gradeLabel}</span>
        </div>
      </div>
      <div class="fb-group-body">${subRows}</div>
    </div>`;
  }).join('');

  $('feedback-cards').innerHTML = overviewHTML + groupsHTML;
}

function renderTranscriptCompare(transcript, lang) {
  const preview = lang.text.split('\n').slice(0, 3).join(' ') + (lang.text.split('\n').length > 3 ? '…' : '');
  $('transcript-compare').innerHTML = `
    <div class="tc-row"><div class="tc-label">방송 원문</div><div class="tc-text">${escHtml(preview)}</div></div>
    <div class="tc-row"><div class="tc-label">AI 인식</div><div class="tc-text recognized">${transcript ? _withReading(escHtml(transcript), state.selectedLang) : '(AI 채점 결과 대기 중...)'}</div></div>`;
}

// ===== TEXT HELPERS =====
function normalize(text) { return text.replace(/[.,!?。、·]/g,'').toLowerCase().trim(); }
function similarity(a, b) {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b, shorter = a.length > b.length ? b : a;
  if (!longer.length) return 1;
  return (longer.length - levenshtein(longer, shorter)) / longer.length;
}
function levenshtein(s, t) {
  const m = s.length, n = t.length;
  const dp = Array.from({length: m+1}, (_,i) => Array.from({length: n+1}, (_,j) => i===0 ? j : j===0 ? i : 0));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = s[i-1]===t[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

// ===== SCRIPT MODAL (추가 & 편집 공용) =====
function _resetModal() {
  document.getElementById('custom-title').value = '';
  document.getElementById('custom-icon').value = '📋';
  document.getElementById('custom-difficulty').value = '기본';
  ['ja','ca'].forEach(l => {
    const ta = document.getElementById(`custom-text-${l}`);
    if (ta) ta.value = '';
  });
  document.getElementById('custom-checkpoints-ko').value = '';
  document.querySelectorAll('.modal-lang-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.modal-lang-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.modal-lang-tab[data-lang="ja"]').classList.add('active');
  document.getElementById('modal-lang-ja').classList.add('active');
  // table builder
  $('table-builder').classList.add('hidden');
  $('btn-table-toggle').classList.remove('active');
  // model voice (언어별 초기화)
  ['ja','ca'].forEach(lang => {
    const el = document.getElementById(`mv-current-${lang}`);
    const nameEl = document.getElementById(`mv-name-${lang}`);
    const fileEl = document.getElementById(`mv-file-${lang}`);
    if (el) el.classList.add('hidden');
    if (nameEl) nameEl.textContent = '';
    if (fileEl) fileEl.value = '';
  });
  // MV 탭 초기화
  document.querySelectorAll('#mv-lang-tabs .mv-lang-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('#mv-lang-tabs .mv-lang-tab[data-lang="ja"]')?.classList.add('active');
  document.querySelectorAll('.mv-lang-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('mv-panel-ko')?.classList.add('active');
  _modalMvLang = 'ja';
}

function openAddModal() {
  _modalState.mode = 'add'; _modalState.editId = null; _modalState.editSource = null;
  _resetModal();
  $('modal-title-text').textContent = '✏️ 나만의 방송문 추가';
  $('modal-save').textContent = '저장하기';
  $('modal-restore').classList.add('hidden');
  $('custom-modal').classList.remove('hidden');
}
// 하위 호환성 alias
const openCustomModal = openAddModal;

async function openEditModal(id, source) {
  _modalState.mode = 'edit'; _modalState.editId = id; _modalState.editSource = source;
  _resetModal();

  let script;
  if (source === 'builtin') {
    script = getEffectiveScript(id);
    $('modal-title-text').textContent = '✏️ 기본 방송문 편집';
    const isModified = !!loadOverrides()[id];
    $('modal-restore').classList.toggle('hidden', !isModified);
  } else {
    script = loadCustomScripts().find(s => s.id === id);
    $('modal-title-text').textContent = '✏️ 내 방송문 편집';
    $('modal-restore').classList.add('hidden');
  }
  if (!script) return;

  document.getElementById('custom-title').value = script.title;
  document.getElementById('custom-icon').value = script.icon || '📋';
  document.getElementById('custom-difficulty').value = script.difficulty || '기본';

  ['ja','ca'].forEach(l => {
    const ta = document.getElementById(`custom-text-${l}`);
    if (ta && script.langs[l]) ta.value = script.langs[l].text || '';
  });
  const koLang = script.langs.ja;
  if (koLang?.checkpoints) {
    document.getElementById('custom-checkpoints-ko').value = koLang.checkpoints.join(', ');
  }
  // model voice (언어별)
  ['ja','ca'].forEach(lang => {
    const stored = localStorage.getItem(`cabinvoice_voice_${id}_${lang}`);
    if (stored) {
      const el = document.getElementById(`mv-current-${lang}`);
      const nameEl = document.getElementById(`mv-name-${lang}`);
      if (el) el.classList.remove('hidden');
      if (nameEl) nameEl.textContent = localStorage.getItem(`cabinvoice_voice_${id}_${lang}_name`) || '등록됨';
    }
  });
  $('modal-save').textContent = '수정 저장';
  $('custom-modal').classList.remove('hidden');
}

function closeCustomModal() { $('custom-modal').classList.add('hidden'); }

async function saveScriptFromModal() {
  const title = document.getElementById('custom-title').value.trim();
  if (!title) { alert('방송 제목을 입력해 주세요.'); document.getElementById('custom-title').focus(); return; }
  const koText = document.getElementById('custom-text-ja').value.trim();
  if (!koText) { alert('일본어 방송 원문은 필수 입력입니다.'); document.getElementById('custom-text-ja').focus(); return; }

  const icon = document.getElementById('custom-icon').value.trim() || '📋';
  const difficulty = document.getElementById('custom-difficulty').value;
  const difficultyClass = { '기본':'', '중급':'medium', '고급':'hard' }[difficulty] || '';
  const cpStr = document.getElementById('custom-checkpoints-ko').value;

  const _savedEditId = _modalState.editId;
  console.log('[저장시작]', _savedEditId || '(새 방송문)');

  if (_modalState.mode === 'edit' && _modalState.editSource === 'builtin') {
    // 기본 방송문 편집 → override에 저장
    const base = _allScripts.find(s => s.id === _modalState.editId);
    const overrides = loadOverrides();
    const newLangs = {};
    ['ja','ca'].forEach(l => {
      const ta = document.getElementById(`custom-text-${l}`);
      const text = ta?.value.trim();
      if (text) {
        const existing = base?.langs[l] || {};
        newLangs[l] = {
          ...existing,
          text,
          checkpoints: (l === 'ja' && cpStr) ? cpStr.split(',').map(s=>s.trim()).filter(Boolean) : (existing.checkpoints || []),
          keyPhrases: extractKeyPhrases(text, l)
        };
      }
    });
    overrides[_modalState.editId] = { title, icon, difficulty, difficultyClass, langs: newLangs };
    saveOverrides(overrides);

    // _allScripts 즉시 반영 (override 적용)
    {
      const _bIdx = _allScripts.findIndex(s => s.id === _modalState.editId);
      if (_bIdx !== -1) {
        const _eff = getEffectiveScript(_modalState.editId);
        if (_eff) _allScripts[_bIdx] = _eff;
      }
    }

    if (_db) {
      // cabinManual/latest 내 해당 방송문도 업데이트 (새로고침 후에도 반영)
      const capturedEditId = _modalState.editId;
      try {
        const latestDoc = await _db.collection(JACA_DB.manual).doc('latest').get();
        if (latestDoc.exists) {
          const announcements = latestDoc.data().announcements || [];
          const aIdx = announcements.findIndex(a => (a.id || a.section) === capturedEditId);
          if (aIdx !== -1) {
            const a = { ...announcements[aIdx] };
            if (newLangs.ko?.text) a.ko = newLangs.ko.text;
            if (newLangs.en?.text) a.en = newLangs.en.text;
            if (newLangs.ko?.checkpoints?.length) a.checkpoints = newLangs.ko.checkpoints;
            announcements[aIdx] = a;
            await _db.collection(JACA_DB.manual).doc('latest').update({ announcements });
            console.log('[저장] cabinManual/latest 업데이트:', capturedEditId);
          }
        }
      } catch(e) {
        console.warn('[저장] cabinManual/latest 업데이트 실패:', e.message);
      }
    }

    // 로컬 캐시 무효화 (다음 로딩 시 Firestore 재조회)
    localStorage.removeItem('cabinvoice_scripts_cache');

  } else if (_modalState.mode === 'edit' && _modalState.editSource === 'custom') {
    // 커스텀 방송문 편집 → 배열 내 수정
    const arr = loadCustomScripts();
    const idx = arr.findIndex(s => s.id === _modalState.editId);
    if (idx === -1) { closeCustomModal(); return; }
    const langs = {};
    langs.ja = buildCustomLang(koText, cpStr, 'ja');
    ['ca'].forEach(l => {
      const text = document.getElementById(`custom-text-${l}`)?.value.trim();
      if (text) langs[l] = buildCustomLang(text, '', l);
    });
    arr[idx] = { ...arr[idx], title, icon, difficulty, difficultyClass, langs };
    saveCustomScripts(arr);
    // _allScripts 즉시 반영
    const _cIdx = _allScripts.findIndex(s => s.id === _modalState.editId);
    if (_cIdx !== -1) _allScripts[_cIdx] = arr[idx];

  } else {
    // 새 방송문 추가
    const langs = {};
    langs.ja = buildCustomLang(koText, cpStr, 'ja');
    ['ca'].forEach(l => {
      const text = document.getElementById(`custom-text-${l}`)?.value.trim();
      if (text) langs[l] = buildCustomLang(text, '', l);
    });
    const id = 'custom_' + Date.now();
    // pending 모델 음성 → 실제 id로 이동 (언어별)
    ['ja','ca'].forEach(lang => {
      const pv = localStorage.getItem(`cabinvoice_voice__pending_${lang}`);
      const pn = localStorage.getItem(`cabinvoice_voice__pending_${lang}_name`);
      if (pv) {
        localStorage.setItem(`cabinvoice_voice_${id}_${lang}`, pv);
        localStorage.setItem(`cabinvoice_voice_${id}_${lang}_name`, pn || '모델 음성');
        localStorage.removeItem(`cabinvoice_voice__pending_${lang}`);
        localStorage.removeItem(`cabinvoice_voice__pending_${lang}_name`);
      }
    });
    // 레거시 단일 pending 폴백
    const pendingVoice = localStorage.getItem('cabinvoice_voice__pending');
    if (pendingVoice) {
      localStorage.setItem(`cabinvoice_voice_${id}_ja`, pendingVoice);
      localStorage.setItem(`cabinvoice_voice_${id}_ja_name`, localStorage.getItem('cabinvoice_voice__pending_name') || '모델 음성');
      localStorage.removeItem('cabinvoice_voice__pending');
      localStorage.removeItem('cabinvoice_voice__pending_name');
    }
    const arr = loadCustomScripts();
    arr.unshift({ id, icon, colorClass:'c-blue', difficulty, difficultyClass, title, langs, _custom: true });
    saveCustomScripts(arr);
  }

  // detail 패널 즉시 재렌더링 (편집 모드일 때만)
  if (_modalState.mode === 'edit' && _savedEditId && _selectedScriptId === _savedEditId) {
    const _updated = getEffectiveScript(_savedEditId);
    if (_updated) {
      _renderDetailContent(_updated, _detailLang);
      console.log('[저장완료] 캐시+화면 갱신:', _savedEditId);
    }
  }

  if (_modalState.mode === 'edit' && _savedEditId) {
    _markGuideUpdateNeeded(_savedEditId).catch(() => {});
  }
  closeCustomModal();
  renderHome();
  console.log('[저장완료]', _savedEditId || '(새 방송문)');
}

// PDF 파싱 결과 임시 저장 (import 시 활용)
let _pdfParsedScripts = [];

let _allScripts = [];  // 전체 방송문 (Firestore + 빌트인 + custom)
let _selectedScriptId = null;
let _detailLang = 'ja';
let _lastDetailScript = null;

// ===== PDF IMPORT =====
function openPdfModal() {
  _showPdfStep('upload');
  $('pdf-import-btn').classList.add('hidden');
  $('pdf-modal').classList.remove('hidden');
}
function closePdfModal() { $('pdf-modal').classList.add('hidden'); }

function _showPdfStep(step) {
  ['upload','parsing','preview','error'].forEach(s => {
    $(`pdf-step-${s}`).classList.toggle('hidden', s !== step);
  });
}

async function handlePdfFile(file) {
  if (!file || file.type !== 'application/pdf') {
    _showPdfError('PDF 파일만 지원합니다. (.pdf 확장자 파일을 선택해 주세요)');
    return;
  }

  _showPdfStep('parsing');
  $('pdf-parsing-msg').textContent = 'PDF 이미지 변환 중...';
  $('pdf-parsing-sub').textContent = file.name;

  try {
    if (!window.pdfjsLib) throw new Error('PDF.js 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;

    $('pdf-parsing-msg').textContent = `Gemini AI로 ${totalPages}페이지 분석 중...`;

    const CHUNK_SIZE = 10;
    const USER_PROMPT = `항공사 방송교범 PDF 페이지들입니다. 각 페이지를 순서대로 분석하여 JSON 배열로만 반환하세요.

규칙:
- 언어 코드: ko(한국어), en(영어)
- 헤더(챕터명), 푸터(페이지번호, REV.XX) 제외
- 조건부 문안(표 구조, General/수하물 과다 반입 등): variants 배열로 추출

각 페이지에 대해:
방송문 있음: {"lang":"ko","num":"2.1.1","title":"방송 제목","text":"방송 내용"}
복수 문안: {"lang":"ko","num":"2.1.1","title":"방송 제목","variants":[{"label":"General","text":"..."}]}
방송문 없는 페이지: {"skip":true}

반환: JSON 배열만 (예: [{"skip":true},{"lang":"ko",...}]) — 설명 없이`;

    const pageResults = [];
    for (let start = 1; start <= totalPages; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, totalPages);
      $('pdf-parsing-sub').textContent = `${start} – ${end} / ${totalPages} 페이지 분석 중...`;

      const images = await _renderPdfPages(pdf, start, end);
      const results = await callGeminiVisionChunk(images, USER_PROMPT);
      pageResults.push(...results);

      if (end < totalPages) await new Promise(r => setTimeout(r, 2000));
    }

    const scripts = groupPagesByScript(pageResults);
    if (!scripts.length) {
      _showPdfError('방송문안을 인식하지 못했습니다.\n\nAI가 방송문 구조를 찾지 못했습니다.\n방송교범 PDF인지 확인하거나 다시 시도해 주세요.');
      return;
    }
    renderPdfPreview(scripts);
  } catch (e) {
    _showPdfError(`오류가 발생했습니다:\n${e.message}`);
  }
}

// PDF 페이지 렌더링 헬퍼 — start~end 페이지를 JPEG base64 배열로 반환
async function _renderPdfPages(pdf, start, end) {
  const images = [];
  for (let p = start; p <= end; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
  }
  return images;
}

// 청크 단위 Gemini Vision 호출 — 이미지 배열 + 프롬프트 → 파싱 결과 배열 반환
async function callGeminiVisionChunk(images, prompt) {
  const model = await getGeminiModel();
  const parts = [
    ...images.map(b64 => ({ inlineData: { data: b64, mimeType: 'image/jpeg' } })),
    { text: prompt }
  ];
  const result = await model.generateContent(parts);
  const raw = result.response.text().trim();

  // JSON 배열 우선, 없으면 개별 JSON 객체 여러 개 파싱
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      return Array.isArray(arr) ? arr.filter(r => r && !r.skip) : [];
    } catch {}
  }
  // 배열 파싱 실패 시 개별 {...} 객체들 추출
  const results = [];
  const objRe = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
  let m;
  while ((m = objRe.exec(raw)) !== null) {
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed && !parsed.skip && parsed.num) results.push(parsed);
    } catch {}
  }
  return results;
}

function groupPagesByScript(pageResults) {
  const scriptMap = new Map();
  const order = [];

  for (const r of pageResults) {
    if (!r.num) continue;
    if (!scriptMap.has(r.num)) {
      scriptMap.set(r.num, { num: r.num, title: r.title || r.num, ko: '', en: '' });
      order.push(r.num);
    }
    const s = scriptMap.get(r.num);
    if (r.title && !s.title) s.title = r.title;

    const lang = r.lang;
    if (['ko','en'].includes(lang)) {
      if (r.variants && r.variants.length >= 2) {
        s[lang] = r.variants.map(v => `[${v.label}]\n${v.text.trim()}`).join('\n\n');
      } else {
        s[lang] = (r.text || '').trim();
      }
    }
  }

  return order.map(k => scriptMap.get(k)).filter(s => s.ko || s.en);
}

function renderPdfPreview(scripts) {
  _pdfParsedScripts = scripts;
  _showPdfStep('preview');
  $('pdf-preview-info').textContent =
    `${scripts.length}개 방송문안 인식됨 — 가져올 항목을 선택·편집하세요`;
  $('pdf-import-btn').classList.remove('hidden');

  const LANG_LABELS = { ko: '🇰🇷 한국어', en: '🇺🇸 영어' };

  const rows = scripts.map((s, i) => {
    const activeLang = ['ko','en'].find(l => s[l]) || 'ko';
    const langTabs = ['ko','en'].map(l =>
      `<button class="pdf-lang-tab${l === activeLang ? ' active' : ''}" data-lang="${l}"${!s[l] ? ' style="opacity:.4"' : ''}>${LANG_LABELS[l]}</button>`
    ).join('');
    const langPanels = ['ko','en'].map(l =>
      `<textarea class="pdf-field-textarea${l !== activeLang ? ' hidden' : ''}" data-field="${l}" rows="4">${(s[l] || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</textarea>`
    ).join('');

    return `
    <div class="pdf-script-item selected" data-idx="${i}">
      <input type="checkbox" class="pdf-script-check" checked>
      <div class="pdf-script-fields">
        <div class="pdf-script-num-title">
          <span class="pdf-script-num">${s.num}</span>
          <input class="pdf-field-input" placeholder="방송 제목"
            value="${(s.title || '').replace(/"/g,'&quot;')}" data-field="title">
        </div>
        <div class="pdf-lang-tabs">${langTabs}</div>
        ${langPanels}
      </div>
    </div>`;
  }).join('');

  $('pdf-script-list').innerHTML = rows;

  $('pdf-script-list').querySelectorAll('.pdf-script-check').forEach(cb => {
    cb.addEventListener('change', () =>
      cb.closest('.pdf-script-item').classList.toggle('selected', cb.checked));
  });

  $('pdf-script-list').querySelectorAll('.pdf-lang-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const item = tab.closest('.pdf-script-item');
      item.querySelectorAll('.pdf-lang-tab').forEach(t => t.classList.remove('active'));
      item.querySelectorAll('.pdf-field-textarea').forEach(ta => ta.classList.add('hidden'));
      tab.classList.add('active');
      item.querySelector(`[data-field="${tab.dataset.lang}"]`).classList.remove('hidden');
    });
  });
}

function _showPdfError(msg) {
  _showPdfStep('error');
  $('pdf-error-msg').textContent = msg;
  $('pdf-import-btn').classList.add('hidden');
}

function importSelectedPdfScripts() {
  const items = $('pdf-script-list').querySelectorAll('.pdf-script-item');
  const toAdd = [];
  items.forEach(item => {
    const cb = item.querySelector('.pdf-script-check');
    if (!cb.checked) return;
    const idx   = parseInt(item.dataset.idx);
    const meta  = _pdfParsedScripts[idx] || {};
    const title = item.querySelector('[data-field="title"]').value.trim() || '방송문';
    const langs = {};
    ['ja','ca'].forEach(l => {
      const ta = item.querySelector(`[data-field="${l}"]`);
      const text = ta ? ta.value.trim() : '';
      if (text) langs[l] = buildCustomLang(text, '', l);
    });
    if (!Object.keys(langs).length) return;
    const id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    toAdd.push({
      id,
      icon: '📋',
      colorClass: 'c-blue',
      difficulty: '기본', difficultyClass: '',
      title: `${meta.num ? meta.num + ' ' : ''}${title}`,
      langs,
      _custom: true
    });
  });
  if (!toAdd.length) { alert('선택된 방송문이 없습니다.'); return; }
  const arr = loadCustomScripts();
  arr.unshift(...[...toAdd].reverse());
  saveCustomScripts(arr);
  closePdfModal();
  renderHome();
  alert(`${toAdd.length}개 방송문안을 가져왔습니다.`);
}

// ===== GEMINI AI SCORING =====
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function callGeminiScoring(script, audioBlob, langCode, checkpoints) {
  // 1인당 일일 채점 횟수 제한 (5회) — Firestore 기준, 기기/브라우저 상관없이 동일 사번이면 공유
  const _empId = _getEmpId();
  const _count = await _getDailyUsageCount(_empId);

  if (_count >= 5) {
    const _limitOverlay = document.createElement('div');
    _limitOverlay.style.cssText = 
      'position:fixed;inset:0;background:rgba(0,0,0,0.7);' +
      'z-index:999999;display:flex;align-items:center;' +
      'justify-content:center;';
    _limitOverlay.innerHTML = `
      <div style="width:100%;max-width:320px;background:#fff;
        border-radius:16px;padding:28px 24px;margin:20px;
        text-align:center;box-sizing:border-box;">
        <div style="font-size:36px;margin-bottom:12px;">✈️</div>
        <h3 style="font-size:17px;font-weight:700;
          color:#003479;margin-bottom:12px;">
          오늘 채점을 모두 완료했어요!</h3>
        <p style="font-size:14px;color:#6E6E73;
          line-height:1.6;margin-bottom:20px;">
          하루 5회 AI 채점 한도를 사용하셨습니다.<br>
          내일 자정이 지나면 다시 채점할 수 있어요.<br><br>
          오늘은 <b>학습 모드</b>와 <b>드릴 모드</b>를<br>
          활용해보세요! 😊</p>
        <button id="limit-close-btn"
          style="width:100%;padding:14px;
          background:#FF6B00;color:white;border:none;
          border-radius:10px;font-size:15px;
          font-weight:700;cursor:pointer;">
          확인</button>
      </div>`;
    document.body.appendChild(_limitOverlay);
    document.getElementById('limit-close-btn')
      .addEventListener('click', () => {
        _limitOverlay.remove();
        showScreen('screen-home'); updateAIUsageBadge();
      });
    return;
  }
  // 성공적인 결과 응답 시에만 차감하기 위해 여기서의 선증가는 제거합니다.

  console.log('audioBlob size:', audioBlob?.size, 'type:', audioBlob?.type);
  const model = await getGeminiModel();
  const langName = { ja:'일본어', ca:'중국어' }[langCode] || '일본어';
  const cpText = checkpoints?.length
    ? `\n핵심 체크포인트 (누락 여부 반드시 확인):\n${checkpoints.map(c=>`- ${c}`).join('\n')}\n`
    : '';

  const _GCL       = getChecklist(langCode);
  const maxFluency = _GCL.fluency.max;
  const maxVoice   = _GCL.voice.max;
  const maxInton   = _GCL.intonation.max;
  const maxPron    = _GCL.pronunciation.max;
  const gradeRule  = 'score 85이상→grade"PASS", 84이하→grade"FAIL" (JA/CA Code 평가표: 85점 이상 취득 시 PASS)';

  const criteriaMap = {
    ja: `[JA코드 평가 CHECK LIST rev.3 — 100점 만점 / 85점 이상 PASS]
※ 응시자 85% 이상이 일본어 비전공자로, 표기된 한글 독음을 보고 읽습니다.
※ 아래 항목·배점은 실제 평가표와 동일하므로 반드시 이 구성대로만 채점하세요.

유창성 ${maxFluency}점:
  ① 끊어 읽기(5): 의미상 자연스러운 곳에서 끊어 읽는가
     - 감점: 끊음이 잦음 / 생략 / Pause가 지나치게 짧거나 긺 / 위치 부정확
     - 조사(は·が·を·に) 뒤 끊음은 자연스러움. 단어 중간 끊김은 감점
  ② 문안 숙지(5): 버벅거림·중간 반복·갑작스러운 멈춤이 있으면 감점
  ③ 속도 연출(5): (전체/부분) 적절한 속도인가
     [반드시 준수] 가장 흔한 문제는 '너무 빠름'. 독음을 따라가다 빨라지며 박(拍)이 뭉개짐.
     - 빠르게 읽어 장음·촉음이 사라지면 반드시 감점
     - 천천히 명확하게 읽으면 우수(5점). 특정 구간만 빨라지는 것도 감점
     금지 표현: '더 빠르게', '속도를 높여' / 권장 표현: '한 박 한 박 살려서', '여유 있게'
  ④ 말하는 듯한 방송연출(10): 또박또박 지양
     - 글자 단위로 뚝뚝 끊어 읽는 낭독체면 감점
     - 한국어식 강세가 아닌 일본어 고저 악센트 흐름으로 말하는가

분위기/목소리 ${maxVoice}점:
  ① 자연스러운 톤(10): 음성에 어울리는 톤인가. 지나치게 높거나 낮으면 감점
  ② 안정적인 발성(5): 음량 큼/작음, 비음, 아성, 갈라짐, 불안정 여부
  ③ 친절한 분위기(5): 차가움·성의 부족 여부. 무성의하게 읽었다면 1~2점
  ④ 과장·단조 지양(5): 과장된 연출 또는 단조로운 연출 모두 감점

억양 ${maxInton}점:
  ① 일본어다운 억양(10): 일본어 특성을 살린 자연스러운 억양인가
     - 감점: 미준수 / 높낮이 변화가 적어 평탄함 / 한국어식 억양 개입
  ② 고른 억양(5): 상승·하향·동일 패턴이 반복되면 감점
  ③ 장음 연출(5): 장음 구간에 불필요한 억양을 얹지 않고 자연스럽게 끄는가
  ④ 어미·조사 처리(5): 짧게 끊음 / 길게 끎 / 불필요한 억양 사용 시 감점
     - 문말 です·ます가 한국어식으로 올라가면 감점

발음 ${maxPron}점 (음성을 직접 듣고 실제 확인된 것만 채점. 확인되지 않으면 점수를 주지 말 것):
  ① 장음(5): 생략 / 불필요한 장음 삽입 / 지나치게 긺·짧음
     - とうきょう는 4박, ありがとうございます의 とう 유지 여부
     - 장음 탈락은 의미가 달라지므로 반복되면 크게 감점
  ② 히라가나 고유의 발음(5): 표기된 독음을 준수하는가. 된소리 발음 주의
     - 예) ございます→고자이마스 ○ / 코사이마스·꼬자이마스 ×
  ③ ん발음·촉음(5): 생략 / 박자 미준수 / 불필요한 삽입
     - しゅっぱつ의 っ에서 한 박 멈춤이 있는가
  ④ 모음(5): 부정확하거나 과장된 모음. う의 과도한 원순, え/い 혼동 등
  ⑤ 오발음(5): 틀린 발음 / 조사 생략 / 조사 오발음 / 뭉개짐`,

    ca: `[CA코드 평가 CHECK LIST rev.3 — 100점 만점 / 85점 이상 PASS]
※ 응시자 85% 이상이 중국어 비전공자이며, 성조 지식이 거의 없는 경우가 많습니다.
※ 아래 항목·배점은 실제 평가표와 동일하므로 반드시 이 구성대로만 채점하세요.

유창성 ${maxFluency}점:
  ① 끊어읽기(5): 의미상 자연스러운 곳에서 끊어 읽는가
     - 감점: 끊음이 잦음 / 생략 / Pause가 지나치게 긴 경우
     - 쉼표(，)와 의미 단위 경계는 자연스러움. 단어(词) 중간 끊김은 감점
  ② 말하는 듯한 방송 연출(10): 스타카토식 지양
     - 글자를 하나씩 또박또박 끊어 읽으면 감점
     - 단어(词) 단위로 자연스럽게 이어지는 리듬인가
  ③ 강조 표현(5): 의미전달력을 높이기 위한 강조가 들어가는가 (편명·목적지·안전 관련)
  ④ 속도 연출(5): 전체/어절 간 적절한 속도인가
     [반드시 준수] 빠르면 성조가 뭉개져 의미 전달이 무너짐.
     - 빠르게 읽어 성조 구분이 사라지면 반드시 감점
     - 특정 부분만 빨라지는 것도 감점. 천천히 성조를 살려 읽으면 우수(5점)
     금지 표현: '더 빠르게', '속도를 높여' / 권장 표현: '천천히 성조를 살려서'
  ⑤ 문안 숙지(5): 버벅거림 주의, 잘못 읽음 주의

분위기/목소리 ${maxVoice}점:
  ① 친근한 분위기(10): 성의 부족·차가움 여부. 무성의하게 읽었다면 1~3점
  ② 음량·발성(5): 음량 큼/작음, 힘없는 발성, 목소리 갈라짐, 비음
  ③ 자연스러운 톤(10): 음성에 어울리는 톤인가. 지나치게 높거나 낮으면 감점
     - 성조를 지키려다 톤이 과장·경직되는 경우도 감점

성조/억양 ${maxInton}점:
  ① 1성·4성(5): 미준수 또는 구분 모호 시 감점
     - 1성(高平, ā) 예) 飞 fēi, 安 ān — 높고 평평하게 유지되는가
     - 4성(全降, à) 예) 位 wèi, 客 kè — 확실히 하강하는가
  ② 2성·3성(5): 미준수 또는 구분 모호 시 감점
     - 2성(上昇, á) 예) 您 nín — 끝까지 올라가는가
     - 3성(降昇, ǎ) 예) 旅 lǚ, 好 hǎo — 내렸다 올리는가
     - 2성과 3성이 구분되지 않으면 감점
  ③ 성조 변화규칙(5): 변화규칙 준수 및 성조 간 자연스러운 연결
     [반드시 아래 규칙대로 확인할 것]
     ⓐ 3성+3성 → 앞 글자를 2성으로 예) 你好 nǐ hǎo → ní hǎo
        표기대로 3성을 두 번 읽으면 감점.
     ⓑ 3성+(1·2·4성·경성) → 앞 글자는 반3성(내리기만 하고 올리지 않음)
        예) 请坐 qǐng zuò, 旅客 lǚ kè. 끝을 올리면 부자연스럽다.
     ⓒ 4성+4성 → 앞 4성은 짧고 덜 내림 예) 再见 zàijiàn, 各位 gèwèi
        둘 다 끝까지 내리면 뚝뚝 끊겨 딱딱하게 들린다. 기내방송에 특히 잦은 구간이다.
     ⓓ 一(yī) → 4성 앞에서 2성(yí) 예) 一次 yícì / 1·2·3성 앞에서 4성(yì) 예) 一般 yìbān
     ⓔ 不(bù) → 4성 앞에서 2성(bú) 예) 不要 búyào
     ⓕ 경성(轻声) — 짧고 약하게 예) 你们, 我们, 先生, 的
     ※ 구두점(，。)으로 끊어 읽는 자리에서는 변조가 일어나지 않는다.
  ④ 중국어다운 억양(10): 중국어 특성을 살린 억양인가
     - 한국어식 억양(모든 글자 같은 높이의 평탄 읽기)이면 크게 감점
     - 성조를 지키면서도 문장 전체 흐름이 자연스러운가

발음 ${maxPron}점 (음성을 직접 듣고 실제 확인된 것만 채점. 확인되지 않으면 점수를 주지 말 것):
  ① 권설음·설치음(5): 혀 위치 구분
     - 권설음 zh/ch/sh/r 예) 中 zhōng, 乘 chéng, 上 shàng
     - 설치음 z/c/s 예) 座 zuò, 次 cì, 三 sān
     - 권설음을 설치음처럼(zhōng→zōng) 발음하면 감점
  ② 단운모(5): a / o / e / i / u / ü
     - ü 발음: 旅 lǚ→'뤼' ○ / '루' ×
     - e 발음: 客 kè→'커' ○ / '케' ×
  ③ 복운모(5): ai / ei / ao / ou / ian / uang 등
     - 예) 飞机 fēijī, 旅客 lǚkè, 航班 hángbān의 운모 완성도
     - 앞뒤 모음이 뭉개지지 않고 이어지는가
  ④ 오발음(5): 위 항목 외 오발음
     - f/h 혼동 예) 飞 fēi를 'ㅎ'으로 발음 시 감점
     - 유기음/무기음 구분 b/p, d/t, g/k`
  };
  const criteria = criteriaMap[langCode] || criteriaMap.ko;

  const base64Audio = await blobToBase64(audioBlob);

  const sharedRules = `언어: ${langName} | ${gradeRule}

[채점 원칙 — 반드시 준수]
당신은 실제 항공사 기내방송 평가 교관입니다.
훈련 목적으로 정직하고 정교하게 채점합니다.

점수 기준:
90점↑: 실제 기내방송으로 즉시 사용 가능한 수준
80~89: 전반적으로 좋으나 1-2가지 개선 필요
70~79: 기본기는 있으나 여러 부분 보완 필요
60~69: 상당한 연습이 필요한 수준
60미만: 방송문 숙지부터 다시 시작 필요

절대 금지:
- 실제로 잘하지 않았는데 칭찬하는 것
- 문안 미완주인데 높은 점수 부여
- 발음/억양 문제가 있는데 우수 판정
- 모호하거나 일반적인 피드백
- 속도 피드백에서 '더 빠르게', '속도를 높여', '빠릿하게', '템포를 올려' 사용
  (기내방송의 흔한 문제는 너무 빠름. 속도 개선 피드백은 항상 '여유 있게' 방향으로)

[채점 전 필수 확인 1 — 묵음/빈 녹음 체크, 최우선 적용]
STT 인식 결과가 5단어 미만이거나 원본 방송문과 전혀 관련 없는 내용이면:
- score를 10 이하로 설정 (아래 채점 기준·카테고리 배점은 적용하지 말 것)
- encouragement 필드에 "음성이 감지되지 않았습니다. 방송문을 읽고 다시 제출해주세요."를 그대로 명시
- categories 각 항목의 good/feedback/practiceTip, goodPoints, missedKeywords, nextFocus, practiceMethod는 모두 빈 문자열 또는 빈 배열로 반환 — 다른 피드백을 일체 생성하지 말 것
- 절대 칭찬하지 말 것

[채점 전 필수 확인 2 — 방송문 일치도(matchRate), 최우선 적용]
원문에서 핵심 단어를 추출(조사·어미·접속사 제외, [목적지][편명][공항명] 등 변수는 어떤 단어가 와도 정상 처리, [생략 가능][필요 시][선택] 등 선택 문안은 제외)하고
STT 인식 결과와 대조해 matchRate = 인식된 핵심단어 수 / 전체 핵심단어 수 × 100 (0-100 정수)를 계산하세요.

일치도별 채점 기준 (반드시 준수, 확인 1이 적용된 경우는 제외):
- 90% 이상: 정상 채점, 감점 없음
- 70~89%: 유창성 "문안 숙지" 항목 -5점. nextFocus 또는 유창성 feedback에 일치도 관련 언급
- 50~69%: score를 60 이하로 제한. encouragement 또는 nextFocus에 "일부 내용이 누락됐습니다" 명시
- 30~49%: score를 40 이하로 제한. "방송문의 절반 이상이 누락됐습니다" 명시
- 30% 미만: score를 20 이하로 제한. "방송문과 전혀 다른 내용이 감지됩니다. 방송문을 숙지하고 다시 시도해주세요." 명시
계산한 matchRate를 JSON "matchRate" 필드에 반드시 포함하세요.

[카테고리 good 필드 작성 규칙]
각 카테고리의 good 필드는 이 음성에서 실제로 확인된 경우에만 구체적으로 작성.
아래 경우 반드시 "" 반환:
- 발화량이 너무 적어 평가 불가
- 억양이 단조로워 칭찬할 내용 없음
- 발음 오류가 많음
- 분위기/목소리가 기내방송 수준 미달
절대 금지: '발화된 부분이 짧아 평가하기 어려웠습니다' 같은 내용을 good에 넣는 것

[카테고리별 피드백 작성 기준]
유창성:
- 끊어읽기: 실제로 자연스러운 위치에서 끊었는지
- 속도: 체감되는 빠름/느림 구체적으로
- 문안숙지: 버벅임, 반복, 멈춤 횟수 언급
- 말하는 듯한 연출: 낭독체 vs 대화체 구분

분위기/목소리:
- 발성이 실제로 안정적인지
- 톤이 기내방송에 어울리는지
- 미소 느낌이 실제로 있었는지
- 평가 불가한 경우 good = "" 반환

억양(JA) / 성조·억양(CA):
- JA: 문말 です·ます의 실제 처리 방식 명시 (올라갔는지 내려갔는지), 장음 위 불필요한 억양 여부
- CA: 1~4성이 실제로 구분됐는지, 3성+3성 변조가 적용됐는지 구체적으로 명시
- 한국어식 평탄 억양·상향 반복 패턴 있으면 반드시 지적
- 단조로운 경우 good = "" 반환

발음:
- STT에서 감지된 실제 오류만 지적
- 오류가 없으면 good에 구체적으로 언급
- '모든 단어를 정확히' 같은 막연한 칭찬 금지

[허용 예외 사항]
• [목적지][편명][공항] 등 변수 자리 단어 대체
• 선택 문안 중 하나만 말한 경우
• 같은 의미를 살짝 다르게 표현한 경우 (단, 완주율 70% 이상 시)

[선택 문안 처리 규칙 - 매우 중요]
방송문에 아래 패턴의 선택지가 있으면 승무원이 그 중 하나만 골라 읽는 것이 정상:

① [General] / [수하물 과다 반입] 등 상황별 선택
   → 어떤 것을 선택했든 감점 없음
   → 선택하지 않은 섹션을 missedKeywords에 포함하지 말 것

② [기내 수하물이 많아 / 만석으로] 같은 슬래시 선택지
   → 하나만 읽어도 정상
   → 나머지를 누락으로 처리하지 말 것

③ [생략 가능] 태그가 붙은 문장
   → 읽지 않아도 정상, 절대 감점하지 말 것
   → missedKeywords에 포함하지 말 것

④ [필요 시] 태그가 붙은 문장
   → 읽지 않아도 감점 없음

⑤ [10분 초과 지연 시] 등 조건부 문장
   → 해당 조건이 아니면 읽지 않는 것이 정상

채점 시 위 패턴을 제외한 반드시 읽어야 하는 핵심 내용만 완주 여부 체크.
피드백에서 선택 문안 누락 언급 금지.
단, 핵심 안전 키워드([목적지], 편명, 실제 안전 지시사항)는 여전히 체크.

[채점 전 필수 확인 3 — 발음 정밀 분석]
음성 파일을 직접 듣고 아래 항목을 실제로 확인해서 채점하세요. 들리지 않은 항목은 평가하지 말 것.

일본어(JA) 발음 정밀 체크:
- 장음 유지: とうきょう(4박)·ございます·ありがとう의 장음이 살아있는지
- 촉음(っ): しゅっぱつ 등에서 한 박 멈춤이 있는지
- ん 발음: 위치별 처리가 자연스러운지
- 된소리 개입: ございます→'꼬자이마스'처럼 경음화되지 않았는지
- 조사 발음: は→'와', を→'오', へ→'에' 준수 여부
- 모음: う 과도한 원순, え/い 혼동 여부

중국어(CA) 발음 정밀 체크:
- 권설음/설치음: 中(zhōng)·上(shàng)이 座(zuò)·三(sān)처럼 들리지 않는지
- 단운모 ü: 旅(lǚ)를 '루'로 발음하지 않았는지
- 단운모 e: 客(kè)를 '케'로 발음하지 않았는지
- 복운모: 飞机(fēijī)·航班(hángbān)의 앞뒤 모음이 뭉개지지 않았는지
- f/h 혼동: 飞(fēi)를 '훼이'로 발음하지 않았는지
- 성조: 1~4성이 실제로 구분되는지, 한국어식 평탄 읽기가 아닌지

발음 오류 유형별 감점:
- 핵심 단어 오발음 (의미 변화): -3점/개
- 일본어 장음·촉음 탈락 / 중국어 성조 오류: -2점/개
- 기타 경미한 오류: -1점/개
- 최대 감점: -10점

실제 발음 오류를 pronunciationErrors 배열로 반환하세요:
- word: 잘못 발음된 단어 또는 음절
- correct: 올바른 발음 (한국어 또는 IPA 표기)
- error: 오류 유형 간략 설명 (예: "장음 미처리", "연음 오류", "th 발음 누락")
- 오류가 없으면 빈 배열 [] 반환

[채점 신뢰도 원칙]
1. 실제 음성에서 들은 것만 평가
2. 들리지 않은 항목은 평가하지 말 것
3. 잘한 점이 확인되지 않으면 good 필드 빈 문자열
4. 관대한 채점 절대 금지
5. 발음이 명확하지 않으면 낮은 점수

[점수 기준선 - 반드시 이 척도로 채점할 것]
이 앱은 실제 자격 평가(85점 PASS)를 대비하는 훈련 도구다.
후하게 준 점수는 응시자가 준비되지 않은 채 평가에 들어가게 만들어 오히려 해가 된다.
아래 기준을 그대로 적용하고, 격려를 이유로 점수를 올리지 말 것.

  90~100 : 교관 모델 음성에 근접. 장음/촉음(일) 또는 성조(중)가 거의 정확하고 방송 톤이 자연스러움
  85~89  : 실제 평가 통과 수준. 사소한 오류는 있으나 의미 전달과 방송 품질에 문제 없음
  70~84  : 읽어내기는 하나 발음/억양 오류가 반복됨. 실제 평가라면 불합격
  50~69  : 원문을 따라 읽는 수준. 장음이나 성조가 자주 무너지고 낭독체가 뚜렷함
  30~49  : 상당 부분이 부정확하거나 뭉개져 승객에게 의미 전달이 어려움
  0~29   : 방송이라 보기 어려움. 미완주, 극심한 오류, 무성의한 발화

[중요]
- 비전공자의 첫 시도는 대개 45~70점대에 위치한다. 이 구간을 80점대로 올리지 말 것.
- 무성의하게 읽었거나 성의가 느껴지지 않으면 분위기/목소리를 실제로 낮게 줄 것.
- 여러 항목이 부족하면 총점도 그에 맞게 낮아야 한다. 항목은 낮은데 총점만 높은 모순 금지.
- encouragement 는 점수와 모순되지 않아야 한다.
  60점대에 '잘하셨어요' 같은 표현은 금지. 무엇을 고치면 오를지 짚어줄 것.

${criteria}
${cpText}
원문:
${script}`;

  const sharedJson = `아래 JSON만 반환하세요 (설명·주석 없이):
{
  "transcript": "음성에서 실제 발화된 내용 (직접 청취해 전사)",
  "language": "${langCode}",
  "score": 0-100 정수,
  "grade": "PASS" 또는 "FAIL" (score 85이상이면 PASS),
  "matchRate": 0-100 정수 (원문 대비 발화 일치율, 선택 문안 제외),
  "pronunciationErrors": [{"word":"단어","correct":"올바른발음","error":"오류설명"}],
  "categories": {
    "fluency": {
      "score": 0-${maxFluency} 정수,
      "level": "우수" 또는 "보통" 또는 "노력필요",
      "good": "이 음성에서 실제로 확인된 잘된 점 (없으면 빈 문자열 \\"\\")",
      "feedback": "개선이 필요한 부분 구체적으로 (2문장, 어느 구간에서 어떤 문제인지 명시)",
      "practiceTip": "다음 연습에서 바로 해볼 수 있는 구체적 방법 1가지 (예: '○○ 구간을 읽을 때 의도적으로 0.5초 멈춰보세요')"
    },
    "atmosphere": {
      "score": 1-${maxVoice} 정수 (음성이 존재하는 한 반드시 1 이상),
      "level": "우수" 또는 "보통" 또는 "노력필요",
      "good": "이 음성에서 실제로 확인된 잘된 점 (없으면 빈 문자열 \\"\\")",
      "feedback": "개선이 필요한 목소리·톤·분위기 관찰 (2문장)",
      "practiceTip": "구체적 연습 방법 1가지"
    },
    "intonation": {
      "score": 0-${maxInton} 정수,
      "level": "우수" 또는 "보통" 또는 "노력필요",
      "good": "이 음성에서 실제로 확인된 잘된 점 (없으면 빈 문자열 \\"\\")",
      "feedback": "억양 개선이 필요한 부분 (문장 끝 처리 방식·단조로움 등 구체적으로, 2문장)",
      "practiceTip": "구체적 연습 방법 1가지 (예: '문장 끝 단어를 약간 낮춰 읽는 연습을 5번 반복하세요')"
    },
    "pronunciation": {
      "score": 0-${maxPron} 정수,
      "level": "우수" 또는 "보통" 또는 "노력필요",
      "good": "이 음성에서 실제로 확인된 잘된 점 (없으면 빈 문자열 \\"\\")",
      "feedback": "발음 개선이 필요한 부분 구체적으로 (2문장)",
      "practiceTip": "구체적 발음 연습 방법 1가지",
      "details": ["실제 오류 예시만: '○○'를 '△△'처럼 발음했는데, '□□'로 연습하세요 (오류 없으면 빈 배열)"]
    }
  },
  "goodPoints": ["이 음성에서 실제로 잘된 점 1 (구체적으로)", "잘된 점 2 (있으면)"],
  "missedKeywords": ["누락된 핵심 키워드 (실제 누락만)"],
  "nextFocus": "이번 연습에서 가장 먼저 개선할 1가지와 그 이유 (예: '억양 — 문장 끝이 단조롭게 올라가서 승객에게 어색하게 들립니다')",
  "practiceMethod": "nextFocus를 개선하기 위한 단계별 연습 방법 (3줄 이내, 내일 당장 따라할 수 있도록 구체적으로)",
  "encouragement": "점수 수준에 맞는 1문장. 85점 이상이면 격려, 84점 이하면 무엇을 고치면 통과선에 닿는지 구체적으로. 실력과 어긋나는 칭찬 금지"
}

중요: atmosphere(분위기·목소리) score는 반드시 1 이상의 정수를 반환하세요.
음성이 존재하는 한 0점은 절대 불가합니다. (단, 확인 1의 묵음/빈 녹음 규칙이 적용된 경우는 예외)
발성·톤·친근함 각 항목에 최소 점수 기준을 적용하세요.`;

  // ── 1차 시도: /api/gemini 프록시 경유로 audio inlineData 전달 ──
  const audioPrompt = `피드백 필수 규칙:
1. 반드시 이 음성에서 실제로 들린 것만 언급
2. 구체적인 단어나 구간 지목 필수
   (예: '~바랍니다 어미가 올라갔습니다')
   (예: '첫 문장 속도가 빠르다가 중반 안정됨')
3. 매번 다른 표현 사용, 패턴 반복 금지
4. 긍정 관찰 먼저, 개선점 나중에
5. 전문 용어 대신 쉬운 말 사용
6. '발음을 연습하세요' 같은 일반론 절대 금지

이 음성에서 실제로 들은 구체적인 특징을 피드백에 반드시 포함하세요.
- 어느 구간에서 어떤 문제가 발생했는지
- 어떤 단어/문장에서 특히 두드러졌는지
- 이 사람만의 특징적인 패턴이 무엇인지

당신은 항공사 기내방송 전문 교관입니다.
첨부된 음성 파일을 반드시 직접 들으세요. STT 텍스트 변환 없이 실제 음성을 기반으로 평가합니다.
채점 전 아래 순서로 음성을 분석하세요:
1. 전체 음성을 한 번 들으며 전반적인 분위기와 완성도 파악
2. 구간별로 끊어읽기·속도·강조 위치 확인
3. 각 항목 기준에 따라 점수 결정

점수를 줄 때는 반드시 "이 음성에서 들은 구체적 근거"를 피드백에 포함하세요.
"전반적으로 좋습니다" 같은 막연한 피드백은 절대 금지입니다.
${sharedRules}

${sharedJson}`;

  try {
    const _audioController = new AbortController();
    const _audioTimeoutId = setTimeout(() => _audioController.abort(), 60000);
    let res;
    try {
      res = await fetchWithRetry('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: _audioController.signal,
        body: JSON.stringify({
          model: GEMINI_MODEL,
          contents: [{
            parts: [
              { inline_data: { mime_type: audioBlob.type || 'audio/webm', data: base64Audio } },
              { text: audioPrompt }
            ]
          }]
        })
      });
    } finally {
      clearTimeout(_audioTimeoutId);
    }
    if (res.status === 501) {
      console.warn('로컬 환경: 배포 후 테스트 필요');
      return null;
    }
    console.log('Gemini audio 응답 status:', res.status);
    const text = await res.text();
    console.log('Gemini audio 응답 앞 200자:', text.slice(0, 200));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    const data = JSON.parse(text);
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      await _incrementDailyUsage(_empId);
      updateAIUsageBadge();
      console.log('[채점] 오늘 채점 횟수:', _count + 1, '/ 5회');
      return JSON.parse(m[0]);
    }
    throw new Error('응답 JSON 파싱 실패');
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('audio 채점 타임아웃(60초), STT 방식으로 전환');
    } else {
      console.error('audio 채점 실패, STT 텍스트 방식으로 전환:', e);
    }
  }

  // ── 2차 fallback: Web Speech API STT 텍스트로 채점 ──
  const transcript = state.transcript?.trim() || '';
  if (!transcript) return null;

  const textPrompt = `당신은 항공사 기내방송 전문 교관입니다.
아래 STT 인식 텍스트를 기반으로 채점하세요 (음성 파일 전달 실패로 텍스트 방식 전환).
막연한 평가 대신 어떤 부분을 어떻게 연습하면 나아지는지 구체적으로 알려주세요.
${sharedRules}

발화 (STT 인식 결과 — 인식 오류 포함될 수 있음):
${transcript}

${sharedJson}`;

  const _textController = new AbortController();
  const _textTimeoutId = setTimeout(() => _textController.abort(), 60000);
  try {
    const result = await model.generateContent(textPrompt);
    const raw = result.response.text().trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const resData = JSON.parse(m[0]);
      await _incrementDailyUsage(_empId);
      updateAIUsageBadge();
      console.log('[채점] 오늘 채점 횟수:', _count + 1, '/ 5회');
      return resData;
    } catch {
      return null;
    }
  } finally {
    clearTimeout(_textTimeoutId);
  }
}

function renderAiResult(ai, isAdmin) {
  const sec = $('ai-result-section');
  if (!sec) return;

  const score = typeof ai.score === 'number' ? ai.score : 0;
  const grade = ai.grade || '미취득';
  const gradeColor = grade === 'A' ? '#16a34a' : grade === 'B' ? '#2563eb' : grade === 'C' ? '#d97706' : '#dc2626';
  // 합격/불합격을 연상시키는 표현을 쓰지 않는다. 연습 상태만 나타낸다.
  const emojiGrade = score >= 85 ? '🎯 안정적인 연습' : score >= 70 ? '🔍 다듬는 중' : '📌 기초 다지기';
  const maxScores = { fluency: 30, atmosphere: 25, intonation: 25, pronunciation: 20 };
  const catMeta = {
    fluency:       { name: '유창성',       icon: '💨', max: maxScores.fluency },
    atmosphere:    { name: '분위기/목소리', icon: '🎙',  max: maxScores.atmosphere },
    intonation:    { name: '억양',         icon: '〰️', max: maxScores.intonation },
    pronunciation: { name: '발음',         icon: '🗣',  max: maxScores.pronunciation }
  };

  // 방송문 일치도 카드 (90% 미만일 때만 표시, AI 상세 분석 최상단)
  const matchRate = typeof ai.matchRate === 'number' ? ai.matchRate : null;
  let matchRateHtml = '';
  if (matchRate !== null && matchRate < 90) {
    if (matchRate >= 70) {
      matchRateHtml = `<div class="ai-match-card ai-match-warn">
        <div class="ai-match-title">📋 방송문 일치도: ${matchRate}%</div>
        <div class="ai-match-desc">일부 내용이 누락됐습니다.</div>
      </div>`;
    } else {
      matchRateHtml = `<div class="ai-match-card ai-match-danger">
        <div class="ai-match-title">⚠️ 방송문 일치도: ${matchRate}%</div>
        <div class="ai-match-desc">방송문의 절반 이상이 누락됐습니다. 방송문을 충분히 숙지 후 다시 시도해주세요.</div>
      </div>`;
    }
  }

  // 등급 헤더
  const gradeHeaderHtml = `
    <div class="ai-grade-header">
      <span class="ai-grade-badge-new" style="background:${gradeColor}">${emojiGrade}</span>

    </div>`;

  // 카테고리 카드 빌더 (헬퍼)
  const _buildCatCard = (key, cat) => {
    const m = catMeta[key];
    if (!m || !cat) return '';
    const pct   = Math.round((Math.min(cat.score, m.max) / m.max) * 100);
    const level = cat.level || (pct >= 87 ? '우수' : pct >= 60 ? '보통' : '노력필요');
    const bgCls = level === '우수' ? 'ai-card-good' : level === '보통' ? 'ai-card-mid' : 'ai-card-low';
    const lvlCls = level === '우수' ? 'lvl-good' : level === '보통' ? 'lvl-mid' : 'lvl-low';
    const lvlEmoji = level === '우수' ? '🔥' : level === '보통' ? '✅' : '⚠️';
    const goodText  = (cat.good && cat.good.trim()) ? cat.good.trim() : null;
    const fbGood    = goodText
      ? `<div class="ai-card-fb-row ai-card-fb-good"><span class="ai-card-fb-icon">✅</span><div><strong>잘된 점</strong><br>${escHtml(goodText)}</div></div>` : '';
    const fbImprove = cat.feedback?.trim()
      ? `<div class="ai-card-fb-row ai-card-fb-improve"><span class="ai-card-fb-icon">📌</span><div><strong>개선 포인트</strong><br>${escHtml(cat.feedback.trim())}</div></div>` : '';
    const fbTip     = cat.practiceTip
      ? `<div class="ai-card-fb-row ai-card-fb-tip"><span class="ai-card-fb-icon">🎯</span><div><strong>다음 연습 목표</strong><br>${escHtml(cat.practiceTip)}</div></div>` : '';
    const pronDetails = (key === 'pronunciation' && cat.details?.length)
      ? cat.details.map(d => `<div class="ai-pron-detail-item">💬 ${escHtml(d)}</div>`).join('') : '';
    const pronErrors = (key === 'pronunciation' && ai.pronunciationErrors?.length)
      ? `<div class="ai-pron-errors">
          <div class="ai-pron-errors-title">🔍 발음 오류 상세</div>
          ${ai.pronunciationErrors.map(e =>
            `<div class="ai-pron-error-item">
              <div class="ai-pron-error-line1">❌ '${escHtml(e.word)}' → ✅ '${escHtml(e.correct)}'</div>
              <div class="ai-pron-error-desc">${escHtml(e.error)}</div>
            </div>`
          ).join('')}
        </div>` : '';
    return `<div class="ai-cat-card ${bgCls}">
      <div class="ai-cat-card-header">
        <span class="ai-cat-card-icon">${m.icon}</span>
        <span class="ai-cat-card-name">${m.name}</span>
        <span class="ai-cat-level-badge ${lvlCls}">${lvlEmoji} ${level}</span>
        ${isAdmin ? `<span class="ai-cat-score-chip">${cat.score}/${m.max}</span>` : ''}
      </div>
      ${fbGood}${fbImprove}${fbTip}
      ${pronDetails}${pronErrors}
    </div>`;
  };

  // ── 유창성 카드: 헤더+잘된점 공개 / 개선포인트+목표 블러 ──
  const flCat = ai.categories?.fluency;
  let fluencyCardHtml = '';
  if (flCat) {
    const m = catMeta.fluency;
    const pct   = Math.round((Math.min(flCat.score, m.max) / m.max) * 100);
    const level = flCat.level || (pct >= 87 ? '우수' : pct >= 60 ? '보통' : '노력필요');
    const bgCls = level === '우수' ? 'ai-card-good' : level === '보통' ? 'ai-card-mid' : 'ai-card-low';
    const lvlCls = level === '우수' ? 'lvl-good' : level === '보통' ? 'lvl-mid' : 'lvl-low';
    const lvlEmoji = level === '우수' ? '🔥' : level === '보통' ? '✅' : '⚠️';
    const goodText = (flCat.good && flCat.good.trim()) ? flCat.good.trim() : null;
    const fbGood = goodText
      ? `<div class="ai-card-fb-row ai-card-fb-good"><span class="ai-card-fb-icon">✅</span><div><strong>잘된 점</strong><br>${escHtml(goodText)}</div></div>` : '';
    const fbImprove = flCat.feedback?.trim()
      ? `<div class="ai-card-fb-row ai-card-fb-improve"><span class="ai-card-fb-icon">📌</span><div><strong>개선 포인트</strong><br>${escHtml(flCat.feedback.trim())}</div></div>` : '';
    const fbTip = flCat.practiceTip
      ? `<div class="ai-card-fb-row ai-card-fb-tip"><span class="ai-card-fb-icon">🎯</span><div><strong>다음 연습 목표</strong><br>${escHtml(flCat.practiceTip)}</div></div>` : '';
    const blurredRows = (fbImprove || fbTip) ? `${fbImprove}${fbTip}` : '';
    fluencyCardHtml = `<div class="ai-cat-card ${bgCls}">
      <div class="ai-cat-card-header">
        <span class="ai-cat-card-icon">${m.icon}</span>
        <span class="ai-cat-card-name">${m.name}</span>
        <span class="ai-cat-level-badge ${lvlCls}">${lvlEmoji} ${level}</span>
        ${isAdmin ? `<span class="ai-cat-score-chip">${flCat.score}/${m.max}</span>` : ''}
      </div>
      ${fbGood}
      ${blurredRows}
    </div>`;
  }

  // ── 블러 영역: 잘한점박스 + 분위기/억양/발음 + 누락 + 핵심목표 ──
  const goodPointsHtml = (ai.goodPoints?.length && score >= 70)
    ? `<div class="ai-good-points-box">
        <div class="ai-good-points-label">👏 잘하셨어요!</div>
        ${ai.goodPoints.map(p => `<div class="ai-good-point-item">✓ ${escHtml(p)}</div>`).join('')}
      </div>` : '';

  const blurredCatCardsHtml = ['atmosphere','intonation','pronunciation']
    .map(key => _buildCatCard(key, ai.categories?.[key])).join('');

  const missedHtml = ai.missedKeywords?.length
    ? `<div class="ai-missed-box">
        <div class="ai-missed-label">⚠️ 누락된 핵심 내용</div>
        <div class="ai-missed-subtitle">아래 내용이 방송에 포함되지 않았습니다</div>
        <div class="ai-missed-list">${ai.missedKeywords.map(k => `<span class="ai-missed-item">${escHtml(k)}</span>`).join('')}</div>
      </div>` : '';

  const nextFocusHtml = (ai.nextFocus || ai.improvementTip)
    ? `<div class="ai-focus-card">
        <div class="ai-focus-title">🎯 이번 핵심 개선 목표</div>
        <div class="ai-focus-content">${escHtml(ai.nextFocus || ai.improvementTip)}</div>
        ${ai.practiceMethod
          ? `<div class="ai-focus-method"><span class="ai-pm-label">💡 단계별 연습 방법</span> ${escHtml(ai.practiceMethod)}</div>` : ''}
      </div>` : '';

  // ── 응원 카드 (공개) ──
  let encourageHtml = '';
  if (ai.encouragement) {
    const encCls  = score >= 85 ? 'ai-encourage-green' : score >= 70 ? 'ai-encourage-blue' : 'ai-encourage-orange';
    const encIcon = score >= 85 ? '✨' : score >= 70 ? '👍' : '💪';
    const encExtra = score < 70
      ? `<div class="ai-encourage-extra">노력하는 과정이 실력이 됩니다.<br>체크리스트를 다시 확인하고 연습해보세요!</div>` : '';
    encourageHtml = `<div class="ai-encourage-card ${encCls}">${encIcon} ${escHtml(ai.encouragement)}${encExtra}</div>`;
  }

  sec.innerHTML = `
    <div class="ai-result-heading">🤖 AI 상세 분석</div>
    ${matchRateHtml}
    ${gradeHeaderHtml}
    ${fluencyCardHtml}
    ${goodPointsHtml}
    ${blurredCatCardsHtml}
    ${missedHtml}
    ${nextFocusHtml}
    ${encourageHtml}
  `;
  console.log('[완료] AI 상세 분석 렌더링');
}

// ===== ADMIN =====
function openAdminScreen() {
  requireEditAuth(() => {
    initFirebase();
    _refreshAdminVersion();
    _refreshAdminVersionList();
    _setupAdminMvSection();
    _loadAdminUserList().then(() => {
      _checkAndAutoSyncAccessLogs();
    });
    _loadTodayLaunchCount();
    showScreen('screen-admin');
  });
}

// 과거 접속 기록이 allowedUsers에 아직 소급 반영되지 않았으면 백그라운드 1회 자동 동기화
async function _checkAndAutoSyncAccessLogs() {
  if (!_db || !_adminAllowedUsers.length) return;
  const hasUnsynced = _adminAllowedUsers.some(u => u.lastAccessAt && !u.totalLoginDays);
  if (hasUnsynced) {
    console.log('[접속로그] 과거 접속 데이터 소급 동기화 자동 시작...');
    await _syncPastAccessLogsToAllowedUsers();
  }
}

// 오늘 하루 앱 실행 인원(로그인 여부 무관, 누적) 조회
async function _loadTodayLaunchCount() {
  const el = $('admin-today-launch-count');
  if (!el || !_db) return;
  el.textContent = '조회 중...';
  try {
    const dateStr = _kstDateStr();
    const snap = await _db.collection(JACA_DB.appLaunches).where('date', '==', dateStr).get();
    const total = snap.size;
    const loggedIn = snap.docs.filter(d => d.data().isLoggedIn).length;
    el.textContent = `오늘 앱 실행: 총 ${total}명 (그중 로그인 완료 ${loggedIn}명)`;
  } catch (e) {
    el.textContent = '조회 실패';
    console.warn('[오늘실행인원] 조회 실패:', e.message);
  }
}

// ===== ADMIN MODEL VOICE MANAGEMENT =====
let _adminMvLang = 'ko';

function _setupAdminMvSection() {
  const select = $('admin-mv-script');
  if (!select) return;
  const optionsHtml = '<option value="">-- 방송문 선택 --</option>' +
    _allScripts.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.title)}</option>`).join('');
  select.innerHTML = optionsHtml;
  const cnSelect = $('admin-cn-script');
  if (cnSelect) cnSelect.innerHTML = optionsHtml;
  select.onchange = () => {
    const id = select.value;
    $('admin-mv-panel').classList.toggle('hidden', !id);
    if (id) _renderAdminMvBody(id, _adminMvLang);
  };
  document.querySelectorAll('#admin-mv-lang-tabs .mv-lang-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('#admin-mv-lang-tabs .mv-lang-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      _adminMvLang = tab.dataset.lang;
      const id = $('admin-mv-script').value;
      if (id) _renderAdminMvBody(id, _adminMvLang);
    };
  });
}

// 로컬 모델 음성 자동 스캔 → Firestore scripts/{id}.modelFiles 저장
async function _scanLocalModelVoices() {
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('[스캔] 현재 사용자:', auth?.currentUser?.email);
  const btn = $('btn-admin-scan-mv');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 스캔 중...'; }
  try {
    const matched = await _doScanLocalModelVoices();
    const _lackN = _mvMissing.length;
    showToast(_lackN
      ? `✅ ${matched}개 매핑 완료 · ${_lackN}편은 일부 언어 음성 누락 (콘솔 확인)`
      : `✅ ${matched}개 방송문 매핑 완료`, _lackN ? 6000 : 3000);
    console.log(`[스캔] ${matched}개 방송문 modelFiles 저장 완료`);
  } catch (e) {
    showToast(`스캔 실패: ${e.message}`);
    console.error('[스캔] 오류:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📂 로컬 모델 음성 스캔'; }
  }
}

async function _resetAndRescanModelVoices() {
  if (!confirm('scripts 컬렉션의 modelFiles 필드를 전부 삭제하고 재스캔합니다.\n계속하시겠습니까?')) return;

  const btn = $('btn-admin-reset-scan-mv');
  const scanBtn = $('btn-admin-scan-mv');
  [btn, scanBtn].forEach(b => { if (b) b.disabled = true; });
  if (btn) btn.textContent = '⏳ 초기화 중...';

  try {
    if (!_db) throw new Error('Firebase 연결이 필요합니다');

    const snap = await _db.collection(JACA_DB.scripts).get(); // JA·CA 전용만 초기화 (Voice Pro 음성 연결은 건드리지 않음)
    if (snap.docs.length > 0) {
      const batch = _db.batch();
      snap.docs.forEach(doc => {
        batch.update(doc.ref, { modelFiles: firebase.firestore.FieldValue.delete() });
      });
      await batch.commit();
    }
    Object.keys(_mvUrlCache).forEach(k => delete _mvUrlCache[k]);

    if (btn) btn.textContent = '⏳ 재스캔 중...';
    const matched = await _doScanLocalModelVoices();
    showToast(`✅ ${matched}개 방송문 재매핑 완료`);
  } catch (e) {
    showToast(`초기화/재스캔 실패: ${e.message}`);
    console.error('[초기화]', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ 전체 초기화 후 재스캔'; }
    if (scanBtn) scanBtn.disabled = false;
  }
}

function _renderAdminMvBody(scriptId, lang) {
  const body = $('admin-mv-body');
  if (!body) return;
  const stored = localStorage.getItem(`cabinvoice_voice_${scriptId}_${lang}`);
  const name = localStorage.getItem(`cabinvoice_voice_${scriptId}_${lang}_name`) || '등록됨';
  body.innerHTML = (stored
    ? `<div class="mv-current" style="margin-bottom:10px">
        <span class="mv-icon">🎵</span>
        <span class="mv-name" style="flex:1">${escHtml(name)}</span>
        <button type="button" class="btn-icon sm" id="admin-mv-play">▶ 재생</button>
        <button type="button" class="btn-icon sm mv-del-btn" id="admin-mv-del">✕ 삭제</button>
       </div>` : '')
    + `<label class="mv-upload-btn">📁 음성 파일 업로드 (MP3/WAV)
        <input type="file" id="admin-mv-file" accept="audio/*" style="display:none">
       </label>`;
  document.getElementById('admin-mv-file')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      saveModelVoiceLang(scriptId, lang, ev.target.result, file.name);
      _renderAdminMvBody(scriptId, lang);
      console.log(`[어드민] ${scriptId}/${lang} 모델 음성 저장: ${file.name}`);
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('admin-mv-play')?.addEventListener('click', () => {
    const b = loadModelVoice(scriptId, lang);
    if (b) new Audio(b).play();
  });
  document.getElementById('admin-mv-del')?.addEventListener('click', () => {
    deleteModelVoiceLang(scriptId, lang);
    _renderAdminMvBody(scriptId, lang);
    console.log(`[어드민] ${scriptId}/${lang} 모델 음성 삭제`);
  });
}

function _refreshAdminVersion() {
  const el = $('admin-deployed-badge');
  if (!_db) { initFirebase(); }
  if (!_db) { el.textContent = 'Firebase 미연결'; el.style.background='#fee2e2'; return; }
  firestoreLoadLatest().then(data => {
    if (data) {
      el.textContent = `${data.revVersion} · ${new Date(data.updatedAt?.seconds*1000||Date.now()).toLocaleDateString('ko')} 배포`;
      el.style.background='#dcfce7';
    } else {
      el.textContent = '배포된 버전 없음';
      el.style.background='#fef9c3';
    }
  });
}

function _refreshAdminVersionList() {
  const el = $('admin-version-list');
  if (!_db) return;
  firestoreLoadHistory().then(list => {
    if (!list.length) {
      el.innerHTML = '<div style="color:var(--gray-400);font-size:13px">버전 이력이 없습니다.</div>';
      return;
    }
    el.innerHTML = list.map(v => `
      <div class="admin-version-item">
        <div class="admin-version-info">
          <strong>${v.revVersion}</strong>
          <span class="admin-version-date">${new Date(v.updatedAt?.seconds*1000||Date.now()).toLocaleString('ko')}</span>
          <span class="admin-version-count">${v.announcements?.length||0}개</span>
        </div>
        <button class="btn-icon sm" data-rev="${v.revVersion}" id="rollback-${v.revVersion.replace(/\./g,'-')}">롤백</button>
      </div>`).join('');
    el.querySelectorAll('[data-rev]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`${btn.dataset.rev} 버전으로 롤백하시겠습니까?`)) return;
        try {
          await firestoreRollback(btn.dataset.rev);
          alert('롤백 완료. 앱을 새로고침하면 적용됩니다.');
          _refreshAdminVersion();
        } catch(e) { alert(`롤백 실패: ${e.message}`); }
      });
    });
  });
}

async function deployJsonToFirestore() {
  const fileInput = $('admin-json-input');
  const file = fileInput?.files?.[0];
  if (!file) { alert('announcements.json 파일을 선택해주세요.'); return; }

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch { alert('JSON 파싱 오류: 올바른 JSON 파일인지 확인해주세요.'); return; }

  if (!data.announcements || !Array.isArray(data.announcements) || !data.revVersion) {
    alert('올바른 announcements.json 형식이 아닙니다.\n(revVersion, announcements 필드 필요)');
    return;
  }

  if (!confirm(`${data.announcements.length}개 방송문을 ${data.revVersion}으로 Firestore에 업로드하시겠습니까?`)) return;

  const btn = $('btn-admin-json-deploy');
  btn.disabled = true; btn.textContent = '업로드 중...';
  try {
    if (!_db) { initFirebase(); }
    if (!_db) throw new Error('Firebase 연결에 실패했습니다.');
    await firestoreSaveLatest({
      revVersion: data.revVersion,
      updatedAt: firebase.firestore.Timestamp.now(),
      announcements: data.announcements
    });
    localStorage.setItem('cabinvoice_scripts_cache', JSON.stringify({
      rev: data.revVersion, announcements: data.announcements, ts: Date.now()
    }));
    alert(`${data.revVersion} 업로드 완료! (${data.announcements.length}개 방송문)\n앱을 새로고침하면 반영됩니다.`);
    _refreshAdminVersion();
    _refreshAdminVersionList();
  } catch(e) {
    alert(`업로드 실패: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Firestore에 업로드';
  }
}

// ===== ADMIN: 사용자 관리 (allowedUsers) =====
const ADMIN_USER_INACTIVE_DAYS = 30;
let _adminAllowedUsers = []; // [{id, name, createdAt, lastAccessAt}]
let _adminUserSearchText = '';
let _adminUserSortMode = 'registered';


async function _loadAdminUserList() {
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }
  const listEl = $('admin-user-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="padding:10px;font-size:13px;color:var(--gray-400)">로딩 중...</div>';
  try {
    const snap = await _db.collection('allowedUsers').get();
    _adminAllowedUsers = snap.docs.map(d => {
      const data = _jacaUserView(d.data()); // JA·CA 전용 통계만 사용
      return {
        id: d.id,
        name: data.name || '',
        createdAt: data.createdAt,
        lastAccessAt: data.lastAccessAt || null,
        totalLoginDays: data.totalLoginDays || 0,
        totalPracticeSeconds: data.totalPracticeSeconds || 0,
        totalEvalCount: data.totalEvalCount || 0,
        ...data
      };
    });
  } catch (e) {
    listEl.innerHTML = `<div style="padding:10px;font-size:13px;color:var(--color-fail)">조회 실패: ${escHtml(e.message)}</div>`;
    return;
  }
  _renderAdminUserList();
}

function _isAdminUserInactive(u) {
  const last = u.lastAccessAt?.toMillis?.();
  if (!last) return true; // 한 번도 접속 안 함
  return (Date.now() - last) / 86400000 >= ADMIN_USER_INACTIVE_DAYS;
}

function _sortedFilteredAdminUsers() {
  const q = _adminUserSearchText.trim().toLowerCase();
  let list = !q
    ? _adminAllowedUsers
    : _adminAllowedUsers.filter(u => u.id.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));

  list = [...list];
  const lastMs = u => u.lastAccessAt?.toMillis?.() ?? -1;
  if (_adminUserSortMode === 'recent') {
    list.sort((a, b) => lastMs(b) - lastMs(a));
  } else if (_adminUserSortMode === 'inactive') {
    list.sort((a, b) => lastMs(a) - lastMs(b));
  } else {
    list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  }
  return list;
}

function _renderAdminUserList() {
  const listEl = $('admin-user-list');
  if (!listEl) return;
  $('admin-user-count').textContent = _adminAllowedUsers.length;

  const thisYear = _kstDateStr().slice(0, 4);
  const thisMonthKey = 'evalCount_' + _kstDateStr().slice(0, 7).replace('-', '_');

  const list = _sortedFilteredAdminUsers();
  if (!list.length) {
    listEl.innerHTML = `<div style="padding:10px;font-size:13px;color:var(--gray-400)">${_adminAllowedUsers.length ? '검색 결과가 없습니다.' : '등록된 사번이 없습니다.'}</div>`;
  } else {
    listEl.innerHTML = list.map(u => {
      const regDate  = u.createdAt?.toDate ? u.createdAt.toDate().toLocaleDateString('ko-KR') : '-';
      const lastDate = u.lastAccessAt?.toDate ? u.lastAccessAt.toDate().toLocaleDateString('ko-KR') : '미접속';
      const inactive = _isAdminUserInactive(u);

      const loginDays = u[`loginDays_${thisYear}`] || u.totalLoginDays || 0;
      const evalThisMonth = u[thisMonthKey] || 0;
      const totalEval = u.totalEvalCount || 0;
      const studyDisplay = _formatPracticeTimeDisplay(u.totalStudySeconds, u.totalPracticeSeconds);

      return `<div class="admin-user-item" style="flex-wrap:wrap;gap:6px;align-items:center;">
        <span class="admin-user-item-id" style="min-width:70px;">${escHtml(u.id)}</span>
        ${u.name ? `<span class="admin-user-item-name" style="min-width:60px;">${escHtml(u.name)}</span>` : ''}
        <span class="admin-user-item-date" style="font-size:12px;color:var(--gray-500);">
          접속: <strong>${loginDays}일</strong> · 학습: <strong>${studyDisplay}</strong> · AI평가: <strong>${evalThisMonth}회</strong>(당월)/${totalEval}회(총) · 최근: ${escHtml(lastDate)}
        </span>
        ${inactive ? `<span class="admin-user-item-badge">⚠️ 장기 미접속</span>` : ''}
        <div style="margin-left:auto;display:flex;gap:4px;">
          <button class="btn-icon sm admin-user-reset-pw-btn" data-id="${escHtml(u.id)}" data-name="${escHtml(u.name)}" style="color:#003479;border-color:#003479;" title="초기 비밀번호(Jeju+사번앞4자리)로 초기화">🔑 PW 초기화</button>
          <button class="btn-icon sm admin-user-del-btn" data-id="${escHtml(u.id)}" data-name="${escHtml(u.name)}">✕ 삭제</button>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.admin-user-reset-pw-btn').forEach(btn => {
      btn.addEventListener('click', () => _resetUserPassword(btn.dataset.id, btn.dataset.name));
    });
    listEl.querySelectorAll('.admin-user-del-btn').forEach(btn => {
      btn.addEventListener('click', () => _deleteAdminUser(btn.dataset.id, btn.dataset.name));
    });
  }

  _renderAdminUserSummary();
}

// 개별 사용자 비밀번호 초기화 (초기값: Jeju + 사번 앞 4자리)
async function _resetUserPassword(empId, name) {
  const defaultPw = 'Jeju' + String(empId).slice(0, 4);
  const label = name ? `${name}(사번: ${empId})` : `사번 ${empId}`;
  if (!confirm(`${label}의 비밀번호를 초기화하시겠습니까?\n\n• 초기 비밀번호: ${defaultPw}\n• 다음 로그인 시 본인 비밀번호 변경 화면이 표출됩니다.`)) return;

  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }
  try {
    await _db.collection('allowedUsers').doc(empId).set({
      password: defaultPw,
      mustChangePassword: empId !== '1603064',
      active: true
    }, { merge: true });
    alert(`✅ ${label}의 비밀번호가 초기화되었습니다.\n\n초기 비밀번호: ${defaultPw}`);
    _loadAdminUserList();
  } catch (e) {
    showToast(`비밀번호 초기화 실패: ${e.message}`, 3000);
  }
}

function _renderAdminUserSummary() {
  const summaryEl = $('admin-user-summary');
  if (!summaryEl) return;
  const total = _adminAllowedUsers.length;
  const thisMonth = _kstDateStr().slice(0, 7); // YYYY-MM
  const activeThisMonth = _adminAllowedUsers.filter(u => {
    const d = u.lastAccessAt?.toDate?.();
    return d && _kstDateStr(d).slice(0, 7) === thisMonth;
  }).length;
  const inactiveCount = _adminAllowedUsers.filter(_isAdminUserInactive).length;
  summaryEl.textContent = `총 ${total}명 등록 / 이번 달 접속 ${activeThisMonth}명 / 장기 미접속 ${inactiveCount}명`;
}

async function _addAdminUser() {
  showToast(JACA_ACCOUNT_MSG, 4000); return; // 공용 계정 보호
  const input = $('admin-user-add-input');
  const nameInput = $('admin-user-name-input');
  const rawId = input.value.trim();
  const name = nameInput ? nameInput.value.trim() : '';
  if (!rawId) return;
  if (!/^\d+$/.test(rawId)) { showToast('사번은 숫자만 입력해주세요.', 2000); return; }
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }

  const empId = String(rawId).padStart(7, '0');
  const defaultPw = 'Jeju' + empId.slice(0, 4);

  try {
    await _db.collection('allowedUsers').doc(empId).set({
      employeeId: empId,
      empId,
      name,
      password: defaultPw,
      active: true,
      mustChangePassword: empId !== '1603064',
      isAdmin: empId === '1603064',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    input.value = '';
    if (nameInput) nameInput.value = '';
    showToast(`추가되었습니다 ✓ (초기 비밀번호: ${defaultPw})`, 3000);
    _loadAdminUserList();
  } catch (e) {
    showToast(`추가 실패: ${e.message}`, 3000);
  }
}

async function _deleteAdminUser(empId, name) {
  showToast(JACA_ACCOUNT_MSG, 4000); return; // 공용 계정 보호
  const label = name ? `${name}(사번: ${empId})` : `사번 ${empId}`;
  if (!confirm(`${label}을 삭제하시겠습니까?\n삭제 즉시 접근이 차단됩니다.`)) return;
  try {
    await _db.collection('allowedUsers').doc(empId).delete();
    showToast('접근 차단 완료');
    _loadAdminUserList();
  } catch (e) {
    showToast(`삭제 실패: ${e.message}`, 3000);
  }
}

async function _deleteAllAdminUsers() {
  showToast(JACA_ACCOUNT_MSG, 4000); return; // 공용 계정 보호
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }
  if (!_adminAllowedUsers.length) { showToast('삭제할 사용자가 없습니다.', 2000); return; }
  if (!confirm('전체 사용자를 삭제하시겠습니까?')) return;

  requireEditAuth(async () => {
    const btn = $('btn-admin-user-delete-all');
    if (btn) { btn.disabled = true; btn.textContent = '삭제 중...'; }
    try {
      const snap = await _db.collection('allowedUsers').get();
      const docs = snap.docs;
      const BATCH_LIMIT = 400;
      for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
        const batch = _db.batch();
        docs.slice(i, i + BATCH_LIMIT).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      showToast('전체 삭제 완료. 새 명단을 업로드해주세요.', 4000);
      $('admin-user-empty-cta')?.classList.remove('hidden');
      _loadAdminUserList();
    } catch (e) {
      showToast(`전체 삭제 실패: ${e.message}`, 3000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🗑 전체 삭제'; }
    }
  }, { forcePrompt: true });
}


// ===== 직원 일괄 등록 =====

// CSV/직접 입력 텍스트 파싱 → [{empId, name, password}]
function _parseBulkCsvData(text, autoPw) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = [];
  for (const line of lines) {
    // 헤더 행 감지 (사번이 숫자가 아닌 경우 스킵)
    const parts = line.split(',').map(p => p.trim());
    const rawId = parts[0] || '';
    if (!rawId || !/^\d+$/.test(rawId)) continue;
    const empId = String(rawId).padStart(7, '0');
    const name = parts[1] || '';
    let password = parts[2] || '';
    if (!password || autoPw) {
      // 규칙: Jeju + 사번 앞 4자리 (예: 1603064 → Jeju1603)
      password = 'Jeju' + empId.slice(0, 4);
    }
    result.push({ empId, name, password });
  }
  return result;
}

// 파싱 데이터 미리보기 테이블 렌더
async function _renderBulkPreview(parsedData) {
  const tbody = $('admin-bulk-preview-tbody');
  const summary = $('admin-bulk-preview-summary');
  const wrap = $('admin-bulk-preview-wrap');
  if (!tbody || !summary || !wrap) return;

  // Firestore에서 기존 사번 목록 조회
  let existingIds = new Set();
  if (_db) {
    try {
      const snap = await _db.collection('allowedUsers').get();
      existingIds = new Set(snap.docs.map(d => d.id));
    } catch (e) { console.warn('[일괄등록] 기존 사용자 조회 실패:', e.message); }
  }

  let newCount = 0, updateCount = 0, errorCount = 0;
  tbody.innerHTML = parsedData.map(({ empId, name, password }) => {
    const isNew = !existingIds.has(empId);
    const isError = !empId || !/^\d+$/.test(empId);
    let statusText, statusStyle;
    if (isError) { statusText = '오류'; statusStyle = 'color:#C0392B;font-weight:700'; errorCount++; }
    else if (isNew) { statusText = '신규'; statusStyle = 'color:#003479;font-weight:600'; newCount++; }
    else { statusText = '업데이트'; statusStyle = 'color:var(--color-warning);font-weight:600'; updateCount++; }
    return `<tr style="border-bottom:1px solid var(--color-border)">
      <td style="padding:5px 10px">${escHtml(empId)}</td>
      <td style="padding:5px 10px">${escHtml(name)}</td>
      <td style="padding:5px 10px;font-family:monospace">${escHtml(password)}</td>
      <td style="padding:5px 10px;${statusStyle}">${statusText}</td>
    </tr>`;
  }).join('');

  summary.textContent = `신규 ${newCount}명 / 업데이트 ${updateCount}명 / 오류 ${errorCount}건`;
  wrap.classList.remove('hidden');
  $('btn-admin-user-bulk-add').disabled = parsedData.length === 0;
  console.log('[완료] 일괄 등록 미리보기');
}

// 파싱 소스 가져오기 (CSV 파일 또는 textarea)
let _bulkParsedData = [];

async function _handleAdminUserExcel(file) {
  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(data), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    // 또 CSV라면 SheetJS가 같은 방식으로 처리
    const csvText = rows.map(r => r.join(',')).join('\n');
    const autoPw = $('admin-bulk-auto-pw')?.checked || false;
    _bulkParsedData = _parseBulkCsvData(csvText, autoPw);
    if ($('admin-bulk-paste-textarea')) $('admin-bulk-paste-textarea').value = csvText;
    await _renderBulkPreview(_bulkParsedData);
  } catch (err) {
    showToast(`파일 파싱 실패: ${err.message}`, 3000);
  }
}

async function bulkRegisterEmployees(data) {
  showToast(JACA_ACCOUNT_MSG, 4000); return; // 공용 계정 보호
  if (!data.length) return;
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }

  const progWrap = $('admin-bulk-progress-wrap');
  const progText = $('admin-bulk-progress-text');
  const progBar  = $('admin-bulk-progress-bar');
  const btn      = $('btn-admin-user-bulk-add');

  if (progWrap) progWrap.classList.remove('hidden');
  if (btn) { btn.disabled = true; btn.textContent = '등록 중...'; }

  const total = data.length;
  let success = 0, failed = 0;

  // 500개단 batch 쮸 한하
  const BATCH_LIMIT = 500;
  for (let i = 0; i < total; i += BATCH_LIMIT) {
    const batch = _db.batch();
    const chunk = data.slice(i, i + BATCH_LIMIT);
    for (const emp of chunk) {
      if (!emp.empId || !emp.password) { failed++; continue; }
      const ref = _db.collection('allowedUsers').doc(emp.empId);
      batch.set(ref, {
        employeeId: emp.empId,
        empId: emp.empId,
        name: emp.name || '',
        password: emp.password,
        active: true,
        mustChangePassword: emp.empId !== '1603064',
        isAdmin: emp.empId === '1603064',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastLogin: null
      }, { merge: true });
      success++;
    }
    await batch.commit();

    // 진행률 업데이트
    const done = Math.min(i + BATCH_LIMIT, total);
    const pct = Math.round((done / total) * 100);
    if (progText) progText.textContent = `${done} / ${total} 등록 중...`;
    if (progBar)  progBar.style.width = pct + '%';
  }

  if (progWrap) progWrap.classList.add('hidden');
  if (btn) { btn.disabled = false; btn.textContent = '📋 일괄 등록 시작'; }

  showToast(`✅ ${success}명 등록 완료, ${failed}명 실패`, 4000);
  _bulkParsedData = [];
  $('admin-bulk-preview-wrap')?.classList.add('hidden');
  $('admin-bulk-paste-textarea') && ($('admin-bulk-paste-textarea').value = '');
  $('admin-user-excel-input') && ($('admin-user-excel-input').value = '');
  $('admin-user-empty-cta')?.classList.add('hidden');
  _loadAdminUserList();
  console.log('[완료] 직원 일괄 등록');
}

function _downloadAdminUserListCsv() {
  if (!_adminAllowedUsers.length) { showToast('등록된 사번이 없습니다.', 2000); return; }
  const thisYear = _kstDateStr().slice(0, 4);
  const thisMonthKey = 'evalCount_' + _kstDateStr().slice(0, 7).replace('-', '_');

  const header = '사번,이름,올해 접속일수,총 접속일수,총 연습시간(초),총 연습시간(표시),이번달 AI평가횟수,총 AI평가횟수,등록일,마지막 접속일\n';
  const rows = _adminAllowedUsers.map(u => {
    const regDate  = u.createdAt?.toDate ? u.createdAt.toDate().toLocaleDateString('ko-KR') : '';
    const lastDate = u.lastAccessAt?.toDate ? u.lastAccessAt.toDate().toLocaleDateString('ko-KR') : '';
    const loginDaysYear = u[`loginDays_${thisYear}`] || 0;
    const totalLoginDays = u.totalLoginDays || 0;
    const practiceSec = u.totalPracticeSeconds || 0;
    const practiceStr = _formatSeconds(practiceSec);
    const evalMonth = u[thisMonthKey] || 0;
    const totalEval = u.totalEvalCount || 0;

    return `${u.id},${u.name || ''},${loginDaysYear},${totalLoginDays},${practiceSec},${practiceStr},${evalMonth},${totalEval},${regDate},${lastDate}`;
  }).join('\n');

  const csv = '﻿' + header + rows;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `allowedUsers_stats_${_kstDateStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}


// ===== 교범 붙여넣기 변환 =====
// 교범 PDF에서 복사한 텍스트를 앱 형식(독음 줄 + 원문 줄)으로 정리한다.
// 원문을 바꾸지 않고 짝짓기·잡음 제거만 하며, 결과를 사용자가 확인·수정 후 반영한다.
let _camImportLang = 'ja';

function _openCamImport(lang) {
  _camImportLang = lang;
  $('cam-import-lang').textContent = lang === 'ca' ? '중국어(中文)로 변환' : '일본어(日本語)로 변환';
  $('cam-import-input').value = '';
  $('cam-import-output').value = '';
  $('cam-import-result').classList.add('hidden');
  $('cam-import-warn').classList.add('hidden');
  $('cam-import-apply').disabled = true;
  $('cam-import-modal').classList.remove('hidden');
  setTimeout(() => $('cam-import-input').focus(), 50);
}
function _closeCamImport() { $('cam-import-modal').classList.add('hidden'); }

function _runCamImport() {
  const raw = $('cam-import-input').value;
  if (!raw.trim()) { showToast('붙여넣은 내용이 없습니다', 2500); return; }
  if (typeof CamImport === 'undefined') { showToast('변환기를 불러오지 못했습니다', 3000); return; }
  let r;
  try { r = CamImport.convert(raw, _camImportLang); }
  catch (e) { console.error('[교범 변환]', e); showToast('변환 실패: ' + e.message, 4000); return; }

  if (!r.text.trim()) { showToast('변환할 방송문을 찾지 못했습니다', 3000); return; }

  $('cam-import-output').value = r.text;
  $('cam-import-result').classList.remove('hidden');
  $('cam-import-apply').disabled = false;

  const w = $('cam-import-warn');
  if (r.warnings.length) {
    w.innerHTML = `⚠️ <b>확인 필요 ${r.warnings.length}건</b> — 독음과 원문의 개수가 맞지 않는 구간입니다.` +
      `<ul>${r.warnings.slice(0, 6).map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`;
    w.classList.remove('hidden');
  } else {
    w.classList.add('hidden');
  }
  showToast(`${r.blocks}개 구간 변환 완료`, 2500);
}

function _applyCamImport() {
  const ta = document.getElementById(`custom-text-${_camImportLang}`);
  if (!ta) return;
  const out = $('cam-import-output').value;
  if (!out.trim()) return;
  if (ta.value.trim() && !confirm('입력창의 기존 내용이 대체됩니다. 계속할까요?')) return;
  ta.value = out;
  _closeCamImport();
  showToast('✅ 입력창에 반영했습니다', 3000);
}

// 과거 accessLogs 원본 기록을 읽어 allowedUsers의 접속일수(totalLoginDays / loginDays_YYYY)로 소급 동기화
async function _syncPastAccessLogsToAllowedUsers() {
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }
  const btn = $('btn-admin-user-sync-logs');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 동기화 중...'; }
  try {
    const snap = await _db.collection(JACA_DB.accessLogs).get();
    if (snap.empty) {
      showToast('accessLogs 데이터가 없습니다.', 2500);
      return;
    }

    // empId -> { years: { 2026: Set(...) }, totalDates: Set(...) }
    const userStats = {};
    snap.docs.forEach(d => {
      const data = d.data();
      const empId = data.employeeId;
      const date = data.date || '';
      if (!empId || !date) return;
      const year = date.slice(0, 4);
      if (!userStats[empId]) {
        userStats[empId] = { years: {}, totalDates: new Set() };
      }
      if (!userStats[empId].years[year]) {
        userStats[empId].years[year] = new Set();
      }
      userStats[empId].years[year].add(date);
      userStats[empId].totalDates.add(date);
    });

    const entries = Object.entries(userStats);
    const BATCH_LIMIT = 400;
    let updatedCount = 0;

    for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
      const batch = _db.batch();
      const chunk = entries.slice(i, i + BATCH_LIMIT);
      chunk.forEach(([empId, stat]) => {
        const ref = _db.collection('allowedUsers').doc(empId);
        const payload = {
          totalLoginDays: stat.totalDates.size,
        };
        Object.entries(stat.years).forEach(([yr, dateSet]) => {
          payload[`loginDays_${yr}`] = dateSet.size;
        });
        batch.set(ref, _jacaStatFields(payload), { merge: true });
        updatedCount++;
      });
      await batch.commit();
    }

    showToast(`✅ ${updatedCount}명 과거 접속일수 소급 동기화 완료!`, 3500);
    await _loadAdminUserList();
    await _loadAdminAccessLogs();
  } catch (e) {
    showToast(`동기화 실패: ${e.message}`, 3500);
    console.error('[접속로그 소급 동기화]', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 접속일수 소급 동기화'; }
  }
}

// ===== ADMIN: 접속 로그 조회 =====
let _adminLogRows = [];

async function _loadAdminAccessLogs() {
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }
  const period = $('admin-log-period').value;
  const listEl = $('admin-log-list');
  listEl.innerHTML = '<div style="padding:10px;font-size:13px;color:var(--gray-400)">로딩 중...</div>';

  const thisYear = _kstDateStr().slice(0, 4);
  const thisMonthKey = 'evalCount_' + _kstDateStr().slice(0, 7).replace('-', '_');

  try {
    // 1. [올해 전체] 조회: 대량 로그 쿼리 없이 allowedUsers의 연간 누적 데이터를 0.1초 만에 즉시 표출 (비용 0원)
    if (period === 'year') {
      const activeUsers = _adminAllowedUsers.filter(u => {
        const yDays = u[`loginDays_${thisYear}`] || u.totalLoginDays || 0;
        const last = u.lastAccessAt?.toDate ? _kstDateStr(u.lastAccessAt.toDate()) : '';
        return yDays > 0 || last.startsWith(thisYear);
      });

      _adminLogRows = activeUsers.map(u => {
        const yDays = u[`loginDays_${thisYear}`] || u.totalLoginDays || 0;
        const lastDate = u.lastAccessAt?.toDate ? u.lastAccessAt.toDate().toLocaleDateString('ko-KR') : '미접속';
        return {
          employeeId: u.id,
          name: u.name || '',
          periodDays: yDays,
          lastDate,
          yearlyLoginDays: yDays,
          totalStudySeconds: u.totalStudySeconds || 0,
          totalPracticeSeconds: u.totalPracticeSeconds || 0,
          evalThisMonth: u[thisMonthKey] || 0,
          totalEvalCount: u.totalEvalCount || 0,
        };
      }).sort((a, b) => b.periodDays - a.periodDays);

      $('admin-log-summary').textContent = `총 활성 사용자: ${_adminLogRows.length}명 (${thisYear}년 연간 누적)`;
      listEl.innerHTML = _adminLogRows.length
        ? _adminLogRows.map(r => `<div class="admin-user-item" style="flex-wrap:wrap;gap:6px;align-items:center;">
            <span class="admin-user-item-id" style="min-width:70px;">${escHtml(r.employeeId)}</span>
            ${r.name ? `<span class="admin-user-item-name" style="min-width:60px;">${escHtml(r.name)}</span>` : ''}
            <span class="admin-user-item-date" style="font-size:12px;color:var(--gray-500);">
              접속: <strong>${r.periodDays}일</strong> · 학습: <strong>${_formatPracticeTimeDisplay(r.totalStudySeconds, r.totalPracticeSeconds)}</strong> · AI평가: <strong>${r.evalThisMonth}회</strong>(당월)/${r.totalEvalCount}회(총) · 최근: ${escHtml(r.lastDate)}
            </span>
          </div>`).join('')
        : `<div style="padding:10px;font-size:13px;color:var(--gray-400)">${thisYear}년 접속 기록이 없습니다.</div>`;
      return;
    }

    // 2. [기간별 상세 로그] 쿼리: 오늘 / 7일 / 30일 / 90일 / 365일
    let query = _db.collection(JACA_DB.accessLogs);
    if (period === 'today') {
      query = query.where('date', '==', _kstDateStr());
    } else {
      const days = parseInt(period, 10);
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      query = query.where('date', '>=', _kstDateStr(from));
    }
    const snap = await query.get();

    // allowedUsers 맵 빌드 (사번 -> 사용자 데이터)
    const userMap = {};
    _adminAllowedUsers.forEach(u => { userMap[u.id] = u; });

    // 사번별 기간 내 접속 일수 및 마지막 접속일 집계
    const userStatsInPeriod = {}; // empId -> { count, lastDate }
    snap.docs.forEach(d => {
      const data = d.data();
      const empId = data.employeeId;
      const date = data.date || '';
      if (!empId) return;
      if (!userStatsInPeriod[empId]) {
        userStatsInPeriod[empId] = { count: 0, lastDate: date };
      }
      userStatsInPeriod[empId].count++;
      if (date > userStatsInPeriod[empId].lastDate) {
        userStatsInPeriod[empId].lastDate = date;
      }
    });

    _adminLogRows = Object.entries(userStatsInPeriod)
      .map(([employeeId, stat]) => {
        const u = userMap[employeeId] || {};
        return {
          employeeId,
          name: u.name || '',
          periodDays: stat.count,
          lastDate: stat.lastDate,
          yearlyLoginDays: u[`loginDays_${thisYear}`] || u.totalLoginDays || stat.count,
          totalStudySeconds: u.totalStudySeconds || 0,
          totalPracticeSeconds: u.totalPracticeSeconds || 0,
          evalThisMonth: u[thisMonthKey] || 0,
          totalEvalCount: u.totalEvalCount || 0,
        };
      })
      .sort((a, b) => (b.periodDays - a.periodDays) || b.lastDate.localeCompare(a.lastDate));

    const periodLabel = period === 'today' ? '오늘' : `최근 ${period}일`;
    $('admin-log-summary').textContent = `총 활성 사용자: ${_adminLogRows.length}명 (${periodLabel})`;
    listEl.innerHTML = _adminLogRows.length
      ? _adminLogRows.map(r => `<div class="admin-user-item" style="flex-wrap:wrap;gap:6px;align-items:center;">
          <span class="admin-user-item-id" style="min-width:70px;">${escHtml(r.employeeId)}</span>
          ${r.name ? `<span class="admin-user-item-name" style="min-width:60px;">${escHtml(r.name)}</span>` : ''}
          <span class="admin-user-item-date" style="font-size:12px;color:var(--gray-500);">
            접속: <strong>${r.periodDays}일</strong> · 학습: <strong>${_formatPracticeTimeDisplay(r.totalStudySeconds, r.totalPracticeSeconds)}</strong> · AI평가: <strong>${r.evalThisMonth}회</strong>(당월)/${r.totalEvalCount}회(총) · 최근: ${escHtml(r.lastDate)}
          </span>
        </div>`).join('')
      : '<div style="padding:10px;font-size:13px;color:var(--gray-400)">해당 기간의 접속 기록이 없습니다.</div>';
  } catch (e) {
    listEl.innerHTML = `<div style="padding:10px;font-size:13px;color:var(--color-fail)">조회 실패: ${escHtml(e.message)}</div>`;
  }
}

function _downloadAdminLogCsv() {
  if (!_adminLogRows.length) { showToast('먼저 조회해주세요.', 2000); return; }
  const period = $('admin-log-period').value;
  const header = '사번,이름,조회기간 접속일수,올해 접속일수,학습체류시간(초),학습체류시간,낭독녹음시간(초),낭독녹음시간,이번달 AI평가횟수,총 AI평가횟수,마지막 접속일\n';
  const rows = _adminLogRows.map(r => {
    const studyStr = _formatSeconds(r.totalStudySeconds || 0);
    const practiceStr = _formatSeconds(r.totalPracticeSeconds || 0);
    return `${r.employeeId},${r.name},${r.periodDays},${r.yearlyLoginDays},${r.totalStudySeconds || 0},"${studyStr}",${r.totalPracticeSeconds || 0},"${practiceStr}",${r.evalThisMonth},${r.totalEvalCount},${r.lastDate}`;
  }).join('\n');
  const csv = '﻿' + header + rows;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const filePeriodName = period === 'year' ? 'annual_2026' : `${period}_days`;
  a.download = `accessLogs_${filePeriodName}_${_kstDateStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== LAUNCH SCREEN ANIMATION =====
function runLaunchAnimation() {
  const chars  = document.querySelectorAll('.ls-char');
  const cursor = document.getElementById('ls-cursor');
  const plane  = document.getElementById('ls-plane');
  const logo   = document.getElementById('ls-logo');
  const pro    = document.getElementById('ls-pro');
  const bar    = document.getElementById('ls-bar');
  const sub    = document.getElementById('ls-sub');
  const wave   = document.getElementById('ls-wave');
  const jmark  = document.getElementById('ls-jmark');
  const nl1    = document.getElementById('ls-nl1');
  const nl2    = document.getElementById('ls-nl2');
  const nh1    = document.getElementById('ls-nh1');
  const nh2    = document.getElementById('ls-nh2');

  if (!chars.length) return 3000;
  console.log('[런칭] 애니메이션 시작');

  // 비행기
  plane.style.animation = 'ls-fly 3.2s ease-out 0.2s forwards';

  // 네온 라인
  setTimeout(() => { nl1.style.opacity='1'; nl1.style.transition='height 1.2s ease'; nl1.style.height='100%'; }, 800);
  setTimeout(() => { nl2.style.opacity='0.7'; nl2.style.transition='height 0.9s ease'; nl2.style.height='100%'; }, 1100);
  setTimeout(() => { nh1.style.opacity='1'; nh1.style.transition='width 1.5s ease'; nh1.style.width='100%'; }, 600);
  setTimeout(() => { nh2.style.opacity='0.8'; nh2.style.transition='width 1.2s ease'; nh2.style.width='100%'; }, 1300);

  // 로고 박스 등장
  setTimeout(() => {
    logo.style.transition = 'opacity 0.5s cubic-bezier(0.34,1.56,0.64,1), transform 0.5s cubic-bezier(0.34,1.56,0.64,1)';
    logo.style.opacity = '1';
  }, 300);

  // 타이핑 시퀀스
  const delays = [900, 1050, 1180, 1300, 1420];
  setTimeout(() => { cursor.style.opacity = '1'; }, 850);
  chars.forEach((c, i) => {
    setTimeout(() => {
      cursor.style.opacity = '0';
      c.style.transition = 'opacity 0.35s cubic-bezier(0.22,1.8,0.36,1), transform 0.35s cubic-bezier(0.22,1.8,0.36,1)';
      c.style.opacity = '1';
      c.style.transform = 'translateY(0) scale(1)';
      c.animate([
        { transform: 'translateY(20px) scale(0.7)' },
        { transform: 'translateY(-6px) scale(1.08)', offset: 0.6 },
        { transform: 'translateY(2px) scale(0.97)', offset: 0.8 },
        { transform: 'translateY(0) scale(1)' }
      ], { duration: 350, easing: 'cubic-bezier(0.22,1.8,0.36,1)' });
      setTimeout(() => { cursor.style.opacity = '1'; }, 80);
    }, delays[i]);
  });

  const endTime = delays[delays.length - 1] + 250;

  setTimeout(() => {
    cursor.style.opacity = '0';
    pro.style.transition = 'opacity 0.4s cubic-bezier(0.34,1.56,0.64,1), transform 0.4s cubic-bezier(0.34,1.56,0.64,1)';
    pro.style.opacity = '1';
  }, endTime + 100);
  setTimeout(() => {
    bar.style.transition = 'width 0.6s ease';
    bar.style.width = '100%';
  }, endTime + 300);
  setTimeout(() => {
    sub.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
    sub.style.opacity = '1';
  }, endTime + 500);
  setTimeout(() => {
    wave.style.transition = 'opacity 0.5s ease';
    wave.style.opacity = '1';
  }, endTime + 750);
  setTimeout(() => {
    jmark.style.transition = 'opacity 0.6s ease';
    jmark.style.opacity = '1';
  }, endTime + 1000);

  return endTime + 1500;
}

function hideLaunchScreen() {
  const ls = document.getElementById('launch-screen');
  if (!ls) return;
  const totalMs = runLaunchAnimation();
  setTimeout(() => {
    ls.style.animation = 'ls-fadeout 0.6s ease forwards';
    setTimeout(() => { ls.remove(); console.log('[런칭] 애니메이션 종료'); }, 600);
  }, totalMs);
}

// ===== GUIDE UPDATE FLAG =====
async function _fetchGuideUpdateFlags() {
  if (!_db) return;
  try {
    const snap = await _db.collection(JACA_DB.scripts).where('guideUpdateNeeded', '==', true).get();
    _guideUpdateNeededIds = new Set(snap.docs.map(d => d.id));
  } catch (e) { console.warn('[가이드플래그] 로드 실패:', e.message); }
}

async function _markGuideUpdateNeeded(scriptId) {
  if (!scriptId) return;
  _guideUpdateNeededIds.add(scriptId);
  renderSidebar(_allScripts);
  if (!_db) return;
  try {
    await _db.collection(JACA_DB.scripts).doc(scriptId).set({ guideUpdateNeeded: true }, { merge: true });
  } catch (e) { console.warn('[가이드플래그] 마킹 실패:', e.message); }
}

async function _clearGuideUpdateNeeded(scriptId) {
  if (!scriptId) return;
  _guideUpdateNeededIds.delete(scriptId);
  renderSidebar(_allScripts);
  if (!_db) return;
  try {
    await _db.collection(JACA_DB.scripts).doc(scriptId).set({ guideUpdateNeeded: false }, { merge: true });
  } catch (e) { console.warn('[가이드플래그] 삭제 실패:', e.message); }
}

// ===== ADMIN BULK GUIDE =====
let _adminGuideRunning = false;

async function _loadAdminGuideStatuses() {
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }
  const listEl = $('admin-guide-script-list');
  const bodyEl = $('admin-guide-status-body');
  if (!listEl) return;
  listEl.innerHTML = '<div style="padding:10px;font-size:13px;color:var(--gray-400)">상태 로딩 중...</div>';
  bodyEl.classList.remove('hidden');

  await _fetchGuideUpdateFlags();

  // 방송문이 보유한 언어(ja/ca)별로 가이드 존재 여부를 각각 확인한다.
  // 모두 있어야 '완성', 하나라도 없으면 '미생성'.
  const results = await Promise.all(_allScripts.map(async s => {
    const langs = ['ja', 'ca'].filter(l => s.langs?.[l]?.text);
    try {
      const snaps = await Promise.all(langs.map(l =>
        _getGuideSnap(s.id, l)));
      const have = snaps.filter(x => x.exists).length;
      return { s, langs, have,
               hasGuide: langs.length > 0 && have === langs.length,
               needsUpdate: _guideUpdateNeededIds.has(s.id) };
    } catch { return { s, langs, have: 0, hasGuide: false, needsUpdate: false }; }
  }));

  let html = '';
  for (const { s, hasGuide, needsUpdate, langs, have } of results) {
    const _part = (langs && langs.length > 1 && have > 0 && have < langs.length)
      ? ` (${have}/${langs.length})` : '';
    const statusBadge = !hasGuide
      ? `<span class="admin-guide-badge badge-guide-none">❌ 미생성${_part}</span>`
      : needsUpdate
        ? '<span class="admin-guide-badge badge-guide-update">🔄 업데이트 필요</span>'
        : '<span class="admin-guide-badge badge-guide-done">✅ 완성</span>';
    html += `<label class="admin-guide-item">
      <input type="checkbox" class="admin-guide-chk" value="${escHtml(s.id)}" ${needsUpdate || !hasGuide ? 'checked' : ''}>
      <span class="admin-guide-item-title">${escHtml(s.title)}</span>
      ${statusBadge}
    </label>`;
  }
  listEl.innerHTML = html || '<div style="padding:10px;font-size:13px;color:var(--gray-400)">방송문이 없습니다.</div>';
}

async function _runBulkGuideGeneration() {
  if (_adminGuideRunning) return;
  if (!_db) { showToast('Firebase 연결이 필요합니다.', 3000); return; }
  const checked = Array.from(document.querySelectorAll('.admin-guide-chk:checked'));
  if (!checked.length) { showToast('방송문을 선택해주세요.', 2000); return; }

  _adminGuideRunning = true;
  const progressEl = $('admin-bulk-guide-progress');
  const btn = $('btn-admin-bulk-guide');
  if (progressEl) progressEl.classList.remove('hidden');
  if (btn) btn.disabled = true;

  const ids = checked.map(c => c.value);
  const total = ids.length;
  let done = 0;
  let failed = 0;

  // ── API 호출 페이싱 ──────────────────────────────────────────────
  // 무료 등급 한도는 대략 10~15 RPM. 몰아서 보내면 즉시 429가 나므로
  // '일정 간격'으로 고르게 내보낸다. 배치 후 장시간 대기보다 총 소요시간이 짧다.
  // 방송문 1편당 일본어·중국어 2회를 호출한다는 점에 유의할 것.
  const MIN_INTERVAL_MS = 6500;   // 호출 간 최소 간격 ≈ 9 RPM (한도 10 아래로 여유)
  const QUOTA_WAIT_SEC  = 60;     // 429 발생 시 회복 대기(초)
  let _lastCallAt = 0;
  let _callsLeft = 0;             // 남은 호출 수 (ETA 표시용)

  const _isQuotaErr = e => /quota|429|RESOURCE_EXHAUSTED|한도/i.test(String(e?.message || e));
  // 일일 한도(RPD)는 대기로 회복되지 않으므로 구분한다.
  const _isDailyErr = e => /per day|daily|RPD|일일/i.test(String(e?.message || e));

  const _fmtEta = n => {
    const sec = Math.round(n * MIN_INTERVAL_MS / 1000);
    return sec >= 60 ? `약 ${Math.ceil(sec / 60)}분` : `약 ${sec}초`;
  };
  // 직전 호출로부터 최소 간격이 지날 때까지 대기
  const _pace = async () => {
    const wait = _lastCallAt ? MIN_INTERVAL_MS - (Date.now() - _lastCallAt) : 0;
    if (wait > 0) await new Promise(x => setTimeout(x, wait));
    _lastCallAt = Date.now();
  };
  const _quotaWait = async (label) => {
    for (let r = QUOTA_WAIT_SEC; r > 0; r--) {
      if (progressEl) progressEl.textContent = `${label} · API 한도 회복 대기 (${r}초 남음)`;
      await new Promise(x => setTimeout(x, 1000));
    }
    _lastCallAt = 0;
  };

  // 총 호출 수 = 각 방송문이 보유한 언어 수의 합 (ETA 계산용)
  _callsLeft = ids.reduce((n, id) => {
    const sc = _allScripts.find(a => a.id === id);
    return n + (sc ? ['ja', 'ca'].filter(l => sc.langs?.[l]?.text).length : 0);
  }, 0);
  let _dailyStop = false;   // 일일 한도 도달 시 전체 중단

  for (const id of ids) {
    const s = _allScripts.find(a => a.id === id);
    const _langs = s ? ['ja', 'ca'].filter(l => s.langs?.[l]?.text) : [];
    if (!s || !_langs.length) { done++; continue; }
    let _okAll = true;
    for (const _lg of _langs) {
      const _lgName = _lg === 'ca' ? '中文' : '日本語';
      if (progressEl) progressEl.textContent =
        `⏳ ${done + 1}/${total} · ${escHtml(s.title)} · ${_lgName} — 남은 시간 ${_fmtEta(_callsLeft)}`;
      let _saved = false;
      for (let _try = 0; _try < 3 && !_saved; _try++) {
        await _pace();
        try {
          const guide = await callGeminiGuide(s.langs[_lg].text, _lg);
          await _saveGuideToFirestore(s.id, _lg, guide);
          _studyGuideCache[`${s.id}_${_lg}`] = guide;
          _saved = true;
        } catch (e) {
          // 일일 한도는 기다려도 회복되지 않으므로 즉시 중단한다.
          if (_isDailyErr(e)) { _dailyStop = true; _okAll = false; break; }
          // 분당 한도는 회복 대기 후 재시도 (최대 2회)
          if (_isQuotaErr(e) && _try < 2) { await _quotaWait(`${done}/${total} 완료`); continue; }
          console.error(`[일괄가이드] ${s.id}/${_lg} 실패:`, e.message);
          _okAll = false;
        }
      }
      _callsLeft--;
      if (_dailyStop) break;
    }
    if (_dailyStop) { failed++; break; }
    if (_okAll) { try { await _clearGuideUpdateNeeded(s.id); } catch {} }
    else failed++;
    done++;
    if (done >= total) break;

  }

  _adminGuideRunning = false;
  if (btn) btn.disabled = false;
  if (progressEl) progressEl.classList.add('hidden');
  showToast(
    _dailyStop ? `일일 API 한도에 도달해 중단했습니다. ${done - failed}/${total} 완료 — 내일 이어서 진행하세요.`
    : failed > 0 ? `${done - failed}/${total} 완료, ${failed}개 실패`
    : `${total}개 가이드 생성 완료 ✓`, _dailyStop ? 7000 : 4000);
  _loadAdminGuideStatuses();
}

// ===== GUIDE MANAGEMENT =====
const _GUIDE_DEFAULT_TEXTS = [
  {
    title: '🎯 이 앱의 목적',
    content: '기내방송 발음·억양·속도를 스스로 훈련하는 AI 기반 자가학습 플랫폼입니다.'
  },
  {
    title: '📋 학습 순서 추천',
    content: 'STEP 1 학습모드 → 방송문 선택 → 모델음성 듣기 (남/여)\nSTEP 2 핵심 포인트 확인 → AI 가이드 생성\nSTEP 3 연습하기 → 직접 녹음 → AI 분석 결과 확인\nSTEP 4 드릴모드 → 구간 반복 연습'
  },
  {
    title: '🎙 녹음 팁',
    content: '• 마이크와 15cm 거리 유지\n• 방송문 끝을 내리면 더 안정적으로 들림\n• 숨을 고르고 첫 단어를 또렷하게 시작'
  },
  {
    title: '📊 AI 분석 결과 보는 법',
    content: '• 발음 정확도 / 억양 / 속도 3가지 항목으로 평가\n• 80점 이상 목표로 반복 연습 권장'
  },
  {
    title: '❓ 자주 묻는 질문',
    content: 'Q. 녹음이 안 돼요\n→ 설정 › Safari(또는 앱) › 마이크 허용을 확인하세요.\n\nQ. AI 분석이 실패해요\n→ 네트워크 연결을 확인한 후 다시 시도해 주세요.\n\nQ. 모델음성이 안 들려요\n→ 음소거 해제 및 볼륨을 확인하세요.'
  }
];

let _guideSections = null; // null = Firestore 미로드

// 서식 기호(STEP, •, Q., →)를 해석해 HTML로 변환
function _guideTextToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div style="height:6px"></div>';
      continue;
    }
    const stepMatch = line.match(/^(STEP\s*\d+)\s+(.*)/);
    if (stepMatch) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<div class="guide-step"><span class="guide-step-num">${stepMatch[1]}</span><span>${stepMatch[2]}</span></div>`;
      continue;
    }
    if (/^[•\-]\s/.test(line)) {
      if (!inList) { html += '<ul class="guide-list">'; inList = true; }
      html += `<li>${line.slice(2)}</li>`;
      continue;
    }
    if (/^Q\./.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<div class="guide-faq-q">${line}</div>`;
      continue;
    }
    if (/^→/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<div class="guide-faq-a">${line.slice(1).trim()}</div>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function _renderGuideBody() {
  const body = $('guide-modal-body');
  const editBtn = $('btn-guide-edit');
  if (!body || !_guideSections) return;
  const unlocked = isEditUnlocked();
  if (editBtn) editBtn.classList.toggle('hidden', unlocked);

  body.innerHTML = '';
  _guideSections.forEach((sec, idx) => {
    const div = document.createElement('div');
    div.className = 'guide-section';
    div.dataset.idx = idx;

    const header = document.createElement('div');
    header.className = 'guide-section-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = sec.title;
    header.appendChild(titleSpan);

    if (unlocked) {
      const secEditBtn = document.createElement('button');
      secEditBtn.className = 'guide-sec-edit-btn';
      secEditBtn.textContent = '✏️';
      secEditBtn.title = '이 섹션 편집';
      secEditBtn.addEventListener('click', () => _enterSectionEdit(div, idx));
      header.appendChild(secEditBtn);
    }

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'guide-section-body';
    bodyDiv.innerHTML = _guideTextToHtml(sec.content);

    div.appendChild(header);
    div.appendChild(bodyDiv);
    body.appendChild(div);
  });
}

function _enterSectionEdit(sectionDiv, idx) {
  if (sectionDiv.classList.contains('guide-editing')) return;
  sectionDiv.classList.add('guide-editing');

  const bodyDiv = sectionDiv.querySelector('.guide-section-body');
  const originalHtml = bodyDiv.innerHTML;
  const sec = _guideSections[idx];

  const textarea = document.createElement('textarea');
  textarea.className = 'guide-edit-textarea';
  textarea.value = sec.content;
  const autoResize = () => { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; };
  textarea.addEventListener('input', autoResize);

  const btnRow = document.createElement('div');
  btnRow.className = 'guide-edit-btnrow';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-icon sm';
  cancelBtn.textContent = '취소';
  cancelBtn.addEventListener('click', () => {
    sectionDiv.classList.remove('guide-editing');
    bodyDiv.innerHTML = originalHtml;
    btnRow.remove();
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-primary sm';
  saveBtn.textContent = '저장';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';
    const newContent = textarea.value;
    _guideSections[idx] = { ..._guideSections[idx], content: newContent };
    try {
      if (_db) await _db.collection(JACA_DB.guide).doc('main').set({ sections: _guideSections });
      showToast('저장되었습니다 ✓');
      sectionDiv.classList.remove('guide-editing');
      bodyDiv.innerHTML = _guideTextToHtml(newContent);
      btnRow.remove();
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
      showToast('저장 실패: ' + e.message, 4000);
    }
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);
  bodyDiv.innerHTML = '';
  bodyDiv.appendChild(textarea);
  bodyDiv.appendChild(btnRow);
  requestAnimationFrame(autoResize);
}

async function _openGuideModal() {
  $('guide-modal').classList.remove('hidden');
  _applyAdminVisibility();
  if (!_guideSections) {
    const body = $('guide-modal-body');
    if (body) body.innerHTML = '<div class="guide-loading">불러오는 중...</div>';
    let data = null;
    if (_db) {
      try {
        // 전용 저장공간 먼저, 없으면 기존 공용 가이드를 읽기만 함
        let snap = await _db.collection(JACA_DB.guide).doc('main').get();
        if (!snap.exists) snap = await _db.collection(SHARED_DB.guide).doc('main').get();
        if (snap.exists && Array.isArray(snap.data().sections)) data = snap.data().sections;
      } catch (e) { console.warn('[가이드] Firestore 로드 실패:', e); }
    }
    _guideSections = data || _GUIDE_DEFAULT_TEXTS.map(s => ({ ...s }));
  }
  _renderGuideBody();
}

// ===== EVENTS =====
document.addEventListener('DOMContentLoaded', () => {
  _recordAppLaunch(); // 로그인 여부와 무관하게 "앱 실행" 자체를 하루 1회 기록

  // vp_s 세션 체크 후 즉시 앱 복구
  const s = localStorage.getItem('vp_s');
  if (s) {
    try {
      const p = JSON.parse(s);
      if (Date.now() < p.exp) {
        enterApp();
      }
    } catch(e) {}
  }

  hideLaunchScreen();

  if (isLoggedIn()) {
    enterApp();
  } else {
    // showScreen('screen-login'); // login.js가 담당
    setTimeout(() => $('login-empid-input')?.focus(), 700);
  }

  // 언어 탭
  $('lang-tabs').querySelectorAll('.lang-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $('lang-tabs').querySelectorAll('.lang-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const newLangCode = tab.dataset.lang;
      state.selectedLang = newLangCode;
      if (state.currentScript) updatePrepContent();
    });
  });

  $('btn-back-prep').addEventListener('click', () => { clearInterval(state.prepTimerInterval); showScreen('screen-home'); updateAIUsageBadge(); });
  $('btn-start-record').addEventListener('click', startRecording);
  $('btn-peek').addEventListener('click', () => $('script-peek-text').classList.toggle('hidden'));
  $('btn-stop-record').addEventListener('click', stopRecording);
  $('btn-home').addEventListener('click', () => showScreen('screen-home'));
  $('btn-retry').addEventListener('click', () => { if (state.currentScript) startPrep(state.currentScript); });

  // 스크립트 편집/추가 모달 이벤트
  $('modal-close').addEventListener('click', closeCustomModal);
  $('modal-cancel').addEventListener('click', closeCustomModal);
  $('modal-save').addEventListener('click', saveScriptFromModal);
  $('modal-restore').addEventListener('click', () => {
    if (confirm('원본 방송문으로 복원하시겠습니까? 수정 내용이 삭제됩니다.')) {
      restoreBuiltIn(_modalState.editId);
      closeCustomModal();
    }
  });
  $('custom-modal').addEventListener('click', e => { if (e.target === $('custom-modal')) closeCustomModal(); });

  // 스크립트 모달 언어 탭
  document.querySelectorAll('.modal-lang-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.modal-lang-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.modal-lang-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`modal-lang-${tab.dataset.lang}`).classList.add('active');
    });
  });

  // PDF 모달 이벤트
  $('pdf-modal-close').addEventListener('click', closePdfModal);
  $('pdf-modal-cancel').addEventListener('click', closePdfModal);
  $('pdf-modal').addEventListener('click', e => { if (e.target === $('pdf-modal')) closePdfModal(); });
  $('pdf-import-btn').addEventListener('click', importSelectedPdfScripts);
  $('pdf-retry-btn').addEventListener('click', () => _showPdfStep('upload'));

  // PDF 전체 선택/해제
  $('pdf-select-all').addEventListener('click', () => {
    $('pdf-script-list').querySelectorAll('.pdf-script-check').forEach(cb => {
      cb.checked = true; cb.closest('.pdf-script-item').classList.add('selected');
    });
  });
  $('pdf-deselect-all').addEventListener('click', () => {
    $('pdf-script-list').querySelectorAll('.pdf-script-check').forEach(cb => {
      cb.checked = false; cb.closest('.pdf-script-item').classList.remove('selected');
    });
  });

  // PDF 파일 선택
  $('pdf-file-input').addEventListener('change', e => {
    if (e.target.files[0]) handlePdfFile(e.target.files[0]);
  });

  // PDF 드래그 앤 드롭
  const dropZone = $('pdf-drop-zone');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handlePdfFile(file);
  });

  // ===== AUTH MODAL 이벤트 =====
  $('auth-confirm').addEventListener('click', _confirmAuth);
  $('auth-cancel').addEventListener('click', () => {
    $('auth-modal').classList.add('hidden');
    _authCallback = null;
  });
  $('auth-pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') _confirmAuth(); });
  $('auth-modal').addEventListener('click', e => {
    if (e.target === $('auth-modal')) { $('auth-modal').classList.add('hidden'); _authCallback = null; }
  });

  // ===== 로그인 화면 이벤트 =====
  $('login-empid-input').addEventListener('input', () => {
    const cleaned = $('login-empid-input').value.replace(/[^0-9]/g, '');
    if (cleaned !== $('login-empid-input').value) $('login-empid-input').value = cleaned;
  });
  $('login-empid-input').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
  $('login-submit-btn').addEventListener('click', attemptLogin);
  $('btn-logout').addEventListener('click', () => {
    if (confirm('로그아웃 하시겠습니까?')) logout();
  });

  // ===== TABLE INSERT 이벤트 =====
  $('btn-table-toggle').addEventListener('click', () => {
    const builder = $('table-builder');
    const isOpen = !builder.classList.contains('hidden');
    builder.classList.toggle('hidden', isOpen);
    $('btn-table-toggle').classList.toggle('active', !isOpen);
  });
  $('tb-insert-btn').addEventListener('click', () => {
    const cols = parseInt($('tb-cols').value, 10);
    const rows = parseInt($('tb-rows').value, 10);
    const ta = document.getElementById('custom-text-ja');
    const header = '|' + Array.from({length:cols}, (_,i)=>`열${i+1}`).join('|') + '|';
    const sep    = '|' + Array(cols).fill('---').join('|') + '|';
    const dataRow= '|' + Array(cols).fill('내용').join('|') + '|';
    const tableStr = [header, sep, ...Array(rows).fill(dataRow)].join('\n');
    const pos = ta.selectionStart;
    const before = ta.value.substring(0, pos);
    const after  = ta.value.substring(pos);
    ta.value = before + (before && !before.endsWith('\n') ? '\n' : '') + tableStr + '\n' + after;
    $('table-builder').classList.add('hidden');
    $('btn-table-toggle').classList.remove('active');
    ta.focus();
  });

  // ===== MODEL VOICE 이벤트 (언어별) =====
  ['ja','ca'].forEach(lang => {
    document.getElementById(`mv-file-${lang}`)?.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { alert('파일 크기 10MB 초과'); e.target.value = ''; return; }
      const reader = new FileReader();
      reader.onload = ev => {
        const key = getModelVoiceKey(lang);
        localStorage.setItem(key, ev.target.result);
        localStorage.setItem(key + '_name', file.name);
        const el = document.getElementById(`mv-current-${lang}`);
        const nameEl = document.getElementById(`mv-name-${lang}`);
        if (el) el.classList.remove('hidden');
        if (nameEl) nameEl.textContent = file.name;
        console.log(`[모달] ${lang} 모델 음성 저장: ${file.name}`);
      };
      reader.readAsDataURL(file);
    });
    document.getElementById(`mv-play-${lang}`)?.addEventListener('click', () => {
      const base64 = localStorage.getItem(getModelVoiceKey(lang));
      if (base64) new Audio(base64).play();
    });
    document.getElementById(`mv-del-${lang}`)?.addEventListener('click', () => {
      const key = getModelVoiceKey(lang);
      localStorage.removeItem(key); localStorage.removeItem(key + '_name');
      const el = document.getElementById(`mv-current-${lang}`);
      if (el) el.classList.add('hidden');
      const nameEl = document.getElementById(`mv-name-${lang}`);
      if (nameEl) nameEl.textContent = '';
      const fileEl = document.getElementById(`mv-file-${lang}`);
      if (fileEl) fileEl.value = '';
    });
  });
  // MV 모달 언어 탭 전환
  document.querySelectorAll('#mv-lang-tabs .mv-lang-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#mv-lang-tabs .mv-lang-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.mv-lang-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`mv-panel-${tab.dataset.lang}`)?.classList.add('active');
      _modalMvLang = tab.dataset.lang;
    });
  });

  // ===== 학습 모드 =====
  $('btn-study-mode').addEventListener('click', startStudyMode);
  $('btn-back-study').addEventListener('click', () => {
    if (_currentModelAudio) { _currentModelAudio.pause(); _currentModelAudio = null; }
    if (state.currentScript) showScreen('screen-prep');
    else showScreen('screen-home'); updateAIUsageBadge();
  });
  // 학습 화면 성별 버튼
  ['m', 'f'].forEach(g => {
    $(`study-gender-${g}`)?.addEventListener('click', () => {
      const G = g.toUpperCase();
      if (_currentGender === G) return;
      _currentGender = G;
      ['m', 'f'].forEach(x => $(`study-gender-${x}`)?.classList.toggle('active', x === g));
      if (_currentModelAudio) { _currentModelAudio.pause(); _currentModelAudio = null; }
      createModelVoicePlayer('study-model-player', { noGender: true });
    });
  });
  // 가이드 업데이트 (관리자 전용)
  $('btn-guide-update')?.addEventListener('click', async () => {
    const s = state.currentScript;
    if (!s) return;
    const lang = state.selectedLang;
    const cacheKey = `${s.id}_${lang}`;
    const updateBtn = $('btn-guide-update');
    const statusEl = $('study-guide-status');
    updateBtn.disabled = true;
    updateBtn.textContent = '⏳ 업데이트 중...';
    statusEl.textContent = 'AI가 최신 내용으로 분석 중...';
    statusEl.className = 'study-guide-loading';
    statusEl.classList.remove('hidden');
    $('study-guide-result').classList.add('hidden');
    try {
      const guide = await callGeminiGuide(s.langs[lang].text, lang);
      _studyGuideCache[cacheKey] = guide;
      statusEl.classList.add('hidden');
      _renderStudyGuide(guide);
      $('btn-gen-guide').textContent = '✅ 가이드 완성';
      _saveGuideToFirestore(s.id, lang, guide);
      await _clearGuideUpdateNeeded(s.id);
      $('study-guide-update-notice')?.classList.add('hidden');
      updateBtn.classList.add('hidden');
      showToast('업데이트 완료 ✓');
    } catch (e) {
      statusEl.textContent = '업데이트 실패. 다시 시도해주세요.';
      statusEl.className = 'study-guide-error';
      updateBtn.disabled = false;
      updateBtn.textContent = '🔄 업데이트';
    }
  });

  // 가이드 생성
  $('btn-gen-guide').addEventListener('click', async () => {
    const s = state.currentScript;
    if (!s) return;
    const lang = state.selectedLang;
    const cacheKey = `${s.id}_${lang}`;
    if (_studyGuideCache[cacheKey]) {
      _renderStudyGuide(_studyGuideCache[cacheKey]);
      return;
    }
    const guideBtn = $('btn-gen-guide');
    const statusEl = $('study-guide-status');
    guideBtn.disabled = true;
    guideBtn.textContent = '⏳ 분석 중...';
    statusEl.textContent = 'AI가 분석 중입니다...';
    statusEl.className = 'study-guide-loading';
    statusEl.classList.remove('hidden');
    $('study-guide-result').classList.add('hidden');
    try {
      const guide = await callGeminiGuide(s.langs[lang].text, lang);
      _studyGuideCache[cacheKey] = guide;
      statusEl.classList.add('hidden');
      _renderStudyGuide(guide);
      guideBtn.textContent = '✅ 가이드 완성';
      // Firestore 자동 저장 (실패해도 무시)
      _saveGuideToFirestore(s.id, lang, guide);
      console.log('[완료] AI 학습 가이드 생성 및 저장');
    } catch (e) {
      // 원인을 화면에 노출 — '다시 시도'만으로는 해결되지 않는 경우가 많음
      const _msg = String(e?.message || e || '');
      const _hint = /quota|429|RESOURCE_EXHAUSTED/i.test(_msg) ? 'API 사용량 한도 초과 — 잠시 후 다시 시도하세요.'
                  : /JSON|parse|Unexpected/i.test(_msg)        ? '응답 형식 오류 — 다시 시도하면 대개 해결됩니다.'
                  : /timeout|network|fetch|Failed to fetch/i.test(_msg) ? '네트워크 오류 — 연결 확인 후 다시 시도하세요.'
                  : /401|403|API key|PERMISSION/i.test(_msg)   ? 'API 키 오류 — 관리자에게 문의하세요.'
                  : /safety|blocked|SAFETY/i.test(_msg)        ? '안전 필터에 차단됨 — 방송문 내용을 확인하세요.'
                  : '';
      statusEl.textContent = '가이드 생성에 실패했습니다. ' + (_hint || _msg.slice(0, 120));
      statusEl.className = 'study-guide-error';
      guideBtn.disabled = false;
      guideBtn.textContent = '가이드 생성하기';
      console.error('[가이드 생성 실패]', e);
    }
  });
  // 학습 화면 하단 버튼
  $('btn-study-to-drill').addEventListener('click', () => {
    if (_currentModelAudio) { _currentModelAudio.pause(); _currentModelAudio = null; }
    startDrillMode();
  });
  $('btn-study-to-record').addEventListener('click', () => {
    if (_currentModelAudio) { _currentModelAudio.pause(); _currentModelAudio = null; }
    showScreen('screen-prep');
    // prep에서 즉시 녹음 시작 트리거
    $('btn-start-record').click();
  });

  // ===== 드릴 모드 =====
  // btn-drill-record는 시작/중지에 따라 _drillRender()/_resetDrillRecordingState()에서
  // .onclick을 동적으로 토글한다 — 여기서 addEventListener로 별도 고정 바인딩하면
  // 클릭마다 두 핸들러가 동시에 발동해 녹음 중 스트림이 끊기므로 고정 리스너를 두지 않는다.
  $('btn-drill-mode').addEventListener('click', startDrillMode);
  $('btn-back-drill').addEventListener('click', () => {
    _resetDrillRecordingState();
    if (_currentModelAudio) { _currentModelAudio.pause(); _currentModelAudio = null; }
    if (state.currentScript) showScreen('screen-prep');
    else showScreen('screen-home'); updateAIUsageBadge();
  });
  $('btn-drill-play-my').addEventListener('click', async () => {
    if (!_drill.myAudioUrl) return;
    await resumeAudioContext();
    const a = new Audio(_drill.myAudioUrl);
    a.setAttribute('playsinline', '');
    a.play().catch(e => { console.error('[드릴] 내음성 재생 오류:', e); showToast('음성 재생에 실패했습니다.', 'error'); });
  });
  $('btn-drill-redo').addEventListener('click', () => {
    if (_drill.myAudioUrl) { URL.revokeObjectURL(_drill.myAudioUrl); _drill.myAudioUrl = null; }
    _drill.myBlob = null;
    _drillRender();
  });
  $('btn-drill-next').addEventListener('click', _drillNext);
  $('btn-drill-done').addEventListener('click', () => {
    if (state.currentScript) startPrep(state.currentScript);
    else showScreen('screen-home'); updateAIUsageBadge();
  });

  // ===== 결과 화면 모델 음성 비교 =====
  $('btn-play-model').addEventListener('click', playModelVoice);
  $('btn-play-my').addEventListener('click', playMyRecording);
  $('btn-compare-voice').addEventListener('click', startModelComparison);
  $('btn-compare-stop').addEventListener('click', stopModelComparison);

  // ===== 관리자 패널 =====
  $('btn-open-admin').addEventListener('click', openAdminScreen);
  $('btn-admin-back').addEventListener('click', () => { showScreen('screen-home'); updateAIUsageBadge(); loadAndRenderHome(); });
  // 관리자 일괄 가이드 생성
  $('btn-admin-load-guide-status')?.addEventListener('click', _loadAdminGuideStatuses);
  $('btn-admin-bulk-guide')?.addEventListener('click', _runBulkGuideGeneration);
  $('btn-admin-guide-select-all')?.addEventListener('click', () => {
    document.querySelectorAll('.admin-guide-chk').forEach(c => c.checked = true);
  });
  $('btn-admin-guide-deselect-all')?.addEventListener('click', () => {
    document.querySelectorAll('.admin-guide-chk').forEach(c => c.checked = false);
  });

  if ($('btn-admin-scan-mv')) $('btn-admin-scan-mv').addEventListener('click', _scanLocalModelVoices);
  if ($('btn-admin-reset-scan-mv')) $('btn-admin-reset-scan-mv').addEventListener('click', _resetAndRescanModelVoices);
  if ($('btn-save-firebase-cfg')) $('btn-save-firebase-cfg').addEventListener('click', () => {
    const ok = initFirebase();
    const el = $('admin-firebase-status');
    if (el) el.textContent = ok ? '✅ Firebase 연결됨' : '❌ 연결 실패';
    if (ok) { _refreshAdminVersion(); _refreshAdminVersionList(); }
  });
  if ($('btn-admin-json-deploy')) $('btn-admin-json-deploy').addEventListener('click', deployJsonToFirestore);

  // ===== 관리자 - 사용자 관리 =====
  $('admin-user-add-input')?.addEventListener('input', () => {
    const el = $('admin-user-add-input');
    const cleaned = el.value.replace(/[^0-9]/g, '');
    if (cleaned !== el.value) el.value = cleaned;
  });
  $('admin-user-add-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') _addAdminUser(); });
  $('admin-user-name-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') _addAdminUser(); });
  $('btn-admin-user-add')?.addEventListener('click', _addAdminUser);
  $('admin-user-excel-input')?.addEventListener('change', e => {
    if (e.target.files[0]) _handleAdminUserExcel(e.target.files[0]);
  });
  $('btn-admin-user-bulk-add')?.addEventListener('click', () => {
    if (_bulkParsedData.length) {
      bulkRegisterEmployees(_bulkParsedData);
    }
  });
  $('btn-admin-bulk-preview')?.addEventListener('click', async () => {
    const textarea = $('admin-bulk-paste-textarea');
    const autoPw = $('admin-bulk-auto-pw')?.checked || false;
    const text = textarea ? textarea.value.trim() : '';
    if (!text) { showToast('입력된 데이터가 없습니다.', 2000); return; }
    _bulkParsedData = _parseBulkCsvData(text, autoPw);
    if (!_bulkParsedData.length) { showToast('유효한 사번 데이터가 없습니다.', 2000); return; }
    await _renderBulkPreview(_bulkParsedData);
  });
  $('admin-bulk-auto-pw')?.addEventListener('change', async () => {
    if (_bulkParsedData.length) {
      const autoPw = $('admin-bulk-auto-pw')?.checked || false;
      const textarea = $('admin-bulk-paste-textarea');
      const text = textarea ? textarea.value.trim() : '';
      _bulkParsedData = _parseBulkCsvData(text, autoPw);
      await _renderBulkPreview(_bulkParsedData);
    }
  });
  $('admin-user-search')?.addEventListener('input', () => {
    _adminUserSearchText = $('admin-user-search').value;
    _renderAdminUserList();
  });
  $('admin-user-sort')?.addEventListener('change', () => {
    _adminUserSortMode = $('admin-user-sort').value;
    _renderAdminUserList();
  });
  $('btn-admin-user-delete-all')?.addEventListener('click', _deleteAllAdminUsers);
  $('btn-admin-user-sync-logs')?.addEventListener('click', _syncPastAccessLogsToAllowedUsers);
  $('btn-admin-user-download')?.addEventListener('click', _downloadAdminUserListCsv);
  $('btn-admin-log-load')?.addEventListener('click', _loadAdminAccessLogs);
  $('btn-admin-log-csv')?.addEventListener('click', _downloadAdminLogCsv);

  // ===== 사이드바 =====
  $('btn-toggle-sidebar').addEventListener('click', openSidebar);
  $('sidebar-overlay').addEventListener('click', closeSidebar);
  $('btn-sidebar-add').addEventListener('click', () => requireEditAuth(openAddModal));
  $('btn-sidebar-pdf').addEventListener('click', () => requireEditAuth(openPdfModal));
  $('btn-sidebar-guide').addEventListener('click', _openGuideModal);
  $('guide-modal-close').addEventListener('click', () => $('guide-modal').classList.add('hidden'));
  $('guide-modal').addEventListener('click', (e) => { if (e.target === $('guide-modal')) $('guide-modal').classList.add('hidden'); });
  $('btn-guide-edit').addEventListener('click', () => requireEditAuth(() => _renderGuideBody()));
  _setupSidebarSearch();

  // 상세 패널 언어 탭
  // 교범 붙여넣기 변환
  document.querySelectorAll('.btn-cam-import').forEach(btn => {
    btn.addEventListener('click', () => _openCamImport(btn.dataset.target));
  });
  $('cam-import-close').addEventListener('click', _closeCamImport);
  $('cam-import-cancel').addEventListener('click', _closeCamImport);
  $('cam-import-run').addEventListener('click', _runCamImport);
  $('cam-import-apply').addEventListener('click', _applyCamImport);
  $('cam-import-modal').addEventListener('click', e => {
    if (e.target === $('cam-import-modal')) _closeCamImport();
  });

  // 발음 포인트 토글 (장음·촉음 / 성조)
  const _ppBtn = $('btn-pron-toggle');
  if (_ppBtn) {
    let _pp = localStorage.getItem('jaca_pron_point') === '1';
    if (typeof setPronPoint === 'function') setPronPoint(_pp);
    const _syncPp = () => {
      _ppBtn.classList.toggle('active', _pp);
      const lb = $('pron-toggle-label');
      if (lb) lb.textContent = _detailLang === 'ca'
        ? (_pp ? '성조 표시 ON' : '성조 표시')
        : (_pp ? '장음·촉음 ON' : '장음·촉음');
    };
    _syncPp();
    _ppBtn.addEventListener('click', () => {
      _pp = !_pp;
      localStorage.setItem('jaca_pron_point', _pp ? '1' : '0');
      if (typeof setPronPoint === 'function') setPronPoint(_pp);
      _syncPp();
      const s = state.currentScript || _lastDetailScript;
      if (s) _renderDetailContent(s, _detailLang);
    });
    window._syncPronBtn = _syncPp;
  }


  $('detail-lang-tabs').querySelectorAll('.detail-lang-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (!_selectedScriptId) return;
      const s = getEffectiveScript(_selectedScriptId);
      if (!s || !s.langs[tab.dataset.lang]?.text) return;
      _detailLang = tab.dataset.lang;
      $('detail-lang-tabs').querySelectorAll('.detail-lang-tab').forEach(t => t.classList.toggle('active', t.dataset.lang===_detailLang));
      _renderDetailContent(s, _detailLang);
      if (window._syncPronBtn) window._syncPronBtn();
    });
  });

  // 상세 패널 버튼들
  $('detail-start-btn').addEventListener('click', () => {
    if (!_selectedScriptId) return;
    const s = getEffectiveScript(_selectedScriptId);
    if (s) { state.selectedLang = _detailLang; startPrep(s, _detailLang); }
  });
  // detail-voice-btn 제거됨 — 모델 음성은 학습 화면(screen-study)에서 재생
  $('detail-edit-btn').addEventListener('click', () => {
    if (!_selectedScriptId) return;
    const btn = $('detail-edit-btn');
    requireEditAuth(() => openEditModal(btn.dataset.id, btn.dataset.source));
  });

  // 결과 화면 버튼
  document.getElementById('btn-result-select')?.addEventListener('click', () => { stopModelComparison(); showScreen('screen-home'); updateAIUsageBadge(); });
  document.getElementById('btn-result-retry-2')?.addEventListener('click', () => { stopModelComparison(); if (state.currentScript) startPrep(state.currentScript); });
  $('btn-retry')?.addEventListener('click', () => { stopModelComparison(); if (state.currentScript) startPrep(state.currentScript); });

  // iOS PWA 백그라운드 복귀 시 AudioContext 재개
  // visibilitychange만으로 부족한 경우를 위해 pageshow도 함께 등록
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeAudioContext();
  });
  window.addEventListener('pageshow', () => { resumeAudioContext(); });

  console.log('[완료] ja/ca 제거');
});
