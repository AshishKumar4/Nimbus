console.log('cwd before:', process.cwd());
try { process.chdir('/tmp'); console.log('cwd after chdir:', process.cwd()); } catch(e) { console.log('chdir fail:', e.message); }