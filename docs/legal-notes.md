# Legal notes

This project reimplements **BRIX Version 1.00** (Michael Riedel, Karlsruhe, October 1991).
It is not affiliated with Michael Riedel, Radiesel, or Epic MegaGames.

## Status of BRIX 1.00

The release documentation that ships with BRIX 1.00, `BRIX.DOC`, states under
*Release notes*:

> I release this programm into the public domain

The copy kept in `reference/brix100/` contains exactly these files:

| File | Bytes | Purpose |
|---|---|---|
| `BRIX.EXE` | 41,120 | The game (Turbo C++ 1990, DOS real mode) |
| `BRIX.DOC` | 2,702 | Release notes containing the public-domain statement |
| `LEVELS` | 19,936 | 112 level records, 178 bytes each |
| `BLOCKS` | 15,360 | 60 16×16 sprites |
| `BRIX.PIC` | 11,278 | Title picture |
| `FONT` | 512 | 8×8 bitmap font |
| `HIGH` | 200 | High-score table |

Evidence that this copy is 1.00 and not a later release: `BRIX.DOC` is headed
"BRIX Version 1.00 ... programmed by 10/1991 by Michael Riedel", the executable
contains no Epic MegaGames text, and the level count (112) matches the
documentation ("The game comes equipped with 112 different levels").

The files are kept as a **development and reference artifact**: the level
extractor reads `LEVELS`, and the test oracle (`tools/brix-oracle/`) runs
`BRIX.EXE` in an emulator to check the modern rules against the original. The
modern game does not load or ship any of these files at runtime.

## What the modern game uses from the original

- **Level data** (the 112 layouts, cursor starts, elevators and time limits),
  converted to JSON by `tools/brix-extractor/`. Covered by the 1.00
  public-domain release.
- **Game rules**, reimplemented from scratch in TypeScript. Rules and mechanics are
  not copyrightable expression; the implementation is original code.

## What the modern game does not use

- No graphics, fonts, pictures, sound or text from any BRIX release. The 1.00
  sprites (`BLOCKS`), title picture (`BRIX.PIC`) and font are public domain too,
  but the modern presentation is drawn from scratch by design.
- Nothing from **Epic Brix / Brix 2 / Brix 2 Deluxe / Brix 3: Superlogic** or any
  other later or commercial release. Their assets, levels, music and code are not
  assumed to be public domain and are not referenced by this project.
- No code from the original executable. The disassembly was read to learn the
  rules and the level format; the executable is only ever *run*, inside the test
  oracle.

## Name

"BRIX" is used descriptively to identify the game being reimplemented. Before
distributing the game commercially, check whether the name is registered as a
trademark in the target markets and choose a distinct product name if needed.
