#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { copyFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version || '0.0.0';
const date = new Date().toISOString().slice(0, 10);
const outName = `billmaker-v${version}-${date}.apk`;

const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};

console.log(`Building ${outName}`);

run('npm run build', { cwd: root });
run('npx cap sync android', { cwd: root });
run('./gradlew assembleDebug', { cwd: join(root, 'android') });

const src = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!existsSync(src)) {
  console.error(`\nBuild succeeded but APK not found at:\n  ${src}`);
  process.exit(1);
}

const dest = join(root, outName);
copyFileSync(src, dest);

const sizeMB = (statSync(dest).size / 1024 / 1024).toFixed(2);
console.log(`\nDone. Created ${outName} (${sizeMB} MB)`);
console.log(`  ${dest}`);
console.log(`\nShare this file. Recipient needs to allow "Install unknown apps" once on their device.`);
