# @nimbus-sh/react

`<NimbusTerminal />` — drop a Nimbus terminal into any React app.

## Install

```bash
npm install @nimbus-sh/react @nimbus-sh/sdk react
```

`react` is a peer-dep (>=18) so the embedder's React copy is the
only one loaded.

## Quickstart

```tsx
import { NimbusTerminal } from '@nimbus-sh/react';
import { useEffect, useState } from 'react';

export function App() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // Embedder's own endpoint mints the token from JWT_SECRET in env.
    fetch('/api/auth/mint', { method: 'POST',
      body: JSON.stringify({ tenant: 'acme', sub: 'alice' }) })
      .then(r => r.json())
      .then(({ token }) => setToken(token));
  }, []);

  if (!token) return <div>Loading…</div>;
  return (
    <NimbusTerminal
      endpoint="https://my-nimbus.workers.dev"
      token={token}
      tenant="acme"
      sub="alice"
      onReady={() => console.log('session attached')}
      style={{ width: '100%', height: 500 }}
    />
  );
}
```

## Props

| Prop | Type | Required | Default | What |
|---|---|---|---|---|
| `endpoint` | `string` | ✓ | — | Base URL of your Nimbus deploy. |
| `token` | `string` | ✓ | — | JWT from `issueNimbusToken`. |
| `tenant` | `string` | ✓ | — | Must match token's `tn` claim. |
| `sub` | `string` | | — | Must match token's `sub` claim. |
| `sessionId` | `string` | | — | Attach to existing session. Absent → mint via `/new`. |
| `onReady` | `() => void` | | — | Fired when WS connects + first prompt visible. |
| `onError` | `(e: NimbusTerminalError) => void` | | — | Fired on session-side errors. |
| `style` | `CSSProperties` | | `{width:'100%',height:'100%'}` | Inline iframe styles. |
| `className` | `string` | | — | Extra class on the iframe. |
| `sandbox` | `string` | | `allow-scripts allow-same-origin allow-downloads allow-forms allow-popups` | iframe sandbox attribute. |
| `title` | `string` | | `Nimbus terminal` | Accessibility title. |

## Imperative handle

```tsx
import { useRef } from 'react';
import { NimbusTerminal, type NimbusTerminalRef } from '@nimbus-sh/react';

const ref = useRef<NimbusTerminalRef>(null);

<NimbusTerminal ref={ref} … />
<button onClick={() => ref.current?.reload()}>Reset session</button>
```

`ref.current` exposes:

- `reload()` — force-fetch the iframe.
- `getUrl()` — current attach URL.
- `getElement()` — the underlying `<iframe>` HTMLElement.

## Headless: `useNimbusSession()`

For embedders that want their own UI:

```tsx
import { useNimbusSession } from '@nimbus-sh/react';

function MyTerm({ token }: { token: string }) {
  const { ready, attachUrl, error } = useNimbusSession({
    endpoint: 'https://my-nimbus.workers.dev',
    token,
    tenant: 'acme',
  });
  if (error)              return <div>Error: {error.message}</div>;
  if (!ready || !attachUrl) return <div>Loading…</div>;
  return <iframe src={attachUrl} style={{ width: '100%', height: 400 }} />;
}
```

## Why an iframe (not direct DOM render)?

Three reasons:

1. The xterm shell ships once from Nimbus — no per-embedder bundle bloat.
2. Cross-origin isolation: embedder JS can't snoop the WebSocket.
3. The shell handles keybinding/resize/CSP-quirks natively; we don't
   want to duplicate that logic in a React component.

A direct-DOM mode (`mode="direct"`) is on the v0.2 roadmap.

MIT.
