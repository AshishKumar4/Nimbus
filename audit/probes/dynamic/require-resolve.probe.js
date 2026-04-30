try { console.log('require.resolve(fs):', require.resolve('fs')); } catch(e) { console.log('resolve fs fail:', e.message); }
try { console.log('require.resolve(path):', require.resolve('path')); } catch(e) { console.log('resolve path fail:', e.message); }
try { console.log('require.resolve(./nope):', require.resolve('./nope')); } catch(e) { console.log('resolve relative fail:', e.message); }