// 계정(로그인/회원가입/점수)과, 게임별 랭킹을 쓰려면 Firebase 프로젝트를 만들고
// 아래 값을 채워야 합니다. 값을 채우기 전까지는 로그인 UI 자체가 숨겨지고,
// 계정이 필요 없는 게임/기능은 그대로 정상 동작합니다.
//
// 설정 방법 (5분 정도 걸립니다):
// 1. https://console.firebase.google.com 접속 → 프로젝트 추가
// 2. 왼쪽 메뉴 Firestore Database → 데이터베이스 만들기 → "테스트 모드"로 시작
//    (테스트 모드는 30일 후 만료되니, 이후 games/crossword/README.md의 보안 규칙으로 교체하세요)
// 3. 왼쪽 메뉴 Authentication → 시작하기 → Sign-in method → 이메일/비밀번호 사용 설정
// 4. 프로젝트 설정(톱니바퀴) → 일반 → "내 앱" → 웹 앱 추가(</> 아이콘)
// 5. 나오는 firebaseConfig 객체 값을 아래에 그대로 붙여넣기
//
// 이 파일은 사이트 루트에 있는 공용 파일입니다 — 메인 페이지 헤더의 로그인 UI와,
// 계정 기능을 쓰는 게임(현재는 games/crossword)이 함께 사용합니다.
window.__firebaseConfig = {
  apiKey: "AIzaSyBJatEHfti9f3bOSr83TmkY_DxWXPGaUCM",
  authDomain: "workslack-c47b2.firebaseapp.com",
  projectId: "workslack-c47b2",
  storageBucket: "workslack-c47b2.firebasestorage.app",
  messagingSenderId: "254739799663",
  appId: "1:254739799663:web:92f9dd34b575a7145d379a",
};
