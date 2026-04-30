import('fs').then(m => console.log('dyn import literal ok:', typeof m.readFileSync)).catch(e => console.log('dyn import literal fail:', e.message));
setTimeout(()=>{}, 2000);