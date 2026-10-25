/* =====================================================
   赤いボールをつかまえよう！ - game.js
   対象: 1歳児 / iPad Safari
   状態: HIDE → APPEAR → RUN → CATCH → (loop)
===================================================== */

'use strict';

// ===== DOM 参照 =====
const ball        = document.getElementById('ball');
const grassCanvas = document.getElementById('grass-canvas');
const flashOv     = document.getElementById('flash-overlay');
const confettiCvs = document.getElementById('confetti-canvas');
const hintText    = document.getElementById('hint-text');
const gameEl      = document.getElementById('game');
const ctx         = confettiCvs.getContext('2d');

// ===== 定数 =====
const BALL_RADIUS   = 60;   // px（当たり判定半径、表示より少し大きめ）
const SPLIT_RADIUS  = 40;   // px（分裂ボールの当たり判定半径）
const HIDE_TIMEOUT  = 5000; // ms: タップなしで自動出現
const RUN_TIMEOUT   = 10000;// ms: タップなしで自動捕獲
const CATCH_HOLD    = 3000; // ms: クリア演出の表示時間
const BALL_SPEED    = 0.7;  // px/frame: 逃げる速さ（ゆっくり目）

// ===== 状態管理 =====
const STATE = { HIDE: 'HIDE', APPEAR: 'APPEAR', RUN: 'RUN', SPLIT: 'SPLIT', CATCH: 'CATCH' };
let state        = STATE.HIDE;
let ballX        = 0;
let ballY        = 0;
let velX         = 0;
let velY         = 0;
let rafId        = null;
let autoTimer    = null;
let confettiArr  = [];
let confettiRaf  = null;
let isFirstRound = true;
let tapBlocked   = false; // 出現直後1秒間のタップ無効フラグ
let splitBalls   = [];   // 分裂中の2ボール: [{el, x, y, velX, velY, caught}, ...]
let splitRafId   = null;

// ===== Web Audio =====
let audioCtx = null;
let applauseBuffer = null;
let pendingFeedback = null;
let soundRequest = 0;
const activeSounds = new Set();

function stopSounds() {
  soundRequest++;
  pendingFeedback = null;
  activeSounds.forEach(source => { try { source.stop(); } catch (_) {} });
  activeSounds.clear();
}
function trackSound(source) {
  activeSounds.add(source);
  source.onended = () => activeSounds.delete(source);
}
function getAudio() {
  if (!audioCtx || audioCtx.state === 'closed') {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return null;
    audioCtx = new Audio({latencyHint: 'interactive'});
    applauseBuffer = null;
    audioCtx.onstatechange = () => {
      if (audioCtx.state === 'running') flushFeedback();
      else if (document.hidden) stopSounds();
    };
  }
  return audioCtx;
}

// iOSではタッチ操作内で無音バッファを再生して音声出力を起動する。
// resume()が保留のままでも、次の操作で必ず再試行する。
function warmupAudio() {
  try {
    const ac = getAudio();
    if (!ac) return;
    if (ac.state !== 'running') {
      const source = ac.createBufferSource();
      source.buffer = ac.createBuffer(1, 1, ac.sampleRate);
      source.connect(ac.destination);
      source.start(0);
      Promise.resolve(ac.resume()).then(flushFeedback, () => {});
    } else flushFeedback();
  } catch (_) { /* 音声起動失敗後も、次の操作で再試行する。 */ }
}

function flushFeedback() {
  if (!pendingFeedback || !audioCtx || audioCtx.state !== 'running') return;
  const feedback = pendingFeedback;
  pendingFeedback = null;
  if (feedback.request !== soundRequest || document.hidden || performance.now() - feedback.at > 1000) return;
  try { feedback.play(); } catch (_) {}
}

function playFeedback(play) {
  pendingFeedback = {request: ++soundRequest, at: performance.now(), play};
  warmupAudio();
}

function prepareAudio() {
  try {
    const ac = getAudio();
    if (ac && !applauseBuffer) applauseBuffer = buildApplauseBuffer(ac);
  } catch (_) {}
}

function playTone(freq, type, duration, startTime, gain = 0.4) {
  const ac    = getAudio();
  if (!ac || ac.state !== 'running') return;
  const osc   = ac.createOscillator();
  const gainN = ac.createGain();
  osc.connect(gainN);
  gainN.connect(ac.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  gainN.gain.setValueAtTime(gain, startTime);
  gainN.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  trackSound(osc);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playPop() {
  const ac = getAudio();
  const now = ac.currentTime + 0.005;
  playTone(880,  'sine', 0.12, now,        0.5);
  playTone(1200, 'sine', 0.10, now + 0.05, 0.4);
}

function playFanfare() {
  const ac  = getAudio();
  const now = ac.currentTime + 0.005;
  const notes = [523, 587, 659, 698, 784];
  notes.forEach((f, i) => {
    playTone(f, 'triangle', 0.25, now + i * 0.12, 0.45);
  });
  [523, 659, 784, 1046].forEach(f => {
    playTone(f, 'triangle', 0.5, now + notes.length * 0.12, 0.35);
  });
}

function playRollTick() {
  const ac  = getAudio();
  const now = ac.currentTime + 0.005;
  playTone(220, 'sine', 0.08, now, 0.15);
}

/** 拍手SE: 2層クラップ（スナップ+ボディ） + ハイパス＋ピーキングEQ */
function buildApplauseBuffer(ac) {
  const dur = 2.8;
  const rate   = ac.sampleRate;
  const frames = Math.ceil(rate * dur);
  const buf    = ac.createBuffer(1, frames, rate);
  const data   = buf.getChannelData(0);

  const clapCount = 42;
  for (let c = 0; c < clapCount; c++) {
    const t     = (c / clapCount) * dur + rand(-0.02, 0.02);
    const onset = Math.max(0, Math.floor(t * rate));

    // ① スナップ層（3〜7ms、急速減衰）: 「パシッ」の輪郭
    const snapLen = Math.floor(rand(0.003, 0.007) * rate);
    for (let s = 0; s < snapLen && onset + s < frames; s++) {
      data[onset + s] += (Math.random() * 2 - 1) * Math.exp(-s / (snapLen * 0.15)) * 2.5;
    }

    // ② ボディ層（20〜50ms、ゆっくり減衰）: 「ペタ」の厚み
    const bodyLen = Math.floor(rand(0.020, 0.050) * rate);
    for (let s = 0; s < bodyLen && onset + s < frames; s++) {
      data[onset + s] += (Math.random() * 2 - 1) * Math.exp(-s / (bodyLen * 0.30)) * 0.7;
    }
  }

  return buf;
}

function playApplause() {
  const ac = getAudio();
  if (!ac || ac.state !== 'running') return;
  const now = ac.currentTime + 0.005;
  const dur = 2.8;
  if (!applauseBuffer) applauseBuffer = buildApplauseBuffer(ac);
  const src = ac.createBufferSource();
  src.buffer = applauseBuffer;
  trackSound(src);

  // ハイパス: 低域ローリングを除去
  const hpf = ac.createBiquadFilter();
  hpf.type  = 'highpass';
  hpf.frequency.value = 1200;

  // ピーキングEQ: 3kHz 付近にパンチ感を追加
  const peak = ac.createBiquadFilter();
  peak.type  = 'peaking';
  peak.frequency.value = 3000;
  peak.gain.value      = 8;
  peak.Q.value         = 1.5;

  const gainN = ac.createGain();
  gainN.gain.setValueAtTime(3.0, now);
  gainN.gain.linearRampToValueAtTime(0, now + dur);

  src.connect(hpf);
  hpf.connect(peak);
  peak.connect(gainN);
  gainN.connect(ac.destination);
  src.start(now);
  src.stop(now + dur);
}

/** 歓声SE: ホワイトノイズ + スイープするバンドパスで「ワアアア！」を合成 */
function playCheering() {
  const ac  = getAudio();
  const now = ac.currentTime + 0.005;
  const dur = 2.5;

  // ベースノイズバッファ（共有）
  const rate   = ac.sampleRate;
  const frames = Math.ceil(rate * dur);
  const buf    = ac.createBuffer(1, frames, rate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  // 2系統のフォルマント: 周波数が上昇して「ワアアア！」を表現
  [
    { fStart: 500,  fPeak: 1600, q: 0.8 },
    { fStart: 800,  fPeak: 2400, q: 1.2 },
  ].forEach(({ fStart, fPeak, q }) => {
    const src = ac.createBufferSource();
    src.buffer = buf;

    const bpf = ac.createBiquadFilter();
    bpf.type  = 'bandpass';
    bpf.Q.value = q;
    // 0.35秒で一気に上昇 → 緩やかに落ち着く
    bpf.frequency.setValueAtTime(fStart, now);
    bpf.frequency.linearRampToValueAtTime(fPeak,          now + 0.35);
    bpf.frequency.exponentialRampToValueAtTime(fStart * 0.9, now + dur);

    const gainN = ac.createGain();
    gainN.gain.setValueAtTime(0,   now);
    gainN.gain.linearRampToValueAtTime(0.55, now + 0.2);
    gainN.gain.setValueAtTime(0.4,          now + 0.8);
    gainN.gain.linearRampToValueAtTime(0,   now + dur);

    src.connect(bpf);
    bpf.connect(gainN);
    gainN.connect(ac.destination);
    src.start(now);
    src.stop(now + dur);
  });
}

// ===== ユーティリティ =====
function rand(min, max) { return Math.random() * (max - min) + min; }

/** ボール位置を DOM に反映 */
function moveBallTo(x, y) {
  ballX = x;
  ballY = y;
  ball.style.left = x + 'px';
  ball.style.top  = y + 'px';
}

/** 空エリアの高さ（画面の上部15%） */
function skyHeight() {
  return window.innerHeight * 0.15;
}

/** confetti キャンバスのリサイズ */
function resizeCanvas() {
  confettiCvs.width  = window.innerWidth;
  confettiCvs.height = window.innerHeight;
}

// ===== 草むら前景を Canvas に描画 =====
function drawGrass() {
  const sky = skyHeight();
  const w   = window.innerWidth;
  const gh  = window.innerHeight - sky;  // 草原の高さ

  grassCanvas.width  = w;
  grassCanvas.height = gh;

  const gc = grassCanvas.getContext('2d');
  gc.clearRect(0, 0, w, gh);

  // 草の穂を横方向に密に並べながら、縦方向にもランダムに散りばめる
  // rowBaseY: キャンバス内のy座標（grassCanvasの上端=0がskyHeightに対応）
  for (let rowBaseY = gh + 10; rowBaseY >= -20; rowBaseY -= 40) {
    const numBladesInRow = Math.ceil(w / 6);
    for (let i = 0; i < numBladesInRow; i++) {
      const bx     = rand(-5, w + 5);
      const bladeH = rand(45, 110);
      const bend   = rand(-28, 28);
      const thick  = rand(2, 5);
      const hue    = rand(90, 135);
      const light  = rand(12, 38);

      gc.strokeStyle = `hsl(${hue}, 60%, ${light}%)`;
      gc.lineWidth   = thick;
      gc.lineCap     = 'round';
      gc.beginPath();
      gc.moveTo(bx, rowBaseY);
      gc.quadraticCurveTo(
        bx + bend * 0.45, rowBaseY - bladeH * 0.55,
        bx + bend,        rowBaseY - bladeH
      );
      gc.stroke();
    }
  }
}

// ===== クリアテキスト =====
function showClearText() {
  let el = document.getElementById('clear-text');
  if (!el) {
    el = document.createElement('div');
    el.id = 'clear-text';
    el.textContent = 'つかまえた！🎉';
    gameEl.appendChild(el);
  }
  el.className = 'show';
}

function hideClearText() {
  const el = document.getElementById('clear-text');
  if (el) el.className = '';
}

// ===== 紙吹雪 =====
const CONFETTI_COLORS = ['#f44336','#e91e63','#9c27b0','#3f51b5',
                         '#2196f3','#4caf50','#ff9800','#ffeb3b'];

function launchConfetti() {
  confettiArr = [];
  for (let i = 0; i < 80; i++) {
    confettiArr.push({
      x:    rand(0, window.innerWidth),
      y:    rand(-100, 0),
      w:    rand(8, 18),
      h:    rand(4, 10),
      color: CONFETTI_COLORS[Math.floor(rand(0, CONFETTI_COLORS.length))],
      vy:   rand(3, 7),
      vx:   rand(-2, 2),
      rot:  rand(0, 360),
      rotV: rand(-4, 4),
      opacity: 1,
    });
  }
  if (confettiRaf) cancelAnimationFrame(confettiRaf);
  animateConfetti();
}

function animateConfetti() {
  ctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
  let alive = false;
  confettiArr.forEach(p => {
    p.y   += p.vy;
    p.x   += p.vx;
    p.rot += p.rotV;
    if (p.y > window.innerHeight * 0.9) p.opacity -= 0.03;
    if (p.opacity > 0) {
      alive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.fillStyle   = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
  });
  if (alive) {
    confettiRaf = requestAnimationFrame(animateConfetti);
  } else {
    ctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
  }
}

// ===== タップエフェクト（リップル） =====
function spawnRipple(x, y, color = 'rgba(255,200,50,0.6)') {
  const r = document.createElement('div');
  r.className   = 'ripple';
  r.style.left  = x + 'px';
  r.style.top   = y + 'px';
  r.style.width = r.style.height = '80px';
  r.style.background = color;
  gameEl.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}

// ===== フラッシュ =====
function doFlash() {
  flashOv.className = '';
  void flashOv.offsetWidth;
  flashOv.className = 'flash';
}

// ===== HIDEフェーズ: 草原内のランダムな位置にボールを隠す =====
function hideBall() {
  const sky = skyHeight();
  const w   = window.innerWidth;
  const h   = window.innerHeight;
  const x   = rand(BALL_RADIUS + 10, w - BALL_RADIUS - 10);
  const y   = rand(sky + BALL_RADIUS + 10, h - BALL_RADIUS - 10);

  moveBallTo(x, y);
  ball.style.zIndex = '5'; // 草むら前景（z-index:20）の後ろ
  ball.className    = '';
}

// ===== HIDE フェーズ開始 =====
// 2歳向け: 8色から指定された色を選ぶ。
const CHOICE_COLORS = [
  {id: 'red', name: 'あかい', ink: '#e53935', gradient: '#ff6b6b, #e53935 50%, #b71c1c'},
  {id: 'green', name: 'みどりの', ink: '#00b83f', gradient: '#8affaa, #00cc44 55%, #00752b'},
  {id: 'blue', name: 'あおい', ink: '#1976d2', gradient: '#80d4ff, #1976d2 55%, #0d47a1'},
  {id: 'yellow', name: 'きいろい', ink: '#ffdf24', gradient: '#fff9ae, #ffdf24 55%, #e6a800'},
  {id: 'cyan', name: 'シアンの', ink: '#00d9e8', gradient: '#adffff, #00e5ed 55%, #008eaa'},
  {id: 'magenta', name: 'マゼンタの', ink: '#e600dc', gradient: '#ffaeff, #ed00dc 55%, #95008d'},
  {id: 'white', name: 'しろい', ink: '#ffffff', gradient: '#ffffff, #f5f5f5 55%, #bdbdbd'},
  {id: 'black', name: 'くろい', ink: '#171717', gradient: '#666666, #222222 55%, #000000'},
];
let targetColorIndex = 0;
let roundBallCount = 2;
function showColorHint(retry = false) {
  const target = CHOICE_COLORS[targetColorIndex];
  hintText.innerHTML = '<span class="target-color" style="color:' + target.ink + '">' + target.name + ' ボール</span>' + (retry ? 'を さがそう' : 'は どれかな？');
}
let dummyBalls = [];
let feedbackTimer = null;
let lastWrongAt = -Infinity;
let movingBalls = [];
let motionStartedAt = null;

function animateChoices(timestamp) {
  if (state !== STATE.RUN) return;
  const dt = motionStartedAt === null ? 0 : Math.min((timestamp - motionStartedAt) / 1000, 0.05);
  motionStartedAt = timestamp;
  const radius = parseFloat(ball.style.width) / 2;
  const minX = radius, maxX = innerWidth - radius;
  const minY = skyHeight() + radius, maxY = innerHeight - radius;
  movingBalls.forEach((b, i) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // 元のゲームと同じ、直進して画面の端で跳ね返る動き。
    if (b.x < minX) { b.x = minX; b.vx = Math.abs(b.vx); }
    if (b.x > maxX) { b.x = maxX; b.vx = -Math.abs(b.vx); }
    if (b.y < minY) { b.y = minY; b.vy = Math.abs(b.vy); }
    if (b.y > maxY) { b.y = maxY; b.vy = -Math.abs(b.vy); }
    if (i === 0) moveBallTo(b.x, b.y);
    else {
      b.el.style.left = b.x + 'px';
      b.el.style.top = b.y + 'px';
    }
  });
  rafId = requestAnimationFrame(animateChoices);
}

function startHide(advance = false) {
  if (advance) {
    targetColorIndex = (targetColorIndex + 1) % CHOICE_COLORS.length;
    roundBallCount++;
  }
  const target = CHOICE_COLORS[targetColorIndex];
  state = STATE.RUN;
  tapBlocked = false;
  clearTimeout(autoTimer);
  clearTimeout(feedbackTimer);
  if (rafId) cancelAnimationFrame(rafId);
  dummyBalls.forEach(b => b.el.remove());
  dummyBalls = [];
  ball.style.display = '';
  ball.style.zIndex = '26';
  ball.className = 'running';
  grassCanvas.classList.remove('wiggling');
  showColorHint();
  hintText.classList.remove('hidden');

  // 毎クリアで1個追加。正解色は1個だけにして、他の色を増やす。
  const w = innerWidth, h = innerHeight;
  const top = h * 0.24, areaHeight = h * 0.70;
  const columns = Math.max(1, Math.ceil(Math.sqrt(roundBallCount * w / areaHeight)));
  const rows = Math.ceil(roundBallCount / columns);
  const cellW = w / columns, cellH = areaHeight / rows;
  const size = Math.min(120, w * 0.22, h * 0.17, cellW * 0.72, cellH * 0.72);
  const positions = Array.from({length: roundBallCount}, (_, i) => ({
    x: ((i % columns) + 0.5) * cellW,
    y: top + (Math.floor(i / columns) + 0.5) * cellH,
  }));
  // 正解の位置を毎回変える。
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  ball.style.width = ball.style.height = size + 'px';
  moveBallTo(positions[0].x, positions[0].y);
  ball.setAttribute('aria-label', target.name + 'ボール');
  ball.style.background = 'radial-gradient(circle at 35% 35%, ' + target.gradient + ')';
  const wrongColors = CHOICE_COLORS.filter(color => color.id !== target.id);
  Array.from({length: roundBallCount - 1}, (_, i) => wrongColors[i % wrongColors.length]).forEach((color, i) => {
    const el = document.createElement('div');
    el.className = 'dummy-ball ' + color.id;
    el.style.width = el.style.height = size + 'px';
    el.style.left = positions[i + 1].x + 'px';
    el.style.top = positions[i + 1].y + 'px';
    el.setAttribute('aria-label', color.name + 'ボール');
    el.style.background = 'radial-gradient(circle at 35% 35%, ' + color.gradient + ')';
    gameEl.appendChild(el);
    dummyBalls.push({el, ...positions[i + 1]});
  });
  movingBalls = [{el: ball, x: ballX, y: ballY}, ...dummyBalls];
  movingBalls.forEach(b => {
    const angle = rand(0, Math.PI * 2);
    b.vx = Math.cos(angle) * 160;
    b.vy = Math.sin(angle) * 160;
  });
  motionStartedAt = null;
  rafId = requestAnimationFrame(animateChoices);
}

function wrongBall(b) {
  const now = performance.now();
  if (now - lastWrongAt < 650) return;
  lastWrongAt = now;
  b.el.classList.remove('wrong');
  void b.el.offsetWidth;
  b.el.classList.add('wrong');
  playFeedback(() => {
    const ac = getAudio();
    // スマートフォンでも聞こえやすい倍音を含む、短い2回のブザー。
    playTone(260, 'sawtooth', 0.24, ac.currentTime + 0.005, 0.32);
    playTone(130, 'square', 0.24, ac.currentTime + 0.005, 0.18);
    playTone(220, 'sawtooth', 0.32, ac.currentTime + 0.31, 0.32);
    playTone(110, 'square', 0.32, ac.currentTime + 0.31, 0.18);
  });
  showColorHint(true);
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    b.el.classList.remove('wrong');
    if (state === STATE.RUN) showColorHint();
  }, 1100);
}

// ===== APPEAR フェーズ =====
function startAppear() {
  state = STATE.APPEAR;
  clearTimeout(autoTimer);
  isFirstRound = false;

  grassCanvas.classList.remove('wiggling');
  hintText.classList.add('hidden');

  // ボールを草むら前景の前面へ
  ball.style.zIndex = '25';
  ball.className    = 'popping';
  playPop();

  setTimeout(() => {
    startRun();
  }, 500);
}

// ===== RUN フェーズ =====
let rollTickInterval = null;

function startRun() {
  state = STATE.RUN;
  ball.className = 'running';

  // 出現直後1秒間: 3倍速で遠くへ逃げ、タップを受け付けない
  tapBlocked = true;
  const angle = rand(0, Math.PI * 2);
  velX = Math.cos(angle) * BALL_SPEED * 3;
  velY = Math.sin(angle) * BALL_SPEED * 3;

  setTimeout(() => {
    if (state === STATE.RUN) {
      tapBlocked = false;
      // 速度を通常に戻す（向きは維持）
      const spd = Math.sqrt(velX * velX + velY * velY);
      if (spd > 0) { velX = (velX / spd) * BALL_SPEED; velY = (velY / spd) * BALL_SPEED; }
    }
  }, 1000);

  rollTickInterval = setInterval(() => {
    if (state === STATE.RUN || state === STATE.SPLIT) playRollTick();
  }, 400);

  rafId = requestAnimationFrame(runLoop);
}

function runLoop() {
  if (state !== STATE.RUN) return;

  const w    = window.innerWidth;
  const h    = window.innerHeight;
  const minY = skyHeight() + BALL_RADIUS; // 空との境界が上限
  const maxY = h - BALL_RADIUS;           // 画面下端が下限

  let nx = ballX + velX;
  let ny = ballY + velY;

  // 壁跳ね返り
  if (nx < BALL_RADIUS)     { nx = BALL_RADIUS;     velX =  Math.abs(velX); }
  if (nx > w - BALL_RADIUS) { nx = w - BALL_RADIUS; velX = -Math.abs(velX); }
  if (ny < minY)            { ny = minY;             velY =  Math.abs(velY); }
  if (ny > maxY)            { ny = maxY;             velY = -Math.abs(velY); }

  moveBallTo(nx, ny);
  rafId = requestAnimationFrame(runLoop);
}

// ===== SPLIT フェーズ =====
function createSplitBallEl() {
  const el = document.createElement('div');
  el.style.zIndex = '25';
  gameEl.appendChild(el);
  return el;
}

function startSplit(tapX, tapY) {
  state = STATE.SPLIT;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  spawnRipple(tapX, tapY, 'rgba(255,150,50,0.7)');
  playPop();

  ball.style.display = 'none';

  const currentAngle = Math.atan2(velY, velX);
  const spd = BALL_SPEED * 3; // 分裂直後は3倍速で逃げる

  splitBalls = [
    { el: createSplitBallEl(), x: ballX, y: ballY,
      velX: Math.cos(currentAngle - Math.PI / 3) * spd,
      velY: Math.sin(currentAngle - Math.PI / 3) * spd, caught: false },
    { el: createSplitBallEl(), x: ballX, y: ballY,
      velX: Math.cos(currentAngle + Math.PI / 3) * spd,
      velY: Math.sin(currentAngle + Math.PI / 3) * spd, caught: false },
  ];

  splitBalls.forEach(b => {
    b.el.className = 'split-ball running';
    b.el.style.left = b.x + 'px';
    b.el.style.top  = b.y + 'px';
  });

  // 1秒間タップ無効、その後通常速度に戻す
  tapBlocked = true;
  setTimeout(() => {
    if (state === STATE.SPLIT) {
      tapBlocked = false;
      splitBalls.forEach(b => {
        if (b.caught) return;
        const s = Math.sqrt(b.velX * b.velX + b.velY * b.velY);
        if (s > 0) { b.velX = (b.velX / s) * BALL_SPEED; b.velY = (b.velY / s) * BALL_SPEED; }
      });
    }
  }, 1000);

  splitRafId = requestAnimationFrame(splitLoop);
}

function splitLoop() {
  if (state !== STATE.SPLIT) return;
  const w = window.innerWidth, h = window.innerHeight;
  const minY = skyHeight() + SPLIT_RADIUS, maxY = h - SPLIT_RADIUS;

  splitBalls.forEach(b => {
    if (b.caught) return;
    let nx = b.x + b.velX, ny = b.y + b.velY;
    if (nx < SPLIT_RADIUS)     { nx = SPLIT_RADIUS;     b.velX =  Math.abs(b.velX); }
    if (nx > w - SPLIT_RADIUS) { nx = w - SPLIT_RADIUS; b.velX = -Math.abs(b.velX); }
    if (ny < minY)             { ny = minY;              b.velY =  Math.abs(b.velY); }
    if (ny > maxY)             { ny = maxY;              b.velY = -Math.abs(b.velY); }
    b.x = nx; b.y = ny;
    b.el.style.left = nx + 'px';
    b.el.style.top  = ny + 'px';
  });
  splitRafId = requestAnimationFrame(splitLoop);
}

function catchSplitBall(b, x, y) {
  b.caught = true;
  b.velX = b.velY = 0;
  b.el.className = 'split-ball caught';
  spawnRipple(x, y, 'rgba(255,220,0,0.7)');
  playPop();
  if (splitBalls.every(sb => sb.caught)) {
    setTimeout(endSplit, 300);
  }
}

function endSplit() {
  if (splitRafId) { cancelAnimationFrame(splitRafId); splitRafId = null; }
  clearInterval(rollTickInterval);
  state = STATE.CATCH;
  doFlash();
  playFeedback(() => { playFanfare(); playApplause(); playCheering(); });
  launchConfetti();
  showClearText();
  setTimeout(() => { playApplause(); playCheering(); }, 500);
  setTimeout(() => { hideClearText(); startHide(); }, CATCH_HOLD);
}

// ===== CATCH フェーズ =====
function catchBall(x, y) {
  if (state !== STATE.RUN) return;
  state = STATE.CATCH;

  clearTimeout(autoTimer);
  clearInterval(rollTickInterval);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  ball.className = 'caught';
  doFlash();
  spawnRipple(x, y, 'rgba(255,220,0,0.7)');
  playFeedback(() => { playFanfare(); playApplause(); playCheering(); });
  launchConfetti();
  showClearText();

  setTimeout(() => {
    hideClearText();
    ball.className = '';
    startHide(true);
  }, CATCH_HOLD);
}

// ===== タッチ / クリック処理 =====
function onTap(clientX, clientY) {
  if (state !== STATE.RUN) return;
  const radius = parseFloat(ball.style.width) / 2;
  // 重なったときも、最前面に見えている正解色を優先する。
  if (Math.hypot(clientX - ballX, clientY - ballY) <= radius * 1.12) {
    clearTimeout(feedbackTimer);
    hintText.classList.add('hidden');
    dummyBalls.forEach(b => b.el.classList.add('quiet'));
    catchBall(clientX, clientY);
    return;
  }
  for (const b of [...dummyBalls].reverse()) {
    if (Math.hypot(clientX - b.x, clientY - b.y) <= radius * 1.12) {
      wrongBall(b);
      return;
    }
  }
}

// 押している途中で2本目が触れたら、全ての指を離すまでグループ全体を無効にする。
const heldPointers = new Set();
let press = null;
let invalidPress = false;
function choiceAt(x, y) {
  const radius = parseFloat(ball.style.width) / 2 * 1.12;
  if (Math.hypot(x - ballX, y - ballY) <= radius) return ball;
  return [...dummyBalls].reverse().find(b => Math.hypot(x - b.x, y - b.y) <= radius) || null;
}
gameEl.addEventListener('pointerdown', e => {
  e.preventDefault();
  warmupAudio();
  heldPointers.add(e.pointerId);
  if (heldPointers.size !== 1 || e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) {
    invalidPress = true;
    press = null;
    return;
  }
  if (invalidPress || state !== STATE.RUN) return;
  press = {id: e.pointerId, x: e.clientX, y: e.clientY,
    choice: choiceAt(e.clientX, e.clientY), round: roundBallCount};
  gameEl.setPointerCapture?.(e.pointerId);
});
window.addEventListener('pointermove', e => {
  if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 30) {
    invalidPress = true;
  }
});
function finishPress(e, cancelled = false) {
  if (!heldPointers.has(e.pointerId)) return;
  const selected = press;
  const valid = !cancelled && !invalidPress && heldPointers.size === 1 &&
    selected && selected.id === e.pointerId && selected.round === roundBallCount && state === STATE.RUN &&
    Math.hypot(e.clientX - selected.x, e.clientY - selected.y) <= 30;
  heldPointers.delete(e.pointerId);
  if (cancelled) invalidPress = true;
  press = null;
  if (valid && selected.choice) {
    if (selected.choice === ball) onTap(ballX, ballY);
    else if (dummyBalls.includes(selected.choice)) wrongBall(selected.choice);
  }
  if (heldPointers.size === 0) invalidPress = false;
}
window.addEventListener('pointerup', e => finishPress(e));
window.addEventListener('pointercancel', e => finishPress(e, true));
window.addEventListener('blur', () => {
  heldPointers.clear();
  press = null;
  invalidPress = false;
});

// Safariで音声の許可が成立するtouchend/pointerupでも起動を試す。
gameEl.addEventListener('touchend', warmupAudio, {passive: true});
gameEl.addEventListener('pointerup', warmupAudio);
gameEl.addEventListener('click', warmupAudio);

window.addEventListener('resize', () => {
  resizeCanvas();
  drawGrass();
  if (state === STATE.RUN) startHide();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSounds();
});

// ===== 起動 =====
// AudioContextは最初のユーザー操作内で作成する。
resizeCanvas();
drawGrass();
startHide();

