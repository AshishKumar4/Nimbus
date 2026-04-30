import { h, render } from "preact";

const features = [
  { icon: "⚡", title: "Edge Computing", desc: "Run code in 300+ cities worldwide with sub-millisecond cold starts" },
  { icon: "🗄️", title: "10 GB SQLite", desc: "Full POSIX filesystem backed by Durable Object SQLite storage" },
  { icon: "🔀", title: "Dynamic Isolates", desc: "Spawn V8 isolates at runtime — each process gets its own sandbox" },
  { icon: "📦", title: "npm Install", desc: "Install any pure-JS package directly from the npm registry" },
  { icon: "🛠️", title: "Esbuild Bundler", desc: "TypeScript, JSX, and bundling via esbuild-wasm" },
  { icon: "🔥", title: "Hot Reload", desc: "File changes trigger instant HMR updates in the preview" },
];

const stats = [
  { value: "300+", label: "Edge Locations" },
  { value: "<1ms", label: "Cold Start" },
  { value: "10 GB", label: "Storage" },
  { value: "∞", label: "Possibilities" },
];

function Navbar() {
  return <nav class="navbar"><div class="nav-brand"><span class="nav-logo">◈</span><span>LIFO Edge OS</span></div><div class="nav-links"><a href="#features">Features</a><a href="#stats">Performance</a><a href="#cta" class="nav-btn">Get Started</a></div></nav>;
}

function Hero() {
  return (
    <section class="hero">
      <div class="hero-badge">Built on Cloudflare Durable Objects</div>
      <h1 class="hero-title">The Browser is the <span class="gradient-text">Operating System</span></h1>
      <p class="hero-subtitle">A full Unix-like environment running at the edge. Shell, filesystem, package manager, bundler, and dev server — all inside a Durable Object with 10 GB SQLite storage.</p>
      <div class="hero-actions">
        <button class="btn btn-primary">npx lifo-sh</button>
        <button class="btn btn-secondary">View on GitHub →</button>
      </div>
      <div class="hero-terminal">
        <div class="terminal-header"><div class="terminal-dots"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></div><span class="terminal-title">user@lifo-edge:~$</span></div>
        <div class="terminal-body">
          <div class="terminal-line"><span class="prompt">$</span> npm install preact</div>
          <div class="terminal-line dim">added 1 package in 0.2s</div>
          <div class="terminal-line"><span class="prompt">$</span> echo "Hello from the edge!" &gt; hello.txt</div>
          <div class="terminal-line"><span class="prompt">$</span> cat hello.txt</div>
          <div class="terminal-line dim">Hello from the edge!</div>
          <div class="terminal-line"><span class="prompt">$</span> df -h</div>
          <div class="terminal-line dim">sqlite         10.7G   24K 10.7G   0% /</div>
          <div class="terminal-line"><span class="prompt">$</span> <span class="cursor">▎</span></div>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section class="features" id="features">
      <h2 class="section-title">Everything you need at the edge</h2>
      <p class="section-subtitle">A complete development environment in Cloudflare's global network</p>
      <div class="features-grid">{features.map((f, i) => <div class="feature-card" key={i}><div class="feature-icon">{f.icon}</div><h3>{f.title}</h3><p>{f.desc}</p></div>)}</div>
    </section>
  );
}

function Stats() {
  return <section class="stats" id="stats"><div class="stats-grid">{stats.map((s, i) => <div class="stat-card" key={i}><div class="stat-value">{s.value}</div><div class="stat-label">{s.label}</div></div>)}</div></section>;
}

function CTA() {
  return (
    <section class="cta" id="cta">
      <h2>Ready to build at the edge?</h2>
      <p>Start with a single command. No installation required.</p>
      <div class="cta-code"><code>npx lifo-sh</code></div>
    </section>
  );
}

function App() {
  return <div class="app"><Navbar /><Hero /><Features /><Stats /><CTA /><footer class="footer"><div class="footer-content"><div class="footer-brand"><span class="nav-logo">◈</span> LIFO Edge OS</div><p>Powered by Cloudflare Durable Objects + SQLite</p></div></footer></div>;
}

render(<App />, document.getElementById("root")!);
