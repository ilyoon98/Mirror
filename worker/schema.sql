-- MIRROR RUSH 리더보드 스키마 (Cloudflare D1 / SQLite)
--   wrangler d1 execute mirror-rush --file=worker/schema.sql --remote

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,   -- 런 UUID (서버 발급)
  seed         TEXT NOT NULL,      -- 판 시드. 같은 시드끼리만 비교됩니다
  mode         TEXT NOT NULL,      -- daily | free
  started_at   INTEGER NOT NULL,   -- 서버 시계. 클라이언트 시각을 대조하는 기준
  submitted_at INTEGER,
  status       TEXT NOT NULL,      -- open | done
  rank_score   INTEGER,            -- 서버가 리플레이로 직접 계산한 점수
  level        INTEGER,
  nick         TEXT,               -- 서버가 생성 (자유 입력을 받지 않습니다)
  events       TEXT                -- 감사용 원본 로그
);

-- 순위 조회: 시드별 상위 N
CREATE INDEX IF NOT EXISTS idx_board ON runs (seed, status, rank_score DESC);
-- 오래된 open 런 정리용
CREATE INDEX IF NOT EXISTS idx_started ON runs (started_at);
