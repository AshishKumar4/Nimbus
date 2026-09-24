/-
  Nimbus.Refine.FastCdcCases — `lean/fixtures/fastcdc.json`: buffers (bytes
  from a seeded xorshift32, some with long repeated runs) and the chunk ends the
  model's `cutContent` gives at the deployed parameters (16/32/64 KiB, the
  code's gear table and padded masks). `tests/unit/fastcdc-refinement.mjs`
  checks `cutContent` and `ContentCutter` (fed in random pieces) against them.
-/

import Nimbus.Vfs.FastCdc
import Nimbus.Refine.Json

namespace Nimbus.Refine.FastCdcCases

open Nimbus.Vfs.FastCdc
open Nimbus.Refine

/-- The code's `GEAR`: xorshift32 from 0x9e3779b9, 256 draws. -/
def gearTable : Array UInt32 := Id.run do
  let mut x : UInt32 := 0x9e3779b9
  let mut out := #[]
  for _ in [0:256] do
    x := x ^^^ (x <<< 13)
    x := x ^^^ (x >>> 17)
    x := x ^^^ (x <<< 5)
    out := out.push x
  return out

/-- `spreadMask(bits)`: `bits` one-bits at `31 - floor(i * 32 / bits)`. -/
def spreadMask (bits : Nat) : UInt32 :=
  (List.range bits).foldl (fun m i => m ||| ((1 : UInt32) <<< (31 - (i * 32 / bits)).toUInt32)) 0

def deployed : Params where
  min := 16384
  avg := 32768
  max := 65536
  maskS := spreadMask 17
  maskL := spreadMask 13
  gear := fun b => gearTable.getD b 0

/-- Bytes of a case: xorshift32 from the seed; with `runs`, every other 4 KiB
    block repeats the one before it. -/
def bytes (seed : Nat) (n : Nat) (runs : Bool) : Array Nat := Id.run do
  let mut s : UInt32 := (seed * 2654435761 + 1).toUInt32
  if s == 0 then s := 1
  let mut out := #[]
  for j in [0:n] do
    if runs && (j / 4096) % 2 == 1 then
      out := out.push (out.getD (j - 4096) 0)
    else
      s := s ^^^ (s <<< 13)
      s := s ^^^ (s >>> 17)
      s := s ^^^ (s <<< 5)
      out := out.push (s &&& 255).toNat
  return out

def caseOf (seed n : Nat) (runs : Bool) : Json :=
  let data := bytes seed n runs
  let ends := cutContent deployed (fun j => data.getD j 0) n
  .obj [("seed", .ofNat seed), ("length", .ofNat n), ("runs", .bool runs), ("ends", .arr (ends.map Json.ofNat))]

def lengths : List Nat := [0, 1, 16384, 16385, 65535, 65536, 65537, 81920, 131072, 200000, 1000003]

def fixture : String :=
  fixtureText [("fixture", .str "fastcdc"), ("model", .str "Nimbus.Vfs.FastCdc.cutContent"),
      ("bytes", .str "xorshift32: s = (seed*2654435761+1) >>> 0 (1 if 0); per byte s^=s<<13; s^=s>>>17; s^=s<<5 (u32); byte = s & 255; with runs, byte j for (j/4096) odd is byte j-4096")]
    ((lengths.zip (List.range lengths.length)).flatMap fun (n, i) => [caseOf (i + 1) n false, caseOf (i + 100) n true])

end Nimbus.Refine.FastCdcCases
