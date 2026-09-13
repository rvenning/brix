# BRIX 1.00 — mechanics

Findings about the original game, from three sources:

- **Code**: the disassembly of `BRIX.EXE` (Turbo C++, large model). Addresses such as
  `s309:4301` are offsets in the game code segment (file offset `0x3490 + address`
  inside the load image).
- **Oracle**: the original executable running in `tools/brix-oracle/` (an 8086/DOS
  emulator), driven by bots, with its memory read after every rule step.
- **BRIX.DOC**: the release notes.

Each finding is marked:

| Mark | Meaning |
|---|---|
| ✅ **Confirmed** | Read from the code *and* reproduced event-for-event against the oracle (`tests/oracle-replay.test.ts`), or a plain fact of the data |
| 🟡 **Read from code** | Read from the disassembly but not exercised in the oracle, or depends on real 1991 hardware |
| ❓ **Unknown** | Not established; needs testing |

Descriptions of BRIX found elsewhere (later Epic releases, Puzznic clones) were not
used as evidence: several of them describe mechanics this version does not have.

---

## 1. The board

✅ A problem is a **14 × 12** grid. The screen is 320×200 with 16-pixel cells and a
six-cell side panel, so 14 columns × 16 = 224 px sit beside the 96 px panel.

✅ Tile bytes:

| Byte | Tile | Solid | Cursor may enter |
|---|---|---|---|
| `00` | empty | no | yes |
| `01`–`08` | block of type 1–8 | yes | yes |
| `0A` | inner wall | yes | **yes** |
| `0B` | frame wall | yes | **no** |
| `0C` | elevator | yes | yes |
| `0D` | void (outside) | yes | yes (never reachable: the frame encloses it) |

✅ In memory the board is **column-major** (`[0C21h + x*12 + y]`), while the file is
row-major. Out-of-range coordinates alias into the neighbouring column; the modern
engine reproduces this aliasing (`rules.ts` `index()`), though no original level
exercises it.

✅ Scans for matches and falling blocks only visit `x = 1..12`, `y = 1..10`.
Every original level keeps its blocks inside that area.

## 2. The cursor and moving blocks

✅ The cursor starts where the level says. **Arrow keys** move it one cell. It stops
only at **frame walls** (`0B`) — it passes over inner walls, blocks and the elevator.

✅ **Space** picks up the block under the cursor, or puts it down. It does nothing
on a non-block, and nothing while the carried block is falling.

✅ While carrying, **left/right** push the block one cell, and only into an **empty**
cell. **Up/down do nothing**: blocks never move vertically under player control.

✅ **No block can be moved while any block anywhere is falling** (`s309:4281`).

✅ **Keys latch.** The last key read is kept in `[0A3h]` and the key handler runs on
every pass of the main loop. A key that cannot act (pushing into a wall, space on
an empty cell, a move while something falls) is *not* discarded: it is tried again
every pass until it succeeds or another key replaces it. In play this means a push
made while blocks are still falling happens by itself the moment they land.
Keys that are not commands (F5, letters) also replace the latched key, cancelling it.

✅ Moving a block resets the **chain counter** to 0 (§5).

🟡 Held keys repeat at the keyboard's typematic rate (BIOS default ~10/s after
~500 ms). The game itself does no repeat handling.

## 3. Gravity

✅ A block with an empty cell below it falls. Falling is discrete: each **fall step**
advances every falling block by 1/16 of a cell, and after 16 steps the blocks move
one row in the board array (`s309:1F95`).

✅ At the start of each cell (offset 0) the game re-collects the falling blocks
(`s309:1E56`), scanning columns right to left and rows bottom to top, **and runs a
full match scan** (§4). So matches are detected continuously, not only after moves.

✅ The falling list is not updated when blocks change row; until the next
re-collection it holds their previous coordinates. The modern engine keeps the same
stale list, because "is this cell falling?" checks read it.

✅ If the carried block falls, the cursor falls with it and the block stays carried.

## 4. Matching

✅ A **match scan** (`s309:4301` mode 1) lists every block that has an orthogonally
adjacent block of the **same type**, where neither is falling and neither is on a
moving elevator. All listed blocks are removed together. So any connected group of
two or more same-type blocks vanishes, whatever its shape.

✅ There is no "three in a row" rule. BRIX.DOC's *"Sometimes it is necessary to put
together three icons at once"* is a hint about puzzle design: with an odd number of
one type, the last three must meet simultaneously or one is stranded.

✅ Removal happens after an animation that **freezes the whole game** — falls, the
elevator and the clock — for about **1.47 s** in the oracle. Keys pressed during the
freeze are latched. Because everything freezes, the freeze length affects no rule;
the modern game uses a shorter animation.

✅ Blocks that lose their support start falling at the next re-collection.

## 5. Scoring

✅ All scoring is in `s309:4B0E` and `s309:5223`:

| Event | Points |
|---|---|
| A blast listing *n* cells | (*n* − 1) × 100 |
| Chain bonus: after a blast, if more than 3 cells have been listed since the player last moved a block | 400 if the running total is 4, 600 if 5, 1000 if 6 or more |
| Level cleared without using F4 | tree level × 1000 |
| Time left when cleared | seconds × tree level × 100 |

✅ The chain total is a byte and includes the current blast, so one long chain can
earn several bonuses (e.g. totals 4 then 6 earn 400 then 1000).

✅ "Tree level" is the column of the level tree, 1–7 (§8), not the problem number.

🟡 The score is a 32-bit value kept across the whole run, including through retries.

## 6. Clearing and failing

✅ The game counts blocks at load (`[8DAh]`, a byte) and subtracts one per listed
cell. **The level is cleared when that count reaches zero** — the board is not
inspected.

🟡 Time runs out one displayed second *after* 0:00. Then "GAME OVER — CONTINUE 10":
Space within 10 s spends one of **5 credits** and replays the problem with a fresh
clock. With no credits left the run ends.

🟡 **F4** restarts the problem **with the clock carried over** and forfeits the clear
bonus. Two retries per problem; F4 with none left counts as time up. Points earned
before the retry are kept.

🟡 **ESC** quits to the title immediately.

## 7. The elevator

✅ A level may have one elevator (metadata bytes 2–4). The loader writes the elevator
tile at its position over whatever the grid holds — level 88's grid has an empty
cell there. The direction byte is read as `0` → never moves, `1` → starts **up**,
anything else → starts **down**.

✅ Blocks standing directly on the elevator form its **stack**, counted upward from
the elevator while cells hold blocks (`s309:22D5`).

✅ Each **elevator step** (`s309:2346`):

1. If waiting, count the wait down and stop.
2. If between rows, move 1/16 of a cell. On reaching a new row, shift the elevator
   and its stack one row in the board, move a riding cursor with them, and scan the
   stack against its **left and right** neighbours (mode 2).
3. If at rest: recount the stack, scan stack blocks against the block **above** each
   (mode 3), then start moving if the cell beyond (above the stack, or below the
   elevator) is empty; otherwise **reverse and wait 10 steps**.

✅ A falling block that meets a moving elevator mid-cell joins its stack
(`s309:2229`); a block resting on top of a descending stack but not yet counted in
it is treated as falling so that it follows.

✅ **Quirk — duplicate stack matches.** Mode 3 lists *both* blocks of every equal
vertical pair in the stack, so in a stack of three equal blocks the middle one is
listed twice. The block counter is decremented once per listing, so it drops below
the true number of blocks, and a level can be declared cleared with blocks still on
the board. Scores and chain totals count the duplicates too. Level 98 (which has
single, unmatchable blocks of types 6 and 7) is presumably meant to be cleared this
way. The modern engine reproduces the quirk.

✅ **Quirk — pulling a block out of the stack.** Carrying a block that is part of the
stack ("riding") and pushing it sideways makes every block above it drop one row at
once, without falling, and leaves the stack count stale until the next recount.

✅ A block on the elevator cannot be pushed while the elevator is between rows, and
no block may be pushed into the cell just below a descending elevator or just above
an ascending stack.

🟡 Metadata bytes 5–7 describe a second elevator slot (the loader sets `[91Ah]`),
but it reuses the first elevator's position variables and no original level uses
it. Not implemented.

## 8. The level tree

✅ `LEVELS` holds **112 problems** in 28 **choices** of 4. The tree has 7 levels;
level *n* has *n* choices. File order is level 1 choice 1, level 2 choice 1,
level 2 choice 2, level 3 choice 1, …

🟡 A new game offers **every choice of levels 1–5**. Choosing one withdraws all
other offers. Its four problems are played in order. Clearing the fourth marks the
choice done and offers the two choices beside it in the next level (same row and
row + 1).

🟡 Level 7 is walked downward: clearing a level-7 choice offers only the one below
it. Clearing the bottom-right choice (problems 109–112) wins the game
("YOU MADE IT!"). 🟡 The win screen shows a "COMPLETING BONUS" of 500000; whether it is added to the score was not checked.

🟡 The tree cursor only moves between offered choices (`s309:379F`–`s309:421D`).

🟡 The tree screen chooses for the player after about 10 seconds ("TIME 07" counts
down).

✅ The final problem (112) is a trivial pair in a decorative maze with a 20-second
limit.

## 9. Timing

✅ The main loop (`s309:2BCC`) reads the keyboard, runs the key handler, then
checks two timers measured in PIT counts (1,193,182 per second):

| Timer | Fires after | Runs |
|---|---|---|
| A | more than 30,000 counts (25.1 ms) | fall step, then elevator step |
| B | more than 15,000 counts (12.6 ms) | fall step |

✅ In the oracle this gives **≈ 118 fall steps and ≈ 39.5 elevator steps per second**:
a block falls a cell in ~135 ms; the elevator moves a cell in ~405 ms and waits
~250 ms when it turns.

🟡 On real 1991 hardware each loop pass took longer, so the timers fired slightly
later than the thresholds; the rates were marginally lower than in the oracle.

✅ **The clock.** The INT 1Ch handler counts BIOS ticks (18.2 Hz). The displayed time
drops by one second every **21 ticks ≈ 1.153 real seconds**. A "1:00" limit
therefore lasts 61 × 21 ticks ≈ 70.4 s. The clock stops during blasts.

## 10. Presentation facts (not reproduced)

- ✅ Block colours are rotated by a random offset per problem (`[920h]` =
  timer mod 8; loaded type *t* becomes `(t + k) mod 8 + 1`). Purely cosmetic; the
  modern game keeps level data unrotated.
- ✅ The game never programs the VGA palette; it uses the BIOS default mode-13h palette.
- 🟡 Two-player mode alternates players between problems. 🟡 Not implemented in the
  modern game (see README).

## 11. Known original bugs not reproduced

- 🟡 **State leaks between problems.** The stack count and elevator position are not
  reset when a problem without an elevator loads, so in a long session a stale stack
  could in principle make the riding logic act on a level with no elevator. The
  modern engine starts every problem from a clean state, matching how the original
  behaves when a problem is the first one loaded. No original level is known to be
  affected in practice.

## ❓ Open questions

- Exact typematic behaviour on period keyboards (affects how held keys feel).
- Whether any original level *requires* the duplicate stack match to be solvable. Level 98
  (single blocks of types 6 and 7) is the candidate; the solver has not found a solution
  within its budget, so this is still open.
- Level 15 (three blocks meeting at a moving elevator) and level 81 are also unsolved by
  the solver. Level 15 may need key timing finer than one key per frame.
- Exact durations of the sound effects during blasts on real hardware (irrelevant
  to rules because everything freezes).
