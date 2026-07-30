# MIRROR RUSH 배포하기

> **현재 배포 주소: <https://mirror-rush.ilyoon362.workers.dev>**
> D1 데이터베이스 `mirror-rush`(APAC)와 함께 이미 떠 있습니다.
> 코드를 고친 뒤에는 저장소 최상위에서 `wrangler deploy` 한 줄이면 갱신됩니다.


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

### 이미 배포된 데이터베이스라면

`schema.sql` 은 다시 실행할 수 없습니다(표가 이미 있습니다).
`worker/migrations/` 의 변경만 순서대로 적용하세요. **배포보다 먼저 해야 합니다** —
열이 없으면 런 시작이 실패해 순위 기능이 통째로 죽습니다.

```bash
wrangler d1 execute mirror-rush --file=worker/migrations/001-free-board.sql --remote
```

```bash
wrangler d1 execute mirror-rush --file=worker/migrations/002-client-id.sql --remote
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
- **시드는 서버가 발급합니다.** 자유 플레이가 순위표의 주력이 되면서,
  클라이언트가 고른 시드를 인정하면 유리한 판만 골라 담을 수 있게 됩니다.
  열려 있는 런이 있으면 **같은 런을 그대로 돌려주어**(10분) 재추첨 비용을 올립니다.
  같은 IP 의 시간당 런 시작은 40회로 제한합니다.

**검증하지 못합니다**
- 사람이 직접 푼 것인지 자동 풀이기가 푼 것인지는 구분하지 못합니다.
  판이 결정론적이라 완전 탐색으로 최적해를 계산할 수 있고, 실제 시간만 흘려보내면
  정직한 제출과 구분되지 않습니다.
- 즉 이 시스템은 **"불가능한 점수"를 막지, "사람이 아닌 것"을 막지는 않습니다.**
  친구·소규모 커뮤니티 순위표로는 충분하지만, 상금이 걸린 랭킹에는 부족합니다.

## 그 밖에

- 이름은 **플레이어가 직접 적습니다**(v1.4). 비워 두면 서버가 지어 줍니다
  (`날카로운반사-800` 형태). `cleanName` 이 12자·제어문자·링크만 막고
  **표현 자체는 걸러내지 않습니다** — 문제가 되면 금지어 목록을 그 함수에 추가하세요.
  v1.1~v1.3 은 이 책임을 피하려고 자유 입력을 받지 않았는데, v1.4 에서 뒤집은 결정입니다.
- 열린 런 재사용은 **기기 식별자(`client_id`) 기준**입니다. IP 기준으로 묶었더니
  같은 네트워크의 두 사람이 한 런을 공유해 뒤에 제출한 쪽이 409 로 실패했습니다.
  `client_id` 는 클라이언트가 만드는 값이라 재추첨을 완전히 막지는 못합니다 —
  실제 브레이크는 IP 기준 시간당 상한(`IP_CAP`)입니다.
- 순위표는 공개됩니다. 한번 올라간 기록은 지워도 캐시에 남을 수 있습니다.
- **IP 는 평문으로 저장하지 않습니다.** 열린 런 재사용과 시간당 상한에만 쓰이며,
  솔트를 섞은 해시 32자만 남깁니다. 솔트는 `IP_SALT` 로 지정할 수 있습니다.
- `core.js`는 게임과 서버가 **같은 파일**을 씁니다. 규칙을 바꾸면 이미 등재된 기록과
  호환되지 않으므로, 규칙을 바꿀 때는 `core.js`의 `PROTOCOL`을 올리세요.
  `protocol` 열이 자유 플레이 순위를 묶는 기준이라 규칙을 올리면 순위표도 새로 시작합니다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/run` | 런 시작. `{mode:'free'\|'daily', clientId}` → `{runId, seed, serverTime, resumed?}`. 같은 기기에 열린 런이 있으면 `resumed:true` 로 같은 런을 반환 (429 = 시간당 상한) |
| POST | `/api/submit` | `{runId, events, name}` 제출 → 서버가 재생·채점 후 `{rank, level, nick, position, mode}`. `name` 은 서버가 정리하며, 비었거나 규칙 위반이면 서버가 지어 줍니다 |
| GET | `/api/board?mode=free&days=&limit=` | **자유 플레이 전체 순위.** 같은 `protocol` 의 모든 런. `days` 생략 = 전체 기간 |
| GET | `/api/board?mode=daily[&seed=]&limit=` | 오늘의 판 순위(시드별). `seed=` 만 주는 옛 호출도 daily 로 처리 |
| GET | `/api/health` | 상태 확인 |
