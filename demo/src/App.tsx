import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar.tsx';
import { Hero } from './components/Hero.tsx';
import { Features } from './components/Features.tsx';
import { LiveStats } from './components/LiveStats.tsx';
import { Terminal } from './components/Terminal.tsx';
import { Footer } from './components/Footer.tsx';

const h = React.createElement;

export function App(): React.ReactElement {
  return h('div', { className: 'app' },
    h(Navbar),
    h('main', null,
      h(Hero),
      h(Features),
      h(Terminal),
      h(LiveStats),
    ),
    h(Footer),
  );
}
