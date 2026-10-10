// web3.js, Anchor and the Meteora SDKs expect Node globals (Buffer, process). Imported
// first by solana.js so they exist before those modules evaluate.
import { Buffer } from 'buffer';

globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, browser: true, version: '', versions: {} };
