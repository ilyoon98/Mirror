-- MIRROR RUSH 리더보드 스키마 (Cloudflare D1 / SQLite)
--   wrangler d1 execute mirror-rush --file=worker/schema.sql --remote

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,   -- 런 UUID (서버 발급)
  seed         TEXT NOT NULL,      -- 판 시드. 오늘의 판은 같은 시드끼리만 비교됩니다
  mode         TEXT NOT NULL,      -- free | daily
  protocol     TEXT,               -- 규칙 버전. 자유 플레이 순위를 묶는 기준입니다
  started_at   INTEGER NOT NULL,   -- 서버 시계. 클라이언트 시각을 대조하는 기준
  submitted_at INTEGER,
  status       TEXT NOT NULL,      -- open | done
  rank_score   INTEGER,            -- 서버가 리플레이로 직접 계산한 점수
  level        INTEGER,
  nick         TEXT,               -- 서버가 생성 (자유 입력을 받지 않습니다)
  events       TEXT,               -- 감사용 원본 로그
  ip_hash      TEXT,               -- 솔트 섞은 해시. 평문 IP 는 저장하지 않습니다
  client_id    TEXT                -- 기기 식별자(브라우저가 만들어 보관). 런 재사용 기준
);

-- 오늘의 판 순위: 시드별 상위 N
CREATE INDEX IF NOT EXISTS idx_board ON runs (seed, status, rank_score DESC);
-- 자유 플레이 순위: 규칙 버전별 상위 N (주력 순위표)
CREATE INDEX IF NOT EXISTS idx_free  ON runs (mode, protocol, status, rank_score DESC);
-- 열린 런 재사용 조회 + 시간당 런 상한
CREATE INDEX IF NOT EXISTS idx_ip     ON runs (ip_hash, started_at);
CREATE INDEX IF NOT EXISTS idx_client ON runs (client_id, started_at);
-- 오래된 open 런 정리용
CREATE INDEX IF NOT EXISTS idx_started ON runs (started_at);
