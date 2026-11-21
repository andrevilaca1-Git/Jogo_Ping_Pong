// CPU oponente (v2, visão superior 3D): gera PlayerInput (mesmo formato do input.js).
// Prediz a trajetória 3D da bola com predictBall, escolhe um ponto de interceptação confortável
// após o quique no próprio lado e move a raquete no plano da mesa (x e z) até lá, com tempo de
// reação e erro conforme o nível. A altura (y) da raquete é automática (trackPaddleHeight no jogo).
//
// Saída em coordenadas de TELA (iguais para os dois lados):
//   moveY > 0 -> mundo +x ; moveX > 0 -> mundo +z
//   aimX = lateral (+z) ; aimY = profundidade * -side (o jogo converte: depth = aimY * -side)
import { TABLE_HALF, TABLE_W_HALF, HIT_RADIUS, PADDLE_MAX_SPEED, PADDLE_ZONE, BALL_R } from './constants.js';
import { predictBall } from './physics.js';
import { canHit } from './shot.js';

export const AI_LEVELS = {
  easy: {
    reaction: 0.4,        // s até começar a reagir à bola que vem
    speed: 0.55,          // fração da velocidade máxima da raquete
    errSigma: 0.08,       // erro gaussiano (m) do ponto de interceptação, em x e em z
    bigMissChance: 0.3,   // chance de "ler errado" a bola
    bigMiss: 0.24,        // tamanho do erro grosseiro (m)
    replan: 0.25,         // s entre recálculos da previsão
    smashChance: 0.3,     // tenta smashes "afobados" (erra muito)
    smashMinY: 0.3,
    // Mira: previsível — quase sempre no meio da mesa, profundidade neutra.
    lateralSpread: 0.15,
    cornerChance: 0,
    depth: [-0.1, 0.1],
    mix: { drive: 0.55, topspin: 0.2, block: 0.1, chop: 0.15 },
    lowMix: { drive: 0.6, topspin: 0.2, block: 0.2 },
    serveTypes: ['drive', 'drive', 'block'],
    serveLateral: 0.2,
    serveWait: 1.0
  },
  normal: {
    reaction: 0.18,
    speed: 0.85,
    errSigma: 0.035,
    bigMissChance: 0.08,
    bigMiss: 0.2,
    replan: 0.12,
    smashChance: 0.4,
    smashMinY: 0.45,
    // v2: mira lateral em toda a largura útil (antes ±0.5 -> z ±0.27: quase tudo pelo centro)
    lateralSpread: 1.0,
    cornerChance: 0.25,
    depth: [-0.3, 0.4],
    mix: { topspin: 0.3, drive: 0.3, chop: 0.15, block: 0.25 },
    lowMix: { block: 0.35, chop: 0.35, drive: 0.3 },
    serveTypes: ['drive', 'topspin', 'chop'],
    serveLateral: 0.5,
    serveWait: 0.8
  },
  hard: {
    reaction: 0.1,
    speed: 1.0,
    errSigma: 0.045,      // v2: menos perfeita que na v1 (rallies CPU×CPU longos demais)
    bigMissChance: 0.1,
    bigMiss: 0.17,
    replan: 0.06,
    smashChance: 0.7,     // v2: mais agressiva (ataca bola alta, cantos e fundo) em vez de
    smashMinY: 0.35,      // só empurrar: rallies hard×hard ficavam longos demais
    lateralSpread: 0.78,  // + cantos: a bola circula pela mesa toda
    cornerChance: 0.6,    // às vezes busca os cantos (lateral ±0.8..1, fundo)
    depth: [0.1, 0.8],
    mix: { topspin: 0.4, block: 0.2, chop: 0.15, drive: 0.25 },
    lowMix: { chop: 0.45, block: 0.35, topspin: 0.2 },
    serveTypes: ['drive', 'topspin', 'chop', 'topspin', 'smash'],
    serveLateral: 0.85,
    serveWait: 0.75
  }
};

const KP = 7;                    // ganho do controlador de posição (1/s)
const HOME_DX = 1.75;            // posição de espera (|x|)
const HOME_Z = 0;
const SMASH_MIN_Y = 0.3;         // abaixo disto um smash planejado vira topspin
const LOW_BALL_Y = 0.15;         // contato baixo: golpes mais seguros
const MIN_CONTACT_X = 0.95;      // |x| mínimo do ponto de contato
const COMFORT_MIN_Y = 0.08;
const COMFORT_MAX_Y = 0.75;
const PREDICT_TIME = 2.2;
const PREDICT_DT = 1 / 120;
const CORNER_LATERAL = 0.8;

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

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

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
    serveTarget: null,
    serveAim: null,
    incoming: false,
    reactTimer: 0,
    replanTimer: 0,
    plan: null,          // { x, z, y, t, shot, aimX, aimY, errX, errZ, letGo }
    ownBounced: false,
    pressedThisBall: false,
    prevVy: 0
  };
}

function homeTarget(side) {
  return { x: side * HOME_DX, z: HOME_Z };
}

function inZone(x, y, z, side) {
  const xs = x * side; // distância "para trás" a partir da rede no próprio lado
  return xs >= MIN_CONTACT_X && xs <= -PADDLE_ZONE.xMin - 0.05 &&
    z >= PADDLE_ZONE.zMin + 0.05 && z <= PADDLE_ZONE.zMax - 0.05 &&
    y >= PADDLE_ZONE.yMin + 0.03 && y <= PADDLE_ZONE.yMax - 0.03;
}

// Escolhe o ponto de interceptação na trajetória 3D prevista.
function findIntercept(ai, ball, paddle, side) {
  const samples = predictBall(ball, PREDICT_TIME, PREDICT_DT);
  const p = ai.params;
  const speed = PADDLE_MAX_SPEED * p.speed * 0.8;
  const pz = num(paddle.z);
  let start = -1;
  if (ai.ownBounced) {
    start = 0;
  } else {
    for (let i = 0; i < samples.length && start < 0; i++) {
      const ev = samples[i].events || [];
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
    const ev = s.events || [];
    if (ev.length && ev[0].type === 'floor') break;
    if (s.vx * side <= 0) break; // voltou (rede) — não persegue
    const sz = num(s.z);
    if (!inZone(s.x, s.y, sz, side)) continue;
    if (s.y < COMFORT_MIN_Y && Math.abs(s.x) <= TABLE_HALF + BALL_R && Math.abs(sz) <= TABLE_W_HALF + BALL_R) continue;
    const dx = s.x - paddle.x;
    const dz = sz - pz;
    const need = Math.sqrt(dx * dx + dz * dz) / speed + 0.05;
    const slack = s.t - need;
    if (slack > fallbackSlack) { fallbackSlack = slack; fallback = s; }
    if (slack < 0) continue;
    // Preferência: altura confortável perto do ápice, sem ir muito para trás nem para o lado.
    let score = 0;
    const y = s.y;
    if (y >= COMFORT_MIN_Y && y <= COMFORT_MAX_Y) score += 1;
    score += Math.min(y, 0.5) * 1.5;                 // mais alto = melhor
    score -= Math.abs(s.vy) * 0.1;                   // perto do ápice (altura automática acompanha melhor)
    score -= Math.max(0, s.x * side - 2.0) * 1.5;    // longe demais da mesa
    score -= Math.max(0, Math.abs(sz) - 1.0) * 1.0;  // muito aberto na lateral
    score -= s.t * 0.15;                             // prefere não esperar demais
    if (score > bestScore) { bestScore = score; best = s; }
  }
  const chosen = best || fallback;
  if (!chosen) return null;
  return { x: chosen.x, y: chosen.y, z: num(chosen.z), t: chosen.t, vy: chosen.vy };
}

// Escolhe a direção do golpe. Retorna { lateral, depth } (-1..1; depth +1 = mais fundo).
function chooseAim(ai, contactZ, opponent) {
  const p = ai.params;
  const rng = ai.rng;
  if (p.cornerChance > 0 && rng() < p.cornerChance) {
    // Canto: se souber onde está o oponente, vai para o lado mais longe dele;
    // senão, cruzado em relação ao ponto de contato (ou aleatório se no meio).
    let dirZ;
    if (opponent && typeof opponent.z === 'number') {
      dirZ = opponent.z > 0 ? -1 : 1;
    } else if (Math.abs(contactZ) > 0.2) {
      dirZ = contactZ > 0 ? -1 : 1;
      if (rng() < 0.35) dirZ = -dirZ; // às vezes paralelo
    } else {
      dirZ = rng() < 0.5 ? -1 : 1;
    }
    return {
      lateral: dirZ * (CORNER_LATERAL + rng() * (1 - CORNER_LATERAL)),
      depth: 0.3 + rng() * 0.5
    };
  }
  let lateral;
  if (ai.level === 'easy') lateral = gauss(rng) * p.lateralSpread * 0.5;
  else lateral = (rng() * 2 - 1) * p.lateralSpread;
  const depth = p.depth[0] + (p.depth[1] - p.depth[0]) * rng();
  return { lateral: clamp(lateral, -1, 1), depth: clamp(depth, -1, 1) };
}

function chooseShot(ai, ball, contactY) {
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
  return shot === 'block' ? null : shot;
}

// O jogo usa o stick direito (aimX/aimY) só se |aim| > 0.3; senão usa o stick esquerdo
// (movimento). Para que a mira escolhida valha sempre, completa a magnitude com profundidade.
const AIM_MIN_MAG = 0.32;
function aimOutput(lateral, depth, side) {
  const lat = clamp(lateral, -1, 1);
  let dep = clamp(depth, -1, 1);
  if (lat * lat + dep * dep < AIM_MIN_MAG * AIM_MIN_MAG) {
    const need = Math.sqrt(AIM_MIN_MAG * AIM_MIN_MAG - lat * lat);
    dep = dep < -0.05 ? -need : need;
  }
  return { aimX: lat, aimY: clamp(dep * -side, -1, 1) };
}

function newPlan(ai, ball, paddle, side, opponent) {
  const p = ai.params;
  const rng = ai.rng;
  const hit = findIntercept(ai, ball, paddle, side);
  if (!hit) return { letGo: true };
  let errX = gauss(rng) * p.errSigma;
  let errZ = gauss(rng) * p.errSigma;
  if (rng() < p.bigMissChance) {
    const a = rng() * Math.PI * 2;
    errX += Math.cos(a) * p.bigMiss;
    errZ += Math.sin(a) * p.bigMiss;
  }
  const shot = chooseShot(ai, ball, hit.y);
  const aim = chooseAim(ai, hit.z, opponent);
  const o = aimOutput(aim.lateral, aim.depth, side);
  return {
    letGo: false, x: hit.x, y: hit.y, z: hit.z, t: hit.t,
    errX: errX, errZ: errZ, shot: shot, aimX: o.aimX, aimY: o.aimY
  };
}

// Controlador proporcional no plano da mesa; converte para coordenadas de tela.
function steer(out, paddle, target, speedFrac) {
  const maxV = PADDLE_MAX_SPEED * speedFrac;
  let vx = (target.x - paddle.x) * KP;
  let vz = (target.z - num(paddle.z)) * KP;
  const sp = Math.sqrt(vx * vx + vz * vz);
  if (sp > maxV) { vx *= maxV / sp; vz *= maxV / sp; }
  out.moveY = clamp(vx / PADDLE_MAX_SPEED, -1, 1); // tela cima = mundo +x
  out.moveX = clamp(vz / PADDLE_MAX_SPEED, -1, 1); // tela direita = mundo +z
}

function resetBall(ai) {
  ai.incoming = false;
  ai.plan = null;
  ai.ownBounced = false;
  ai.pressedThisBall = false;
  ai.reactTimer = 0;
  ai.replanTimer = 0;
}

// state: { ball, paddle, side, phase, isServer, ballInPlay, dt, opponent? }
// `opponent` (opcional) = raquete do adversário; o nível hard usa para mirar longe dele.
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
    ai.serveType = null;
    ai.serveTarget = null;
    ai.serveAim = null;
    resetBall(ai);
  }

  // --- Saque ---
  if (phase === 'serve') {
    if (state.isServer) {
      if (!ai.serveTarget) {
        ai.serveTarget = {
          x: side * (TABLE_HALF + 0.12 + rng() * 0.1),
          z: (rng() * 2 - 1) * 0.45
        };
        ai.serveWait = p.serveWait + rng() * 0.35;
        ai.serveType = p.serveTypes[Math.floor(rng() * p.serveTypes.length)];
        const lat = (rng() * 2 - 1) * p.serveLateral;
        const dep = rng() * 0.6 - 0.2;
        ai.serveAim = aimOutput(lat, dep, side);
      }
      steer(out, paddle, ai.serveTarget, 0.6);
      ai.serveTimer += dt;
      out.shot = ai.serveType;
      out.aimX = ai.serveAim.aimX;
      out.aimY = ai.serveAim.aimY;
      if (ai.serveTimer >= ai.serveWait) {
        out.shotPressed = ai.serveType;
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

  // Detecta o quique no próprio lado (vy troca de sinal perto do tampo, sobre a mesa).
  const bz = num(ball.z);
  if (!ai.ownBounced && ai.prevVy < 0 && ball.vy > 0 && ball.y < 0.08 &&
      ball.x * side > 0 && ball.x * side <= TABLE_HALF + 0.02 && Math.abs(bz) <= TABLE_W_HALF + 0.02) {
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
    const np = newPlan(ai, ball, paddle, side, state.opponent);
    if (prev && !prev.letGo && !np.letGo) {
      // Mantém o erro, o golpe e a mira sorteados para esta bola.
      np.errX = prev.errX; np.errZ = prev.errZ;
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

  const target = { x: plan.x + plan.errX, z: plan.z + plan.errZ };
  steer(out, paddle, target, p.speed);
  out.shot = plan.shot;
  out.aimX = plan.aimX;
  out.aimY = plan.aimY;

  const dx = ball.x - paddle.x;
  const dy = ball.y - num(paddle.y);
  const dz = bz - num(paddle.z);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!ai.pressedThisBall && plan.shot && (dist < HIT_RADIUS * 2.5 || canHit(ball, paddle, side))) {
    out.shotPressed = plan.shot;
    ai.pressedThisBall = true;
  }
  return out;
}
