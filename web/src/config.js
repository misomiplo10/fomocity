// Which backend to run. No cluster → the local simulator.
//
// Dev / devnet: ?cluster=localnet&mint=<game mint>  (optionally &rpc=<url>)
// Production: set VITE_CLUSTER, VITE_RPC_URL and VITE_MINT at build time. On mainnet the
// URL can't override the RPC or the mint, so a shared link can't point players at a
// lookalike game or a lying RPC.
const DEFAULT_RPC = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

export function chainConfig(search = location.search) {
  const q = new URLSearchParams(search);
  const env = import.meta.env ?? {};
  const cluster = env.VITE_CLUSTER || q.get('cluster');
  if (!cluster) return null;
  if (!(cluster in DEFAULT_RPC)) throw new Error(`unknown cluster "${cluster}"`);
  const locked = cluster === 'mainnet';
  const pick = (k, envKey) => (locked ? env[envKey] : q.get(k) || env[envKey]);
  const rpcUrl = pick('rpc', 'VITE_RPC_URL') || DEFAULT_RPC[cluster];
  const mint = pick('mint', 'VITE_MINT');
  if (!mint) throw new Error('no game mint configured (?mint= or VITE_MINT)');
  return { cluster, rpcUrl, mint };
}
