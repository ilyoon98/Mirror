# MIRROR RUSH 배포하기

게임과 순위 서버를 **Cloudflare 한 곳에 같이** 올립니다.
GitHub Pages나 Vercel은 필요 없습니다.

- 게임(정적 파일)과 API가 **같은 주소**를 쓰므로 CORS 설정이 필요 없습니다.
- 배포하면 `API_BASE` 같은 걸 채울 필요 없이 순위가 **자동으로 켜집니다**.

## 준비 (한 번만)

Node가 있어야 합니다. 없으면 <https://nodejs.org> 에서 LTS를 설치하세요.

```bash
npm install -g wrangler
```

```bash
wrangler login
```

브라우저가 열리면 Cloudflare 계정으로 허용을 누릅니다.

## 1. 데이터베이스 만들기

저장소 최상위(`wrangler.toml`이 있는 폴더)에서 실행합니다.

```bash
wrangler d1 create mirror-rush
```

출력에 이런 줄이 나옵니다.

```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

이 값을 `wrangler.toml`의 `PASTE_YOUR_D1_DATABASE_ID_HERE` 자리에 붙여넣습니다.

## 2. 표 만들기

```bash
wrangler d1 execute mirror-rush --file=worker/schema.sql --remote
```

## 3. 배포

```bash
wrangler deploy
```

끝나면 주소가 출력됩니다.

```
https://mirror-rush.<계정이름>.workers.dev
```

그 주소로 접속하면 게임이 뜨고, 우측 상단 **순위** 버튼에 전체 순위가 나옵니다.

## 확인

```bash
curl https://mirror-rush.<계정이름>.workers.dev/api/health
```

`{"ok":true,...}` 가 나오면 정상입니다.

## 자주 막히는 곳

- **내 컴퓨터에서 `public/index.html`을 더블클릭해 열면 순위가 안 됩니다.**
  브라우저가 `file://`에서는 서버 요청을 막습니다. 게임 자체와 오늘의 판, 기록 코드는
  그대로 동작하니 개발 중에는 이대로 쓰셔도 됩니다.
- 로컬에서 순위까지 시험해 보려면:

  ```bash
  wrangler dev
  ```

  `http://localhost:8787` 로 접속합니다. (`--remote` 없이 쓰면 로컬 임시 DB를 씁니다)

## 무엇을 검증하고, 무엇을 검증하지 못하는가

**검증합니다**
- 제출된 입력 로그를 서버가 `core.js`로 **그대로 재생해 점수를 직접 계산**합니다.
  클라이언트가 보낸 점수는 받지도 않습니다.
- 그 시드에서 불가능한 수(거울 칸 발사, 범위 밖, 잘못된 방향 등)는 거부합니다.
- 런 시작 시각을 **서버 시계**로 찍어, 보고된 시각의 합보다 실제 경과가 짧으면 거부합니다.
  "0초 만에 100레벨" 류를 막습니다.
- 한 런은 한 번만 제출됩니다.

**검증하지 못합니다**
- 사람이 직접 푼 것인지 자동 풀이기가 푼 것인지는 구분하지 못합니다.
  판이 결정론적이라 완전 탐색으로 최적해를 계산할 수 있고, 실제 시간만 흘려보내면
  정직한 제출과 구분되지 않습니다.
- 즉 이 시스템은 **"불가능한 점수"를 막지, "사람이 아닌 것"을 막지는 않습니다.**
  친구·소규모 커뮤니티 순위표로는 충분하지만, 상금이 걸린 랭킹에는 부족합니다.

## 그 밖에

- 닉네임은 **서버가 생성**합니다(`날카로운반사-800` 형태). 자유 입력을 받지 않는 이유는
  부적절한 표현과 개인정보 관리 책임을 지지 않기 위해서입니다.
- 순위표는 공개됩니다. 한번 올라간 기록은 지워도 캐시에 남을 수 있습니다.
- `core.js`는 게임과 서버가 **같은 파일**을 씁니다. 규칙을 바꾸면 이미 등재된 기록과
  호환되지 않으므로, 규칙을 바꿀 때는 `core.js`의 `PROTOCOL`을 올리세요.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/run` | 런 시작. `{runId, seed, serverTime}` 반환 |
| POST | `/api/submit` | `{runId, events}` 제출 → 서버가 재생·채점 후 `{rank, level, nick, position}` |
| GET | `/api/board?seed=&limit=` | 시드별 상위 기록 |
| GET | `/api/health` | 상태 확인 |
