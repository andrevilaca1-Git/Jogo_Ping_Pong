// Constantes compartilhadas do mundo do jogo (unidades: metros, segundos).
// Visão lateral: eixo x ao longo da mesa, eixo y = altura acima do tampo da mesa.
export const TABLE_HALF = 1.37;      // mesa vai de x=-1.37 a x=+1.37 (2,74 m oficial)
export const TABLE_W_HALF = 0.7625;  // largura: z de -0.7625 a +0.7625 (1,525 m oficial)
export const NET_W_HALF = 0.915;     // rede se estende 15,25 cm além das laterais
export const NET_H = 0.1525;         // altura oficial da rede (15,25 cm)
export const BALL_R = 0.02;          // raio da bola (40 mm)
export const GRAVITY = 9.81;
export const TABLE_RESTITUTION = 0.88;
export const FLOOR_Y = -0.76;        // chão (mesa tem 76 cm de altura)
export const K_MAGNUS = 0.004;       // ay -= K_MAGNUS * spin * |vx|  (spin>0 = topspin, mergulha)
export const AIR_DRAG = 0.12;        // v *= (1 - AIR_DRAG*dt)
export const SPIN_DECAY = 0.3;       // spin *= (1 - SPIN_DECAY*dt)
export const PHYSICS_DT = 1 / 240;

export const PADDLE_R = 0.085;       // raio visual da raquete
export const HIT_RADIUS = 0.16;      // distância 3D bola-centro da raquete para contato (generoso p/ latência de TV)
export const PADDLE_MAX_SPEED = 4.5; // m/s
// Zona de movimento da raquete do lado ESQUERDO (side=-1). Lado direito é espelhado (x * -1).
export const PADDLE_ZONE = { xMin: -2.5, xMax: -0.9, yMin: -0.35, yMax: 1.15, zMin: -1.35, zMax: 1.35 };

export const SIDE_LEFT = -1;
export const SIDE_RIGHT = 1;

export const SHOT_TYPES = ['block', 'drive', 'topspin', 'chop', 'smash'];
