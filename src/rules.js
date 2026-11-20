// Regras oficiais ITTF (singles): placar, saque, troca de lados e árbitro do rally.
// Sem DOM; roda no Node para testes. Sintaxe compatível com navegadores antigos de TV.
import { TABLE_HALF, SIDE_LEFT, SIDE_RIGHT } from './constants.js';

export const REASON_TEXT = {
  SERVE_FAULT: 'Falta de saque',
  SERVE_NET: 'Saque na rede',
  OUT: 'Bola fora',
  NET: 'Rede',
  OWN_SIDE: 'Quicou no próprio lado',
  DOUBLE_BOUNCE: 'Dois quiques',
  MISS: 'Não devolveu',
  OBSTRUCTION: 'Obstrução',
  DOUBLE_HIT: 'Toque duplo',
  LET: 'Let — repetir saque'
};

function other(player) {
  return player === 0 ? 1 : 0;
}

function gamesNeeded(match) {
  return Math.floor(match.bestOf / 2) + 1;
}

// ---------------------------------------------------------------------------
// Partida
// ---------------------------------------------------------------------------

export function createMatch(opts) {
  const o = opts || {};
  const bestOf = o.bestOf === undefined ? 5 : o.bestOf;
  const pointsToWin = o.pointsToWin === undefined ? 11 : o.pointsToWin;
  const firstServer = o.firstServer === undefined ? 0 : o.firstServer;
  const changeEnds = o.changeEnds === undefined ? true : !!o.changeEnds;
  return {
    bestOf: bestOf,
    pointsToWin: pointsToWin,
    changeEnds: changeEnds,
    score: [0, 0],
    gamesWon: [0, 0],
    gameNumber: 1,
    history: [],
    firstServerOfGame: firstServer,
    firstServerOfMatch: firstServer,
    endsSwapped: false,
    deciderSwapDone: false,
    over: false,
    winner: null
  };
}

export function awardPoint(match, player) {
  const result = { gameOver: false, matchOver: false, gameWinner: null, swapEnds: false };
  if (match.over || (player !== 0 && player !== 1)) return result;

  const opp = other(player);
  match.score[player] += 1;
  const P = match.pointsToWin;

  if (match.score[player] >= P && match.score[player] - match.score[opp] >= 2) {
    result.gameOver = true;
    result.gameWinner = player;
    match.gamesWon[player] += 1;
    match.history.push([match.score[0], match.score[1]]);

    if (match.gamesWon[player] >= gamesNeeded(match)) {
      match.over = true;
      match.winner = player;
      result.matchOver = true;
      return result;
    }

    match.gameNumber += 1;
    match.score = [0, 0];
    match.firstServerOfGame = (match.gameNumber - 1) % 2 === 0
      ? match.firstServerOfMatch
      : other(match.firstServerOfMatch);
    if (match.changeEnds) {
      match.endsSwapped = !match.endsSwapped;
      result.swapEnds = true;
    }
    return result;
  }

  // Game decisivo: troca de lados quando o primeiro jogador chega a 5 pontos (11 pontos).
  const deciderMark = Math.ceil(P / 2) - 1;
  if (match.changeEnds && !match.deciderSwapDone && match.gameNumber === match.bestOf &&
      match.score[player] === deciderMark && match.score[opp] < deciderMark) {
    match.deciderSwapDone = true;
    match.endsSwapped = !match.endsSwapped;
    result.swapEnds = true;
  }
  return result;
}

export function getServer(match) {
  const first = match.firstServerOfGame;
  const total = match.score[0] + match.score[1];
  const deuceAt = match.pointsToWin - 1;
  let turns;
  if (match.score[0] >= deuceAt && match.score[1] >= deuceAt) {
    // A partir de 10-10: troca a cada ponto.
    turns = deuceAt + (total - 2 * deuceAt);
  } else {
    turns = Math.floor(total / 2);
  }
  return turns % 2 === 0 ? first : other(first);
}

export function getReceiver(match) {
  return other(getServer(match));
}

export function getSide(match, player) {
  const base = player === 0 ? SIDE_LEFT : SIDE_RIGHT;
  return match.endsSwapped ? -base : base;
}

export function isDeuce(match) {
  const d = match.pointsToWin - 1;
  return match.score[0] >= d && match.score[1] >= d;
}

export function isGamePoint(match) {
  if (match.over) return null;
  const P = match.pointsToWin;
  for (let p = 0; p < 2; p++) {
    const mine = match.score[p];
    const theirs = match.score[other(p)];
    if (mine + 1 >= P && mine + 1 - theirs >= 2) return p;
  }
  return null;
}

export function isMatchPoint(match) {
  const p = isGamePoint(match);
  if (p === null) return null;
  return match.gamesWon[p] + 1 >= gamesNeeded(match) ? p : null;
}

// ---------------------------------------------------------------------------
// Árbitro do rally
// ---------------------------------------------------------------------------
// Fases: 'awaitServe' (aguardando golpe de saque) -> 'serve' (bola do saque em voo)
//        -> 'rally' -> 'over' (decisão tomada; rally.result guarda o resultado).

export function createRally(match) {
  const server = getServer(match);
  const receiver = other(server);
  const sides = {};
  sides[0] = getSide(match, 0);
  sides[1] = getSide(match, 1);
  return {
    server: server,
    receiver: receiver,
    sides: sides,
    phase: 'awaitServe',
    lastHitter: null,
    hits: 0,
    ownBounces: 0,     // quiques no lado de quem bateu por último, desde o golpe
    targetBounces: 0,  // quiques no lado do oponente de quem bateu por último, desde o golpe
    netTouched: false, // a bola tocou a rede desde o último golpe
    result: null
  };
}

function finish(rally, winner, reason) {
  rally.phase = 'over';
  rally.result = { winner: winner, reason: reason };
  return rally.result;
}

function finishLet(rally) {
  rally.phase = 'over';
  rally.result = { let: true, reason: 'LET' };
  return rally.result;
}

function registerHit(rally, player) {
  rally.lastHitter = player;
  rally.hits += 1;
  rally.ownBounces = 0;
  rally.targetBounces = 0;
  rally.netTouched = false;
}

function refereeAwaitServe(rally, event) {
  const server = rally.server;
  const receiver = rally.receiver;
  if (event.type === 'hit') {
    if (event.player === server) {
      registerHit(rally, server);
      rally.phase = 'serve';
      return null;
    }
    // Recebedor tocou a bola antes do saque.
    return finish(rally, server, 'OBSTRUCTION');
  }
  if (event.type === 'floor') return finish(rally, receiver, 'MISS');
  if (event.type === 'bounce') return finish(rally, receiver, 'SERVE_FAULT');
  return null;
}

function refereeServe(rally, event) {
  const server = rally.server;
  const receiver = rally.receiver;
  const serverSide = rally.sides[server];
  const failReason = rally.netTouched ? 'SERVE_NET' : 'SERVE_FAULT';

  if (event.type === 'net') {
    rally.netTouched = true;
    return null;
  }
  if (event.type === 'bounce') {
    if (event.side === serverSide) {
      if (rally.ownBounces === 0 && !rally.netTouched) {
        rally.ownBounces = 1;
        return null;
      }
      // Segundo quique no lado do sacador (ou voltou da rede).
      return finish(rally, receiver, failReason);
    }
    // Quique no lado do recebedor.
    if (rally.ownBounces === 0) return finish(rally, receiver, 'SERVE_FAULT');
    if (rally.netTouched) return finishLet(rally);
    rally.targetBounces = 1;
    rally.phase = 'rally';
    return null;
  }
  if (event.type === 'floor') return finish(rally, receiver, failReason);
  if (event.type === 'hit') {
    if (event.player === server) return finish(rally, receiver, 'DOUBLE_HIT');
    // Recebedor rebateu antes da bola quicar no seu lado.
    if (Math.abs(event.x) > TABLE_HALF) return finish(rally, receiver, failReason);
    if (rally.ownBounces === 0) return finish(rally, receiver, 'SERVE_FAULT');
    // Saque que tocou a rede e seria bom: obstrução num let continua sendo let.
    if (rally.netTouched) return finishLet(rally);
    return finish(rally, server, 'OBSTRUCTION');
  }
  return null;
}

function refereeRally(rally, event) {
  const hitter = rally.lastHitter;
  const opp = other(hitter);
  const hitterSide = rally.sides[hitter];

  if (event.type === 'hit') {
    if (event.player === hitter) {
      // Bater duas vezes seguidas / tocar a bola que é do oponente.
      return finish(rally, opp, 'DOUBLE_HIT');
    }
    if (rally.targetBounces >= 1) {
      registerHit(rally, opp);
      return null;
    }
    // Voleio: rebateu antes de a bola quicar no seu lado.
    if (Math.abs(event.x) <= TABLE_HALF) return finish(rally, hitter, 'OBSTRUCTION');
    return finish(rally, opp, 'OUT');
  }
  if (event.type === 'net') {
    rally.netTouched = true;
    return null;
  }
  if (event.type === 'bounce') {
    if (event.side === hitterSide) {
      if (rally.targetBounces >= 1) {
        // Quicou no lado do oponente e voltou sem ser devolvida.
        return finish(rally, hitter, 'MISS');
      }
      return finish(rally, opp, rally.netTouched ? 'NET' : 'OWN_SIDE');
    }
    rally.targetBounces += 1;
    if (rally.targetBounces >= 2) return finish(rally, hitter, 'DOUBLE_BOUNCE');
    return null;
  }
  if (event.type === 'floor') {
    if (rally.targetBounces >= 1) return finish(rally, hitter, 'MISS');
    return finish(rally, opp, rally.netTouched ? 'NET' : 'OUT');
  }
  return null;
}

export function refereeEvent(rally, event) {
  if (!rally || !event || rally.phase === 'over' || rally.result) return null;
  if (rally.phase === 'awaitServe') return refereeAwaitServe(rally, event);
  if (rally.phase === 'serve') return refereeServe(rally, event);
  if (rally.phase === 'rally') return refereeRally(rally, event);
  return null;
}
