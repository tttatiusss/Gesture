# Gestura Chess Control

Extensão de Chrome que usa a webcam (MediaPipe HandLandmarker, reaproveitado
do projeto Gestura) para controlar as peças no chess.com só com a mão:
**pinça = clicar e segurar a peça, soltar a pinça = largar a peça na casa.**

Não usa o mouse do sistema — ela simula os mesmos eventos de mouse/pointer
que o navegador gera quando você clica de verdade, na posição onde sua
pinça está mapeada na tela (por isso funciona só dentro da aba do Chrome
onde está ativa).

## Instalar

1. Abra `chrome://extensions`
2. Ative o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactação** (Load unpacked)
4. Selecione a pasta `extension/` (esta pasta)
5. Abra `https://www.chess.com/play/online` — um painel preto vai aparecer
   no canto superior direito da página

## Usar

1. No painel, clique em **"iniciar controle por gestos"**
2. Autorize o acesso à câmera quando o Chrome pedir (só precisa na primeira vez)
3. Um ponto verde ("cursor virtual") vai seguir sua mão na tela
4. Feche a pinça (polegar + indicador) sobre uma peça para "segurar" e
   arraste; abra a pinça sobre a casa de destino para soltar

> Dica: você não precisa esticar o braço até a borda da câmera para chegar
> à borda da tela — a área útil já é recortada (constantes `MARGIN_X` /
> `MARGIN_Y` em `camera.js`) para reduzir o esforço.

## Estrutura

```
extension/
├── manifest.json     # config da extensão (MV3)
├── content.js         # injetado no chess.com: painel + disparo de eventos de mouse
├── overlay.css        # estilo do painel e do cursor virtual
├── camera.html/js     # roda em iframe isolado (chrome-extension://): webcam + MediaPipe
└── lib/               # MediaPipe tasks-vision empacotado localmente (sem depender de CDN)
```

O modelo de detecção de mãos (~10MB) ainda é baixado do Google na primeira
vez (`storage.googleapis.com`), mas o runtime WASM está embutido localmente
para evitar problemas de política de "remote code" em extensões.

## Limitações conhecidas / possíveis ajustes

- **Sensibilidade da pinça**: `PINCH_THRESHOLD` em `camera.js` (padrão
  `0.055`, igual ao Gestura original). Se estiver pinçando sem querer,
  diminua; se estiver difícil de fechar a pinça, aumente.
- **Uma mão por vez**: pensado para controlar 1 peça de cada vez, como o
  mouse. Dá pra estender para 2 mãos se quiser jogar com um amigo (ideia
  do README original do Gestura).
- **Como o chess.com lida com clique vs. arraste**: o script dispara
  `pointerdown/mousedown` → `pointermove/mousemove` (enquanto a pinça está
  fechada) → `pointerup/mouseup/click` (ao soltar). Isso cobre tanto
  "clique na peça, clique no destino" quanto "arrastar", que são os dois
  modos de mover peça que sites de xadrez costumam suportar. Se algum
  movimento não for reconhecido, o ponto de ajuste é a função `fireAt` em
  `content.js`.
- **Detecção de bots**: como isso é literalmente sua mão controlando o
  cursor em tempo real (não um script jogando sozinho), não é um "engine
  assist" — é só um método alternativo de input, parecido com um leitor de
  tela ou controle assistivo. Ainda assim, vale checar os termos de uso do
  chess.com se for usar em partidas ranqueadas/competitivas.
- **Calibração**: hoje é um mapeamento linear simples (câmera → janela).
  Se quiser mais precisão, dá pra adicionar uma etapa de calibração de 2
  pontos (pinçar no canto superior-esquerdo e inferior-direito da área
  que quer usar) — fica como próxima evolução.
