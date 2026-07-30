/* ============================================================
   MIRROR RUSH — 검증 리더보드 Worker (Cloudflare Workers + D1)

   핵심 설계: 클라이언트 점수를 절대 믿지 않습니다.
   제출된 것은 '입력 로그'뿐이고, 서버가 core.js 로 그대로 재생해
   점수를 스스로 계산합니다. 클라이언트가 보낸 점수는 참고조차 하지 않습니다.

   다만 리플레이만으로는 "이 시드에서 가능한 수였는가"까지만 증명됩니다.
   클라이언트가 보고한 시각(e)은 검증할 수 없으므로,
   런 시작 시각을 서버가 직접 찍어 실제 경과 시간과 대조해 빈틈을 메웁니다.
   ============================================================ */
import '../public/core.js';
const Core = globalThis.MirrorCore;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/* 게임과 API가 같은 주소에서 돌기 때문에 평소엔 CORS가 필요 없습니다.
   다른 곳에 올린 게임에서도 부르고 싶을 때만 ALLOWED_ORIGINS 를 채우세요. */
function cors(env, req){
  const origin = req.headers.get('Origin') || '';
  const allow  = (env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
  if(!allow.length) return {};                 // 같은 출처만 쓰는 기본 설정
  if(!allow.includes(origin)) return { 'access-control-allow-origin': 'null' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };
}
const json = (data, status, extra) =>
  new Response(JSON.stringify(data), { status: status||200, headers: {...JSON_HEADERS, ...extra} });

/* 닉네임 — 플레이어가 직접 적은 이름을 씁니다.
   비워 두면 서버가 만들어 줍니다(예전 방식).

   자유 입력을 받으면 부적절한 표현·개인정보가 순위표에 올라올 수 있습니다.
   길이·제어문자·링크만 막아 두었고, 표현 자체를 걸러내지는 않습니다.
   문제가 되면 금지어 목록을 여기에 추가하세요. */
const ADJ = ['빠른','고요한','날카로운','신중한','또렷한','대담한','정확한','침착한'];
const NOUN= ['거울','광선','프리즘','반사','섬광','각도','굴절','초점'];
function makeNick(rand){
  const a = ADJ[Math.floor(rand()*ADJ.length)];
  const n = NOUN[Math.floor(rand()*NOUN.length)];
  return `${a}${n}-${Math.floor(rand()*900+100)}`;
}

const NAME_MAX = 12;
/* 제어문자·폭 없는 문자 제거.
   정규식 문자 클래스에 넣으면 소스에 리터럴 제어문자가 박혀 파싱이 깨지므로
   코드포인트로 걸러냅니다. 클라이언트의 stripCtl 과 같은 규칙이어야 합니다.
   최종 판정은 여기(서버)가 합니다 — 클라이언트 정리는 편의일 뿐입니다. */
function stripCtl(s){
  return [...String(s)].filter(ch=>{
    const cp = ch.codePointAt(0);
    return !(cp < 0x20 || cp === 0x7f || (cp >= 0x200b && cp <= 0x200f)
             || cp === 0x2028 || cp === 0x2029);
  }).join('');
}
function cleanName(v){
  if(typeof v !== 'string') return null;
  let s = stripCtl(v)
           .replace(/\s+/g, ' ')
           .trim();
  if(/https?:\/\//i.test(s)) return null;                  // 링크는 받지 않습니다
  s = [...s].slice(0, NAME_MAX).join('');                   // 이모지를 쪼개지 않도록 코드포인트 단위
  return s.length ? s : null;
}

/* 기기 식별자 — 브라우저가 만들어 보관하는 임의 문자열입니다.
   개인정보가 아니고, 서버는 '같은 기기인가'만 봅니다. */
const cleanClientId = v =>
  (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v)) ? v : null;

/* ─── 시드 쇼핑 방어 ───
   자유 플레이가 순위표의 주력이 되면서 새로 생긴 구멍입니다.
   오늘의 판은 시드가 하나라 고를 수 없었지만, 자유 플레이는 /api/run 을 반복해
   유리한 시드만 골라 쓸 수 있습니다(판 생성 규칙이 공개된 결정론 코어이므로
   받은 시드의 유리함을 클라이언트가 즉시 계산할 수 있습니다).

   그래서 **열려 있는 런이 있으면 같은 런을 그대로 돌려줍니다.**
   새 시드를 받으려면 그 런을 끝내 제출하거나(= 점수가 기록되거나)
   REUSE_MS 가 지나기를 기다려야 하므로, 시드 한 장을 고르는 비용이
   "무료 무한 재추첨"에서 "런 하나 또는 10분"으로 올라갑니다.

   IP 는 평문으로 저장하지 않습니다. 순위표에 필요한 정보가 아니고,
   있으면 유출 대상이 되기만 하므로 솔트를 섞은 해시만 남깁니다.

   한계: 재사용 기준을 IP 가 아니라 브라우저가 보낸 client_id 로 잡습니다.
   IP 로 잡았더니 사무실·집·모바일 NAT 처럼 IP 를 공유하는 두 사람이 한 런을 공유해
   뒤에 제출한 쪽이 등재에 실패했습니다(같은 판을 받는 문제도 있었습니다).
   client_id 는 클라이언트가 만드는 값이라 매번 새로 만들면 재사용을 피할 수 있습니다.
   그래서 재추첨을 실제로 막는 것은 아래의 **IP 기준 시간당 상한**이고,
   재사용은 '새로고침 복구 + 손쉬운 재추첨 차단' 정도로 봐야 합니다. */
const REUSE_MS   = 10*60*1000;   // 열린 런을 같은 시드로 돌려주는 기간
const START_CAP  = 40;           // 같은 기기의 시간당 런 시작 상한
const IP_CAP     = 200;          // 같은 IP 의 시간당 런 시작 상한(공유 IP 를 막지 않을 만큼 넉넉히)

async function sha256hex(s){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function ipHash(env, req){
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  return (await sha256hex(ip + '|' + (env.IP_SALT || 'mirror-rush'))).slice(0, 32);
}

/* 로그가 담을 수 있는 최소 소요 시간.
   "0초 만에 100레벨" 같은 제출을 막습니다. */
function minElapsedMs(events){
  let ms = 0;
  for(const e of events){
    // v1.6 부터 s 의 e 는 '그 판을 보며 쓴 시간' 입니다. t(판별 시간초과) 이벤트는 없어졌습니다.
    if(e.k==='s') ms += Math.max(0, e.e|0);
    else if(e.k==='e') ms += 0;                 // 피버 경과는 f 이벤트의 e 로 이미 반영
  }
  // 피버 구간: 각 피버의 마지막 f 시각까지는 최소한 흘렀어야 함
  let feverMax = 0, acc = 0;
  for(const e of events){
    if(e.k==='f') feverMax = Math.max(feverMax, e.e|0);
    else if(e.k==='e'){ acc += feverMax; feverMax = 0; }
  }
  return ms + acc + feverMax;
}

async function handleRunStart(env, req){
  const body = await req.json().catch(()=>({}));
  const mode = body.mode==='daily' ? 'daily' : 'free';   // 기본이 자유 플레이입니다
  const now  = Date.now();
  const iph  = await ipHash(env, req);
  const cid  = cleanClientId(body.clientId);
  const hour = now - 60*60*1000;

  /* 열려 있는 런이 있으면 그대로 돌려줍니다 (새로고침 복구 + 손쉬운 재추첨 차단).
     같은 기기에서만 재사용합니다 — IP 로 묶으면 같은 네트워크의 다른 사람 런을
     가져가 버려서, 뒤에 제출한 쪽이 '이미 제출된 런' 으로 등재에 실패합니다.
     client_id 가 없는 옛 클라이언트는 예전처럼 IP 로 묶습니다(서로 섞이지 않게 분리). */
  const open = cid
    ? await env.DB.prepare(
        `SELECT id, seed FROM runs
          WHERE client_id=? AND mode=? AND protocol=? AND status='open' AND started_at > ?
          ORDER BY started_at DESC LIMIT 1`
      ).bind(cid, mode, Core.PROTOCOL, now - REUSE_MS).first()
    : await env.DB.prepare(
        `SELECT id, seed FROM runs
          WHERE client_id IS NULL AND ip_hash=? AND mode=? AND protocol=? AND status='open' AND started_at > ?
          ORDER BY started_at DESC LIMIT 1`
      ).bind(iph, mode, Core.PROTOCOL, now - REUSE_MS).first();
  if(open)
    return { runId:open.id, seed:open.seed, serverTime:now, resumed:true };

  // 자동화 backstop — 기기 기준으로 조이고, IP 기준은 공유 IP 를 막지 않을 만큼만 둡니다
  if(cid){
    const byC = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM runs WHERE client_id=? AND started_at > ?'
    ).bind(cid, hour).first();
    if((byC?.c ?? 0) >= START_CAP)
      return { error:'런을 너무 자주 시작했습니다. 잠시 후 다시 시도하세요.', status:429 };
  }
  const byIp = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM runs WHERE ip_hash=? AND started_at > ?'
  ).bind(iph, hour).first();
  if((byIp?.c ?? 0) >= IP_CAP)
    return { error:'이 네트워크에서 런이 너무 많습니다. 잠시 후 다시 시도하세요.', status:429 };

  // 시드는 서버가 발급합니다. 클라이언트가 고른 시드는 받지 않습니다.
  const seed = mode==='daily' ? Core.dailySeed(now)
                              : Core.freeSeed(now, ()=>Math.random());
  const id   = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO runs (id, seed, mode, protocol, started_at, status, ip_hash, client_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, seed, mode, Core.PROTOCOL, now, 'open', iph, cid).run();
  return { runId:id, seed, serverTime:now };
}

async function handleSubmit(env, req){
  const body = await req.json().catch(()=>({}));
  const { runId, events } = body;
  if(typeof runId!=='string' || !Array.isArray(events))
    return { error:'runId 와 events 가 필요합니다', status:400 };
  if(events.length > 2500)
    return { error:'이벤트가 너무 많습니다', status:400 };

  const row = await env.DB.prepare(
    'SELECT id, seed, mode, protocol, started_at, status FROM runs WHERE id=?'
  ).bind(runId).first();
  if(!row)              return { error:'없는 런입니다', status:404 };
  if(row.status!=='open') return { error:'이미 제출된 런입니다', status:409 };

  // ── 1. 리플레이 검증 — 서버가 점수를 직접 계산합니다 ──
  let v;
  try{ v = Core.replay(row.seed, events); }
  catch(e){ return { error:'리플레이 실패: '+e.message, status:400 }; }
  if(!v.ok) return { error:'불가능한 수가 있습니다: '+v.reason, status:400 };

  // ── 2. 서버 시계와 대조 — 보고된 시각이 실제로 흐른 시간 안에 들어오는가 ──
  const now     = Date.now();
  const elapsed = now - row.started_at;
  const needed  = minElapsedMs(events);
  if(elapsed < needed * 0.7)
    return { error:`실제 경과 시간이 부족합니다 (${Math.round(elapsed/1000)}초 / 최소 ${Math.round(needed*0.7/1000)}초)`, status:400 };

  /* 위 검사는 '보고된 시간'을 근거로 하므로, 시간을 0 으로 보고하면 문턱도 0 이 되어
     스스로 무력해집니다. 그래서 **서버 시계만으로도** 런 길이를 묶습니다.
     한 발에는 사람이 판을 보고 두 번 누르는 시간이 반드시 들어가므로,
     실제 경과 시간을 최소 발사 비용으로 나눈 값이 발사 수의 상한입니다. */
  const shots    = events.reduce((s,e)=> s + (e.k==='s' ? 1 : 0), 0);
  const maxShots = Math.floor(elapsed / Core.MIN_SHOT_MS) + 5;   // +5 는 시계 오차 여유
  if(shots > maxShots)
    return { error:`실제 경과 시간에 비해 발사가 너무 많습니다 (${shots}발 / 최대 ${maxShots}발)`, status:400 };

  if(elapsed > 30*60*1000)
    return { error:'런이 너무 오래됐습니다', status:400 };

  // 플레이어가 적은 이름을 씁니다. 비었거나 규칙에 안 맞으면 서버가 만들어 줍니다.
  const nick = cleanName(body.name) || makeNick(Core.makeRng(runId));
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE runs SET status=?, submitted_at=?, rank_score=?, level=?, nick=?, events=? WHERE id=?'
    ).bind('done', now, v.rank, v.level, nick, JSON.stringify(events).slice(0, 200000), runId)
  ]);

  /* 순위를 세는 범위가 모드마다 다릅니다.
     오늘의 판은 **같은 시드**끼리 (모두가 같은 문제를 풀었으므로),
     자유 플레이는 **같은 규칙 버전의 모든 런**끼리 비교합니다. */
  const better = row.mode==='free'
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM runs
          WHERE mode='free' AND protocol=? AND status='done' AND rank_score>?`
      ).bind(row.protocol, v.rank).first()
    : await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM runs
          WHERE seed=? AND status='done' AND rank_score>?`
      ).bind(row.seed, v.rank).first();

  return { ok:true, seed:row.seed, mode:row.mode, rank:v.rank, level:v.level,
           nick, position:(better?.c ?? 0)+1 };
}

/* 순위표 조회
     ?mode=free                 자유 플레이 — 같은 규칙 버전의 모든 런을 한 표에 모읍니다
     ?mode=free&days=7          최근 7일만 (전체 순위가 굳어 신규 진입이 막히는 것을 완화)
     ?mode=daily[&seed=…]       오늘의 판 — 같은 시드끼리만

   자유 플레이는 판이 매번 다르지만 레벨 1부터 같은 생성기·같은 난이도 곡선을
   밟으므로 런 전체 점수는 비교가 성립합니다(엔드리스 아케이드와 같은 방식). */
async function handleBoard(env, url){
  const q     = url.searchParams;
  const limit = Math.min(50, Math.max(1, +(q.get('limit')||20)));
  const mode  = q.get('mode')==='daily' ? 'daily'
              : q.get('seed') ? 'daily' : 'free';       // seed 를 주면 옛 호출과 호환

  if(mode==='free'){
    const days  = Math.min(365, Math.max(0, +(q.get('days')||0)));
    const since = days ? Date.now() - days*24*60*60*1000 : 0;
    /* 지난 시즌 조회 — 규칙이 바뀌면 순위표를 새로 시작하지만 기록은 지우지 않습니다.
       protocol 을 주면 그 시즌 표를 봅니다(읽기만, 규칙과 무관). */
    const proto = /^mr[0-9]{1,3}$/.test(q.get('protocol')||'') ? q.get('protocol') : Core.PROTOCOL;
    const { results } = await env.DB.prepare(
      `SELECT nick, rank_score AS rank, level, submitted_at
         FROM runs
        WHERE mode='free' AND protocol=? AND status='done' AND submitted_at > ?
        ORDER BY rank_score DESC, submitted_at ASC LIMIT ?`
    ).bind(proto, since, limit).all();
    // 어떤 시즌이 존재하는지 함께 알려줍니다 (클라이언트가 선택 UI 를 그립니다)
    const { results: seasons } = await env.DB.prepare(
      `SELECT protocol, COUNT(*) AS runs, MAX(rank_score) AS best
         FROM runs
        WHERE mode='free' AND status='done' AND protocol IS NOT NULL
        GROUP BY protocol`
    ).all();
    return { mode:'free', protocol:proto, current:Core.PROTOCOL, days,
             entries: results||[], seasons: seasons||[] };
  }

  const seed = q.get('seed') || Core.dailySeed(Date.now());
  const { results } = await env.DB.prepare(
    `SELECT nick, rank_score AS rank, level, submitted_at
       FROM runs WHERE seed=? AND status='done'
      ORDER BY rank_score DESC, submitted_at ASC LIMIT ?`
  ).bind(seed, limit).all();
  return { mode:'daily', seed, entries: results||[] };
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const hdr = cors(env, req);
    if(req.method==='OPTIONS') return new Response(null, { status:204, headers:hdr });

    try{
      if(url.pathname==='/api/run' && req.method==='POST'){
        const r = await handleRunStart(env, req);
        return json(r, r.status||200, hdr);
      }

      if(url.pathname==='/api/submit' && req.method==='POST'){
        const r = await handleSubmit(env, req);
        return json(r, r.status||200, hdr);
      }
      if(url.pathname==='/api/board' && req.method==='GET')
        return json(await handleBoard(env, url), 200, hdr);

      if(url.pathname==='/api/health')
        return json({ ok:true, protocol:Core.PROTOCOL, seed:Core.dailySeed(Date.now()) }, 200, hdr);

      if(url.pathname.startsWith('/api/')) return json({ error:'not found' }, 404, hdr);

      // /api/* 가 아니면 public/ 의 게임 파일을 그대로 내보냅니다
      return env.ASSETS.fetch(req);
    }catch(e){
      return json({ error:'서버 오류: '+e.message }, 500, hdr);
    }
  }
};
