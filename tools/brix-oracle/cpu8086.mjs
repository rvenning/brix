// A small real-mode 8086 (plus the 186 opcodes Turbo C can emit) interpreter.
// It exists for one purpose: running the original BRIX.EXE headless so the
// modern engine can be checked against the 1991 code. It is not a PC emulator;
// the host (dos.mjs) supplies interrupts, ports and time.

const CF = 0x0001, PF = 0x0004, AF = 0x0010, ZF = 0x0040, SF = 0x0080,
  TF = 0x0100, IF = 0x0200, DF = 0x0400, OF = 0x0800;

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, p = 1;
  while (b) { p ^= b & 1; b >>= 1; }
  PARITY[i] = p;
}

export const REG = { AX: 0, CX: 1, DX: 2, BX: 3, SP: 4, BP: 5, SI: 6, DI: 7 };
export const SEG = { ES: 0, CS: 1, SS: 2, DS: 3 };

export class CPU {
  constructor(host) {
    this.host = host; // { int(n, cpu) -> bool handled, portIn(port, size), portOut(port, val, size) }
    this.mem = new Uint8Array(0x110000);
    this.r = new Uint16Array(8);
    this.s = new Uint16Array(4);
    this.ip = 0;
    this.flags = 0x0002;
    this.halted = false;
    this.icount = 0;
    // decode state
    this.segOverride = -1;
    this.rep = 0;
  }

  // ---------- memory ----------
  rb(seg, off) { return this.mem[((seg << 4) + (off & 0xffff)) & 0xfffff]; }
  rw(seg, off) {
    const a = ((seg << 4) + (off & 0xffff));
    return this.mem[a & 0xfffff] | (this.mem[(a + 1) & 0xfffff] << 8);
  }
  wb(seg, off, v) { this.mem[((seg << 4) + (off & 0xffff)) & 0xfffff] = v; }
  ww(seg, off, v) {
    const a = ((seg << 4) + (off & 0xffff));
    this.mem[a & 0xfffff] = v & 0xff;
    this.mem[(a + 1) & 0xfffff] = (v >> 8) & 0xff;
  }

  fetchb() { const v = this.rb(this.s[1], this.ip); this.ip = (this.ip + 1) & 0xffff; return v; }
  fetchw() { const v = this.rw(this.s[1], this.ip); this.ip = (this.ip + 2) & 0xffff; return v; }
  fetchsb() { const v = this.fetchb(); return v < 0x80 ? v : v - 0x100; }

  // ---------- registers ----------
  get8(i) { return i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >> 8); }
  set8(i, v) {
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & 0x00ff) | ((v & 0xff) << 8);
  }

  push(v) { this.r[4] = (this.r[4] - 2) & 0xffff; this.ww(this.s[2], this.r[4], v); }
  pop() { const v = this.rw(this.s[2], this.r[4]); this.r[4] = (this.r[4] + 2) & 0xffff; return v; }

  getF(f) { return (this.flags & f) !== 0; }
  setF(f, on) { if (on) this.flags |= f; else this.flags &= ~f; }

  // ---------- modrm ----------
  decodeModrm() {
    const m = this.fetchb();
    const mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
    const d = { mod, reg, rm, seg: 0, off: 0 };
    if (mod === 3) return d;
    let off = 0, seg = SEG.DS;
    switch (rm) {
      case 0: off = this.r[3] + this.r[6]; break;
      case 1: off = this.r[3] + this.r[7]; break;
      case 2: off = this.r[5] + this.r[6]; seg = SEG.SS; break;
      case 3: off = this.r[5] + this.r[7]; seg = SEG.SS; break;
      case 4: off = this.r[6]; break;
      case 5: off = this.r[7]; break;
      case 6:
        if (mod === 0) off = this.fetchw();
        else { off = this.r[5]; seg = SEG.SS; }
        break;
      case 7: off = this.r[3]; break;
    }
    if (mod === 1) off += this.fetchsb();
    else if (mod === 2) off += this.fetchw();
    if (this.segOverride >= 0) seg = this.segOverride;
    d.seg = this.s[seg];
    d.off = off & 0xffff;
    return d;
  }
  rmR8(d) { return d.mod === 3 ? this.get8(d.rm) : this.rb(d.seg, d.off); }
  rmW8(d, v) { if (d.mod === 3) this.set8(d.rm, v); else this.wb(d.seg, d.off, v & 0xff); }
  rmR16(d) { return d.mod === 3 ? this.r[d.rm] : this.rw(d.seg, d.off); }
  rmW16(d, v) { if (d.mod === 3) this.r[d.rm] = v; else this.ww(d.seg, d.off, v & 0xffff); }

  // ---------- flags helpers ----------
  szp(v, w) {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    v &= mask;
    this.setF(ZF, v === 0);
    this.setF(SF, (v & sign) !== 0);
    this.setF(PF, PARITY[v & 0xff] === 1);
  }

  alu(op, a, b, w) {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    let res;
    switch (op) {
      case 0: // ADD
      case 2: { // ADC
        const c = op === 2 && this.getF(CF) ? 1 : 0;
        res = a + b + c;
        this.setF(CF, res > mask);
        this.setF(AF, ((a ^ b ^ res) & 0x10) !== 0);
        this.setF(OF, ((~(a ^ b) & (a ^ res)) & sign) !== 0);
        break;
      }
      case 3: // SBB
      case 5: // SUB
      case 7: { // CMP
        const c = op === 3 && this.getF(CF) ? 1 : 0;
        res = a - b - c;
        this.setF(CF, res < 0);
        this.setF(AF, ((a ^ b ^ res) & 0x10) !== 0);
        this.setF(OF, (((a ^ b) & (a ^ res)) & sign) !== 0);
        break;
      }
      case 1: res = a | b; this.setF(CF, false); this.setF(OF, false); this.setF(AF, false); break;
      case 4: res = a & b; this.setF(CF, false); this.setF(OF, false); this.setF(AF, false); break;
      case 6: res = a ^ b; this.setF(CF, false); this.setF(OF, false); this.setF(AF, false); break;
    }
    res &= mask;
    this.szp(res, w);
    return op === 7 ? a : res;
  }

  inc(v, w) {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    const res = (v + 1) & mask;
    this.setF(OF, res === sign);
    this.setF(AF, (res & 0xf) === 0);
    this.szp(res, w);
    return res;
  }
  dec(v, w) {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    const res = (v - 1) & mask;
    this.setF(OF, v === sign);
    this.setF(AF, (v & 0xf) === 0);
    this.szp(res, w);
    return res;
  }

  shift(op, v, count, w) {
    const bits = w ? 16 : 8, mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    count &= 0x1f;
    if (count === 0) return v;
    let cf = this.getF(CF) ? 1 : 0;
    switch (op) {
      case 0: // ROL
        for (let i = 0; i < count; i++) { cf = (v & sign) ? 1 : 0; v = ((v << 1) | cf) & mask; }
        this.setF(CF, cf); this.setF(OF, (((v & sign) ? 1 : 0) ^ cf) === 1);
        return v;
      case 1: // ROR
        for (let i = 0; i < count; i++) { cf = v & 1; v = (v >> 1) | (cf ? sign : 0); }
        this.setF(CF, cf); this.setF(OF, (((v >> (bits - 1)) ^ (v >> (bits - 2))) & 1) === 1);
        return v;
      case 2: // RCL
        for (let i = 0; i < count; i++) { const nc = (v & sign) ? 1 : 0; v = ((v << 1) | cf) & mask; cf = nc; }
        this.setF(CF, cf); this.setF(OF, (((v & sign) ? 1 : 0) ^ cf) === 1);
        return v;
      case 3: // RCR
        for (let i = 0; i < count; i++) { const nc = v & 1; v = (v >> 1) | (cf ? sign : 0); cf = nc; }
        this.setF(CF, cf); this.setF(OF, (((v >> (bits - 1)) ^ (v >> (bits - 2))) & 1) === 1);
        return v;
      case 4: case 6: { // SHL/SAL
        let res = v;
        for (let i = 0; i < count; i++) { cf = (res & sign) ? 1 : 0; res = (res << 1) & mask; }
        this.setF(CF, cf); this.setF(OF, (((res & sign) ? 1 : 0) ^ cf) === 1);
        this.szp(res, w);
        return res;
      }
      case 5: { // SHR
        let res = v;
        this.setF(OF, (v & sign) !== 0);
        for (let i = 0; i < count; i++) { cf = res & 1; res >>= 1; }
        this.setF(CF, cf);
        this.szp(res, w);
        return res;
      }
      case 7: { // SAR
        let res = v;
        for (let i = 0; i < count; i++) { cf = res & 1; res = (res >> 1) | (res & sign); }
        this.setF(CF, cf); this.setF(OF, false);
        this.szp(res, w);
        return res;
      }
    }
    return v;
  }

  cond(c) {
    const f = this.flags;
    let r;
    switch (c >> 1) {
      case 0: r = (f & OF) !== 0; break;
      case 1: r = (f & CF) !== 0; break;
      case 2: r = (f & ZF) !== 0; break;
      case 3: r = (f & (CF | ZF)) !== 0; break;
      case 4: r = (f & SF) !== 0; break;
      case 5: r = (f & PF) !== 0; break;
      case 6: r = ((f & SF) !== 0) !== ((f & OF) !== 0); break;
      case 7: r = (f & ZF) !== 0 || (((f & SF) !== 0) !== ((f & OF) !== 0)); break;
    }
    return (c & 1) ? !r : r;
  }

  interrupt(n) {
    if (this.host.int(n, this)) return;
    this.push(this.flags);
    this.push(this.s[1]);
    this.push(this.ip);
    this.flags &= ~(IF | TF);
    this.ip = this.rw(0, n * 4);
    this.s[1] = this.rw(0, n * 4 + 2);
  }

  // Dispatch a hardware interrupt as a real vectored call (used for the timer).
  hwInterrupt(n) {
    this.halted = false;
    this.push(this.flags);
    this.push(this.s[1]);
    this.push(this.ip);
    this.flags &= ~(IF | TF);
    this.ip = this.rw(0, n * 4);
    this.s[1] = this.rw(0, n * 4 + 2);
  }

  // ---------- string ops ----------
  stringOp(op) {
    const w = op & 1;
    const step = (this.flags & DF) ? (w ? -2 : -1) : (w ? 2 : 1);
    const srcSeg = this.s[this.segOverride >= 0 ? this.segOverride : SEG.DS];
    const kind = op & 0xfe;
    const once = () => {
      switch (kind) {
        case 0xa4: // MOVS
          if (w) this.ww(this.s[0], this.r[7], this.rw(srcSeg, this.r[6]));
          else this.wb(this.s[0], this.r[7], this.rb(srcSeg, this.r[6]));
          this.r[6] += step; this.r[7] += step;
          break;
        case 0xa6: { // CMPS
          const a = w ? this.rw(srcSeg, this.r[6]) : this.rb(srcSeg, this.r[6]);
          const b = w ? this.rw(this.s[0], this.r[7]) : this.rb(this.s[0], this.r[7]);
          this.alu(7, a, b, w);
          this.r[6] += step; this.r[7] += step;
          break;
        }
        case 0xaa: // STOS
          if (w) this.ww(this.s[0], this.r[7], this.r[0]);
          else this.wb(this.s[0], this.r[7], this.r[0] & 0xff);
          this.r[7] += step;
          break;
        case 0xac: // LODS
          if (w) this.r[0] = this.rw(srcSeg, this.r[6]);
          else this.set8(0, this.rb(srcSeg, this.r[6]));
          this.r[6] += step;
          break;
        case 0xae: { // SCAS
          const b = w ? this.rw(this.s[0], this.r[7]) : this.rb(this.s[0], this.r[7]);
          this.alu(7, w ? this.r[0] : this.r[0] & 0xff, b, w);
          this.r[7] += step;
          break;
        }
      }
    };
    if (!this.rep) { once(); return; }
    const conditional = kind === 0xa6 || kind === 0xae;
    while (this.r[1] !== 0) {
      once();
      this.r[1]--;
      if (conditional) {
        const z = this.getF(ZF);
        if (this.rep === 0xf3 && !z) break;
        if (this.rep === 0xf2 && z) break;
      }
    }
  }

  // ---------- execution ----------
  step() {
    this.segOverride = -1;
    this.rep = 0;
    const startIp = this.ip;
    let op = this.fetchb();
    for (;;) {
      if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) {
        this.segOverride = (op >> 3) & 3; op = this.fetchb();
      } else if (op === 0xf2 || op === 0xf3) {
        this.rep = op; op = this.fetchb();
      } else if (op === 0xf0) {
        op = this.fetchb();
      } else break;
    }
    this.icount++;
    const r = this.r, s = this.s;

    // ALU block 00-3F
    if (op < 0x40 && (op & 7) < 6) {
      const aop = op >> 3;
      switch (op & 7) {
        case 0: { const d = this.decodeModrm(); const v = this.alu(aop, this.rmR8(d), this.get8(d.reg), 0); if (aop !== 7) this.rmW8(d, v); return; }
        case 1: { const d = this.decodeModrm(); const v = this.alu(aop, this.rmR16(d), r[d.reg], 1); if (aop !== 7) this.rmW16(d, v); return; }
        case 2: { const d = this.decodeModrm(); const v = this.alu(aop, this.get8(d.reg), this.rmR8(d), 0); if (aop !== 7) this.set8(d.reg, v); return; }
        case 3: { const d = this.decodeModrm(); const v = this.alu(aop, r[d.reg], this.rmR16(d), 1); if (aop !== 7) r[d.reg] = v; return; }
        case 4: { const v = this.alu(aop, r[0] & 0xff, this.fetchb(), 0); if (aop !== 7) this.set8(0, v); return; }
        case 5: { const v = this.alu(aop, r[0], this.fetchw(), 1); if (aop !== 7) r[0] = v; return; }
      }
    }

    switch (op) {
      case 0x06: this.push(s[0]); return;
      case 0x07: s[0] = this.pop(); return;
      case 0x0e: this.push(s[1]); return;
      case 0x0f: s[1] = this.pop(); return;
      case 0x16: this.push(s[2]); return;
      case 0x17: s[2] = this.pop(); return;
      case 0x1e: this.push(s[3]); return;
      case 0x1f: s[3] = this.pop(); return;
      case 0x27: { // DAA
        let al = r[0] & 0xff; const oldCF = this.getF(CF);
        if ((al & 0xf) > 9 || this.getF(AF)) { al += 6; this.setF(AF, true); } else this.setF(AF, false);
        if ((r[0] & 0xff) > 0x99 || oldCF) { al += 0x60; this.setF(CF, true); } else this.setF(CF, false);
        this.set8(0, al); this.szp(al & 0xff, 0); return;
      }
      case 0x2f: { // DAS
        let al = r[0] & 0xff; const oldAL = al, oldCF = this.getF(CF);
        if ((al & 0xf) > 9 || this.getF(AF)) { al -= 6; this.setF(AF, true); } else this.setF(AF, false);
        if (oldAL > 0x99 || oldCF) { al -= 0x60; this.setF(CF, true); } else this.setF(CF, false);
        this.set8(0, al); this.szp(al & 0xff, 0); return;
      }
      case 0x37: // AAA
        if ((r[0] & 0xf) > 9 || this.getF(AF)) { r[0] = (r[0] + 0x106) & 0xffff; this.setF(AF, true); this.setF(CF, true); }
        else { this.setF(AF, false); this.setF(CF, false); }
        r[0] &= 0xff0f; return;
      case 0x3f: // AAS
        if ((r[0] & 0xf) > 9 || this.getF(AF)) { r[0] = (r[0] - 6) & 0xffff; r[0] = (r[0] - 0x100) & 0xffff; this.setF(AF, true); this.setF(CF, true); }
        else { this.setF(AF, false); this.setF(CF, false); }
        r[0] &= 0xff0f; return;
    }
    if (op >= 0x40 && op <= 0x47) { r[op - 0x40] = this.inc(r[op - 0x40], 1); return; }
    if (op >= 0x48 && op <= 0x4f) { r[op - 0x48] = this.dec(r[op - 0x48], 1); return; }
    if (op >= 0x50 && op <= 0x57) {
      if (op === 0x54) { const v = r[4]; this.push(v); } else this.push(r[op - 0x50]);
      return;
    }
    if (op >= 0x58 && op <= 0x5f) { r[op - 0x58] = this.pop(); return; }
    if (op >= 0x70 && op <= 0x7f) { const d = this.fetchsb(); if (this.cond(op - 0x70)) this.ip = (this.ip + d) & 0xffff; return; }
    if (op >= 0x90 && op <= 0x97) { const t = r[0]; r[0] = r[op - 0x90]; r[op - 0x90] = t; return; }
    if (op >= 0xb0 && op <= 0xb7) { this.set8(op - 0xb0, this.fetchb()); return; }
    if (op >= 0xb8 && op <= 0xbf) { r[op - 0xb8] = this.fetchw(); return; }
    if (op >= 0xd8 && op <= 0xdf) { this.decodeModrm(); return; } // FPU escape: ignore

    switch (op) {
      case 0x60: { const sp = r[4]; for (let i = 0; i < 8; i++) this.push(i === 4 ? sp : r[i]); return; }
      case 0x61: { for (let i = 7; i >= 0; i--) { const v = this.pop(); if (i !== 4) r[i] = v; } return; }
      case 0x68: this.push(this.fetchw()); return;
      case 0x6a: this.push(this.fetchsb() & 0xffff); return;
      case 0x69: case 0x6b: {
        const d = this.decodeModrm();
        const a = this.rmR16(d) << 16 >> 16;
        const b = op === 0x69 ? (this.fetchw() << 16 >> 16) : this.fetchsb();
        const res = a * b;
        r[d.reg] = res & 0xffff;
        const over = res !== ((res & 0xffff) << 16 >> 16);
        this.setF(CF, over); this.setF(OF, over);
        return;
      }
      case 0x80: case 0x82: { const d = this.decodeModrm(); const v = this.alu(d.reg, this.rmR8(d), this.fetchb(), 0); if (d.reg !== 7) this.rmW8(d, v); return; }
      case 0x81: { const d = this.decodeModrm(); const v = this.alu(d.reg, this.rmR16(d), this.fetchw(), 1); if (d.reg !== 7) this.rmW16(d, v); return; }
      case 0x83: { const d = this.decodeModrm(); const v = this.alu(d.reg, this.rmR16(d), this.fetchsb() & 0xffff, 1); if (d.reg !== 7) this.rmW16(d, v); return; }
      case 0x84: { const d = this.decodeModrm(); this.alu(4, this.rmR8(d), this.get8(d.reg), 0); return; }
      case 0x85: { const d = this.decodeModrm(); this.alu(4, this.rmR16(d), r[d.reg], 1); return; }
      case 0x86: { const d = this.decodeModrm(); const t = this.rmR8(d); this.rmW8(d, this.get8(d.reg)); this.set8(d.reg, t); return; }
      case 0x87: { const d = this.decodeModrm(); const t = this.rmR16(d); this.rmW16(d, r[d.reg]); r[d.reg] = t; return; }
      case 0x88: { const d = this.decodeModrm(); this.rmW8(d, this.get8(d.reg)); return; }
      case 0x89: { const d = this.decodeModrm(); this.rmW16(d, r[d.reg]); return; }
      case 0x8a: { const d = this.decodeModrm(); this.set8(d.reg, this.rmR8(d)); return; }
      case 0x8b: { const d = this.decodeModrm(); r[d.reg] = this.rmR16(d); return; }
      case 0x8c: { const d = this.decodeModrm(); this.rmW16(d, s[d.reg & 3]); return; }
      case 0x8d: { const d = this.decodeModrm(); r[d.reg] = d.off; return; }
      case 0x8e: { const d = this.decodeModrm(); s[d.reg & 3] = this.rmR16(d); return; }
      case 0x8f: { const d = this.decodeModrm(); this.rmW16(d, this.pop()); return; }
      case 0x98: r[0] = ((r[0] & 0xff) << 24 >> 24) & 0xffff; return;
      case 0x99: r[2] = (r[0] & 0x8000) ? 0xffff : 0; return;
      case 0x9a: { const o = this.fetchw(), sg = this.fetchw(); this.push(s[1]); this.push(this.ip); s[1] = sg; this.ip = o; return; }
      case 0x9b: return;
      case 0x9c: this.push(this.flags | 0xf002); return;
      case 0x9d: this.flags = (this.pop() & 0x0fd5) | 0x0002; return;
      case 0x9e: this.flags = (this.flags & 0xff00) | (r[0] >> 8 & 0xd5) | 2; return;
      case 0x9f: this.set8(4, this.flags & 0xff); return;
      case 0xa0: { const o = this.fetchw(); this.set8(0, this.rb(s[this.segOverride >= 0 ? this.segOverride : 3], o)); return; }
      case 0xa1: { const o = this.fetchw(); r[0] = this.rw(s[this.segOverride >= 0 ? this.segOverride : 3], o); return; }
      case 0xa2: { const o = this.fetchw(); this.wb(s[this.segOverride >= 0 ? this.segOverride : 3], o, r[0] & 0xff); return; }
      case 0xa3: { const o = this.fetchw(); this.ww(s[this.segOverride >= 0 ? this.segOverride : 3], o, r[0]); return; }
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        this.stringOp(op); return;
      case 0xa8: this.alu(4, r[0] & 0xff, this.fetchb(), 0); return;
      case 0xa9: this.alu(4, r[0], this.fetchw(), 1); return;
      case 0xc0: case 0xc1: {
        const d = this.decodeModrm(); const w = op & 1;
        const v = w ? this.rmR16(d) : this.rmR8(d);
        const res = this.shift(d.reg, v, this.fetchb(), w);
        if (w) this.rmW16(d, res); else this.rmW8(d, res);
        return;
      }
      case 0xc2: { const n = this.fetchw(); this.ip = this.pop(); r[4] = (r[4] + n) & 0xffff; return; }
      case 0xc3: this.ip = this.pop(); return;
      case 0xc4: { const d = this.decodeModrm(); r[d.reg] = this.rw(d.seg, d.off); s[0] = this.rw(d.seg, d.off + 2); return; }
      case 0xc5: { const d = this.decodeModrm(); r[d.reg] = this.rw(d.seg, d.off); s[3] = this.rw(d.seg, d.off + 2); return; }
      case 0xc6: { const d = this.decodeModrm(); this.rmW8(d, this.fetchb()); return; }
      case 0xc7: { const d = this.decodeModrm(); this.rmW16(d, this.fetchw()); return; }
      case 0xc8: {
        const size = this.fetchw(); const level = this.fetchb() & 0x1f;
        this.push(r[5]); const frame = r[4];
        for (let i = 1; i < level; i++) { r[5] = (r[5] - 2) & 0xffff; this.push(this.rw(s[2], r[5])); }
        if (level > 0) this.push(frame);
        r[5] = frame; r[4] = (r[4] - size) & 0xffff;
        return;
      }
      case 0xc9: r[4] = r[5]; r[5] = this.pop(); return;
      case 0xca: { const n = this.fetchw(); this.ip = this.pop(); s[1] = this.pop(); r[4] = (r[4] + n) & 0xffff; return; }
      case 0xcb: this.ip = this.pop(); s[1] = this.pop(); return;
      case 0xcc: this.interrupt(3); return;
      case 0xcd: this.interrupt(this.fetchb()); return;
      case 0xce: if (this.getF(OF)) this.interrupt(4); return;
      case 0xcf: this.ip = this.pop(); s[1] = this.pop(); this.flags = (this.pop() & 0x0fd5) | 2; return;
      case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const d = this.decodeModrm(); const w = op & 1;
        const count = op >= 0xd2 ? r[1] & 0xff : 1;
        const v = w ? this.rmR16(d) : this.rmR8(d);
        const res = this.shift(d.reg, v, count, w);
        if (w) this.rmW16(d, res); else this.rmW8(d, res);
        return;
      }
      case 0xd4: { const base = this.fetchb(); if (base === 0) { this.interrupt(0); return; } const al = r[0] & 0xff; this.set8(4, Math.floor(al / base)); this.set8(0, al % base); this.szp(r[0] & 0xff, 0); return; }
      case 0xd5: { const base = this.fetchb(); const v = ((r[0] >> 8) * base + (r[0] & 0xff)) & 0xff; r[0] = v; this.szp(v, 0); return; }
      case 0xd6: this.set8(0, this.getF(CF) ? 0xff : 0); return;
      case 0xd7: this.set8(0, this.rb(s[this.segOverride >= 0 ? this.segOverride : 3], (r[3] + (r[0] & 0xff)) & 0xffff)); return;
      case 0xe0: case 0xe1: case 0xe2: {
        const d = this.fetchsb(); r[1] = (r[1] - 1) & 0xffff;
        let take = r[1] !== 0;
        if (op === 0xe0) take = take && !this.getF(ZF);
        if (op === 0xe1) take = take && this.getF(ZF);
        if (take) this.ip = (this.ip + d) & 0xffff;
        return;
      }
      case 0xe3: { const d = this.fetchsb(); if (r[1] === 0) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe4: this.set8(0, this.host.portIn(this.fetchb(), 1) & 0xff); return;
      case 0xe5: r[0] = this.host.portIn(this.fetchb(), 2) & 0xffff; return;
      case 0xe6: this.host.portOut(this.fetchb(), r[0] & 0xff, 1); return;
      case 0xe7: this.host.portOut(this.fetchb(), r[0], 2); return;
      case 0xe8: { const d = this.fetchw(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.fetchw(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const o = this.fetchw(), sg = this.fetchw(); this.ip = o; s[1] = sg; return; }
      case 0xeb: { const d = this.fetchsb(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xec: this.set8(0, this.host.portIn(r[2], 1) & 0xff); return;
      case 0xed: r[0] = this.host.portIn(r[2], 2) & 0xffff; return;
      case 0xee: this.host.portOut(r[2], r[0] & 0xff, 1); return;
      case 0xef: this.host.portOut(r[2], r[0], 2); return;
      case 0xf4: this.halted = true; return;
      case 0xf5: this.flags ^= CF; return;
      case 0xf6: case 0xf7: this.group3(op & 1); return;
      case 0xf8: this.setF(CF, false); return;
      case 0xf9: this.setF(CF, true); return;
      case 0xfa: this.setF(IF, false); return;
      case 0xfb: this.setF(IF, true); return;
      case 0xfc: this.setF(DF, false); return;
      case 0xfd: this.setF(DF, true); return;
      case 0xfe: {
        const d = this.decodeModrm();
        if (d.reg === 0) this.rmW8(d, this.inc(this.rmR8(d), 0));
        else if (d.reg === 1) this.rmW8(d, this.dec(this.rmR8(d), 0));
        else throw new Error(`bad FE /${d.reg} at ${s[1].toString(16)}:${startIp.toString(16)}`);
        return;
      }
      case 0xff: {
        const d = this.decodeModrm();
        switch (d.reg) {
          case 0: this.rmW16(d, this.inc(this.rmR16(d), 1)); return;
          case 1: this.rmW16(d, this.dec(this.rmR16(d), 1)); return;
          case 2: { const t = this.rmR16(d); this.push(this.ip); this.ip = t; return; }
          case 3: { const o = this.rw(d.seg, d.off), sg = this.rw(d.seg, d.off + 2); this.push(s[1]); this.push(this.ip); this.ip = o; s[1] = sg; return; }
          case 4: this.ip = this.rmR16(d); return;
          case 5: { this.ip = this.rw(d.seg, d.off); s[1] = this.rw(d.seg, d.off + 2); return; }
          case 6: this.push(this.rmR16(d)); return;
        }
        break;
      }
    }
    throw new Error(`unimplemented opcode ${op.toString(16)} at ${s[1].toString(16)}:${startIp.toString(16)}`);
  }

  group3(w) {
    const d = this.decodeModrm();
    const r = this.r;
    const v = w ? this.rmR16(d) : this.rmR8(d);
    switch (d.reg) {
      case 0: case 1: this.alu(4, v, w ? this.fetchw() : this.fetchb(), w); return;
      case 2: if (w) this.rmW16(d, ~v & 0xffff); else this.rmW8(d, ~v & 0xff); return;
      case 3: { const res = this.alu(5, 0, v, w); this.setF(CF, v !== 0); if (w) this.rmW16(d, res); else this.rmW8(d, res); return; }
      case 4: // MUL
        if (w) { const p = r[0] * v; r[0] = p & 0xffff; r[2] = (p >>> 16) & 0xffff; const o = r[2] !== 0; this.setF(CF, o); this.setF(OF, o); }
        else { const p = (r[0] & 0xff) * v; r[0] = p & 0xffff; const o = (p & 0xff00) !== 0; this.setF(CF, o); this.setF(OF, o); }
        return;
      case 5: // IMUL
        if (w) { const p = (r[0] << 16 >> 16) * (v << 16 >> 16); r[0] = p & 0xffff; r[2] = (p >> 16) & 0xffff; const o = p !== ((p & 0xffff) << 16 >> 16); this.setF(CF, o); this.setF(OF, o); }
        else { const p = ((r[0] & 0xff) << 24 >> 24) * (v << 24 >> 24); r[0] = p & 0xffff; const o = p !== ((p & 0xff) << 24 >> 24); this.setF(CF, o); this.setF(OF, o); }
        return;
      case 6: // DIV
        if (v === 0) { this.interrupt(0); return; }
        if (w) { const n = (r[2] * 65536 + r[0]); const q = Math.floor(n / v); if (q > 0xffff) { this.interrupt(0); return; } r[0] = q; r[2] = n % v; }
        else { const n = r[0]; const q = Math.floor(n / v); if (q > 0xff) { this.interrupt(0); return; } r[0] = ((n % v) << 8) | q; }
        return;
      case 7: // IDIV
        if (v === 0) { this.interrupt(0); return; }
        if (w) { const n = (r[2] << 16) | r[0]; const dv = v << 16 >> 16; const q = Math.trunc(n / dv); if (q > 32767 || q < -32768) { this.interrupt(0); return; } r[0] = q & 0xffff; r[2] = (n % dv) & 0xffff; }
        else { const n = r[0] << 16 >> 16; const dv = v << 24 >> 24; const q = Math.trunc(n / dv); if (q > 127 || q < -128) { this.interrupt(0); return; } r[0] = (((n % dv) & 0xff) << 8) | (q & 0xff); }
        return;
    }
  }
}

export const FLAGS = { CF, PF, AF, ZF, SF, TF, IF, DF, OF };
