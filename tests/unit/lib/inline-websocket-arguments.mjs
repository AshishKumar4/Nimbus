export async function inlineWebSocketArguments(base) {
  // Invalid WebIDL inputs are intentional: compare their runtime conversions.
  const NativeWebSocket = /** @type {any} */ (WebSocket);
  const events = [];
  const constructorCases = [
    ['no URL', []], ['bad URL', ['not a URL']], ['fragment', [base + '/#']],
    ['duplicate', [base, ['chat', 'CHAT']]], ['invalid protocol', [base, ['bad space']]],
    ['symbol protocol', [base, Symbol('p')]], ['symbol URL', [Symbol('u')]],
    ['bad iterator', [base, { [Symbol.iterator]: undefined }]],
  ];
  for (const [name, args] of constructorCases) {
    try { const socket = new NativeWebSocket(...args); socket.close(); events.push([name, 'accepted']); }
    catch (error) { events.push([name, error.name]); }
  }
  const getters = [];
  const initialized = new NativeWebSocket(base, {
    get protocols() { getters.push('protocols'); return ['chat']; },
    get dispatcher() { getters.push('dispatcher'); return undefined; },
    get headers() { getters.push('headers'); return { 'x-review': 'getters' }; },
  });
  await new Promise((resolve, reject) => {
    initialized.onerror = (event) => reject(new Error(event.message ?? event.error?.message));
    initialized.onopen = () => { events.push(['init getters', getters]); initialized.close(3000); };
    initialized.onclose = resolve;
  });
  for (const [options, code, reason] of [
    ['chat', 3000.1, null], [new Set(['chat']), 3001.8, true],
    [7, { valueOf() { return 3000; } }, { toString() { return 'reason'; } }],
    [{}, 3000, undefined], [{ protocols: null, headers: [['X-Review', 'list']] }, 3000, 'done'],
  ]) {
    const next = new NativeWebSocket(base, options);
    await new Promise((resolve, reject) => {
      next.onerror = (event) => reject(new Error(event.message ?? event.error?.message));
      next.onopen = () => { events.push(['constructor', next.protocol]); next.close(code, reason); };
      next.onclose = (event) => { events.push(['converted close', event.code, event.reason]); resolve(); };
    });
  }
  const socket = new NativeWebSocket(base + '/headers', { protocols: ['chat'], headers: { 'x-review': 'yes' } });
  socket.binaryType = 'arraybuffer';
  socket.binaryType = 'invalid';
  events.push(['binaryType invalid', socket.binaryType]);
  socket.binaryType = { toString() { return 'arraybuffer'; } };
  events.push(['binaryType object', socket.binaryType]);
  const values = [7, true, null, undefined, { toString() { return 'custom'; } }, '\ud800', 'text',
    new Uint8Array([0, 128, 255]), new DataView(new Uint8Array([8, 9, 10]).buffer, 1, 2),
    new Uint8Array([11, 12]).buffer, new Blob(['blob'])];
  await new Promise((resolve, reject) => {
    let index = 0;
    socket.onerror = (event) => reject(new Error(event.message ?? event.error?.message ?? 'WebSocket failed'));
    socket.onopen = () => {
      events.push(['open', socket.protocol]);
      try { socket.send(Symbol('data')); events.push(['symbol send', 'accepted']); }
      catch (error) { events.push(['symbol send', error.name]); }
      try { socket.send(); events.push(['missing send', 'accepted']); }
      catch (error) { events.push(['missing send', error.name]); }
      for (const [code, reason] of [[1001, ''], [3000, 'x'.repeat(124)], [Symbol('code'), ''], [3000, Symbol('reason')]]) {
        try { socket.close(code, reason); events.push(['invalid close', 'accepted']); }
        catch (error) { events.push(['invalid close', error.name]); }
      }
      socket.send(values[index++]);
    };
    socket.onmessage = async (event) => {
      if (typeof event.data === 'string') events.push(['message', event.data]);
      else events.push(['binary', [...new Uint8Array(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data)]]);
      if (index < values.length) socket.send(values[index++]);
      else socket.close('3000', 42);
    };
    socket.onclose = (event) => { events.push(['close', event.code, event.reason, event.wasClean]); resolve(); };
  });
  return events;
}
