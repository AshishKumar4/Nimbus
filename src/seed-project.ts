/**
 * seed-project.ts — Materialize a polished Vite + React + TS + Tailwind +
 * React Router starter at /home/user/app on first boot.
 *
 * Invariants:
 *   - Idempotent: won't re-seed once the sentinel (~/.nimbus-seeded) exists.
 *   - Atomic-ish: file bodies written in ONE writeBatch(); sentinel written
 *     in a SECOND writeBatch() so a crash between the two re-runs the whole
 *     seed on next boot (writeFile is idempotent, so retry is safe).
 *   - User escape hatch: `rm -rf ~/app ~/.nimbus-seeded` → next session
 *     regenerates from factory defaults (hard reset semantics).
 *
 * Design choices (see plan):
 *   - Root: /home/user/app (doesn't pollute the home dir)
 *   - Polished deps: react-router, framer-motion, lucide-react, tailwindcss
 *   - No pre-install of node_modules (~200MB; let the user see install run)
 *   - No auto-start of vite (surprising; README says `npm run dev`)
 *   - Basename injection (commit 2) handles the /preview/ basepath wiring.
 */

import type {
  SqliteVFS,
  BatchInodeEntry,
  BatchChunkEntry,
} from './sqlite-vfs.js';
import { CHUNK_SIZE } from './constants.js';
import { enc } from './_shared/bytes.js';

/** Sentinel: if present, seed never runs again (until user deletes it). */
export const SEED_SENTINEL_PATH = 'home/user/.nimbus-seeded';

/** Project root. Absolute VFS path (no leading slash). */
export const SEED_PROJECT_DIR = 'home/user/app';

export interface SeedFile {
  /** VFS path, no leading slash. */
  path: string;
  content: string;
}

// ── File bodies ─────────────────────────────────────────────────────────

const PACKAGE_JSON = `{
  "name": "nimbus-starter",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "framer-motion": "^11.11.0",
    "lucide-react": "^0.460.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nimbus Starter</title>
    <link rel="stylesheet" href="/src/index.css" />
  </head>
  <body class="bg-slate-950 text-slate-100 antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const VITE_CONFIG = `import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
`;

const TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
`;

const INDEX_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

html,
body,
#root {
  height: 100%;
}

body {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    'Segoe UI', sans-serif;
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}

/* Layered background:
 *   1. Warm orange spotlight from the top
 *   2. Cool violet rim light from the right (depth, not color)
 *   3. Faint grid pattern (Linear / Vercel-style)
 *   4. Deep slate base
 */
body {
  background-color: #020617;
  background-image:
    radial-gradient(1100px 520px at 18% -8%, rgba(243, 128, 32, 0.18), transparent 60%),
    radial-gradient(900px 600px at 95% 10%, rgba(99, 102, 241, 0.08), transparent 60%),
    linear-gradient(rgba(148, 163, 184, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.04) 1px, transparent 1px);
  background-size: auto, auto, 40px 40px, 40px 40px;
  background-position: 0 0, 0 0, -1px -1px, -1px -1px;
  background-attachment: fixed;
}

/* Selection */
::selection { background: rgba(243, 128, 32, 0.35); color: #fff7ed; }

/* Custom scrollbar */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 8px; }
::-webkit-scrollbar-thumb:hover { background: #334155; }

/* Hero gradient text — sized so the bg-clip mask doesn't crop descenders */
.hero-gradient {
  background: linear-gradient(135deg, #fdba74 0%, #f97316 35%, #f38020 60%, #fb7185 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  background-size: 200% 200%;
  animation: hero-shift 12s ease-in-out infinite;
}
@keyframes hero-shift {
  0%, 100% { background-position: 0% 50%; }
  50%      { background-position: 100% 50%; }
}

/* Soft glow ring on hover for feature cards */
.card-glow {
  position: relative;
  isolation: isolate;
}
.card-glow::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(135deg, rgba(243, 128, 32, 0.0), rgba(243, 128, 32, 0.0));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  pointer-events: none;
  transition: background 280ms ease;
  z-index: -1;
}
.card-glow:hover::before {
  background: linear-gradient(135deg, rgba(243, 128, 32, 0.55), rgba(251, 113, 133, 0.25));
}

/* Terminal block */
.terminal {
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.85), rgba(2, 6, 23, 0.85));
  border: 1px solid rgba(148, 163, 184, 0.12);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 20px 60px -20px rgba(243, 128, 32, 0.18);
}
`;

const MAIN_TSX = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import App from './App';
import Home from './pages/Home';
import Docs from './pages/Docs';
import Playground from './pages/Playground';
import './index.css';

// Note: Nimbus automatically injects a \`basename\` matching this session's
// preview URL (e.g. "/s/<id>/preview") so links like <NavLink to="/docs">
// resolve correctly. To opt out, add the comment "// nimbus-no-basename"
// anywhere in this file, or set an explicit basename yourself — Nimbus
// will not override user-supplied values.
const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'docs', element: <Docs /> },
      { path: 'playground', element: <Playground /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
`;

const APP_TSX = `import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Home, FileText, Zap } from 'lucide-react';

const nav = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/docs', label: 'Docs', icon: FileText, end: false },
  { to: '/playground', label: 'Playground', icon: Zap, end: false },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 mb-10">
      <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-orange-400 via-orange-500 to-rose-500 shadow-lg shadow-orange-500/20 flex items-center justify-center">
        <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-white/20 to-transparent" />
        <svg viewBox="0 0 24 24" className="relative w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6 6 0 0 0 4 13a4 4 0 0 0 .5 7.95"/>
        </svg>
      </div>
      <div className="flex flex-col leading-none">
        <div className="font-semibold tracking-tight text-slate-100">Nimbus</div>
        <div className="text-[10px] text-slate-500 mt-0.5 tracking-wider uppercase">Edge OS</div>
      </div>
    </div>
  );
}

export default function App() {
  const loc = useLocation();
  return (
    <div className="min-h-full flex">
      <aside className="w-60 shrink-0 border-r border-slate-800/60 p-6 flex flex-col gap-1 bg-slate-950/30 backdrop-blur-xl">
        <Logo />
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-3 mb-2">
          Navigation
        </div>
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              \`group relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 \${
                isActive
                  ? 'bg-orange-500/10 text-orange-200 ring-1 ring-orange-500/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-100'
              }\`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="nav-indicator"
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full bg-orange-400"
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  />
                )}
                <n.icon className={\`w-4 h-4 transition \${isActive ? 'text-orange-300' : 'text-slate-500 group-hover:text-slate-300'}\`} />
                <span className="font-medium">{n.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <div className="mt-auto pt-6 border-t border-slate-800/60">
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-[11px] font-medium text-slate-300">Live in a Durable Object</span>
          </div>
          <div className="text-[11px] text-slate-500 leading-relaxed">
            Edit <code className="text-slate-300 font-mono text-[10px] px-1 py-0.5 bg-slate-800/60 rounded">src/pages/Home.tsx</code> and save \u2014 HMR reloads instantly.
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={loc.pathname}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="p-10 lg:p-14 max-w-6xl mx-auto"
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
`;

const HOME_TSX = `import { motion } from 'framer-motion';
import { Zap, HardDrive, Cpu, ArrowRight, BookOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import SystemStats from '../components/SystemStats';
import Card from '../components/Card';

const features = [
  {
    icon: Cpu,
    title: 'Edge-Native Runtime',
    desc: 'Node, npm, git, vite and 60+ Unix utilities, all running inside one Durable Object \u2014 no cold starts, no containers.',
    accent: 'from-orange-400/20 to-orange-600/5',
    iconBg: 'from-orange-500/20 to-orange-600/10',
    iconColor: 'text-orange-300',
  },
  {
    icon: Zap,
    title: 'Sub-second HMR',
    desc: 'esbuild + Vite serve straight from the VFS. Edit a file, save, and your preview reflects it before your eye reaches the tab.',
    accent: 'from-amber-400/20 to-amber-600/5',
    iconBg: 'from-amber-500/20 to-amber-600/10',
    iconColor: 'text-amber-300',
  },
  {
    icon: HardDrive,
    title: '10 GB Persistent VFS',
    desc: 'A SQLite-backed filesystem that survives restarts. Clone real repos, install real packages, never lose a thing.',
    accent: 'from-rose-400/20 to-rose-600/5',
    iconBg: 'from-rose-500/20 to-rose-600/10',
    iconColor: 'text-rose-300',
  },
];

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
};

export default function Home() {
  return (
    <div className="space-y-20">
      {/* HERO */}
      <header className="relative pt-4">
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 ring-1 ring-orange-500/30 text-orange-200 text-xs font-medium backdrop-blur">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-orange-400"></span>
            </span>
            <span className="tracking-wide">Running on Cloudflare\u2019s edge \u00b7 v0.1</span>
          </div>
        </motion.div>

        <motion.h1
          {...fadeUp}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.06 }}
          className="mt-6 text-6xl md:text-7xl font-bold tracking-tight leading-[1.05] hero-gradient max-w-4xl pb-2"
        >
          A dev environment<br />that lives at the edge.
        </motion.h1>

        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.14 }}
          className="mt-6 text-xl text-slate-400 max-w-2xl leading-relaxed"
        >
          Nimbus is a full Linux-like workspace \u2014 node, npm, git, vite \u2014
          running entirely inside a single Cloudflare Durable Object. No VMs.
          No cold starts. Just code.
        </motion.p>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.22 }}
          className="mt-8 flex flex-wrap items-center gap-3"
        >
          <Link
            to="/playground"
            className="group inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-400 text-white font-medium text-sm shadow-lg shadow-orange-500/25 hover:shadow-orange-500/40 transition-all hover:-translate-y-0.5"
          >
            Try the Playground
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            to="/docs"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900/60 hover:bg-slate-800/80 text-slate-200 font-medium text-sm ring-1 ring-slate-700/60 hover:ring-slate-600 transition"
          >
            <BookOpen className="w-4 h-4" />
            Read the docs
          </Link>
        </motion.div>

        {/* Terminal block */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="mt-12 terminal rounded-xl overflow-hidden max-w-2xl"
        >
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800/60 bg-slate-950/40">
            <div className="flex gap-1.5">
              <span className="w-3 h-3 rounded-full bg-rose-500/70"></span>
              <span className="w-3 h-3 rounded-full bg-amber-500/70"></span>
              <span className="w-3 h-3 rounded-full bg-emerald-500/70"></span>
            </div>
            <span className="ml-2 text-[11px] text-slate-500 font-mono">~/app</span>
          </div>
          <pre className="px-5 py-4 text-[13px] font-mono leading-relaxed overflow-x-auto">
<span className="text-slate-600">$</span> <span className="text-slate-300">npm install</span>
<span className="text-slate-500">  added 184 packages in 8.9s</span>
<span className="text-slate-600">$</span> <span className="text-slate-300">npm run dev</span>
<span className="text-slate-500">  </span><span className="text-orange-300">VITE</span><span className="text-slate-500"> v5.4.0  ready in </span><span className="text-emerald-300">312 ms</span>
<span className="text-slate-500">  \u279c</span> <span className="text-slate-300">Local:   </span><span className="text-orange-300 underline decoration-orange-500/40">http://localhost:5173/</span>
          </pre>
        </motion.div>
      </header>

      {/* FEATURES */}
      <section>
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.4, delay: 0.4 }}
          viewport={{ once: true }}
          whileInView={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Why Nimbus
          </h2>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-100">
            The full stack. None of the weight.
          </p>
        </motion.div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ delay: 0.05 + i * 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <Card className="card-glow group h-full transition-all duration-300 hover:-translate-y-1">
                <div className={\`w-11 h-11 rounded-xl bg-gradient-to-br \${f.iconBg} ring-1 ring-white/5 flex items-center justify-center mb-5 group-hover:scale-110 transition-transform duration-300\`}>
                  <f.icon className={\`w-5 h-5 \${f.iconColor}\`} />
                </div>
                <h3 className="font-semibold text-slate-100 text-base">{f.title}</h3>
                <p className="text-sm text-slate-400 mt-2 leading-relaxed">{f.desc}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      {/* LIVE STATS */}
      <section>
        <div className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Live system stats
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Polled from <code className="text-slate-400 font-mono">/api/stats</code> every 3s \u2014 your real Durable Object talking back.
          </p>
        </div>
        <SystemStats />
      </section>

      <footer className="text-sm text-slate-500 pt-8 border-t border-slate-800/60 flex flex-wrap items-center justify-between gap-4">
        <div>
          Hack on this page: <code className="text-slate-300 font-mono">src/pages/Home.tsx</code>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse"></span>
          <span className="text-slate-400">HMR connected</span>
        </div>
      </footer>
    </div>
  );
}
`;

const DOCS_TSX = `import Card from '../components/Card';
import { Terminal, GitBranch, Package, Rocket } from 'lucide-react';

const sections = [
  {
    icon: Terminal,
    title: 'Open the terminal',
    body: 'Connect via WebSocket to /ws. You get a full shell with node, npm, git, vite, esbuild and about 60 Unix utilities.',
  },
  {
    icon: Package,
    title: 'Install packages',
    body: 'npm install works against the real registry. Nimbus uses a batched VFS + content-addressed cache so 500-package installs land in ~80 seconds.',
  },
  {
    icon: GitBranch,
    title: 'Clone a real repo',
    body: 'git clone https://github.com/you/your-repo. Network and packfile processing run in a facet worker to keep the supervisor DO unblocked.',
  },
  {
    icon: Rocket,
    title: 'Ship',
    body: 'vite build emits to dist/. Preview via this session\\'s preview URL, or wire it up to serve from the Worker itself.',
  },
];

export default function Docs() {
  return (
    <div className="space-y-10">
      <header>
        <div className="text-xs font-semibold uppercase tracking-wider text-orange-400/80">Documentation</div>
        <h1 className="mt-2 text-5xl font-bold tracking-tight text-slate-100">Get started</h1>
        <p className="text-slate-400 mt-3 text-lg max-w-2xl">
          Four things worth knowing about Nimbus before you ship something with it.
        </p>
      </header>
      <div className="space-y-4">
        {sections.map((s, i) => (
          <Card key={s.title} className="hover:border-orange-500/20 transition-colors">
            <div className="flex gap-5">
              <div className="shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-orange-500/15 to-rose-500/5 ring-1 ring-orange-500/20 flex items-center justify-center">
                <s.icon className="w-5 h-5 text-orange-300" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-slate-500">0{i + 1}</span>
                  <h3 className="font-semibold text-slate-100 text-lg">{s.title}</h3>
                </div>
                <p className="text-sm text-slate-400 mt-2 leading-relaxed">{s.body}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <div className="text-sm text-slate-500 pt-6 border-t border-slate-800/60">
        Full source at <code className="text-slate-300 font-mono">src/pages/Docs.tsx</code>.
      </div>
    </div>
  );
}
`;

const PLAYGROUND_TSX = `import { useState } from 'react';
import { motion } from 'framer-motion';
import { Heart, Star, Sparkles, Zap, RefreshCcw } from 'lucide-react';
import Card from '../components/Card';

export default function Playground() {
  const [count, setCount] = useState(0);
  const [liked, setLiked] = useState(false);
  return (
    <div className="space-y-10">
      <header>
        <div className="text-xs font-semibold uppercase tracking-wider text-orange-400/80">Playground</div>
        <h1 className="mt-2 text-5xl font-bold tracking-tight text-slate-100">
          Press buttons. Watch state.
        </h1>
        <p className="text-slate-400 mt-3 text-lg max-w-2xl">
          Minimal React state demo. Edit this file and save \u2014 HMR keeps the counter value.
        </p>
      </header>

      <Card>
        <div className="flex items-center gap-6">
          <div className="flex flex-col gap-4">
            <div className="text-7xl font-bold tabular-nums bg-gradient-to-br from-orange-300 to-rose-400 bg-clip-text text-transparent">
              {count}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setCount((c) => c + 1)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-orange-500 hover:bg-orange-400 text-white transition flex items-center gap-2 shadow-lg shadow-orange-500/20 hover:shadow-orange-500/30 hover:-translate-y-0.5"
              >
                <Zap className="w-4 h-4" />
                Increment
              </button>
              <button
                onClick={() => setCount(0)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-200 transition flex items-center gap-2 ring-1 ring-slate-700/60"
              >
                <RefreshCcw className="w-4 h-4" />
                Reset
              </button>
            </div>
          </div>
          <div className="ml-auto">
            <motion.button
              onClick={() => setLiked((v) => !v)}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              className={\`w-16 h-16 rounded-full flex items-center justify-center transition \${
                liked
                  ? 'bg-rose-500/20 ring-2 ring-rose-500/50 text-rose-400 shadow-lg shadow-rose-500/20'
                  : 'bg-slate-800/80 text-slate-400 hover:bg-slate-700 ring-1 ring-slate-700/60'
              }\`}
            >
              <Heart className={\`w-6 h-6 \${liked ? 'fill-rose-400' : ''}\`} />
            </motion.button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 mb-3">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h3 className="font-semibold">Try this</h3>
        </div>
        <ul className="space-y-2 text-sm text-slate-400 list-disc list-inside">
          <li>Open the terminal and run <code className="text-slate-300">ls src/pages</code></li>
          <li>Edit <code className="text-slate-300">src/pages/Playground.tsx</code> — save — HMR keeps state</li>
          <li>Click <Star className="inline w-3.5 h-3.5 text-yellow-400 -mt-0.5" /> on <code className="text-slate-300">lucide-react</code> when you're done</li>
        </ul>
      </Card>
    </div>
  );
}
`;

const CARD_TSX = `import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
}

export default function Card({ children, className = '' }: CardProps) {
  return (
    <div
      className={
        'p-6 rounded-xl bg-slate-900/50 border border-slate-800/70 backdrop-blur-sm ' +
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ' +
        'hover:border-slate-700/80 transition-colors ' +
        className
      }
    >
      {children}
    </div>
  );
}
`;

const SYSTEM_STATS_TSX = `import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import Card from './Card';

interface Stats {
  files: number;
  directories: number;
  usedBytes: number;
  capacityBytes: number;
  inodes?: { total: number; files: number; directories: number };
  cache?: { entries: number; hits: number; misses: number; hitRate: number };
}

export default function SystemStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // The preview is served at <session>/preview/...  where <session> is
      // either "" (legacy, single-DO mode) or "/s/<id>" (multi-session mode).
      // Strip the /preview tail from the current URL to get the API root.
      // Using location.pathname avoids hardcoding a session ID at build time.
      const apiRoot = location.pathname.replace(/\\/preview(\\/.*)?$/, '');
      fetch(apiRoot + '/api/stats')
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((s) => { if (!cancelled) setStats(s); })
        .catch((e) => { if (!cancelled) setError(String(e.message || e)); });
    };
    load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) {
    return (
      <Card>
        <div className="text-sm text-rose-300">Could not load /api/stats: {error}</div>
      </Card>
    );
  }
  if (!stats) {
    return (
      <Card>
        <div className="text-sm text-slate-500">Loading stats…</div>
      </Card>
    );
  }

  const mb = (stats.usedBytes / 1_000_000).toFixed(1);
  const cap = (stats.capacityBytes / 1_000_000_000).toFixed(1);
  const pct = (stats.usedBytes / stats.capacityBytes) * 100;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatTile label="Files" value={stats.files.toLocaleString()} />
      <StatTile label="Directories" value={stats.directories.toLocaleString()} />
      <StatTile label="Used" value={\`\${mb} MB\`} sub={\`of \${cap} GB\`} />
      <StatTile
        label="Used %"
        value={pct.toFixed(2) + '%'}
        sub={<ProgressBar value={pct} />}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25 }}
      className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80"
    >
      <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-slate-100">
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </motion.div>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="mt-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-orange-500 to-rose-500"
        style={{ width: \`\${Math.min(100, Math.max(0.5, value))}%\` }}
      />
    </div>
  );
}
`;

const README_MD = `# Nimbus Starter

A polished Vite + React + TypeScript + Tailwind + React Router starter,
pre-seeded on first boot inside a Cloudflare Durable Object.

## Quickstart

    cd app                      # you're probably already here
    npm install                 # ~450 packages, ~80 seconds on first run
    npm run dev                 # starts vite; preview opens in the sidebar

## What's inside

- **React 18** with automatic JSX runtime
- **React Router 6** — routes at \`/\`, \`/docs\`, \`/playground\`
- **Tailwind CSS** via the edge-vendored Play CDN (auto-injected by
  Nimbus when it sees a \`tailwind.config.*\` file in the project root —
  served from \`/__nimbus_assets/tailwind-play.js\`, no third-party CDN)
- **Framer Motion** for page transitions and micro-interactions
- **Lucide icons**
- **Live system stats** — \`src/components/SystemStats.tsx\` polls the
  session-relative \`/api/stats\` endpoint so you can verify the whole stack
  is wired end-to-end.

## Routing under the preview path

Your session has a shareable URL of the form
\`https://<host>/s/<session-id>/\`, and the preview is served at
\`https://<host>/s/<session-id>/preview/\`. Nimbus automatically injects the
matching \`basename\` into your \`createBrowserRouter\` / \`<BrowserRouter>\`
so \`<NavLink to="/docs">\` lands at the right path with no extra config.

To opt out:

- Set an explicit \`basename\` yourself — Nimbus never overrides user values, OR
- Add the comment \`// nimbus-no-basename\` anywhere in your entry file, OR
- Add \`nimbusInjectBasename: false\` to your \`vite.config.ts\`.

## Start fresh

    rm -rf ~/app ~/.nimbus-seeded

Then restart the session. A factory-fresh copy of this starter will be
regenerated. (The sentinel file \`~/.nimbus-seeded\` is what prevents
re-seeding on normal boots; deleting it opts back in.)

## Customize

Delete anything you don't want. The seed never runs again once
\`~/.nimbus-seeded\` exists, so your edits are safe.

## Other frameworks

Nimbus also runs (W11 status):

- **SvelteKit** (\`@sveltejs/kit\`) — \u2705 dev + build
- **Astro** (\`astro\`) — \u2705 dev + build
- **Remix v2** (\`@remix-run/dev\` vite plugin) — \u2705 dev + build
- **Nuxt 3** (\`nuxt\`) — \u26A0\uFE0F caveats (Vite + Nitro single-server only;
  HMR may degrade)
- **Next.js** (\`next\`) — \u274C blocked in Phase 1 (custom server,
  webpack/Turbopack); tracked for W11.5

To use one of the supported frameworks, clone its starter or scaffold
with \`npm create <framework>@latest\` (or your usual scaffolder), then
\`npm install && npm run dev\` from the project directory.
`;

// ── SEED_FILES list (single source of truth) ────────────────────────────

export const SEED_FILES: SeedFile[] = [
  { path: SEED_PROJECT_DIR + '/package.json',                  content: PACKAGE_JSON },
  { path: SEED_PROJECT_DIR + '/index.html',                    content: INDEX_HTML },
  { path: SEED_PROJECT_DIR + '/vite.config.ts',                content: VITE_CONFIG },
  { path: SEED_PROJECT_DIR + '/tailwind.config.js',            content: TAILWIND_CONFIG },
  { path: SEED_PROJECT_DIR + '/tsconfig.json',                 content: TSCONFIG_JSON },
  { path: SEED_PROJECT_DIR + '/README.md',                     content: README_MD },
  { path: SEED_PROJECT_DIR + '/src/index.css',                 content: INDEX_CSS },
  { path: SEED_PROJECT_DIR + '/src/main.tsx',                  content: MAIN_TSX },
  { path: SEED_PROJECT_DIR + '/src/App.tsx',                   content: APP_TSX },
  { path: SEED_PROJECT_DIR + '/src/pages/Home.tsx',            content: HOME_TSX },
  { path: SEED_PROJECT_DIR + '/src/pages/Docs.tsx',            content: DOCS_TSX },
  { path: SEED_PROJECT_DIR + '/src/pages/Playground.tsx',      content: PLAYGROUND_TSX },
  { path: SEED_PROJECT_DIR + '/src/components/Card.tsx',       content: CARD_TSX },
  { path: SEED_PROJECT_DIR + '/src/components/SystemStats.tsx', content: SYSTEM_STATS_TSX },
];

// ── Seed logic ──────────────────────────────────────────────────────────

/**
 * Should we run the starter-project seed?
 * Returns false if:
 *   - Sentinel exists (already seeded; user can `rm ~/.nimbus-seeded` to opt in again)
 *   - Project dir already exists (user has their own ~/app we must not clobber)
 */
export function shouldSeedProject(vfs: SqliteVFS): boolean {
  try {
    if (vfs.exists(SEED_SENTINEL_PATH)) return false;
    if (vfs.exists(SEED_PROJECT_DIR)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the sentinel is present (seed has completed at least once).
 * Used to gate MOTD hints about the starter app.
 */
export function hasSeededProject(vfs: SqliteVFS): boolean {
  try { return vfs.exists(SEED_SENTINEL_PATH); } catch { return false; }
}

/**
 * Materialize the seed project.
 *
 * Two-phase write for crash recovery:
 *   1. Write all file bodies + directory inodes in ONE writeBatch().
 *   2. Only on success, write the sentinel in a SEPARATE writeBatch().
 *
 * If the process dies between (1) and (2), the next boot will re-run this
 * function (sentinel absent). All writes are `INSERT OR REPLACE` so retry
 * is idempotent. If (1) itself fails mid-transaction, sqlite rolls back and
 * we start clean next boot.
 */
export function seedProject(
  vfs: SqliteVFS,
  opts?: { log?: (msg: string) => void },
): { seeded: boolean; files: number; reason?: string } {
  const log = opts?.log;

  if (!shouldSeedProject(vfs)) {
    return { seeded: false, files: 0, reason: 'already-seeded-or-present' };
  }

  log?.('[seed] materializing starter app at /home/user/app ...');

  const mtime = Date.now();
  const inodes: BatchInodeEntry[] = [];
  const chunks: BatchChunkEntry[] = [];
  const dirSet = new Set<string>();

  // Collect every directory on the path of every file
  const addDir = (dir: string) => {
    if (!dir) return;
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? cur + '/' + p : p;
      dirSet.add(cur);
    }
  };

  for (const { path, content } of SEED_FILES) {
    // Gather parent directories
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash > 0) addDir(path.substring(0, lastSlash));

    const data = enc.encode(content);
    const size = data.length;
    const chunkCount = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);

    inodes.push({
      path,
      parentPath: lastSlash > 0 ? path.substring(0, lastSlash) : '',
      isDir: false,
      size,
      mtime,
      mode: 0o644,
      chunkCount,
    });

    if (size > 0) {
      if (size <= CHUNK_SIZE) {
        chunks.push({ path, chunkId: 0, data });
      } else {
        for (let i = 0; i < chunkCount; i++) {
          chunks.push({
            path,
            chunkId: i,
            data: data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
          });
        }
      }
    }
  }

  // Add dir inodes (deduplicated by set)
  for (const dir of dirSet) {
    const lastSlash = dir.lastIndexOf('/');
    inodes.push({
      path: dir,
      parentPath: lastSlash > 0 ? dir.substring(0, lastSlash) : '',
      isDir: true,
      size: 0,
      mtime,
      mode: 0o755,
      chunkCount: 0,
    });
  }

  let fileCount = 0;
  try {
    // Phase 1: all project files + directories in ONE transactionSync
    const result = vfs.writeBatch({ inodes, chunks });
    fileCount = SEED_FILES.length;
    log?.(`[seed] wrote ${SEED_FILES.length} files + ${dirSet.size} dirs (${result.inodes} inodes, ${result.chunks} chunks)`);

    // Phase 2: sentinel in a SECOND batch — only runs if Phase 1 succeeded.
    // A crash between Phase 1 and Phase 2 leaves the project materialized but
    // no sentinel; next boot sees ~/app already exists → shouldSeedProject()
    // returns false → we skip harmlessly. (That's why we also check exists(~/app).)
    const sentinelData = enc.encode(
      `# Nimbus seed sentinel — delete this file AND ~/app to re-seed.\n` +
      `# Seeded at: ${new Date(mtime).toISOString()}\n` +
      `# Files: ${SEED_FILES.length}\n`,
    );
    vfs.writeBatch({
      inodes: [{
        path: SEED_SENTINEL_PATH,
        parentPath: 'home/user',
        isDir: false,
        size: sentinelData.length,
        mtime,
        mode: 0o644,
        chunkCount: 1,
      }],
      chunks: [{ path: SEED_SENTINEL_PATH, chunkId: 0, data: sentinelData }],
    });
    log?.(`[seed] sentinel written → ${SEED_SENTINEL_PATH}`);
  } catch (e: any) {
    log?.(`[seed] failed: ${e?.message || e}`);
    return { seeded: false, files: fileCount, reason: e?.message || 'write-failed' };
  }

  return { seeded: true, files: fileCount };
}
