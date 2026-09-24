/-
  Nimbus.Refine.Json — the JSON a fixture is written in, and the generator's
  random source. Emit-only: the fixtures are read by the unit tests.
-/

namespace Nimbus.Refine

/-- A JSON value. Numbers are integers: every fixture value is exact. -/
inductive Json where
  | null
  | bool (b : Bool)
  | int (n : Int)
  | str (s : String)
  | arr (xs : List Json)
  | obj (kvs : List (String × Json))
  deriving Inhabited

private def escapeChar (c : Char) : String :=
  if c = '"' then "\\\""
  else if c = '\\' then "\\\\"
  else if c = '\n' then "\\n"
  else if c.toNat < 0x20 then
    let hex := Nat.toDigits 16 c.toNat
    "\\u" ++ String.mk (List.replicate (4 - hex.length) '0' ++ hex)
  else c.toString

def quote (s : String) : String := "\"" ++ String.join (s.toList.map escapeChar) ++ "\""

/-- Compact rendering. -/
partial def Json.render : Json → String
  | .null => "null"
  | .bool b => if b then "true" else "false"
  | .int n => toString n
  | .str s => quote s
  | .arr xs => "[" ++ ",".intercalate (xs.map Json.render) ++ "]"
  | .obj kvs => "{" ++ ",".intercalate (kvs.map fun (k, v) => quote k ++ ":" ++ v.render) ++ "}"

/-- A fixture file: its header fields compact, then one case per line, so a
    changed case is a one-line diff. -/
def fixtureText (header : List (String × Json)) (cases : List Json) : String :=
  "{" ++ String.join (header.map fun (k, v) => quote k ++ ":" ++ v.render ++ ",\n") ++
    quote "cases" ++ ":[\n" ++ ",\n".intercalate (cases.map Json.render) ++ "\n]}\n"

def Json.ofNat (n : Nat) : Json := .int n

def Json.opt {α : Type} (f : α → Json) : Option α → Json
  | none => .null
  | some a => f a

/-! ## Random source -/

/-- SplitMix64: a fixed seed gives the same cases on every machine. -/
structure Rng where
  state : UInt64

def Rng.next (r : Rng) : UInt64 × Rng :=
  let s := r.state + 0x9E3779B97F4A7C15
  let z := (s ^^^ (s >>> 30)) * 0xBF58476D1CE4E5B9
  let z := (z ^^^ (z >>> 27)) * 0x94D049BB133111EB
  (z ^^^ (z >>> 31), ⟨s⟩)

abbrev Gen := StateM Rng

/-- A number below `n` (0 when `n` is 0). -/
def below (n : Nat) : Gen Nat := do
  let r ← get
  let (x, r') := r.next
  set r'
  return if n = 0 then 0 else x.toNat % n

/-- True with probability `num / den`. -/
def chance (num den : Nat) : Gen Bool := do
  return (← below den) < num

def pick {α : Type} [Inhabited α] (xs : List α) : Gen α := do
  return xs.getD (← below xs.length) default

/-- Run `g` until it yields a case, at most `tries` times. -/
def retry {α : Type} (tries : Nat) (g : Gen (Option α)) : Gen (Option α) :=
  match tries with
  | 0 => return none
  | n + 1 => do
    match ← g with
    | some a => return some a
    | none => retry n g

/-- `n` cases from `g`, skipping draws it rejects. -/
def casesOf (n : Nat) (g : Gen (Option Json)) : Gen (List Json) := do
  let mut out := #[]
  for _ in [0:n] do
    if let some c ← retry 100 g then out := out.push c
  return out.toList

def runGen {α : Type} (seed : UInt64) (g : Gen α) : α := (g.run ⟨seed⟩).1

end Nimbus.Refine
