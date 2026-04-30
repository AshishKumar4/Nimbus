const spec = 'fs';
import(spec).then(m => console.log('dyn import var ok:', typeof m.readFileSync)).catch(e => console.log('dyn import var fail:', e.message));
setTimeout(()=>{}, 2000);