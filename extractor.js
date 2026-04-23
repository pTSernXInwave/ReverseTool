#!/usr/bin/env node

import fs from "fs";
import path from "path";
import vm from "vm";
import zlib from "zlib";
import crypto from "crypto";

function usage() {
  console.error("Usage: node extractor.js <project-name> [out-root]");
  console.error("Example: node extractor.js example out");
  console.error("Default out-root: _out");
}

function sanitizeRelativePath(inputPath) {
  const normalized = inputPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const safe = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    safe.push(part);
  }
  return safe.join("/");
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function hasKnownExtension(filePath) {
  return /\.[a-zA-Z0-9]+$/.test(path.basename(filePath));
}

function safeBaseName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function bufferToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function base64ToUint8Array(b64) {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function base122ToUint8Array(text) {
  const controls = [0, 10, 13, 34, 38, 92];
  const out = new Uint8Array((1.75 * text.length) | 0);
  let curr = 0;
  let bits = 0;
  let n = 0;

  const write7 = (value) => {
    const shifted = value << 1;
    curr |= shifted >>> bits;
    bits += 7;
    if (bits >= 8) {
      out[n++] = curr & 0xff;
      bits -= 8;
      curr = (shifted << (7 - bits)) & 0xff;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) {
      const ctrlIndex = (code >>> 8) & 7;
      if (ctrlIndex !== 7) write7(controls[ctrlIndex]);
      write7(code & 127);
    } else {
      write7(code);
    }
  }

  return out.slice(0, n);
}

function decodeBrotliToUint8Array(encoded, useBase122) {
  const input = useBase122 ? base122ToUint8Array(encoded) : base64ToUint8Array(encoded);
  const out = zlib.brotliDecompressSync(Buffer.from(input));
  return Uint8Array.from(out);
}

function sniffExtension(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return ".webp";
  if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return ".ogg";
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return ".wav";
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return ".mp3";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return ".mp3";
  return null;
}

function mimeToExtension(mime) {
  const normalized = String(mime || "").toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return ".mp3";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "audio/wav") return ".wav";
  return ".bin";
}

function collectInlineDataUris(source) {
  const out = [];
  const dataUriRegex = /data:([a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=]+)/g;
  let m;

  while ((m = dataUriRegex.exec(source))) {
    const mime = m[1].toLowerCase();
    const base64 = m[2];
    const matchStart = m.index;
    const tagStart = source.lastIndexOf("<", matchStart);
    const tagEnd = source.indexOf(">", matchStart);
    let assetId = null;

    if (tagStart >= 0 && tagEnd > tagStart && tagEnd - tagStart < 200_000) {
      const tagText = source.slice(tagStart, tagEnd + 1);
      const idMatch = tagText.match(/\bid\s*=\s*["']([^"']+)["']/i);
      if (idMatch) assetId = idMatch[1];
    }

    out.push({ mime, base64, assetId });
  }

  return out;
}

function findMatchingParen(source, openParenIndex) {
  let i = openParenIndex + 1;
  let depth = 1;
  let quote = null;
  let escape = false;

  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }

  return -1;
}

function collectCompressedPushExpressions(source) {
  const marker = "window._compressedAssets.push(";
  const expressions = [];
  let from = 0;

  while (from < source.length) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    const openParenIndex = start + marker.length - 1;
    const closeParenIndex = findMatchingParen(source, openParenIndex);
    if (closeParenIndex === -1) break;

    const expr = source.slice(openParenIndex + 1, closeParenIndex);
    expressions.push(expr);
    from = closeParenIndex + 1;
  }

  return expressions;
}

async function run(htmlPath, outDir) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const expressions = collectCompressedPushExpressions(html);
  if (expressions.length === 0) {
    throw new Error("No window._compressedAssets.push(...) entries found.");
  }

  const windowObj = {
    jsons: {},
    blobs: {},
    sounds: {},
    _compressedAssets: [],
    eval: () => {},
  };

  const context = {
    window: windowObj,
    JSON,
    Promise,
    TextDecoder,
    console,
    decompressString: (encoded, isBase122) =>
      Promise.resolve(Buffer.from(decodeBrotliToUint8Array(encoded, isBase122)).toString("utf8")),
    decompressArrayBuffer: (encoded, isBase122) =>
      Promise.resolve(bufferToArrayBuffer(Buffer.from(decodeBrotliToUint8Array(encoded, isBase122)))),
  };

  const vmContext = vm.createContext(context);

  for (const expr of expressions) {
    const script = `window._compressedAssets.push(${expr});`;
    vm.runInContext(script, vmContext, { timeout: 30_000 });
  }

  await Promise.all(windowObj._compressedAssets);

  const absOutDir = path.resolve(outDir);
  fs.mkdirSync(absOutDir, { recursive: true });
  const jsonRoot = path.join(absOutDir, "jsons");
  const blobRoot = path.join(absOutDir, "blobs");
  const soundRoot = path.join(absOutDir, "sounds");
  const inlineRoot = path.join(absOutDir, "inline-assets");

  let jsonCount = 0;
  for (const [assetPath, value] of Object.entries(windowObj.jsons)) {
    const rel = sanitizeRelativePath(assetPath || `json_${jsonCount}.json`);
    const target = path.join(jsonRoot, rel.endsWith(".json") ? rel : `${rel}.json`);
    ensureDirForFile(target);
    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    fs.writeFileSync(target, serialized, "utf8");
    jsonCount++;
  }

  let blobCount = 0;
  for (const [assetPath, value] of Object.entries(windowObj.blobs)) {
    const rel = sanitizeRelativePath(assetPath || `blob_${blobCount}.bin`);

    let buf;
    if (value instanceof ArrayBuffer) {
      buf = Buffer.from(value);
    } else if (ArrayBuffer.isView(value)) {
      buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new Error(`Unsupported blob value type for "${assetPath}"`);
    }

    let relWithExt = rel;
    if (!hasKnownExtension(relWithExt)) {
      const ext = sniffExtension(buf) || ".blob";
      relWithExt += ext;
    }
    const target = path.join(blobRoot, relWithExt);
    ensureDirForFile(target);
    fs.writeFileSync(target, buf);
    blobCount++;
  }

  let soundCount = 0;
  for (const [assetPath, value] of Object.entries(windowObj.sounds)) {
    const rel = sanitizeRelativePath(assetPath || `sound_${soundCount}.bin`);

    let buf;
    if (value instanceof ArrayBuffer) {
      buf = Buffer.from(value);
    } else if (ArrayBuffer.isView(value)) {
      buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new Error(`Unsupported sound value type for "${assetPath}"`);
    }

    let relWithExt = rel;
    if (!hasKnownExtension(relWithExt)) {
      relWithExt += sniffExtension(buf) || ".bin";
    }
    const target = path.join(soundRoot, relWithExt);
    ensureDirForFile(target);
    fs.writeFileSync(target, buf);
    soundCount++;
  }

  const inlineAssets = collectInlineDataUris(html);
  const inlineHashes = new Set();
  let inlineAssetCount = 0;
  for (let i = 0; i < inlineAssets.length; i++) {
    const item = inlineAssets[i];
    const buf = Buffer.from(item.base64, "base64");
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    if (inlineHashes.has(hash)) continue;
    inlineHashes.add(hash);

    const ext = mimeToExtension(item.mime);
    let rel;
    if (item.assetId) {
      rel = sanitizeRelativePath(item.assetId);
      if (!hasKnownExtension(rel)) rel += ext;
    } else {
      rel = `${safeBaseName(item.mime.replace("/", "_"))}_${i}_${hash.slice(0, 10)}${ext}`;
    }

    const target = path.join(inlineRoot, rel);
    ensureDirForFile(target);
    fs.writeFileSync(target, buf);
    inlineAssetCount++;
  }

  const summary = {
    input: path.resolve(htmlPath),
    outputDir: absOutDir,
    compressedEntries: expressions.length,
    jsonCount,
    blobCount,
    soundCount,
    inlineAssetCount,
  };
  fs.writeFileSync(path.join(absOutDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log(
    `Extracted ${jsonCount} json(s), ${blobCount} blob(s), ${soundCount} sound(s), ${inlineAssetCount} inline asset(s) from ${expressions.length} compressed entries.`,
  );
  console.log(`Output: ${absOutDir}`);
}

async function main() {
  const projectName = process.argv[2];
  const outRootArg = process.argv[3] || "_out";
  if (!projectName) {
    usage();
    process.exitCode = 1;
    return;
  }

  const htmlPath = path.resolve(`${projectName}.html`);
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Build file not found: ${htmlPath}`);
  }

  const outRoot = path.resolve(outRootArg);
  const outDir = path.join(outRoot, `${projectName}.extracted`);

  await run(htmlPath, outDir);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exitCode = 1;
});
