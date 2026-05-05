<script lang="ts">
  import { greet } from '$lib/greet';
  const message = greet('SvelteKit');
</script>

<h1 data-sveltekit-test-marker>{message}</h1>
<p>Minimal SvelteKit fixture for Nimbus W11.</p>
