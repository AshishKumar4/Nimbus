#!/usr/bin/env bun
// keybindings/edit-ops — readline parity for line-editing ops.

import {
  ARROW_LEFT, HOME, END,
  CTRL_A, CTRL_E, CTRL_U, CTRL_K, CTRL_W, CTRL_Y, CTRL_T, CTRL_D,
  ALT_D, ALT_BACKSPACE, BACKSPACE,
} from './_keys.mjs';
import { runRecipes } from './_recipe.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

await runRecipes('keybindings/edit-ops', [
  // ────────────── Backspace / Ctrl+H ──────────────
  {
    name: 'Backspace deletes char before cursor',
    // "echo abZ" + backspace + "c" → "echo abc"
    steps: ['echo abZ', BACKSPACE, 'c'],
    expect: 'abc',
  },

  // ────────────── Ctrl+U — cut to START of line ──────────────
  // bash readline: Ctrl+U deletes from cursor to LINE START (puts in
  // kill-ring). Our current shell wipes the entire line. After fix,
  // Ctrl+U from mid-line should keep the tail.
  {
    name: 'Ctrl+U from line end cuts everything → empty line',
    // We need to type a NEW echo line after Ctrl+U. Plan:
    //   type "junk", Ctrl+U  → buffer ""
    //   type "echo X"        → buffer "echo X"
    steps: ['junk', CTRL_U, 'echo X'],
    expect: 'X',
  },
  {
    name: 'Ctrl+U from mid-line cuts only the head — tail survives',
    // type "PREFIXecho hello", arrow-left ×11 (cursor between "PREFIX" and "echo"),
    // Ctrl+U → buffer becomes "echo hello"
    steps: [
      'PREFIXecho hello',
      ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT,
      ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT,
      CTRL_U,
    ],
    expect: 'hello',
  },

  // ────────────── Ctrl+K — cut to END ──────────────
  {
    name: 'Ctrl+K cuts from cursor to end of line',
    // type "echo abXYZ", arrow-left ×3, Ctrl+K  → buffer "echo ab"
    steps: ['echo abXYZ', ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, CTRL_K],
    expect: 'ab',
  },

  // ────────────── Ctrl+W — cut word back (whitespace-delim per bash) ──────────────
  {
    name: 'Ctrl+W deletes preceding whitespace-delimited word',
    // type "echo foo bar BAD", Ctrl+W → "echo foo bar "
    steps: ['echo foo bar BAD', CTRL_W],
    expect: 'foo bar ',
  },
  {
    name: 'Ctrl+W deletes punctuation as part of the word (whitespace-only delim)',
    // type "echo foo a.b.c", Ctrl+W → "echo foo " (whitespace boundary)
    steps: ['echo foo a.b.c', CTRL_W],
    expect: 'foo ',
  },

  // ────────────── Alt+Backspace — readline word-back ──────────────
  // readline's M-DEL uses [A-Za-z0-9_] word boundaries.
  {
    name: 'Alt+Backspace deletes preceding word (readline word def)',
    // type "echo foo bar BAD", Alt+Backspace → "echo foo bar "
    steps: ['echo foo bar BAD', ALT_BACKSPACE],
    expect: 'foo bar ',
  },
  {
    name: 'Alt+Backspace stops at punctuation (unlike Ctrl+W)',
    // type "echo foo a.b.c", Alt+Backspace → "echo foo a.b." (only "c"
    // is the word; "." is non-word).
    steps: ['echo foo a.b.c', ALT_BACKSPACE],
    expect: 'foo a.b.',
  },

  // ────────────── Alt+D — delete word forward ──────────────
  // bash readline M-d (kill-word): "Kill from point to end of current
  // word, or if between words to end of NEXT word." So from a space the
  // whitespace + following word are both consumed.
  {
    name: 'Alt+D mid-word — kills from cursor to end of current word',
    // line = "echo BADX foo" (13 chars, indices 0..12).
    //   index 0=e 1=c 2=h 3=o 4=' ' 5=B 6=A 7=D 8=X 9=' ' 10=f 11=o 12=o
    // ←×7 from end (cursor=13) → cursor at index 6 = 'A'.
    // Alt+D kills word-tail from index 6 onward: kills "ADX" → leaves
    // "echo B foo".
    steps: [
      'echo BADX foo',
      ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT,
      ARROW_LEFT, ARROW_LEFT, ARROW_LEFT,
      ALT_D,
    ],
    expect: 'B foo',
  },

  // ────────────── Ctrl+Y — yank ──────────────
  {
    name: 'Ctrl+Y yanks the last cut',
    // type "echo BAD ", Ctrl+W (cuts "BAD ") → buffer "echo ", then
    // type "foo", then Ctrl+Y → buffer "echo fooBAD "
    // But Ctrl+W cuts "BAD " including the trailing space? No: bash
    // Ctrl+W kills the word BEFORE the cursor including any trailing
    // whitespace before that word. With cursor at end-of-line after
    // "echo BAD ", the word before cursor is "" (cursor is after
    // whitespace). Different recipe:
    //   type "echo foo BAD"      buffer = "echo foo BAD"
    //   Ctrl+W                   → kills "BAD" → buffer = "echo foo "
    //                              kill-ring = "BAD"
    //   type "X"                 → buffer = "echo foo X"
    //   Ctrl+Y                   → buffer = "echo foo XBAD"
    steps: ['echo foo BAD', CTRL_W, 'X', CTRL_Y],
    expect: 'foo XBAD',
  },

  // ────────────── Ctrl+T — transpose ──────────────
  // bash: with cursor over a char, swap the char BEFORE cursor with the
  // char AT cursor, then advance cursor by one. Edge cases:
  //   - at end of line: swap last two chars
  //   - at start of line: bell, no-op
  {
    name: 'Ctrl+T at end of line — swaps last two chars',
    // type "echo abcd", at end-of-line, Ctrl+T → "echo abdc"
    steps: ['echo abcd', CTRL_T],
    expect: 'abdc',
  },
  {
    name: 'Ctrl+T mid-line — swaps char-before with char-at, advances',
    // type "echo abcd", ←×2 (cursor between b and c), Ctrl+T → "echo acbd"
    // (swap b and c, advance cursor)
    steps: ['echo abcd', ARROW_LEFT, ARROW_LEFT, CTRL_T],
    expect: 'acbd',
  },

  // ────────────── Ctrl+D — delete char fwd when line non-empty ──────────────
  {
    name: 'Ctrl+D mid-line deletes char at cursor (not EOF)',
    // type "echo abZcd", ←×3 (cursor on Z), Ctrl+D → "echo abcd"
    steps: ['echo abZcd', ARROW_LEFT, ARROW_LEFT, ARROW_LEFT, CTRL_D],
    expect: 'abcd',
  },
]);
