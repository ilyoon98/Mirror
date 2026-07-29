/* ============================================================
   MIRROR RUSH — 결정론 코어
   브라우저(index.html)와 검증 서버(worker/)가 **같은 파일**을 씁니다.
   여기에 있는 것은 전부 시드로 재현 가능해야 하므로,
   Math.random() / Date.now() / DOM 접근을 절대 넣지 마세요.
   ============================================================ */
;(function(){
'use strict';

/* 로그 포맷 + 판 규칙 버전.
   규칙이 바뀌면 반드시 올립니다. 시드에도 들어가므로(dailySeed) 옛 규칙으로 등재된
   기록과 새 규칙의 판이 같은 순위표에서 섞이지 않습니다. */
const PROTOCOL = 'mr2';

/* ---------------- 타일 종류 ----------------
   grid[r][c] 에 들어가는 값. null 은 빈 칸입니다. */
const T = {
  MIRROR_A : '/',    // 거울
  MIRROR_B : '\\',
  VANISH   : 'X',    // 소멸 타일 — 빔이 흡수되어 실패
  PRISM    : 'P',    // 프리즘 — 들어온 반대편을 뺀 3방향으로 분산
  ONEWAY_A : 'a',    // 단방향 거울 — E/S 진행이면 통과, W/N 진행이면 '/' 처럼 반사
  ONEWAY_B : 'b'     //                                        '\\' 처럼 반사
};
const isMirror = t => t===T.MIRROR_A || t===T.MIRROR_B;
const isOneway = t => t===T.ONEWAY_A || t===T.ONEWAY_B;
// 단방향 거울은 진행 방향이 E 또는 S 일 때만 그냥 통과합니다
const onewayPasses = d => d==='E' || d==='S';
const onewayFace   = t => t===T.ONEWAY_A ? T.MIRROR_A : T.MIRROR_B;

/* FLIP — 판의 모든 거울을 동시에 뒤집습니다. 고정 규칙이라 암산이 가능합니다.
   소멸·프리즘 타일은 그대로 두고, 단방향 거울도 반사면만 뒤집습니다. */
function flipGrid(grid){
  return grid.map(row => row.map(t =>
    t===T.MIRROR_A ? T.MIRROR_B :
    t===T.MIRROR_B ? T.MIRROR_A :
    t===T.ONEWAY_A ? T.ONEWAY_B :
    t===T.ONEWAY_B ? T.ONEWAY_A : t));
}

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
const OPP    = { N:'S', S:'N', E:'W', W:'E' };
const REFLECT = {
  '/' : { N:'E', E:'N', S:'W', W:'S' },
  '\\': { N:'W', W:'N', S:'E', E:'S' }
};
const boardSizeFor = lv => lv<13 ? 5 : lv<25 ? 6 : 7;
const timeLimitFor = (n,lv) => Math.max(6 + (n-5)*1.5, (13 + (n-5)*3) - lv*0.4);

const FEVER_EVERY = 5;
const FEVER_MS    = 6000;
const MAX_LIFE    = 3;

/* ---------------- 빔 시뮬레이션 ----------------
   trace() 는 한 발이 만들어내는 '모든 갈래'를 돌려줍니다.
   프리즘이 없으면 갈래는 1개뿐이라 예전과 똑같이 동작합니다.

   반환: { beams:[{path, exit, loop, absorbed}], splits }
     exit     : 'r,c,d' 형태의 탈출 경계면, 못 나갔으면 null
     absorbed : 소멸 타일에 흡수됨 (그 갈래는 실패)
     loop     : 무한 반사

   무한 재귀를 막기 위해 프리즘 통과 횟수(MAX_SPLITS)와
   전체 스텝 수(STEP_BUDGET)에 상한을 둡니다.                       */
const MAX_SPLITS  = 2;      // 한 발에서 프리즘을 최대 2번까지만 갈라짐
const STEP_BUDGET = 900;    // 모든 갈래를 합친 이동 칸 수 상한

function trace(grid, n, r0, c0, d0){
  const beams = [];
  let steps = 0, splits = 0;

  // 시작 지점이 프리즘이어도 첫 칸에서는 갈라지지 않습니다(설치 칸은 항상 빈 칸)
  const queue = [{ r:r0, c:c0, d:d0, path:[[r0,c0]], seen:new Set() }];

  while(queue.length){
    const b = queue.shift();
    let { r, c, d, path, seen } = b;

    for(;;){
      if(steps++ > STEP_BUDGET){ beams.push({ path, exit:null, loop:true, absorbed:false }); break; }
      const key = r+','+c+','+d;
      if(seen.has(key)){ beams.push({ path, exit:null, loop:true, absorbed:false }); break; }
      seen.add(key);

      const [dr,dc] = DIRS[d], nr = r+dr, nc = c+dc;
      if(nr<0 || nr>=n || nc<0 || nc>=n){
        beams.push({ path, exit:r+','+c+','+d, loop:false, absorbed:false }); break;
      }
      r=nr; c=nc; path.push([r,c]);
      const t = grid[r][c];

      if(t === T.VANISH){                                  // 소멸 — 여기서 끝
        beams.push({ path, exit:null, loop:false, absorbed:true }); break;
      }
      if(t === T.PRISM){
        if(splits >= MAX_SPLITS){                          // 상한을 넘으면 직진 처리
          continue;
        }
        splits++;
        // 들어온 반대편(뒤쪽)만 빼고 직진 + 좌90 + 우90 세 갈래
        const back = OPP[d];
        for(const nd of DKEYS){
          if(nd === back) continue;
          if(nd === d) continue;                            // 직진은 이 루프가 계속 이어갑니다
          queue.push({ r, c, d:nd, path:path.slice(), seen:new Set(seen) });
        }
        continue;                                           // 직진 갈래는 그대로 진행
      }
      if(isOneway(t)){
        if(onewayPasses(d)) continue;                       // E/S 진행 → 그냥 통과
        d = REFLECT[onewayFace(t)][d];                      // W/N 진행 → 반사
        continue;
      }
      if(isMirror(t)) d = REFLECT[t][d];
    }
  }
  return { beams, splits };
}

// 예전 호출부와의 호환 — 갈래가 하나뿐인 경우의 결과를 그대로 돌려줍니다
function simulate(grid, n, r, c, d){
  const { beams } = trace(grid, n, r, c, d);
  const b = beams[0];
  return { path:b.path, exit:b.exit, loop:b.loop, absorbed:b.absorbed, beams };
}

const countBounces = (grid,path) =>
  path.reduce((s,[r,c])=> s + (isMirror(grid[r][c]) || isOneway(grid[r][c]) ? 1 : 0), 0);

function exitLineHasMirror(grid, n, exitKey){
  const [r,c,d] = exitKey.split(',');
  const hit = t => isMirror(t) || isOneway(t);
  if(d==='N'||d==='S'){ for(let i=0;i<n;i++) if(hit(grid[i][+c])) return true; }
  else                { for(let i=0;i<n;i++) if(hit(grid[+r][i])) return true; }
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

    // ── 특수 타일 배치 ──
    // 정답 경로를 막지 않는 자리에만 놓고, 다 놓은 뒤 반드시 다시 풀리는지 확인합니다.
    // 프리즘이 있다면 '살려서 통과하는 길'도 최소 하나는 남아야 합니다.
    // 그러지 않으면 프리즘은 위험만 있고 보상이 없는 함정이 됩니다.
    const plan = hazardPlan(n, level);
    const keep = protectedCells(grid, n, exits);   // 재시도 사이에 바뀌지 않으므로 한 번만
    let best = null;
    for(let k=0;k<4;k++){
      const g2 = grid.map(row=>row.slice());
      placeHazards(rng, g2, n, level, exits, keep);
      const info = solveInfo(g2, n, exits);
      if(!info.ok) continue;
      if(!plan.prism || info.prismOk){ best = {g:g2, info}; break; }
      if(!best) best = {g:g2, info};           // 차선책 — 최소한 풀리기는 하는 판
    }
    if(!best) continue;
    for(let r=0;r<n;r++) grid[r] = best.g[r];
    return { grid, exits, maxScore: best.info.maxScore, safeBest: best.info.safeBest };
  }
  // 안전망 — 특수 타일 없이 반드시 풀리는 고정 배치
  const grid = Array.from({length:n},()=>Array(n).fill(null));
  grid[2][4] = T.MIRROR_A;
  const exits=[{key:'0,4,N',best:6,bounce:1,mult:1},{key:'2,0,W',best:3,bounce:1,mult:2}];
  return { grid, exits, maxScore:60, safeBest:60 };
}

/* 특수 타일 배치.
   레벨에 따라 소멸 → 프리즘 → 단방향 순으로 점진적으로 등장시킵니다.
   두 출구의 '최적 경로'가 지나는 칸은 건드리지 않아, 적어도 그 두 답은 살아남습니다. */
/* 프리즘은 아직 켜지 않습니다.
   출구는 "정답이 6개 이하인 희귀한 면"으로 고르는데, 프리즘 갈래는 임의 방향으로 흩어져
   그 면에 닿을 확률이 사실상 0입니다. 실측: 전수 탐색으로 자리를 골라도
   '갈래가 출구에 도달하는 판' 0% (레벨 8·20·35 각 40판).
   즉 지금 규칙 그대로면 프리즘은 위험만 있고 보상이 없는 함정이 됩니다.
   보상 규칙을 정한 뒤 이 값을 되살리세요. */
const PRISM_ENABLED = false;

/* 단방향 거울도 아직 켜지 않습니다.
   특수 타일은 두 출구의 최적 경로를 피해서 놓기 때문에(그래야 판이 반드시 풀립니다),
   단방향 거울이 정답 경로에 놓이는 일이 없어 그냥 장식이 됩니다.
   실측: 정답 경로에 단방향 거울이 관여하는 판 0% (레벨 10~50 각 60판).
   의미를 가지려면 '경로 위에 놓고 다시 풀리는지 확인'하는 별도 배치가 필요합니다. */
const ONEWAY_ENABLED = false;

function hazardPlan(n, level){
  const total = n*n;
  return {
    vanish : Math.min(1 + Math.floor(level/5), 3),
    prism  : (PRISM_ENABLED && level>=8) ? Math.min(1 + Math.floor((level-8)/10), 2) : 0,
    oneway : (ONEWAY_ENABLED && level>=10) ? Math.min(1 + Math.floor((level-10)/12), 2) : 0,
    cap    : Math.max(3, Math.floor(total*0.18))     // 방 대비 과밀 방지
  };
}

function bestPathCells(grid, n, exitKey){
  let best=null;
  for(let r=0;r<n;r++) for(let c=0;c<n;c++){
    if(grid[r][c]) continue;
    for(const d of DKEYS){
      const s = simulate(grid,n,r,c,d);
      if(s.exit!==exitKey || s.absorbed) continue;
      if(!best || s.path.length>best.length) best = s.path;
    }
  }
  return best;
}

function protectedCells(grid, n, exits){
  const keep = new Set();
  for(const e of exits){
    const p = bestPathCells(grid, n, e.key);
    if(p) for(const [r,c] of p) keep.add(r+','+c);
  }
  return keep;
}

function placeHazards(rng, grid, n, level, exits, keepIn){
  const plan = hazardPlan(n, level);
  // 두 출구의 최적 경로는 보호합니다 (재시도 시 매번 다시 구하지 않도록 받아둡니다)
  const keep = keepIn || protectedCells(grid, n, exits);
  const free=[];
  for(let r=0;r<n;r++) for(let c=0;c<n;c++)
    if(!grid[r][c] && !keep.has(r+','+c)) free.push([r,c]);
  for(let i=free.length-1;i>0;i--){ const j=rndOf(rng,i+1); [free[i],free[j]]=[free[j],free[i]]; }

  let put = 0;
  const takeNear = (pts)=>{                    // 주어진 좌표들에 가까운 빈 칸을 우선 집어옵니다
    if(!pts.length) return free.pop();
    let bi = free.length-1, bd = Infinity;
    for(let i=free.length-1;i>=0;i--){
      const [r,c] = free[i];
      let m = Infinity;
      for(const [pr,pc] of pts) m = Math.min(m, Math.abs(r-pr)+Math.abs(c-pc));
      if(m < bd){ bd = m; bi = i; }
    }
    return free.splice(bi,1)[0];
  };
  const place = (kind, howMany, near)=>{
    const out=[];
    for(let i=0;i<howMany && put<plan.cap && free.length; i++){
      const cell = near ? takeNear(near) : free.pop();
      if(!cell) break;
      const [r,c] = cell;
      grid[r][c] = kind==='oneway' ? (rng()<0.5 ? T.ONEWAY_A : T.ONEWAY_B) : kind;
      out.push([r,c]); put++;
    }
    return out;
  };
  place('oneway', plan.oneway);

  /* 프리즘을 소멸 타일보다 먼저 놓습니다.
     3갈래 중 하나만 흡수돼도 판 전체가 실패인 규칙이라, 순서를 반대로 하면
     소멸 타일이 모든 갈래를 죽여서 "위험만 있고 보상이 없는" 함정이 됩니다. */
  const prisms = [];
  for(let i=0; i<plan.prism && put<plan.cap && free.length; i++){
    let idx = free.length-1;
    for(let k=0; k<free.length; k++){                    // 갈래가 출구까지 닿는 자리를 고릅니다
      const cand = free.length-1-k;
      const [r,c] = free[cand];
      grid[r][c] = T.PRISM;
      const good = hasSafeSplitShot(grid, n, exits);
      grid[r][c] = null;
      if(good){ idx = cand; break; }
    }
    const [r,c] = free.splice(idx,1)[0];
    grid[r][c] = T.PRISM; prisms.push([r,c]); put++;
  }

  /* 소멸 타일은 한 칸씩 놓되, 프리즘이 있으면
     '살아남는 분산 발사'가 하나도 없어지는 자리는 피합니다.
     위험은 그대로 두면서(대부분의 갈래는 여전히 죽습니다) 보상의 길만 남깁니다. */
  for(let i=0; i<plan.vanish && put<plan.cap && free.length; i++){
    let idx = free.length-1;
    if(prisms.length){
      for(let k=0; k<Math.min(6, free.length); k++){
        const cand = free.length-1-k;
        const [r,c] = free[cand];
        grid[r][c] = T.VANISH;
        const alive = hasSafeSplitShot(grid, n, exits);
        grid[r][c] = null;
        if(alive){ idx = cand; break; }
      }
    }
    const [r,c] = free.splice(idx,1)[0];
    grid[r][c] = T.VANISH; put++;
  }
}

/* 프리즘을 지나면서 모든 갈래가 흡수되지 않고, 하나 이상이 출구에 닿는 발사가 있는가 */
function hasSafeSplitShot(grid, n, exits){
  for(let r=0;r<n;r++) for(let c=0;c<n;c++){
    if(grid[r][c]) continue;
    for(const d of DKEYS){
      const t = trace(grid,n,r,c,d);
      if(t.splits===0) continue;
      if(t.beams.some(b=>b.absorbed)) continue;
      if(t.beams.some(b => exits.some(e=>e.key===b.exit))) return true;
    }
  }
  return false;
}

/* 배치 후 실제로 풀리는지, 그리고 이 판에서 낼 수 있는 최고 점수는 얼마인지.
   safeBest 는 '프리즘을 쓰지 않는 안전한 경로'의 최고 점수입니다.
   프리즘 도박을 하지 않아도 클리어할 길이 반드시 남아 있어야 합니다. */
function solveInfo(grid, n, exits){
  let maxScore = 0, safeBest = 0, ok = false;
  let prismOk = false, prismMulti = 0;       // 프리즘을 살려서 낼 수 있는 결과
  for(let r=0;r<n;r++) for(let c=0;c<n;c++){
    if(grid[r][c]) continue;
    for(const d of DKEYS){
      const t = trace(grid,n,r,c,d);
      if(t.beams.some(b=>b.absorbed)) continue;        // 한 갈래라도 흡수되면 실패 발사
      const hits = t.beams.filter(b => exits.some(e=>e.key===b.exit));
      if(!hits.length) continue;
      const sc = shotScore(hits, exits, t.beams.length);
      if(sc > maxScore) maxScore = sc;
      if(t.splits===0){ ok = true; if(sc > safeBest) safeBest = sc; }
      else { prismOk = true; if(hits.length > prismMulti) prismMulti = hits.length; }
    }
  }
  return { ok, maxScore, safeBest, prismOk, prismMulti };
}

/* 한 발의 기본 점수.
   여러 갈래가 출구에 닿으면 '난사 보너스'가 붙습니다 (정밀 계산이 아니라 갈래 수 기반). */
const SPLIT_BONUS = [1, 1, 1.5, 2, 2];      // 도달 갈래 수 → 배율
function shotScore(hits, exits, beamCount){
  let best = 0;
  for(const b of hits){
    const e = exits.find(x=>x.key===b.exit);
    const v = b.path.length * 10 * e.mult;
    if(v > best) best = v;
  }
  const bonus = SPLIT_BONUS[Math.min(hits.length, SPLIT_BONUS.length-1)];
  return Math.round(best * bonus);
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
function shotGain({base, maxScore, remain, combo}){
  const perfect = base >= maxScore;
  const timeB   = Math.round(remain*8);
  const m       = 1 + combo*0.15;
  const rank    = Math.round(base*(perfect?2:1) * m);
  return { perfect, rank, total: Math.round((base*(perfect?2:1) + timeB) * m) };
}

/* FLIP 적용 — 거울을 뒤집고 그 판의 최고 점수(PERFECT 기준)를 다시 계산합니다.
   클라이언트와 검증기가 반드시 같은 함수를 써야 PERFECT 판정이 어긋나지 않습니다. */
function applyFlip(lv, n){
  const grid = flipGrid(lv.grid);
  const info = solveInfo(grid, n, lv.exits);
  return { ...lv, grid, maxScore: info.maxScore || lv.maxScore, safeBest: info.safeBest };
}

/* 한 발의 결과 판정 — 클라이언트와 서버가 반드시 같은 답을 내야 합니다. */
function judgeShot(grid, n, exits, r, c, d){
  const t = trace(grid, n, r, c, d);
  const absorbed = t.beams.some(b=>b.absorbed);
  const hits = t.beams.filter(b => exits.some(e=>e.key===b.exit));
  // 소멸 타일에 한 갈래라도 걸리면 판 전체가 실패입니다 (프리즘 도박의 대가)
  if(absorbed) return { ok:false, reason:'absorbed', beams:t.beams, splits:t.splits };
  if(!hits.length){
    const loop = t.beams.every(b=>b.loop);
    return { ok:false, reason:loop?'loop':'miss', beams:t.beams, splits:t.splits };
  }
  const bestBeam = hits.reduce((a,b)=> b.path.length>a.path.length ? b : a);
  return {
    ok:true, beams:t.beams, splits:t.splits, hits,
    base: shotScore(hits, exits, t.beams.length),
    cells: bestBeam.path.length,
    mult: exits.find(e=>e.key===bestBeam.exit).mult,
    splitHits: hits.length
  };
}
function feverGain({cells, hits, optimal, combo}){
  const g = Math.round((18 + cells*22 + hits*5) * (optimal?1.5:1) * (1 + combo*0.15));
  return { rank:g, total:g };                 // 피버는 시간 보너스가 없어 동일
}

/* ---------------- 리플레이 검증 ----------------
   log = { v, seed, events:[ {k:'s',r,c,d,e} | {k:'x'} | {k:'t'} | {k:'f',c,e} ] }
     s : 발사   (e = 그 레벨 타이머 시작 후 경과 ms)
     x : FLIP  (판마다 1회. 보드의 모든 거울이 뒤집힙니다)
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

  let flipped = false;                // 이 판에서 FLIP 을 이미 썼는가
  const loadLevel = ()=>{
    n = boardSizeFor(level);
    lv = genLevel(rng, n, level);
    tLimit = timeLimitFor(n, level);
    flipped = false;
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
    if(ev.k==='x'){                          // FLIP — 판마다 1회, 발사 전에만
      if(flipped) return fail('FLIP 을 두 번 썼습니다 @'+i);
      flipped = true;
      lv = applyFlip(lv, n);
      continue;
    }
    if(ev.k!=='s') return fail('플레이 중 허용되지 않는 이벤트 '+ev.k+' @'+i);

    const r=ev.r|0, c=ev.c|0, d=ev.d;
    if(r<0||r>=n||c<0||c>=n) return fail('칸 범위 밖 @'+i);
    if(lv.grid[r][c]) return fail('빈 칸이 아닌 곳에서 발사 @'+i);
    if(!DIRS[d]) return fail('방향 값이 잘못됨 @'+i);
    if(!(ev.e>=0 && ev.e<=tLimit*1000+250)) return fail('발사 시각 범위 밖 @'+i);
    playMs += ev.e;

    const j = judgeShot(lv.grid, n, lv.exits, r, c, d);
    if(j.ok){
      const remain = Math.max(0, tLimit - ev.e/1000);
      const g = shotGain({base:j.base, maxScore:lv.maxScore, remain, combo});
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
  // 규칙 버전을 시드에 넣어, 규칙이 바뀌면 판도 순위표도 자연히 새로 시작합니다
  return `${PROTOCOL}-${y}${String(m).padStart(2,'0')}${String(day).padStart(2,'0')}`;
}

const API = {
  PROTOCOL, FEVER_EVERY, FEVER_MS, MAX_LIFE, DIRS, DKEYS, OPP, REFLECT, T,
  isMirror, isOneway, onewayPasses, onewayFace, flipGrid, applyFlip,
  hashSeed, makeRng, rndOf, pickOf,
  boardSizeFor, timeLimitFor, trace, simulate, countBounces, genLevel,
  judgeShot, shotScore, solveInfo, hazardPlan,
  genFeverRow, newFeverRound, feverSim, feverBest,
  shotGain, feverGain, replay,
  shareCode, parseShareCode, dailySeed
};

if (typeof module === 'object' && module.exports) module.exports = API;
globalThis.MirrorCore = API;

})();
