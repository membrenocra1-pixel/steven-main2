'use strict';

/**
 * /api/ably-auth.js
 * Issues short-lived Ably token requests to clients.
 * Requires env var: ABLY_API_KEY
 */

const Ably = require('ably');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const client = new Ably.Rest(process.env.ABLY_API_KEY);
    const tokenRequest = await client.auth.createTokenRequest({
      capability: { 'ink-game': ['subscribe', 'publish'], 'ink-player-*': ['subscribe'] }
    });
    res.json(tokenRequest);
  } catch (err) {
    console.error('[Ably Auth]', err);
    res.status(500).json({ error: err.message });
  }
};
