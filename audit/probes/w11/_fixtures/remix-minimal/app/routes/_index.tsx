import { Link } from '@remix-run/react';

export default function Index() {
  return (
    <div data-remix-test-marker>
      <h1>Remix minimal</h1>
      <p>
        Try the <Link to="/about">about page</Link>.
      </p>
    </div>
  );
}
