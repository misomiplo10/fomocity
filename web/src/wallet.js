// Wallet connection. Injected wallets (Phantom, Backpack, Solflare) for real play, plus a
// throwaway burner key for localnet so the game can be tested without an extension.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';

export function injectedWallets() {
  const w = globalThis;
  return [
    ['Phantom', w.phantom?.solana],
    ['Backpack', w.backpack],
    ['Solflare', w.solflare],
  ].filter(([, p]) => p?.connect);
}

export async function connectInjected(name, provider) {
  await provider.connect();
  return {
    name,
    publicKey: new PublicKey(provider.publicKey.toString()),
    signTransaction: (tx) => provider.signTransaction(tx),
    signAllTransactions: (txs) => provider.signAllTransactions(txs),
    disconnect: () => provider.disconnect?.(),
  };
}

const BURNER_KEY = 'fomocity.burner';

// Localnet only: a key kept in this browser's storage and funded by airdrop. It is a test
// key for a local validator, never for real funds.
export async function connectBurner(connection) {
  let kp;
  try {
    const saved = localStorage.getItem(BURNER_KEY);
    if (saved) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  } catch {}
  if (!kp) {
    kp = Keypair.generate();
    try { localStorage.setItem(BURNER_KEY, JSON.stringify([...kp.secretKey])); } catch {}
  }
  if ((await connection.getBalance(kp.publicKey)) < LAMPORTS_PER_SOL) {
    await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  }
  const sign = (tx) => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    name: 'Burner (localnet)',
    publicKey: kp.publicKey,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
    disconnect() {},
  };
}
