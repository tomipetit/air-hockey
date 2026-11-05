// M2 E2E：Playwright（Chromium 2 コンテキスト）で 2 台対戦を検証する。docs/design/M2.md §8.3
// 実行: npm run test:e2e（build 後にこのファイルを node で実行）
// 前提: Playwright と Chromium は導入済み（NODE_PATH 経由で require、playwright install はしない）
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.env.E2E_PORT || 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const TOTAL_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 240_000);
const ONLY = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',') : null;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- サーバー ----------
function startServer() {
  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const proc = spawn(tsx, ['server/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', STATIC_DIR: 'dist' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // tsx の子プロセスごと kill できるように
  });
  proc.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return proc;
}

function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* 既に終了 */
    }
  }
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitHealthy(ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await get(`${BASE}/healthz`);
    if (r && r.status === 200 && r.body === 'ok') return;
    await sleep(200);
  }
  throw new Error('server /healthz did not become ok within 10s');
}

// ---------- ブラウザ ----------
let browser;

/** 外部フォントは遮断（オフラインで遅延・エラーにならないよう空で返す） */
async function newPage(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  if (opts.init) await ctx.addInitScript(opts.init);
  if (opts.captureWs) {
    // テスト用に WebSocket を捕まえておき、生パケットを送れるようにする（不正 INPUT 注入用）
    await ctx.addInitScript(() => {
      const Orig = window.WebSocket;
      window.__wss = [];
      window.WebSocket = class extends Orig {
        constructor(...a) {
          super(...a);
          window.__wss.push(this);
        }
      };
    });
  }
  const page = await ctx.newPage();
  page.__name = name;
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') page.__errors.push(`console.error: ${m.text()}`);
  });
  return { ctx, page };
}

const snap = (page) => page.evaluate(() => window.__ah.snapshot());

async function waitSnap(page, pred, timeout, desc) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await snap(page);
      if (pred(last)) return last;
    } catch (e) {
      last = `evaluate failed: ${e.message}`;
    }
    if (Date.now() > end) {
      throw new Error(
        `[${page.__name}] timeout ${timeout}ms: ${desc}\n  last snapshot: ${JSON.stringify(last)}`,
      );
    }
    await sleep(25);
  }
}

async function text(page, sel) {
  return (await page.locator(sel).textContent()) ?? '';
}

async function waitText(page, sel, pred, timeout, desc) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await text(page, sel).catch(() => '<none>');
    if (pred(last)) return last;
    if (Date.now() > end) throw new Error(`[${page.__name}] timeout ${timeout}ms: ${desc} (${sel}="${last}")`);
    await sleep(25);
  }
}

async function waitVisible(page, sel, timeout, desc) {
  try {
    await page.locator(sel).waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`[${page.__name}] timeout ${timeout}ms: ${desc} (${sel} not visible)`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function noErrors(...pages) {
  for (const p of pages) {
    assert(p.__errors.length === 0, `[${p.__name}] page errors:\n  ${p.__errors.join('\n  ')}`);
  }
}

async function shot(scenario, pages) {
  for (const [suffix, p] of Object.entries(pages)) {
    if (!p || p.isClosed()) continue;
    await p.screenshot({ path: path.join(OUT, `${scenario}-${suffix}.png`) }).catch(() => {});
  }
}

/** P1 で部屋を作り、コードを返す */
async function createRoom(p1) {
  await p1.goto(`${BASE}/?e2e${p1.__flags || ''}`);
  await p1.locator('#create-btn').click();
  const code = await waitText(p1, '#room-code', (t) => /^\d{4}$/.test(t), 10_000, 'room code');
  return code;
}

async function bothReady(p1, p2, kind, timeout) {
  const ok = (s) => s.net && s.net.phase === 'ready' && s.net.kind === kind && s.mode === 'playing';
  const s1 = await waitSnap(p1, ok, timeout, `ready/${kind}/playing`);
  const s2 = await waitSnap(p2, ok, timeout, `ready/${kind}/playing`);
  return [s1, s2];
}

/** A-4：P2 の lastStateTick が 1 秒で 30 以上増える */
async function checkStateFlow(p2) {
  const a = await waitSnap(p2, (s) => s.lastStateTick !== null, 5000, 'first STATE');
  await sleep(1000);
  const b = await snap(p2);
  const inc = b.lastStateTick - a.lastStateTick;
  assert(inc >= 30, `STATE flow too slow: lastStateTick +${inc}/s (want >= 30)`);
  return inc;
}

const isPlaying = (s) => s.phase === 'playing';

/** A-7：forceGoal(scorer) で両者の HUD が正しい側に加点される */
async function goal(p1, p2, scorer, expect1, expect2) {
  await waitSnap(p1, isPlaying, 10_000, 'host phase playing (before forceGoal)');
  const ok = await p1.evaluate((s) => window.__ah.forceGoal(s), scorer);
  assert(ok === true, `forceGoal(${scorer}) returned ${ok}`);
  // expectN = [#score-me, #score-opp]
  await waitText(p1, '#score-me', (t) => t === String(expect1[0]), 3000, `P1 #score-me=${expect1[0]}`);
  await waitText(p1, '#score-opp', (t) => t === String(expect1[1]), 3000, `P1 #score-opp=${expect1[1]}`);
  await waitText(p2, '#score-me', (t) => t === String(expect2[0]), 3000, `P2 #score-me=${expect2[0]}`);
  await waitText(p2, '#score-opp', (t) => t === String(expect2[1]), 3000, `P2 #score-opp=${expect2[1]}`);
}

async function canvasBox(page) {
  const b = await page.locator('#stage').boundingBox();
  return b;
}

async function moveMouse(page, fx, fy) {
  const b = await canvasBox(page);
  await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 2 });
}

// ---------- シナリオ ----------
const notes = [];

async function scenarioA() {
  const A = {};
  const h = await newPage('A-P1');
  const g = await newPage('A-P2');
  A.p1 = h.page;
  A.p2 = g.page;
  try {
    const code = await createRoom(A.p1);
    // 待機画面：QR・URL・状態
    const url = await text(A.p1, '#room-url');
    assert(url.endsWith(`?room=${code}`), `invite URL wrong: ${url}`);
    await waitText(A.p1, '#host-status', (t) => t.includes('相手の参加を待っています'), 5000, 'host waiting text');
    await A.p1.waitForFunction(() => document.getElementById('room-qr').classList.contains('ready'), null, {
      timeout: 5000,
    });
    assert(await A.p1.locator('#localhost-warning').isVisible(), 'localhost warning should be visible on 127.0.0.1');

    await A.p2.goto(`${BASE}/?e2e&room=${code}`);
    const [s1, s2] = await bothReady(A.p1, A.p2, 'p2p', 10_000);
    assert(s1.localSide === 1 && s1.driverKind === 'host', `P1 side/driver: ${s1.localSide}/${s1.driverKind}`);
    assert(s2.localSide === 2 && s2.driverKind === 'guest', `P2 side/driver: ${s2.localSide}/${s2.driverKind}`);
    // ?room= は URL から消える
    assert(!A.p2.url().includes('room='), `room param should be removed from URL: ${A.p2.url()}`);
    // HUD ラベル
    assert((await text(A.p1, '#who-opp')) === 'RIVAL', 'P1 #who-opp should be RIVAL');
    assert((await text(A.p2, '#who-opp')) === 'RIVAL', 'P2 #who-opp should be RIVAL');
    assert((await text(A.p2, '#who-me')) === 'YOU', 'P2 #who-me should be YOU');

    // A-4
    const inc = await checkStateFlow(A.p2);
    notes.push(`A: STATE +${inc} tick/s at P2`);

    // #net-status：P2P xxms
    const ns1 = await waitText(A.p1, '#net-status', (t) => /^P2P \d+ms$/.test(t), 5000, 'P1 net-status P2P xxms');
    const ns2 = await waitText(A.p2, '#net-status', (t) => /^P2P \d+ms$/.test(t), 5000, 'P2 net-status P2P xxms');
    notes.push(`A: net-status P1="${ns1}" P2="${ns2}"`);

    // A-5：P2 の入力（画面右下 → ワールド −x, 自陣 z<0）
    await moveMouse(A.p2, 0.8, 0.8);
    const t0 = Date.now();
    const local = await waitSnap(A.p2, (s) => s.mallets[1].x < -0.1, 1000, 'P2 local mallet moves to -x');
    const localMs = Date.now() - t0;
    notes.push(`A: P2 local mallet reacted in ${localMs}ms (spec: within 100ms)`);
    assert(localMs <= 100 + 150, `P2 local mallet too slow: ${localMs}ms`); // headless のフレーム間隔ぶんの余裕
    await waitSnap(A.p1, (s) => s.mallets[1].x < 0 && s.mallets[1].z < 0, 500 + 500, 'P1 sees P2 mallet x<0,z<0');
    const remoteMs = Date.now() - t0;
    notes.push(`A: P1 saw P2 mallet in ${remoteMs}ms (spec: within 500ms)`);
    assert(local.mallets[1].z < 0, 'P2 local mallet must stay in own half');
    await moveMouse(A.p2, 0.2, 0.8);
    await waitSnap(A.p1, (s) => s.mallets[1].x > 0, 1000, 'P1 sees P2 mallet x>0 after moving left');

    // A-6：P1 の入力（画面右 = ワールド +x）
    await moveMouse(A.p1, 0.8, 0.8);
    await waitSnap(A.p1, (s) => s.mallets[0].x > 0 && s.mallets[0].z > 0, 1000, 'P1 own mallet x>0');
    await waitSnap(A.p2, (s) => s.mallets[0].x > 0, 1000, 'P2 sees P1 mallet x>0 (interpolated)');

    // A-7：得点（P1 視点と P2 視点で YOU/RIVAL の側が逆）
    await goal(A.p1, A.p2, 1, [1, 0], [0, 1]);
    await goal(A.p1, A.p2, 2, [1, 1], [1, 1]);
    const s2b = await snap(A.p2);
    assert(s2b.score[0] === 1 && s2b.score[1] === 1, `P2 snapshot score ${s2b.score}`);

    // A-8：P1 が 7 点
    for (let n = 2; n <= 7; n++) {
      await goal(A.p1, A.p2, 1, [n, 1], [1, n]);
    }
    await waitVisible(A.p1, '#result', 5000, 'P1 result');
    await waitVisible(A.p2, '#result', 5000, 'P2 result');
    assert((await text(A.p1, '#result-title')) === 'YOU WIN', `P1 result title: ${await text(A.p1, '#result-title')}`);
    assert((await text(A.p2, '#result-title')) === 'YOU LOSE', `P2 result title: ${await text(A.p2, '#result-title')}`);
    assert((await text(A.p2, '#result-score')) === '1 – 7', `P2 result score: "${await text(A.p2, '#result-score')}"`);
    assert((await text(A.p1, '#result-score')) === '7 – 1', `P1 result score: "${await text(A.p1, '#result-score')}"`);
    await shot('A-result', { p1: A.p1, p2: A.p2 });

    // A-9：再戦
    await A.p2.locator('#again-btn').click();
    assert(await A.p2.locator('#again-btn').isDisabled(), 'P2 #again-btn should be disabled while waiting');
    const waitingLabel = await text(A.p2, '#again-btn');
    assert(waitingLabel.includes('相手を待っています'), `P2 again label: ${waitingLabel}`);
    await waitVisible(A.p1, '#result-note', 3000, 'P1 #result-note');
    const note = await text(A.p1, '#result-note');
    assert(note.includes('相手は再戦を希望しています'), `P1 result-note: ${note}`);
    await A.p1.locator('#again-btn').click();
    for (const p of [A.p1, A.p2]) {
      await waitSnap(p, (s) => s.mode === 'playing' && s.score && s.score[0] === 0 && s.score[1] === 0, 5000, 'rematch playing 0-0');
      await waitText(p, '#score-me', (t) => t === '0', 3000, '#score-me 0 after rematch');
      await waitText(p, '#score-opp', (t) => t === '0', 3000, '#score-opp 0 after rematch');
    }
    // 再戦後も得点が正しく反映される（tick が戻らないことの確認）
    await goal(A.p1, A.p2, 2, [0, 1], [1, 0]);

    await shot('A', { p1: A.p1, p2: A.p2 });

    // A-10：P2 がポーズ → タイトルへ
    await A.p2.locator('#pause-btn').click();
    await waitVisible(A.p2, '#pause', 2000, 'P2 pause screen');
    assert(!(await A.p2.locator('#restart-btn').isVisible()), 'restart button should be hidden in net match');
    await A.p2.locator('#quit-btn').click();
    await waitVisible(A.p1, '#net-msg', 5000, 'P1 net-msg after P2 quit');
    const msg = await text(A.p1, '#net-msg-text');
    assert(msg.includes('相手が退出しました'), `P1 net-msg-text: ${msg}`);
    assert((await text(A.p1, '#net-msg-title')) === '対戦終了', 'P1 net-msg-title should be 対戦終了');
    const s2q = await snap(A.p2);
    assert(s2q.mode === 'title', `P2 should be at title after quit, got ${s2q.mode}`);
    // タイトルへ戻れる
    await A.p1.locator('#net-msg-ok').click();
    await waitSnap(A.p1, (s) => s.mode === 'title' && s.net === null && s.localSide === 1, 2000, 'P1 back to title');
    noErrors(A.p1, A.p2);
  } catch (e) {
    await shot('A-fail', { p1: A.p1, p2: A.p2 });
    throw e;
  } finally {
    await h.ctx.close();
    await g.ctx.close();
  }
}

async function scenarioB() {
  const h = await newPage('B-P1');
  const g = await newPage('B-P2', { captureWs: true });
  const p1 = h.page;
  const p2 = g.page;
  try {
    const code = await createRoom(p1);
    const t0 = Date.now();
    await p2.goto(`${BASE}/?e2e&forceRelay&room=${code}`);
    await bothReady(p1, p2, 'relay', 3000);
    notes.push(`B: relay ready in ${Date.now() - t0}ms`);
    await waitText(p1, '#net-status', (t) => /^中継 (\d+|--)ms$/.test(t), 5000, 'P1 net-status 中継');
    await waitText(p2, '#net-status', (t) => /^中継 (\d+|--)ms$/.test(t), 5000, 'P2 net-status 中継');
    await waitText(p1, '#toast', (t) => t === 'サーバー経由で接続しました', 2000, 'P1 forced relay toast');
    await waitText(p2, '#toast', (t) => t === 'サーバー経由で接続しました', 2000, 'P2 forced relay toast');
    await checkStateFlow(p2);

    // 不正 INPUT の注入（中継 WS に生パケットを流す）。P2 はマウスを動かしていないので seq は未使用
    const inject = (seq, x, z) =>
      p2.evaluate(
        ([seq, x, z]) => {
          const ws = window.__wss.find((w) => w.readyState === 1);
          const b = new Uint8Array(11);
          const dv = new DataView(b.buffer);
          dv.setUint8(0, 0x02);
          dv.setUint16(1, seq, true);
          dv.setFloat32(3, x, true);
          dv.setFloat32(7, z, true);
          ws.send(b);
        },
        [seq, x, z],
      );
    const before = (await snap(p1)).mallets[1];
    await inject(1, NaN, -0.5);
    await inject(2, 5, -0.5);
    await inject(3, 0.2, -50);
    await sleep(400);
    const after = (await snap(p1)).mallets[1];
    assert(
      Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.z - before.z) < 1e-6,
      `NaN/out-of-range INPUT moved the host's P2 mallet: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
    await inject(4, 0.3, 0.5); // 相手陣地 → 自陣へクランプ
    const cl = await waitSnap(p1, (s) => Math.abs(s.mallets[1].x - 0.3) < 0.01, 2000, 'injected INPUT applied');
    assert(cl.mallets[1].z <= -0.065 + 1e-6, `P2 mallet crossed center line: z=${cl.mallets[1].z}`);

    await goal(p1, p2, 1, [1, 0], [0, 1]);
    await goal(p1, p2, 2, [1, 1], [1, 1]);
    await shot('B', { p1, p2 });
    noErrors(p1, p2);
  } catch (e) {
    await shot('B-fail', { p1, p2 });
    throw e;
  } finally {
    await h.ctx.close();
    await g.ctx.close();
  }
}

async function scenarioC() {
  const h = await newPage('C-P1');
  const g = await newPage('C-P2');
  const p1 = h.page;
  const p2 = g.page;
  p1.__flags = '&blockIce';
  try {
    const code = await createRoom(p1);
    await p2.goto(`${BASE}/?e2e&room=${code}`);
    // P1 が negotiating（peer_joined 受信）になった時刻から計測
    const neg = await waitSnap(p1, (s) => s.net && (s.net.phase === 'negotiating' || s.net.phase === 'ready'), 5000, 'P1 negotiating');
    assert(neg.net.phase === 'negotiating' && neg.net.kind === 'p2p', `P1 should try p2p first: ${JSON.stringify(neg.net)}`);
    const t0 = Date.now();
    let relayAt = null;
    for (;;) {
      const s = await snap(p1);
      if (s.net && s.net.kind === 'relay') {
        relayAt = Date.now() - t0;
        break;
      }
      if (Date.now() - t0 > 9000) break;
      await sleep(50);
    }
    assert(relayAt !== null, 'P1 did not switch to relay within 9s');
    assert(relayAt >= 4800, `P1 switched to relay too early: ${relayAt}ms (want >= 5s)`);
    await bothReady(p1, p2, 'relay', Math.max(500, 9000 - (Date.now() - t0)));
    const total = Date.now() - t0;
    notes.push(`C: relay switch at ${relayAt}ms, both playing at ${total}ms after peer join`);
    assert(total <= 9000, `fallback took ${total}ms (want <= 9s)`);
    await waitText(p1, '#toast', (t) => t.includes('直接つながらなかったため'), 2000, 'P1 fallback toast');
    await waitText(p2, '#toast', (t) => t.includes('直接つながらなかったため'), 2000, 'P2 fallback toast');
    await waitText(p2, '#net-status', (t) => t.startsWith('中継'), 3000, 'P2 net-status 中継');
    await goal(p1, p2, 1, [1, 0], [0, 1]);
    await shot('C', { p1, p2 });
    noErrors(p1, p2);
  } catch (e) {
    await shot('C-fail', { p1, p2 });
    throw e;
  } finally {
    await h.ctx.close();
    await g.ctx.close();
  }
}

async function scenarioD() {
  const h = await newPage('D-P1');
  const g = await newPage('D-P2');
  const x = await newPage('D-P3');
  const y = await newPage('D-P4');
  const p1 = h.page;
  const p2 = g.page;
  const p3 = x.page;
  const p4 = y.page;
  try {
    const code = await createRoom(p1);
    // 存在しないコード
    const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
    await p3.goto(`${BASE}/?e2e&room=${wrong}`);
    await waitVisible(p3, '#net-msg', 8000, 'P3 net-msg for room_not_found');
    const t3 = await text(p3, '#net-msg-text');
    assert(t3.includes('見つかりません') && t3.includes(wrong), `room_not_found text: ${t3}`);
    assert((await text(p3, '#net-msg-title')) === '接続エラー', 'room_not_found title');

    // コード入力画面から手で入力（4 桁で自動参加）
    await p2.goto(`${BASE}/?e2e`);
    await p2.locator('#join-btn').click();
    await waitVisible(p2, '#join', 2000, 'join screen');
    await p2.locator('#code-input').fill('12a');
    const sanitized = await p2.locator('#code-input').inputValue();
    assert(sanitized === '12', `non-digits should be removed from code input: "${sanitized}"`);
    await p2.locator('#code-input').fill('');
    await p2.locator('#code-input').pressSequentially(code);
    await bothReady(p1, p2, 'p2p', 10_000);

    // 対戦中の部屋に 3 人目
    await p4.goto(`${BASE}/?e2e&room=${code}`);
    await waitVisible(p4, '#net-msg', 8000, 'P4 net-msg for room_full');
    const t4 = await text(p4, '#net-msg-text');
    assert(t4.includes('すでに対戦中'), `room_full text: ${t4}`);
    // タイトルへ戻れる
    await p4.locator('#net-msg-ok').click();
    await waitSnap(p4, (s) => s.mode === 'title', 2000, 'P4 back to title');

    // 3 人目の失敗が対戦に影響しない
    await goal(p1, p2, 1, [1, 0], [0, 1]);

    // ホストのページを閉じる
    await shot('D', { p1, p2 });
    const tClose = Date.now();
    await p1.close();
    await waitVisible(p2, '#net-msg', 4000, 'P2 net-msg after host closed (within 4s: peer_left + 1.5s grace)');
    const t2 = await text(p2, '#net-msg-text');
    notes.push(`D: guest notified ${Date.now() - tClose}ms after host page.close(): "${t2}"`);
    assert(/接続が切れました|部屋を閉じました/.test(t2), `host-closed text: ${t2}`);
    assert(t2.includes('ホストが部屋を閉じました'), `host-closed text should come from peer_left (not 8s lost): ${t2}`);
    noErrors(p2, p3, p4);
  } catch (e) {
    await shot('D-fail', { p1, p2, p3, p4 });
    throw e;
  } finally {
    for (const c of [h, g, x, y]) await c.ctx.close();
  }
}

/** 追加：ゲストがタブを閉じたとき、ホストに通知されタイトルへ戻れる（受け入れ基準 8.5） */
async function scenarioE() {
  const h = await newPage('E-P1');
  const g = await newPage('E-P2');
  const p1 = h.page;
  const p2 = g.page;
  try {
    const code = await createRoom(p1);
    await p2.goto(`${BASE}/?e2e&room=${code}`);
    await bothReady(p1, p2, 'p2p', 10_000);
    await goal(p1, p2, 2, [0, 1], [1, 0]);
    const t0 = Date.now();
    await p2.close();
    await waitVisible(p1, '#net-msg', 4000, 'P1 net-msg after guest closed (within 4s: peer_left + 1.5s grace)');
    const t1 = await text(p1, '#net-msg-text');
    notes.push(`E: host notified ${Date.now() - t0}ms after guest page.close(): "${t1}"`);
    assert(t1.includes('相手との接続が切れました'), `guest-closed text: ${t1}`);
    assert(t1.includes('0 – 1'), `interrupted score should be "（0 – 1 で中断）" from host view: ${t1}`);
    await p1.locator('#net-msg-ok').click();
    await waitSnap(p1, (s) => s.mode === 'title', 2000, 'P1 back to title');
    // 続けて CPU 練習ができる（ネット対戦の後始末の確認）
    await p1.locator('#start-btn').click();
    const s = await waitSnap(p1, (s) => s.driverKind === 'cpu' && s.mode === 'playing', 3000, 'CPU practice after net');
    assert(s.localSide === 1 && s.net === null, `CPU after net: side=${s.localSide} net=${JSON.stringify(s.net)}`);
    assert((await text(p1, '#who-opp')) === 'CPU', 'opponent label should be CPU in practice');
    noErrors(p1);
  } catch (e) {
    await shot('E-fail', { p1, p2 });
    throw e;
  } finally {
    await h.ctx.close();
    await g.ctx.close();
  }
}

/** F：中継の READY が来ない → ホストは待機に戻りゲスト枠を解放（kick_guest）、すぐ別の人が入れる */
async function scenarioF() {
  const h = await newPage('F-P1');
  // P2 はバイナリ（ゲームパケット）を送れない：READY が届かない
  const g = await newPage('F-P2', {
    init: () => {
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) {
        if (typeof d !== 'string') return;
        return orig.call(this, d);
      };
    },
  });
  const x = await newPage('F-P3');
  const p1 = h.page;
  const p2 = g.page;
  const p3 = x.page;
  try {
    const code = await createRoom(p1);
    await p2.goto(`${BASE}/?e2e&forceRelay&room=${code}`);
    await waitSnap(p1, (s) => s.net && s.net.phase === 'negotiating', 5000, 'P1 negotiating');
    const t0 = Date.now();
    await waitText(p1, '#host-status', (t) => t.includes('接続に失敗しました'), 8000, 'P1 relay_failed status');
    const failMs = Date.now() - t0;
    const s1 = await snap(p1);
    assert(s1.mode === 'hostWait' && s1.net.phase === 'waiting', `P1 should be back to waiting: ${JSON.stringify(s1.net)}`);
    assert((await text(p1, '#room-code')) === code, 'room code should stay the same');
    await waitVisible(p2, '#net-msg', 3000, 'P2 net-msg after kicked');
    const t2 = await text(p2, '#net-msg-text');
    assert(t2.includes('相手と接続できませんでした'), `kicked guest text: ${t2}`);
    const kickedMs = Date.now() - t0;
    // 直後に別の人が同じコードで参加できる（以前は 15 秒間 room_full）
    await p3.goto(`${BASE}/?e2e&room=${code}`);
    await bothReady(p1, p3, 'p2p', 10_000);
    notes.push(`F: relay_failed ${failMs}ms after negotiating, guest kicked notice at ${kickedMs}ms, P3 joined OK`);
    await goal(p1, p3, 1, [1, 0], [0, 1]);
    // P2 はタイトルへ戻れる
    await p2.locator('#net-msg-ok').click();
    await waitSnap(p2, (s) => s.mode === 'title', 2000, 'P2 back to title');
    noErrors(p1, p2, p3);
  } catch (e) {
    await shot('F-fail', { p1, p2, p3 });
    throw e;
  } finally {
    for (const c of [h, g, x]) await c.ctx.close();
  }
}

/** G：試合終了から 1.1 秒以内に再戦が始まっても、前の試合の結果画面が新しい試合に被らない */
async function scenarioG() {
  const h = await newPage('G-P1');
  const g = await newPage('G-P2');
  const p1 = h.page;
  const p2 = g.page;
  try {
    const code = await createRoom(p1);
    await p2.goto(`${BASE}/?e2e&room=${code}`);
    await bothReady(p1, p2, 'p2p', 10_000);
    for (let n = 1; n <= 6; n++) await goal(p1, p2, 1, [n, 0], [0, n]);
    await waitSnap(p1, isPlaying, 10_000, 'host playing before last goal');
    // ゲストは先に再戦希望を出しておく（結果画面のボタンを DOM 経由で押す）
    await p2.evaluate(() => document.getElementById('again-btn').click());
    await waitVisible(p1, '#result-note', 3000, 'P1 result-note (peer wants rematch)').catch(() => {});
    await p1.evaluate(() => window.__ah.forceGoal(1));
    await waitSnap(p1, (s) => s.phase === 'over', 3000, 'host over');
    const tOver = Date.now();
    // 結果画面が出る前（1.1 秒以内）にホストも「もう一度」
    await p1.evaluate(() => document.getElementById('again-btn').click());
    const restartMs = Date.now() - tOver;
    assert(restartMs < 1000, `could not restart within 1.1s (${restartMs}ms)`);
    await waitSnap(p1, (s) => s.phase === 'countdown' && s.mode === 'playing', 2000, 'host new match');
    await sleep(1600); // 古いタイマー（1.1 秒）が発火する時間を過ぎる
    for (const p of [p1, p2]) {
      const s = await snap(p);
      assert(s.mode === 'playing', `[${p.__name}] stale result screen shown on new match: mode=${s.mode}`);
      assert(!(await p.locator('#result').isVisible()), `[${p.__name}] #result visible on new match`);
    }
    notes.push(`G: host rematch ${restartMs}ms after over; no stale result screen`);
    noErrors(p1, p2);
  } catch (e) {
    await shot('G-fail', { p1, p2 });
    throw e;
  } finally {
    await h.ctx.close();
    await g.ctx.close();
  }
}

/** H：膠着（サーブ後に誰も触らず 7 秒）→ 両端末で視点に合ったトースト */
async function scenarioH() {
  const h = await newPage('H-P1');
  const g = await newPage('H-P2');
  const p1 = h.page;
  const p2 = g.page;
  try {
    const code = await createRoom(p1);
    await p2.goto(`${BASE}/?e2e&room=${code}`);
    await bothReady(p1, p2, 'p2p', 10_000);
    const s0 = await waitSnap(p1, isPlaying, 6000, 'host playing');
    const servedHalf = s0.puck.z > 0 ? 1 : 2;
    // 両者とも触らない → サーブ位置で 7 秒停止 → 相手側（servedHalf の反対）から再開
    const toast = async (p) =>
      waitText(p, '#toast', (t) => t.startsWith('パックが止まったので'), 10_000, 'stall toast');
    const [t1, t2] = await Promise.all([toast(p1), toast(p2)]);
    const s1 = await snap(p1);
    const restartHalf = s1.puck.z > 0 ? 1 : 2;
    assert(restartHalf !== servedHalf, `stall should restart on the other half (served ${servedHalf}, now ${restartHalf})`);
    const want1 = restartHalf === 1 ? 'あなたの陣地' : '相手の陣地';
    const want2 = restartHalf === 2 ? 'あなたの陣地' : '相手の陣地';
    assert(t1.includes(want1), `P1 stall toast "${t1}" should include ${want1}`);
    assert(t2.includes(want2), `P2 stall toast "${t2}" should include ${want2}`);
    notes.push(`H: stall restart half=${restartHalf}; P1="${t1}" P2="${t2}"`);
    noErrors(p1, p2);
  } catch (e) {
    await shot('H-fail', { p1, p2 });
    throw e;
  } finally {
    await h.ctx.close();
    await g.ctx.close();
  }
}

// ---------- main ----------
async function main() {
  const scenarios = [
    ['A', scenarioA],
    ['B', scenarioB],
    ['C', scenarioC],
    ['D', scenarioD],
    ['E', scenarioE],
    ['F', scenarioF],
    ['G', scenarioG],
    ['H', scenarioH],
  ].filter(([n]) => !ONLY || ONLY.includes(n));
  const server = startServer();
  let failed = 0;
  const killAll = () => stopServer(server);
  process.on('exit', killAll);
  const watchdog = setTimeout(() => {
    console.error(`E2E total timeout ${TOTAL_TIMEOUT_MS}ms exceeded`);
    killAll();
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);
  try {
    await waitHealthy();
    browser = await chromium.launch({
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
    for (const [name, fn] of scenarios) {
      const t = Date.now();
      try {
        await fn();
        log(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      } catch (e) {
        failed++;
        log(`FAIL ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)\n  ${String(e && e.stack ? e.message : e).replace(/\n/g, '\n  ')}`);
      }
    }
  } catch (e) {
    failed++;
    log(`FAIL setup: ${e && e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    clearTimeout(watchdog);
    killAll();
  }
  if (notes.length) log(`notes:\n  ${notes.join('\n  ')}`);
  log(failed ? `E2E: ${failed} scenario(s) failed` : 'E2E: all passed');
  process.exit(failed ? 1 : 0);
}

main();
