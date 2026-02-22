#!/usr/bin/env node
/**
 * Halls of History — Hand Simulation Engine
 * Runs as a GitHub Action on a cron schedule.
 * Reads history.json, simulates all hands since last run, appends, commits back.
 *
 * This script is the single source of truth for game state.
 * It is append-only. It never resets anything.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, 'history.json');
const HAND_INTERVAL_SEC = 28;        // one hand every 28 seconds
const MAX_HANDS_PER_RUN = 200;       // safety cap per Action run
const KEEP_RECENT = 150;             // hands kept in recentHands (for poker page display)
// allTimeHands keeps a lightweight record of every hand ever played

// ── SEATS ──────────────────────────────────────────────────────────────────
const SEATS = [
  { name:'GPT-5.2',        short:'GPT-5.2',  emoji:'🤖', arch:'LAG' },
  { name:'Gemini 2.5 Pro', short:'Gem 2.5',  emoji:'🌐', arch:'TAG' },
  { name:'Claude 3.7',     short:'Cl 3.7',   emoji:'🔬', arch:'TAG' },
  { name:'o3-mini',        short:'o3-mini',  emoji:'⚡', arch:'GTO' },
  { name:'Grok-3',         short:'Grok-3',   emoji:'🦅', arch:'LAG' },
  { name:'Qwen3',          short:'Qwen3',    emoji:'🐉', arch:'TAG' },
  { name:'Flash Exp',      short:'Flash',    emoji:'⚗️', arch:'LAG' },
  { name:'Claude Opus 4',  short:'Cl Opus',  emoji:'👁️', arch:'TAG' },
  { name:'DeepSeek R1',    short:'DeepSeek', emoji:'🧮', arch:'GTO' },
];
const N = 9;

// ── SEEDED RNG (Splitmix32) ────────────────────────────────────────────────
function makeLCG(seed) {
  let s = (seed >>> 0) + 0x9e3779b9;
  return function () {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z;
  };
}

function handSeed(idx) {
  return (idx * 0x6c62272e + 0xd59b3b4f) >>> 0;
}

// ── DECK ──────────────────────────────────────────────────────────────────
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
const RANK_V = {};
RANKS.forEach((r, i) => (RANK_V[r] = i + 2));

function makeDeck(rng) {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push({ r, s, v: RANK_V[r] });
  for (let i = 51; i > 0; i--) {
    const j = rng() % (i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cs(c) { return c.r + c.s; }
function cIsRed(c) { return c.s === '♥' || c.s === '♦'; }

// ── HAND EVALUATOR ────────────────────────────────────────────────────────
function evalBest5(cards) {
  if (cards.length < 5) return 0;
  let best = 0;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const sc = score5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (sc > best) best = sc;
          }
  return best;
}

function score5(c) {
  const vs = c.map(x => x.v).sort((a, b) => b - a);
  const ss = c.map(x => x.s);
  const flush = ss.every(s => s === ss[0]);
  const st = straightHigh(vs);
  const cnt = {};
  for (const v of vs) cnt[v] = (cnt[v] || 0) + 1;
  const grps = Object.values(cnt).sort((a, b) => b - a);
  const kk = Object.entries(cnt)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([v]) => +v);
  const enc = kk.reduce((acc, v, i) => acc + v * Math.pow(15, kk.length - 1 - i), 0);
  if (flush && st === 14) return 9e6 + enc;
  if (flush && st)        return 8e6 + st * 1e3 + enc;
  if (grps[0] === 4)      return 7e6 + enc;
  if (grps[0] === 3 && grps[1] === 2) return 6e6 + enc;
  if (flush)              return 5e6 + enc;
  if (st)                 return 4e6 + st * 1e3 + enc;
  if (grps[0] === 3)      return 3e6 + enc;
  if (grps[0] === 2 && grps[1] === 2) return 2e6 + enc;
  if (grps[0] === 2)      return 1e6 + enc;
  return enc;
}

function straightHigh(vs) {
  const u = [...new Set(vs)];
  for (let i = 0; i <= u.length - 5; i++) {
    const s = u.slice(i, i + 5);
    if (s[0] - s[4] === 4 && new Set(s).size === 5) return s[0];
  }
  if (u.includes(14) && u.includes(5) && u.includes(4) && u.includes(3) && u.includes(2)) return 5;
  return null;
}

function rankName(sc) {
  if (sc >= 9e6) return 'Royal Flush';
  if (sc >= 8e6) return 'Straight Flush';
  if (sc >= 7e6) return 'Four of a Kind';
  if (sc >= 6e6) return 'Full House';
  if (sc >= 5e6) return 'Flush';
  if (sc >= 4e6) return 'Straight';
  if (sc >= 3e6) return 'Three of a Kind';
  if (sc >= 2e6) return 'Two Pair';
  if (sc >= 1e6) return 'One Pair';
  return 'High Card';
}

// ── PREFLOP STRENGTH ──────────────────────────────────────────────────────
function pfStr(hole) {
  const [a, b] = hole;
  const av = a.v, bv = b.v;
  const suited = a.s === b.s;
  const hi = Math.max(av, bv), lo = Math.min(av, bv);
  const gap = hi - lo;
  if (av === bv) {
    if (hi >= 12) return 0.90; if (hi >= 9) return 0.74;
    if (hi >= 6)  return 0.58; return 0.44;
  }
  if (hi === 14) {
    if (lo >= 12) return 0.84; if (lo >= 10) return 0.72;
    if (lo >= 8 && suited) return 0.64; if (lo >= 6) return 0.55; return 0.44;
  }
  if (hi >= 12 && lo >= 10) return 0.68;
  if (gap <= 2 && suited && hi >= 9) return 0.62;
  if (gap <= 1 && hi >= 9) return 0.57;
  if (suited && hi >= 10) return 0.54;
  if (gap <= 2 && hi >= 8) return 0.48;
  return 0.32;
}

// ── ACTION DECISION ───────────────────────────────────────────────────────
function decide(si, hole, board, pot, toCall, stack, position, nActive, street, rng) {
  const seat = SEATS[si];
  const r01 = () => (rng() >>> 0) / 4294967295;

  if (street === 'preflop') return decidePF(si, hole, pot, toCall, stack, position, nActive, r01);

  let str = 0;
  const all = [...hole, ...board];
  if (all.length >= 5) str = evalBest5(all) / 9e6;
  else str = pfStr(hole) * 0.85;

  const posBonus = position >= nActive - 2 ? 0.08 : 0;
  const adj = str + posBonus;
  const potOdds = pot > 0 ? toCall / (pot + toCall + 0.001) : 0;
  const spR = r01();

  if (toCall === 0) {
    if (adj > 0.74 && spR < 0.82) {
      const b = Math.max(Math.floor(pot * (0.45 + spR * 0.35)), 2);
      return { action: 'raise', amount: Math.min(b, stack), note: 'Value bet' };
    }
    if (adj > 0.50 && spR < 0.45) {
      const b = Math.max(Math.floor(pot * (0.33 + spR * 0.3)), 2);
      return { action: 'raise', amount: Math.min(b, stack), note: 'Probe bet' };
    }
    if (seat.arch === 'LAG' && adj > 0.36 && spR < 0.42 && street === 'flop') {
      const b = Math.max(Math.floor(pot * 0.55), 2);
      return { action: 'raise', amount: Math.min(b, stack), note: 'C-bet' };
    }
    if (seat.arch === 'GTO' && spR < 0.28 && adj > 0.42) {
      const b = Math.max(Math.floor(pot * (0.28 + spR * 0.2)), 2);
      return { action: 'raise', amount: Math.min(b, stack), note: 'Mixed freq bet' };
    }
    return { action: 'call', amount: 0, note: 'Check' };
  }

  if (adj > 0.80 && stack > toCall * 2 && spR < 0.38) {
    const rz = Math.min(Math.floor((pot + toCall) * 2.3), stack);
    return { action: 'raise', amount: rz, note: 'Value raise' };
  }
  if (adj > potOdds + 0.20 || (adj > 0.68 && spR < 0.7))
    return { action: 'call', amount: Math.min(toCall, stack), note: 'Call with equity' };
  if (adj > potOdds - 0.08 && spR < 0.32)
    return { action: 'call', amount: Math.min(toCall, stack), note: 'Pot odds call' };
  return { action: 'fold', amount: 0, note: 'Fold' };
}

function decidePF(si, hole, pot, toCall, stack, position, nActive, r01) {
  const seat = SEATS[si];
  const str = pfStr(hole);
  const inBtn = position === nActive - 1;
  const spR = r01();
  const foldThresh = seat.arch === 'LAG' ? 0.30 : seat.arch === 'GTO' ? 0.36 : 0.40;
  if (str < foldThresh) {
    if (toCall === 0) return { action: 'call', amount: 0, note: 'Check BB' };
    return { action: 'fold', amount: 0, note: 'Below range' };
  }
  if (toCall === 0) {
    if (str > 0.52 || (inBtn && str > 0.40) || (seat.arch === 'LAG' && str > 0.38)) {
      const sz = Math.min((pot || 2) * 3 + 2, stack);
      return { action: 'raise', amount: sz, note: 'Open raise' };
    }
    return { action: 'call', amount: 0, note: 'Limp' };
  }
  const potOdds = toCall / (pot + toCall);
  if (str > 0.80 || (str > 0.70 && seat.arch === 'LAG' && spR < 0.28)) {
    const rz = Math.min(toCall * 3 + (pot || 0), stack);
    return { action: 'raise', amount: rz, note: '3-bet' };
  }
  if (str > potOdds + 0.14)
    return { action: 'call', amount: Math.min(toCall, stack), note: 'Call raise' };
  return { action: 'fold', amount: 0, note: 'Fold to raise' };
}

// ── BETTING ROUND ─────────────────────────────────────────────────────────
function bettingRound(folded, stacks, invested, hole, board, street, firstActIdx, dealerIdx, sbIdx, bbIdx, pot, rng) {
  const bets = Array(N).fill(0);
  if (street === 'preflop') {
    bets[sbIdx] = Math.min(1, stacks[sbIdx] + invested[sbIdx]);
    bets[bbIdx] = Math.min(2, stacks[bbIdx] + invested[bbIdx]);
  }
  let maxBet = bets.reduce((a, b) => Math.max(a, b), 0);

  const order = [];
  for (let off = 0; off < N; off++) {
    const s = (firstActIdx + off) % N;
    if (!folded[s]) order.push(s);
  }

  const needsAct = new Set(order);
  const actionLog = [];
  let safety = 0;

  while (needsAct.size > 0 && safety++ < N * 6) {
    const s = order.find(x => needsAct.has(x));
    if (s === undefined) break;
    needsAct.delete(s);
    if (folded[s]) continue;

    const active = order.filter(x => !folded[x]);
    if (active.length <= 1) break;

    const toCall = Math.max(0, maxBet - bets[s]);
    const position = active.indexOf(s);
    const dec = decide(s, hole[s], board, pot, toCall, stacks[s], position, active.length, street, rng);

    if (dec.action === 'fold') {
      folded[s] = true;
      actionLog.push(`${SEATS[s].short}: FOLD`);
    } else if (dec.action === 'call' || dec.amount === 0) {
      const amt = Math.min(toCall, stacks[s]);
      stacks[s] -= amt; bets[s] += amt; pot += amt; invested[s] += amt;
      actionLog.push(`${SEATS[s].short}: ${toCall === 0 ? 'CHECK' : `CALL $${amt}`}`);
    } else {
      const totalBet = Math.min(dec.amount, stacks[s] + bets[s]);
      const add = totalBet - bets[s];
      if (add <= 0) {
        const amt = Math.min(toCall, stacks[s]);
        stacks[s] -= amt; bets[s] += amt; pot += amt; invested[s] += amt;
        actionLog.push(`${SEATS[s].short}: CALL $${amt}`);
      } else {
        stacks[s] -= add; bets[s] += add; pot += add; invested[s] += add;
        maxBet = bets[s];
        actionLog.push(`${SEATS[s].short}: RAISE to $${bets[s]}`);
        for (const other of order) {
          if (!folded[other] && other !== s && bets[other] < maxBet) needsAct.add(other);
        }
      }
    }
  }

  return { pot, actionLog };
}

// ── SIMULATE ONE HAND ─────────────────────────────────────────────────────
function simulateHand(handIdx, stacksIn) {
  const rng = makeLCG(handSeed(handIdx));
  const stacks = [...stacksIn];
  const deck = makeDeck(rng);

  const dealerIdx = handIdx % N;
  const sbIdx = (dealerIdx + 1) % N;
  const bbIdx = (dealerIdx + 2) % N;

  const hole = Array.from({ length: N }, () => [deck.pop(), deck.pop()]);
  const board5 = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  const folded = Array(N).fill(false);
  const invested = Array(N).fill(0);

  // Post blinds
  const sbAmt = Math.min(1, stacks[sbIdx]);
  const bbAmt = Math.min(2, stacks[bbIdx]);
  stacks[sbIdx] -= sbAmt; invested[sbIdx] += sbAmt;
  stacks[bbIdx] -= bbAmt; invested[bbIdx] += bbAmt;
  let pot = sbAmt + bbAmt;

  const actionsByStreet = { preflop: [], flop: [], turn: [], river: [] };

  // PRE-FLOP
  const utg = (dealerIdx + 3) % N;
  const pfResult = bettingRound(folded, stacks, invested, hole, [], 'preflop', utg, dealerIdx, sbIdx, bbIdx, pot, rng);
  pot = pfResult.pot;
  actionsByStreet.preflop = pfResult.actionLog;

  let active = Array.from({ length: N }, (_, i) => i).filter(i => !folded[i]);
  if (active.length === 1) {
    const w = active[0]; stacks[w] += pot;
    return buildResult(handIdx, dealerIdx, sbIdx, bbIdx, hole, [], pot, w, 'Uncontested', [], stacks, actionsByStreet);
  }

  // FLOP
  const flop = board5.slice(0, 3);
  const flopResult = bettingRound(folded, stacks, invested, hole, flop, 'flop', (dealerIdx + 1) % N, dealerIdx, sbIdx, bbIdx, pot, rng);
  pot = flopResult.pot;
  actionsByStreet.flop = flopResult.actionLog;

  active = Array.from({ length: N }, (_, i) => i).filter(i => !folded[i]);
  if (active.length === 1) {
    const w = active[0]; stacks[w] += pot;
    return buildResult(handIdx, dealerIdx, sbIdx, bbIdx, hole, flop, pot, w, 'Uncontested', [], stacks, actionsByStreet);
  }

  // TURN
  const turn = [...flop, board5[3]];
  const turnResult = bettingRound(folded, stacks, invested, hole, turn, 'turn', (dealerIdx + 1) % N, dealerIdx, sbIdx, bbIdx, pot, rng);
  pot = turnResult.pot;
  actionsByStreet.turn = turnResult.actionLog;

  active = Array.from({ length: N }, (_, i) => i).filter(i => !folded[i]);
  if (active.length === 1) {
    const w = active[0]; stacks[w] += pot;
    return buildResult(handIdx, dealerIdx, sbIdx, bbIdx, hole, turn, pot, w, 'Uncontested', [], stacks, actionsByStreet);
  }

  // RIVER
  const river = [...turn, board5[4]];
  const riverResult = bettingRound(folded, stacks, invested, hole, river, 'river', (dealerIdx + 1) % N, dealerIdx, sbIdx, bbIdx, pot, rng);
  pot = riverResult.pot;
  actionsByStreet.river = riverResult.actionLog;

  // SHOWDOWN
  const sdSeats = Array.from({ length: N }, (_, i) => i).filter(i => !folded[i]);
  let bestScore = -1, winner = -1;
  for (const s of sdSeats) {
    const sc = evalBest5([...hole[s], ...river]);
    if (sc > bestScore) { bestScore = sc; winner = s; }
  }
  stacks[winner] += pot;

  // Rebuy under 60bb
  for (let i = 0; i < N; i++) if (stacks[i] < 60) stacks[i] = 400;

  return buildResult(handIdx, dealerIdx, sbIdx, bbIdx, hole, river, pot, winner, rankName(bestScore), sdSeats, stacks, actionsByStreet);
}

function buildResult(handIdx, dealerIdx, sbIdx, bbIdx, hole, board, pot, winner, winHand, sdSeats, stacks, actionsByStreet) {
  const ts = new Date(
    // Genesis: 2026-02-22T00:00:00 UTC + handIdx * HAND_INTERVAL_SEC seconds
    Date.UTC(2026, 1, 22, 0, 0, 0) + handIdx * HAND_INTERVAL_SEC * 1000
  ).toISOString();

  return {
    handIndex: handIdx,
    handNumber: handIdx + 1,
    timestamp: ts,
    dealer: dealerIdx,
    sb: sbIdx,
    bb: bbIdx,
    pot,
    board: board.map(cs),
    winner,
    winnerName: SEATS[winner].short,
    winHand,
    sdSeats,
    // Hole cards stored as strings — readable in archive
    hole: hole.map(h => h.map(cs)),
    stacks: [...stacks],
    actions: actionsByStreet,
  };
}

// ── LIFETIME STATS UPDATER ────────────────────────────────────────────────
function updateLifetimeStats(lifetimeStats, result) {
  lifetimeStats.handsDealt++;
  const p = lifetimeStats.byPlayer[result.winner];
  p.wins++;
  p.potsWon += result.pot;
  if (result.sdSeats.length > 1) {
    for (const si of result.sdSeats) {
      lifetimeStats.byPlayer[si].showdowns++;
      if (si === result.winner) lifetimeStats.byPlayer[si].showdownWins++;
    }
  }
  for (let i = 0; i < N; i++) {
    const lp = lifetimeStats.byPlayer[i];
    if (result.stacks[i] > lp.stackHigh) lp.stackHigh = result.stacks[i];
    if (result.stacks[i] < lp.stackLow) lp.stackLow = result.stacks[i];
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────
function main() {
  console.log('[simulate] Starting hand simulation run...');

  // Load history
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));

  const lastHandIndex = history.meta.lastHandIndex;
  const now = Date.now();

  // Genesis is 2026-02-22T00:00:00 UTC
  const genesisMs = Date.UTC(2026, 1, 22, 0, 0, 0);
  const currentHandIndex = Math.floor((now - genesisMs) / (HAND_INTERVAL_SEC * 1000));

  if (currentHandIndex <= lastHandIndex) {
    console.log(`[simulate] Up to date. Last hand: #${lastHandIndex + 1}. Current: #${currentHandIndex + 1}. Nothing to do.`);
    return;
  }

  const fromIndex = lastHandIndex + 1;
  const toIndex = Math.min(currentHandIndex, fromIndex + MAX_HANDS_PER_RUN - 1);
  const handsToSimulate = toIndex - fromIndex + 1;

  console.log(`[simulate] Simulating hands #${fromIndex + 1} → #${toIndex + 1} (${handsToSimulate} hands)`);

  // Get current stacks from history
  let stacks = [...history.currentStacks];

  const newResults = [];
  for (let i = fromIndex; i <= toIndex; i++) {
    const result = simulateHand(i, stacks);
    stacks = result.stacks;
    updateLifetimeStats(history.lifetimeStats, result);
    newResults.push(result);
  }

  // Update history object
  history.meta.lastHandIndex = toIndex;
  history.meta.lastUpdated = new Date().toISOString();
  history.meta.totalHands = toIndex + 1;
  history.currentStacks = stacks;

  // recentHands: rolling window of KEEP_RECENT
  const combined = [...history.recentHands, ...newResults];
  history.recentHands = combined.slice(-KEEP_RECENT);

  // allTimeHands: lightweight record of every hand — just enough for the archive
  const lightweight = newResults.map(r => ({
    n: r.handNumber,
    ts: r.timestamp,
    w: r.winner,
    wn: r.winnerName,
    wh: r.winHand,
    pot: r.pot,
    board: r.board,
    stacks: r.stacks,
  }));
  history.allTimeHands = [...(history.allTimeHands || []), ...lightweight];

  // Write back
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');

  console.log(`[simulate] Done. Total hands in ledger: ${history.meta.totalHands}`);
  console.log(`[simulate] File size: ${Math.round(fs.statSync(HISTORY_PATH).size / 1024)}KB`);
}

main();
