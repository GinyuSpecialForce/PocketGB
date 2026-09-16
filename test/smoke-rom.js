// Builds a tiny hand-assembled .gb ROM that exercises CPU ops, MMU IO, timer and PPU.
// Results are written to HRAM 0xFF80.. for the harness to assert; then a gradient
// is drawn into tile data and the LCD is enabled for framebuffer verification.
'use strict';

function buildSmokeRom() {
  const rom = new Uint8Array(0x8000); // 32KB, 2 banks, ROM-only

  const w = (addr, ...bytes) => rom.set(bytes, addr);

  // ---- header ----
  w(0x0100, 0x00, 0xC3, 0x50, 0x01); // nop; jp $0150
  rom[0x0134] = 0x50; rom[0x0135] = 0x47; // title "PG"
  rom[0x0147] = 0x00; // ROM only
  rom[0x0148] = 0x00; // 32KB
  rom[0x0149] = 0x00; // no RAM
  // header checksum over 0x134..0x14C
  let x = 0;
  for (let i = 0x134; i <= 0x14C; i++) x = (x - rom[i] - 1) & 0xFF;
  rom[0x014D] = x;
  // global checksum (not verified by us, but be tidy)
  let g = 0;
  for (let i = 0; i < rom.length; i++) { if (i !== 0x14E && i !== 0x14F) g = (g + rom[i]) & 0xFFFF; }
  rom[0x014E] = g >> 8; rom[0x014F] = g & 0xFF;

  let p = 0x0150;
  const emit = (...bytes) => { w(p, ...bytes); p += bytes.length; };
  const setHL = (v) => emit(0x21, v & 0xFF, v >> 8);       // LD HL,nn
  const setA = (v) => emit(0x3E, v);                        // LD A,n
  const ldHLA = () => emit(0x77);                           // LD (HL),A
  const incHL = () => emit(0x23);                           // INC HL

  // Test 1: ALU — DAA chain, ADC/SBC with carry, 16-bit add, rotations
  // Results recorded to HRAM starting 0xFF80 via HL pointer
  setHL(0xFF80);

  // a) 0x45 + 0x38 = 0x7D, H set then DAA -> 0x83? (no: H set means +6 low nibble) compute: 45+38=7D, half-carry set (5+8>15)? 5+8=13 >15? no. flags Z0 N0 H0 C0 -> DAA: 7D stays (low 0xD>9? D=13>9 and N=0 -> +6 -> 83, C0). Record 0x83.
  setA(0x45); emit(0xC6, 0x38);      // ADD A,0x38
  emit(0x27);                        // DAA
  ldHLA(); incHL();                  // [FF80]=0x83

  // b) 0x9C - 0x3F with borrow chain: SUB 0x3F then SBC 0x01 (carry from sub? 9C-3F=5D no borrow) then record
  setA(0x9C); emit(0xD6, 0x3F);      // SUB 0x3F -> 0x5D
  emit(0xDE, 0x01);                  // SBC A,0x01 -> 0x5C
  ldHLA(); incHL();                  // [FF81]=0x5C

  // c) carry flag: 0xFF + 1 = 0x00 with C=1, ADC 0 -> 0x01
  setA(0xFF); emit(0xC6, 0x01);      // ADD A,1 -> 0, C set
  emit(0xCE, 0x00);                  // ADC A,0 -> 1
  ldHLA(); incHL();                  // [FF82]=0x01

  // d) RL through carry twice: A=0x80, RLCA->0x01 C=1, RLA->0x03
  setA(0x80); emit(0x07);            // RLCA
  emit(0x17);                        // RLA
  ldHLA(); incHL();                  // [FF83]=0x03

  // e) 16-bit add: HL=0x00FF + BC=0x0001 = 0x0100. HL is our record pointer,
  //    so park it in DE. (SM83 has no EX DE,HL — copy back via A.)
  setHL(0xFF84); emit(0x54); emit(0x5D); // LD D,H; LD E,L → DE = 0xFF84
  setHL(0x00FF); emit(0x01, 0x01, 0x00); // LD BC,0x0001
  emit(0x09);                        // ADD HL,BC → HL = 0x0100
  emit(0x7C);                        // LD A,H → A = 0x01
  emit(0x62); emit(0x6B);            // LD H,D; LD L,E → HL = 0xFF84 (pointer back)
  ldHLA(); incHL();                  // [FF84]=0x01

  // f) CP + conditional: A=0x10, CP 0x10 -> Z set; JR Z taken
  setA(0x10); emit(0xFE, 0x10);      // CP 0x10
  emit(0x28, 0x02);                  // JR Z,+2 (skip the two INC HL? no: skip 2 bytes)
  emit(0x3E, 0xEE);                  // LD A,0xEE (skipped)
  setA(0x42);                        // reached only if Z (record 0x42)
  ldHLA(); incHL();                  // [FF85]=0x42

  // g) stack: PUSH AF / POP DE round trip; A=0x77 F=0x80
  setA(0x77); emit(0xF5);            // PUSH AF (F bits low nibble are 0 -> af=0x7780)
  emit(0xD1);                        // POP DE
  emit(0x7A);                        // LD A,D
  ldHLA(); incHL();                  // [FF86]=0x77

  // h) CALL/RET: call subroutine at 0x0500 (clear of all mainline code) that adds 0x11 to A
  setA(0x22);
  emit(0xCD, 0x00, 0x05);            // CALL 0x0500
  ldHLA(); incHL();                  // [FF87]=0x33

  // i) CB RES/SET/SLAP: A=0xFF, CB 87 (RES 0,A) -> 0xFE, CB C7? no SET 1 -> 0xFF... use SLA
  setA(0xFF);
  emit(0xCB, 0x87);                  // RES 0,A -> FE
  emit(0xCB, 0x27);                  // SLA A -> FC
  ldHLA(); incHL();                  // [FF88]=0xFC

  // j) Timer: enable at 262144 Hz (TAC=0x05), burn ~166k m-cycles via nested loops
  //    (JR offsets are signed bytes: inner loop must stay within 128 bytes)
  setA(0x05); emit(0xE0, 0x07);      // LDH (TAC),A
  setA(0xF0); emit(0xE0, 0x06);      // LDH (TMA),A
  setA(0x00); emit(0xE0, 0x05);      // LDH (TIMA),A
  emit(0x06, 0x08);                  // LD B,8        (outer counter)
  const outerStart = p;
  emit(0x0E, 0x32);                  // LD C,50       (inner counter)
  const innerStart = p;
  for (let i = 0; i < 100; i++) emit(0x00); // 100 NOPs (400 m-cycles per inner pass)
  emit(0x0D);                        // DEC C
  emit(0x20, (0x100 - (p + 2 - innerStart)) & 0xFF); // JR NZ inner (offset -103, fits)
  emit(0x05);                        // DEC B
  emit(0x20, (0x100 - (p + 2 - outerStart)) & 0xFF); // JR NZ outer (offset -108, fits)
  // After loop, read TIMA
  emit(0xF0, 0x05);                  // LDH A,(TIMA)
  ldHLA(); incHL();                  // [FF89]=TIMA snapshot

  // k) PPU: tile 0 = solid color 3, tile map filled with tile 0, BGP inverts
  setHL(0x8000);
  for (let i = 0; i < 8; i++) {
    emit(0x3E, 0xFF); ldHLA(); incHL(); // plane 0 = FF
    emit(0x3E, 0xFF); ldHLA(); incHL(); // plane 1 = FF → color 3
  }
  // tile map at 0x9800: fill 32x8 entries with tile 0 (A already 0? no — reload)
  setHL(0x9800);
  emit(0x3E, 0x00);                  // A = tile 0
  for (let i = 0; i < 32 * 8; i++) { ldHLA(); incHL(); }
  // BGP: map color3 -> shade 0 (top field 00, rest 11)
  setA(0x3F); emit(0xE0, 0x47);      // BGP = 0b00_11_11_11: 3→0, 0/1/2→3
  setA(0x91); emit(0xE0, 0x40);      // LCDC = on, BG on, tiledata 8000, map 9800

  // Wait for first frame: LY=144 loop
  // poll: LD A,(FF44); CP 144; JR NZ
  const pollStart = p;
  emit(0xF0, 0x44);                  // LDH A,(LY)
  emit(0xFE, 0x90);                  // CP 0x90
  emit(0x20, (0x100 - (p - pollStart + 2)) & 0xFF); // JR NZ back

  // Done: write marker to spare HRAM (clear of records at FF80-FF89) and halt forever
  setA(0xDE); emit(0xE0, 0x8F);      // [FF8F] = 0xDE done marker
  const haltHere = p;
  emit(0x76);                        // HALT
  emit(0x18, 0xFE);                  // JR -2 (in case of halt bug/wake)

  // Subroutine at 0x0500: ADD A,0x11; RET
  w(0x0500, 0xC6, 0x11, 0xC9);

  return rom;
}

module.exports = { buildSmokeRom };
