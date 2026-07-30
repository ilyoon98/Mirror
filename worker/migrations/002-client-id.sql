-- MIRROR RUSH — 기기 식별자 + 직접 입력 이름 (v1.4)
--
--   wrangler d1 execute mirror-rush --file=worker/migrations/002-client-id.sql --remote
--
-- 왜 필요한가:
-- v1.3 의 '열린 런 재사용'을 IP 기준으로 만들어서, 같은 네트워크의 두 사람이
-- 한 런을 공유해 버렸습니다. 뒤에 제출한 쪽은 409 '이미 제출된 런입니다' 로 등재 실패했고
-- 같은 판을 받는 문제도 있었습니다. 기기마다 다른 client_id 로 구분합니다.
--
-- SQLite 는 ADD COLUMN 에 IF NOT EXISTS 가 없습니다.
-- 이미 적용된 DB 에서는 첫 줄이 "duplicate column name" 으로 실패하는데,
-- 그건 이미 반영되었다는 뜻입니다.

ALTER TABLE runs ADD COLUMN client_id TEXT;

-- 열린 런 재사용 조회 (client_id + ip_hash 조합)
CREATE INDEX IF NOT EXISTS idx_client ON runs (client_id, started_at);
