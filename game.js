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
const HIDE_TIMEOUT  = 5000; // ms: タップなしで自動出現
const RUN_TIMEOUT   = 10000;// ms: タップなしで自動捕獲
const CATCH_HOLD    = 3000; // ms: クリア演出の表示時間
const BALL_SPEED    = 3.5;  // px/frame: 逃げる速さ（ゆっくり目）

// ===== 状態管理 =====
const STATE = { HIDE: 'HIDE', APPEAR: 'APPEAR', RUN: 'RUN', CATCH: 'CATCH' };
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

// ===== Web Audio =====
let audioCtx = null;
let audioWarmedUp = false;

/** 初回タップ時にiOSのオーディオハードウェアを起動する（遅延防止） */
function warmupAudio() {
  if (audioWarmedUp) return;
  audioWarmedUp = true;
  const ac = getAudio();
  const buf = ac.createBuffer(1, 1, ac.sampleRate);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
  src.start(0);
}
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq, type, duration, startTime, gain = 0.4) {
  const ac    = getAudio();
  const osc   = ac.createOscillator();
  const gainN = ac.createGain();
  osc.connect(gainN);
  gainN.connect(ac.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  gainN.gain.setValueAtTime(gain, startTime);
  gainN.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playPop() {
  const ac = getAudio();
  const now = ac.currentTime + 0.05;
  playTone(880,  'sine', 0.12, now,        0.5);
  playTone(1200, 'sine', 0.10, now + 0.05, 0.4);
}

function playFanfare() {
  const ac  = getAudio();
  const now = ac.currentTime + 0.05;
  const notes = [523, 587, 659, 698, 784];
  notes.forEach((f, i) => {
    playTone(f, 'triangle', 0.25, now + i * 0.12, 0.45);
  });
  [523, 659, 784].forEach(f => {
    playTone(f, 'triangle', 0.5, now + notes.length * 0.12, 0.35);
  });
}

function playRollTick() {
  const ac  = getAudio();
  const now = ac.currentTime + 0.05;
  playTone(220, 'sine', 0.08, now, 0.15);
}

/** 拍手SE: 2層クラップ（スナップ+ボディ） + ハイパス＋ピーキングEQ */
function playApplause() {
  const ac  = getAudio();
  const now = ac.currentTime + 0.05;
  const dur = 2.8;

  const rate   = ac.sampleRate;
  const frames = Math.ceil(rate * dur);
  const buf    = ac.createBuffer(1, frames, rate);
  const data   = buf.getChannelData(0);

  const clapCount = 20;
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

  const src = ac.createBufferSource();
  src.buffer = buf;

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
  const now = ac.currentTime + 0.05;
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
    gainN.gain.linearRampToValueAtTime(3.0, now + 0.2);
    gainN.gain.setValueAtTime(2.5,          now + 0.8);
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
function startHide() {
  state = STATE.HIDE;
  tapBlocked = false;
  clearTimeout(autoTimer);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  hideBall();
  grassCanvas.classList.add('wiggling');

  hintText.textContent = 'どこかにかくれているよ！';
  hintText.classList.remove('hidden');

  // 自動出現タイマーなし（子供が自分で見つけるまで待つ）
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
    if (state === STATE.RUN) playRollTick();
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
  playFanfare();
  launchConfetti();
  showClearText();
  setTimeout(() => {
    playApplause();
    playCheering();
  }, 500);

  setTimeout(() => {
    hideClearText();
    ball.className = '';
    startHide();
  }, CATCH_HOLD);
}

// ===== タッチ / クリック処理 =====
function onTap(clientX, clientY) {
  if (state === STATE.CATCH || state === STATE.APPEAR) return;

  if (state === STATE.HIDE) {
    // RUNフェーズと同じ距離判定でボールの隠れ位置付近のみ反応
    if (clientY >= skyHeight()) {
      const dx   = clientX - ballX;
      const dy   = clientY - ballY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= BALL_RADIUS * 1.4) {
        spawnRipple(clientX, clientY, 'rgba(100,200,100,0.5)');
        startAppear();
      }
    }
    return;
  }

  if (state === STATE.RUN) {
    if (tapBlocked) return; // 出現直後1秒間はタップ無効
    const dx   = clientX - ballX;
    const dy   = clientY - ballY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= BALL_RADIUS * 1.4) {
      catchBall(clientX, clientY);
    } else {
      spawnRipple(clientX, clientY, 'rgba(200,100,100,0.4)');
      const awayAngle = Math.atan2(ballY - clientY, ballX - clientX);
      velX = Math.cos(awayAngle) * BALL_SPEED * 1.5;
      velY = Math.sin(awayAngle) * BALL_SPEED * 1.5;
    }
  }
}

// タッチイベント
gameEl.addEventListener('touchstart', e => {
  e.preventDefault();
  warmupAudio();
  const t = e.changedTouches[0];
  onTap(t.clientX, t.clientY);
}, { passive: false });

// マウスフォールバック（PC テスト用）
gameEl.addEventListener('mousedown', e => {
  onTap(e.clientX, e.clientY);
});

// リサイズ対応
window.addEventListener('resize', () => {
  resizeCanvas();
  drawGrass();
  if (state === STATE.HIDE) hideBall();
});

// ===== 起動 =====
resizeCanvas();
drawGrass();
startHide();
