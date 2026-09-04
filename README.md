# 🎮 미니게임 모음

정적 사이트로 만든 미니게임 모음입니다. 서버/DB 없이 GitHub Pages 등에 바로 배포할 수 있습니다.

## 로컬에서 확인하기

`main.js`가 `games.json`을 `fetch`로 읽기 때문에 `index.html`을 파일로 직접 열면(file://) 브라우저 보안 정책으로 로드가 안 될 수 있습니다. 아래처럼 로컬 서버를 띄워 확인하세요.

```bash
# 프로젝트 폴더에서
python -m http.server 8000
# 또는
npx serve .
```

이후 `http://localhost:8000` 접속.

## 새 게임 추가하는 방법

새 게임을 추가할 때 해야 할 일은 딱 두 가지입니다.

### 1. `games/` 폴더 아래에 새 게임 폴더 만들기

`games/_template/` 폴더를 통째로 복사해서 새 이름으로 바꿉니다.

```
games/_template/  →  games/my-new-game/
```

`games/my-new-game/` 안의 `script.js`에 게임 로직을 작성하세요. `index.html`, `style.css`는 필요에 따라 수정해도 되지만, 최소한으로도 바로 동작합니다.

### 2. `games.json`에 게임 정보 한 줄 추가하기

루트의 [games.json](games.json)에 아래 형식으로 항목을 추가합니다.

```json
{
  "id": "my-new-game",
  "title": "내 새 게임",
  "description": "한 줄 설명",
  "path": "games/my-new-game/index.html",
  "thumbnail": "assets/my-new-game-thumb.png"
}
```

- `id`, `path`는 필수입니다. 없으면 메인 페이지에서 해당 항목이 표시되지 않습니다.
- `thumbnail`을 생략하거나 이미지가 없으면 기본 썸네일([assets/default-thumb.svg](assets/default-thumb.svg))이 표시됩니다.

이게 전부입니다. 메인 페이지([index.html](index.html), [main.js](main.js))는 `games.json`을 읽어 카드 목록을 자동으로 그리므로, 메인 페이지 코드를 직접 수정할 필요가 없습니다.

## 폴더 구조

```
game-collection/
├── index.html          # 메인 페이지
├── style.css            # 공통 스타일
├── main.js               # games.json을 읽어 카드 렌더링
├── games.json             # 게임 메타데이터 목록
├── games/
│   └── _template/          # 새 게임 만들 때 복사하는 템플릿
│       ├── index.html
│       ├── style.css
│       └── script.js
└── assets/                  # 공통 이미지/아이콘
```

## 랭킹(순위표)이 필요한 게임을 만들 때

사이트 전체에 DB를 깔 필요는 없습니다. 랭킹이 필요한 그 게임 폴더 안에서만 Firebase(Firestore)나 Supabase 같은 가벼운 백엔드를 연결하세요. 나머지 게임과 메인 페이지는 그대로 정적으로 유지됩니다. 랭킹이 필요 없는 게임은 `localStorage`만 사용하면 됩니다.
