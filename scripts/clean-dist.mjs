// A package's build starts here: its dist is removed, so the build writes
// exactly what its src compiles to (tsc never deletes an output whose
// source is gone). Run from the package's directory.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

rmSync(resolve(process.cwd(), 'dist'), { recursive: true, force: true });
