#!/usr/bin/env bun
// keybindings/cursor-movement — readline parity for cursor moves.
//
// Verifies the line-editor moves the cursor correctly so subsequent
// typed characters land in the right place. We use the `echo X` recipe:
// the X is the line we end up executing, and its content reveals where
// the cursor was when we typed the marker chars.

import {
  ARROW_LEFT, ARROW_RIGHT, HOME, HOME_LINUX, END, END_LINUX,
  CTRL_A, CTRL_B, CTRL_E, CTRL_F,
  CTRL_LEFT, CTRL_RIGHT, ALT_LEFT_MOD3, ALT_RIGHT_MOD3, ALT_B, ALT_F,
} from './_keys.mjs';
import { runRecipes } from './_recipe.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

await runRecipes('keybindings/cursor-movement', [
  // ────────────── single-char arrows (smoke) ──────────────
  {
    name: 'arrow-left + type — inserts before last char',
    // type "echo ab", arrow-left, type "X" → "echo aXb"
    steps: ['echo ab', ARROW_LEFT, 'X'],
    expect: 'aXb',
  },
  {
    name: 'arrow-right — moves past, type appends',
    // type "echo ab", arrow-left, arrow-right, type "X" → "echo abX"
    steps: ['echo ab', ARROW_LEFT, ARROW_RIGHT, 'X'],
    expect: 'abX',
  },

  // ────────────── line start / end ──────────────
  {
    name: 'Home (\\x1b[H) — go to line start',
    // type "echo HELLO", Home, type "ZZ", End — buffer becomes "ZZecho HELLO"
    // But that's not runnable. Build differently: type "echo abc", Home,
    // move to position 5 (skip "echo "), then type "X" before "abc".
    // Simplest: type "echo abc", End, then Home will jump back to start
    // (BEFORE "echo "), which makes the line non-executable. Instead use
    // an inline verification: type " abc", Home, type "echo" → "echo abc".
    steps: [' abc', HOME, 'echo'],
    expect: 'abc',
  },
  {
    name: 'Home (Linux variant \\x1b[1~) — go to line start',
    steps: [' abc', HOME_LINUX, 'echo'],
    expect: 'abc',
  },
  {
    name: 'End (\\x1b[F) — go to line end',
    // type "echo ab", arrow-left twice, End, type "X" → "echo abX"
    steps: ['echo ab', ARROW_LEFT, ARROW_LEFT, END, 'X'],
    expect: 'abX',
  },
  {
    name: 'End (Linux variant \\x1b[4~) — go to line end',
    steps: ['echo ab', ARROW_LEFT, ARROW_LEFT, END_LINUX, 'X'],
    expect: 'abX',
  },
  {
    name: 'Ctrl+A — go to line start (readline alias for Home)',
    steps: [' abc', CTRL_A, 'echo'],
    expect: 'abc',
  },
  {
    name: 'Ctrl+E — go to line end (readline alias for End)',
    steps: ['echo ab', ARROW_LEFT, ARROW_LEFT, CTRL_E, 'X'],
    expect: 'abX',
  },

  // ────────────── Ctrl+B / Ctrl+F (readline char-left/right) ──────────────
  {
    name: 'Ctrl+B — move left one char (readline alias for ←)',
    steps: ['echo ab', CTRL_B, 'X'],
    expect: 'aXb',
  },
  {
    name: 'Ctrl+F — move right one char (readline alias for →)',
    // Type "echo ab", ARROW_LEFT (cursor between a and b), Ctrl+F (cursor
    // after b), type "X" → "echo abX".  Distinct from Ctrl+B path.
    steps: ['echo ab', ARROW_LEFT, CTRL_F, 'X'],
    expect: 'abX',
  },

  // ────────────── Ctrl+← / Ctrl+→ (Linux word-by-word) ──────────────
  {
    name: 'Ctrl+Left — move one word left',
    // type "echo foo bar", Ctrl+Left jumps to start of "bar", type "X" → "echo foo Xbar"
    steps: ['echo foo bar', CTRL_LEFT, 'X'],
    expect: 'foo Xbar',
  },
  {
    name: 'Ctrl+Right — move one word right',
    // Start with "echo aa bb", arrow-left ×5 (cursor between "echo " and "aa"),
    // Ctrl+Right → cursor at end of "aa", type "Z" → "echo aaZ bb".
    steps: ['echo aa bb', ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, CTRL_RIGHT, 'Z'],
    expect: 'aaZ bb',
  },

  // ────────────── Alt+B / Alt+F (cross-platform word nav) ──────────────
  {
    name: 'Alt+B — move one word back',
    steps: ['echo foo bar', ALT_B, 'X'],
    expect: 'foo Xbar',
  },
  {
    name: 'Alt+F — move one word forward',
    // type "echo aa bb", arrow-left ×5 (cursor between "echo " and "aa"),
    // Alt+F → cursor at end of "aa", type "Z" → "echo aaZ bb"
    steps: ['echo aa bb', ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ALT_F, 'Z'],
    expect: 'aaZ bb',
  },

  // ────────────── Alt+← / Alt+→ (mod-3 sequences) ──────────────
  {
    name: 'Alt+Left mod-3 (\\x1b[1;3D) — word left',
    steps: ['echo foo bar', ALT_LEFT_MOD3, 'X'],
    expect: 'foo Xbar',
  },
  {
    name: 'Alt+Right mod-3 (\\x1b[1;3C) — word right',
    steps: ['echo aa bb', ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ALT_RIGHT_MOD3, 'Z'],
    expect: 'aaZ bb',
  },
]);
