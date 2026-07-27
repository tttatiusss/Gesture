import { FilesetResolver, HandLandmarker } from "./lib/vision_bundle.mjs";

// ----- Constantes (portadas do Gestura original) -----
const LM = { WRIST: 0, THUMB_TIP: 4, INDEX_TIP: 8 };
const PINCH_THRESHOLD = 0.055;
const LOAD_TIMEOUT_MS = 20000;

// Trim: encolhe a área útil da câmera para não precisar esticar o braço
// até as bordas do quadro para alcançar as bordas da tela.
const MARGIN_X = 0.18;
const MARGIN_Y = 0.12;

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const msg = document.getElementById("msg");

let handLandmarker = null;
let running = false;
let lastVideoTime = -1;

function dist2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isPinching(landmarks) {
  return dist2D(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) < PINCH_THRESHOLD;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Mapeia coordenada normalizada da webcam (0..1, ja espelhada) para
// coordenada normalizada de "tela util" (0..1) aplicando o trim de margem.
function applyMargin(nx, ny) {
  const x = clamp01((nx - MARGIN_X) / (1 - 2 * MARGIN_X));
  const y = clamp01((ny - MARGIN_Y) / (1 - 2 * MARGIN_Y));
  return { x, y };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function initHandLandmarker() {
  const vision = await withTimeout(
    FilesetResolver.forVisionTasks("./lib/wasm"),
    LOAD_TIMEOUT_MS,
    "Tempo limite ao carregar runtime MediaPipe (WASM local)."
  );

  try {
    return await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "video",
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      }),
      LOAD_TIMEOUT_MS,
      "Tempo limite ao baixar modelo HandLandmarker (GPU)."
    );
  } catch (gpuErr) {
    console.warn("[Gestura] GPU falhou, tentando CPU…", gpuErr);
    return await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "CPU",
      },
      runningMode: "video",
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
  }
}

function drawSkeleton(lm) {
  ctx.save();
  ctx.fillStyle = "#3fce6b";
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function sendToParent(payload) {
  window.parent.postMessage({ source: "gestura-cam", ...payload }, "*");
}

async function loop() {
  if (!running) return;

  if (video.currentTime !== lastVideoTime && handLandmarker) {
    lastVideoTime = video.currentTime;
    const result = handLandmarker.detectForVideo(video, performance.now());

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const lm = result.landmarks[0];
      drawSkeleton(lm);

      const pinching = isPinching(lm);
      // video ja e espelhado via CSS (scaleX(-1)); landmarks vem "crus" da
      // camera (nao espelhados), entao invertemos X para casar com o visual.
      const rawX = 1 - (lm[LM.THUMB_TIP].x + lm[LM.INDEX_TIP].x) / 2;
      const rawY = (lm[LM.THUMB_TIP].y + lm[LM.INDEX_TIP].y) / 2;
      const mapped = applyMargin(rawX, rawY);

      msg.textContent = pinching ? "pinca ativa" : "mao detectada";
      sendToParent({ type: "cursor", x: mapped.x, y: mapped.y, pinching, present: true });
    } else {
      msg.textContent = "nenhuma mao detectada";
      sendToParent({ type: "cursor", present: false });
    }
  }

  requestAnimationFrame(loop);
}

async function start() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    msg.textContent = "carregando modelo de maos…";
    handLandmarker = await initHandLandmarker();

    running = true;
    msg.textContent = "pronto";
    sendToParent({ type: "ready" });
    requestAnimationFrame(loop);
  } catch (err) {
    console.error("[Gestura] erro ao iniciar", err);
    msg.textContent = "erro: " + err.message;
    sendToParent({ type: "error", message: err.message });
  }
}

window.addEventListener("message", (ev) => {
  if (!ev.data) return;
  if (ev.data.cmd === "stop") {
    running = false;
    if (video.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
    }
    msg.textContent = "parado";
  }
  if (ev.data.cmd === "start" && !running) {
    start();
  }
});

start();
