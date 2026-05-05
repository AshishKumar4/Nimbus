import { useState } from 'react';

export default function Counter() {
  const [n, setN] = useState(0);
  return (
    <button onClick={() => setN((x) => x + 1)} data-test="counter">
      count is {n}
    </button>
  );
}
