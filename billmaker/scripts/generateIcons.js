#!/usr/bin/env node
/**
 * Generates Android launcher icons from inline SVG sources.
 *
 *   1. Renders the SVGs to 1024x1024 PNGs in assets/
 *   2. Runs @capacitor/assets to produce all mipmap-* sizes,
 *      round icons, and the adaptive icon XML
 */
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const root = join(dirname(__filename), '..');
const assetsDir = join(root, 'assets');

// Solid sky-blue + white receipt/bill glyph — used as the legacy launcher icon
// (Android < 8) and as the source for the adaptive-icon foreground.
const ICON_ONLY_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="180" fill="#0284c7"/>
  <g transform="translate(512,512)">
    <rect x="-150" y="-230" width="300" height="460" rx="40" fill="white"/>
    <rect x="-95" y="-150" width="190" height="34" rx="17" fill="#0284c7"/>
    <rect x="-95" y="-80" width="190" height="34" rx="17" fill="#0284c7"/>
    <rect x="-95" y="-10" width="120" height="34" rx="17" fill="#0284c7"/>
  </g>
</svg>`;

// White receipt centered, sized to fit comfortably inside the 66% adaptive
// safe-zone — used for the adaptive-icon foreground layer. The sky-blue lines
// sit over the sky-blue background layer, reading as the receipt's text lines.
const ICON_FOREGROUND_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <g transform="translate(512,512)">
    <rect x="-120" y="-185" width="240" height="370" rx="32" fill="white"/>
    <rect x="-75" y="-120" width="150" height="27" rx="13" fill="#0284c7"/>
    <rect x="-75" y="-65" width="150" height="27" rx="13" fill="#0284c7"/>
    <rect x="-75" y="-10" width="95" height="27" rx="13" fill="#0284c7"/>
  </g>
</svg>`;

// Solid sky-blue for the adaptive-icon background layer.
const ICON_BACKGROUND_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#0284c7"/>
</svg>`;

// Splash source (2732x2732) — the receipt logo centered on a light background.
// The inner group reuses the same receipt glyph as the launcher icon, scaled up.
const RECEIPT_GLYPH = `
    <g transform="translate(-240,-240) scale(15)">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="#0284c7"/>
      <rect x="10" y="7" width="12" height="18" rx="1.5" fill="white"/>
      <rect x="12.5" y="11" width="7" height="1.6" rx="0.8" fill="#0284c7"/>
      <rect x="12.5" y="14.5" width="7" height="1.6" rx="0.8" fill="#0284c7"/>
      <rect x="12.5" y="18" width="4.5" height="1.6" rx="0.8" fill="#0284c7"/>
    </g>`;
const SPLASH_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  <rect width="2732" height="2732" fill="#f8fafc"/>
  <g transform="translate(1366,1366)">${RECEIPT_GLYPH}</g>
</svg>`;
const SPLASH_DARK_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  <rect width="2732" height="2732" fill="#0f172a"/>
  <g transform="translate(1366,1366)">${RECEIPT_GLYPH}</g>
</svg>`;

const renderSvg = async (svg, outName, size = 1024) => {
  const outPath = join(assetsDir, outName);
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
  console.log(`  rendered ${outName}`);
};

mkdirSync(assetsDir, { recursive: true });

console.log('Rendering source PNGs from inline SVGs...');
await renderSvg(ICON_ONLY_SVG, 'icon-only.png');
await renderSvg(ICON_FOREGROUND_SVG, 'icon-foreground.png');
await renderSvg(ICON_BACKGROUND_SVG, 'icon-background.png');
await renderSvg(SPLASH_SVG, 'splash.png', 2732);
await renderSvg(SPLASH_DARK_SVG, 'splash-dark.png', 2732);

console.log('\nRunning @capacitor/assets to produce mipmap assets...');
execSync('npx @capacitor/assets generate --android', { stdio: 'inherit', cwd: root });

console.log('\nDone. Launcher icons updated in android/app/src/main/res/mipmap-*');
