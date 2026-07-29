# MIRROR RUSH — 검증 리더보드 배포

정적 게임(GitHub Pages 등)은 그대로 두고, 순위표 API만 Cloudflare Workers + D1에 올립니다.

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

## 배포

```bash
npm install -g wrangler
wrangler login
```

D1 데이터베이스를 만들고, 출력된 `database_id`를 `wrangler.toml`에 넣습니다.

```bash
wrangler d1 create mirror-rush
```

스키마를 적용합니다.

```bash
wrangler d1 execute mirror-rush --file=worker/schema.sql --remote
```

`wrangler.toml`의 `ALLOWED_ORIGINS`를 게임이 올라간 출처로 바꿉니다.
비워 두면 모든 출처를 허용하니 반드시 채우세요.

배포합니다.

```bash
cd worker && wrangler deploy
```

동작을 확인합니다.

```bash
curl https://mirror-rush-api.<계정>.workers.dev/api/health
```

마지막으로 `index.html`의 `API_BASE`에 배포된 주소를 넣습니다.
비워 두면 순위표만 꺼진 채 게임은 그대로 동작합니다.

```js
const API_BASE = 'https://mirror-rush-api.<계정>.workers.dev';
```

## 주의

- **`file://`에서는 순위표가 동작하지 않습니다.** 브라우저가 교차 출처 요청을 막습니다.
  GitHub Pages 등 http(s)로 올린 뒤에 확인하세요.
- 닉네임은 **서버가 생성**합니다(`빠른거울-482` 형태). 자유 입력을 받지 않는 이유는
  부적절한 표현과 개인정보 관리 책임을 지지 않기 위해서입니다.
- 순위표는 공개됩니다. 한번 올라간 기록은 지워도 캐시에 남을 수 있습니다.
- `core.js`는 게임과 서버가 **같은 파일**을 씁니다. 규칙을 바꾸면 양쪽이 함께 바뀌므로,
  이미 등재된 기록과는 호환되지 않습니다. 규칙 변경 시 `core.js`의 `PROTOCOL`을 올리고
  시드를 새로 시작하세요.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/run` | 런 시작. `{runId, seed, serverTime}` 반환 |
| POST | `/api/submit` | `{runId, events}` 제출 → 서버가 재생·채점 후 `{rank, level, nick, position}` |
| GET | `/api/board?seed=&limit=` | 시드별 상위 기록 |
| GET | `/api/health` | 상태 확인 |
