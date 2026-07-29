/* ============================================================
   MIRROR RUSH — 검증 리더보드 Worker (Cloudflare Workers + D1)

   핵심 설계: 클라이언트 점수를 절대 믿지 않습니다.
   제출된 것은 '입력 로그'뿐이고, 서버가 core.js 로 그대로 재생해
   점수를 스스로 계산합니다. 클라이언트가 보낸 점수는 참고조차 하지 않습니다.

   다만 리플레이만으로는 "이 시드에서 가능한 수였는가"까지만 증명됩니다.
   클라이언트가 보고한 시각(e)은 검증할 수 없으므로,
   런 시작 시각을 서버가 직접 찍어 실제 경과 시간과 대조해 빈틈을 메웁니다.
   ============================================================ */
import '../core.js';
const Core = globalThis.MirrorCore;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function cors(env, req){
  const origin = req.headers.get('Origin') || '';
  const allow  = (env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const ok = allow.length===0 || allow.includes(origin);
  return {
    'access-control-allow-origin': ok ? (origin || '*') : 'null',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };
}
const json = (data, status, extra) =>
  new Response(JSON.stringify(data), { status: status||200, headers: {...JSON_HEADERS, ...extra} });

/* 닉네임: 자유 입력을 받지 않습니다.
   부적절한 표현·개인정보 관리 책임을 지지 않기 위해 서버가 만들어 줍니다. */
const ADJ = ['빠른','고요한','날카로운','신중한','또렷한','대담한','정확한','침착한'];
const NOUN= ['거울','광선','프리즘','반사','섬광','각도','굴절','초점'];
function makeNick(rand){
  const a = ADJ[Math.floor(rand()*ADJ.length)];
  const n = NOUN[Math.floor(rand()*NOUN.length)];
  return `${a}${n}-${Math.floor(rand()*900+100)}`;
}

/* 로그가 담을 수 있는 최소 소요 시간.
   "0초 만에 100레벨" 같은 제출을 막습니다. */
function minElapsedMs(events){
  let ms = 0;
  for(const e of events){
    if(e.k==='s') ms += Math.max(0, e.e|0);
    else if(e.k==='t') ms += 6000;              // 시간초과는 최소 제한시간(하한 6초)만큼 걸림
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
  const mode = body.mode==='free' ? 'free' : 'daily';
  const now  = Date.now();
  const seed = mode==='daily' ? Core.dailySeed(now)
                              : 'f' + now.toString(36) + Math.floor(Math.random()*1e6).toString(36);
  const id   = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO runs (id, seed, mode, started_at, status) VALUES (?,?,?,?,?)'
  ).bind(id, seed, mode, now, 'open').run();
  return { runId:id, seed, serverTime:now };
}

async function handleSubmit(env, req){
  const body = await req.json().catch(()=>({}));
  const { runId, events } = body;
  if(typeof runId!=='string' || !Array.isArray(events))
    return { error:'runId 와 events 가 필요합니다', status:400 };
  if(events.length > 5000)
    return { error:'이벤트가 너무 많습니다', status:400 };

  const row = await env.DB.prepare(
    'SELECT id, seed, mode, started_at, status FROM runs WHERE id=?'
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
  if(elapsed > 12*60*60*1000)
    return { error:'런이 너무 오래됐습니다', status:400 };

  const nick = makeNick(Core.makeRng(runId));
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE runs SET status=?, submitted_at=?, rank_score=?, level=?, nick=?, events=? WHERE id=?'
    ).bind('done', now, v.rank, v.level, nick, JSON.stringify(events).slice(0, 200000), runId)
  ]);

  const better = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM runs WHERE seed=? AND status=? AND rank_score>?'
  ).bind(row.seed, 'done', v.rank).first();

  return { ok:true, seed:row.seed, rank:v.rank, level:v.level, nick, position:(better?.c ?? 0)+1 };
}

async function handleBoard(env, url){
  const seed  = url.searchParams.get('seed') || Core.dailySeed(Date.now());
  const limit = Math.min(50, Math.max(1, +(url.searchParams.get('limit')||20)));
  const { results } = await env.DB.prepare(
    `SELECT nick, rank_score AS rank, level, submitted_at
       FROM runs WHERE seed=? AND status='done'
      ORDER BY rank_score DESC, submitted_at ASC LIMIT ?`
  ).bind(seed, limit).all();
  return { seed, entries: results||[] };
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const hdr = cors(env, req);
    if(req.method==='OPTIONS') return new Response(null, { status:204, headers:hdr });

    try{
      if(url.pathname==='/api/run' && req.method==='POST')
        return json(await handleRunStart(env, req), 200, hdr);

      if(url.pathname==='/api/submit' && req.method==='POST'){
        const r = await handleSubmit(env, req);
        return json(r, r.status||200, hdr);
      }
      if(url.pathname==='/api/board' && req.method==='GET')
        return json(await handleBoard(env, url), 200, hdr);

      if(url.pathname==='/api/health')
        return json({ ok:true, protocol:Core.PROTOCOL, seed:Core.dailySeed(Date.now()) }, 200, hdr);

      return json({ error:'not found' }, 404, hdr);
    }catch(e){
      return json({ error:'서버 오류: '+e.message }, 500, hdr);
    }
  }
};
