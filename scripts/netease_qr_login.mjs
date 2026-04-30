import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000';
const COOKIE_FILE = path.resolve(__dirname, '../../data/netease_cookie.txt');

async function main() {
  const keyRes = await fetch(`${BASE}/login/qr/key?timerstamp=${Date.now()}`);
  const keyData = await keyRes.json();
  const unikey = keyData.data.unikey;

  const qrRes = await fetch(`${BASE}/login/qr/create?key=${unikey}&qrimg=true`);
  const qrData = await qrRes.json();

  console.log('\n========================================');
  console.log('  Netease Music QR Code Login');
  console.log('========================================');
  console.log(`\n  Open this URL and scan with Netease App:\n`);
  console.log(`  ${qrData.data.qrurl}\n`);
  console.log('  Waiting for scan... (5 min timeout)\n');

  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await fetch(`${BASE}/login/qr/check?key=${unikey}&timerstamp=${Date.now()}`);
      const data = await res.json();
      const statuses = { 800: 'Waiting for scan...', 801: 'Scanned! Confirm in App', 802: 'Confirmed!', 803: 'SUCCESS' };
      const msg = statuses[data.code] || `code=${data.code}`;
      process.stdout.write(`\r  [${i}] ${msg}                    `);
      if (data.code === 803) {
        console.log('\n\n  Login successful! Cookie saved.\n');
        fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
        fs.writeFileSync(COOKIE_FILE, data.cookie);
        process.exit(0);
      }
      if (![800, 801, 802, 803].includes(data.code)) {
        console.log(`\n  Unexpected: code=${data.code} ${data.message || ''}\n`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`\n  Poll error: ${err.message}`);
    }
  }
  console.log('\n  Timeout.\n');
  process.exit(1);
}

main();
