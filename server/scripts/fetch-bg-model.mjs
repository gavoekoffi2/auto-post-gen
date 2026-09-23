#!/usr/bin/env node
// Fetches the background-removal model used to cut out a poster character.
//
// The model is NOT committed (44 MB of binary in git history forever). It is
// downloaded at image build time (Dockerfile) and before the tests (npm test),
// from a pinned release, and verified against a pinned SHA-256: a corrupted
// or substituted file is refused rather than loaded.
//
//   Model   : "silueta" — U²-Net (Apache-2.0) reduced to 43 MB by the rembg
//             project (MIT). General salient-object segmentation: works for a
//             photographed person and for an illustrated mascot alike.
//   Source  : https://github.com/danielgatis/rembg/releases/tag/v0.0.0
//
// Usage: node scripts/fetch-bg-model.mjs [destination]
// Default destination: models/silueta.onnx next to package.json, which is
// where the API looks unless BG_REMOVAL_MODEL_PATH says otherwise.
//
// The download goes through curl or wget when present, because both honour
// HTTPS_PROXY / https_proxy (Node's built-in fetch does not), then falls back
// to fetch.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx";
export const MODEL_SHA256 = "75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? join(root, "models", "silueta.onnx"));

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function verified(path) {
  return existsSync(path) && sha256(readFileSync(path)) === MODEL_SHA256;
}

function hasCommand(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Each method in turn until one works: a busybox wget without TLS support,
// or a curl blocked by a proxy, must not end the attempt.
async function download(to) {
  const failures = [];
  if (hasCommand("curl")) {
    try {
      execFileSync("curl", ["-fsSL", "--retry", "3", "--max-time", "600", "-o", to, MODEL_URL], { stdio: "inherit" });
      return;
    } catch (err) {
      failures.push(`curl: ${err.message}`);
    }
  }
  if (hasCommand("wget")) {
    try {
      execFileSync("wget", ["-q", "-O", to, MODEL_URL], { stdio: "inherit" });
      return;
    } catch (err) {
      failures.push(`wget: ${err.message}`);
    }
  }
  try {
    const response = await fetch(MODEL_URL, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    writeFileSync(to, Buffer.from(await response.arrayBuffer()));
    return;
  } catch (err) {
    failures.push(`fetch: ${err.message}`);
  }
  throw new Error(failures.join("; "));
}

if (verified(destination)) {
  console.log(`background-removal model present and verified: ${destination}`);
  process.exit(0);
}

mkdirSync(dirname(destination), { recursive: true });
const partial = `${destination}.partial`;
try {
  console.log(`downloading the background-removal model from ${MODEL_URL}`);
  await download(partial);
  const actual = sha256(readFileSync(partial));
  if (actual !== MODEL_SHA256) {
    throw new Error(`checksum mismatch: expected ${MODEL_SHA256}, got ${actual}`);
  }
  renameSync(partial, destination);
  console.log(`background-removal model installed and verified: ${destination}`);
} catch (err) {
  rmSync(partial, { force: true });
  console.error(
    `Could not install the background-removal model (${err.message}).\n` +
      `Download ${MODEL_URL} manually to ${destination} (sha256 ${MODEL_SHA256}), ` +
      `or set BG_REMOVAL_MODEL_PATH to where it is.`,
  );
  process.exit(1);
}
