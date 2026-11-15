'use strict';
// Assemble source files only. No SSH, TV installation or application launch.
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = require('../tv/zona-runtime.json');
const sha = body => crypto.createHash('sha256').update(body).digest('hex');
function download(address) {
  return new Promise((resolve, reject) => {
    const request = https.get(address, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('Loader HTTP ' + response.statusCode)); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) request.destroy(Error('Loader size limit')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    });
    const deadline = setTimeout(() => request.destroy(Error('Loader deadline')), 20000);
    request.on('close', () => clearTimeout(deadline)); request.on('error', reject);
  });
}
async function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--loader')) throw Error('Use [--loader <reviewed loader-original.js>]');
  const pending = [];
  for (const entry of manifest.entries) {
    if (!/^(autonomy|vendor)\/[A-Za-z0-9._/-]+$/.test(entry.path) || entry.path.split('/').includes('..')) throw Error('Invalid runtime path');
    let body;
    if (entry.source) {
      if (!entry.source.startsWith('tv/zona') || entry.source.split('/').includes('..')) throw Error('Invalid source path');
      body = fs.readFileSync(path.join(root, entry.source));
    } else if (entry.path === 'vendor/loader-original.js' && entry.url === 'https://kinoserial.online/loader.js') {
      body = args.length ? fs.readFileSync(path.resolve(args[1])) : await download(entry.url);
    } else throw Error('Unknown external dependency');
    if (sha(body) !== entry.sha256) throw Error('Reviewed SHA256 differs: ' + entry.path);
    pending.push({entry, body});
  }
  const output = path.join(root, '.build', 'zona-runtime', manifest.version);
  for (const {entry, body} of pending) {
    const file = path.join(output, entry.path); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, body);
  }
  console.log(JSON.stringify({prepared: true, version: manifest.version, files: pending.length, output, tvOperations: 0}));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {main};
