# 🏓 Ping Pong TV

Tênis de mesa para jogar **na TV Samsung com controles de Xbox**: 2 jogadores locais
na mesma tela, ou 1 jogador contra a CPU (Fácil / Normal / Difícil).
Segue as **regras oficiais da ITTF** (singles).

## Como jogar na TV Samsung

### 1. Conecte os controles de Xbox na TV
Na TV: **Configurações → Conexão → Lista de dispositivos Bluetooth** (ou *Gerenciador de
dispositivos externos → Gerenciador de dispositivos de entrada*).
No controle: segure o botão **Xbox** para ligar e depois segure o botão de **pareamento**
(em cima, ao lado do USB) até o logo piscar rápido. Selecione "Xbox Wireless Controller" na TV.
Repita para o 2º controle. O **primeiro controle conectado é o Jogador 1** (raquete vermelha).

### 2. Abra o jogo — escolha uma opção

**Opção A — Navegador da TV (mais simples)**
1. No GitHub do repositório: *Settings → Pages → Source: GitHub Actions*, e faça merge na `main`.
   O workflow `.github/workflows/pages.yml` roda os testes e publica automaticamente.
2. Na TV, abra o app **Internet** e acesse `https://<seu-usuario>.github.io/Jogo_Ping_Pong/`.
3. Aperte qualquer botão do controle para ele ser reconhecido.

> Nem todos os modelos/versões do navegador da Samsung repassam o controle para páginas web.
> Se o controle não responder no navegador, use a opção B (ou C).

**Opção B — Instalar como app Tizen (recomendado para controle garantido)**
1. Instale o **Tizen Studio** no PC com a extensão *TV Extensions* e um certificado Samsung.
2. Ative o **Modo Desenvolvedor** na TV (app *Apps* → digite `12345` no controle remoto →
   ligue o modo e informe o IP do PC) e reinicie a TV.
3. Rode `npm install && npm run build`. A pasta `dist/` já contém `config.xml` e o ícone.
4. No Tizen Studio: *File → Import → Tizen → Tizen Project* apontando para `dist/`, conecte a TV
   pelo *Device Manager* (IP da TV) e *Run As → Tizen Web Application*.

**Opção C — Console Xbox ou PC ligado na TV**
O navegador Microsoft Edge do Xbox (ou Chrome/Edge num PC via HDMI) suporta os controles
diretamente: abra o mesmo endereço da opção A.

## Controles

| Ação | Controle Xbox | Teclado J1 | Teclado J2 |
|---|---|---|---|
| Mover raquete | Analógico esquerdo / D-pad | W A S D | Setas |
| Mirar (curta ↔ longa, alta) | Analógico direito | — | — |
| Drive (golpe normal) / sacar | **A** | F | K |
| Topspin (rápido, efeito para frente) | **X** | G | L |
| Corte / chop (lento, efeito para trás) | **B** | H | J |
| Smash (mortal em bola alta) | **RT** | T | I |
| Bloqueio (seguro) | sem botão | — | — |
| Pausa | **Menu** (☰) | Esc | P |

Segure o botão do golpe **enquanto a bola chega** na raquete. O contato é automático:
posicione a raquete onde a bola vai estar depois de quicar no seu lado.
Dica: bola alta → smash; bola baixa e rápida → bloqueio ou topspin; para variar, corte.

## Regras oficiais aplicadas (ITTF)
- Game de **11 pontos**, com **2 de vantagem**; partida em **melhor de 3, 5 ou 7** games.
- Saque troca a cada **2 pontos**; a partir de **10-10**, a cada ponto. Quem saca primeiro alterna a cada game.
- O saque deve quicar **primeiro no seu lado** e depois no do adversário.
  Tocou na rede e caiu certo = **let** (repete o saque).
- Na troca de bola, a bola deve quicar no lado do adversário (pode tocar a rede).
- Dois quiques, bola fora, quique no próprio lado, rebater duas vezes = ponto do adversário.
- Rebater antes de quicar com a bola sobre a mesa = **obstrução** (ponto do adversário).
- Troca de lados após cada game e aos 5 pontos no game decisivo.

## Desenvolvimento

```bash
npm install
npm test            # testes unitários (regras, física, golpes, controles, IA, jogo)
npm run test:e2e    # testes no navegador com controles de Xbox simulados
npm run build       # gera dist/ (bundle compatível com TVs antigas, Chromium 56+)
npm run serve       # http://localhost:8080  (?demo=1 = CPU × CPU)
```

Arquitetura e contratos entre módulos: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
O jogo foi construído por uma equipe de agentes (Regras, Física, Controles/IA, Jogo/Visual e QA)
sob um agente coordenador.
