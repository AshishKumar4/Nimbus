import { maxSatisfying, satisfies as pep440Satisfies, valid as validPep440Version, validRange as validPep440Range, } from '@renovatebot/pep440';
import { EnvironmentMarkerVariable, parsePipRequirementsFile, parsePipRequirementsLine, RequirementsSyntaxError, } from 'pip-requirements-js';
import { z } from 'zod/v4';
import { errorText } from '../_shared/error-text.js';
import { normalizeVfsPath, parentVfsPath, resolveVfsPath } from '../vfs/path.js';
/** Where `pip install` puts packages for the user whose home is `home`. */
export function pythonSitePackages(home) {
    return `${normalizeVfsPath(home)}/.nimbus-python/site-packages`;
}
const PYPI_API = 'https://pypi.org/pypi';
const IGNORED_PIP_INSTALL_FLAGS = new Set([
    '--upgrade',
    '-U',
    '--force-reinstall',
    '--no-cache-dir',
    '--user',
    '--disable-pip-version-check',
    '--prefer-binary',
    '--only-binary=:all:',
]);
const PIP_INSTALL_FLAGS_WITH_VALUE = new Set([
    '-i',
    '--index-url',
    '--extra-index-url',
    '-f',
    '--find-links',
    '--trusted-host',
    '--timeout',
    '--retries',
    '--platform',
    '--python-version',
    '--implementation',
    '--abi',
    '--only-binary',
]);
const PurePythonSourcePackageSchema = z.object({
    canonicalName: z.string().min(1),
    importName: z.string().min(1),
    version: z.string().min(1),
    sourceUrl: z.url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourcePackageDir: z.string().min(1),
});
const PIP_SOURCE_PACKAGES = z.record(z.string(), PurePythonSourcePackageSchema).parse({
    // Pinned to the release build-python.sh compiles _speedups.c from. The two
    // halves of this package are built apart and only meet at import, so a skew
    // between them is a C extension paired with an __init__.py it never saw.
    markupsafe: {
        canonicalName: 'markupsafe',
        importName: 'markupsafe',
        version: '3.0.3',
        sourceUrl: 'https://files.pythonhosted.org/packages/7e/99/7690b6d4034fffd95959cbe0c02de8deb3098cc577c67bb6a24fe5d7caa7/markupsafe-3.0.3.tar.gz',
        sha256: '722695808f4b6457b320fdc131280796bdceb04ab50fe1795cd540799ebe1698',
        sourcePackageDir: 'markupsafe-3.0.3/src/markupsafe',
    },
});
const VariantPackageSchema = z.object({
    canonicalName: z.string().min(1),
    version: z.string().min(1),
});
/**
 * Packages the sci interpreter variant already contains, whole.
 *
 * wasm32-wasi has no dlopen, so numpy's thirteen extension modules are linked
 * into python-sci.wasm and its Python half ships beside it in sci-packages.zip
 * (EXTENSIONS.md). There is nothing for pip to fetch, so installing one only
 * records it — and that record is what makes the next `python` choose the
 * variant that has it, which is why it is written even though no bytes move.
 *
 * markupsafe is deliberately not here: only its _speedups module is compiled, so
 * its Python half installs from source like any other package, and the variant
 * supplies the C half to a session that has selected it.
 */
const PIP_VARIANT_PACKAGES = z.record(z.string(), VariantPackageSchema).parse({
    numpy: { canonicalName: 'numpy', version: '2.4.3' },
});
/**
 * The dist-info directories that mean "this session needs the sci variant".
 *
 * Derived from the pins above rather than written out, so a version bump cannot
 * leave the selector looking for a directory pip no longer writes.
 */
const SCI_VARIANT_DIST_INFO = Object.freeze([
    ...Object.values(PIP_VARIANT_PACKAGES).map((p) => `${p.canonicalName}-${p.version}.dist-info`),
    `${PIP_SOURCE_PACKAGES.markupsafe.canonicalName}-${PIP_SOURCE_PACKAGES.markupsafe.version}.dist-info`,
]);
/**
 * Whether this session has installed anything the sci interpreter variant
 * carries compiled code for.
 *
 * This reads installed state; it does not predict what a program might import.
 * The dist-info directory pip writes is the record, and a variant chosen from it
 * is right for `python -c` reading a module name out of a variable, which a
 * per-program classifier cannot be.
 */
export async function sessionUsesSciVariant(vfs, home) {
    const sitePackages = pythonSitePackages(home);
    for (const dir of SCI_VARIANT_DIST_INFO)
        if (await vfs.exists(`${sitePackages}/${dir}`))
            return true;
    return false;
}
const PypiFileSchema = z.object({
    filename: z.string(),
    packagetype: z.string().optional(),
    url: z.url(),
    digests: z.object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }).optional(),
    yanked: z.union([z.boolean(), z.string()]).optional(),
});
const PypiJsonSchema = z.object({
    info: z.object({
        name: z.string(),
        version: z.string(),
        requires_dist: z.array(z.string()).nullable().optional(),
    }),
    releases: z.record(z.string(), z.array(PypiFileSchema)).optional(),
    urls: z.array(PypiFileSchema).optional(),
});
/**
 * PyPI's answers, by network and request, kept as pip's HTTP cache
 * (cachecontrol) keeps them: each for its response's max-age, 900 s for
 * PyPI's JSON API, none without one. What has expired is dropped whenever an
 * answer is kept, so a process's own egress leaves nothing behind it.
 */
const pypiCache = new Map();
/** How long, in ms, a response says it may be reused: its Cache-Control max-age, 0 for none (or no-store, no-cache). */
function pypiAnswerAge(resp) {
    const control = resp.headers?.get('cache-control') ?? '';
    if (/(^|,)\s*(no-store|no-cache)\s*(,|$)/i.test(control))
        return 0;
    const age = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(control);
    return age === null ? 0 : Number(age[1]) * 1000;
}
export async function buildPipInvocation(argv, binName, cwd, vfs, runtimeContext) {
    const wantsVersion = argv.includes('--version') || argv.includes('-V');
    const wantsHelp = argv.length === 0 || argv.includes('--help') || argv.includes('-h');
    if (wantsVersion) {
        return {
            mode: 'pip',
            code: `print(${JSON.stringify(`pip 24.3.1 (Nimbus package bridge for CPython ${runtimeContext.markers.python_version}, wasm32-wasi)`)})`,
            exitCode: 0,
        };
    }
    if (wantsHelp) {
        return {
            mode: 'pip',
            code: [
                `print(${JSON.stringify(`Usage: ${binName} install <package> [package...]`)})`,
                'print("Nimbus pip installs PyPI pure wheels, curated pure source artifacts, and local pure wheels.")',
                'print("Native Linux wheels and request-time extension modules are rejected before install.")',
            ].join('\n'),
            exitCode: 0,
        };
    }
    const command = argv[0];
    if (command !== 'install') {
        return {
            mode: 'none',
            code: '',
            error: `pip subcommand '${command || '(none)'}' is not supported yet; supported: install, --version, --help`,
            exitCode: 2,
        };
    }
    const plan = await buildPipInstallPlan(argv.slice(1), cwd, vfs, runtimeContext);
    if (plan.error) {
        return { mode: 'none', code: '', error: plan.error, exitCode: plan.exitCode };
    }
    return {
        mode: 'pip',
        code: buildPipInstallCode(plan, pythonSitePackages(runtimeContext.home)),
        exitCode: 0,
    };
}
async function buildPipInstallPlan(argv, cwd, vfs, runtimeContext) {
    const roots = [];
    const constraints = new Map();
    const localWheels = [];
    const displayPackages = [];
    const { markers } = runtimeContext;
    let includeDependencies = true;
    const collected = { vfs, markers, roots, constraints, localWheels, displayPackages };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-r' || arg === '--requirement') {
            const reqPath = argv[i + 1];
            if (!reqPath)
                return failedPlan(`${arg}: missing requirements file`, 2);
            const err = (await addRequirementsFile('requirements', reqPath, cwd, 0, collected));
            if (err)
                return failedPlan(err, 1);
            i++;
            continue;
        }
        if (arg.startsWith('--requirement=')) {
            const err = (await addRequirementsFile('requirements', arg.slice('--requirement='.length), cwd, 0, collected));
            if (err)
                return failedPlan(err, 1);
            continue;
        }
        if (arg === '-c' || arg === '--constraint') {
            const constraintPath = argv[i + 1];
            if (!constraintPath)
                return failedPlan(`${arg}: missing constraints file`, 2);
            const err = (await addRequirementsFile('constraints', constraintPath, cwd, 0, collected));
            if (err)
                return failedPlan(err, 1);
            i++;
            continue;
        }
        if (arg.startsWith('--constraint=')) {
            const err = (await addRequirementsFile('constraints', arg.slice('--constraint='.length), cwd, 0, collected));
            if (err)
                return failedPlan(err, 1);
            continue;
        }
        if (isIgnoredPipInstallFlag(arg))
            continue;
        if (pipFlagTakesValue(arg)) {
            if (!argv[i + 1])
                return failedPlan(`${arg}: missing value`, 2);
            i++;
            continue;
        }
        if (arg === '--no-deps') {
            includeDependencies = false;
            continue;
        }
        if (arg.startsWith('-')) {
            return failedPlan(`pip install option '${arg}' is not supported in Nimbus yet`, 2);
        }
        const local = (await localWheelArtifact(arg, cwd, vfs));
        if ('error' in local)
            return failedPlan(local.error, 1);
        if (local.artifact) {
            localWheels.push(local.artifact);
            displayPackages.push(local.artifact.displayName);
            continue;
        }
        let parsed;
        try {
            parsed = parsePipRequirementsLine(arg);
        }
        catch (e) {
            return failedPlan(e instanceof RequirementsSyntaxError ? e.message : `invalid requirement '${arg}'`, 1);
        }
        if (!parsed)
            continue;
        const err = (await addRequirement('requirements', parsed, cwd, { word: arg }, 0, collected));
        if (err)
            return failedPlan(err, 1);
    }
    if (roots.length === 0 && localWheels.length === 0) {
        return failedPlan('pip install: missing package name', 2);
    }
    const resolved = await resolveRequirements(roots, constraints, includeDependencies, runtimeContext);
    if ('error' in resolved)
        return failedPlan(resolved.error, 1);
    const remoteWheels = [];
    const sourcePackages = [];
    const variantPackages = [];
    for (const pkg of resolved.packages.values()) {
        if (pkg.artifact.kind === 'remote-wheel')
            remoteWheels.push(pkg.artifact);
        else if (pkg.artifact.kind === 'source')
            sourcePackages.push(pkg.artifact);
        else
            variantPackages.push(pkg.artifact);
    }
    const installLabels = [
        ...remoteWheels.map((wheel) => wheel.canonicalName),
        ...sourcePackages.map((source) => source.canonicalName),
        ...variantPackages.map((variant) => variant.canonicalName),
        ...localWheels.map((wheel) => wheel.displayName),
    ];
    return {
        remoteWheels,
        sourcePackages,
        variantPackages,
        localWheels,
        displayPackages: installLabels.length > 0 ? installLabels : displayPackages,
        exitCode: 0,
    };
}
function failedPlan(error, exitCode) {
    return {
        remoteWheels: [], sourcePackages: [], variantPackages: [],
        localWheels: [], displayPackages: [], error, exitCode,
    };
}
/**
 * The lines of the requirements or constraints file `reqPath` (from
 * `baseDir`), at include `depth`, and the directory its own includes
 * resolve from; or why it cannot be read.
 */
async function readRequirementsFile(kind, reqPath, baseDir, vfs, depth) {
    if (depth > 8)
        return { error: `${kind} nesting exceeded 8 files` };
    const abs = resolveVfsPath(reqPath, baseDir);
    const probe = (await probeVfsPath(vfs, abs));
    if ('error' in probe)
        return { error: `cannot read ${kind} file ${reqPath}: ${probe.error}` };
    if (!probe.exists)
        return { error: `${kind} file not found: ${reqPath}` };
    const text = (await readVfsText(vfs, abs));
    if ('error' in text)
        return { error: `cannot read ${kind} file ${reqPath}: ${text.error}` };
    try {
        return { lines: parsePipRequirementsFile(text.text), dir: parentVfsPath(abs) };
    }
    catch (e) {
        return { error: e instanceof RequirementsSyntaxError ? e.message : `invalid ${kind} file: ${reqPath}` };
    }
}
/**
 * One requirement of the install, read as `kind`: a -r file is read as the
 * kind it is named in, a -c file as constraints; a constraint adds its
 * versions to its package's constraints, a requirement a root and its
 * label. A URL is a local pure wheel on the command line, and refused in a
 * file.
 */
async function addRequirement(kind, requirement, baseDir, origin, depth, collected) {
    if (requirement.type === 'RequirementsFile' || requirement.type === 'ConstraintsFile') {
        return await addRequirementsFile(requirement.type === 'ConstraintsFile' ? 'constraints' : kind, requirement.path, baseDir, depth, collected);
    }
    if (requirement.type === 'ProjectURL') {
        if ('file' in origin) {
            return kind === 'constraints'
                ? `${origin.file}: URL constraints are not supported`
                : `${origin.file}: URL requirements need a Nimbus wheel artifact or local pure wheel path`;
        }
        const local = (await localWheelArtifact(requirement.url, baseDir, collected.vfs));
        if ('error' in local)
            return local.error;
        if (!local.artifact)
            return `${origin.word}: URL requirements need a local pure wheel path`;
        collected.localWheels.push({ ...local.artifact, displayName: canonicalPackageName(requirement.name) });
        collected.displayPackages.push(canonicalPackageName(requirement.name));
        return null;
    }
    if (!markerApplies(requirement.environmentMarkerTree, requirement.extras || [], collected.markers))
        return null;
    if (kind === 'constraints') {
        const name = canonicalPackageName(requirement.name);
        collected.constraints.set(name, [...(collected.constraints.get(name) || []), ...versionSpecifiers(requirement.versionSpec || [])]);
    }
    else {
        collected.roots.push(projectRequirementToPackageRequirement(requirement));
        collected.displayPackages.push(formatDisplayRequirement(requirement));
    }
    return null;
}
/** Each requirement of the requirements or constraints file `reqPath`, read as `kind` (addRequirement). */
async function addRequirementsFile(kind, reqPath, baseDir, depth, collected) {
    const file = await readRequirementsFile(kind, reqPath, baseDir, collected.vfs, depth);
    if ('error' in file)
        return file.error;
    for (const requirement of file.lines) {
        const err = await addRequirement(kind, requirement, file.dir, { file: reqPath }, depth + 1, collected);
        if (err)
            return err;
    }
    return null;
}
async function readVfsText(vfs, path) {
    try {
        return { text: new TextDecoder('utf-8').decode((await vfs.readFile(path))) };
    }
    catch (e) {
        return { error: errorText(e) };
    }
}
async function probeVfsPath(vfs, path) {
    try {
        return { exists: (await vfs.exists(path)) };
    }
    catch (e) {
        return { error: errorText(e) };
    }
}
async function resolveRequirements(roots, constraints, includeDependencies, runtimeContext) {
    const requirements = new Map();
    const queue = [];
    const add = (req) => {
        const name = canonicalPackageName(req.name);
        const existing = requirements.get(name);
        if (existing) {
            existing.specs = uniqueStrings([...existing.specs, ...req.specs]);
            existing.extras = uniqueStrings([...existing.extras, ...req.extras]);
        }
        else {
            requirements.set(name, { name, specs: uniqueStrings(req.specs), extras: uniqueStrings(req.extras) });
        }
        if (!queue.includes(name))
            queue.push(name);
    };
    for (const root of roots)
        add(root);
    const resolved = new Map();
    /** Each package's dependencies, as last read: at its version, with its extras. A request that changes neither adds none. */
    const expanded = new Map();
    while (queue.length > 0) {
        const name = queue.shift();
        const req = requirements.get(name);
        const resolvedPkg = await resolveOneRequirement({
            ...req,
            specs: uniqueStrings([...req.specs, ...(constraints.get(name) || [])]),
        }, runtimeContext);
        if ('error' in resolvedPkg)
            return resolvedPkg;
        resolved.set(name, resolvedPkg.package);
        const expansion = JSON.stringify([resolvedPkg.package.version, [...req.extras].sort()]);
        if (expanded.get(name) === expansion)
            continue;
        expanded.set(name, expansion);
        if (!includeDependencies)
            continue;
        const metadata = await fetchPypiJson(runtimeContext.network, name, resolvedPkg.package.version);
        if ('error' in metadata)
            return metadata;
        for (const depLine of metadata.data.info.requires_dist ?? []) {
            let dep;
            try {
                dep = parsePipRequirementsLine(depLine);
            }
            catch {
                return { error: `${name} dependency '${depLine}' is not a supported PEP 508 requirement` };
            }
            if (!dep)
                continue;
            if (dep.type !== 'ProjectName') {
                return { error: `${name} dependency '${depLine}' needs a Nimbus package artifact` };
            }
            if (!markerApplies(dep.environmentMarkerTree, req.extras, runtimeContext.markers))
                continue;
            add(projectRequirementToPackageRequirement(dep));
        }
    }
    return { packages: resolved };
}
async function resolveOneRequirement(req, runtimeContext) {
    const variantPolicy = PIP_VARIANT_PACKAGES[canonicalPackageName(req.name)];
    if (variantPolicy) {
        const range = specifierRange(req.specs);
        if (range && !pep440Satisfies(variantPolicy.version, range)) {
            return {
                error: `only ${variantPolicy.canonicalName} ${variantPolicy.version} is available here `
                    + `(it is compiled into the interpreter, not fetched), and it does not satisfy ${range}`,
            };
        }
        return {
            package: {
                name: variantPolicy.canonicalName,
                version: variantPolicy.version,
                artifact: { kind: 'variant', ...variantPolicy },
            },
        };
    }
    const sourcePolicy = PIP_SOURCE_PACKAGES[req.name];
    if (sourcePolicy)
        return resolveSourcePolicy(req, sourcePolicy);
    const metadata = await fetchPypiJson(runtimeContext.network, req.name);
    if ('error' in metadata)
        return metadata;
    const releases = metadata.data.releases || {};
    const versions = Object.keys(releases).filter((version) => validPep440Version(version) && releases[version]?.some((file) => !file.yanked));
    const range = specifierRange(req.specs);
    const version = findBestVersion(versions, range || '>=0');
    if (!version) {
        return { error: `no PyPI release of ${req.name} satisfies ${range || '>=0'}` };
    }
    const versionMetadata = await fetchPypiJson(runtimeContext.network, req.name, version);
    if ('error' in versionMetadata)
        return versionMetadata;
    const files = versionMetadata.data.urls || releases[version] || [];
    const wheel = selectPureWheel(req.name, version, files);
    if ('error' in wheel)
        return wheel;
    return {
        package: {
            name: req.name,
            version,
            artifact: wheel.artifact,
        },
    };
}
function resolveSourcePolicy(req, sourcePolicy) {
    const range = specifierRange(req.specs);
    if (range && !pep440Satisfies(sourcePolicy.version, range)) {
        return { error: `${req.name}${range} needs a Nimbus source artifact; available artifact is ${req.name}==${sourcePolicy.version}` };
    }
    return {
        package: {
            name: req.name,
            version: sourcePolicy.version,
            artifact: { ...sourcePolicy, kind: 'source' },
        },
    };
}
function selectPureWheel(name, version, files) {
    const wheels = files.filter((file) => file.packagetype === 'bdist_wheel' || file.filename.endsWith('.whl'));
    const pure = wheels.find((file) => isPurePythonWheel(file.filename) && !file.yanked && file.digests?.sha256);
    if (pure?.digests?.sha256) {
        return {
            artifact: {
                kind: 'remote-wheel',
                canonicalName: canonicalPackageName(name),
                version,
                wheelUrl: pure.url,
                sha256: pure.digests.sha256,
            },
        };
    }
    if (wheels.some((file) => isPyodideExtensionWheel(file.filename))) {
        return { error: pyodideExtensionWheelDiagnostic(name, version, wheels.map((file) => file.filename)) };
    }
    if (wheels.some((file) => isNativePlatformWheel(file.filename))) {
        return { error: `${name}==${version} ships native platform wheels; native Linux wheels cannot run in Nimbus` };
    }
    if (files.some((file) => file.packagetype === 'sdist')) {
        return { error: `${name}==${version} has no compatible pure wheel; source builds need a Nimbus source policy or prebuilt Nimbus ABI artifact` };
    }
    return { error: `${name}==${version} has no compatible Nimbus package artifact` };
}
function findBestVersion(versions, range) {
    try {
        return maxSatisfying(versions, range);
    }
    catch {
        return null;
    }
}
async function fetchPypiJson(network, name, version) {
    const canonical = canonicalPackageName(name);
    // Cached per network: what one workspace's egress answered is never another's.
    const key = `${network.id}|` + (version ? `${canonical}@${version}` : canonical);
    let entry = pypiCache.get(key);
    if (!entry || entry.expires <= Date.now()) {
        const url = version
            ? `${PYPI_API}/${encodeURIComponent(canonical)}/${encodeURIComponent(version)}/json`
            : `${PYPI_API}/${encodeURIComponent(canonical)}/json`;
        const fetched = {
            expires: Infinity,
            promise: network.fetch(url).then(async (resp) => {
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
                const data = PypiJsonSchema.parse(await resp.json());
                fetched.expires = Date.now() + pypiAnswerAge(resp);
                return data;
            }),
        };
        entry = fetched;
        const now = Date.now();
        for (const [kept, answer] of pypiCache)
            if (answer.expires <= now)
                pypiCache.delete(kept);
        pypiCache.set(key, entry);
    }
    try {
        return { data: await entry.promise };
    }
    catch (e) {
        if (pypiCache.get(key) === entry)
            pypiCache.delete(key);
        return { error: `PyPI metadata fetch failed for ${canonical}: ${e instanceof Error ? e.message : String(e)}` };
    }
}
function projectRequirementToPackageRequirement(requirement) {
    return {
        name: canonicalPackageName(requirement.name),
        specs: versionSpecifiers(requirement.versionSpec || []),
        extras: (requirement.extras || []).map(canonicalPackageName),
    };
}
function versionSpecifiers(specs) {
    return specs.map((spec) => `${spec.operator}${spec.version}`);
}
function specifierRange(specs) {
    return specs.join(',');
}
function formatDisplayRequirement(requirement) {
    const extras = requirement.extras?.length ? `[${requirement.extras.join(',')}]` : '';
    return `${canonicalPackageName(requirement.name)}${extras}${specifierRange(versionSpecifiers(requirement.versionSpec || []))}`;
}
function markerApplies(marker, extras, markers) {
    if (!marker)
        return true;
    const candidates = extras.length > 0 ? extras : [''];
    return candidates.some((extra) => evaluateMarker(marker, extra, markers));
}
function evaluateMarker(marker, extra, markers) {
    if (isMarkerNode(marker)) {
        const left = evaluateMarker(marker.left, extra, markers);
        const right = evaluateMarker(marker.right, extra, markers);
        return marker.operator === 'and' ? left && right : left || right;
    }
    return evaluateMarkerLeaf(marker, extra, markers);
}
function isMarkerNode(marker) {
    return marker.operator === 'and' || marker.operator === 'or';
}
function evaluateMarkerLeaf(marker, extra, markers) {
    const left = markerValue(marker.left, extra, markers);
    const right = markerValue(marker.right, extra, markers);
    if (marker.operator === 'in')
        return right.includes(left);
    if (marker.operator === 'not in')
        return !right.includes(left);
    if (marker.operator === '==' || marker.operator === '!=') {
        if (!isVersionMarkerValue(marker.left) && !isVersionMarkerValue(marker.right)) {
            return marker.operator === '==' ? left === right : left !== right;
        }
    }
    const expression = `${marker.operator}${right}`;
    if (validPep440Version(left) && validPep440Range(expression)) {
        return pep440Satisfies(left, expression);
    }
    if (marker.operator === '==')
        return left === right;
    if (marker.operator === '!=')
        return left !== right;
    return false;
}
function isVersionMarkerValue(value) {
    return value === 'python_version'
        || value === 'python_full_version'
        || value === 'implementation_version';
}
function markerValue(value, extra, markers) {
    if (value === EnvironmentMarkerVariable.Extra)
        return extra;
    if (isPythonString(value))
        return value.slice(1, -1);
    return markers[value];
}
function isPythonString(value) {
    return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
}
async function localWheelArtifact(rawSpec, baseDir, vfs) {
    const pathSpec = localWheelPathSpec(rawSpec);
    if ('error' in pathSpec)
        return pathSpec;
    const spec = pathSpec.path;
    const looksLikePath = spec.startsWith('/')
        || spec.startsWith('./')
        || spec.startsWith('../')
        || (!spec.includes(' ') && !spec.includes('\t') && spec.endsWith('.whl'));
    if (!looksLikePath)
        return { artifact: null };
    const abs = resolveVfsPath(spec, baseDir);
    const probe = (await probeVfsPath(vfs, abs));
    if ('error' in probe)
        return { error: `cannot access local wheel ${rawSpec}: ${probe.error}` };
    if (!probe.exists)
        return { error: `local wheel not found: ${rawSpec}` };
    const fileName = abs.slice(abs.lastIndexOf('/') + 1);
    if (!fileName.endsWith('.whl')) {
        return { error: `local installs currently require a .whl file: ${rawSpec}` };
    }
    const wheelError = validateWheelFileName(fileName);
    if (wheelError)
        return { error: wheelError };
    return {
        artifact: {
            path: `/${abs}`,
            displayName: fileName.slice(0, -'.whl'.length),
        },
    };
}
function localWheelPathSpec(rawSpec) {
    if (!rawSpec.startsWith('file://'))
        return { path: rawSpec };
    try {
        const url = new URL(rawSpec);
        if (url.protocol !== 'file:')
            return { path: rawSpec };
        return { path: decodeURIComponent(url.pathname) };
    }
    catch {
        return { error: `invalid file URL: ${rawSpec}` };
    }
}
function validateWheelFileName(fileName) {
    if (isPurePythonWheel(fileName))
        return null;
    if (isNativePlatformWheel(fileName)) {
        return `native Linux wheel '${fileName}' cannot run in Nimbus; install a pure wheel or a Nimbus ABI artifact`;
    }
    if (isPyodideExtensionWheel(fileName)) {
        return `Pyodide/Emscripten extension wheel '${fileName}' cannot run in Nimbus' CPython (wasm32-wasi); install a pure wheel`;
    }
    return `wheel '${fileName}' targets an unsupported ABI; Nimbus pip supports pure Python wheels and Nimbus ABI artifacts`;
}
function pyodideExtensionWheelDiagnostic(name, version, filenames) {
    const wheel = filenames.find(isPyodideExtensionWheel) || 'Pyodide/Emscripten wheel';
    return `${canonicalPackageName(name)}==${version} ships a Pyodide/Emscripten extension wheel (${wheel}), ` +
        `which cannot run in Nimbus' CPython (wasm32-wasi), and no pure wheel.`;
}
function isPurePythonWheel(fileName) {
    const tags = wheelTags(fileName);
    if (!tags)
        return false;
    return tags.abiTag === 'none'
        && tags.platformTag === 'any'
        && tags.pythonTag.split('.').some((tag) => tag === 'py3' || tag.startsWith('py3') || tag === 'cp313');
}
function isNativePlatformWheel(fileName) {
    const tags = wheelTags(fileName);
    if (!tags)
        return false;
    return /manylinux|musllinux|linux|macosx|win/.test(tags.platformTag);
}
function isPyodideExtensionWheel(fileName) {
    const tags = wheelTags(fileName);
    if (!tags)
        return false;
    return /emscripten|wasm32|pyodide/.test(`${tags.abiTag}-${tags.platformTag}`);
}
function wheelTags(fileName) {
    const stem = fileName.endsWith('.whl') ? fileName.slice(0, -4) : fileName;
    const parts = stem.split('-');
    if (parts.length < 5)
        return null;
    return {
        pythonTag: parts[parts.length - 3].toLowerCase(),
        abiTag: parts[parts.length - 2].toLowerCase(),
        platformTag: parts[parts.length - 1].toLowerCase(),
    };
}
function buildPipInstallCode(plan, sitePackages) {
    return [
        'import hashlib',
        'import io',
        'import os',
        'import shutil',
        'import sys',
        'import tarfile',
        'import zipfile',
        'import urllib.error',
        'import urllib.request',
        `remote_wheels = ${JSON.stringify(plan.remoteWheels)}`,
        `local_wheels = ${JSON.stringify(plan.localWheels)}`,
        `source_packages = ${JSON.stringify(plan.sourcePackages)}`,
        `variant_packages = ${JSON.stringify(plan.variantPackages)}`,
        `display_packages = ${JSON.stringify(plan.displayPackages)}`,
        `target_site_packages = ${JSON.stringify(`/${sitePackages}`)}`,
        'unsupported_extension_suffixes = (".so", ".pyd", ".dll", ".dylib")',
        'os.makedirs(target_site_packages, exist_ok=True)',
        'if target_site_packages not in sys.path:',
        '    sys.path.insert(0, target_site_packages)',
        'def _nimbus_dist_info_dir(name, version):',
        '    return os.path.join(target_site_packages, name.replace("-", "_") + "-" + version + ".dist-info")',
        // The record pip reads back: a pure wheel with no RECORD entries.
        'def _nimbus_write_dist_info(dist_info, policy):',
        '    os.makedirs(dist_info, exist_ok=True)',
        '    with open(os.path.join(dist_info, "METADATA"), "w", encoding="utf-8") as f:',
        '        f.write("Metadata-Version: 2.1\\nName: " + policy["canonicalName"] + "\\nVersion: " + policy["version"] + "\\n")',
        '    with open(os.path.join(dist_info, "WHEEL"), "w", encoding="utf-8") as f:',
        '        f.write("Wheel-Version: 1.0\\nGenerator: Nimbus pip\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
        '    with open(os.path.join(dist_info, "RECORD"), "w", encoding="utf-8") as f:',
        '        f.write("")',
        'def _nimbus_assert_supported_member(rel):',
        '    leaf = rel.rsplit("/", 1)[-1]',
        '    if leaf.endswith(unsupported_extension_suffixes):',
        '        raise RuntimeError("unsupported extension artifact in wheel: " + rel)',
        'def _nimbus_safe_target(rel):',
        '    target = os.path.normpath(os.path.join(target_site_packages, rel))',
        '    if not target.startswith(target_site_packages + os.sep):',
        '        raise RuntimeError("unsafe wheel path: " + rel)',
        '    return target',
        'def _nimbus_install_wheel_bytes(data):',
        '    with zipfile.ZipFile(io.BytesIO(data)) as wheel:',
        '        infos = [member for member in wheel.infolist() if not member.is_dir()]',
        '        for member in infos:',
        '            _nimbus_assert_supported_member(member.filename)',
        '        for member in infos:',
        '            target = _nimbus_safe_target(member.filename)',
        '            os.makedirs(os.path.dirname(target), exist_ok=True)',
        '            with wheel.open(member) as source, open(target, "wb") as out:',
        '                shutil.copyfileobj(source, out)',
        // One fetch, in the standard library. This used to be pyodide.http.pyfetch,
        // which existed because Pyodide's interpreter has no sockets of its own and
        // had to borrow the host's fetch. CPython here has real sockets and real
        // OpenSSL, so urllib does the whole thing - TLS included - inside the guest,
        // and the download stops being a special case.
        'def _nimbus_fetch_bytes(url, what):',
        '    try:',
        '        with urllib.request.urlopen(url) as response:',
        '            if response.status != 200:',
        '                raise RuntimeError("cannot fetch " + what + ": HTTP " + str(response.status))',
        '            return response.read()',
        '    except urllib.error.HTTPError as exc:',
        '        raise RuntimeError("cannot fetch " + what + ": HTTP " + str(exc.code))',
        '    except urllib.error.URLError as exc:',
        '        raise RuntimeError("cannot fetch " + what + ": " + str(exc.reason))',
        'def _nimbus_install_remote_wheel(policy):',
        '    metadata_path = os.path.join(_nimbus_dist_info_dir(policy["canonicalName"], policy["version"]), "METADATA")',
        '    if os.path.exists(metadata_path):',
        '        return',
        '    data = _nimbus_fetch_bytes(policy["wheelUrl"], policy["canonicalName"] + " wheel")',
        '    digest = hashlib.sha256(data).hexdigest()',
        '    if digest != policy["sha256"]:',
        '        raise RuntimeError(policy["canonicalName"] + " wheel hash mismatch")',
        '    _nimbus_install_wheel_bytes(data)',
        'def _nimbus_install_local_wheel(policy):',
        '    with open(policy["path"], "rb") as f:',
        '        _nimbus_install_wheel_bytes(f.read())',
        'def _nimbus_install_source_package(policy):',
        '    metadata_path = os.path.join(_nimbus_dist_info_dir(policy["canonicalName"], policy["version"]), "METADATA")',
        '    if os.path.exists(metadata_path):',
        '        return',
        '    data = _nimbus_fetch_bytes(policy["sourceUrl"], policy["canonicalName"] + " source archive")',
        '    digest = hashlib.sha256(data).hexdigest()',
        '    if digest != policy["sha256"]:',
        '        raise RuntimeError(policy["canonicalName"] + " source archive hash mismatch")',
        '    package_root = os.path.join(target_site_packages, policy["importName"])',
        '    if os.path.isdir(package_root):',
        '        shutil.rmtree(package_root)',
        '    os.makedirs(package_root, exist_ok=True)',
        '    prefix = policy["sourcePackageDir"].rstrip("/") + "/"',
        '    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:',
        '        for member in archive.getmembers():',
        '            if not member.isfile() or not member.name.startswith(prefix):',
        '                continue',
        '            rel = member.name[len(prefix):]',
        '            if not rel or rel.rsplit("/", 1)[-1].endswith(unsupported_extension_suffixes):',
        '                raise RuntimeError("unsupported extension artifact in source policy: " + member.name)',
        '            if not (rel.endswith(".py") or rel.endswith(".pyi") or rel == "py.typed"):',
        '                continue',
        '            target = os.path.normpath(os.path.join(package_root, rel))',
        '            if not target.startswith(package_root + os.sep) and target != package_root:',
        '                raise RuntimeError("unsafe source archive path: " + member.name)',
        '            os.makedirs(os.path.dirname(target), exist_ok=True)',
        '            source = archive.extractfile(member)',
        '            if source is None:',
        '                continue',
        '            with source, open(target, "wb") as out:',
        '                shutil.copyfileobj(source, out)',
        '    dist_info = _nimbus_dist_info_dir(policy["canonicalName"], policy["version"])',
        '    if os.path.isdir(dist_info):',
        '        shutil.rmtree(dist_info)',
        '    _nimbus_write_dist_info(dist_info, policy)',
        // A variant package's code is already inside the interpreter and on its
        // sys.path; only the record is missing, and that record is what makes the
        // next spawn pick the interpreter that has it.
        'def _nimbus_install_variant_package(policy):',
        '    dist_info = _nimbus_dist_info_dir(policy["canonicalName"], policy["version"])',
        '    if os.path.exists(os.path.join(dist_info, "METADATA")):',
        '        return',
        '    _nimbus_write_dist_info(dist_info, policy)',
        'for source_package in source_packages:',
        '    _nimbus_install_source_package(source_package)',
        'for variant_package in variant_packages:',
        '    _nimbus_install_variant_package(variant_package)',
        'for wheel in remote_wheels:',
        '    _nimbus_install_remote_wheel(wheel)',
        'for wheel in local_wheels:',
        '    _nimbus_install_local_wheel(wheel)',
        'print("Successfully installed " + " ".join(display_packages))',
    ].join('\n');
}
function canonicalPackageName(name) {
    return name.replace(/[_.]+/g, '-').toLowerCase();
}
function uniqueStrings(values) {
    return [...new Set(values)];
}
function isIgnoredPipInstallFlag(arg) {
    return IGNORED_PIP_INSTALL_FLAGS.has(arg);
}
function pipFlagTakesValue(arg) {
    if (arg.includes('='))
        return false;
    return PIP_INSTALL_FLAGS_WITH_VALUE.has(arg);
}
