#!/usr/bin/env bash
# Local validator with Meteora's real mainnet programs cloned in, plus our program.
# The DBC pool authority is cloned because on mainnet it holds SOL that pays rent for
# the DAMM v2 pool and positions created at migration.
# Token-2022 is cloned too: DAMM v2 position NFTs need the mainnet version.
# Usage: ./localnet.sh   (then, in another shell: npm run test:localnet)
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .anchor
PROGRAM_ID=$(solana-keygen pubkey target/deploy/fomocity-keypair.json)

exec solana-test-validator --reset --quiet \
  --ledger .anchor/test-ledger \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --clone Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp \
  --clone FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM \
  --bpf-program "$PROGRAM_ID" target/deploy/fomocity.so
