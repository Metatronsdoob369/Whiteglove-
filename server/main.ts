/**
 * WHITEGLOVE — Binary Entry Point
 *
 * This is what gets compiled and packaged via pkg.
 * Boots the API server with the bundled vault index.
 *
 * Usage (compiled binary):
 *   ./spectral-agent                         # uses bundled vault
 *   VAULT_INDEX=/path/to/index.json ./spectral-agent  # custom vault
 *   PORT=4880 ./spectral-agent
 */

import path from "path";
import fs from "fs";

// When running as a pkg binary, __dirname points inside the snapshot.
// The vault index ships alongside the binary, not inside it (too large).
// We resolve it relative to the binary's actual location on disk.
const binaryDir = path.dirname(process.execPath);
const defaultVaultIndex = path.join(binaryDir, "vault", "index.json");
const vaultIndex = process.env.VAULT_INDEX ?? defaultVaultIndex;

if (!fs.existsSync(vaultIndex)) {
  console.error(`\n[WhiteGlove] Vault index not found: ${vaultIndex}`);
  console.error(`Expected: vault/index.json alongside the binary`);
  console.error(`Run setup: whiteglove-setup (included in package)\n`);
  process.exit(1);
}

// Inject vault path into environment so the API server picks it up
process.env.WG_VAULT_INDEX = vaultIndex;

// Boot the API
import "./api";
