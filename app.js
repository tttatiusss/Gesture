import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17,
};

const PINCH_THRESHOLD = 0.055;
const FRAME_PADDING = 28;
const FREEZE_HOLD_MS = 250;
const COUNTDOWN_SECONDS = 5;
const FIST_HOLD_FRAMES = 12;
const SNAP_DISTANCE_RATIO = 0.45;
let GRID = 3;
const LOAD_TIMEOUT_MS = 20000;

// Difficulty levels
const DIFFICULTY_LEVELS = {
  1: { grid: 2, name: "Fácil", timeBonus: 30 },
  2: { grid: 3, name: "Médio", timeBonus: 60 },
  3: { grid: 4, name: "Difícil", timeBonus: 90 },
};
let currentLevel = 2;

// Scoring system
const BASE_TIME = 60;
const TIME_PENALTY_PER_PHASE = 5;
const SCORE_PER_PIECE = 100;
const COMBO_MULTIPLIER = 2;

const scoring = {
  active: false,
  startTime: 0,
  timeRemaining: BASE_TIME,
  score: 0,
  combo: 0,
  perfectSolve: true,
  phase: 1,
};

const rankings = {
  key: 'gesture_rankings',
  get() {
    try {
      return JSON.parse(localStorage.getItem(this.key)) || {};
    } catch {
      return {};
    }
  },
  save(filterName, score, time) {
    const data = this.get();
    if (!data[filterName]) data[filterName] = [];
    data[filterName].push({
      score,
      time,
      date: new Date().toISOString(),
      level: currentLevel,
    });
    data[filterName].sort((a, b) => b.score - a.score);
    data[filterName] = data[filterName].slice(0, 5);
    localStorage.setItem(this.key, JSON.stringify(data));
  },
  getTop(filterName) {
    const data = this.get();
    return data[filterName] || [];
  },
};

// Sound effects system
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const sounds = {
  playTone(freq, duration, type = 'sine', volume = 0.3) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  },
  clack() {
    this.playTone(800, 0.05, 'square', 0.15);
    setTimeout(() => this.playTone(600, 0.03, 'square', 0.1), 20);
  },
  snap() {
    this.playTone(1200, 0.08, 'sine', 0.25);
    setTimeout(() => this.playTone(1800, 0.05, 'sine', 0.15), 30);
  },
  countdownBeep() {
    this.playTone(880, 0.1, 'sine', 0.2);
  },
  fanfare() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      setTimeout(() => this.playTone(freq, 0.3, 'sine', 0.2), i * 100);
    });
  },
  combo() {
    this.playTone(660, 0.1, 'sine', 0.2);
    setTimeout(() => this.playTone(880, 0.15, 'sine', 0.25), 80);
    setTimeout(() => this.playTone(1100, 0.2, 'sine', 0.2), 160);
  },
  gameOver() {
    this.playTone(200, 0.5, 'sawtooth', 0.2);
    setTimeout(() => this.playTone(150, 0.5, 'sawtooth', 0.15), 300);
  },
};

const OPEN_HAND_HOLD_FRAMES = 18;

const PHOTO_FILTERS = [
  {
    name: "P&B",
    apply(imageData) {
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        let v = gray * PHOTOBOOTH_CONTRAST_ALPHA + PHOTOBOOTH_BRIGHTNESS_BETA;
        v += gaussianNoise(PHOTOBOOTH_NOISE_STD);
        v = Math.max(0, Math.min(255, v));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      return imageData;
    },
  },
  {
    name: "Sépia",
    apply(imageData) {
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        d[i]     = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189 + gaussianNoise(6));
        d[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168 + gaussianNoise(6));
        d[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131 + gaussianNoise(6));
      }
      return imageData;
    },
  },
  {
    name: "Alto Contraste",
    apply(imageData) {
      const d = imageData.data;
      const factor = 1.8;
      for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          let v = d[i + c] / 255;
          v = ((v - 0.5) * factor + 0.5) * 255;
          d[i + c] = Math.max(0, Math.min(255, v));
        }
      }
      return imageData;
    },
  },
  {
    name: "Vinheta",
    apply(imageData) {
      const d = imageData.data;
      const w = imageData.width, h = imageData.height;
      const cx = w / 2, cy = h / 2;
      const maxDist = Math.sqrt(cx * cx + cy * cy);
      for (let i = 0; i < d.length; i += 4) {
        const px = (i / 4) % w;
        const py = Math.floor((i / 4) / w);
        const dx = px - cx, dy = py - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
        const vignette = 1 - dist * dist * 0.85;
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        let v = (gray * 0.6 + (d[i] + d[i + 1] + d[i + 2]) / 3 * 0.4) * vignette;
        v += gaussianNoise(5);
        v = Math.max(0, Math.min(255, v));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      return imageData;
    },
  },
  {
    name: "Retrô",
    apply(imageData) {
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        d[i]     = Math.min(255, gray * 1.1 + 30 + gaussianNoise(10));
        d[i + 1] = Math.min(255, gray * 0.9 + 15 + gaussianNoise(10));
        d[i + 2] = Math.min(255, gray * 0.7 + 5  + gaussianNoise(10));
      }
      return imageData;
    },
  },
];

const PHOTOBOOTH_CONTRAST_ALPHA = 1.3;
const PHOTOBOOTH_BRIGHTNESS_BETA = 10;
const PHOTOBOOTH_NOISE_STD = 15;

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const videoEl = document.getElementById("webcam");
const canvas = document.getElementById("sceneCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const loadingOverlay = document.getElementById("loadingOverlay");
const loaderText = document.getElementById("loaderText");
const loaderRetry = document.getElementById("loaderRetry");
const errorBanner = document.getElementById("errorBanner");
const progressBadge = document.getElementById("progressBadge");
const progressText = document.getElementById("progressText");

const galleryStrip = document.getElementById("galleryStrip");
const galleryEmpty = document.getElementById("galleryEmpty");
const galleryCount = document.getElementById("galleryCount");
const downloadStripBtn = document.getElementById("downloadStripBtn");
const resetAllBtn = document.getElementById("resetAllBtn");
const stripCompleteMsg = document.getElementById("stripCompleteMsg");
const pauseOverlay = document.getElementById("pauseOverlay");
const filterBadge = document.getElementById("filterBadge");
const filterTextEl = document.getElementById("filterText");
const timerBar = document.getElementById("timerBar");
const rankingOverlay = document.getElementById("rankingOverlay");
const rankingFilterName = document.getElementById("rankingFilterName");
const rankingList = document.getElementById("rankingList");
const closeRanking = document.getElementById("closeRanking");

let appState = "tracking";
let isPaused = false;
let openHandHoldCounter = 0;
let isMultiplayer = false;

// Multiplayer state
const multiplayer = {
  player1: { pieces: [], boardBox: null, solved: false, score: 0 },
  player2: { pieces: [], boardBox: null, solved: false, score: 0 },
  sharedPhoto: null,
};

let currentFilterIndex = 0;

const THREE_FINGERS_HOLD_FRAMES = 15;
let threeFingersHoldCounter = 0;

const THUMBS_UP_HOLD_FRAMES = 15;
const THUMBS_UP_COOLDOWN_FRAMES = 20;
let thumbsUpHoldCounter = 0;
let thumbsUpCooldown = 0;

const puzzle = {
  boardBox: null,
  pieces: [],
  solved: false,
  tileW: 0,
  tileH: 0,
};

const SHATTER_COLS = 6;
const SHATTER_ROWS = 6;
const SHATTER_DURATION_MS = 850;
const shatter = {
  active: false,
  startedAt: 0,
  fragments: [],
  pendingCanvas: null,
};

// Particle system
const particles = {
  active: [],
  fingerTrail: [],
  
  addGoldenParticles(x, y, count = 20) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 100;
      this.active.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 100,
        life: 1,
        decay: 0.02 + Math.random() * 0.02,
        size: 2 + Math.random() * 3,
        color: `hsl(${45 + Math.random() * 15}, 100%, ${50 + Math.random() * 30}%)`,
        type: 'golden',
      });
    }
  },
  
  addConfetti(x, y, count = 50) {
    const colors = ['#f5c518', '#e0533d', '#5fae6e', '#4a90d9', '#ff6b9d'];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 200;
      this.active.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 150,
        life: 1,
        decay: 0.01 + Math.random() * 0.01,
        size: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        type: 'confetti',
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 10,
      });
    }
  },
  
  addFingerTrail(x, y) {
    this.fingerTrail.push({ x, y, life: 1, decay: 0.08 });
    if (this.fingerTrail.length > 20) this.fingerTrail.shift();
  },
  
  update(dt) {
    // Update particles
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 200 * dt; // gravity
      p.life -= p.decay;
      if (p.type === 'confetti') {
        p.rotation += p.rotationSpeed * dt;
      }
      if (p.life <= 0) this.active.splice(i, 1);
    }
    
    // Update finger trail
    for (let i = this.fingerTrail.length - 1; i >= 0; i--) {
      this.fingerTrail[i].life -= this.fingerTrail[i].decay;
      if (this.fingerTrail[i].life <= 0) this.fingerTrail.splice(i, 1);
    }
  },
  
  draw() {
    // Draw finger trail
    if (this.fingerTrail.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < this.fingerTrail.length; i++) {
        const prev = this.fingerTrail[i - 1];
        const curr = this.fingerTrail[i];
        const alpha = curr.life * 0.5;
        ctx.strokeStyle = `rgba(245, 197, 24, ${alpha})`;
        ctx.lineWidth = 4 * curr.life;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(curr.x, curr.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    
    // Draw particles
    for (const p of this.active) {
      ctx.save();
      ctx.globalAlpha = p.life;
      if (p.type === 'confetti') {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  },
  
  clear() {
    this.active = [];
    this.fingerTrail = [];
  },
};

// Screen shake effect
const screenShake = {
  active: false,
  intensity: 0,
  duration: 0,
  startedAt: 0,
  
  start(intensity = 10, duration = 300) {
    this.active = true;
    this.intensity = intensity;
    this.duration = duration;
    this.startedAt = performance.now();
  },
  
  update() {
    if (!this.active) return { x: 0, y: 0 };
    const elapsed = performance.now() - this.startedAt;
    if (elapsed >= this.duration) {
      this.active = false;
      return { x: 0, y: 0 };
    }
    const progress = elapsed / this.duration;
    const currentIntensity = this.intensity * (1 - progress);
    return {
      x: (Math.random() - 0.5) * currentIntensity,
      y: (Math.random() - 0.5) * currentIntensity,
    };
  },
};

// Flash effect
const flashEffect = {
  active: false,
  alpha: 0,
  startedAt: 0,
  duration: 200,
  
  start() {
    this.active = true;
    this.alpha = 1;
    this.startedAt = performance.now();
  },
  
  update() {
    if (!this.active) return;
    const elapsed = performance.now() - this.startedAt;
    if (elapsed >= this.duration) {
      this.active = false;
      this.alpha = 0;
      return;
    }
    this.alpha = 1 - elapsed / this.duration;
  },
  
  draw() {
    if (!this.active || this.alpha <= 0) return;
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${this.alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  },
};

const STRIP_MAX_PHOTOS = 3;
const galleryEntries = [];

function addToGallery(snapshotCanvas) {
  if (galleryEntries.length >= STRIP_MAX_PHOTOS) return;

  galleryEntries.push({ canvas: snapshotCanvas, time: Date.now() });
  renderGalleryThumb(snapshotCanvas, galleryEntries.length);
  galleryCount.textContent = `${galleryEntries.length} / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) galleryEmpty.style.display = "none";

  if (galleryEntries.length >= STRIP_MAX_PHOTOS) {
    showStripComplete();
  }
}

function isStripFull() {
  return galleryEntries.length >= STRIP_MAX_PHOTOS;
}

function showStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.add("visible");
  updateStripDownloadAvailability();
}

function hideStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.remove("visible");
}

function updateStripDownloadAvailability() {
  if (!downloadStripBtn) return;
  downloadStripBtn.disabled = galleryEntries.length === 0;
}

const STRIP_FILE_BORDER = 24;
const STRIP_FILE_GAP = 16;
const STRIP_FILE_BG = "#ffffff";

function downloadPhotoStrip() {
  if (galleryEntries.length === 0) return;

  const entries = galleryEntries;
  const targetW = entries[0].canvas.width;
  const scaledHeights = entries.map((entry) =>
    Math.round(entry.canvas.height * (targetW / entry.canvas.width))
  );

  const totalH =
    STRIP_FILE_BORDER * 2 +
    scaledHeights.reduce((sum, h) => sum + h, 0) +
    STRIP_FILE_GAP * (entries.length - 1);
  const totalW = targetW + STRIP_FILE_BORDER * 2;

  const stripCanvas = document.createElement("canvas");
  stripCanvas.width = totalW;
  stripCanvas.height = totalH;
  const stripCtx = stripCanvas.getContext("2d");

  stripCtx.fillStyle = STRIP_FILE_BG;
  stripCtx.fillRect(0, 0, totalW, totalH);

  let cursorY = STRIP_FILE_BORDER;
  entries.forEach((entry, i) => {
    const h = scaledHeights[i];
    stripCtx.drawImage(entry.canvas, STRIP_FILE_BORDER, cursorY, targetW, h);
    cursorY += h + STRIP_FILE_GAP;
  });

  stripCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `puzzlecam_tira_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}

function resetEverything() {
  galleryEntries.length = 0;
  galleryStrip.innerHTML = "";
  galleryCount.textContent = `0 / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) {
    galleryEmpty.style.display = "block";
    galleryStrip.appendChild(galleryEmpty);
  }
  hideStripComplete();
  updateStripDownloadAvailability();
  resetPuzzleOnly();
  statusText.textContent = "tudo reiniciado";
}

function renderGalleryThumb(snapshotCanvas, index) {
  const print = document.createElement("div");
  print.className = "print";

  const thumbCanvas = document.createElement("canvas");
  const THUMB_W = 220;
  const scale = THUMB_W / snapshotCanvas.width;
  thumbCanvas.width = THUMB_W;
  thumbCanvas.height = Math.round(snapshotCanvas.height * scale);
  thumbCanvas.getContext("2d").drawImage(snapshotCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);

  const label = document.createElement("div");
  label.className = "print-label";
  label.textContent = `#${String(index).padStart(2, "0")}`;

  print.appendChild(thumbCanvas);
  print.appendChild(label);
  galleryStrip.insertBefore(print, galleryStrip.firstChild);
}

function resetPuzzleOnly() {
  puzzle.boardBox = null;
  puzzle.pieces = [];
  puzzle.solved = false;
  puzzle.fullPhotoboothCanvas = null;
  appState = "tracking";
  countdown.active = false;
  drag.activeHand = null;
  drag.piece = null;
  shatter.active = false;
  shatter.fragments = [];
  shatter.pendingCanvas = null;
  fistHoldCounter = 0;
  lastSeenFrame.box = null;
  lastSeenFrame.at = 0;
  openHandHoldCounter = 0;
  threeFingersHoldCounter = 0;
  thumbsUpHoldCounter = 0;
  thumbsUpCooldown = 0;
  
  // Reset new systems
  scoring.active = false;
  scoring.score = 0;
  scoring.combo = 0;
  scoring.perfectSolve = true;
  scoring.phase = 1;
  scoring.timeRemaining = BASE_TIME - (scoring.phase - 1) * TIME_PENALTY_PER_PHASE;
  particles.clear();
  screenShake.active = false;
  flashEffect.active = false;
  
  // Reset multiplayer state
  multiplayer.player1.pieces = [];
  multiplayer.player1.boardBox = null;
  multiplayer.player1.solved = false;
  multiplayer.player1.score = 0;
  multiplayer.player2.pieces = [];
  multiplayer.player2.boardBox = null;
  multiplayer.player2.solved = false;
  multiplayer.player2.score = 0;
  multiplayer.sharedPhoto = null;
  
  updateProgressBadge();
}

function togglePause() {
  isPaused = !isPaused;
  if (isPaused) {
    pauseOverlay.classList.add("visible");
    statusText.textContent = "pausado";
  } else {
    pauseOverlay.classList.remove("visible");
    statusText.textContent = "pronto";
  }
}

function showFilterBadge() {
  filterTextEl.textContent = `filtro: ${PHOTO_FILTERS[currentFilterIndex].name}`;
  filterBadge.classList.add("visible");
}

function updateTimerBar() {
  if (!scoring.active) {
    timerBar.style.width = '100%';
    timerBar.classList.remove('warning', 'critical');
    return;
  }
  
  const maxTime = BASE_TIME + DIFFICULTY_LEVELS[currentLevel].timeBonus - (scoring.phase - 1) * TIME_PENALTY_PER_PHASE;
  const percentage = (scoring.timeRemaining / maxTime) * 100;
  timerBar.style.width = `${Math.max(0, percentage)}%`;
  
  timerBar.classList.remove('warning', 'critical');
  if (percentage <= 20) {
    timerBar.classList.add('critical');
  } else if (percentage <= 40) {
    timerBar.classList.add('warning');
  }
}

function setLevel(level) {
  currentLevel = level;
  GRID = DIFFICULTY_LEVELS[level].grid;
  
  // Update UI
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.level) === level);
  });
  
  statusText.textContent = `Nível: ${DIFFICULTY_LEVELS[level].name}`;
  
  // Reset puzzle if active
  if (appState === 'puzzle' || appState === 'countdown') {
    resetPuzzleOnly();
  }
}

function showRanking() {
  const filterName = PHOTO_FILTERS[currentFilterIndex].name;
  const topScores = rankings.getTop(filterName);
  
  rankingFilterName.textContent = filterName;
  rankingList.innerHTML = '';
  
  if (topScores.length === 0) {
    rankingList.innerHTML = '<div style="text-align:center; color:var(--gallery-ink-soft); padding:20px;">Nenhum registro ainda</div>';
  } else {
    topScores.forEach((entry, i) => {
      const item = document.createElement('div');
      item.className = 'ranking-item';
      const date = new Date(entry.date).toLocaleDateString('pt-BR');
      const levelName = DIFFICULTY_LEVELS[entry.level]?.name || entry.level;
      item.innerHTML = `
        <span class="rank">#${i + 1}</span>
        <span class="score">${entry.score} pts</span>
        <span class="meta">${entry.time.toFixed(1)}s | ${levelName} | ${date}</span>
      `;
      rankingList.appendChild(item);
    });
  }
  
  rankingOverlay.classList.remove('hidden');
  setTimeout(() => rankingOverlay.classList.add('visible'), 10);
}

function hideRanking() {
  rankingOverlay.classList.remove('visible');
  setTimeout(() => rankingOverlay.classList.add('hidden'), 300);
}

function toggleMultiplayer() {
  isMultiplayer = !isMultiplayer;
  const btn = document.getElementById('multiplayerBtn');
  btn.classList.toggle('active', isMultiplayer);
  
  if (isMultiplayer) {
    statusText.textContent = 'Modo 2 jogadores ativo! Mão esquerda = P1, Mão direita = P2';
  } else {
    statusText.textContent = 'Modo single jogador';
  }
  
  // Reset puzzle if active
  if (appState === 'puzzle' || appState === 'countdown') {
    resetPuzzleOnly();
  }
}

function cycleFilter(direction) {
  currentFilterIndex = (currentFilterIndex + direction + PHOTO_FILTERS.length) % PHOTO_FILTERS.length;
  showFilterBadge();
}

function fitCanvasToWindow() {
  const stageEl = document.getElementById("stage");
  const vw = stageEl.clientWidth;
  const vh = stageEl.clientHeight;
  const videoAspect = canvas.width / canvas.height;
  const containerAspect = vw / vh;

  let cssWidth, cssHeight;
  if (containerAspect > videoAspect) {
    cssWidth = vw;
    cssHeight = vw / videoAspect;
  } else {
    cssHeight = vh;
    cssWidth = vh * videoAspect;
  }

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

window.addEventListener("resize", fitCanvasToWindow);

async function initWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador não suporta getUserMedia.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  videoEl.srcObject = stream;

  await new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });

  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  fitCanvasToWindow();
}

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function initHandLandmarker() {
  let vision;
  try {
    vision = await withTimeout(
      FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      ),
      LOAD_TIMEOUT_MS,
      "Tempo limite esgotado ao carregar o runtime do MediaPipe (WASM). Verifique sua conexão com a internet ou se o cdn.jsdelivr.net está bloqueado."
    );
  } catch (err) {
    throw err;
  }

  try {
    const handLandmarker = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "video",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      }),
      LOAD_TIMEOUT_MS,
      "Tempo limite esgotado ao baixar o modelo HandLandmarker (~10MB) com GPU."
    );
    return handLandmarker;
  } catch (gpuErr) {
    console.warn("[PuzzleCam] Falhou com delegate GPU, tentando novamente com CPU…", gpuErr);
  }

  try {
    const handLandmarker = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "CPU",
        },
        runningMode: "video",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      }),
      LOAD_TIMEOUT_MS,
      "Tempo limite esgotado ao baixar o modelo HandLandmarker (~10MB) mesmo com CPU. Verifique sua conexão ou se storage.googleapis.com está bloqueado na sua rede."
    );
    return handLandmarker;
  } catch (cpuErr) {
    throw cpuErr;
  }
}

function dist2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isPinching(landmarks) {
  return dist2D(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) < PINCH_THRESHOLD;
}

function isFist(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const pairs = [
    [LM.INDEX_TIP, LM.INDEX_MCP],
    [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
    [LM.RING_TIP, LM.RING_MCP],
    [LM.PINKY_TIP, LM.PINKY_MCP],
  ];
  let curled = 0;
  for (const [tipIdx, mcpIdx] of pairs) {
    if (dist2D(landmarks[tipIdx], wrist) < dist2D(landmarks[mcpIdx], wrist)) curled++;
  }
  return curled >= 4;
}

function isHandOpen(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const pairs = [
    [LM.INDEX_TIP, LM.INDEX_MCP],
    [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
    [LM.RING_TIP, LM.RING_MCP],
    [LM.PINKY_TIP, LM.PINKY_MCP],
  ];
  let extended = 0;
  for (const [tipIdx, mcpIdx] of pairs) {
    if (dist2D(landmarks[tipIdx], wrist) > dist2D(landmarks[mcpIdx], wrist)) extended++;
  }
  const thumbTip = landmarks[LM.THUMB_TIP];
  const thumbIp = landmarks[3];
  if (dist2D(thumbTip, wrist) > dist2D(thumbIp, wrist)) extended++;
  return extended >= 5;
}

function isThumbsUp(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const thumbTip = landmarks[LM.THUMB_TIP];
  const thumbIp = landmarks[3];
  const thumbExtended = dist2D(thumbTip, wrist) > dist2D(thumbIp, wrist);
  if (!thumbExtended) return false;
  const pairs = [
    [LM.INDEX_TIP, LM.INDEX_MCP],
    [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
    [LM.RING_TIP, LM.RING_MCP],
    [LM.PINKY_TIP, LM.PINKY_MCP],
  ];
  for (const [tipIdx, mcpIdx] of pairs) {
    if (dist2D(landmarks[tipIdx], wrist) > dist2D(landmarks[mcpIdx], wrist)) return false;
  }
  return true;
}

function isThreeFingers(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const pairs = [
    [LM.INDEX_TIP, LM.INDEX_MCP],
    [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
    [LM.RING_TIP, LM.RING_MCP],
    [LM.PINKY_TIP, LM.PINKY_MCP],
  ];
  let extended = 0;
  for (const [tipIdx, mcpIdx] of pairs) {
    if (dist2D(landmarks[tipIdx], wrist) > dist2D(landmarks[mcpIdx], wrist)) extended++;
  }
  // Exactly 3 fingers extended (index, middle, ring)
  return extended === 3;
}

function toPixel(landmarkNorm) {
  return { x: landmarkNorm.x * canvas.width, y: landmarkNorm.y * canvas.height };
}

function mirrorLandmarkX(landmark) {
  return { x: 1 - landmark.x, y: landmark.y };
}

function computeHandFrame(indexTipA, indexTipB) {
  const a = toPixel(indexTipA);
  const b = toPixel(indexTipB);

  const minX = Math.min(a.x, b.x) - FRAME_PADDING;
  const maxX = Math.max(a.x, b.x) + FRAME_PADDING;
  const minY = Math.min(a.y, b.y) - FRAME_PADDING;
  const maxY = Math.max(a.y, b.y) + FRAME_PADDING;

  const x = Math.max(0, minX);
  const y = Math.max(0, minY);
  const width = Math.min(canvas.width, maxX) - x;
  const height = Math.min(canvas.height, maxY) - y;

  return { x, y, width, height };
}

const freezeGate = { holding: false, since: 0 };

const FRAME_GRACE_MS = 450;
const lastSeenFrame = { box: null, at: 0 };

const countdown = {
  active: false,
  startedAt: 0,
  lastBeep: 0,
};

function startCountdown(frameBox) {
  puzzle.boardBox = { ...frameBox };
  appState = "countdown";
  countdown.active = true;
  countdown.startedAt = performance.now();
}

function drawCountdownOverlay(box) {
  const elapsed = (performance.now() - countdown.startedAt) / 1000;
  const remaining = COUNTDOWN_SECONDS - elapsed;

  if (remaining <= 0) {
    finishCountdownAndCapture(box);
    return;
  }

  // Play beep on each second change
  const n = Math.ceil(remaining);
  if (n !== countdown.lastBeep) {
    countdown.lastBeep = n;
    sounds.countdownBeep();
  }

  applyBWInsideBox(box);

  ctx.save();
  ctx.strokeStyle = "#f5c518";
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  ctx.fillStyle = "rgba(10,10,8,0.45)";
  ctx.fillRect(box.x, box.y, box.width, box.height);

  ctx.font = `${Math.max(48, Math.min(box.width, box.height) * 0.4)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = "#f5c518";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), cx, cy);
  ctx.restore();

  statusText.textContent = `capturando em ${n}…`;
}

function gaussianNoise(std) {
  const u1 = Math.random() || 1e-6;
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0 * std;
}

function applyPhotoboothEffect(imageData) {
  return PHOTO_FILTERS[currentFilterIndex].apply(imageData);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function finishCountdownAndCapture(box) {
  countdown.active = false;
  
  // Flash effect on capture
  flashEffect.start();
  sounds.clack();

  const mirroredFrame = document.createElement("canvas");
  mirroredFrame.width = canvas.width;
  mirroredFrame.height = canvas.height;
  const mirroredCtx = mirroredFrame.getContext("2d");
  mirroredCtx.save();
  mirroredCtx.translate(mirroredFrame.width, 0);
  mirroredCtx.scale(-1, 1);
  mirroredCtx.drawImage(videoEl, 0, 0, mirroredFrame.width, mirroredFrame.height);
  mirroredCtx.restore();

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(box.width));
  cropCanvas.height = Math.max(1, Math.round(box.height));
  const cropCtx = cropCanvas.getContext("2d");
  cropCtx.drawImage(
    mirroredFrame,
    box.x, box.y, box.width, box.height,
    0, 0, cropCanvas.width, cropCanvas.height
  );

  const fullImageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
  applyPhotoboothEffect(fullImageData);
  cropCtx.putImageData(fullImageData, 0, 0);

  // Set grid size based on current level
  GRID = DIFFICULTY_LEVELS[currentLevel].grid;

  if (isMultiplayer) {
    // Create split-screen puzzles for multiplayer
    multiplayer.sharedPhoto = cropCanvas;
    
    const halfWidth = cropCanvas.width / 2;
    const player1Canvas = document.createElement("canvas");
    player1Canvas.width = halfWidth;
    player1Canvas.height = cropCanvas.height;
    player1Canvas.getContext("2d").drawImage(cropCanvas, 0, 0, halfWidth, cropCanvas.height, 0, 0, halfWidth, cropCanvas.height);
    
    const player2Canvas = document.createElement("canvas");
    player2Canvas.width = halfWidth;
    player2Canvas.height = cropCanvas.height;
    player2Canvas.getContext("2d").drawImage(cropCanvas, halfWidth, 0, halfWidth, cropCanvas.height, 0, 0, halfWidth, cropCanvas.height);
    
    // Create puzzles for both players
    createPlayerPuzzle(1, player1Canvas, box, halfWidth, cropCanvas.height);
    createPlayerPuzzle(2, player2Canvas, box, halfWidth, cropCanvas.height);
    
    appState = "puzzle";
    fistHoldCounter = 0;
    
    // Initialize scoring for both players
    scoring.active = true;
    scoring.startTime = performance.now();
    scoring.timeRemaining = BASE_TIME + DIFFICULTY_LEVELS[currentLevel].timeBonus - (scoring.phase - 1) * TIME_PENALTY_PER_PHASE;
    multiplayer.player1.score = 0;
    multiplayer.player2.score = 0;
    
    updateProgressBadge();
  } else {
    // Single player mode
    puzzle.fullPhotoboothCanvas = cropCanvas;

    const tileW = Math.floor(cropCanvas.width / GRID);
    const tileH = Math.floor(cropCanvas.height / GRID);
    const pieces = [];

    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const sx = col * tileW;
        const sy = row * tileH;
        const w = col === GRID - 1 ? cropCanvas.width - sx : tileW;
        const h = row === GRID - 1 ? cropCanvas.height - sy : tileH;

        const pieceCanvas = document.createElement("canvas");
        pieceCanvas.width = w;
        pieceCanvas.height = h;
        pieceCanvas.getContext("2d").drawImage(cropCanvas, sx, sy, w, h, 0, 0, w, h);

        pieces.push({
          row, col,
          canvas: pieceCanvas,
          w, h,
          x: 0, y: 0,
          placed: false,
          dragging: false,
          targetX: 0, targetY: 0, // For entry animation
        });
      }
    }

    const slots = [];
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        slots.push({ x: box.x + col * tileW, y: box.y + row * tileH });
      }
    }
    shuffle(slots);

    // Entry animation: pieces start at center and fly to shuffled positions
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    
    pieces.forEach((piece, i) => {
      piece.targetX = slots[i].x;
      piece.targetY = slots[i].y;
      piece.x = centerX;
      piece.y = centerY;
      piece.animating = true;
      piece.animStartedAt = performance.now();
      piece.animDelay = i * 30; // Staggered timing
      
      if (isNearOwnCell(piece, box, tileW, tileH)) {
        snapPieceToCell(piece, box, tileW, tileH);
        piece.animating = false;
      }
    });

    puzzle.boardBox = box;
    puzzle.pieces = pieces;
    puzzle.tileW = tileW;
    puzzle.tileH = tileH;
    puzzle.solved = pieces.every((p) => p.placed);
    appState = "puzzle";
    fistHoldCounter = 0;
    
    // Initialize scoring
    scoring.active = true;
    scoring.startTime = performance.now();
    scoring.timeRemaining = BASE_TIME + DIFFICULTY_LEVELS[currentLevel].timeBonus - (scoring.phase - 1) * TIME_PENALTY_PER_PHASE;
    scoring.score = 0;
    scoring.combo = 0;
    scoring.perfectSolve = true;
    
    updateProgressBadge();
  }
}

function createPlayerPuzzle(playerNum, photoCanvas, originalBox, width, height) {
  const tileW = Math.floor(width / GRID);
  const tileH = Math.floor(height / GRID);
  const pieces = [];
  
  // Create board box for this player (split screen)
  const boardBox = {
    x: playerNum === 1 ? originalBox.x : originalBox.x + originalBox.width / 2,
    y: originalBox.y,
    width: originalBox.width / 2,
    height: originalBox.height,
  };

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const sx = col * tileW;
      const sy = row * tileH;
      const w = col === GRID - 1 ? width - sx : tileW;
      const h = row === GRID - 1 ? height - sy : tileH;

      const pieceCanvas = document.createElement("canvas");
      pieceCanvas.width = w;
      pieceCanvas.height = h;
      pieceCanvas.getContext("2d").drawImage(photoCanvas, sx, sy, w, h, 0, 0, w, h);

      pieces.push({
        row, col,
        canvas: pieceCanvas,
        w, h,
        x: 0, y: 0,
        placed: false,
        dragging: false,
        targetX: 0, targetY: 0,
        player: playerNum,
      });
    }
  }

  const slots = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      slots.push({ x: boardBox.x + col * tileW, y: boardBox.y + row * tileH });
    }
  }
  shuffle(slots);

  const centerX = boardBox.x + boardBox.width / 2;
  const centerY = boardBox.y + boardBox.height / 2;
  
  pieces.forEach((piece, i) => {
    piece.targetX = slots[i].x;
    piece.targetY = slots[i].y;
    piece.x = centerX;
    piece.y = centerY;
    piece.animating = true;
    piece.animStartedAt = performance.now();
    piece.animDelay = i * 30;
  });

  const playerData = playerNum === 1 ? multiplayer.player1 : multiplayer.player2;
  playerData.pieces = pieces;
  playerData.boardBox = boardBox;
  playerData.tileW = tileW;
  playerData.tileH = tileH;
  playerData.solved = false;
}

const drag = {
  activeHand: null,
  piece: null,
  offsetX: 0,
  offsetY: 0,
};

function isNearOwnCell(piece, box, tileW, tileH) {
  const correctX = box.x + piece.col * tileW;
  const correctY = box.y + piece.row * tileH;
  const dx = piece.x - correctX;
  const dy = piece.y - correctY;
  const tolerance = Math.min(tileW, tileH) * SNAP_DISTANCE_RATIO;
  return Math.sqrt(dx * dx + dy * dy) < tolerance;
}

function reconcilePlacedState(box, tileW, tileH) {
  if (!box || !puzzle.pieces.length) return false;
  for (const piece of puzzle.pieces) {
    if (piece.displacing || piece.dragging) continue;
    piece.placed = isNearOwnCell(piece, box, tileW, tileH);
  }
  return puzzle.pieces.every((p) => p.placed);
}

function snapPieceToCell(piece, box, tileW, tileH) {
  const wasPlaced = piece.placed;
  displaceCellOccupant(piece, piece.row, piece.col, box, tileW, tileH);
  piece.x = box.x + piece.col * tileW;
  piece.y = box.y + piece.row * tileH;
  piece.placed = true;
  
  // Sound and particle effects on snap
  if (!wasPlaced) {
    sounds.snap();
    const centerX = piece.x + piece.w / 2;
    const centerY = piece.y + piece.h / 2;
    particles.addGoldenParticles(centerX, centerY, 15);
    
    // Combo system
    scoring.combo++;
    if (scoring.combo >= 3) {
      scoring.combo = 0;
      sounds.combo();
      particles.addConfetti(centerX, centerY, 30);
      // Bonus score for combo
      scoring.score += SCORE_PER_PIECE * COMBO_MULTIPLIER;
    } else {
      scoring.score += SCORE_PER_PIECE;
    }
  }
}

function displaceCellOccupant(piece, targetRow, targetCol, box, tileW, tileH) {
  const cellX = box.x + targetCol * tileW;
  const cellY = box.y + targetRow * tileH;

  const occupant = puzzle.pieces.find((p) => {
    if (p === piece || p.displacing) return false;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    return (
      cx >= cellX && cx < cellX + tileW &&
      cy >= cellY && cy < cellY + tileH
    );
  });
  if (!occupant) return;

  if (occupant.row === targetRow && occupant.col === targetCol && occupant.placed) {
    return;
  }

  occupant.placed = false;

  const freeCells = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (row === targetRow && col === targetCol) continue;
      const cx0 = box.x + col * tileW;
      const cy0 = box.y + row * tileH;
      const taken = puzzle.pieces.some((p) => {
        if (p === occupant || p === piece || p.displacing) return false;
        const cx = p.x + p.w / 2;
        const cy = p.y + p.h / 2;
        return cx >= cx0 && cx < cx0 + tileW && cy >= cy0 && cy < cy0 + tileH;
      });
      if (!taken) freeCells.push({ row, col });
    }
  }

  let targetSlot;
  if (freeCells.length > 0) {
    targetSlot = freeCells[Math.floor(Math.random() * freeCells.length)];
  } else {
    targetSlot = { row: occupant.row, col: occupant.col };
  }

  const jitterX = (Math.random() - 0.5) * tileW * 0.5;
  const jitterY = (Math.random() - 0.5) * tileH * 0.5;
  const targetX = box.x + targetSlot.col * tileW + jitterX;
  const targetY = box.y + targetSlot.row * tileH + jitterY;

  animateDisplacement(occupant, targetX, targetY, box);
}

const DISPLACE_ANIM_MS = 220;

function animateDisplacement(piece, targetX, targetY, box) {
  const startX = piece.x;
  const startY = piece.y;
  const startedAt = performance.now();

  piece.displacing = true;

  function step() {
    const t = Math.min(1, (performance.now() - startedAt) / DISPLACE_ANIM_MS);
    const eased = 1 - Math.pow(1 - t, 3);

    piece.x = startX + (targetX - startX) * eased;
    piece.y = startY + (targetY - startY) * eased;

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      piece.x = targetX;
      piece.y = targetY;
      piece.displacing = false;
      clampPieceToBoard(piece);
    }
  }

  requestAnimationFrame(step);
}

function findNearestPiece(px, py) {
  let best = null;
  let bestDist = Infinity;
  for (const piece of puzzle.pieces) {
    if (piece.displacing) continue;
    const cx = piece.x + piece.w / 2;
    const cy = piece.y + piece.h / 2;
    const d = Math.hypot(px - cx, py - cy);
    if (d < Math.max(piece.w, piece.h) * 0.75 && d < bestDist) {
      best = piece;
      bestDist = d;
    }
  }
  return best;
}

function handleDragForHand(handLabel, pinching, indexPx) {
  // Add finger trail
  particles.addFingerTrail(indexPx.x, indexPx.y);
  
  if (isMultiplayer) {
    // Multiplayer mode: hand A = player 1 (left), hand B = player 2 (right)
    const playerNum = handLabel === 'A' ? 1 : 2;
    const playerData = playerNum === 1 ? multiplayer.player1 : multiplayer.player2;
    
    if (pinching) {
      if (drag.activeHand === null) {
        const candidate = findNearestPieceInPlayer(indexPx.x, indexPx.y, playerData);
        if (candidate) {
          drag.activeHand = handLabel;
          drag.piece = candidate;
          drag.offsetX = indexPx.x - candidate.x;
          drag.offsetY = indexPx.y - candidate.y;
          candidate.dragging = true;
          candidate.placed = false;
        }
      } else if (drag.activeHand === handLabel && drag.piece) {
        drag.piece.x = indexPx.x - drag.offsetX;
        drag.piece.y = indexPx.y - drag.offsetY;
      }
    } else {
      if (drag.activeHand === handLabel && drag.piece) {
        const piece = drag.piece;
        piece.dragging = false;
        sounds.clack();
        if (isNearOwnCell(piece, playerData.boardBox, playerData.tileW, playerData.tileH)) {
          snapPieceToCell(piece, playerData.boardBox, playerData.tileW, playerData.tileH);
          playerData.score += SCORE_PER_PIECE;
        } else {
          clampPieceToBoardInPlayer(piece, playerData.boardBox);
          const box = playerData.boardBox;
          const cx = piece.x + piece.w / 2;
          const cy = piece.y + piece.h / 2;
          const dropCol = Math.min(
            GRID - 1,
            Math.max(0, Math.floor((cx - box.x) / playerData.tileW))
          );
          const dropRow = Math.min(
            GRID - 1,
            Math.max(0, Math.floor((cy - box.y) / playerData.tileH))
          );
          displaceCellOccupantInPlayer(piece, dropRow, dropCol, box, playerData.tileW, playerData.tileH, playerData.pieces);
        }
        drag.activeHand = null;
        drag.piece = null;
        playerData.solved = reconcilePlacedStateInPlayer(playerData.boardBox, playerData.tileW, playerData.tileH, playerData.pieces);
        updateProgressBadge();
        
        // Check for winner
        if (playerData.solved) {
          sounds.fanfare();
          screenShake.start(8, 400);
          particles.addConfetti(
            playerData.boardBox.x + playerData.boardBox.width / 2,
            playerData.boardBox.y + playerData.boardBox.height / 2,
            80
          );
          statusText.textContent = `Jogador ${playerNum} venceu! Feche o punho para reiniciar`;
        }
      }
    }
  } else {
    // Single player mode
    if (pinching) {
      if (drag.activeHand === null) {
        const candidate = findNearestPiece(indexPx.x, indexPx.y);
        if (candidate) {
          drag.activeHand = handLabel;
          drag.piece = candidate;
          drag.offsetX = indexPx.x - candidate.x;
          drag.offsetY = indexPx.y - candidate.y;
          candidate.dragging = true;
          candidate.placed = false;
          // Reset combo on picking up a piece
          if (candidate.row !== Math.floor((candidate.y - puzzle.boardBox.y) / puzzle.tileH) ||
              candidate.col !== Math.floor((candidate.x - puzzle.boardBox.x) / puzzle.tileW)) {
            scoring.combo = 0;
            scoring.perfectSolve = false;
          }
        }
      } else if (drag.activeHand === handLabel && drag.piece) {
        drag.piece.x = indexPx.x - drag.offsetX;
        drag.piece.y = indexPx.y - drag.offsetY;
      }
    } else {
      if (drag.activeHand === handLabel && drag.piece) {
        const piece = drag.piece;
        piece.dragging = false;
        sounds.clack();
        if (isNearOwnCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH)) {
          snapPieceToCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH);
        } else {
          // Reset combo on incorrect placement
          scoring.combo = 0;
          scoring.perfectSolve = false;
          clampPieceToBoard(piece);
          const box = puzzle.boardBox;
          const cx = piece.x + piece.w / 2;
          const cy = piece.y + piece.h / 2;
          const dropCol = Math.min(
            GRID - 1,
            Math.max(0, Math.floor((cx - box.x) / puzzle.tileW))
          );
          const dropRow = Math.min(
            GRID - 1,
            Math.max(0, Math.floor((cy - box.y) / puzzle.tileH))
          );
          displaceCellOccupant(piece, dropRow, dropCol, box, puzzle.tileW, puzzle.tileH);
        }
        drag.activeHand = null;
        drag.piece = null;
        puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
        updateProgressBadge();
      }
    }
  }
}

function findNearestPieceInPlayer(px, py, playerData) {
  let best = null;
  let bestDist = Infinity;
  for (const piece of playerData.pieces) {
    if (piece.displacing) continue;
    const cx = piece.x + piece.w / 2;
    const cy = piece.y + piece.h / 2;
    const d = Math.hypot(px - cx, py - cy);
    if (d < Math.max(piece.w, piece.h) * 0.75 && d < bestDist) {
      best = piece;
      bestDist = d;
    }
  }
  return best;
}

function clampPieceToBoardInPlayer(piece, box) {
  piece.x = Math.min(Math.max(piece.x, box.x), box.x + box.width - piece.w);
  piece.y = Math.min(Math.max(piece.y, box.y), box.y + box.height - piece.h);
}

function displaceCellOccupantInPlayer(piece, targetRow, targetCol, box, tileW, tileH, pieces) {
  const cellX = box.x + targetCol * tileW;
  const cellY = box.y + targetRow * tileH;

  const occupant = pieces.find((p) => {
    if (p === piece || p.displacing) return false;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    return (
      cx >= cellX && cx < cellX + tileW &&
      cy >= cellY && cy < cellY + tileH
    );
  });
  if (!occupant) return;

  if (occupant.row === targetRow && occupant.col === targetCol && occupant.placed) {
    return;
  }

  occupant.placed = false;

  const freeCells = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (row === targetRow && col === targetCol) continue;
      const cx0 = box.x + col * tileW;
      const cy0 = box.y + row * tileH;
      const taken = pieces.some((p) => {
        if (p === occupant || p === piece || p.displacing) return false;
        const cx = p.x + p.w / 2;
        const cy = p.y + p.h / 2;
        return cx >= cx0 && cx < cx0 + tileW && cy >= cy0 && cy < cy0 + tileH;
      });
      if (!taken) freeCells.push({ row, col });
    }
  }

  let targetSlot;
  if (freeCells.length > 0) {
    targetSlot = freeCells[Math.floor(Math.random() * freeCells.length)];
  } else {
    targetSlot = { row: occupant.row, col: occupant.col };
  }

  const jitterX = (Math.random() - 0.5) * tileW * 0.5;
  const jitterY = (Math.random() - 0.5) * tileH * 0.5;
  const targetX = box.x + targetSlot.col * tileW + jitterX;
  const targetY = box.y + targetSlot.row * tileH + jitterY;

  animateDisplacement(occupant, targetX, targetY, box);
}

function reconcilePlacedStateInPlayer(box, tileW, tileH, pieces) {
  if (!box || !pieces.length) return false;
  for (const piece of pieces) {
    if (piece.displacing || piece.dragging) continue;
    piece.placed = isNearOwnCell(piece, box, tileW, tileH);
  }
  return pieces.every((p) => p.placed);
}

function clampPieceToBoard(piece) {
  const box = puzzle.boardBox;
  piece.x = Math.min(Math.max(piece.x, box.x), box.x + box.width - piece.w);
  piece.y = Math.min(Math.max(piece.y, box.y), box.y + box.height - piece.h);
}

function drawBoardAndPieces() {
  if (isMultiplayer) {
    // Draw both player boards
    drawPlayerBoard(multiplayer.player1, 1, "#4a90d9");
    drawPlayerBoard(multiplayer.player2, 2, "#e0533d");
  } else {
    // Single player mode
    const box = puzzle.boardBox;

    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(245,197,24,0.18)";
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(box.x + i * puzzle.tileW, box.y);
      ctx.lineTo(box.x + i * puzzle.tileW, box.y + box.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(box.x, box.y + i * puzzle.tileH);
      ctx.lineTo(box.x + box.width, box.y + i * puzzle.tileH);
      ctx.stroke();
    }
    ctx.restore();

    // Update and draw entry animations
    const now = performance.now();
    for (const piece of puzzle.pieces) {
      if (piece.animating) {
        const elapsed = now - piece.animStartedAt;
        if (elapsed >= piece.animDelay) {
          const animTime = elapsed - piece.animDelay;
          const duration = 400;
          const t = Math.min(1, animTime / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          piece.x = (box.x + box.width / 2) + (piece.targetX - (box.x + box.width / 2)) * eased;
          piece.y = (box.y + box.height / 2) + (piece.targetY - (box.y + box.height / 2)) * eased;
          if (t >= 1) {
            piece.animating = false;
            piece.x = piece.targetX;
            piece.y = piece.targetY;
          }
        }
      }
    }

    const sorted = [...puzzle.pieces].sort((a, b) => (a.dragging ? 1 : 0) - (b.dragging ? 1 : 0));

    for (const piece of sorted) {
      ctx.save();
      if (piece.dragging) {
        ctx.shadowColor = "rgba(245,197,24,0.9)";
        ctx.shadowBlur = 14;
      }
      ctx.drawImage(piece.canvas, piece.x, piece.y, piece.w, piece.h);
      ctx.strokeStyle = piece.placed ? "#5fae6e" : "rgba(234,229,214,0.5)";
      ctx.lineWidth = piece.dragging ? 3 : 1.5;
      ctx.strokeRect(piece.x, piece.y, piece.w, piece.h);
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = puzzle.solved ? "#5fae6e" : "#f5c518";
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.restore();

    // Draw photo preview thumbnail
    if (puzzle.fullPhotoboothCanvas && !puzzle.solved) {
      const thumbSize = Math.min(120, Math.min(box.width, box.height) * 0.25);
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.drawImage(
        puzzle.fullPhotoboothCanvas,
        box.x + box.width - thumbSize - 10,
        box.y + box.height - thumbSize - 10,
        thumbSize,
        thumbSize
      );
      ctx.strokeStyle = "rgba(245,197,24,0.5)";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        box.x + box.width - thumbSize - 10,
        box.y + box.height - thumbSize - 10,
        thumbSize,
        thumbSize
      );
      ctx.restore();
    }

    if (puzzle.solved) {
      ctx.save();
      ctx.fillStyle = "rgba(95,174,110,0.15)";
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.font = `${Math.max(20, box.width * 0.07)}px 'IBM Plex Mono', monospace`;
      ctx.fillStyle = "#5fae6e";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      
      let solveText = "COMPLETO! — feche o punho para salvar";
      if (scoring.perfectSolve) {
        solveText = "PERFEITO! — feche o punho para salvar";
        ctx.font = `${Math.max(24, box.width * 0.08)}px 'IBM Plex Mono', monospace`;
        ctx.fillStyle = "#f5c518";
      }
      ctx.fillText(solveText, box.x + box.width / 2, box.y + box.height / 2);
      
      // Show score
      ctx.font = `${Math.max(16, box.width * 0.05)}px 'IBM Plex Mono', monospace`;
      ctx.fillStyle = "rgba(234,229,214,0.8)";
      ctx.fillText(`Pontuação: ${scoring.score}`, box.x + box.width / 2, box.y + box.height / 2 + 30);
      ctx.restore();
    }
  }
}

function drawPlayerBoard(playerData, playerNum, color) {
  const box = playerData.boardBox;
  if (!box) return;

  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = `${color}33`; // 20% opacity
  ctx.lineWidth = 1;
  for (let i = 1; i < GRID; i++) {
    ctx.beginPath();
    ctx.moveTo(box.x + i * playerData.tileW, box.y);
    ctx.lineTo(box.x + i * playerData.tileW, box.y + box.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(box.x, box.y + i * playerData.tileH);
    ctx.lineTo(box.x + box.width, box.y + i * playerData.tileH);
    ctx.stroke();
  }
  ctx.restore();

  // Update and draw entry animations
  const now = performance.now();
  for (const piece of playerData.pieces) {
    if (piece.animating) {
      const elapsed = now - piece.animStartedAt;
      if (elapsed >= piece.animDelay) {
        const animTime = elapsed - piece.animDelay;
        const duration = 400;
        const t = Math.min(1, animTime / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        piece.x = (box.x + box.width / 2) + (piece.targetX - (box.x + box.width / 2)) * eased;
        piece.y = (box.y + box.height / 2) + (piece.targetY - (box.y + box.height / 2)) * eased;
        if (t >= 1) {
          piece.animating = false;
          piece.x = piece.targetX;
          piece.y = piece.targetY;
        }
      }
    }
  }

  const sorted = [...playerData.pieces].sort((a, b) => (a.dragging ? 1 : 0) - (b.dragging ? 1 : 0));

  for (const piece of sorted) {
    ctx.save();
    if (piece.dragging) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
    }
    ctx.drawImage(piece.canvas, piece.x, piece.y, piece.w, piece.h);
    ctx.strokeStyle = piece.placed ? "#5fae6e" : "rgba(234,229,214,0.5)";
    ctx.lineWidth = piece.dragging ? 3 : 1.5;
    ctx.strokeRect(piece.x, piece.y, piece.w, piece.h);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = playerData.solved ? "#5fae6e" : color;
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.restore();

  // Draw player label
  ctx.save();
  ctx.font = `${Math.max(14, box.width * 0.05)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(`J${playerNum}: ${playerData.score} pts`, box.x + box.width / 2, box.y - 10);
  ctx.restore();

  if (playerData.solved) {
    ctx.save();
    ctx.fillStyle = "rgba(95,174,110,0.15)";
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.font = `${Math.max(20, box.width * 0.07)}px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`JOGADOR ${playerNum} VENCEU!`, box.x + box.width / 2, box.y + box.height / 2);
    ctx.restore();
  }
}

function updateProgressBadge() {
  if (appState !== "puzzle") {
    progressBadge.classList.remove("visible", "solved");
    return;
  }
  
  let text = '';
  if (isMultiplayer) {
    const p1Placed = multiplayer.player1.pieces.filter((p) => p.placed).length;
    const p2Placed = multiplayer.player2.pieces.filter((p) => p.placed).length;
    text = `J1: ${p1Placed}/${multiplayer.player1.pieces.length} | J2: ${p2Placed}/${multiplayer.player2.pieces.length}`;
    
    if (scoring.active) {
      const timeSec = Math.ceil(scoring.timeRemaining);
      text += ` | ${timeSec}s | J1: ${multiplayer.player1.score} | J2: ${multiplayer.player2.score}`;
    }
  } else {
    const placedCount = puzzle.pieces.filter((p) => p.placed).length;
    text = `${placedCount} / ${puzzle.pieces.length} peças`;
    
    if (scoring.active) {
      const timeSec = Math.ceil(scoring.timeRemaining);
      text += ` | ${timeSec}s | ${scoring.score} pts`;
      if (scoring.combo > 0) {
        text += ` | Combo x${scoring.combo}`;
      }
    }
  }
  
  progressText.textContent = text;
  progressBadge.classList.add("visible");
  progressBadge.classList.toggle("solved", puzzle.solved || (multiplayer.player1.solved || multiplayer.player2.solved));
  
  updateTimerBar();
}

function drawVideoFrame() {
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function applyBWInsideBox(box) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(canvas.width - x, Math.round(box.width));
  const h = Math.min(canvas.height - y, Math.round(box.height));
  if (w <= 0 || h <= 0) return;

  const region = ctx.getImageData(x, y, w, h);
  applyPhotoboothEffect(region);
  ctx.putImageData(region, x, y);
}

function drawLiveFrameOverlay(box) {
  ctx.save();
  ctx.strokeStyle = "#f5c518";
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const cornerLen = 18;
  ctx.lineWidth = 4;
  const corners = [
    [box.x, box.y, 1, 1],
    [box.x + box.width, box.y, -1, 1],
    [box.x, box.y + box.height, 1, -1],
    [box.x + box.width, box.y + box.height, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + cornerLen * dy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + cornerLen * dx, cy);
    ctx.stroke();
  }
  ctx.restore();
}

function isPointInBoard(px, py, box) {
  if (!box) return false;
  return (
    px >= box.x &&
    px <= box.x + box.width &&
    py >= box.y &&
    py <= box.y + box.height
  );
}

function drawHandSkeleton(landmarksPx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(255,255,255,0.85)";
  ctx.shadowBlur = 10;
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;

  for (const [iA, iB] of HAND_CONNECTIONS) {
    const a = landmarksPx[iA];
    const b = landmarksPx[iB];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.shadowBlur = 6;
  ctx.fillStyle = "white";
  for (const p of landmarksPx) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawHandSkeletonsOverBoard(handsLandmarks, box) {
  if (!box || !handsLandmarks || handsLandmarks.length === 0) return;

  for (const lm of handsLandmarks) {
    const landmarksPx = lm.map((pt) => toPixel(mirrorLandmarkX(pt)));
    const overBoard = landmarksPx.some((p) => isPointInBoard(p.x, p.y, box));
    if (overBoard) {
      drawHandSkeleton(landmarksPx);
    }
  }
}

function startShatter(sourceCanvas, box) {
  const cols = SHATTER_COLS;
  const rows = SHATTER_ROWS;
  const fragW = sourceCanvas.width / cols;
  const fragH = sourceCanvas.height / rows;
  const fragments = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = col * fragW;
      const sy = row * fragH;

      const fragCanvas = document.createElement("canvas");
      fragCanvas.width = Math.ceil(fragW);
      fragCanvas.height = Math.ceil(fragH);
      fragCanvas.getContext("2d").drawImage(
        sourceCanvas,
        sx, sy, fragW, fragH,
        0, 0, fragCanvas.width, fragCanvas.height
      );

      const cx = box.x + sx + fragW / 2;
      const cy = box.y + sy + fragH / 2;

      const boardCx = box.x + box.width / 2;
      const boardCy = box.y + box.height / 2;
      const dirX = cx - boardCx;
      const dirY = cy - boardCy;
      const dirLen = Math.max(1, Math.hypot(dirX, dirY));
      const speed = 90 + Math.random() * 160;

      fragments.push({
        canvas: fragCanvas,
        x: cx,
        y: cy,
        w: fragW,
        h: fragH,
        vx: (dirX / dirLen) * speed + (Math.random() - 0.5) * 40,
        vy: (dirY / dirLen) * speed + (Math.random() - 0.5) * 40 - 60,
        rotation: 0,
        rotationSpeed: (Math.random() - 0.5) * 6,
        gravity: 220 + Math.random() * 80,
      });
    }
  }

  shatter.fragments = fragments;
  shatter.active = true;
  shatter.startedAt = performance.now();
  appState = "shattering";
}

function updateAndDrawShatter() {
  const elapsedMs = performance.now() - shatter.startedAt;
  const t = Math.min(1, elapsedMs / SHATTER_DURATION_MS);

  if (t >= 1) {
    finishShatter();
    return;
  }

  const dt = 1 / 60;
  const fadeStart = 0.45;

  ctx.save();
  for (const frag of shatter.fragments) {
    frag.x += frag.vx * dt;
    frag.y += frag.vy * dt;
    frag.vy += frag.gravity * dt;
    frag.rotation += frag.rotationSpeed * dt;

    const alpha = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (1 - fadeStart));
    const scale = 1 - t * 0.25;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(frag.x, frag.y);
    ctx.rotate(frag.rotation);
    ctx.scale(scale, scale);
    ctx.drawImage(frag.canvas, -frag.w / 2, -frag.h / 2, frag.w, frag.h);
    ctx.restore();
  }
  ctx.restore();
}

function finishShatter() {
  shatter.active = false;
  shatter.fragments = [];
  if (shatter.pendingCanvas) {
    addToGallery(shatter.pendingCanvas);
    statusText.textContent = "salvo na tira!";
    shatter.pendingCanvas = null;
  }
  resetPuzzleOnly();
}

function handleFistReset() {
  if (appState !== "puzzle") {
    statusText.textContent = "reiniciado (punho)";
    resetPuzzleOnly();
    return;
  }

  const reallySolved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
  puzzle.solved = reallySolved;

  if (reallySolved && puzzle.fullPhotoboothCanvas) {
    // Save score to rankings
    const filterName = PHOTO_FILTERS[currentFilterIndex].name;
    const timeTaken = (performance.now() - scoring.startTime) / 1000;
    rankings.save(filterName, scoring.score, timeTaken);
    
    // Play fanfare and effects
    sounds.fanfare();
    screenShake.start(8, 400);
    if (scoring.perfectSolve) {
      particles.addConfetti(
        puzzle.boardBox.x + puzzle.boardBox.width / 2,
        puzzle.boardBox.y + puzzle.boardBox.height / 2,
        80
      );
    }
    
    shatter.pendingCanvas = puzzle.fullPhotoboothCanvas;
    startShatter(puzzle.fullPhotoboothCanvas, puzzle.boardBox);
  } else {
    statusText.textContent = "reiniciado (punho)";
    resetPuzzleOnly();
  }
}

let handLandmarker = null;
let fistHoldCounter = 0;

function processResults(result) {
  if (appState === "shattering") {
    updateAndDrawShatter();
    statusText.textContent = "salvando…";
    return;
  }

  // Update effects
  const dt = 1 / 60;
  particles.update(dt);
  flashEffect.update();
  const shakeOffset = screenShake.update();
  
  // Apply screen shake
  if (shakeOffset.x !== 0 || shakeOffset.y !== 0) {
    ctx.save();
    ctx.translate(shakeOffset.x, shakeOffset.y);
  }

  const handsLandmarks = result.landmarks || [];
  const noHands = handsLandmarks.length === 0;

  // ── Open hand pause detection ──
  // 10 fingers (both hands open) = pause, 5 fingers (one hand open) = unpause
  if (!noHands) {
    const openHandsCount = handsLandmarks.filter((lm) => isHandOpen(lm)).length;
    const draggingNow = drag.activeHand !== null && drag.piece !== null;

    // PAUSE: both hands open (10 fingers) held for N frames
    if (openHandsCount >= 2 && !isPaused && !draggingNow && appState !== "countdown" && appState !== "shattering") {
      openHandHoldCounter++;
      if (openHandHoldCounter >= OPEN_HAND_HOLD_FRAMES) {
        openHandHoldCounter = 0;
        if (!isPaused) togglePause();
        return;
      }
      statusText.textContent = `levante as 2 maos para pausar (${openHandHoldCounter}/${OPEN_HAND_HOLD_FRAMES})`;
    }
    // UNPAUSE: one hand open (5 fingers) while paused
    else if (openHandsCount === 1 && isPaused) {
      openHandHoldCounter++;
      if (openHandHoldCounter >= OPEN_HAND_HOLD_FRAMES) {
        openHandHoldCounter = 0;
        if (isPaused) togglePause();
        return;
      }
      statusText.textContent = `despausando… (${openHandHoldCounter}/${OPEN_HAND_HOLD_FRAMES})`;
    }
    else {
      openHandHoldCounter = 0;
    }

    // Thumbs up filter cycling (only when not paused, not dragging)
    if (!isPaused && !draggingNow && appState !== "countdown" && appState !== "shattering") {
      if (thumbsUpCooldown > 0) {
        thumbsUpCooldown--;
      }
      const thumbsUpHand = handsLandmarks.find((lm) => isThumbsUp(lm));
      if (thumbsUpHand && thumbsUpCooldown === 0) {
        thumbsUpHoldCounter++;
        if (thumbsUpHoldCounter >= THUMBS_UP_HOLD_FRAMES) {
          thumbsUpHoldCounter = 0;
          thumbsUpCooldown = THUMBS_UP_COOLDOWN_FRAMES;
          cycleFilter(1);
        } else {
          statusText.textContent = appState === "tracking"
            ? `polegar para cima para trocar filtro (${thumbsUpHoldCounter}/${THUMBS_UP_HOLD_FRAMES})`
            : statusText.textContent;
        }
      } else if (!thumbsUpHand) {
        thumbsUpHoldCounter = 0;
      }
    } else {
      thumbsUpHoldCounter = 0;
    }
  } else {
    openHandHoldCounter = 0;
    thumbsUpHoldCounter = 0;
  }

  // ── Skip all processing when paused ──
  if (isPaused) {
    ctx.save();
    ctx.fillStyle = "rgba(10,10,8,0.55)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    return;
  }

  if (noHands) {
    statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot";
    fistHoldCounter = 0;
    freezeGate.holding = false;

    if (drag.activeHand && drag.piece) {
      handleDragForHand(drag.activeHand, false, { x: drag.piece.x, y: drag.piece.y });
    }

    if (appState === "tracking") {
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < FRAME_GRACE_MS) {
        applyBWInsideBox(lastSeenFrame.box);
        drawLiveFrameOverlay(lastSeenFrame.box);
      }
      statusText.textContent = isStripFull()
        ? "tira completa — baixe ou reinicie"
        : "buscando mãos…";
      return;
    }

    if (appState === "countdown") {
      drawCountdownOverlay(puzzle.boardBox);
      return;
    }

    if (appState === "puzzle") {
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
      drawBoardAndPieces();
      statusText.textContent = puzzle.solved
        ? "quebra-cabeça completo! feche o punho para salvar"
        : "monte o quebra-cabeça com pinch";
      return;
    }

    return;
  }

  statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot live";

  const anyFist = handsLandmarks.some((lm) => isFist(lm));
  const draggingNow = drag.activeHand !== null && drag.piece !== null;
  if (anyFist && !draggingNow && appState !== "tracking") {
    fistHoldCounter++;
    if (fistHoldCounter >= FIST_HOLD_FRAMES) {
      fistHoldCounter = 0;
      handleFistReset();
      return;
    }
  } else {
    fistHoldCounter = 0;
  }

  if (appState === "tracking") {
    if (isStripFull()) {
      statusText.textContent = "tira completa — baixe ou reinicie";
      return;
    }
    if (handsLandmarks.length === 2) {
      const [handA, handB] = handsLandmarks;
      const indexA = mirrorLandmarkX(handA[LM.INDEX_TIP]);
      const indexB = mirrorLandmarkX(handB[LM.INDEX_TIP]);
      const frameBox = computeHandFrame(indexA, indexB);

      if (frameBox.width > 4 && frameBox.height > 4) {
        applyBWInsideBox(frameBox);
        drawLiveFrameOverlay(frameBox);
        lastSeenFrame.box = frameBox;
        lastSeenFrame.at = performance.now();
      }

      // Check for 3-finger gesture on either hand to start countdown
      const threeFingersA = isThreeFingers(handA);
      const threeFingersB = isThreeFingers(handB);
      const hasThreeFingers = threeFingersA || threeFingersB;
      
      if (hasThreeFingers && frameBox.width > 40 && frameBox.height > 40) {
        threeFingersHoldCounter++;
        if (threeFingersHoldCounter >= THREE_FINGERS_HOLD_FRAMES) {
          threeFingersHoldCounter = 0;
          startCountdown(frameBox);
        } else {
          statusDot.className = "status-dot armed";
          statusText.textContent = `3 dedos para capturar (${threeFingersHoldCounter}/${THREE_FINGERS_HOLD_FRAMES})`;
        }
      } else {
        threeFingersHoldCounter = 0;
        statusText.textContent = "enquadre com 2 mãos, depois polegar para filtro, 3 dedos para capturar";
      }
    } else {
      threeFingersHoldCounter = 0;
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < FRAME_GRACE_MS) {
        applyBWInsideBox(lastSeenFrame.box);
        drawLiveFrameOverlay(lastSeenFrame.box);
        statusText.textContent = "enquadre com 2 mãos, depois polegar para filtro, 3 dedos para capturar";
      } else {
        statusText.textContent = "enquadre com 2 mãos, depois polegar para filtro, 3 dedos para capturar";
      }
    }
    return;
  }

  if (appState === "countdown") {
    drawCountdownOverlay(puzzle.boardBox);
    return;
  }

  if (appState === "puzzle") {
    // Update timer
    if (scoring.active && !puzzle.solved) {
      const elapsed = (performance.now() - scoring.startTime) / 1000;
      scoring.timeRemaining = Math.max(0, BASE_TIME + DIFFICULTY_LEVELS[currentLevel].timeBonus - (scoring.phase - 1) * TIME_PENALTY_PER_PHASE - elapsed);
      if (scoring.timeRemaining <= 0) {
        // Time's up - game over
        sounds.gameOver();
        statusText.textContent = "tempo esgotado! feche o punho para reiniciar";
        scoring.active = false;
      }
    }
    
    const labelsPresent = new Set();
    handsLandmarks.forEach((lm, i) => {
      const label = i === 0 ? "A" : "B";
      labelsPresent.add(label);
      const pinching = isPinching(lm);
      const indexPx = toPixel(mirrorLandmarkX(lm[LM.INDEX_TIP]));
      handleDragForHand(label, pinching, indexPx);
    });

    if (drag.activeHand && !labelsPresent.has(drag.activeHand) && drag.piece) {
      handleDragForHand(drag.activeHand, false, { x: drag.piece.x, y: drag.piece.y });
    }

    if (!drag.piece) {
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
    }

    drawBoardAndPieces();
    drawHandSkeletonsOverBoard(handsLandmarks, puzzle.boardBox);
    particles.draw();
    flashEffect.draw();

    statusText.textContent = puzzle.solved
      ? (fistHoldCounter > 0
          ? `salvando… mantenha o punho (${fistHoldCounter}/${FIST_HOLD_FRAMES})`
          : "quebra-cabeça completo! feche o punho para salvar")
      : "monte o quebra-cabeça com pinch";
  }
  
  // Restore canvas after screen shake
  if (shakeOffset.x !== 0 || shakeOffset.y !== 0) {
    ctx.restore();
  }
}

function renderLoop() {
  if (videoEl.readyState >= 2 && handLandmarker) {
    drawVideoFrame();
    const nowMs = performance.now();
    const result = handLandmarker.detectForVideo(videoEl, nowMs);
    processResults(result);
  }
  requestAnimationFrame(renderLoop);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.style.display = "block";
}

function showLoaderError(message) {
  loaderText.textContent = message;
  loaderText.style.color = "#e0533d";
  loaderRetry.classList.remove("hidden");
}

function resetLoaderUI() {
  loadingOverlay.classList.remove("hidden");
  loaderText.style.color = "";
  loaderText.textContent = "carregando Gestura";
  loaderRetry.classList.add("hidden");
  errorBanner.style.display = "none";
}

async function boot() {
  resetLoaderUI();

  let settled = false;
  const watchdogMs = (LOAD_TIMEOUT_MS * 2) + 5000;
  const watchdog = setTimeout(() => {
    if (!settled) {
      showLoaderError("O carregamento está demorando demais. Clique em tentar novamente ou verifique sua conexão.");
    }
  }, watchdogMs);

  try {
    if (!videoEl.srcObject) {
      await initWebcam();
    }

    handLandmarker = await initHandLandmarker();

    settled = true;
    clearTimeout(watchdog);
    loadingOverlay.classList.add("hidden");
    statusText.textContent = "pronto";
    requestAnimationFrame(renderLoop);
  } catch (err) {
    settled = true;
    clearTimeout(watchdog);
    if (err && err.name === "NotAllowedError") {
      showLoaderError("Permissão de câmera negada. Ative-a nas configurações do navegador e clique em tentar novamente.");
    } else if (err && err.name === "NotFoundError") {
      showLoaderError("Nenhuma webcam disponível foi encontrada.");
    } else {
      showLoaderError((err && err.message) || "Erro ao iniciar o app.");
    }
  }
}

loaderRetry.addEventListener("click", () => {
  boot();
});

if (downloadStripBtn) {
  downloadStripBtn.addEventListener("click", downloadPhotoStrip);
  updateStripDownloadAvailability();
}

if (resetAllBtn) {
  resetAllBtn.addEventListener("click", () => {
    const confirmed = window.confirm(
      "Tem certeza de que deseja apagar toda a tira de fotos e começar de novo?"
    );
    if (confirmed) resetEverything();
  });
}

// Level selector event listeners
document.querySelectorAll('.level-btn').forEach(btn => {
  if (btn.id === 'multiplayerBtn') {
    btn.addEventListener('click', toggleMultiplayer);
  } else {
    btn.addEventListener('click', () => {
      const level = parseInt(btn.dataset.level);
      setLevel(level);
    });
  }
});

// Ranking overlay event listeners
if (closeRanking) {
  closeRanking.addEventListener('click', hideRanking);
}

// Show ranking when double-clicking filter badge
filterBadge.addEventListener('dblclick', showRanking);

boot();