// CPU oponente: gera PlayerInput (mesmo formato do input.js).
// Prediz a trajetória da bola com predictBall, escolhe um ponto confortável após o quique
// no próprio lado e move a raquete até lá com tempo de reação e erro conforme o nível.
import { TABLE_HALF, HIT_RADIUS, PADDLE_MAX_SPEED, PADDLE_ZONE, BALL_R } from './constants.js';
import { predictBall } from './physics.js';
import { canHit } from './shot.js';

export const AI_LEVELS = {
  easy: {
    reaction: 0.4,       // s até começar a reagir à bola que vem
    speed: 0.55,         // fração da velocidade máxima da raquete
    errSigma: 0.09,      // erro gaussiano (m) do ponto de interceptação
    bigMissChance: 0.3,  // chance de "ler errado" a bola
    bigMiss: 0.24,       // tamanho do erro grosseiro (m)
    replan: 0.25,        // s entre recálculos da previsão
    smashChance: 0.3,    // tenta smashes "afobados" (erra muito)
    smashMinY: 0.3,
    aimDepth: [0, 0],
    aimSpread: 0.15,
    mix: { drive: 0.55, topspin: 0.2, block: 0.1, chop: 0.15 },
    lowMix: { drive: 0.6, topspin: 0.2, block: 0.2 },
    serveTypes: ['drive', 'drive', 'block'],
    serveWait: 1.0
  },
  normal: {
    reaction: 0.18,
    speed: 0.85,
    errSigma: 0.035,
    bigMissChance: 0.07,
    bigMiss: 0.2,
    replan: 0.12,
    smashChance: 0.4,
    smashMinY: 0.45,
    aimDepth: [-0.3, 0.4],
    aimSpread: 0.3,
    mix: { topspin: 0.3, drive: 0.3, chop: 0.15, block: 0.25 },
    lowMix: { block: 0.35, chop: 0.35, drive: 0.3 },
    serveTypes: ['drive', 'topspin', 'chop'],
    serveWait: 0.8
  },
  hard: {
    reaction: 0.09,
    speed: 1.0,
    errSigma: 0.016,
    bigMissChance: 0.025,
    bigMiss: 0.18,
    replan: 0.06,
    smashChance: 0.5,
    smashMinY: 0.5,
    aimDepth: [-0.2, 0.5],
    aimSpread: 0.5,
    mix: { topspin: 0.4, block: 0.3, chop: 0.2, drive: 0.1 },
    lowMix: { chop: 0.5, block: 0.4, topspin: 0.1 },
    serveTypes: ['drive', 'topspin', 'chop', 'topspin', 'smash'],
    serveWait: 0.75
  }
};

const KP = 7;                    // ganho do controlador de posição (1/s)
const HOME_DX = 1.75;            // posição de espera (|x|)
const HOME_Y = 0.22;
const SMASH_MIN_Y = 0.3;         // abaixo disto um smash planejado vira topspin
const LOW_BALL_Y = 0.15;         // contato baixo: golpes mais seguros
const MIN_CONTACT_X = 0.95;      // |x| mínimo do ponto de contato
const COMFORT_MIN_Y = 0.08;
const COMFORT_MAX_Y = 0.75;
const PREDICT_TIME = 2.2;
const PREDICT_DT = 1 / 120;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function gauss(rng) {
  let u = rng();
  const v = rng();
  if (u < 1e-9) u = 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pickWeighted(mix, rng) {
  let total = 0;
  for (const k in mix) total += mix[k];
  let r = rng() * total;
  for (const k in mix) {
    r -= mix[k];
    if (r <= 0) return k;
  }
  return 'drive';
}

function emptyInput() {
  return {
    connected: true, source: 'cpu', moveX: 0, moveY: 0, aimX: 0, aimY: 0,
    shot: null, shotPressed: null, pausePressed: false
  };
}

export function createAI(opts) {
  opts = opts || {};
  const level = AI_LEVELS[opts.level] ? opts.level : 'normal';
  return {
    level: level,
    params: AI_LEVELS[level],
    rng: opts.rng || Math.random,
    phase: null,
    serveTimer: 0,
    serveWait: 0,
    serveType: null,
    servePressed: false,
    serveTarget: null,
    incoming: false,
    reactTimer: 0,
    replanTimer: 0,
    plan: null,          // { x, y, t, shot, aimX, aimY, errX, errY, letGo }
    ownBounced: false,
    pressedThisBall: false,
    prevVy: 0
  };
}

function homeTarget(side) {
  return { x: side * HOME_DX, y: HOME_Y };
}

function inZone(x, y, side) {
  const xs = x * side; // distância "para trás" a partir da rede no próprio lado
  return xs >= MIN_CONTACT_X && xs <= -PADDLE_ZONE.xMin - 0.05 &&
    y >= PADDLE_ZONE.yMin + 0.03 && y <= PADDLE_ZONE.yMax - 0.03;
}

// Escolhe o ponto de interceptação na trajetória prevista.
function findIntercept(ai, ball, paddle, side) {
  const samples = predictBall(ball, PREDICT_TIME, PREDICT_DT);
  const p = ai.params;
  const speed = PADDLE_MAX_SPEED * p.speed * 0.8;
  let start = -1;
  if (ai.ownBounced) {
    start = 0;
  } else {
    for (let i = 0; i < samples.length && start < 0; i++) {
      const ev = samples[i].events;
      for (let j = 0; j < ev.length; j++) {
        if (ev[j].type === 'bounce' && ev[j].side === side) { start = i + 1; break; }
        if (ev[j].type === 'floor') { i = samples.length; break; }
      }
    }
  }
  if (start < 0) return null; // não quica no nosso lado: deixa passar (fora/rede)

  let best = null;
  let bestScore = -1e9;
  let fallback = null;
  let fallbackSlack = -1e9;
  for (let i = start; i < samples.length; i++) {
    const s = samples[i];
    if (s.events.length && s.events[0].type === 'floor') break;
    if (s.vx * side <= 0) break; // voltou (rede) — não persegue
    if (!inZone(s.x, s.y, side)) continue;
    if (s.y < COMFORT_MIN_Y && Math.abs(s.x) <= TABLE_HALF + BALL_R) continue;
    const dx = s.x - paddle.x;
    const dy = s.y - paddle.y;
    const need = Math.sqrt(dx * dx + dy * dy) / speed + 0.04;
    const slack = s.t - need;
    if (slack > fallbackSlack) { fallbackSlack = slack; fallback = s; }
    if (slack < 0) continue;
    // Preferência: altura confortável perto do ápice, sem ir muito para trás.
    let score = 0;
    const y = s.y;
    if (y >= COMFORT_MIN_Y && y <= COMFORT_MAX_Y) score += 1;
    score += Math.min(y, 0.5) * 1.5;         // mais alto = melhor
    score -= Math.abs(s.vy) * 0.08;          // perto do ápice
    score -= Math.max(0, s.x * side - 2.0) * 1.5; // longe demais da mesa
    score -= s.t * 0.15;                     // prefere não esperar demais
    if (score > bestScore) { bestScore = score; best = s; }
  }
  const chosen = best || fallback;
  if (!chosen) return null;
  return { x: chosen.x, y: chosen.y, t: chosen.t, vy: chosen.vy };
}

function chooseShot(ai, ball, contactY, side) {
  const p = ai.params;
  const rng = ai.rng;
  let shot;
  if (contactY >= p.smashMinY && rng() < p.smashChance) {
    shot = 'smash';
  } else if (contactY < LOW_BALL_Y) {
    shot = pickWeighted(p.lowMix, rng);
  } else if ((ball.spin || 0) < -40 && ai.level !== 'easy') {
    shot = pickWeighted({ topspin: 0.5, chop: 0.3, block: 0.2 }, rng);
  } else {
    shot = pickWeighted(p.mix, rng);
  }
  const depth = p.aimDepth[0] + (p.aimDepth[1] - p.aimDepth[0]) * rng();
  return {
    shot: shot === 'block' ? null : shot,
    aimX: clamp(-side * depth, -1, 1),
    aimY: clamp((rng() * 2 - 1) * p.aimSpread, -1, 1)
  };
}

function newPlan(ai, ball, paddle, side) {
  const p = ai.params;
  const rng = ai.rng;
  const hit = findIntercept(ai, ball, paddle, side);
  if (!hit) return { letGo: true };
  let errX = gauss(rng) * p.errSigma;
  let errY = gauss(rng) * p.errSigma;
  if (rng() < p.bigMissChance) {
    const a = rng() * Math.PI * 2;
    errX += Math.cos(a) * p.bigMiss;
    errY += Math.sin(a) * p.bigMiss;
  }
  const s = chooseShot(ai, ball, hit.y, side);
  return {
    letGo: false, x: hit.x, y: hit.y, t: hit.t,
    errX: errX, errY: errY, shot: s.shot, aimX: s.aimX, aimY: s.aimY
  };
}

function steer(out, paddle, target, speedFrac) {
  const maxV = PADDLE_MAX_SPEED * speedFrac;
  let vx = (target.x - paddle.x) * KP;
  let vy = (target.y - paddle.y) * KP;
  const sp = Math.sqrt(vx * vx + vy * vy);
  if (sp > maxV) { vx *= maxV / sp; vy *= maxV / sp; }
  out.moveX = clamp(vx / PADDLE_MAX_SPEED, -1, 1);
  out.moveY = clamp(vy / PADDLE_MAX_SPEED, -1, 1);
}

function resetBall(ai) {
  ai.incoming = false;
  ai.plan = null;
  ai.ownBounced = false;
  ai.pressedThisBall = false;
  ai.reactTimer = 0;
  ai.replanTimer = 0;
}

export function updateAI(ai, state) {
  const ball = state.ball;
  const paddle = state.paddle;
  const side = state.side;
  const phase = state.phase;
  const dt = state.dt > 0 ? state.dt : 1 / 60;
  const p = ai.params;
  const rng = ai.rng;
  const out = emptyInput();
  if (!ball || !paddle) return out;

  if (phase !== ai.phase) {
    ai.phase = phase;
    ai.serveTimer = 0;
    ai.servePressed = false;
    ai.serveType = null;
    ai.serveTarget = null;
    resetBall(ai);
  }

  // --- Saque ---
  if (phase === 'serve') {
    if (state.isServer) {
      if (!ai.serveTarget) {
        ai.serveTarget = { x: side * (TABLE_HALF + 0.12 + rng() * 0.1), y: 0.16 + rng() * 0.14 };
        ai.serveWait = p.serveWait + rng() * 0.35;
        ai.serveType = p.serveTypes[Math.floor(rng() * p.serveTypes.length)];
      }
      steer(out, paddle, ai.serveTarget, 0.6);
      ai.serveTimer += dt;
      out.shot = ai.serveType;
      if (ai.serveTimer >= ai.serveWait) {
        out.shotPressed = ai.serveType;
        out.aimX = clamp(-side * (rng() * 0.6 - 0.2), -1, 1);
        // Se o jogo ainda não aceitou o saque, tenta de novo em 0.5 s.
        ai.serveTimer = ai.serveWait - 0.5;
      }
    } else {
      steer(out, paddle, homeTarget(side), 0.6);
    }
    return out;
  }

  // --- Rally ---
  const incoming = state.ballInPlay !== false && !ball.dead && ball.vx * side > 0.3;
  if (!incoming) {
    if (ai.incoming) resetBall(ai);
    steer(out, paddle, homeTarget(side), p.speed * 0.7);
    ai.prevVy = ball.vy;
    return out;
  }

  if (!ai.incoming) {
    ai.incoming = true;
    ai.reactTimer = p.reaction * (0.75 + rng() * 0.5);
    ai.plan = null;
    ai.ownBounced = false;
    ai.pressedThisBall = false;
  }

  // Detecta o quique no próprio lado (vy troca de sinal perto do tampo).
  if (!ai.ownBounced && ai.prevVy < 0 && ball.vy > 0 && ball.y < 0.08 &&
      ball.x * side > 0 && ball.x * side <= TABLE_HALF + 0.02) {
    ai.ownBounced = true;
  }
  ai.prevVy = ball.vy;

  if (ai.reactTimer > 0) {
    ai.reactTimer -= dt;
    // Ainda "lendo" a bola: deriva devagar para a posição de espera.
    steer(out, paddle, homeTarget(side), p.speed * 0.4);
    return out;
  }

  ai.replanTimer -= dt;
  if (!ai.plan || ai.replanTimer <= 0) {
    const prev = ai.plan;
    const np = newPlan(ai, ball, paddle, side);
    if (prev && !prev.letGo && !np.letGo) {
      // Mantém o erro e o golpe sorteados para esta bola .
      np.errX = prev.errX; np.errY = prev.errY;
      np.shot = prev.shot; np.aimX = prev.aimX; np.aimY = prev.aimY;
      if (np.y < SMASH_MIN_Y - 0.08 && np.shot === 'smash') np.shot = 'topspin';
    }
    ai.plan = np;
    ai.replanTimer = p.replan;
  }

  const plan = ai.plan;
  if (plan.letGo) {
    steer(out, paddle, homeTarget(side), p.speed * 0.5);
    return out;
  }

  const target = { x: plan.x + plan.errX, y: plan.y + plan.errY };
  steer(out, paddle, target, p.speed);
  out.shot = plan.shot;
  out.aimX = plan.aimX;
  out.aimY = plan.aimY;

  const dx = ball.x - paddle.x;
  const dy = ball.y - paddle.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (!ai.pressedThisBall && plan.shot && (dist < HIT_RADIUS * 2.5 || canHit(ball, paddle, side))) {
    out.shotPressed = plan.shot;
    ai.pressedThisBall = true;
  }
  return out;
}
