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
const PROTOCOL = 'mr7';

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
/* 방은 6×6 까지만 커집니다(v1.8).
   7×7 은 훑는 비용만 늘렸습니다 — 60초를 런 전체가 공유하므로 큰 판은 시간을 더 먹고,
   타일 배율이 0.68 까지 줄어 모바일 터치도 불편했습니다.
   후반 난이도는 거울 밀도와 '정답 희소성' 이 이어받습니다. */
const boardSizeFor = lv => lv<13 ? 5 : 6;
const timeLimitFor = (n,lv) => Math.max(6 + (n-5)*1.5, (13 + (n-5)*3) - lv*0.4);

const FEVER_EVERY = 5;
const FEVER_MS    = 6000;
/* ---------------- 시간 규칙 (v1.6) ----------------
   판마다 제한시간을 초기화하던 방식을 버리고 **런 전체가 하나의 시간 풀**을 씁니다.
   시간이 0이 되면 그 자리에서 게임 오버이고, 라이프 개념은 없앴습니다.
   틀린 발사의 대가는 '거기에 쓴 시간' 그 자체입니다.

   시간은 **플레이어가 판을 보고 있는 동안에만** 흐릅니다.
   빔이 나는 동안과 피버 구간에서는 줄지 않습니다. */
const TIME_MAX       = 60000;   // 시작 시간 풀 (ms)
const PERFECT_REGAIN = 2000;    // PERFECT 한 발마다 회복 (상한 TIME_MAX)
const MAX_LIFE       = 3;       // 남겨둔 상수 — v1.6 부터 게임 진행에는 쓰지 않습니다

/* ---------------- 런 길이 상한 (v1.10) ----------------
   v1.6 에서 판별 제한시간을 없애고 전역 풀로 바꾸면서, 풀을 깎는 값이
   '클라이언트가 보고한 시간' 하나가 되어 버렸습니다.
   그래서 모든 발사를 e=0 으로 보고하면 풀이 줄지 않아 런이 끝나지 않았습니다.
   실측: 발사 72번의 보고 시간 합계 6ms 로 레벨 71·랭크 563,418 이 검증을 통과.
   (정당한 최고 기록의 122배)

   아래 세 상한이 그 구멍을 막습니다. 사람의 정상 플레이는 건드리지 않는 값입니다. */
/* 한 발이 풀에서 최소로 소모하는 시간. 보고값이 이보다 작아도 이만큼 깎습니다.
   200ms 로 두면 풀 예산(60초+회복 30초)이 450발을 감당해, 정직한 플레이(약 60발)의
   7.5배까지 벌 수 있었습니다. 500ms 면 상한이 180발로 내려갑니다.
   사람이 새 판을 읽고 두 번 누르는 데 0.5초 미만이 걸리는 일은 드물어,
   정상 플레이(발당 약 1,500ms)에는 영향이 없습니다. */
const MIN_SHOT_MS     = 500;
const REGAIN_CAP      = 30000;  // 한 런에서 PERFECT 로 회복할 수 있는 총량.
                                //   이게 없으면 회복(2000) > 최소비용(200) 이라 런이 무한해집니다.
const FEVER_MAX_TAPS  = 25;     // 피버 한 구간의 최대 타격 수.
                                //   시각만 0 으로 채우면 무한히 두드릴 수 있었습니다.

/* 콤보 배수 상한.
   배수가 무한히 오르면 점수가 '발사 수의 제곱'에 비례해, 런을 늘리는 모든 수단이
   과도하게 보상됩니다. 실측: 발사 2.5배 차이가 점수 35배 차이가 됐습니다.
   상한을 두면 점수가 발사 수에 거의 선형이 되어, 남은 오차가 그대로 오차로 남습니다.
   또한 '오래 버티기' 보다 '잘 쏘기' 가 점수를 가르게 됩니다. */
const COMBO_MULT_MAX = 4.0;                 // 콤보 20 에서 도달
const comboMult = combo => Math.min(COMBO_MULT_MAX, 1 + combo*0.15);

/* ---------------- 빔 시뮬레이션 ----------------
   trace() 는 한 발이 만들어내는 '모든 갈래'를 돌려줍니다.
   프리즘이 없으면 갈래는 1개뿐이라 예전과 똑같이 동작합니다.

   반환: { beams:[{path, exit, loop, absorbed}], splits }
     exit     : 'r,c,d' 형태의 탈출 경계면, 못 나갔으면 null
     absorbed : 소멸 타일에 흡수됨 (그 갈래는 실패)
     loop     : 무한 반사

   무한 재귀를 막기 위해 한 갈래가 지날 수 있는 프리즘 수(MAX_SPLITS)와
   전체 스텝 수(STEP_BUDGET)에 상한을 둡니다.
   MAX_SPLITS 는 **갈래별 깊이**입니다. 프리즘 1개당 2갈래이므로 최대 2²=4갈래입니다. */
const MAX_SPLITS  = 2;      // 한 갈래가 프리즘을 최대 2번까지 지날 수 있음
const STEP_BUDGET = 900;    // 모든 갈래를 합친 이동 칸 수 상한

function trace(grid, n, r0, c0, d0){
  const beams = [];
  let steps = 0, splits = 0;          // splits: 이 발에서 일어난 분기 횟수(0이면 프리즘을 안 지남)

  // 시작 지점이 프리즘이어도 첫 칸에서는 갈라지지 않습니다(설치 칸은 항상 빈 칸)
  const queue = [{ r:r0, c:c0, d:d0, depth:0, path:[[r0,c0]], seen:new Set() }];

  while(queue.length){
    const b = queue.shift();
    let { r, c, d, path, seen } = b;
    const depth = b.depth;

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
        /* 좌 90°·우 90° **두 갈래만** 만듭니다. 직진 갈래는 만들지 않습니다.

           직진을 두면 프리즘이 원래 정답 경로를 그대로 이어받아, 프리즘이 없어도
           성공했을 발사에 배율만 얹히는 '공짜 성공' 이 생깁니다(실측 43.1%).
           직진을 없애면 그 경우가 구조적으로 발생할 수 없어 예외 처리가 필요 없습니다. */
        if(depth >= MAX_SPLITS){
          // 분기 예산을 다 쓴 갈래는 여기서 끝납니다 (직진으로 통과시키지 않습니다)
          beams.push({ path, exit:null, loop:false, absorbed:false, blocked:true }); break;
        }
        splits++;
        const back = OPP[d];
        for(const nd of DKEYS){
          if(nd === back || nd === d) continue;              // 뒤로도, 직진으로도 가지 않습니다
          queue.push({ r, c, d:nd, depth:depth+1, path:path.slice(), seen:new Set(seen) });
        }
        break;                                               // 들어온 갈래는 프리즘에서 소비됩니다
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
  /* 거울 밀도 상한을 0.55 → 0.62 로 올렸습니다(v1.8).
     5×5 구간(레벨 1~12)은 거울이 최대 12개라 이 상한에 닿지 않으므로 영향이 없고,
     6×6 에서만 22개까지 늘어 후반 곡선이 이어집니다. */
  const mirrorCount = Math.min(4 + Math.floor(level*0.7), Math.floor(total*0.62));
  const wantLen     = Math.min(5 + Math.floor(level/2), 14 + (n-5)*5);
  const wantBounce  = Math.min(1 + Math.floor(level/4), 6);

  /* 정답 희소성 — 이 판을 클리어하는 발사가 몇 개까지 있어도 되는가.
     밀도와 방 크기는 물리적 상한이 있지만 이 값은 없어서, 후반 난이도를 여기서 끌고 갑니다.
     레벨이 오를수록 조여 "찍어서 맞는" 확률을 낮춥니다. */
  const wantSol = Math.max(3, 6 - Math.floor(level/10));
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
    const maxSol    = relax ? wantSol + 6 : wantSol;
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
/* 프리즘·단방향 거울 — v1.5 에서 켰습니다.

   오래 막혀 있던 원인은 '배치 후 회피' 라는 생성 방식이었습니다(placeHazards 주석 참고).
   '배치 후 재검증' 으로 바꾸고, 프리즘은 직진을 없애 좌우 2갈래로 확정했습니다.
   실측 — 프리즘 '1갈래 이상 출구 도달' 46.8%, 단방향 '정답 경로 관여' 94.1%. */
const PRISM_ENABLED = true;
const ONEWAY_ENABLED = true;

function hazardPlan(n, level){
  const total = n*n;
  return {
    vanish : Math.min(1 + Math.floor(level/5), 3),
    /* 등장 시점을 앞으로 당겼습니다(v1.7).
       첫 피버가 5연속 클리어 직후(=레벨 6 진입)이므로, 프리즘을 그 시점에 붙여
       "피버를 한 번 보고 나면 새 기믹이 열린다"는 리듬을 만듭니다. */
    prism  : (PRISM_ENABLED && level>=6) ? Math.min(1 + Math.floor((level-6)/8), 2) : 0,
    oneway : (ONEWAY_ENABLED && level>=8) ? Math.min(1 + Math.floor((level-8)/10), 2) : 0,
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

/* 특수 타일 배치 — 타일 종류에 따라 두 가지 전략을 씁니다.

   소멸 타일: **배치 후 회피** (예전 그대로)
     보호구역(두 출구의 최적 경로) 밖에만 놓습니다. 소멸 타일은 위협이라
     경로 밖에 있어도 제 역할을 합니다.

   프리즘·단방향 거울: **배치 후 재검증** (v1.4 에서 바꿨습니다)
     보호구역 안, 즉 정답 경로 위까지 후보에 넣고, 놓은 뒤 판이 여전히 풀리는지
     다시 시뮬레이션해서 통과할 때만 확정합니다.

     왜 바꿨는가: 레이저 경로는 결정론적·가역적이라 출구에서 역추적한 경로가
     '갈래가 출구에 닿을 수 있는 칸' 전체와 정확히 일치합니다. 그 경로를 피해서만
     놓으면 프리즘 갈래가 출구에 닿는 일은 **원리적으로 불가능**합니다.
     실측으로도 그런 자리 1,429곳이 전부 보호구역 안이었고 배치 가능한 칸은 0곳,
     프리즘 발사 12,187건이 100% 실패였습니다. 단방향 거울이 정답에 관여하는 판도
     같은 이유로 0% 였습니다. 회피로는 고칠 수 없는 구조적 원인입니다. */
function placeHazards(rng, grid, n, level, exits, keepIn){
  const plan = hazardPlan(n, level);
  const shuffle = a =>{ for(let i=a.length-1;i>0;i--){ const j=rndOf(rng,i+1); [a[i],a[j]]=[a[j],a[i]]; } return a; };
  const emptyCells = ()=>{
    const out=[];
    for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(!grid[r][c]) out.push([r,c]);
    return out;
  };

  let put = 0;
  const solvable = ()=> solveInfo(grid, n, exits).ok;   // 안전한(갈라지지 않는) 정답 경로가 남아 있는가

  /* 후보를 훑어 '판이 계속 풀리는' 첫 자리에 놓습니다.
     want 를 주면 그 조건까지 만족하는 자리를 먼저 찾고, 없으면 풀림만 보고 놓습니다.
     둘 다 실패하면 그 타일은 놓지 않습니다 — 의미 없는 자리에 억지로 놓지 않습니다. */
  const placeVerified = (makeTile, want)=>{
    const cands = shuffle(emptyCells());
    for(let pass=0; pass<(want?2:1); pass++){
      for(const [r,c] of cands){
        if(grid[r][c]) continue;
        grid[r][c] = makeTile();
        if(solvable() && (pass===1 || !want || want(r,c))){ put++; return [r,c]; }
        grid[r][c] = null;
      }
    }
    return null;
  };

  /* ── 프리즘을 먼저 놓습니다 ──
     순서가 중요합니다. 단방향을 먼저 놓으면, 뒤에 놓인 프리즘이 단방향이 쓰던
     정답 경로를 끊어(프리즘은 들어온 갈래를 소비합니다) 단방향이 장식이 됩니다.
     실측: 단방향 → 프리즘 순서에서 관여율이 97.9% → 77.6% 로 떨어졌습니다.
     프리즘을 먼저 놓고 단방향을 그 위에서 검증하면 이 문제가 생기지 않습니다. */
  const prisms = [];
  for(let i=0; i<plan.prism && put<plan.cap; i++){
    const cell = placeVerified(()=>T.PRISM, ()=> hasSplitExitShot(grid, n, exits));
    if(!cell) break;
    prisms.push(cell);
  }

  // ── 단방향 거울 — 정답 경로에 실제로 관여하는 자리를 우선합니다 ──
  const oneways = [];
  for(let i=0; i<plan.oneway && put<plan.cap; i++){
    const cell = placeVerified(
      ()=> rng()<0.5 ? T.ONEWAY_A : T.ONEWAY_B,
      (r,c)=> onSolutionPath(grid, n, exits, r, c));
    if(!cell) break;
    oneways.push(cell);
  }

  /* ── 소멸 타일 ──
     보호구역을 여기서 다시 구합니다. 프리즘·단방향이 예전 최적 경로 위에 놓였을 수 있어
     받아온 keep 이 더는 살아 있는 경로가 아닐 수 있기 때문입니다.
     (그대로 쓰면 소멸 타일이 남은 유일한 정답 경로를 막아버릴 수 있습니다) */
  const keep = (prisms.length || oneways.length)
    ? protectedCells(grid, n, exits)
    : (keepIn || protectedCells(grid, n, exits));
  const outside = shuffle(emptyCells().filter(([r,c]) => !keep.has(r+','+c)));

  for(let i=0; i<plan.vanish && put<plan.cap && outside.length; i++){
    let idx = outside.length-1;
    if(prisms.length){
      // 프리즘이 있으면 '갈래가 출구에 닿는 길'을 전부 지우는 자리는 피합니다
      for(let k=0; k<Math.min(6, outside.length); k++){
        const cand = outside.length-1-k;
        const [r,c] = outside[cand];
        grid[r][c] = T.VANISH;
        const alive = hasSplitExitShot(grid, n, exits);
        grid[r][c] = null;
        if(alive){ idx = cand; break; }
      }
    }
    const [r,c] = outside.splice(idx,1)[0];
    grid[r][c] = T.VANISH; put++;
  }
}

/* 프리즘을 지나 갈라진 갈래 중 하나 이상이 실제 출구에 닿는 발사가 있는가.
   죽은 갈래는 그 갈래만 무효이므로 흡수 여부는 보지 않습니다. */
function hasSplitExitShot(grid, n, exits){
  for(let r=0;r<n;r++) for(let c=0;c<n;c++){
    if(grid[r][c]) continue;
    for(const d of DKEYS){
      const t = trace(grid,n,r,c,d);
      if(t.splits===0) continue;
      if(t.beams.some(b => exits.some(e=>e.key===b.exit))) return true;
    }
  }
  return false;
}

/* (r,c) 가 '갈라지지 않는 정답 경로' 위에 실제로 놓여 있는가.
   단방향 거울이 장식이 아니라 답에 관여하는지 보는 기준입니다.

   프리즘을 지나 갈라진 경로는 세지 않습니다(splits===0 만 인정).
   solveInfo 의 ok 도 갈라지지 않는 경로로 판정하므로 기준을 맞춥니다. */
function onSolutionPath(grid, n, exits, r0, c0){
  for(let r=0;r<n;r++) for(let c=0;c<n;c++){
    if(grid[r][c]) continue;
    for(const d of DKEYS){
      const t = trace(grid,n,r,c,d);
      if(t.splits !== 0) continue;
      const b = t.beams[0];
      if(!b || b.absorbed || !b.exit) continue;
      if(!exits.some(e=>e.key===b.exit)) continue;
      if(b.path.some(([pr,pc]) => pr===r0 && pc===c0)) return true;
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
      // 일반 발사만 흡수로 실패합니다. 프리즘 발사는 죽은 갈래를 무효로 넘깁니다.
      if(t.splits===0 && t.beams.some(b=>b.absorbed)) continue;
      const hits = t.beams.filter(b => exits.some(e=>e.key===b.exit));
      if(!hits.length) continue;
      const sc = shotScore(hits, exits, t.beams);
      if(sc > maxScore) maxScore = sc;
      if(t.splits===0){ ok = true; if(sc > safeBest) safeBest = sc; }
      else { prismOk = true; if(hits.length > prismMulti) prismMulti = hits.length; }
    }
  }
  return { ok, maxScore, safeBest, prismOk, prismMulti };
}

/* 한 발의 기본 점수.
   점수의 뼈대는 '출구에 닿은 갈래 중 가장 긴 것'이고, 여기에 '난사 보너스'가 붙습니다.

   보너스는 **보드 밖으로 나간 갈래 수**를 셉니다 — 정답 출구가 아니어도 됩니다.
   프리즘의 값은 "갈래를 살려서 내보냈다"에 있고, 세 갈래가 모두 정답 출구로 모이는 것은
   기하학적으로 거의 불가능하기 때문입니다. 흡수·무한반사로 죽은 갈래는 세지 않습니다.
   갈래가 하나뿐인 일반 발사는 나간 갈래도 1개라 배율 1 — 예전과 값이 같습니다. */
/* 보드를 벗어난 갈래 수 → 배율.

   실측 기준으로 정했습니다. 프리즘 발사는 배율을 붙이기 **전에** 이미 일반 발사의
   1.8~4.2배입니다(꺾인 갈래가 길게 돌기 때문). 그래서 배율을 세게 주면 프리즘이
   사실상 필수 선택이 됩니다.

   out=2 가 성공의 64% 를 차지해 실질 조절 지점은 인덱스 2 하나입니다.
   이 값이면 계산해서 맞춘 프리즘 발사는 일반 발사의 2.6배, 감으로 지르면
   기대값 1.2배입니다(성공률 45%, 실패 시 라이프 손실). */
const SPLIT_BONUS = [1, 1, 1.25, 1.6, 2.0];
function shotScore(hits, exits, beams){
  let best = 0;
  for(const b of hits){
    const e = exits.find(x=>x.key===b.exit);
    const v = b.path.length * 10 * e.mult;
    if(v > best) best = v;
  }
  const out = beams.filter(b=>b.exit).length;
  const bonus = SPLIT_BONUS[Math.min(out, SPLIT_BONUS.length-1)];
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
/* remain 은 이제 **남은 전체 시간(초)** 입니다(예전에는 그 판의 남은 제한시간).
   랭킹 점수(rank)에는 여전히 시간 보너스가 들어가지 않습니다 — 서버가 검증할 수 없는
   값이라 비교 기준에서 빼는 편이 정직합니다. */
function shotGain({base, maxScore, remain, combo}){
  const perfect = base >= maxScore;
  const timeB   = Math.round(remain*2);
  const m       = comboMult(combo);
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

/* 한 발의 결과 판정 — 클라이언트와 서버가 반드시 같은 답을 내야 합니다.

   갈래가 하나인 일반 발사와 프리즘으로 갈라진 발사의 규칙이 다릅니다.

   일반 발사(splits===0)
     소멸 타일에 걸리면 실패. 예전과 같습니다.

   프리즘 발사(splits>=1)
     소멸·벽·무한반사로 끝난 갈래는 **그 갈래만 무효**이고 판을 실패로 만들지 않습니다.
     최소 1갈래가 실제 출구에 닿으면 클리어이고, 전부 죽으면 실패입니다.
     한 갈래만 흡수돼도 전부 실패로 처리하던 예전 규칙에서는 프리즘이
     위험만 있고 보상이 없는 함정이었습니다. */
function judgeShot(grid, n, exits, r, c, d){
  const t = trace(grid, n, r, c, d);
  const hits = t.beams.filter(b => exits.some(e=>e.key===b.exit));

  if(t.splits === 0 && t.beams.some(b=>b.absorbed))
    return { ok:false, reason:'absorbed', beams:t.beams, splits:t.splits };

  if(!hits.length){
    // 실패 사유는 '모든 갈래가 같은 이유로 죽었을 때'만 그 이유로 알려줍니다
    const reason = t.beams.every(b=>b.absorbed) ? 'absorbed'
                 : t.beams.every(b=>b.loop)     ? 'loop'
                 : 'miss';
    return { ok:false, reason, beams:t.beams, splits:t.splits };
  }
  const bestBeam = hits.reduce((a,b)=> b.path.length>a.path.length ? b : a);
  return {
    ok:true, beams:t.beams, splits:t.splits, hits,
    base: shotScore(hits, exits, t.beams),
    cells: bestBeam.path.length,
    mult: exits.find(e=>e.key===bestBeam.exit).mult,
    splitHits: hits.length
  };
}
function feverGain({cells, hits, optimal, combo}){
  const g = Math.round((18 + cells*22 + hits*5) * (optimal?1.5:1) * comboMult(combo));
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
  let level=1, combo=0, rank=0, total=0;
  let mode='play';                    // play | fever
  let lv=null, n=0;
  let fever=null, feverHits=0, feverRound=null;
  let playMs=0;                       // 재생상 소요된 최소 시간(초 단위 검증용)
  let pool = TIME_MAX;                // 남은 전체 시간(ms). 0 이 되면 게임 오버
  let regained=0, feverTaps=0;        // 회복 총량·피버 구간 타격 수 (런 길이 상한)

  const loadLevel = ()=>{
    n = boardSizeFor(level);
    lv = genLevel(rng, n, level);
  };
  const enterFever = ()=>{ mode='fever'; feverHits=0; fever=0; feverTaps=0; feverRound=newFeverRound(rng); };
  const leaveFever = ()=>{
    // 피버는 시간을 깎지 않습니다(보상 자체가 '공짜 시간'). 라이프 회복은 없앴습니다.
    playMs += FEVER_MS;
    mode='play'; level++; loadLevel();
  };
  const fail = reason => ({ ok:false, reason, rank, total, level });
  const done = () => ({ ok:true, rank, total, level, playMs, reason:null });

  loadLevel();

  for(let i=0;i<events.length;i++){
    const ev = events[i];
    if(pool<=0) return fail('시간이 0인데 이벤트가 더 있음 @'+i);

    if(mode==='fever'){
      if(ev.k==='e'){ leaveFever(); continue; }
      if(ev.k!=='f') return fail('피버 중 허용되지 않는 이벤트 '+ev.k+' @'+i);
      if(!(ev.e>=0 && ev.e<=FEVER_MS)) return fail('피버 시각 범위 밖 @'+i);
      if(ev.e < fever) return fail('피버 시각이 역행 @'+i);
      if(++feverTaps > FEVER_MAX_TAPS) return fail('피버 타격이 한 구간 상한을 넘음 @'+i);
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

    if(ev.k==='x'){                          // FLIP — v1.6 부터 횟수 제한 없음
      lv = applyFlip(lv, n);
      continue;
    }
    if(ev.k!=='s') return fail('플레이 중 허용되지 않는 이벤트 '+ev.k+' @'+i);

    const r=ev.r|0, c=ev.c|0, d=ev.d;
    if(r<0||r>=n||c<0||c>=n) return fail('칸 범위 밖 @'+i);
    if(lv.grid[r][c]) return fail('빈 칸이 아닌 곳에서 발사 @'+i);
    if(!DIRS[d]) return fail('방향 값이 잘못됨 @'+i);
    // e = 이 판을 보며 쓴 시간(ms). 남은 시간보다 오래 걸렸다면 불가능한 발사입니다.
    if(!(ev.e>=0)) return fail('발사 시각이 음수 @'+i);
    if(ev.e > pool + 250) return fail('남은 시간보다 오래 걸린 발사 @'+i);
    // 보고값이 0 이어도 최소 비용은 반드시 소모합니다 (클라이언트도 같은 값으로 깎습니다)
    pool -= Math.max(ev.e, MIN_SHOT_MS);
    playMs += ev.e;

    const j = judgeShot(lv.grid, n, lv.exits, r, c, d);
    if(j.ok){
      const g = shotGain({base:j.base, maxScore:lv.maxScore, remain:Math.max(0,pool)/1000, combo});
      rank += g.rank; total += g.total; combo++;
      if(g.perfect){                                    // 회복은 최대치와 런 총량 둘 다에 걸립니다
        const add = Math.max(0, Math.min(PERFECT_REGAIN, REGAIN_CAP - regained));
        regained += add;
        pool = Math.min(TIME_MAX, pool + add);
      }
      if(combo % FEVER_EVERY === 0) enterFever();
      else { level++; loadLevel(); }
    }else{
      // 실패해도 레벨은 오르지 않습니다(같은 레벨의 새 판). 대가는 거기에 쓴 시간입니다.
      combo=0; loadLevel();
    }
    if(pool<=0) return done();                // 시간이 다 되면 그 자리에서 끝
  }
  return done();
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

/* ---------------- 자유 플레이 시드 ----------------
   런마다 새 판이지만 순위표는 하나로 모입니다. 같은 생성기·같은 난이도 곡선을
   레벨 1부터 순서대로 밟으므로, 판이 달라도 런 전체 점수는 비교가 성립합니다.

   오늘의 판과 마찬가지로 규칙 버전을 앞에 붙입니다. 그래야 규칙이 바뀌었을 때
   옛 기록이 새 순위표에 남지 않습니다.

   rand 는 시드 생성에만 쓰는 난수입니다(판 진행에는 절대 쓰지 않습니다).
   서버가 발급한 값을 클라이언트가 그대로 받아쓰는 것이 원칙이며,
   이 함수는 서버와 오프라인 플레이가 같은 형식을 쓰도록 두었습니다. */
function freeSeed(nowMs, rand){
  const r = Math.floor((rand ? rand() : 0.5) * 0xFFFFFFFF).toString(36);
  return `${PROTOCOL}-f${Number(nowMs).toString(36)}${r}`;
}
const isFreeSeed = s => typeof s==='string' && s.startsWith(PROTOCOL+'-f');

const API = {
  PROTOCOL, FEVER_EVERY, FEVER_MS, MIN_SHOT_MS, REGAIN_CAP, FEVER_MAX_TAPS,
  COMBO_MULT_MAX, comboMult, MAX_LIFE, TIME_MAX, PERFECT_REGAIN, DIRS, DKEYS, OPP, REFLECT, T,
  isMirror, isOneway, onewayPasses, onewayFace, flipGrid, applyFlip,
  hashSeed, makeRng, rndOf, pickOf,
  boardSizeFor, timeLimitFor, trace, simulate, countBounces, genLevel,
  judgeShot, shotScore, solveInfo, hazardPlan,
  hasSplitExitShot, onSolutionPath, protectedCells, bestPathCells,
  genFeverRow, newFeverRound, feverSim, feverBest,
  shotGain, feverGain, replay,
  shareCode, parseShareCode, dailySeed, freeSeed, isFreeSeed
};

if (typeof module === 'object' && module.exports) module.exports = API;
globalThis.MirrorCore = API;

})();
