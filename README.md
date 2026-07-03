# Gestura

> Captura por gestos — quebra-cabeça fotografico controlado inteiramente pelas maos.

O Gestura usa a webcam e o modelo [MediaPipe HandLandmarker](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) para detectar suas maos em tempo real. Voce enquadra uma foto com os dedos, escolhe um filtro artistico, monta o puzzle arrastando as pecas com pinca e salva o resultado numa tira de fotos estilo cabine.

---

## Tecnologias

- **HTML5 / CSS3 / JavaScript** puro — sem frameworks, sem bundler
- **MediaPipe HandLandmarker** via CDN (`@mediapipe/tasks-vision@0.10.14`) — deteccao de 21 landmarks por mao com GPU/CPU
- **Canvas API** — renderizacao, filtros pixel-a-pixel e animacoes
- **WebRTC** (`getUserMedia`) — acesso a webcam

## Estrutura

```
Gesture/
├── index.html        # HTML: overlays, HUD, galeria lateral
├── app.js            # Logica completa: gestos, filtros, puzzle, render loop
├── css/
│   └── styles.css    # Estilos, animacoes e variaveis CSS
└── README.md
```

## Como Rodar

O app usa ES Modules com imports de CDN, entao precisa de um servidor local (nao funciona com `file://`).

```bash
# Python 3
python3 -m http.server 8080

# Node.js
npx serve .

# PHP
php -S localhost:8080
```

Acesse `http://localhost:8080` e permita o acesso a camera.

> **Requisitos:** Chrome, Edge ou Firefox moderno com WebGL habilitado. O modelo MediaPipe (~10MB) e baixado na primeira carga.

---

## Fluxo do Jogo

```
1. RASTREAMENTO
   Mostre as duas maos. Os dedos indicadores definem o quadro de captura.
   Faca polegar para cima para trocar o filtro.

2. CAPTURA
   Pinca com as duas maos ao mesmo tempo → contagem de 3s → foto capturada.

3. PUZZLE
   A foto vira 9 pecas em formato de quebra-cabeca (com encaixes) embaralhadas.
   Arraste com pinca para montar. Peca perto do lugar faz snap automatico.

4. VITORIA
   Todas as 9 pecas no lugar → quadro verde "COMPLETO!".

5. RECOMPENSA
   Feche o punho → efeito shatter → foto salva na tira lateral.

6. TIRA DE FOTOS
   Ate 3 fotos por tira → baixe como PNG vertical ou reinicie.
```

---

## Gestos

| Gesto | Acao |
|---|---|
| **Pinca** (polegar + indicador) | Arrastar pecas do puzzle |
| **Pinca dupla** (duas maos) | Iniciar captura da foto |
| **Punho fechado** | Salvar foto (puzzle completo) ou reiniciar puzzle |
| **10 dedos levantados** (duas maos abertas) | **Pausar** o jogo (overlay escuro) |
| **5 dedos levantados** (uma mao aberta) | **Despausar** o jogo |
| **Polegar para cima** (thumbs up) | **Trocar filtro** (segurar por ~15 frames) |

### Detalhes dos gestos

- **Pausar:** levante as duas maos com todos os dedos abertos e segure por ~18 frames. Um overlay escurece a tela e congela todo o processamento.
- **Despausar:** enquanto pausado, levante apenas uma mao aberta por ~18 frames para retomar.
- **Trocar filtro:** faca polegar para cima (mao fechada com polegar estendido) e segure por ~15 frames. Um badge na parte inferior mostra o filtro selecionado. Apos trocar, ha um cooldown de ~20 frames antes de poder trocar novamente.

---

## Filtros

5 filtros artisticos aplicados pixel-a-pixel no momento da captura:

| Filtro | Efeito |
|---|---|
| **P&B** | Preto e branco com alto contraste e ruido granulado (estilo fotocabine) |
| **Sepia** | Tons quentes de marrom/dourado (foto envelhecida) |
| **Alto Contraste** | Contraste elevado com fator 1.8x (cores intensas) |
| **Vinheta** | Escurecimento radial nas bordas com foco central (camera vintage) |
| **Retrô** | Tons amarelados com desvio de cor e ruido (estetica anos 70) |

O filtro e aplicado tanto na pre-visualizacao ao vivo (dentro do quadro de captura) quanto na foto final salva na tira.

---

## Interface

### HUD Superior
- Marca "Gestura" com subtitulo
- Indicador de status com ponto colorido:
  - Verde = maos detectadas
  - Amarelo = pinca ativa, pronto para capturar
  - Vermelho = sem maos detectadas

### Badge de Progresso
- Aparece durante o puzzle: `X / 9 pecas colocadas`
- Fica verde quando o puzzle e completado

### Badge de Filtro
- Aparece na parte inferior ao trocar filtro
- Mostra o nome do filtro e desaparece apos 2 segundos

### Overlay de Pausa
- Tela escurecida com icone de pausa e instrucao para despausar

### Galeria Lateral (Tira)
- Miniaturas numeradas das fotos salvas
- Contador `X / 3`
- Botao **baixar tira** — gera PNG vertical com todas as fotos
- Botao **reiniciar tudo** — limpa a tira e reseta o puzzle

---

## Constantes Configuraveis

No topo de `app.js`:

| Constante | Padrao | Descricao |
|---|---|---|
| `PINCH_THRESHOLD` | `0.055` | Distancia para detectar pinca |
| `FRAME_PADDING` | `28px` | Margem do quadro de captura |
| `FREEZE_HOLD_MS` | `250ms` | Tempo segurando pinca dupla para iniciar captura |
| `COUNTDOWN_SECONDS` | `3` | Duracao da contagem regressiva |
| `FIST_HOLD_FRAMES` | `12` | Frames com punho fechado para salvar/resetar |
| `OPEN_HAND_HOLD_FRAMES` | `18` | Frames com maos abertas para pausar/despausar |
| `SNAP_DISTANCE_RATIO` | `0.45` | Proximidade para snap automatico de peca |
| `GRID` | `3` | Tamanho da grade (3 = 3x3 = 9 pecas) |
| `THUMBS_UP_HOLD_FRAMES` | `15` | Frames segurando polegar para trocar filtro |
| `THUMBS_UP_COOLDOWN_FRAMES` | `20` | Cooldown entre trocas de filtro |
| `STRIP_MAX_PHOTOS` | `3` | Maximo de fotos na tira |

---

## Detalhes Tecnicos

### Deteccao de Maos
- Ate 2 maos simultaneas com 21 landmarks cada
- Fallback automatico GPU → CPU se WebGL falhar
- Timeout de 20s no carregamento do modelo com botao de retry
- Grace period de 450ms quando as maos saem do quadro

### Filtros de Imagem
- Processamento pixel-a-pixel via `ImageData`
- Ruido gaussiano para textura analogica
- Aplicado em tempo real na pre-visualizacao e na captura final

### Puzzle
- 9 pecas em formato de quebra-cabeca com encaixes (tabs/blanks) gerados aleatoriamente
- Cada peca tem um canvas maior que a celula para acomodar os encaixes
- Snap automatico por proximidade (tolerancia de 45% do tamanho da celula)
- Deslocamento animado (cubic-bezier, 220ms) quando uma peca empurra outra
- Deteccao de vitoria por verificacao de todas as posicoes
- Outline verde nas pecas colocadas, outline claro nas demais

### Animacao Shatter
- 36 fragmentos (6x6) com fisica individual (velocidade, rotacao, gravidade)
- Fade out progressivo a partir de 45% da animacao
- Duracao total: 850ms
- Usada como transicao ao salvar a foto na tira

---

## Compatibilidade

| Navegador | Status |
|---|---|
| Chrome 90+ | Completo |
| Edge 90+ | Completo |
| Firefox 90+ | Completo |
| Safari 15+ | Parcial (pode cair para CPU) |

> Requer HTTPS ou `localhost` para acesso a camera.

---

## Ideias para Evoluir

- **Dificuldade progressiva** — grades maiores (4x4, 5x5), rotacao de pecas
- **Sons e feedback audio** — efeitos sonoros para pinca, snap, countdown e vitoria
- **Mais filtros** — glitch, neon, infravermelho, Polaroid
- **Modo multijogador** — dois puzzles lado a lado, cada jogador com uma mao
- **Timer e ranking** — cronometro por puzzle com salvamento em localStorage
- **PWA** — service worker para funcionar offline e ser instalavel
- **Compartilhamento** — botao para compartilhar a tira direto em redes sociais
- **FaceMesh** — deteccao de expressoes faciais para stickers automaticos na foto

---

## Licenca

MIT
