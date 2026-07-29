/* ============================================================
   MIRROR RUSH — 결정론 코어
   브라우저(index.html)와 검증 서버(worker/)가 **같은 파일**을 씁니다.
   여기에 있는 것은 전부 시드로 재현 가능해야 하므로,
   Math.random() / Date.now() / DOM 접근을 절대 넣지 마세요.
   ============================================================ */
;(function(){
'use strict';

const PROTOCOL = 'mr1';          // 로그 포맷 버전. 규칙이 바뀌면 올립니다.

/* ---------------- 시드 PRNG (mulberry32) ---------------- */
function hashSeed(str){
  let h = 2166136261 >>> 0;                       // FNV-1a
  str = String(str);
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function makeRng(seed){
  let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// rng 를 받아 쓰는 헬퍼 (원본 게임의 rnd/pick 과 동일한 의미)
const rndOf  = (rng,n) => Math.floor(rng()*n);
const pickOf = (rng,a) => a[rndOf(rng,a.length)];

/* ---------------- 방 / 반사 규칙 ---------------- */
const DIRS   = { N:[-1,0], E:[0,1], S:[1,0], W:[0,-1] };
const DKEYS  = ['N','E','S','W'];
const REFLECT = {
  '/' : { N:'E', E:'N', S:'W', W:'S' },
  '\\': { N:'W', W:'N', S:'E', E:'S' }
};
const boardSizeFor = lv => lv<13 ? 5 : lv<25 ? 6 : 7;
const timeLimitFor = (n,lv) => Math.max(6 + (n-5)*1.5, (13 + (n-5)*3) - lv*0.4);

const FEVER_EVERY = 5;
const FEVER_MS    = 6000;
const MAX_LIFE    = 3;

/* ---------------- 빔 시뮬레이션 ---------------- */
function simulate(grid, n, r, c, d){
  const path=[[r,c]], seen=new Set();
  for(let i=0;i<300;i++){
    const key = r+','+c+','+d;
    if(seen.has(key)) return { path, exit:null, loop:true };
    seen.add(key);
    const [dr,dc]=DIRS[d], nr=r+dr, nc=c+dc;
    if(nr<0||nr>=n||nc<0||nc>=n) return { path, exit:r+','+c+','+d, loop:false };
    r=nr; c=nc; path.push([r,c]);
    const m=grid[r][c];
    if(m) d = REFLECT[m][d];
  }
  return { path, exit:null, loop:true };
}
const countBounces = (grid,path) => path.reduce((s,[r,c])=> s + (grid[r][c]?1:0), 0);

function exitLineHasMirror(grid, n, exitKey){
  const [r,c,d] = exitKey.split(',');
  if(d==='N'||d==='S'){ for(let i=0;i<n;i++) if(grid[i][+c]) return true; }
  else                { for(let i=0;i<n;i++) if(grid[+r][i]) return true; }
  return false;
}

/* ---------------- 레벨 생성 ----------------
   출구 2개(×1 긴 쪽 / ×2 짧은 쪽). rng 호출 순서가 곧 시드 재현의 계약입니다. */
function genLevel(rng, n, level){
  const total       = n*n;
  const mirrorCount = Math.min(4 + Math.floor(level*0.7), Math.floor(total*0.55));
  const wantLen     = Math.min(5 + Math.floor(level/2), 14 + (n-5)*5);
  const wantBounce  = Math.min(1 + Math.floor(level/4), 6);
  const RELAX_AT = 120, MAX_TRY = 420;

  for(let attempt=0; attempt<MAX_TRY; attempt++){
    const grid = Array.from({length:n}, ()=>Array(n).fill(null));
    const cells=[]; for(let r=0;r<n;r++) for(let c=0;c<n;c++) cells.push([r,c]);
    for(let i=cells.length-1;i>0;i--){ const j=rndOf(rng,i+1); [cells[i],cells[j]]=[cells[j],cells[i]]; }
    for(let i=0;i<mirrorCount;i++){ const [r,c]=cells[i]; grid[r][c] = rng()<0.5 ? '/' : '\\'; }

    const byExit = new Map();
    for(let r=0;r<n;r++) for(let c=0;c<n;c++){
      if(grid[r][c]) continue;
      for(const d of DKEYS){
        const res = simulate(grid,n,r,c,d);
        if(!res.exit) continue;
        const e = byExit.get(res.exit) || { count:0, best:0, bounce:0 };
        e.count++;
        if(res.path.length > e.best){ e.best = res.path.length; e.bounce = countBounces(grid,res.path); }
        byExit.set(res.exit, e);
      }
    }

    const relax     = attempt > RELAX_AT;
    const minLen    = relax ? Math.max(4, Math.round(wantLen*0.6)) : wantLen;
    const maxSol    = relax ? 12 : 6;
    const minBounce = relax ? 1  : wantBounce;

    const mainCands=[], subCands=[];
    for(const [exitKey,e] of byExit){
      if(e.bounce < 1) continue;
      if(!exitLineHasMirror(grid, n, exitKey)) continue;
      if(e.count>=1 && e.count<=maxSol && e.best>=minLen && e.bounce>=minBounce)
        mainCands.push({key:exitKey, best:e.best, bounce:e.bounce});
      if(e.best>=3 && e.count<=maxSol+4)
        subCands.push({key:exitKey, best:e.best, bounce:e.bounce});
    }
    if(!mainCands.length) continue;

    const main = pickOf(rng, mainCands);
    const subs = subCands.filter(s => s.key!==main.key && s.best < main.best);
    if(!subs.length) continue;
    let sub;
    if(subs.length>1 && rng()<0.6){
      const near=[...subs].sort((a,b)=>
        Math.abs(a.best*2-main.best)-Math.abs(b.best*2-main.best)).slice(0,3);
      sub=pickOf(rng,near);
    } else sub=pickOf(rng,subs);

    main.mult=1; sub.mult=2;
    const exits=[main,sub];
    return { grid, exits, maxScore: Math.max(...exits.map(x=>x.best*x.mult))*10 };
  }
  const grid = Array.from({length:n},()=>Array(n).fill(null));
  grid[2][4] = '/';
  const exits=[{key:'0,4,N',best:6,bounce:1,mult:1},{key:'2,0,W',best:3,bounce:1,mult:2}];
  return { grid, exits, maxScore:60 };
}

/* ---------------- 피버 레인 ---------------- */
function genFeverRow(rng, exit){
  const row=[null,null,null,null,null];
  if(rndOf(rng,7)===0) return row;
  const cols = exit==='R' ? [0,1,2,3] : [1,2,3,4];
  for(let i=cols.length-1;i>0;i--){ const j=rndOf(rng,i+1); [cols[i],cols[j]]=[cols[j],cols[i]]; }
  const k = 1 + rndOf(rng,2);
  for(let i=0;i<k;i++) row[cols[i]] = rng()<0.5 ? '/' : '\\';
  return row;
}
function newFeverRound(rng){
  const exit = rng()<0.5 ? 'L' : 'R';       // 출구를 먼저 뽑고 레인을 만듭니다 (순서 고정)
  return { exit, row: genFeverRow(rng, exit) };
}
function feverSim(row,c,exit){
  const step = exit==='R' ? 1 : -1;
  const path=[c];
  for(let i=c+step; i>=0 && i<5; i+=step){
    path.push(i);
    if(row[i]) return { path, ok:false, hit:i };
  }
  return { path, ok:true };
}
function feverBest(row,exit){
  let best=0;
  for(let c=0;c<5;c++){
    if(row[c]) continue;
    const s=feverSim(row,c,exit);
    if(s.ok && s.path.length>best) best=s.path.length;
  }
  return best;
}

/* ---------------- 점수 ----------------
   랭킹 점수(rank)는 시간 보너스를 뺀 값입니다.
   시간 보너스는 클라이언트가 보고한 시각에 의존해 서버가 검증할 수 없기 때문입니다.
   화면에 보이는 점수(total)에는 그대로 포함됩니다. */
function shotGain({cells, mult, maxScore, remain, combo}){
  const base    = cells*10*mult;
  const perfect = base >= maxScore;
  const timeB   = Math.round(remain*8);
  const m       = 1 + combo*0.15;
  const rank    = Math.round(base*(perfect?2:1) * m);
  return { perfect, rank, total: Math.round((base*(perfect?2:1) + timeB) * m) };
}
function feverGain({cells, hits, optimal, combo}){
  const g = Math.round((18 + cells*22 + hits*5) * (optimal?1.5:1) * (1 + combo*0.15));
  return { rank:g, total:g };                 // 피버는 시간 보너스가 없어 동일
}

/* ---------------- 리플레이 검증 ----------------
   log = { v, seed, events:[ {k:'s',r,c,d,e} | {k:'t'} | {k:'f',c,e} ] }
     s : 발사   (e = 그 레벨 타이머 시작 후 경과 ms)
     t : 시간초과
     f : 피버 타격 (e = 피버 시작 후 경과 ms)
   반환 { ok, rank, total, level, reason }
   ok=false 면 reason 에 어긋난 지점이 담깁니다.                      */
function replay(seed, events){
  const rng = makeRng(seed);
  let level=1, life=MAX_LIFE, combo=0, rank=0, total=0;
  let mode='play';                    // play | fever
  let lv=null, n=0, tLimit=0;
  let fever=null, feverHits=0, feverRound=null;
  let playMs=0;                       // 재생상 소요된 최소 시간(초 단위 검증용)

  const loadLevel = ()=>{
    n = boardSizeFor(level);
    lv = genLevel(rng, n, level);
    tLimit = timeLimitFor(n, level);
  };
  const enterFever = ()=>{ mode='fever'; feverHits=0; fever=0; feverRound=newFeverRound(rng); };
  const leaveFever = ()=>{
    if(feverHits>0 && life<MAX_LIFE) life++;
    playMs += FEVER_MS;
    mode='play'; level++; loadLevel();
  };
  const fail = reason => ({ ok:false, reason, rank, total, level });

  loadLevel();

  for(let i=0;i<events.length;i++){
    const ev = events[i];
    if(life<=0) return fail('라이프가 0인데 이벤트가 더 있음 @'+i);

    if(mode==='fever'){
      if(ev.k==='e'){ leaveFever(); continue; }
      if(ev.k!=='f') return fail('피버 중 허용되지 않는 이벤트 '+ev.k+' @'+i);
      if(!(ev.e>=0 && ev.e<=FEVER_MS)) return fail('피버 시각 범위 밖 @'+i);
      if(ev.e < fever) return fail('피버 시각이 역행 @'+i);
      fever = ev.e;
      const col = ev.c|0;
      if(col<0||col>4) return fail('피버 열 범위 밖 @'+i);
      if(feverRound.row[col]) return fail('거울 칸에 설치 @'+i);
      const r = feverSim(feverRound.row, col, feverRound.exit);
      if(r.ok){
        feverHits++; combo++;
        const g = feverGain({cells:r.path.length, hits:feverHits, optimal:r.path.length>=feverBest(feverRound.row,feverRound.exit), combo});
        rank += g.rank; total += g.total;
      }
      feverRound = newFeverRound(rng);       // 성공·실패 모두 새 레인
      continue;
    }

    if(ev.k==='t'){                          // 시간 초과
      // 실패해도 레벨은 오르지 않습니다(같은 레벨의 새 판). 클라이언트와 반드시 같아야 합니다.
      life--; combo=0; playMs += tLimit*1000; loadLevel();
      if(life<=0){ return { ok:true, rank, total, level, reason:null }; }
      continue;
    }
    if(ev.k!=='s') return fail('플레이 중 허용되지 않는 이벤트 '+ev.k+' @'+i);

    const r=ev.r|0, c=ev.c|0, d=ev.d;
    if(r<0||r>=n||c<0||c>=n) return fail('칸 범위 밖 @'+i);
    if(lv.grid[r][c]) return fail('거울 칸에서 발사 @'+i);
    if(!DIRS[d]) return fail('방향 값이 잘못됨 @'+i);
    if(!(ev.e>=0 && ev.e<=tLimit*1000+250)) return fail('발사 시각 범위 밖 @'+i);
    playMs += ev.e;

    const res = simulate(lv.grid, n, r, c, d);
    const hit = lv.exits.find(x=>x.key===res.exit) || null;
    if(hit){
      const remain = Math.max(0, tLimit - ev.e/1000);
      const g = shotGain({cells:res.path.length, mult:hit.mult, maxScore:lv.maxScore, remain, combo});
      rank += g.rank; total += g.total; combo++;
      if(combo % FEVER_EVERY === 0) enterFever();
      else { level++; loadLevel(); }
    }else{
      life--; combo=0; loadLevel();          // 실패 시 레벨 유지 (클라이언트와 동일)
      if(life<=0) return { ok:true, rank, total, level, reason:null };
    }
  }
  return { ok:true, rank, total, level, playMs, reason:null };
}

/* ---------------- 공유 코드 ----------------
   서버 없이 친구끼리 비교할 때 쓰는 짧은 문자열입니다.
   체크섬은 캐주얼한 오타·장난만 걸러냅니다. 위조를 막지는 못합니다. */
function shareCode({seed, rank, level, nick}){
  const body = [PROTOCOL, seed, rank, level, (nick||'').slice(0,12)].join('|');
  return body + '|' + (hashSeed(body) % 46656).toString(36).padStart(3,'0').toUpperCase();
}
function parseShareCode(code){
  const p = String(code||'').trim().split('|');
  if(p.length!==6 || p[0]!==PROTOCOL) return null;
  const body = p.slice(0,5).join('|');
  if((hashSeed(body) % 46656).toString(36).padStart(3,'0').toUpperCase() !== p[5]) return null;
  const rank=+p[2], level=+p[3];
  if(!Number.isFinite(rank) || !Number.isFinite(level)) return null;
  return { seed:p[1], rank, level, nick:p[4] };
}

/* ---------------- 오늘의 판 ----------------
   UTC 날짜를 씁니다. 지역마다 다른 판을 받으면 비교가 성립하지 않기 때문입니다. */
function dailySeed(nowMs){
  const d = new Date(nowMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth()+1, day = d.getUTCDate();
  return `${y}${String(m).padStart(2,'0')}${String(day).padStart(2,'0')}`;
}

const API = {
  PROTOCOL, FEVER_EVERY, FEVER_MS, MAX_LIFE, DIRS, DKEYS, REFLECT,
  hashSeed, makeRng, rndOf, pickOf,
  boardSizeFor, timeLimitFor, simulate, countBounces, genLevel,
  genFeverRow, newFeverRound, feverSim, feverBest,
  shotGain, feverGain, replay,
  shareCode, parseShareCode, dailySeed
};

if (typeof module === 'object' && module.exports) module.exports = API;
globalThis.MirrorCore = API;

})();
