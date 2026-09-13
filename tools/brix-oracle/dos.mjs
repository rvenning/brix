// Just enough PC + DOS for BRIX.EXE: EXE loading, a handful of INT 21h
// services, INT 10h/16h/1Ah, the PIT, the VGA retrace bit and the DAC palette.
// Time is derived from the instruction count, so every run is deterministic.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CPU, FLAGS } from './cpu8086.mjs';

const STUB_SEG = 0xf000;
const PSP_SEG = 0x1000;
const ENV_SEG = 0x0f00;
const MEM_TOP = 0xa000;

// Emulated machine speed. Only affects how much CPU work fits in a frame; game
// logic in BRIX is paced by the timer and the retrace, not by CPU speed.
export const IPS = 2_000_000;
const TICK_INS = Math.round(IPS * 65536 / 1193182); // instructions per 18.2 Hz tick
const FRAME_INS = Math.round(IPS / 70);

export class Machine {
  constructor(gameDir, { argv = [], log = () => {} } = {}) {
    this.gameDir = gameDir;
    this.log = log;
    this.cpu = new CPU(this);
    this.files = new Map(); // handle -> { name, data, pos, write }
    this.written = new Map(); // name -> Buffer (files the game created)
    this.nextHandle = 5;
    this.keys = [];
    this.keyReads = 0;
    this.exited = false;
    this.exitCode = null;
    this.palette = new Uint8Array(768);
    this.dacIndex = 0; this.dacComp = 0;
    this.nextTick = TICK_INS;
    this.lowestAlloc = MEM_TOP;
    this.pspTop = MEM_TOP;
    this.pitLatched = false;
    this.picReadIRR = false;
    this.speaker = 0;
    this.setupIVT();
    this.loadExe(path.join(gameDir, 'BRIX.EXE'), argv);
  }

  setupIVT() {
    const m = this.cpu.mem;
    for (let n = 0; n < 256; n++) {
      this.cpu.ww(0, n * 4, n);
      this.cpu.ww(0, n * 4 + 2, STUB_SEG);
      m[(STUB_SEG << 4) + n] = 0xcf; // IRET, so chained calls to an old vector return
    }
    // BIOS data area
    this.cpu.ww(0x40, 0x13, 640); // conventional memory KB
    this.cpu.wb(0x40, 0x49, 3);
  }

  loadExe(file, argv) {
    const exe = fs.readFileSync(file);
    const cpu = this.cpu;
    const lastPage = exe.readUInt16LE(2), pages = exe.readUInt16LE(4);
    const nrel = exe.readUInt16LE(6), hdrParas = exe.readUInt16LE(8);
    const ss = exe.readUInt16LE(0x0e), sp = exe.readUInt16LE(0x10);
    const ip = exe.readUInt16LE(0x14), cs = exe.readUInt16LE(0x16);
    const relo = exe.readUInt16LE(0x18);
    const imageLen = (pages - (lastPage ? 1 : 0)) * 512 + lastPage - hdrParas * 16;
    const loadSeg = PSP_SEG + 0x10;
    cpu.mem.set(exe.subarray(hdrParas * 16, hdrParas * 16 + imageLen), loadSeg << 4);
    for (let i = 0; i < nrel; i++) {
      const off = exe.readUInt16LE(relo + i * 4), seg = exe.readUInt16LE(relo + i * 4 + 2);
      const addr = ((loadSeg + seg) << 4) + off;
      const v = cpu.mem[addr] | (cpu.mem[addr + 1] << 8);
      const nv = (v + loadSeg) & 0xffff;
      cpu.mem[addr] = nv & 0xff; cpu.mem[addr + 1] = nv >> 8;
    }
    // environment: one variable, then the program path
    const env = Buffer.from('COMSPEC=C:\\COMMAND.COM\0\0\x01\0C:\\BRIX.EXE\0', 'latin1');
    cpu.mem.set(env, ENV_SEG << 4);
    // PSP
    cpu.wb(PSP_SEG, 0, 0xcd); cpu.wb(PSP_SEG, 1, 0x20);
    cpu.ww(PSP_SEG, 2, MEM_TOP);
    cpu.ww(PSP_SEG, 0x2c, ENV_SEG);
    const tail = argv.length ? ' ' + argv.join(' ') : '';
    cpu.wb(PSP_SEG, 0x80, tail.length);
    for (let i = 0; i < tail.length; i++) cpu.wb(PSP_SEG, 0x81 + i, tail.charCodeAt(i));
    cpu.wb(PSP_SEG, 0x81 + tail.length, 0x0d);

    cpu.s[0] = PSP_SEG; cpu.s[3] = PSP_SEG;
    cpu.s[2] = (loadSeg + ss) & 0xffff; cpu.r[4] = sp;
    cpu.s[1] = (loadSeg + cs) & 0xffff; cpu.ip = ip;
    cpu.flags = 0x0202;
    this.loadSeg = loadSeg;
  }

  // ---------- time ----------
  get ticks() { return Math.floor(this.cpu.icount / TICK_INS); }
  get ms() { return this.cpu.icount * 1000 / IPS; }

  run(instructions) {
    const cpu = this.cpu;
    const end = cpu.icount + instructions;
    const hooks = this.hooks;
    this.stopRequested = false;
    while (cpu.icount < end && !this.exited && !this.stopRequested) {
      if (cpu.icount >= this.nextTick && (cpu.flags & FLAGS.IF)) {
        this.nextTick += TICK_INS;
        this.timerTick();
      }
      if (cpu.halted) { cpu.icount = Math.max(cpu.icount + 1, Math.min(this.nextTick, end)); continue; }
      if (hooks && cpu.s[1] === this.hookSeg) {
        const h = hooks.get(cpu.ip);
        if (h) h(this);
      }
      cpu.step();
    }
  }
  runMs(ms) { this.run(Math.round(ms * IPS / 1000)); }

  timerTick() {
    const cpu = this.cpu;
    let t = cpu.rw(0x40, 0x6c) | (cpu.rw(0x40, 0x6e) << 16);
    t = (t + 1) >>> 0;
    cpu.ww(0x40, 0x6c, t & 0xffff); cpu.ww(0x40, 0x6e, t >>> 16);
    const off = cpu.rw(0, 0x1c * 4), seg = cpu.rw(0, 0x1c * 4 + 2);
    if (!(seg === STUB_SEG && off === 0x1c)) cpu.hwInterrupt(0x1c);
  }

  // ---------- ports ----------
  portIn(port, size) {
    const cpu = this.cpu;
    switch (port) {
      case 0x3da: {
        const phase = cpu.icount % FRAME_INS;
        return (phase < FRAME_INS / 12 ? 0x08 : 0) | (phase % 400 < 40 ? 1 : 0);
      }
      case 0x40: {
        if (this.pitLatchValue === undefined) {
          const phase = cpu.icount % TICK_INS;
          this.pitLatchValue = (65535 - Math.floor(phase * 65536 / TICK_INS)) & 0xffff;
          this.pitLatchHi = false;
        }
        if (!this.pitLatchHi) { this.pitLatchHi = true; return this.pitLatchValue & 0xff; }
        const v = this.pitLatchValue >> 8; this.pitLatchValue = undefined; return v;
      }
      case 0x20: return (cpu.icount >= this.nextTick) ? 1 : 0;
      case 0x21: return 0;
      case 0x61: return this.speaker;
      case 0x60: return 0;
      case 0x3c9: return 0;
      default:
        return 0xff;
    }
  }
  portOut(port, val, size) {
    switch (port) {
      case 0x43: if ((val & 0xc0) === 0 && (val & 0x30) === 0) { this.pitLatchValue = undefined; } return;
      case 0x61: this.speaker = val; return;
      case 0x3c8: this.dacIndex = val & 0xff; this.dacComp = 0; return;
      case 0x3c9:
        this.palette[this.dacIndex * 3 + this.dacComp] = val & 0x3f;
        if (++this.dacComp === 3) { this.dacComp = 0; this.dacIndex = (this.dacIndex + 1) & 0xff; }
        return;
      default:
        if (size === 2 && (port === 0x3c4 || port === 0x3ce || port === 0x3d4)) return;
    }
  }

  // ---------- interrupts ----------
  int(n, cpu) {
    const off = cpu.rw(0, n * 4), seg = cpu.rw(0, n * 4 + 2);
    if (!(seg === STUB_SEG && off === n)) return false; // hooked by the program
    switch (n) {
      case 0x10: this.int10(cpu); return true;
      case 0x16: this.int16(cpu); return true;
      case 0x1a: this.int1a(cpu); return true;
      case 0x21: this.int21(cpu); return true;
      case 0x00: throw new Error('divide error');
      default:
        this.log(`unhandled int ${n.toString(16)} ah=${(cpu.r[0] >> 8).toString(16)}`);
        return true;
    }
  }

  int10(cpu) {
    const ah = cpu.r[0] >> 8;
    switch (ah) {
      case 0x00:
        this.videoMode = cpu.r[0] & 0x7f;
        cpu.mem.fill(0, 0xa0000, 0xb0000);
        if (this.videoMode === 0x13) this.palette.set(defaultVgaPalette());
        return;
      case 0x0f: cpu.r[0] = (0x28 << 8) | (this.videoMode ?? 3); cpu.set8(7, 0); return;
      case 0x10: {
        const al = cpu.r[0] & 0xff;
        if (al === 0x10) { const i = cpu.r[3]; this.palette[i * 3] = cpu.r[2] >> 8 & 63; this.palette[i * 3 + 1] = cpu.r[1] >> 8 & 63; this.palette[i * 3 + 2] = cpu.r[1] & 63; }
        if (al === 0x12) { const first = cpu.r[3], count = cpu.r[1]; for (let i = 0; i < count * 3; i++) this.palette[first * 3 + i] = cpu.rb(cpu.s[0], cpu.r[2] + i) & 63; }
        return;
      }
      default: this.log(`int10 ah=${ah.toString(16)}`); return;
    }
  }

  int16(cpu) {
    const ah = cpu.r[0] >> 8;
    switch (ah) {
      case 0x00: case 0x10:
        cpu.r[0] = this.keys.length ? this.keys.shift() : 0;
        this.keyReads++;
        return;
      case 0x01: case 0x11:
        if (this.keys.length) { cpu.r[0] = this.keys[0]; cpu.flags &= ~FLAGS.ZF; }
        else cpu.flags |= FLAGS.ZF;
        return;
      case 0x02: cpu.set8(0, 0); return;
      default: this.log(`int16 ah=${ah.toString(16)}`); return;
    }
  }

  int1a(cpu) {
    const ah = cpu.r[0] >> 8;
    if (ah === 0) { cpu.r[1] = cpu.rw(0x40, 0x6e); cpu.r[2] = cpu.rw(0x40, 0x6c); cpu.set8(0, 0); return; }
    this.log(`int1a ah=${ah.toString(16)}`);
  }

  setCarry(on) { this.cpu.setF(FLAGS.CF, on); }

  readAsciiz(seg, off) {
    let s = '';
    for (let i = 0; i < 128; i++) { const c = this.cpu.rb(seg, off + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }

  resolve(name) {
    const base = path.basename(name.replace(/\\/g, '/')).toLowerCase();
    const entries = fs.readdirSync(this.gameDir);
    const hit = entries.find(e => e.toLowerCase() === base);
    return hit ? path.join(this.gameDir, hit) : null;
  }

  int21(cpu) {
    const ah = cpu.r[0] >> 8, al = cpu.r[0] & 0xff;
    const r = cpu.r, s = cpu.s;
    switch (ah) {
      case 0x30: r[0] = 0x0005; r[3] = 0; r[1] = 0; return; // DOS 5.0
      case 0x25: cpu.ww(0, al * 4, r[2]); cpu.ww(0, al * 4 + 2, s[3]); return;
      case 0x35: r[3] = cpu.rw(0, al * 4); s[0] = cpu.rw(0, al * 4 + 2); return;
      case 0x4a: {
        const want = r[3];
        const limit = this.lowestAlloc - s[0];
        if (want > limit) { r[3] = limit; r[0] = 8; this.setCarry(true); return; }
        if (s[0] === PSP_SEG) this.pspTop = PSP_SEG + want;
        this.setCarry(false); return;
      }
      case 0x48: {
        const want = r[3];
        const avail = this.lowestAlloc - this.pspTop - 1;
        if (want > avail) { r[3] = Math.max(0, avail); r[0] = 8; this.setCarry(true); return; }
        this.lowestAlloc -= want;
        r[0] = this.lowestAlloc; this.setCarry(false); return;
      }
      case 0x49: this.setCarry(false); return;
      case 0x4c: this.exited = true; this.exitCode = al; return;
      case 0x3d: {
        const name = this.readAsciiz(s[3], r[2]);
        const lower = path.basename(name).toLowerCase();
        let data;
        if (this.written.has(lower)) data = this.written.get(lower);
        else { const f = this.resolve(name); if (!f) { r[0] = 2; this.setCarry(true); this.log(`open miss ${name}`); return; } data = fs.readFileSync(f); }
        const h = this.nextHandle++;
        this.files.set(h, { name: lower, data: Buffer.from(data), pos: 0, write: (al & 3) !== 0 });
        r[0] = h; this.setCarry(false); return;
      }
      case 0x3c: {
        const name = path.basename(this.readAsciiz(s[3], r[2])).toLowerCase();
        const h = this.nextHandle++;
        this.files.set(h, { name, data: Buffer.alloc(0), pos: 0, write: true });
        this.written.set(name, Buffer.alloc(0));
        r[0] = h; this.setCarry(false); return;
      }
      case 0x3e: {
        const f = this.files.get(r[3]);
        if (f && f.write) this.written.set(f.name, f.data);
        this.files.delete(r[3]); this.setCarry(false); return;
      }
      case 0x3f: {
        const f = this.files.get(r[3]);
        if (!f) { if (r[3] === 0) { r[0] = 0; this.setCarry(false); return; } r[0] = 6; this.setCarry(true); return; }
        const n = Math.min(r[1], f.data.length - f.pos);
        for (let i = 0; i < n; i++) cpu.wb(s[3], r[2] + i, f.data[f.pos + i]);
        f.pos += n; r[0] = n; this.setCarry(false); return;
      }
      case 0x40: {
        const bytes = [];
        for (let i = 0; i < r[1]; i++) bytes.push(cpu.rb(s[3], r[2] + i));
        if (r[3] <= 4) { this.log('stdout: ' + Buffer.from(bytes).toString('latin1')); r[0] = r[1]; this.setCarry(false); return; }
        const f = this.files.get(r[3]);
        if (!f) { r[0] = 6; this.setCarry(true); return; }
        const need = f.pos + bytes.length;
        if (need > f.data.length) { const nb = Buffer.alloc(need); f.data.copy(nb); f.data = nb; }
        Buffer.from(bytes).copy(f.data, f.pos); f.pos += bytes.length;
        r[0] = bytes.length; this.setCarry(false); return;
      }
      case 0x42: {
        const f = this.files.get(r[3]);
        if (!f) { r[0] = 6; this.setCarry(true); return; }
        const offset = ((r[1] << 16) | r[2]) >> 0;
        const base = al === 0 ? 0 : al === 1 ? f.pos : f.data.length;
        f.pos = Math.max(0, base + offset);
        r[2] = f.pos & 0xffff; r[1] = f.pos >>> 16; r[0] = r[2];
        this.setCarry(false); return;
      }
      case 0x43: { const f = this.resolve(this.readAsciiz(s[3], r[2])); if (!f) { r[0] = 2; this.setCarry(true); return; } r[1] = 0x20; this.setCarry(false); return; }
      case 0x41: this.setCarry(false); return;
      case 0x44:
        if (al === 0) { r[2] = r[3] <= 2 ? (0x80 | (r[3] === 0 ? 1 : 2)) : 0; this.setCarry(false); return; }
        this.setCarry(false); return;
      case 0x0b: cpu.set8(0, this.keys.length ? 0xff : 0); return;
      case 0x2a: r[1] = 1991; r[2] = (10 << 8) | 1; cpu.set8(0, 2); return;
      case 0x2c: { const t = this.ms; r[1] = (Math.floor(t / 3600000) % 24 << 8) | Math.floor(t / 60000) % 60; r[2] = (Math.floor(t / 1000) % 60 << 8) | Math.floor(t / 10) % 100; return; }
      case 0x1a: return;
      default:
        this.log(`int21 ah=${ah.toString(16)} al=${al.toString(16)} at ${s[1].toString(16)}:${cpu.ip.toString(16)}`);
        this.setCarry(true); return;
    }
  }

  // Hooks fire before the instruction at seg:ip runs. All hooks share one segment.
  addHook(seg, ip, fn) {
    if (!this.hooks) { this.hooks = new Map(); this.hookSeg = seg; }
    if (seg !== this.hookSeg) throw new Error('hooks must share a segment');
    this.hooks.set(ip, fn);
  }

  snapshot() {
    const c = this.cpu;
    return {
      mem: c.mem.slice(), r: c.r.slice(), s: c.s.slice(), ip: c.ip, flags: c.flags, icount: c.icount,
      nextTick: this.nextTick, keys: this.keys.slice(), palette: this.palette.slice(),
      lowestAlloc: this.lowestAlloc, pspTop: this.pspTop, videoMode: this.videoMode,
      written: new Map(this.written), files: new Map([...this.files].map(([k, v]) => [k, { ...v, data: Buffer.from(v.data) }])),
      nextHandle: this.nextHandle,
    };
  }
  restore(s) {
    const c = this.cpu;
    c.mem.set(s.mem); c.r.set(s.r); c.s.set(s.s); c.ip = s.ip; c.flags = s.flags; c.icount = s.icount; c.halted = false;
    this.nextTick = s.nextTick; this.keys = s.keys.slice(); this.palette.set(s.palette);
    this.lowestAlloc = s.lowestAlloc; this.pspTop = s.pspTop; this.videoMode = s.videoMode;
    this.written = new Map(s.written); this.files = new Map([...s.files].map(([k, v]) => [k, { ...v, data: Buffer.from(v.data) }]));
    this.nextHandle = s.nextHandle; this.exited = false; this.pitLatchValue = undefined;
  }

  // ---------- helpers for tests ----------
  pressScan(scan, ascii = 0) { this.keys.push((scan << 8) | ascii); }

  dataSeg() { return this.loadSeg + 0x93d; }
  peek8(off) { return this.cpu.rb(this.dataSeg(), off); }
  peek16(off) { return this.cpu.rw(this.dataSeg(), off); }
  poke8(off, v) { this.cpu.wb(this.dataSeg(), off, v); }
  poke16(off, v) { this.cpu.ww(this.dataSeg(), off, v); }

  screenPng(file) {
    const W = 320, H = 200;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
      raw[y * (W * 3 + 1)] = 0;
      for (let x = 0; x < W; x++) {
        const c = this.cpu.mem[0xa0000 + y * W + x];
        const o = y * (W * 3 + 1) + 1 + x * 3;
        raw[o] = this.palette[c * 3] * 255 / 63; raw[o + 1] = this.palette[c * 3 + 1] * 255 / 63; raw[o + 2] = this.palette[c * 3 + 2] * 255 / 63;
      }
    }
    fs.writeFileSync(file, encodePng(W, H, raw));
  }
}

// BRIX never programs the DAC; it draws with the BIOS default mode-13h palette.
export function defaultVgaPalette() {
  const p = [];
  const ega = [0x000000, 0x00002a, 0x002a00, 0x002a2a, 0x2a0000, 0x2a002a, 0x2a1500, 0x2a2a2a,
    0x151515, 0x15153f, 0x153f15, 0x153f3f, 0x3f1515, 0x3f153f, 0x3f3f15, 0x3f3f3f];
  for (const c of ega) p.push(c >> 16, (c >> 8) & 0xff, c & 0xff);
  for (const g of [0x00, 0x05, 0x08, 0x0b, 0x0e, 0x11, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x28, 0x2d, 0x32, 0x38, 0x3f]) p.push(g, g, g);
  const seq = [[0,0,4],[1,0,4],[2,0,4],[3,0,4],[4,0,4],[4,0,3],[4,0,2],[4,0,1],[4,0,0],[4,1,0],[4,2,0],[4,3,0],
    [4,4,0],[3,4,0],[2,4,0],[1,4,0],[0,4,0],[0,4,1],[0,4,2],[0,4,3],[0,4,4],[0,3,4],[0,2,4],[0,1,4]];
  const groups = [[0x00,0x10,0x1f,0x2f,0x3f],[0x1f,0x27,0x2f,0x37,0x3f],[0x2d,0x31,0x36,0x3a,0x3f],
    [0x00,0x07,0x0e,0x15,0x1c],[0x0e,0x11,0x15,0x18,0x1c],[0x14,0x16,0x18,0x1a,0x1c],
    [0x00,0x04,0x08,0x0c,0x10],[0x08,0x0a,0x0c,0x0e,0x10],[0x0b,0x0c,0x0d,0x0f,0x10]];
  for (const L of groups) for (const [r, g, b] of seq) p.push(L[r], L[g], L[b]);
  while (p.length < 768) p.push(0);
  return p;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
