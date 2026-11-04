/*
 * 打包发布用的 zip。
 * 不用 Compress-Archive：它会把路径写成反斜杠（不符合 ZIP 规范），
 * 且不保证目录结构在 macOS / Linux 上正确解压。
 *
 * 用法：node tools/build-zip.mjs
 * 产物：dist/zhihuishu-auto-continue-v<version>.zip
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 扩展运行时需要的文件；测试、构建脚本、文档都不打进去 */
const INCLUDE = ['manifest.json', 'src', 'icons', 'LICENSE', 'README.md'];

function walk(abs, base = '') {
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(p, rel));
    else out.push(rel);
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function build(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // flags: UTF-8 文件名
    local.writeUInt16LE(8, 8);       // method: deflate
    local.writeUInt16LE(0, 10);      // time
    local.writeUInt16LE(0x21, 12);   // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = [];
for (const item of INCLUDE) {
  const abs = path.join(ROOT, item);
  if (!existsSync(abs)) continue;
  if (item === 'src' || item === 'icons') {
    for (const rel of walk(abs, item)) files.push(rel);
  } else {
    files.push(item);
  }
}

const entries = files.map((name) => ({ name, data: readFileSync(path.join(ROOT, name)) }));
const zip = build(entries);

const outDir = path.join(ROOT, 'dist');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `zhihuishu-auto-continue-v${manifest.version}.zip`);
writeFileSync(out, zip);

console.log('版本 ' + manifest.version);
console.log('文件 ' + entries.length + ' 个，' + (zip.length / 1024).toFixed(1) + ' KB');
entries.forEach((e) => console.log('  ' + e.name.padEnd(30) + e.data.length + 'B'));
console.log('输出 ' + out);
