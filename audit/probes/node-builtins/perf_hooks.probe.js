const p = require('perf_hooks');
console.log('keys:', Object.keys(p).slice(0, 10).join(','));
console.log('performance.now:', typeof p.performance && typeof p.performance.now);
console.log('PerformanceObserver typeof:', typeof p.PerformanceObserver);
