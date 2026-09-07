# 오목 (1대1) 설정 방법

다른 게임과 달리 오목은 **로그인이 필수**입니다 — 1대1 대전이라 "이 방의 두 명 중
누가 나인지"를 새로고침 후에도 구분할 신원이 있어야 하고, 게스트 신원은 그걸
보장하지 못합니다. 계정 자체는 사이트 공용([../../firebase-config.js](../../firebase-config.js),
[../../auth.js](../../auth.js))을 그대로 씁니다 — 자세한 설정 방법은
[games/crossword/README.md](../crossword/README.md)를 참고하세요.

## 어떻게 매칭되나 (방 코드 방식)

로비/매치메이킹 큐 없이 **방 코드 공유** 방식입니다.

1. 한쪽이 "새 방 만들기"를 누르면 6자리 코드(대문자+숫자, 헷갈리는 `0/O`, `1/I`
   제외)를 가진 방이 `omok-rooms/{코드}` 문서로 만들어지고 대기 화면이 뜹니다.
2. 코드나 링크(`?room=코드`가 붙은 URL)를 상대에게 보내주면, 상대가 코드를 입력하거나
   링크를 열어서 참가합니다 — 링크를 열면 로그인 여부와 상관없이 자동으로 그 방에
   참가를 시도합니다(로그인 안 돼 있으면 로그인 후 자동으로 이어서 참가).
3. 참가하는 순간 방 상태가 `playing`으로 바뀌고 두 클라이언트 모두
   [Firestore `onSnapshot`](https://firebase.google.com/docs/firestore/query-data/listen)으로
   같은 문서를 실시간 구독하므로, 한쪽이 돌을 두면 상대 화면에도 거의 즉시 반영됩니다.
4. 게임이 끝나면(승/무) "재대결"로 같은 방을 초기화해서 바로 다시 둘 수 있습니다.

방 문서는 게임이 끝나도 자동으로 삭제되지 않습니다 — 캐주얼 용도라 정리 없이
쌓이는 걸 감수했습니다(사이트의 `daily-scores` 문서들과 같은 방침).

## 데이터 구조

`omok-rooms/{roomCode}` 문서 하나 = 방 하나:

```
{
  hostUid, hostNickname,      // 방 만든 사람 = 흑돌(1)
  guestUid, guestNickname,    // 참가한 사람 = 백돌(2), 참가 전엔 null
  board: number[225],         // 15x15을 평평하게 편 배열. 0=빈칸, 1=흑, 2=백
                               // (Firestore는 배열의 배열을 지원하지 않아서 평평하게 폄)
  turn: "host" | "guest",
  status: "waiting" | "playing" | "finished",
  winner: null | "host" | "guest" | "draw",
  winLine: null | number[],   // 승리 시 연결된 칸들의 인덱스 (하이라이트용)
  moveCount,
  createdAt, updatedAt,
}
```

승리 판정(`games/omok/script.js`의 `checkWin()`)은 자유 룰(freestyle) 기준으로,
정확히 5개가 아니라 5개 "이상" 연속이어도 이깁니다(엄격한 렌주 룰의 장목 금지 같은
제한 없음) — 규칙을 최대한 단순하게 유지하기 위한 의도적인 단순화입니다.

## Firestore 보안 규칙 (추가분)

기존 [games/crossword/README.md](../crossword/README.md)에 있는 규칙에 아래
`omok-rooms` 블록을 **같은 `match /databases/{database}/documents { ... }` 안에**
추가하세요.

```
match /omok-rooms/{roomId} {
  allow read: if true;
  allow create: if request.auth != null
                && request.resource.data.hostUid == request.auth.uid
                && request.resource.data.guestUid == null
                && request.resource.data.status == "waiting"
                && request.resource.data.turn == "host"
                && request.resource.data.board is list
                && request.resource.data.board.size() == 225;
  // 방의 host/guest만 쓸 수 있고, guest 자리가 비어있을 때 자기 uid로
  // 채워 넣는 "참가" 액션도 허용합니다. 크로스워드 규칙과 같은 이유로
  // 이번 턴이 정말 내 차례가 맞는지, 이 칸이 정말 비어있었는지, 보드가
  // 딱 한 칸만 바뀌었는지까지는 규칙에서 검증하지 않습니다(Cloud
  // Functions 없이는 배열 diff 검증이 번거롭습니다) -- 클라이언트가
  // Firestore 트랜잭션으로 이미 막고 있고, 어차피 로그인한 두 명만
  // 이 문서를 쓸 수 있다는 게 이 캐주얼 게임의 실질적 방어선입니다.
  allow update: if request.auth != null
                && (
                  request.auth.uid == resource.data.hostUid ||
                  request.auth.uid == resource.data.guestUid ||
                  (resource.data.guestUid == null && request.resource.data.guestUid == request.auth.uid)
                );
}
```

규칙을 아직 안 붙였거나 Firebase 설정 자체가 안 돼 있으면, 오목 페이지는 로그인
필요 안내 화면만 보여주고 조용히 멈춥니다(다른 게임이 깨지지 않습니다).
