-- MIRROR RUSH — 자유 플레이 순위표 마이그레이션 (v1.3)
--
-- 이미 배포된 D1 에는 runs 테이블이 있으므로 schema.sql 을 다시 실행할 수 없습니다.
-- 열을 덧붙이고 인덱스만 추가합니다.
--
--   wrangler d1 execute mirror-rush --file=worker/migrations/001-free-board.sql --remote
--
-- SQLite 는 ADD COLUMN 에 IF NOT EXISTS 가 없습니다.
-- 이미 적용된 DB 에서는 앞의 두 줄이 "duplicate column name" 으로 실패하는데,
-- 그건 이미 반영되었다는 뜻이므로 그대로 두고 나머지를 실행하면 됩니다.

ALTER TABLE runs ADD COLUMN protocol TEXT;
ALTER TABLE runs ADD COLUMN ip_hash  TEXT;

-- 기존 기록은 규칙 버전이 시드에만 있었습니다.
-- 'mr2-…' 형태면 mr2, 접두어가 없으면 v1.1 이전(mr1)입니다.
UPDATE runs SET protocol = 'mr2' WHERE protocol IS NULL AND seed LIKE 'mr2-%';
UPDATE runs SET protocol = 'mr1' WHERE protocol IS NULL;

CREATE INDEX IF NOT EXISTS idx_free ON runs (mode, protocol, status, rank_score DESC);
CREATE INDEX IF NOT EXISTS idx_ip   ON runs (ip_hash, started_at);
