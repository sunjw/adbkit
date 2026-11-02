/* global require, process, console, __dirname, setInterval, clearInterval */
// Manual push/pull check against a real device. Not run by mocha.
//
//   npm run compile
//   node test/pushpull.js <local-file> [remote-dir] [serial]
//
// Pushes <local-file> to <remote-dir> (default /sdcard/Download/temp), pulls it
// back into the git-ignored temp/ directory, then compares the MD5 of both
// copies and reports the throughput and peak RSS.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const { Adb } = require('../dist/index.js');

const SRC = process.argv[2];
const REMOTE_DIR = process.argv[3] || '/sdcard/Download/temp';
if (!SRC) {
  console.error('Usage: node test/pushpull.js <local-file> [remote-dir] [serial]');
  process.exit(2);
}
const REMOTE = `${REMOTE_DIR}/${path.basename(SRC)}`;
const LOCAL_DIR = path.join(__dirname, '..', 'temp');
const LOCAL = path.join(LOCAL_DIR, 'pulled.bin');

const hashFile = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

let peakRss = 0;
const mem = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 200);

const mb = (bytes) => (bytes / 1048576).toFixed(0);

const track = (label, transfer, total) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    let last = 0;
    transfer.on('progress', (s) => {
      const now = Date.now();
      if (now - last > 5000) {
        last = now;
        console.log(
          `${label} ${((s.bytesTransferred / total) * 100).toFixed(1)}% rss=${mb(process.memoryUsage().rss)}MB`,
        );
      }
    });
    transfer.on('end', () => resolve(Date.now() - start));
    transfer.on('error', reject);
  });

const report = (label, size, ms) =>
  console.log(`${label} done in ${(ms / 1000).toFixed(1)}s, ${(size / 1048576 / (ms / 1000)).toFixed(1)} MB/s`);

(async () => {
  const client = Adb.createClient();
  const serial = process.argv[4] || (await client.listDevices())[0].id;
  const device = client.getDevice(serial);
  const size = fs.statSync(SRC).size;

  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  execFileSync('adb', ['-s', serial, 'shell', 'mkdir', '-p', REMOTE_DIR]);

  console.log('hashing source...');
  const srcHash = await hashFile(SRC);
  console.log('source md5', srcHash);

  try {
    console.log('push start');
    const pushTransfer = await device.push(SRC, REMOTE);
    report('push', size, await track('push', pushTransfer, size));
    console.log(`peak rss after push ${mb(peakRss)}MB`);

    console.log('pull start');
    const pullTransfer = await device.pull(REMOTE);
    const written = new Promise((resolve, reject) => {
      const out = fs.createWriteStream(LOCAL);
      out.on('finish', resolve);
      out.on('error', reject);
      pullTransfer.pipe(out);
    });
    const pullMs = await track('pull', pullTransfer, size);
    await written;
    report('pull', size, pullMs);

    const pulledSize = fs.statSync(LOCAL).size;
    const pulledHash = await hashFile(LOCAL);
    console.log('pulled size', pulledSize, 'expected', size);
    console.log('pulled md5', pulledHash);
    console.log(srcHash === pulledHash && pulledSize === size ? 'HASH MATCH' : 'HASH MISMATCH');
    console.log(`peak rss ${mb(peakRss)}MB`);
    if (srcHash !== pulledHash) {
      process.exitCode = 1;
    }
  } finally {
    clearInterval(mem);
    fs.rmSync(LOCAL, { force: true });
    execFileSync('adb', ['-s', serial, 'shell', 'rm', '-f', REMOTE]);
  }
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
