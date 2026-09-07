# 점수 · 랭킹(Firebase) 설정 방법

이 사이트의 게임 5개(스도쿠, 지뢰찾기, 크로스워드, 타자 연습, 2048)는 모두 계정 없이
로컬에서 완전히 동작합니다. 계정을 만들면 **깰 때마다 매번** 점수가 쌓이고(하루
1회 같은 제한 없음), 그 점수가 메인 페이지 사이드바의 두 랭킹에 반영됩니다.

- **전체 누적 점수 랭킹**: 계정을 만든 이후 지금까지 쌓은 점수 총합.
- **오늘 획득한 점수**: 오늘 하루 동안 획득한 점수 합계로 매긴 순위. 자정에
  다시 0부터 시작합니다.

**점수 정책** (게임별 `script.js`에 정의):
- 크로스워드: 완성할 때마다 고정 100점
- 스도쿠 / 지뢰찾기: 난이도별 차등 — 쉬움 50점, 중간 100점, 어려움 200점
- 타자 연습: 고정 점수 없음 — 그 판에서 터뜨린 단어 수가 그대로 적립 점수
  (한 판에 몇십 점도 나올 수 있음 -- 그래서 Firestore 규칙에 "한 번에 최대
  N점" 같은 상한을 두지 않음, 아래 2번 참고)
- 2048: 고정 점수 없음 — 게임 오버 시점의 점수를 20으로 나눈 값(최대 900점).
  원점수 자체를 그대로 적립하면 손쉽게 수만 점이 나와서 다른 게임과 스케일이
  전혀 안 맞고, `crossword-users/{uid}/history` 규칙의 단일 기록 상한
  1000점도 넘어버린다 — 그래서 이 게임만 클라이언트 쪽에서 점수를 줄이고
  900점으로 한 번 더 clamp해서, 상한을 계속 따라 올리지 않고도 규칙 안에
  들어오게 했다(`games/2048/script.js`의 `SCORE_TO_POINTS_DIVISOR`/`MAX_POINTS`).

크로스워드/스도쿠/지뢰찾기가 원래 10~20점대였다가 한 번에 100~200점대로
올라간 건, 타자 연습 한 판이 몇십 점씩 쉽게 나오는 것에 비해 다른 게임들의
점수가 너무 작게 느껴져서(한 판 깨는 데 걸리는 시간/난이도에 비해 손해처럼
보임) 전부 10배로 맞춘 것입니다. 새 게임을 추가할 때도 "한 판(또는 완료 1회)
깨는 데 걸리는 시간과 난이도가 다른 게임들과 비슷하다면 비슷한 점수대"로
맞춰주세요.

**파일 위치**: 로그인/회원가입/계정, 점수 적립, 랭킹 표시는 사이트 전체
공용이라 게임 폴더가 아니라 프로젝트 루트에 있습니다 —
[firebase-config.js](../../firebase-config.js)(Firebase 설정값),
[auth.js](../../auth.js)(로그인/회원가입/로그아웃 + `awardPoints()` 공용 점수
적립 함수 + 메인 페이지 헤더 UI), [leaderboard.js](../../leaderboard.js)(메인
페이지 사이드바의 두 랭킹). 각 게임의 `script.js`는 승리 시점에
`awardPoints(점수, 게임id, 표시이름)`을 호출하기만 하면 되고, 나머지(계정
누적, 오늘의 랭킹, 점수 내역 기록)는 `auth.js`가 알아서 처리합니다.

**로그인/회원가입 UI와 랭킹 목록은 게임 페이지가 아니라 사이트 메인
페이지([index.html](../../index.html))에 있습니다** — 로그인은 헤더에, 랭킹은
사이드바에. 계정은 사이트 전체 공용이라, 메인 페이지에서 로그인해두면 어느
게임 페이지에 들어가도 자동으로 로그인 상태로 인식됩니다. 각 게임 페이지
안에는 현재 로그인 상태를 보여주는 안내 문구만 남아 있습니다.

## 1. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 → "프로젝트 추가"
2. 왼쪽 메뉴에서 **Firestore Database** → "데이터베이스 만들기" → 우선 **테스트 모드**로 시작
   (테스트 모드는 30일 후 자동으로 잠기니, 아래 2번의 보안 규칙으로 미리 바꿔두는 걸 권장합니다)
3. 왼쪽 메뉴에서 **Authentication** → "시작하기" → 로그인 방법 탭에서 **이메일/비밀번호**
   제공업체를 사용 설정. (아이디/비밀번호 계정 기능에 필요합니다 — 실제로 이메일을
   보내지는 않고, `아이디@crossword.local` 같은 내부용 가짜 이메일로만 씁니다)
4. 프로젝트 설정(톱니바퀴 아이콘) → 일반 탭 → "내 앱" → 웹 앱 추가(`</>` 아이콘)
5. 나오는 `firebaseConfig` 객체 값을 사이트 **루트**의 [firebase-config.js](../../firebase-config.js)에
   그대로 붙여넣기 (게임 폴더 안이 아니라 프로젝트 최상위 파일입니다 — 로그인이
   사이트 전체 공용이라 계정 관련 설정도 공용 위치에 있습니다)

붙여넣고 나면 메인 페이지 헤더에 로그인/회원가입 버튼이 나타나고, 각 게임을
깰 때마다 점수가 적립되면서 사이드바 랭킹에 반영됩니다.

## 2. Firestore 보안 규칙

계정이 필요한 기능이라 모든 쓰기는 본인 계정으로 로그인한 사람만, 본인 문서만
건드릴 수 있도록 막습니다. Firebase 콘솔의 Firestore Database → 규칙 탭에서
아래로 교체하세요.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /crossword-users/{uid} {
      allow read: if true;
      allow create: if request.auth != null && request.auth.uid == uid
                    && request.resource.data.totalScore == 0
                    && request.resource.data.nickname is string
                    && request.resource.data.nickname.size() <= 12;
      // 점수 적립(증가, 닉네임 불변) 또는 닉네임 변경(점수 불변)만 허용 --
      // 둘 다 동시에 바뀌는 요청은 막는다. 한 번의 증가 폭에 상한을 두지
      // 않는다 -- 처음엔 "한 번에 최대 20점"(스도쿠/지뢰찾기 어려움)으로
      // 맞춰뒀었는데, 타자 연습처럼 한 판에 몇십 점씩도 나오는 게임이 생기자
      // 그 게임의 정상적인 점수 적립이 그냥 permission-denied로 막혀버렸다.
      // 게임마다 점수 스케일이 다르고 앞으로도 계속 게임이 늘어날 걸 감안하면
      // 상한을 게임 종류에 맞춰 계속 따라 올리는 것보다, 애초에 상한을 두지
      // 않는 게 낫다 -- 이 사이트의 위협 모델(캐주얼 점수 제도, Cloud
      // Functions 없이 클라이언트 증가값을 규칙으로만 검증)에서는 "본인 계정만
      // 건드릴 수 있다"가 실질적인 방어선이지, 증가 폭 상한이 아니었다.
      allow update: if request.auth != null && request.auth.uid == uid
                    && (
                      (request.resource.data.totalScore > resource.data.totalScore
                       && request.resource.data.nickname == resource.data.nickname)
                      ||
                      (request.resource.data.totalScore == resource.data.totalScore
                       && request.resource.data.nickname is string
                       && request.resource.data.nickname.size() > 0
                       && request.resource.data.nickname.size() <= 12)
                    );
    }

    // 오늘 하루 동안 각 계정이 획득한 점수 합계. 본인 문서만 늘릴 수 있고,
    // 누구나 읽을 수 있습니다(사이드바 "오늘 획득한 점수" 랭킹용).
    match /daily-scores/{date}/entries/{uid} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid
                   && request.resource.data.nickname is string
                   && request.resource.data.nickname.size() <= 12
                   && request.resource.data.points is number
                   && request.resource.data.points >= 0;
    }

    // 점수를 언제, 어느 게임에서 얼마나 받았는지 기록. 본인만 읽을 수 있고,
    // 한 번 쓰면 수정/삭제는 안 됩니다(내역 조작 방지).
    match /crossword-users/{uid}/history/{entryId} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create: if request.auth != null && request.auth.uid == uid
                    && request.resource.data.points is number
                    && request.resource.data.points > 0
                    && request.resource.data.points <= 1000
                    && request.resource.data.game is string
                    && request.resource.data.gameLabel is string;
      allow update, delete: if false;
    }
  }
}
```

이 규칙들은 "형식이 맞고, 본인 계정만 건드릴 수 있다" 정도의 방어입니다.
완벽한 부정 방지는 아니지만(Cloud Functions 없이 클라이언트 증가값을 규칙으로만
검증하는 수준), 친목/캐주얼용 점수 제도로는 충분합니다.

## 3. 데이터 구조

- `crossword-users/{uid}` — 계정 하나. `{ username, nickname, totalScore, createdAt }`.
  `username`은 로그인용 아이디, `nickname`은 랭킹에 표시되는 이름입니다.
  로그인한 사람이 어떤 게임이든 깰 때마다 `totalScore`가 그 게임의 점수만큼
  늘어납니다. `nickname`은 메인 페이지 헤더의 "내 정보"에서 언제든 바꿀 수
  있습니다(이미 등록된 과거 랭킹 기록의 표시 이름은 소급 변경되지 않습니다).
- `daily-scores/{YYYY-MM-DD}/entries/{uid}` — 그날 한 계정이 모든 게임에서
  획득한 점수 합계. `{ nickname, points, updatedAt }`. 매번 점수를 받을 때마다
  `points`가 누적되고, 자정이 지나 날짜가 바뀌면 새 문서로 다시 0부터
  시작합니다.
- `crossword-users/{uid}/history/{entryId}` — 점수를 받을 때마다 쌓이는 내역.
  `{ game, gameLabel, points, createdAt }`. "내 정보" 패널의 점수 내역 목록에
  최근 20개가 표시됩니다. 본인만 읽을 수 있고 한 번 쓰면 수정/삭제되지 않습니다.

아이디는 Firebase Auth 내부에서 `아이디@crossword.local` 형태의 이메일로 취급되므로,
같은 아이디로 두 번 가입할 수 없습니다(이미 있는 아이디면 가입 시 자동으로 걸러집니다).
비밀번호는 Firebase가 직접 해시해서 저장하며, 이 사이트 코드나 Firestore 어디에도
평문으로 남지 않습니다.

## 4. 새 게임에 점수 붙이기

게임이 이겼을 때 딱 한 줄이면 됩니다:

```js
await awardPoints(점수, "게임id", "랭킹/내역에 표시할 이름");
```

로그인 안 한 상태에서 호출하면 아무것도 하지 않고 `false`를 반환합니다(게임
자체는 로그인 없이도 자유롭게 플레이 가능). 반복 플레이를 허용할지, 하루/판당
제한을 둘지는 전적으로 게임 쪽 로직이 정합니다 — `awardPoints()`는 아무 제한도
걸지 않습니다.

## 5. 크로스워드 문제(퍼즐)는 어떻게 만들어지나

미리 만들어 둔 문제 목록(`puzzles.json` 같은 것)이 없습니다 — **플레이할 때마다
브라우저에서 그 자리에 새로 생성**합니다. [crossword_words.js](crossword_words.js)의
`COMMON_POOL`(공용 단어 풀)을 무작위로 섞어 [auto_crossword.js](auto_crossword.js)의
`autoPlace()`로 서로 교차하는 배치를 시도하는 걸 짧은 시간(`script.js`의
`GEN_TIME_BUDGET_MS`, 기본 1.8초) 동안 최대 `GEN_MAX_ATTEMPTS`번 반복하면서, 그중
**단어 수 × 밀도(채워진 칸 / 전체 칸)** 점수가 가장 높은 조합을 채택합니다.
`startNewPuzzle()`이 이 과정을 감싸고 있고, 게임 시작 시 + "다음 문제" 버튼을 누를
때마다 매번 다시 돌아갑니다. 그래서 같은 문제가 반복될 일이 (사실상) 없습니다 — 이
두 파일(`crossword_words.js`, `auto_crossword.js`)은 이제 개발 도구가 아니라 게임이
직접 불러다 쓰는 실행 코드라 `tools/` 폴더가 아니라 이 게임 폴더 바로 아래에 있습니다.

**주의: 점수를 "단어 수"만으로 매기면 안 됩니다.** `GEN_MAX_DIM`(최대 칸수)만 키우고
단어 수만 비교하면, 생성기는 굳이 촘촘하게 안 뭉쳐도 되니 가장 쉬운 길인 "대각선으로
계속 새 단어 하나씩 이어 붙이기"를 택해버려서 오히려 더 듬성듬성해집니다(실제로
`GEN_MAX_DIM`을 15로 올렸다가 이 문제로 되돌린 적이 있습니다). 밀도를 점수에 같이
넣어야 큰 칸수를 허용해도 성기게 퍼지지 않고 촘촘한 조합을 고릅니다. `GEN_MAX_DIM`을
더 키우고 싶다면 이 점을 염두에 두세요 — 단어 풀 자체가 함께 커지지 않으면 칸수
상한만 올려도 밀도가 오르지 않습니다(현재 [crossword_words.js](crossword_words.js)는
약 220개, 음절 길이는 2글자 10% / 3글자 60% / 4글자 20% / 5글자 10% 비율로
맞춰져 있음).

**주의 2: 어느 크로싱을 쓸지도 무작위로 골라야 합니다.** `autoPlace()`가 한 단어를
붙일 자리를 찾을 때 "처음 발견한 유효한 자리"를 그냥 확정해버리면(예전 구현이 그랬음),
입력 단어 순서를 아무리 섞어도 매번 거의 같은 모양(왼쪽 위에서 오른쪽 아래로 이어지는
계단 모양)으로 수렴합니다 — 오래된 칸부터 순서대로 훑다가 맨 처음 맞는 자리에서 바로
멈추기 때문입니다. 지금은 유효한 자리를 다 모아 둔 다음 그중 하나를 무작위로 골라서
붙입니다(`autoPlace()`의 `candidates` 배열). 이게 "판마다 실제로 다른 모양"이 나오게
하는 핵심입니다.

**레이아웃 규칙**: 한 칸은 가로 단어 하나 + 세로 단어 하나까지만 지날 수 있고(가로끼리,
세로끼리는 절대 겹치지 않음), 같은 방향 단어끼리는 최소 한 칸(검은 칸)을 띄웁니다 —
[auto_crossword.js](auto_crossword.js)의 `tryPlace`가 강제합니다. 이 두 규칙만 지키면
한 줄에 가로 단어가 여러 개 들어가는 것도 허용되므로, NYT 미니 크로스워드처럼 여러 짧은
단어가 촘촘하게 맞물리는 구조가 나옵니다.

**단어를 더 추가하고 싶을 때**: [crossword_words.js](crossword_words.js)의
`COMMON_POOL` 배열에 `w("단어", "뜻 설명")` 형식으로 추가하면 됩니다. 좌표는 몰라도
됩니다 — 다음에 플레이할 때부터 바로 그 단어도 후보에 포함됩니다. 어떻게 배치되는지
브라우저 없이 터미널에서 미리 보고 싶다면:

```bash
cd games/crossword/tools
node build_puzzles.js       # 기본 7개를 만들어 tools/preview.json에 저장 + 콘솔 출력
node build_puzzles.js 14    # 14개 미리보기
```

`build_puzzles.js`는 실제 게임이 쓰지 않는 **디버그/미리보기 전용** 스크립트입니다 —
실제 플레이는 항상 브라우저에서 바로 생성됩니다.

### 왜 이렇게 만드나

칸 하나는 가로 단어 하나 + 세로 단어 하나, 최대 둘까지만 지날 수 있습니다. 그래서 "학교,
학생, 학원, 방학"처럼 같은 글자(학)를 공유하는 단어를 아무리 많이 넣어도, 그 글자가 있는
칸 하나에는 실제로 딱 2개만 꽂힐 수 있고 나머지는 배치를 못 합니다 — 즉 큰 십자말풀이를
만들려면 몇 개의 "허브 글자"보다 애초에 단어 풀 자체가 크고 다양해야 하고, 어떤 순서로
시도하느냐에 따라 결과 크기가 달라집니다. `generatePuzzle()`(script.js)은 이걸 감안해서
같은 단어 풀을 매번 무작위 순서로 섞어 여러 번 시도하고, 그중 가장 크게 나온 조합을
채택합니다.

[auto_crossword.js](auto_crossword.js)의 배치 로직은 같은 칸에 가로-가로
또는 세로-세로 단어가 겹치는 걸 자동으로 막고, 최종 격자에서 모든 단어가 실제로 정확히
읽히는지(교차점 글자가 일치하는지) 다시 한번 검증한 뒤에만 결과를 씁니다 — 그래서 이
스크립트로 만든 퍼즐은 손으로 좌표를 잘못 계산해 생기는 오류가 날 수 없습니다.
