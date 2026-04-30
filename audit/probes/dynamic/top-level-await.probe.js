// TLA — should fail because user code runs inside new Function().
const x = await Promise.resolve(1); console.log('TLA result:', x);