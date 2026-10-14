// Vercel serverless function: a read-only relay from the website to Helius, so the Helius
// key stays in Vercel's private environment (HELIUS_RPC_URL) and never ships to browsers.
// The site calls /api/rpc (VITE_RPC_URL=/api/rpc).
//
// Only the read-only methods the site actually uses are forwarded, so the endpoint can't
// be used to send transactions or run expensive scans on your Helius credits.
const ALLOWED = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getTokenAccountBalance',
  'getSlot',
  'getBlockTime',
  'getBlockHeight',
  'getEpochInfo',
  'getLatestBlockhash',
  'getVersion',
  'getGenesisHash',
]);
const MAX_BATCH = 20;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const target = process.env.HELIUS_RPC_URL;
  if (!target) {
    res.status(500).json({ error: 'HELIUS_RPC_URL is not set' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!body || calls.length === 0 || calls.length > MAX_BATCH) {
    res.status(400).json({ error: 'bad request' });
    return;
  }
  const blocked = calls.find((c) => !c || typeof c.method !== 'string' || !ALLOWED.has(c.method));
  if (blocked) {
    res.status(403).json({ jsonrpc: '2.0', id: blocked?.id ?? null, error: { code: -32601, message: `method not allowed: ${blocked?.method}` } });
    return;
  }
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    res.status(upstream.status);
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.send(await upstream.text());
  } catch {
    res.status(502).json({ error: 'upstream RPC unreachable' });
  }
};
