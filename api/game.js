'use strict';

/**
 * INK GAME — Vercel Serverless API  (/api/game.js)
 *
 * Replaces the Express/Socket.IO server.js for Vercel deployment.
 * Real-time is handled by Ably. Game state is stored in Ably channel
 * presence + a simple in-memory store (per cold-start; use Vercel KV
 * or Upstash Redis for persistence across instances if needed).
 *
 * Setup:
 *   1. npm install ably
 *   2. Set env var:  ABLY_API_KEY=xxxxx.yyyyy:zzzzz  (from ably.com dashboard)
 *   3. Deploy to Vercel — this file lives at /api/game.js
 *
 * Client calls this endpoint via fetch('/api/game', { method:'POST', body: JSON })
 * with { action, ...payload }.
 */

const Ably = require('ably');

// ─── Config ──────────────────────────────────────────────────────────────────
const RLGL_MOVE_THRESHOLD = 0.06;
const RLGL_RESPAWN_X      = -45;
const ATTACK_RANGE        = 2.8;
const ATTACK_ARC          = 110;
const ATTACK_DAMAGE       = 20;
const KNOCKBACK_FORCE     = 6.0;
const TOW_PLANK_Y         = 15.3;
const TOW_FALL_DEATH_Y    = -8;
const TOW_PLANK_HALF_W    = 0.9;

const PHASES = {
  WAITING  : 'WAITING',
  REDLIGHT : 'REDLIGHT',
  TUGOFWAR : 'TUGOFWAR',
  MINGLE   : 'MINGLE',
  RESULTS  : 'RESULTS'
};

const PHASE_DURATIONS = {
  WAITING  : 65000,
  REDLIGHT : 75000,
  TUGOFWAR : 60000,
  MINGLE   : 55000,
  RESULTS  : 12000
};

const TILE_COLORS = ['red','blue','yellow','green','pink','orange','purple','cyan'];

const LOBBY_GUARD_LINES = [
  { at:  0, text: "Welcome, players. You have been brought here for one reason — to compete." },
  { at: 13, text: "The rules are simple. Follow every instruction. Hesitation is the same as failure." },
  { at: 26, text: "You may move freely within this area. Any attempt to breach the barriers will be penalised." },
  { at: 39, text: "Combat is permitted inside the lobby circle. Eliminate your rivals before the games even begin." },
  { at: 52, text: "In thirteen seconds the first game begins. Prepare yourselves. There are no second chances." }
];

// ─── In-memory state (shared within same serverless instance) ─────────────────
// For multi-instance consistency, migrate this to Vercel KV / Upstash Redis.
const players      = global._inkPlayers      || (global._inkPlayers = {});
const towTeams     = global._inkTowTeams     || (global._inkTowTeams = { A: [], B: [] });
let gameState      = global._inkGameState    || (global._inkGameState = {
  phase         : PHASES.WAITING,
  phaseStart    : Date.now(),
  redLightActive: false,
  towRopeOffset : 0,
  mingleTargetSize: 3,
  mingleTiles   : _buildMingleGrid()
});

function _syncGlobal() {
  global._inkPlayers   = players;
  global._inkTowTeams  = towTeams;
  global._inkGameState = gameState;
}

// ─── Ably client (REST for publishing from serverless) ────────────────────────
function getAbly() {
  return new Ably.Rest(process.env.ABLY_API_KEY);
}

async function publish(channel, event, data) {
  const ably = getAbly();
  const ch   = ably.channels.get(channel);
  await ch.publish(event, data);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function deg2rad(d) { return d * (Math.PI / 180); }
function angleDiffDeg(a, b) {
  let d = ((b - a) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}
function vecLen(dx, dz) { return Math.sqrt(dx * dx + dz * dz); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

function createPlayer(id, name) {
  return {
    id, name: name || 'Player',
    x: (Math.random() - 0.5) * 18,
    y: 0,
    z: (Math.random() - 0.5) * 18,
    ry: 0, hp: 100, alive: true, eliminated: false,
    dashCd: 0, prevX: 0, prevZ: 0,
    tapBalance: 0, team: null,
    kbVx: 0, kbVz: 0, kbDecay: 0.82
  };
}

function _buildMingleGrid() {
  const tiles = [];
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 12; c++) {
      tiles.push({
        id: `tile_${r}_${c}`, row: r, col: c,
        x: (c - 5.5) * 2.5, z: (r - 5.5) * 2.5,
        color: TILE_COLORS[Math.floor(Math.random() * TILE_COLORS.length)],
        sunk: false
      });
    }
  }
  return tiles;
}

function _publicSnapshot() {
  const out = {};
  for (const [id, p] of Object.entries(players)) {
    out[id] = { id, name: p.name,
      x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
      ry: +p.ry.toFixed(3), hp: p.hp, alive: p.alive, team: p.team };
  }
  return out;
}

async function _eliminatePlayer(socketId, reason) {
  const p = players[socketId];
  if (!p || p.eliminated) return;
  p.alive = false; p.eliminated = true; p.hp = 0;
  await publish('ink-game', 'playerEliminated', { id: socketId, name: p.name, reason, phase: gameState.phase });
  await publish(`ink-player-${socketId}`, 'selfEliminated', { reason });
}

async function _processTap(socketId) {
  const p = players[socketId];
  if (!p || !p.alive || gameState.phase !== PHASES.TUGOFWAR) return;
  const power = 0.008;
  if (p.team === 'A') {
    gameState.towRopeOffset = clamp(gameState.towRopeOffset - power, -1, 1);
  } else {
    gameState.towRopeOffset = clamp(gameState.towRopeOffset + power, -1, 1);
  }
  await publish('ink-game', 'towUpdate', { offset: gameState.towRopeOffset });
  if (gameState.towRopeOffset <= -1) {
    await publish('ink-game', 'towResult', { winner: 'A' });
    for (const id of towTeams.B) await _eliminatePlayer(id, 'TOW_LOST');
  } else if (gameState.towRopeOffset >= 1) {
    await publish('ink-game', 'towResult', { winner: 'B' });
    for (const id of towTeams.A) await _eliminatePlayer(id, 'TOW_LOST');
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { action, playerId } = body || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });

  try {
    switch (action) {

      // ── Join ──────────────────────────────────────────────────────────────
      case 'join': {
        const name = String(body.name || 'Player').substring(0, 20);
        const id   = body.clientId || `p_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
        players[id] = createPlayer(id, name);
        _syncGlobal();

        await publish('ink-game', 'playerJoined', { id, name });

        return res.json({
          id,
          phase          : gameState.phase,
          duration       : PHASE_DURATIONS[gameState.phase],
          elapsed        : Date.now() - gameState.phaseStart,
          redLightActive : gameState.redLightActive,
          mingleTiles    : gameState.mingleTiles,
          mingleTargetSize: gameState.mingleTargetSize,
          towRopeOffset  : gameState.towRopeOffset,
          players        : _publicSnapshot()
        });
      }

      // ── Leave ─────────────────────────────────────────────────────────────
      case 'leave': {
        const p = players[playerId];
        if (p) {
          await publish('ink-game', 'playerLeft', { id: playerId, name: p.name });
          delete players[playerId];
          towTeams.A = towTeams.A.filter(id => id !== playerId);
          towTeams.B = towTeams.B.filter(id => id !== playerId);
          _syncGlobal();
        }
        return res.json({ ok: true });
      }

      // ── Move ──────────────────────────────────────────────────────────────
      case 'move': {
        const p = players[playerId];
        if (!p) return res.json({ ok: false, reason: 'unknown player' });

        const newX = +body.x || 0, newZ = +body.z || 0;
        const newY = +body.y || 0, newRy = +body.ry || 0;

        if (gameState.phase === PHASES.REDLIGHT && gameState.redLightActive && p.alive && !p.eliminated) {
          const dx = newX - p.prevX, dz = newZ - p.prevZ;
          if (vecLen(dx, dz) > RLGL_MOVE_THRESHOLD) {
            await _eliminatePlayer(playerId, 'RLGL_MOVED');
            _syncGlobal();
            return res.json({ ok: false, snap: { x: RLGL_RESPAWN_X, y: 0, z: p.prevZ } });
          }
        }

        p.prevX = p.x; p.prevZ = p.z;
        p.x = newX; p.y = newY; p.z = newZ; p.ry = newRy;

        if (gameState.phase === PHASES.TUGOFWAR && p.alive && p.y < TOW_FALL_DEATH_Y) {
          await _eliminatePlayer(playerId, 'TOW_FELL');
        }

        // Broadcast position to all others via Ably
        await publish('ink-game', 'playerMoved', {
          id: playerId,
          x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
          ry: +p.ry.toFixed(3), hp: p.hp,
          kbx: +p.kbVx.toFixed(3), kbz: +p.kbVz.toFixed(3)
        });

        _syncGlobal();
        return res.json({ ok: true });
      }

      // ── Dash ──────────────────────────────────────────────────────────────
      case 'dash': {
        const p = players[playerId];
        if (!p || !p.alive) return res.json({ ok: false });
        const now = Date.now();
        if (p.dashCd && now - p.dashCd < 800) return res.json({ ok: false, reason: 'cooldown' });
        p.dashCd = now;
        const angle = body.ry != null ? +body.ry : p.ry;
        p.kbVx += Math.sin(angle) * 14;
        p.kbVz += Math.cos(angle) * 14;
        await publish('ink-game', 'playerDash', { id: playerId, ry: angle });
        _syncGlobal();
        return res.json({ ok: true });
      }

      // ── Attack ────────────────────────────────────────────────────────────
      case 'attack': {
        const attacker = players[playerId];
        if (!attacker || !attacker.alive) return res.json({ hits: [] });

        const hits = [];
        for (const [tid, target] of Object.entries(players)) {
          if (tid === playerId || !target.alive) continue;
          const dx = target.x - attacker.x, dz = target.z - attacker.z;
          const dist = vecLen(dx, dz);
          if (dist > ATTACK_RANGE) continue;
          const toTarget = Math.atan2(dx, dz);
          const diff = Math.abs(angleDiffDeg(
            attacker.ry * (180 / Math.PI),
            toTarget    * (180 / Math.PI)
          ));
          if (diff <= ATTACK_ARC / 2) {
            target.hp = Math.max(0, target.hp - ATTACK_DAMAGE);
            const kbDir = dist > 0.01 ? { x: dx/dist, z: dz/dist } : { x: Math.sin(attacker.ry), z: Math.cos(attacker.ry) };
            target.kbVx += kbDir.x * KNOCKBACK_FORCE;
            target.kbVz += kbDir.z * KNOCKBACK_FORCE;
            hits.push({ id: tid, dmg: ATTACK_DAMAGE, hp: target.hp, kbx: target.kbVx, kbz: target.kbVz });
            if (target.hp <= 0) await _eliminatePlayer(tid, 'KILLED');
          }
        }

        if (hits.length > 0) await publish('ink-game', 'attackHits', { attackerId: playerId, hits });
        _syncGlobal();
        return res.json({ hits });
      }

      // ── Tap (tug-of-war) ──────────────────────────────────────────────────
      case 'tap': {
        await _processTap(playerId);
        _syncGlobal();
        return res.json({ ok: true, offset: gameState.towRopeOffset });
      }

      // ── yUpdate ───────────────────────────────────────────────────────────
      case 'yUpdate': {
        const p = players[playerId];
        if (p) {
          p.y = +body.y || p.y;
          if (gameState.phase === PHASES.TUGOFWAR && p.alive && p.y < TOW_FALL_DEATH_Y) {
            await _eliminatePlayer(playerId, 'TOW_FELL');
            _syncGlobal();
          }
        }
        return res.json({ ok: true });
      }

      // ── Chat ──────────────────────────────────────────────────────────────
      case 'chat': {
        const p = players[playerId];
        if (!p || !body.text) return res.json({ ok: false });
        await publish('ink-game', 'chatMsg', { id: playerId, name: p.name, text: String(body.text).substring(0, 120) });
        return res.json({ ok: true });
      }

      // ── Emote ─────────────────────────────────────────────────────────────
      case 'emote': {
        await publish('ink-game', 'playerEmote', { id: playerId, emote: body.emote });
        return res.json({ ok: true });
      }

      // ── State (for polling fallback) ───────────────────────────────────────
      case 'state': {
        return res.json({
          phase          : gameState.phase,
          duration       : PHASE_DURATIONS[gameState.phase],
          elapsed        : Date.now() - gameState.phaseStart,
          redLightActive : gameState.redLightActive,
          towRopeOffset  : gameState.towRopeOffset,
          mingleTiles    : gameState.mingleTiles,
          mingleTargetSize: gameState.mingleTargetSize,
          players        : _publicSnapshot()
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[INK API]', err);
    return res.status(500).json({ error: err.message });
  }
};
