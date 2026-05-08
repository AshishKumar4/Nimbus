// W10 functional: detectCloudflareWorkersProject

import { ok, eq, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
// Imports the detector from the leaf module project-detect.ts (Bun can't
// load nimbus-session.ts because it pulls cloudflare:workers).
import { detectCloudflareWorkersProject } from '../../../../src/runtime/project-detect.ts';

// Case 1: empty project — false
{
  const vfs = makeMockVfs();
  eq('empty project not CF Workers', detectCloudflareWorkersProject(vfs, 'home/user'), false);
}

// Case 2: wrangler.jsonc present
{
  const vfs = makeMockVfs();
  vfs.writeFile('home/user/wrangler.jsonc', '{"name":"x","main":"src/index.ts"}');
  eq('wrangler.jsonc → true', detectCloudflareWorkersProject(vfs, 'home/user'), true);
}

// Case 3: wrangler.json
{
  const vfs = makeMockVfs();
  vfs.writeFile('home/user/wrangler.json', '{"name":"x"}');
  eq('wrangler.json → true', detectCloudflareWorkersProject(vfs, 'home/user'), true);
}

// Case 4: wrangler.toml
{
  const vfs = makeMockVfs();
  vfs.writeFile('home/user/wrangler.toml', 'name = "x"\nmain = "src/index.ts"');
  eq('wrangler.toml → true', detectCloudflareWorkersProject(vfs, 'home/user'), true);
}

// Case 5: package.json with wrangler in devDependencies
{
  const vfs = makeMockVfs();
  vfs.writeFile('home/user/package.json', JSON.stringify({
    name: 'foo',
    devDependencies: { wrangler: '^3.0.0' },
  }));
  eq('package.json devDeps wrangler → true',
    detectCloudflareWorkersProject(vfs, 'home/user'), true);
}

// Case 6: package.json with wrangler in dependencies
{
  const vfs = makeMockVfs();
  vfs.writeFile('home/user/package.json', JSON.stringify({
    name: 'foo',
    dependencies: { wrangler: '^3.0.0' },
  }));
  eq('package.json deps wrangler → true',
    detectCloudflareWorkersProject(vfs, 'home/user'), true);
}

// Case 7: package.json without wrangler
{
  const vfs = makeMockVfs();
  vfs.writeFile('home/user/package.json', JSON.stringify({
    name: 'foo',
    dependencies: { express: '^4' },
  }));
  eq('package.json without wrangler → false',
    detectCloudflareWorkersProject(vfs, 'home/user'), false);
}

// Case 8: malformed package.json doesn't crash; returns false
{
  const vfs = makeMockVfs();
  vfs.writeFile('home/user/package.json', '{ this is not json');
  eq('malformed package.json → false (no crash)',
    detectCloudflareWorkersProject(vfs, 'home/user'), false);
}

summary('w10/functional/project-type-detection');
