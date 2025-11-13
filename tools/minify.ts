#!/usr/bin/env bun
/*
  tools/minify.ts

  Bun TypeScript single-file script to:
  - extract inline <style> and inline <script> blocks from an HTML file
  - minify inline CSS (csso)
  - obfuscate inline JS (javascript-obfuscator)
  - optionally rename class and id tokens across HTML/CSS/inline JS
  - finally run html-minifier-terser to collapse whitespace/remove comments

  Usage:
    bun run tools/minify.ts input.html -o output.html --no-rename

  Notes:
  - This is a best-effort tool for single-file static HTML. It focuses on inline
    CSS/JS. External assets (scripts/styles with src/href) are left untouched.
  - Renaming classes/ids is optional and uses simple regex replacements; complex
    JS selectors or runtime string-built selectors might not be updated.
*/

import fs from 'fs';
import path from 'path';
import * as csso from 'csso';
import { minify as minifyHtml } from 'html-minifier-terser';
import * as JavaScriptObfuscator from 'javascript-obfuscator';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: bun run tools/minify.ts <input.html> -o <output.html> [--no-rename]');
  process.exit(1);
}

const inputFile = args[0];
let outputFile = 'index.min.html';
let doRename = true;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if ((a === '-o' || a === '--out' || a === '--output') && args[i+1]) {
    outputFile = args[i+1];
    i++;
  } else if (a === '--no-rename') {
    doRename = false;
  }
}

function shortToken(i: number) {
  // base36 short token (avoid starting with a digit for CSS class safety)
  const s = i.toString(36);
  return '_' + s; // prefix with underscore to be safe
}

const html = fs.readFileSync(inputFile, 'utf8');

// Collect inline <style> blocks
const styleRegex = /<style(.*?)>([\s\S]*?)<\/style>/gi;
let styleMatches: Array<{full: string, attrs: string, content: string}> = [];
let m: RegExpExecArray | null;
while ((m = styleRegex.exec(html)) !== null) {
  styleMatches.push({ full: m[0], attrs: m[1], content: m[2] });
}

// Collect inline <script> blocks without src
const scriptRegex = /<script(?:(?!src)[^>])*?([^>]*)>([\s\S]*?)<\/script>/gi;
let scriptMatches: Array<{full: string, attrs: string, content: string}> = [];
while ((m = scriptRegex.exec(html)) !== null) {
  // Skip scripts with a src attribute in the captured attrs
  const full = m[0];
  const attrs = m[1] || '';
  // crude check for src= inside the full tag (covers both single/double/no quotes)
  const openTag = full.split('>')[0];
  if (/\ssrc\s*=/.test(openTag)) continue;
  scriptMatches.push({ full, attrs, content: m[2] });
}

let outHtml = html;

// 1) Build rename map if requested: collect all class and id tokens from HTML and CSS
let renameMap: Record<string,string> = {};
if (doRename) {
  const classRegex = /class\s*=\s*"([^"]+)"/gi;
  const classSet = new Set<string>();
  while ((m = classRegex.exec(html)) !== null) {
    const arr = m[1].split(/\s+/).filter(Boolean);
    arr.forEach(c => classSet.add(c));
  }

  const idRegex = /id\s*=\s*"([^"]+)"/gi;
  const idSet = new Set<string>();
  while ((m = idRegex.exec(html)) !== null) {
    idSet.add(m[1]);
  }

  // also scan CSS selectors for .name and #id
  const cssSelectorRegex = /(?:\.|#)([A-Za-z0-9_-]+)/g;
  for (const s of styleMatches) {
    let mm: RegExpExecArray | null;
    while ((mm = cssSelectorRegex.exec(s.content)) !== null) {
      const name = mm[1];
      // ignore numeric-only names
      if (/^\d+$/.test(name)) continue;
      classSet.add(name);
    }
  }

  // generate mapping
  let iCnt = 0;
  for (const cls of Array.from(classSet)) {
    if (!renameMap[cls]) renameMap[cls] = shortToken(iCnt++);
  }
  for (const id of Array.from(idSet)) {
    if (!renameMap[id]) renameMap[id] = shortToken(iCnt++);
  }
}

// 2) Process CSS blocks: minify and rename selectors
for (const s of styleMatches) {
  let css = s.content;
  // rename selectors in CSS using simple token replacement for .name and #id
  if (doRename && Object.keys(renameMap).length) {
    for (const [orig, token] of Object.entries(renameMap)) {
      // replace .orig and #orig in selectors
      const esc = orig.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      css = css.replace(new RegExp('([\\.#])' + esc + '(?![A-Za-z0-9_-])', 'g'), (m2: string, p1: string) => p1 + token);
      // replace occurrences in attribute selectors [class~="orig"] etc.
      css = css.replace(new RegExp('(\\[class[^\\]]*?~=\\s*["\']?)' + esc + '(["\']?\\])', 'g'), '$1' + token + '$2');
    }
  }
  // minify CSS
  try {
    const min = csso.minify(css).css;
    outHtml = outHtml.replace(s.full, `<style${s.attrs}>${min}</style>`);
  } catch (err) {
    console.error('CSS minification failed for a block, keeping original. Error:', err);
    // fallback: keep original
  }
}

// 3) Process JS blocks: obfuscate and replace class/id usages inside strings crudely
for (const sc of scriptMatches) {
  let code = sc.content;
  // attempt to replace selector strings in inline JS (".cls", '#id', class names in quotes)
  if (doRename && Object.keys(renameMap).length) {
    for (const [orig, token] of Object.entries(renameMap)) {
      // replace ".orig" and '#orig' inside quoted strings
      const escOrig = orig.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      code = code.replace(new RegExp('(["\'`])([.#])?' + escOrig + "\\1", 'g'), (m2: string) => {
        // m2 contains the full quoted string; replace the token inside it
        return m2.replace(orig, token);
      });
      // replace occurrences like classList.add('orig') or element.id = 'orig'
      code = code.replace(new RegExp("(['\"])" + escOrig + "\\1", 'g'), `$1${token}$2`);
    }
  }

  try {
    const obf = JavaScriptObfuscator.obfuscate(code, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      transformObjectKeys: true,
    });
    const out = obf.getObfuscatedCode();
    // replace the original block
    outHtml = outHtml.replace(sc.full, `<script${sc.attrs}>${out}</script>`);
  } catch (err) {
    console.error('JS obfuscation failed for a block, keeping original. Error:', err);
  }
}

// 4) If rename was requested, replace class/id attributes in the HTML body
if (doRename && Object.keys(renameMap).length) {
  // replace class="a b" tokens
  outHtml = outHtml.replace(/class\s*=\s*"([^"]+)"/gi, (m: string, g1: string) => {
    const parts = g1.split(/\s+/).filter(Boolean).map((p: string) => renameMap[p] || p);
    return `class="${parts.join(' ')}"`;
  });
  // replace id attributes
  outHtml = outHtml.replace(/id\s*=\s*"([^"]+)"/gi, (m: string, g1: string) => {
    const r = renameMap[g1] || g1;
    return `id="${r}"`;
  });
}

// 5) Final HTML minification pass
(async () => {
  try {
    const minified = await minifyHtml(outHtml, {
      collapseWhitespace: true,
      removeComments: true,
      removeAttributeQuotes: false,
      keepClosingSlash: true,
      minifyCSS: false, // already minified
      minifyJS: false, // already obfuscated/minified
    });
    fs.writeFileSync(outputFile, minified, 'utf8');
    console.log(`Wrote optimized file: ${outputFile}`);
    if (doRename) {
      console.log('Note: class/id renaming was applied. Mapping sample (first 10):');
      const entries = Object.entries(renameMap).slice(0, 10);
      for (const [k,v] of entries) console.log(`  ${k} -> ${v}`);
    }
  } catch (err) {
    console.error('Final HTML minification failed:', err);
    // fallback: write the un-minified outHtml
    fs.writeFileSync(outputFile, outHtml, 'utf8');
    console.log(`Wrote non-minified optimized file: ${outputFile}`);
  }
})();
