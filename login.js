console.log('[Login] login.js 로드됨');
(function() {
  const KEY = 'vp_s';

  function getSession() {
    try {
      const s = localStorage.getItem(KEY);
      if (!s) return null;
      const p = JSON.parse(s);
      if (Date.now() > p.exp) {
        localStorage.removeItem(KEY);
        return null;
      }
      return p;
    } catch(e) {
      localStorage.removeItem(KEY);
      return null;
    }
  }

  function getInitialPassword(empId) {
    return 'Jeju' + String(empId).padStart(7,'0').substring(0,4);
  }

  function showLogin() {
    if (document.getElementById('vp-lo')) return;
    const el = document.createElement('div');
    el.id = 'vp-lo';
    el.style.cssText = 'position:fixed;inset:0;background:#000;' +
      'z-index:999999;display:flex;align-items:center;' +
      'justify-content:center;font-family:-apple-system,sans-serif;';
    el.innerHTML = `
      <div style="width:100%;max-width:340px;background:#121212;
        border-radius:16px;padding:32px 24px;margin:20px;
        border:1px solid #333;box-sizing:border-box;">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="font-size:36px;">✈️</div>
          <h1 style="font-size:22px;font-weight:800;
            color:#FF6B00;margin:8px 0 4px;">Voice Pro</h1>
          <p style="font-size:12px;color:rgba(255,255,255,0.5);">
            일본어 · 중국어 기내방송 훈련 플랫폼</p>
        </div>
        <div style="margin-bottom:14px;">
          <label style="font-size:13px;font-weight:600;
            color:rgba(255,255,255,0.85);display:block;
            margin-bottom:6px;">사번</label>
          <input id="vp-eid" type="text" inputmode="numeric"
            placeholder="사번을 입력하세요"
            style="width:100%;padding:12px;border:1.5px solid #333;
            border-radius:10px;font-size:15px;background:#1c1c1e;
            color:#fff;box-sizing:border-box;outline:none;">
        </div>
        <div style="margin-bottom:6px;">
          <label style="font-size:13px;font-weight:600;
            color:rgba(255,255,255,0.85);display:block;
            margin-bottom:6px;">비밀번호</label>
          <div style="position:relative;">
            <input id="vp-pw" type="password"
              placeholder="비밀번호를 입력하세요"
              style="width:100%;padding:12px 40px 12px 12px;
              border:1.5px solid #333;border-radius:10px;
              font-size:15px;background:#1c1c1e;color:#fff;
              box-sizing:border-box;outline:none;">
            <span id="vp-eye" style="position:absolute;right:12px;
              top:50%;transform:translateY(-50%);
              cursor:pointer;font-size:18px;">👁</span>
          </div>
        </div>
        <p style="font-size:11px;color:#666;margin-bottom:18px;">
          초기 비밀번호: Jeju + 사번 앞 4자리<br>
          예) 사번 1603064 → Jeju1603</p>
        <button id="vp-btn" style="width:100%;padding:14px;
          background:#FF6B00;color:white;border:none;
          border-radius:10px;font-size:16px;font-weight:700;
          cursor:pointer;">로그인</button>
        <p id="vp-err" style="color:#ff453a;font-size:13px;
          text-align:center;margin-top:10px;min-height:18px;"></p>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('vp-eye').onclick = function() {
      const pw = document.getElementById('vp-pw');
      pw.type = pw.type === 'password' ? 'text' : 'password';
    };

    async function doLogin() {
      console.log('[Login] _db 직접:', typeof _db, !!_db);
      const empRaw = document.getElementById('vp-eid').value.trim();
      const pw = document.getElementById('vp-pw').value.trim();
      const err = document.getElementById('vp-err');
      const btn = document.getElementById('vp-btn');
      err.textContent = '';

      if (!empRaw || !pw) {
        err.textContent = '사번과 비밀번호를 입력해주세요.';
        return;
      }

      const empId = String(empRaw).padStart(7, '0');
      btn.textContent = '확인 중...';
      btn.disabled = true;

      try {
        if (!window._db && typeof initFirebase === 'function') {
          initFirebase();
        }
        if (!window._db) {
          // Firebase 전역 객체로 직접 초기화 시도
          try {
            window._db = firebase.firestore();
            console.log('[Login] _db 직접 초기화 성공');
          } catch(e) {
            console.error('[Login] _db 초기화 실패:', e);
            err.textContent = '연결 오류. 새로고침 후 다시 시도해주세요.';
            btn.textContent = '로그인'; btn.disabled = false;
            return;
          }
        }

        const doc = await window._db
          .collection('allowedUsers').doc(empId).get();

        if (!doc.exists || !doc.data().active) {
          err.textContent = '등록되지 않은 사번이거나 접근 제한 계정입니다.';
          btn.textContent = '로그인'; btn.disabled = false;
          return;
        }

        if (doc.data().password !== pw) {
          err.innerHTML = '비밀번호가 올바르지 않습니다.<br><span style="font-size:11px;color:#aaa;line-height:1.5;display:inline-block;margin-top:4px;">초기 비밀번호: Jeju + 사번 앞 4자리 (예: Jeju1603)<br>비밀번호 분실 시 관리자에게 초기화를 요청하세요.</span>';
          btn.textContent = '로그인'; btn.disabled = false;
          return;
        }

        localStorage.setItem(KEY, JSON.stringify({
          empId,
          name: doc.data().name || '',
          isAdmin: doc.data().isAdmin || false,
          exp: Date.now() + 7 * 24 * 60 * 60 * 1000
        }));

        try {
          await window._db.collection('allowedUsers').doc(empId)
            .update({
              lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) {}

        el.remove();
        console.log('[Login] 로그인 성공 후 화면 전환');

        // 홈 화면 표시
        if (typeof showScreen === 'function') {
          showScreen('screen-home');
        } else if (typeof renderHome === 'function') {
          renderHome();
          const home = document.getElementById('screen-home');
          if (home) home.style.display = 'block';
        }
        console.log('[Login] 성공:', empId);

        const mustChange = doc.data().mustChangePassword;
        console.log('[Login] mustChangePassword:', mustChange);

        if ((mustChange === true || mustChange === undefined) && empId !== '1603064') {
          showChangePw(empId, doc.data().password);
          return;
        }

        // mustChangePassword가 없거나 false면 보안 팝업
        showSecurityNotice();

      } catch(e) {
        console.error('[Login] 오류:', e);
        err.textContent = '오류가 발생했습니다. 다시 시도해주세요.';
        btn.textContent = '로그인'; btn.disabled = false;
      }
    }

    document.getElementById('vp-btn')
      .addEventListener('click', doLogin);
    document.getElementById('vp-pw')
      .addEventListener('keydown', function(e) {
        if (e.key === 'Enter') doLogin();
      });
    document.getElementById('vp-eid')
      .addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          document.getElementById('vp-pw').focus();
        }
      });
  }

  function showChangePw(empId, currentPw) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#000;' +
      'z-index:999999;display:flex;align-items:center;' +
      'justify-content:center;font-family:-apple-system,sans-serif;';
    el.innerHTML = `
      <div style="width:100%;max-width:340px;background:#121212;
        border-radius:16px;padding:32px 24px;margin:20px;
        border:1px solid #333;box-sizing:border-box;">
        <div style="text-align:center;margin-bottom:20px;">
          <div style="font-size:28px;">🔐</div>
          <h2 style="font-size:18px;font-weight:700;
            color:#fff;margin:8px 0 4px;">비밀번호 변경</h2>
          <p style="font-size:12px;color:rgba(255,255,255,0.5);">
            첫 로그인입니다. 개인 비밀번호를 설정해주세요.</p>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:13px;color:rgba(255,255,255,0.85);
            display:block;margin-bottom:6px;">새 비밀번호</label>
          <input id="vp-np1" type="password" placeholder="7자 이상"
            style="width:100%;padding:12px;border:1.5px solid #333;
            border-radius:10px;font-size:15px;background:#1c1c1e;
            color:#fff;box-sizing:border-box;outline:none;">
        </div>
        <div style="margin-bottom:16px;">
          <label style="font-size:13px;color:rgba(255,255,255,0.85);
            display:block;margin-bottom:6px;">비밀번호 확인</label>
          <input id="vp-np2" type="password" placeholder="동일하게 입력"
            style="width:100%;padding:12px;border:1.5px solid #333;
            border-radius:10px;font-size:15px;background:#1c1c1e;
            color:#fff;box-sizing:border-box;outline:none;">
        </div>
        <p style="font-size:11px;color:#666;margin-bottom:16px;">
          7자 이상 · 초기 비밀번호와 달라야 함</p>
        <button id="vp-cpbtn" style="width:100%;padding:14px;
          background:#FF6B00;color:white;border:none;
          border-radius:10px;font-size:16px;font-weight:700;
          cursor:pointer;">변경 완료</button>
        <p id="vp-cperr" style="color:#ff453a;font-size:13px;
          text-align:center;margin-top:10px;min-height:18px;"></p>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('vp-cpbtn')
      .addEventListener('click', async function() {
        const np1 = document.getElementById('vp-np1').value.trim();
        const np2 = document.getElementById('vp-np2').value.trim();
        const err = document.getElementById('vp-cperr');
        err.textContent = '';

        if (np1.length < 7) {
          err.textContent = '7자 이상 입력해주세요.'; return;
        }
        if (np1 === currentPw) {
          err.textContent = '초기 비밀번호와 다르게 설정해주세요.'; return;
        }
        if (np1 !== np2) {
          err.textContent = '비밀번호가 일치하지 않습니다.'; return;
        }

        try {
          await window._db.collection('allowedUsers').doc(empId)
            .update({ password: np1, mustChangePassword: false });
          el.remove();
          showSecurityNotice();
        } catch(e) {
          document.getElementById('vp-cperr')
            .textContent = '오류가 발생했습니다.';
        }
      });
  }

  function showSecurityNotice() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);' +
      'z-index:999999;display:flex;align-items:center;' +
      'justify-content:center;font-family:-apple-system,sans-serif;';
    el.innerHTML = `
      <div style="width:100%;max-width:360px;background:#fff;
        border-radius:16px;padding:28px 24px;margin:20px;
        box-shadow:0 20px 60px rgba(0,0,0,0.3);
        box-sizing:border-box;">
        <div style="text-align:center;margin-bottom:20px;">
          <div style="font-size:32px;">⚠️</div>
          <h2 style="font-size:16px;font-weight:700;
            color:#C0392B;line-height:1.4;margin:8px 0 0;">
            보안 안내 및 무단 배포 금지</h2>
        </div>
        <p style="font-size:13px;color:#333;line-height:1.7;
          margin-bottom:16px;">
          본 플랫폼은 당사 임직원의 교육 및 훈련을 위해
          운영되는 <strong>사내 자산</strong>입니다.</p>
        <div style="background:#FFF5F5;border-left:3px solid #C0392B;
          border-radius:0 8px 8px 0;padding:12px 14px;
          margin-bottom:16px;">
          <p style="font-size:13px;color:#003479;font-weight:600;
            line-height:1.8;margin:0;">
            ▶ 개인 사번/비밀번호 공유 금지<br>
            ▶ 사이트 내 모든 자료의 외부 유출 및 무단 배포 금지</p>
        </div>
        <p style="font-size:12px;color:#666;line-height:1.7;
          margin-bottom:20px;">
          위 사항을 위반할 경우 당사 보안 규정 위반으로
          개인 정보 관리에 만전을 기해 주시기 바랍니다.<br><br>
          본 시스템에 로그인하는 것은 위 보안 사항을 준수할 것에
          <strong>동의하는 것으로 간주됩니다.</strong></p>
        <button id="vp-agree" style="width:100%;padding:14px;
          background:#FF6B00;color:white;border:none;
          border-radius:10px;font-size:15px;font-weight:700;
          cursor:pointer;letter-spacing:1px;">동의합니다</button>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('vp-agree')
      .addEventListener('click', function() {
        el.remove();
        console.log('[Login] 보안 동의 완료');
        if (typeof enterApp === 'function') {
          enterApp();
        } else if (typeof showScreen === 'function') {
          showScreen('screen-home');
        }
      });
  }

  // 런칭스크린 사라진 후 세션 체크
  function waitAndCheck() {
    const launch = document.getElementById('launch-screen');
    console.log('[Login] waitAndCheck 실행, launch:', !!launch);
    const isVisible = launch &&
      launch.style.display !== 'none' &&
      launch.style.opacity !== '0' &&
      !launch.classList.contains('hidden');
    console.log('[Login] isVisible:', isVisible);
    if (isVisible) {
      setTimeout(waitAndCheck, 300);
      return;
    }
    console.log('[Login] 세션 체크 시작');
    if (!getSession()) showLogin();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(waitAndCheck, 300);
    });
  } else {
    setTimeout(waitAndCheck, 300);
  }

})();
