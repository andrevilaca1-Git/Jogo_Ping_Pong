# Arquitetura — Jogo de Ping Pong (Tênis de Mesa) para TV

Jogo HTML5 Canvas, visão lateral 2D, 2 jogadores locais com controles de Xbox
(Gamepad API) no navegador da Smart TV Samsung (ou app Tizen). Também tem modo 1P vs CPU.

## Restrições técnicas (TODOS os agentes)
- JavaScript puro, ES modules (`import`/`export`), **sem dependências de runtime**.
- Compatível com navegadores antigos de TV (Chromium 56+ após build com esbuild):
  **NÃO usar** optional chaining `?.`, nullish `??`, campos de classe, `#private`,
  top-level await, `Array.prototype.at`, `structuredClone`, `replaceAll`.
- Módulos de lógica (`rules`, `physics`, `shot`, `ai`, `input`, `game`) **não podem tocar o DOM
  no momento do import** e devem rodar no Node 22 para testes (`node --test tests/`).
- Testes: `node:test` + `node:assert/strict`, arquivos `tests/<modulo>.test.js`.
- Textos visíveis ao usuário em **português do Brasil**.
- Constantes compartilhadas em `src/constants.js` (não duplicar valores).

## Sistema de coordenadas
- Metros. `x` ao longo da mesa: mesa em `[-1.37, +1.37]`, rede em `x = 0`, altura `0.1525`.
- `y` = altura acima do tampo da mesa (tampo em y=0, chão em y=-0.76).
- Lado esquerdo `side = -1`, lado direito `side = +1`. Jogador 0 começa à esquerda.
- Bola: `{ x, y, vx, vy, spin }` (spin em rad/s; >0 topspin, <0 backspin).
- Raquete: `{ x, y, vx, vy }`.

## Módulos e donos

| Arquivo | Dono |
|---|---|
| `src/constants.js`, `docs/`, build, CI | Coordenador |
| `src/rules.js` | Agente Regras |
| `src/physics.js`, `src/shot.js` | Agente Física |
| `src/input.js`, `src/audio.js`, `src/ai.js` | Agente Controles/IA |
| `src/game.js`, `src/render.js`, `src/main.js`, `index.html`, `styles.css` | Agente Jogo/Visual |
| `tests/e2e/` | Agente QA |

---

### `src/rules.js` — regras oficiais ITTF (singles)
```js
export function createMatch({ bestOf = 5, pointsToWin = 11, firstServer = 0, changeEnds = true } = {})
// -> match: { bestOf, pointsToWin, changeEnds, score:[a,b], gamesWon:[a,b], gameNumber (1..),
//             history:[[a,b],...], firstServerOfGame, firstServerOfMatch, endsSwapped:false,
//             deciderSwapDone:false, over:false, winner:null }
export function awardPoint(match, player)
// muta match; retorna { gameOver, matchOver, gameWinner (0|1|null), swapEnds (bool: trocar lados agora) }
export function getServer(match)     // 0|1 — troca a cada 2 pontos; a partir de 10-10 troca a cada ponto.
export function getReceiver(match)
export function getSide(match, player) // -1|1 considerando endsSwapped
export function isDeuce(match)        // ambos >= pointsToWin-1
export function isGamePoint(match)    // retorna jogador (0|1) com game point, ou null
export function isMatchPoint(match)   // idem para match point
export function createRally(match)    // árbitro do ponto atual: { server, receiver, sides:{0:-1|1,1:-1|1}, phase, ... }
export function refereeEvent(rally, event)
// event: { type:'hit', player, x, y } | { type:'bounce', side, x } | { type:'net', clip } | { type:'floor', x }
// retorna null (bola em jogo) | { winner: 0|1, reason: CODE } | { let: true, reason: 'LET' }
export const REASON_TEXT // { CODE: 'texto pt-BR' }
```
Regras a aplicar:
- Game a 11, vence com 2 de vantagem. Match melhor de N (3/5/7).
- Saque alterna a cada 2 pontos; em 10-10 alterna a cada ponto. Quem saca primeiro alterna a cada game.
- Troca de lado após cada game, e no game decisivo quando alguém chega a 5 pontos.
- Saque: a bola deve quicar primeiro no lado do sacador, depois no lado do recebedor.
  Saque que toca a rede e depois cai certo no lado do recebedor = **let** (repete).
  Saque que toca a rede e falha = ponto do recebedor.
- Rally: após o golpe de P, a bola deve quicar no lado do oponente (pode tocar a rede).
  Quique no próprio lado após o próprio golpe, chão ou fora = ponto do oponente.
- Bola que quica duas vezes no mesmo lado sem ser devolvida = ponto de quem bateu por último.
- Voleio (rebater antes de quicar no seu lado): se a bola está sobre a mesa (`|x| <= 1.37`)
  = **obstrução**, ponto do oponente; se já passou da linha de fundo (`|x| > 1.37`)
  = a bola do oponente era fora, ponto de quem rebateu.
- Rebater fora de vez (bater duas vezes seguidas, bater no lado errado) = ponto do oponente.
- Códigos de motivo: `SERVE_FAULT, SERVE_NET, OUT, NET, OWN_SIDE, DOUBLE_BOUNCE, MISS, OBSTRUCTION, DOUBLE_HIT, LET`.

### `src/physics.js`
```js
export function createBall(x = 0, y = 0.3) // -> {x,y,vx:0,vy:0,spin:0}
export function stepBall(ball, dt)          // muta ball, integra gravidade, Magnus, arrasto, spin decay.
// Retorna array de eventos ocorridos neste passo:
//  { type:'bounce', side:-1|1, x }  quique no tampo (|x|<=TABLE_HALF, descendo)
//     no quique: vy = -vy*TABLE_RESTITUTION; vx += sign(vx)*spin*0.002 (topspin acelera, backspin freia);
//     spin *= 0.7
//  { type:'net', clip:bool }  cruzou x=0 abaixo de NET_H+BALL_R. clip=true se passou raspando
//     (perde ~40% de vx mas continua); senão rebate (vx = -vx*0.15).
//  { type:'floor', x }  atingiu FLOOR_Y (bola para: vx=vy=0, ball.dead=true)
export function predictBall(ball, maxTime, dt = PHYSICS_DT) // simula cópia; retorna [{t,x,y,events}] amostras
export function clampPaddle(paddle, side)   // limita raquete à zona do lado (PADDLE_ZONE espelhada)
export function movePaddle(paddle, side, moveX, moveY, dt) // mover com aceleração suave até PADDLE_MAX_SPEED
```

### `src/shot.js`
```js
export function canHit(ball, paddle, side) // dist<=HIT_RADIUS && ball.vx*side>0 (vindo em direção ao lado)
//   (para |vx| muito pequeno, aceitar também)
export function computeShot({ ball, paddle, side, shotType, aim = {x:0,y:0}, rng = Math.random })
// -> { vx, vy, spin, quality (0..1), type }
// Bola volta na direção -side. Mira alvo de quique no lado do oponente; profundidade por aim.x
// (empurrar em direção ao oponente = mais fundo). Qualidade cai com contato fora do centro e com
// spin/velocidade da bola recebida; baixa qualidade = dispersão (pode ir na rede ou fora).
// Tipos: 'block' (sem botão, suave, seguro), 'drive' (A), 'topspin' (X, spin +, rápido e seguro),
//        'chop' (B, backspin, lento e baixo), 'smash' (RT, muito rápido; arriscado se a bola está baixa).
export function computeServe({ side, paddle, shotType, aim = {x:0,y:0}, rng = Math.random })
// -> ball state {x,y,vx,vy,spin} saindo da raquete; trajetória quica primeiro no lado do sacador
// e depois no lado do recebedor (busca numérica usando stepBall). Pequena chance de erro/rede.
```

### `src/input.js`
```js
export const XBOX = { A:0, B:1, X:2, Y:3, LB:4, RB:5, LT:6, RT:7, VIEW:8, MENU:9, LS:10, RS:11,
                      UP:12, DOWN:13, LEFT:14, RIGHT:15 }
export function createInputManager({ getGamepads, keyTarget } = {})
// getGamepads padrão = () => navigator.getGamepads(); keyTarget padrão = window (se existir)
// manager.poll() -> { players: [PlayerInput, PlayerInput], menu: MenuInput }
// manager.rumble(playerIndex, strength 0..1, ms)
// manager.assignment -> índices de gamepad por jogador (1º controle conectado = Jogador 1)
// PlayerInput: { connected, source:'gamepad'|'keyboard'|'none',
//   moveX, moveY (-1..1, coordenadas de TELA: direita +, cima +, deadzone 0.18),
//   aimX, aimY (stick direito), shot: ShotType|null (botão segurado; prioridade smash>topspin>chop>drive),
//   shotPressed: ShotType|null (borda neste frame), pausePressed: bool }
// Mapeamento: LS mover; RS mira; A=drive, X=topspin, B=chop, RT(>0.5)=smash, MENU=pausa;
// D-pad também move. Teclado: J1 = WASD + F(drive) G(topspin) H(chop) T(smash) Esc(pausa);
// J2 = setas + K(drive) L(topspin) J(chop) I(smash) P(pausa).
// MenuInput: { up, down, left, right, confirm, back } (bordas) agregando todos os controles,
// teclado e controle remoto Samsung (setas, Enter=13, Voltar=10009, Escape, Backspace).
```

### `src/audio.js`
```js
export function createAudio() // -> { play(name, opts), setEnabled(bool), unlock() }
// nomes: 'hit' (opts.power 0..1), 'bounce', 'net', 'score', 'win', 'menu', 'serve'.
// WebAudio sintetizado; no-op seguro se AudioContext não existir (Node).
```

### `src/ai.js`
```js
export function createAI({ level = 'normal' } = {}) // 'easy' | 'normal' | 'hard'
export function updateAI(ai, { ball, paddle, side, phase, isServer, ballInPlay, dt })
// -> PlayerInput (mesmo formato do input.js). Usa predictBall para achar onde interceptar.
// phase: 'serve' | 'rally' | outros. Sacando: posiciona e aperta shotPressed após ~0.8s.
```

### `src/game.js` (lógica, sem DOM) / `src/render.js` / `src/main.js`
```js
export function createGame({ audio, rng } = {})
export function updateGame(game, dt, inputs /* [PlayerInput, PlayerInput] */, menuInput)
// game.screen: 'title' | 'playing' | 'paused' | 'matchOver'
// game.phase (em 'playing'): 'serve' | 'rally' | 'pointOver' | 'gameOver'
// game.mode: '1p' | '2p'; game.match (rules), game.ball, game.paddles[2], game.lastPoint
```
- Passo de física fixo (`PHYSICS_DT`) com acumulador. Contato raquete-bola via `canHit`
  com cooldown; eventos de física e `hit` vão para `refereeEvent`.
- `main.js`: cria canvas 1920x1080 escalado para a tela, loop `requestAnimationFrame`,
  expõe `window.__pingpong = { game, input }` para testes e2e.
