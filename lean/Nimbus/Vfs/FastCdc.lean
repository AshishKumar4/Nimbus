/-
  Nimbus.Vfs.FastCdc — the content cutter of the v2 store
  (`packages/core/src/vfs/content-chunking.ts`: `scan`, `cdcCut`, `cutContent`,
  `ContentCutter`). FastCDC with normalized chunking: the gear hash rolls from
  `start + min`, a hit on the strict mask before `start + avg`, on the loose mask
  after it, and a forced cut at `start + max`.

  The gear table and the masks are parameters: every theorem holds for any
  table and any masks, so none depends on the hash's statistics. The rolling
  hash is the code's (`h = (h << 1) + GEAR[b]` in 32 bits; the code's `| 0`
  keeps the same bits as this `UInt32`).

  Proved: every cut lies in `(start + min, start + max]` (or is the end); the
  cuts of a whole buffer tile it with chunks of at most `max` bytes, every chunk
  but the last longer than `min`; a cut depends only on the bytes from its
  chunk's start to at most `max` past it, so an edit changes no cut before its
  chunk and cuts rejoin once one lands on an old boundary past the edit; and a
  cut found on a prefix of a stream (`final = false`) is the cut of the whole.
-/

namespace Nimbus.Vfs.FastCdc

structure Params where
  min : Nat
  avg : Nat
  max : Nat
  maskS : UInt32
  maskL : UInt32
  gear : Nat → UInt32

variable (P : Params)

/-- The code's two loops, one index at a time: `i` the next byte, `h` the hash
    so far. -/
def scanFrom (d : Nat → Nat) (normal limit : Nat) (i : Nat) (h : UInt32) : Nat :=
  if i < limit then
    let h' := (h <<< 1) + P.gear (d i)
    if i < normal then
      if h' &&& P.maskS = 0 then i + 1 else scanFrom d normal limit (i + 1) h'
    else
      if h' &&& P.maskL = 0 then i + 1 else scanFrom d normal limit (i + 1) h'
  else limit
termination_by limit - i

def scan (d : Nat → Nat) (start limit : Nat) : Nat :=
  scanFrom P d (min (start + P.avg) limit) limit (start + P.min) 0

/-- `cdcCut`, with `none` for the code's -1 (more bytes needed). -/
def cdcCut (d : Nat → Nat) (start stop : Nat) (final : Bool) : Option Nat :=
  if stop - start ≤ P.min then (if final then some stop else none)
  else if stop - start < P.max ∧ final = false then
    let c := scan P d start stop
    if c < stop then some c else none
  else some (scan P d start (min (start + P.max) stop))

/-! ## Where a cut can fall -/

theorem scanFrom_bounds (d : Nat → Nat) (normal limit : Nat) :
    ∀ i h, i < limit → i < scanFrom P d normal limit i h ∧ scanFrom P d normal limit i h ≤ limit := by
  intro i
  induction i using (measure fun i => limit - i).wf.induction with
  | _ i ih =>
  intro h hi
  unfold scanFrom
  rw [if_pos hi]
  simp only
  have step : ∀ h', i < scanFrom P d normal limit (i + 1) h' ∧ scanFrom P d normal limit (i + 1) h' ≤ limit := by
    intro h'
    by_cases e : i + 1 < limit
    · have := ih (i + 1) (by show limit - (i + 1) < limit - i; omega) h' e; exact ⟨by omega, this.2⟩
    · have : ¬ (i + 1 < limit) := e
      unfold scanFrom; rw [if_neg this]; omega
  split
  · split
    · exact ⟨by omega, by omega⟩
    · exact step _
  · split
    · exact ⟨by omega, by omega⟩
    · exact step _

/-- A cut from `start` lies past `start + min` and at most at `limit`. -/
theorem scan_bounds (d : Nat → Nat) (start limit : Nat) (h : start + P.min < limit) :
    start + P.min < scan P d start limit ∧ scan P d start limit ≤ limit :=
  scanFrom_bounds P d _ _ _ 0 h

/-- Every cut of a whole buffer (`final`): the end if what is left is at most
    `min`, else strictly past `start + min`, at most `start + max`, at most the end. -/
theorem cdcCut_final (d : Nat → Nat) (start stop : Nat) (hs : start < stop) (hmm : P.min < P.max) :
    ∃ c, cdcCut P d start stop true = some c ∧ start < c ∧ c ≤ stop ∧ c ≤ start + P.max ∧
      (c = stop ∨ start + P.min < c) := by
  unfold cdcCut
  by_cases h1 : stop - start ≤ P.min
  · rw [if_pos h1]; exact ⟨stop, by simp, hs, Nat.le_refl _, by omega, Or.inl rfl⟩
  · rw [if_neg h1, if_neg (by simp)]
    obtain ⟨b1, b2⟩ := scan_bounds P d start (min (start + P.max) stop) (by omega)
    refine ⟨_, rfl, by omega, by omega, by omega, Or.inr b1⟩

/-! ## A cut depends only on the bytes it scans -/

theorem scanFrom_local {d d' : Nat → Nat} (normal limit : Nat) :
    ∀ i h, (∀ j, i ≤ j → j < limit → d j = d' j) →
      scanFrom P d normal limit i h = scanFrom P d' normal limit i h := by
  intro i
  induction i using (measure fun i => limit - i).wf.induction with
  | _ i ih =>
  intro h hd
  unfold scanFrom
  by_cases hi : i < limit
  · rw [if_pos hi, if_pos hi]
    simp only
    rw [hd i (Nat.le_refl _) hi]
    have := fun h' => ih (i + 1) (by show limit - (i + 1) < limit - i; omega) h' (fun j hj hl => hd j (by omega) hl)
    split <;> split <;> first | rfl | exact this _
  · rw [if_neg hi, if_neg hi]

/-- Two buffers that agree from a chunk's start over the bytes a cut can read
    (`max` of them, or to the end) cut that chunk at the same place: an edit moves
    no cut before the chunk it touches, and once a new cut lands on an old
    boundary past the edit every later cut is the old one. -/
theorem cdcCut_local {d d' : Nat → Nat} (start stop : Nat) (final : Bool)
    (hd : ∀ j, start ≤ j → j < min (start + P.max) stop → d j = d' j) :
    cdcCut P d start stop final = cdcCut P d' start stop final := by
  unfold cdcCut scan
  split
  · rfl
  · split
    · rw [scanFrom_local P _ _ _ _ (fun j h1 h2 => hd j (by omega) (by omega))]
    · rw [scanFrom_local P _ _ _ _ (fun j h1 h2 => hd j (by omega) h2)]

/-! ## A stream cuts where the whole buffer does -/

/-- Scanning with a later limit finds the same cut when the earlier scan found
    one before its limit. -/
theorem scanFrom_extend (d : Nat → Nat) (n1 n2 l1 l2 : Nat) (hl : l1 ≤ l2)
    (hn : n1 = n2 ∨ (n1 = l1 ∧ l1 ≤ n2)) :
    ∀ i h, scanFrom P d n1 l1 i h < l1 → scanFrom P d n2 l2 i h = scanFrom P d n1 l1 i h := by
  intro i
  induction i using (measure fun i => l1 - i).wf.induction with
  | _ i ih =>
  intro h hlt
  by_cases hi : i < l1
  · have hi2 : i < l2 := by omega
    have hn' : i < n1 ↔ i < n2 := by rcases hn with e | ⟨e, h2⟩ <;> constructor <;> intro <;> omega
    unfold scanFrom at hlt ⊢
    rw [if_pos hi] at hlt ⊢
    rw [if_pos hi2]
    simp only at hlt ⊢
    by_cases hin : i < n1
    · rw [if_pos hin] at hlt ⊢; rw [if_pos (hn'.mp hin)]
      split
      · rfl
      · rename_i hm; rw [if_neg hm] at hlt
        exact ih (i + 1) (by show l1 - (i + 1) < l1 - i; omega) _ hlt
    · rw [if_neg hin] at hlt ⊢; rw [if_neg (fun h => hin (hn'.mpr h))]
      split
      · rfl
      · rename_i hm; rw [if_neg hm] at hlt
        exact ih (i + 1) (by show l1 - (i + 1) < l1 - i; omega) _ hlt
  · unfold scanFrom at hlt; rw [if_neg hi] at hlt; omega

/-- `ContentCutter.push`: a cut found on the bytes received so far is the cut
    of the whole stream, whatever arrives later (the buffers agree on what was
    received). -/
theorem cdcCut_prefix {d d' : Nat → Nat} (start stop stop' : Nat) (hs : stop ≤ stop')
    (hd : ∀ j, start ≤ j → j < stop → d j = d' j) {c : Nat} (h : cdcCut P d start stop false = some c) :
    cdcCut P d' start stop' true = some c := by
  have hmm : start + P.min < stop := by
    unfold cdcCut at h; split at h
    · simp at h
    · omega
  unfold cdcCut at h ⊢
  rw [if_neg (by omega)] at h
  rw [if_neg (by omega), if_neg (by simp)]
  split at h
  · rename_i hlt
    simp only at h
    split at h
    · rename_i hc
      injection h with h; subst h
      unfold scan at hc ⊢
      -- the prefix scan reads only received bytes
      rw [scanFrom_local P (d := d) (d' := d') _ _ _ _ (fun j _ hj => hd j (by omega) hj)] at hc ⊢
      congr 1
      apply scanFrom_extend P d' _ _ _ _ (by omega) _ _ _ hc
      by_cases e : start + P.avg ≤ stop
      · left; omega
      · right; constructor <;> omega
    · cases h
  · rename_i hge
    injection h with h; subst h
    have hmax : stop - start ≥ P.max := by
      apply Classical.byContradiction; intro hn; exact hge ⟨by omega, rfl⟩
    unfold scan
    have e1 : min (start + P.max) stop' = min (start + P.max) stop := by omega
    rw [e1]
    congr 1
    exact (scanFrom_local P _ _ _ _ (fun j _ hj => hd j (by omega) (by omega))).symm

/-! ## A whole buffer is tiled -/

/-- `cutContent`'s loop, with fuel. -/
def cuts (d : Nat → Nat) (n : Nat) : Nat → Nat → List Nat
  | 0, _ => []
  | f + 1, s =>
    if s < n then
      match cdcCut P d s n true with
      | some c => c :: cuts d n f c
      | none => []
    else []

/-- One chunk up to `max` bytes, FastCDC above. -/
def cutContent (d : Nat → Nat) (n : Nat) : List Nat :=
  if n = 0 then [] else if n ≤ P.max then [n] else cuts P d n n 0

/-- `l` is the list of chunk ends of `[s, n)`: each chunk non-empty and at
    most `max` long, and every chunk but the last longer than `min`. -/
inductive Tiles (n : Nat) : Nat → List Nat → Prop
  | done (s : Nat) : s = n → Tiles n s []
  | chunk (s c : Nat) (l : List Nat) : s < c → c ≤ s + P.max → (c = n ∨ s + P.min < c) → Tiles n c l →
      Tiles n s (c :: l)

theorem cuts_tile (d : Nat → Nat) (n : Nat) (hmm : P.min < P.max) :
    ∀ f s, s ≤ n → n - s ≤ f → Tiles P n s (cuts P d n f s) := by
  intro f
  induction f with
  | zero => intro s hs hf; exact .done s (by omega)
  | succ f ih =>
    intro s hs hf
    unfold cuts
    by_cases hlt : s < n
    · rw [if_pos hlt]
      obtain ⟨c, hc, h1, h2, h3, h4⟩ := cdcCut_final P d s n hlt hmm
      rw [hc]
      exact .chunk s c _ h1 h3 h4 (ih c h2 (by omega))
    · rw [if_neg hlt]; exact .done s (by omega)

/-- The cuts of a whole buffer tile it: chunks of at most `max` bytes, every one
    but the last longer than `min`, the last ending at the buffer's end. -/
theorem cutContent_tiles (d : Nat → Nat) (n : Nat) (hmm : P.min < P.max) :
    Tiles P n 0 (cutContent P d n) := by
  unfold cutContent
  split
  · exact .done 0 (by omega)
  · split
    · exact .chunk 0 n [] (by omega) (by omega) (Or.inl rfl) (.done n rfl)
    · exact cuts_tile P d n hmm n 0 (Nat.zero_le _) (by omega)

end Nimbus.Vfs.FastCdc
