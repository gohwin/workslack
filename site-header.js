// 사이트 전체 공용 헤더(로고 + 로그인/회원가입/내 정보 UI)와 그 팝업들(auth-form,
// my-info-panel)을 그 자리에 바로 심습니다. auth.js가 여기 나오는 id들을
// document.getElementById로 즉시(스크립트 최상단에서) 찾으므로, 이 파일은 반드시
// auth.js보다 먼저 로드되어야 합니다 -- 사이트 전체가 쓰는 "document.write로
// <script>/<link> 태그를 그 자리에 바로 삽입" 방식과 같은 이유로, 여기서도
// document.write를 씁니다(마크업 자체가 나중에 비동기로 끼워지면 auth.js가
// 실행되는 시점에 아직 DOM에 없을 수 있음).
//
// 메인 페이지(index.html)에서는 window.__siteBase가 없으니 "index.html"로,
// games/<id>/ 페이지에서는 games/crossword/index.html의 <script> 블록이 미리
// 계산해 둔 window.__siteBase를 그대로 써서 "../../index.html" 상대경로 문제를
// 각 페이지가 다시 계산할 필요 없게 합니다.
(function () {
  var homeHref = typeof window.__siteBase === "string" ? window.__siteBase + "index.html" : "index.html";
  // Each game page's <head> script sets window.__gameTitle (see
  // games/*/index.html) before this file loads, specifically so the title
  // can be written into the nav bar here instead of the page repeating it
  // as its own <h1> -- that used to eat a full extra row of vertical space
  // on every game page, which mattered enough to fix once survivor's canvas
  // started needing to fit the viewport height exactly. No separate "back
  // to list" link -- the brand logo on the left already goes there.
  var gameTitle = typeof window.__gameTitle === "string" ? window.__gameTitle : null;
  var gameNavHtml = gameTitle
    ? '<div class="nav-game"><span class="nav-game-title">' + gameTitle + '</span></div>'
    : "";

  document.write(
    '<div class="nav-bar">' +
      '<a class="brand" href="' + homeHref + '">work<span class="brand-accent">slack</span><span class="brand-tld">.gg</span></a>' +
      gameNavHtml +
      '<div id="account-area" class="account-area" hidden>' +
        '<div id="account-guest" class="account-row">' +
          '<span class="account-hint">계정을 만들면 완료할 때마다 점수가 쌓여요</span>' +
          '<button id="show-login-btn" class="btn btn-ghost">로그인</button>' +
          '<button id="show-signup-btn" class="btn btn-accent">회원가입</button>' +
        '</div>' +
        '<div id="account-logged-in" class="account-row" hidden>' +
          '<span id="account-info"></span>' +
          '<button id="my-info-btn" class="btn btn-ghost">내 정보</button>' +
          '<button id="logout-btn" class="btn btn-ghost">로그아웃</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div id="auth-form-area" class="auth-form" hidden>' +
      '<input id="auth-username" type="text" maxlength="16" placeholder="아이디 (영문/숫자, 3~16자)" autocomplete="off" />' +
      '<input id="auth-password" type="password" maxlength="64" placeholder="비밀번호 (6자 이상)" autocomplete="off" />' +
      '<input id="auth-nickname" type="text" maxlength="12" placeholder="닉네임 (최대 12자)" autocomplete="off" hidden />' +
      '<div class="auth-form-actions">' +
        '<button id="auth-submit-btn" class="btn btn-accent"></button>' +
        '<button id="auth-cancel-btn" class="btn btn-ghost">취소</button>' +
      '</div>' +
      '<p id="auth-status" class="auth-status"></p>' +
    '</div>' +

    '<div id="my-info-area" class="my-info-panel" hidden>' +
      '<div class="my-info-header">' +
        '<h3>내 정보</h3>' +
        '<button id="my-info-close-btn" class="my-info-close" aria-label="닫기">✕</button>' +
      '</div>' +
      '<p id="my-info-score" class="my-info-score"></p>' +
      '<div class="my-info-section">' +
        '<label for="nickname-change-input">닉네임 변경</label>' +
        '<div class="my-info-row">' +
          '<input id="nickname-change-input" type="text" maxlength="12" autocomplete="off" />' +
          '<button id="nickname-change-btn" class="btn btn-accent">변경</button>' +
        '</div>' +
        '<p id="nickname-change-status" class="auth-status"></p>' +
      '</div>' +
      '<div class="my-info-section">' +
        '<p class="my-info-section-title">점수 내역</p>' +
        '<p id="score-history-status" class="leaderboard-status"></p>' +
        '<ol id="score-history-list" class="score-history-list"></ol>' +
      '</div>' +
    '</div>'
  );
})();
