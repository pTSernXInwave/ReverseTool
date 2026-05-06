#!/usr/bin/env node

import fs from "fs";
import path from "path";
import zlib from "zlib";

function usage() {
  console.error("Usage: node encode.js <project-name> [out-root]");
  console.error("Example: node encode.js example out");
  console.error("Default out-root: _out");
}

function sanitizeRelativePath(inputPath) {
  const normalized = String(inputPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const safe = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    safe.push(part);
  }
  return safe.join("/");
}

function mimeToExtension(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "image/png") return ".png";
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/webp") return ".webp";
  return ".bin";
}

function hasExtension(filePath) {
  return /\.[a-z0-9]+$/i.test(path.basename(filePath));
}

function encodeBrotliBase64(buf) {
  return zlib.brotliCompressSync(buf).toString("base64");
}

function updateInlineImages(html, inlineRoot) {
  const imageTagPattern =
    /(<img\b[^>]*\bid=(["'])([^"']+)\2[^>]*\bsrc=(["'])data:([a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+);base64,)([A-Za-z0-9+/=]+)(\4)/gi;

  let changedCount = 0;
  let missingCount = 0;
  const missingIds = new Set();

  const updated = html.replace(imageTagPattern, (full, prefix, _q1, id, _q2, mime, oldB64, suffix) => {
    let rel = sanitizeRelativePath(id);
    if (!hasExtension(rel)) rel += mimeToExtension(mime);
    const sourcePath = path.join(inlineRoot, rel);

    if (!fs.existsSync(sourcePath)) {
      missingCount++;
      missingIds.add(rel);
      return full;
    }

    const newB64 = fs.readFileSync(sourcePath).toString("base64");
    if (newB64 !== oldB64) changedCount++;
    return `${prefix}${newB64}${suffix}`;
  });

  return { html: updated, changedCount, missingCount, missingIds: [...missingIds] };
}

function updateSoundExpressions(html, soundsRoot) {
  const soundExprPattern =
    /(decompressArrayBuffer\(\s*")([^"]+)("\s*,\s*)(true|false)(\s*\)\.then\(\s*function\s*\(\s*[^)]*\)\s*\{\s*window\.sounds\[\s*"([^"]+)"\s*\]\s*=)/g;

  let changedCount = 0;
  let missingCount = 0;
  let unsupportedCount = 0;
  const missingPaths = new Set();

  const updated = html.replace(
    soundExprPattern,
    (full, partA, encoded, partB, useBase122Text, partC, soundPath) => {
      const useBase122 = useBase122Text === "true";
      const rel = sanitizeRelativePath(soundPath);
      const sourcePath = path.join(soundsRoot, rel);

      if (!fs.existsSync(sourcePath)) {
        missingCount++;
        missingPaths.add(rel);
        return full;
      }

      if (useBase122) {
        // Current build stores sounds with base64 (false). Keep unsupported safely unchanged.
        unsupportedCount++;
        return full;
      }

      const audioBuf = fs.readFileSync(sourcePath);
      const newEncoded = encodeBrotliBase64(audioBuf);
      if (newEncoded !== encoded) changedCount++;
      return `${partA}${newEncoded}${partB}${useBase122Text}${partC}`;
    },
  );

  return { html: updated, changedCount, missingCount, unsupportedCount, missingPaths: [...missingPaths] };
}

function disablePackageLinkTamperReload(html) {
  let removedCount = 0;

  let updated = html;
  const start = updated.indexOf("function _initSyncDecompression(){");
  if (start >= 0) {
    const end = updated.indexOf("function _fetchFreeWorker", start);
    const blockEnd = end >= 0 ? end : Math.min(updated.length, start + 6000);
    const block = updated.slice(start, blockEnd);

    let relCall = block.indexOf("window['location'][");
    if (relCall < 0) {
      relCall = block.indexOf('window["location"][');
    }

    if (relCall >= 0) {
      const absCall = start + relCall;
      const semi = updated.indexOf(";", absCall);
      if (semi > absCall) {
        updated =
          updated.slice(0, absCall) +
          "void 0/* anti-tamper reload disabled */" +
          updated.slice(semi);
        removedCount++;
      }
    }
  }

  return { html: updated, removedCount };
}

function disablePreloaderIconReloadGuard(html) {
  let removedCount = 0;
  let updated = html;

  const exactObfCall = "window[_0x154337(0x116)][_0x154337(0x117)]();";
  const exactHits = (updated.match(/window\[_0x154337\(0x116\)\]\[_0x154337\(0x117\)\]\(\);/g) || []).length;
  if (exactHits > 0) {
    updated = updated.split(exactObfCall).join("void 0/* preloader icon guard disabled */;");
    removedCount += exactHits;
  }

  // Fallback: plain reload call inside preloader guard function.
  const fnStart = updated.indexOf("function _0x393758(");
  if (fnStart >= 0) {
    const fnEnd = updated.indexOf("function _0x4e71()", fnStart);
    const blockEnd = fnEnd >= 0 ? fnEnd : Math.min(updated.length, fnStart + 4000);
    const block = updated.slice(fnStart, blockEnd);
    if (block.includes("window.location.reload();")) {
      updated = updated.replace("window.location.reload();", "void 0/* preloader icon guard disabled */;");
      removedCount++;
    }
  }

  return { html: updated, removedCount };
}

async function run(projectName, outRootArg) {
  if (!projectName) {
    usage();
    process.exitCode = 1;
    return;
  }

  const outRoot = path.resolve(outRootArg || "_out");
  const buildPath = path.resolve(`${projectName}.html`);
  const extractedDir = path.join(outRoot, `${projectName}.extracted`);
  const inlineDir = path.join(extractedDir, "inline-assets");
  const soundsDir = path.join(extractedDir, "sounds");
  const outputPath = path.join(outRoot, `new_${projectName}.html`);

  if (!fs.existsSync(buildPath)) {
    throw new Error(`Build file not found: ${buildPath}`);
  }
  if (!fs.existsSync(extractedDir)) {
    throw new Error(`Extracted folder not found: ${extractedDir}`);
  }
  if (!fs.existsSync(inlineDir)) {
    throw new Error(`inline-assets folder not found: ${inlineDir}`);
  }
  if (!fs.existsSync(soundsDir)) {
    throw new Error(`sounds folder not found: ${soundsDir}`);
  }

  let html = fs.readFileSync(buildPath, "utf8");

  const inlineResult = updateInlineImages(html, inlineDir);
  html = inlineResult.html;

  const soundResult = updateSoundExpressions(html, soundsDir);
  html = soundResult.html;

  const antiTamperResult = disablePackageLinkTamperReload(html);
  html = antiTamperResult.html;

  const preloaderGuardResult = disablePreloaderIconReloadGuard(html);
  html = preloaderGuardResult.html;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");

  console.log(`Source build: ${buildPath}`);
  console.log(`Extracted dir: ${extractedDir}`);
  console.log(`New build: ${outputPath}`);
  console.log(`Inline images updated: ${inlineResult.changedCount}`);
  console.log(`Sound payloads updated: ${soundResult.changedCount}`);
  console.log(`Inline image files missing: ${inlineResult.missingCount}`);
  console.log(`Sound files missing: ${soundResult.missingCount}`);
  console.log(`Base122 sound payloads skipped: ${soundResult.unsupportedCount}`);
  console.log(`Anti-tamper reload checks removed: ${antiTamperResult.removedCount}`);
  console.log(`Preloader icon guard reloads removed: ${preloaderGuardResult.removedCount}`);

  if (inlineResult.missingIds.length > 0) {
    console.log("Missing inline asset paths (first 20):");
    for (const item of inlineResult.missingIds.slice(0, 20)) {
      console.log(`- ${item}`);
    }
  }
  if (soundResult.missingPaths.length > 0) {
    console.log("Missing sound paths (first 20):");
    for (const item of soundResult.missingPaths.slice(0, 20)) {
      console.log(`- ${item}`);
    }
  }
}

run(process.argv[2], process.argv[3] || "_out").catch((err) => {
  console.error(err.stack || String(err));
  process.exitCode = 1;
});
