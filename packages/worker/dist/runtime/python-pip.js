import { maxSatisfying, satisfies as pep440Satisfies, valid as validPep440Version, validRange as validPep440Range, } from '@renovatebot/pep440';
import { parsePipRequirementsFile, parsePipRequirementsLine, RequirementsSyntaxError, } from 'pip-requirements-js';
import { z } from 'zod/v4';
import { parentVfsPath, resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { PYODIDE_PACKAGE_ABI } from '@nimbus-sh/core/runtime/os-contracts.js';
import { isRuntimePythonPackageArtifactMetadata, RuntimePythonPackageArtifactMetadataSchema, } from './runtime-catalog.js';
export const PYTHON_SITE_PACKAGES_ROOT = 'home/user/.nimbus-python/site-packages';
export const PYTHON_PYODIDE_PACKAGE_MANIFEST = `${PYTHON_SITE_PACKAGES_ROOT}/.nimbus-pyodide-packages.json`;
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
export function sessionUsesSciVariant(vfs) {
    return SCI_VARIANT_DIST_INFO.some((dir) => vfs.exists(`${PYTHON_SITE_PACKAGES_ROOT}/${dir}`));
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
const PyodideLockPackageSchema = z.object({
    depends: z.array(z.string()).default([]),
    file_name: z.string().min(1),
    imports: z.array(z.string()).default([]),
    install_dir: z.string().optional(),
    name: z.string().min(1),
    package_type: z.string().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().min(1),
});
const PyodideLockfileSchema = z.object({
    info: z.object({
        abi_version: z.string().min(1),
        arch: z.string().min(1),
        platform: z.string().min(1),
        python: z.string().min(1),
    }),
    packages: z.record(z.string(), PyodideLockPackageSchema),
});
const pypiCache = new Map();
export const InstalledPyodidePackageManifestSchema = z.object({
    version: z.literal(1),
    packages: z.array(RuntimePythonPackageArtifactMetadataSchema),
});
export function parseInstalledPyodidePackageManifest(text) {
    return InstalledPyodidePackageManifestSchema.parse(JSON.parse(text));
}
export async function buildPipInvocation(argv, binName, cwd, vfs, runtimeContext = {}) {
    const wantsVersion = argv.includes('--version') || argv.includes('-V');
    const wantsHelp = argv.length === 0 || argv.includes('--help') || argv.includes('-h');
    if (wantsVersion) {
        return {
            mode: 'pip',
            code: 'print("pip 24.3.1 (Nimbus package bridge for CPython 3.13, wasm32-wasi)")',
            exitCode: 0,
        };
    }
    if (wantsHelp) {
        return {
            mode: 'pip',
            code: [
                `print(${JSON.stringify(`Usage: ${binName} install <package> [package...]`)})`,
                'print("Nimbus pip installs PyPI pure wheels, curated pure source artifacts, and local pure wheels.")',
                'print("Compiled Pyodide wheels require startup-loaded Nimbus package artifacts.")',
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
        code: buildPipInstallCode(plan),
        exitCode: 0,
        pyodidePackages: plan.pyodidePackages,
    };
}
async function buildPipInstallPlan(argv, cwd, vfs, runtimeContext) {
    const roots = [];
    const constraints = new Map();
    const localWheels = [];
    const displayPackages = [];
    let includeDependencies = true;
    const addRequirement = (requirement, baseDir, source) => {
        if (requirement.type === 'RequirementsFile') {
            return addRequirementsFile(requirement.path, baseDir, vfs, roots, constraints, displayPackages, 0);
        }
        if (requirement.type === 'ConstraintsFile') {
            return addConstraintsFile(requirement.path, baseDir, vfs, constraints, 0);
        }
        if (requirement.type === 'ProjectURL') {
            const local = localWheelArtifact(requirement.url, baseDir, vfs);
            if ('error' in local)
                return local.error;
            if (local.artifact) {
                localWheels.push({
                    ...local.artifact,
                    displayName: canonicalPackageName(requirement.name),
                });
                displayPackages.push(canonicalPackageName(requirement.name));
                return null;
            }
            return `${source}: URL requirements need a local pure wheel path`;
        }
        if (!markerApplies(requirement.environmentMarkerTree, requirement.extras || []))
            return null;
        roots.push(projectRequirementToPackageRequirement(requirement));
        displayPackages.push(formatDisplayRequirement(requirement));
        return null;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-r' || arg === '--requirement') {
            const reqPath = argv[i + 1];
            if (!reqPath)
                return failedPlan(`${arg}: missing requirements file`, 2);
            const err = addRequirementsFile(reqPath, cwd, vfs, roots, constraints, displayPackages, 0);
            if (err)
                return failedPlan(err, 1);
            i++;
            continue;
        }
        if (arg.startsWith('--requirement=')) {
            const err = addRequirementsFile(arg.slice('--requirement='.length), cwd, vfs, roots, constraints, displayPackages, 0);
            if (err)
                return failedPlan(err, 1);
            continue;
        }
        if (arg === '-c' || arg === '--constraint') {
            const constraintPath = argv[i + 1];
            if (!constraintPath)
                return failedPlan(`${arg}: missing constraints file`, 2);
            const err = addConstraintsFile(constraintPath, cwd, vfs, constraints, 0);
            if (err)
                return failedPlan(err, 1);
            i++;
            continue;
        }
        if (arg.startsWith('--constraint=')) {
            const err = addConstraintsFile(arg.slice('--constraint='.length), cwd, vfs, constraints, 0);
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
        const local = localWheelArtifact(arg, cwd, vfs);
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
        const err = addRequirement(parsed, cwd, arg);
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
    const pyodidePackages = [];
    const variantPackages = [];
    for (const pkg of resolved.packages.values()) {
        if (pkg.artifact.kind === 'remote-wheel') {
            remoteWheels.push(pkg.artifact);
        }
        else if (pkg.artifact.kind === 'source') {
            sourcePackages.push(pkg.artifact);
        }
        else if (pkg.artifact.kind === 'variant') {
            variantPackages.push(pkg.artifact);
        }
        else {
            pyodidePackages.push(pkg.artifact.artifact);
        }
    }
    const installLabels = [
        ...remoteWheels.map((wheel) => wheel.canonicalName),
        ...sourcePackages.map((source) => source.canonicalName),
        ...variantPackages.map((variant) => variant.canonicalName),
        ...pyodidePackages.map((artifact) => artifact.packageName),
        ...localWheels.map((wheel) => wheel.displayName),
    ];
    return {
        remoteWheels,
        sourcePackages,
        variantPackages,
        pyodidePackages,
        localWheels,
        displayPackages: installLabels.length > 0 ? installLabels : displayPackages,
        exitCode: 0,
    };
}
function failedPlan(error, exitCode) {
    return {
        remoteWheels: [], sourcePackages: [], variantPackages: [], pyodidePackages: [],
        localWheels: [], displayPackages: [], error, exitCode,
    };
}
function addRequirementsFile(reqPath, baseDir, vfs, requirements, constraints, displayPackages, depth) {
    if (depth > 8)
        return 'requirements nesting exceeded 8 files';
    const abs = resolveVfsPath(reqPath, baseDir);
    const probe = probeVfsPath(vfs, abs);
    if ('error' in probe)
        return `cannot read requirements file ${reqPath}: ${probe.error}`;
    if (!probe.exists)
        return `requirements file not found: ${reqPath}`;
    const text = readVfsText(vfs, abs);
    if ('error' in text)
        return `cannot read requirements file ${reqPath}: ${text.error}`;
    let parsed;
    try {
        parsed = parsePipRequirementsFile(text.text);
    }
    catch (e) {
        return e instanceof RequirementsSyntaxError ? e.message : `invalid requirements file: ${reqPath}`;
    }
    const nextBaseDir = parentVfsPath(abs);
    for (const requirement of parsed) {
        if (requirement.type === 'RequirementsFile') {
            const err = addRequirementsFile(requirement.path, nextBaseDir, vfs, requirements, constraints, displayPackages, depth + 1);
            if (err)
                return err;
            continue;
        }
        if (requirement.type === 'ConstraintsFile') {
            const err = addConstraintsFile(requirement.path, nextBaseDir, vfs, constraints, depth + 1);
            if (err)
                return err;
            continue;
        }
        if (requirement.type === 'ProjectURL') {
            return `${reqPath}: URL requirements need a Nimbus wheel artifact or local pure wheel path`;
        }
        if (!markerApplies(requirement.environmentMarkerTree, requirement.extras || []))
            continue;
        requirements.push(projectRequirementToPackageRequirement(requirement));
        displayPackages.push(formatDisplayRequirement(requirement));
    }
    return null;
}
function addConstraintsFile(reqPath, baseDir, vfs, constraints, depth) {
    if (depth > 8)
        return 'constraints nesting exceeded 8 files';
    const abs = resolveVfsPath(reqPath, baseDir);
    const probe = probeVfsPath(vfs, abs);
    if ('error' in probe)
        return `cannot read constraints file ${reqPath}: ${probe.error}`;
    if (!probe.exists)
        return `constraints file not found: ${reqPath}`;
    const text = readVfsText(vfs, abs);
    if ('error' in text)
        return `cannot read constraints file ${reqPath}: ${text.error}`;
    let parsed;
    try {
        parsed = parsePipRequirementsFile(text.text);
    }
    catch (e) {
        return e instanceof RequirementsSyntaxError ? e.message : `invalid constraints file: ${reqPath}`;
    }
    const nextBaseDir = parentVfsPath(abs);
    for (const requirement of parsed) {
        if (requirement.type === 'RequirementsFile' || requirement.type === 'ConstraintsFile') {
            const err = addConstraintsFile(requirement.path, nextBaseDir, vfs, constraints, depth + 1);
            if (err)
                return err;
            continue;
        }
        if (requirement.type === 'ProjectURL')
            return `${reqPath}: URL constraints are not supported`;
        if (!markerApplies(requirement.environmentMarkerTree, requirement.extras || []))
            continue;
        const name = canonicalPackageName(requirement.name);
        constraints.set(name, [...(constraints.get(name) || []), ...versionSpecifiers(requirement.versionSpec || [])]);
    }
    return null;
}
function readVfsText(vfs, path) {
    try {
        return { text: new TextDecoder('utf-8').decode(vfs.readFile(path)) };
    }
    catch (e) {
        return { error: errorMessage(e) };
    }
}
function probeVfsPath(vfs, path) {
    try {
        return { exists: vfs.exists(path) };
    }
    catch (e) {
        return { error: errorMessage(e) };
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
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
    while (queue.length > 0) {
        const name = queue.shift();
        const req = requirements.get(name);
        const resolvedPkg = await resolveOneRequirement({
            ...req,
            specs: uniqueStrings([...req.specs, ...(constraints.get(name) || [])]),
        }, runtimeContext);
        if ('error' in resolvedPkg)
            return resolvedPkg;
        const previous = resolved.get(name);
        resolved.set(name, resolvedPkg.package);
        if (previous && previous.version === resolvedPkg.package.version)
            continue;
        if (!includeDependencies)
            continue;
        const dependencyLines = resolvedPkg.package.artifact.kind === 'pyodide-package'
            ? resolvedPkg.package.artifact.artifact.dependencies
            : null;
        const metadata = dependencyLines
            ? null
            : await fetchPypiJson(name, resolvedPkg.package.version);
        if (metadata && 'error' in metadata)
            return metadata;
        for (const depLine of dependencyLines ?? metadata?.data.info.requires_dist ?? []) {
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
            if (!markerApplies(dep.environmentMarkerTree, req.extras))
                continue;
            add(projectRequirementToPackageRequirement(dep));
        }
    }
    return { packages: resolved };
}
async function resolveOneRequirement(req, runtimeContext) {
    const pyodidePackage = findPyodideCompiledPackage(req, runtimeContext);
    if (pyodidePackage && 'error' in pyodidePackage)
        return pyodidePackage;
    if (pyodidePackage) {
        const runtimeArtifact = findRuntimePythonPackageArtifact(pyodidePackage, runtimeContext.runtimeArtifacts || []);
        if (runtimeArtifact) {
            return {
                package: {
                    name: req.name,
                    version: runtimeArtifact.version,
                    artifact: {
                        kind: 'pyodide-package',
                        packageName: runtimeArtifact.packageName,
                        version: runtimeArtifact.version,
                        artifact: runtimeArtifact,
                    },
                },
            };
        }
        const sourcePolicy = PIP_SOURCE_PACKAGES[req.name];
        if (!sourcePolicy)
            return { error: pyodideCompiledPackageDiagnostic(pyodidePackage) };
        return resolveSourcePolicy(req, sourcePolicy);
    }
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
    const metadata = await fetchPypiJson(req.name);
    if ('error' in metadata)
        return metadata;
    const releases = metadata.data.releases || {};
    const versions = Object.keys(releases).filter((version) => validPep440Version(version) && releases[version]?.some((file) => !file.yanked));
    const range = specifierRange(req.specs);
    const version = findBestVersion(versions, range || '>=0');
    if (!version) {
        return { error: `no PyPI release of ${req.name} satisfies ${range || '>=0'}` };
    }
    const versionMetadata = await fetchPypiJson(req.name, version);
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
async function fetchPypiJson(name, version) {
    const canonical = canonicalPackageName(name);
    const key = version ? `${canonical}@${version}` : canonical;
    let entry = pypiCache.get(key);
    if (!entry) {
        const url = version
            ? `${PYPI_API}/${encodeURIComponent(canonical)}/${encodeURIComponent(version)}/json`
            : `${PYPI_API}/${encodeURIComponent(canonical)}/json`;
        entry = {
            promise: fetch(url).then(async (resp) => {
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
                return PypiJsonSchema.parse(await resp.json());
            }),
        };
        pypiCache.set(key, entry);
    }
    try {
        return { data: await entry.promise };
    }
    catch (e) {
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
function markerApplies(marker, extras) {
    if (!marker)
        return true;
    const candidates = extras.length > 0 ? extras : [''];
    return candidates.some((extra) => evaluateMarker(marker, extra));
}
function evaluateMarker(marker, extra) {
    if (isMarkerNode(marker)) {
        const left = evaluateMarker(marker.left, extra);
        const right = evaluateMarker(marker.right, extra);
        return marker.operator === 'and' ? left && right : left || right;
    }
    return evaluateMarkerLeaf(marker, extra);
}
function isMarkerNode(marker) {
    return marker.operator === 'and' || marker.operator === 'or';
}
function evaluateMarkerLeaf(marker, extra) {
    const left = markerValue(marker.left, extra);
    const right = markerValue(marker.right, extra);
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
function markerValue(value, extra) {
    if (value === 'python_version')
        return '3.13';
    if (value === 'python_full_version')
        return '3.13.2';
    if (value === 'os_name')
        return 'posix';
    if (value === 'sys_platform')
        return 'emscripten';
    if (value === 'platform_release')
        return 'nimbus';
    if (value === 'platform_system')
        return 'Emscripten';
    if (value === 'platform_version')
        return 'nimbus';
    if (value === 'platform_machine')
        return 'wasm32';
    if (value === 'platform_python_implementation')
        return 'CPython';
    if (value === 'implementation_name')
        return 'cpython';
    if (value === 'implementation_version')
        return '3.13.2';
    if (value === 'extra')
        return extra;
    return unquotePythonString(value);
}
function unquotePythonString(value) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function localWheelArtifact(rawSpec, baseDir, vfs) {
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
    const probe = probeVfsPath(vfs, abs);
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
        return `Pyodide/Emscripten extension wheel '${fileName}' needs a startup-loaded Nimbus Python package artifact; request-time extension modules cannot run in Workers`;
    }
    return `wheel '${fileName}' targets an unsupported ABI; Nimbus pip supports pure Python wheels and Nimbus ABI artifacts`;
}
function findPyodideCompiledPackage(req, runtimeContext) {
    const lockfile = parsePyodideLockfile(runtimeContext.pyodideLockfileText);
    if (lockfile && 'error' in lockfile)
        return lockfile;
    if (!lockfile)
        return null;
    const canonical = canonicalPackageName(req.name);
    const entry = Object.values(lockfile.data.packages).find((pkg) => canonicalPackageName(pkg.name) === canonical);
    if (!entry || isPurePythonWheel(entry.file_name))
        return null;
    const range = specifierRange(req.specs);
    if (range && !pep440Satisfies(entry.version, range))
        return null;
    if (!isPyodideExtensionWheel(entry.file_name))
        return null;
    return {
        ...entry,
        canonicalName: canonical,
        abi: PYODIDE_PACKAGE_ABI,
    };
}
function parsePyodideLockfile(lockfileText) {
    if (!lockfileText)
        return null;
    try {
        return { data: PyodideLockfileSchema.parse(JSON.parse(lockfileText)) };
    }
    catch (e) {
        return {
            error: `installed Pyodide lockfile is invalid: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
}
function findRuntimePythonPackageArtifact(pkg, artifacts) {
    return artifacts.find((artifact) => {
        if (!isRuntimePythonPackageArtifactMetadata(artifact))
            return false;
        return canonicalPackageName(artifact.packageName) === pkg.canonicalName
            && artifact.version === pkg.version
            && artifact.wheelFileName === pkg.file_name
            && artifact.wheelSha256 === pkg.sha256
            && artifact.loadMode === 'startup-module';
    }) ?? null;
}
function pyodideCompiledPackageDiagnostic(pkg) {
    return `${pkg.canonicalName}==${pkg.version} is available as a Pyodide/Emscripten wheel (${pkg.file_name}), ` +
        `but Nimbus needs a startup-loaded Python package artifact for compiled modules. ` +
        `Request-time WebAssembly extension loading is not supported in Workers.`;
}
function pyodideExtensionWheelDiagnostic(name, version, filenames) {
    const wheel = filenames.find(isPyodideExtensionWheel) || 'Pyodide/Emscripten wheel';
    return `${canonicalPackageName(name)}==${version} ships a Pyodide/Emscripten extension wheel (${wheel}); ` +
        `Nimbus needs a startup-loaded Python package artifact for compiled modules. ` +
        `Request-time WebAssembly extension loading is not supported in Workers.`;
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
function buildPipInstallCode(plan) {
    return [
        'import hashlib',
        'import io',
        'import json',
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
        `pyodide_packages = ${JSON.stringify(plan.pyodidePackages)}`,
        `display_packages = ${JSON.stringify(plan.displayPackages)}`,
        `target_site_packages = ${JSON.stringify('/' + PYTHON_SITE_PACKAGES_ROOT)}`,
        `pyodide_manifest_path = ${JSON.stringify('/' + PYTHON_PYODIDE_PACKAGE_MANIFEST)}`,
        'unsupported_extension_suffixes = (".so", ".pyd", ".dll", ".dylib")',
        'os.makedirs(target_site_packages, exist_ok=True)',
        'if target_site_packages not in sys.path:',
        '    sys.path.insert(0, target_site_packages)',
        'def _nimbus_dist_info_dir(name, version):',
        '    return os.path.join(target_site_packages, name.replace("-", "_") + "-" + version + ".dist-info")',
        'def _nimbus_load_pyodide_manifest():',
        '    try:',
        '        with open(pyodide_manifest_path, "r", encoding="utf-8") as f:',
        '            data = json.load(f)',
        '        if data.get("version") == 1 and isinstance(data.get("packages"), list):',
        '            return data',
        '    except Exception:',
        '        pass',
        '    return {"version": 1, "packages": []}',
        'def _nimbus_write_pyodide_manifest(data):',
        '    os.makedirs(os.path.dirname(pyodide_manifest_path), exist_ok=True)',
        '    tmp = pyodide_manifest_path + ".tmp"',
        '    with open(tmp, "w", encoding="utf-8") as f:',
        '        json.dump(data, f, sort_keys=True)',
        '    os.replace(tmp, pyodide_manifest_path)',
        'def _nimbus_record_pyodide_packages(policies):',
        '    if not policies:',
        '        return',
        '    manifest = _nimbus_load_pyodide_manifest()',
        '    packages = {p.get("id"): p for p in manifest.get("packages", []) if isinstance(p, dict) and p.get("id")}',
        '    for policy in policies:',
        '        packages[policy["id"]] = policy',
        '    manifest["packages"] = sorted(packages.values(), key=lambda p: p["id"])',
        '    _nimbus_write_pyodide_manifest(manifest)',
        'def _nimbus_allowed_extensions(policy):',
        '    return {module["path"] for module in policy.get("extensionModules", [])}',
        'def _nimbus_assert_supported_member(rel, allowed_extensions=None):',
        '    allowed_extensions = allowed_extensions or set()',
        '    leaf = rel.rsplit("/", 1)[-1]',
        '    if leaf.endswith(unsupported_extension_suffixes) and rel not in allowed_extensions:',
        '        raise RuntimeError("unsupported extension artifact in wheel: " + rel)',
        'def _nimbus_safe_target(rel):',
        '    target = os.path.normpath(os.path.join(target_site_packages, rel))',
        '    if not target.startswith(target_site_packages + os.sep):',
        '        raise RuntimeError("unsafe wheel path: " + rel)',
        '    return target',
        'def _nimbus_install_wheel_bytes(data, allowed_extensions=None):',
        '    allowed_extensions = allowed_extensions or set()',
        '    with zipfile.ZipFile(io.BytesIO(data)) as wheel:',
        '        infos = [member for member in wheel.infolist() if not member.is_dir()]',
        '        for member in infos:',
        '            _nimbus_assert_supported_member(member.filename, allowed_extensions)',
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
        'def _nimbus_install_pyodide_package(policy):',
        '    metadata_path = os.path.join(_nimbus_dist_info_dir(policy["packageName"], policy["version"]), "METADATA")',
        '    if os.path.exists(metadata_path):',
        '        return',
        '    url = "https://cdn.jsdelivr.net/pyodide/v" + policy["pyodideVersion"] + "/full/" + policy["wheelFileName"]',
        '    data = _nimbus_fetch_bytes(url, policy["packageName"] + " Pyodide wheel")',
        '    digest = hashlib.sha256(data).hexdigest()',
        '    if digest != policy["wheelSha256"]:',
        '        raise RuntimeError(policy["packageName"] + " Pyodide wheel hash mismatch")',
        '    _nimbus_install_wheel_bytes(data, _nimbus_allowed_extensions(policy))',
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
        '    os.makedirs(dist_info, exist_ok=True)',
        '    with open(os.path.join(dist_info, "METADATA"), "w", encoding="utf-8") as f:',
        '        f.write("Metadata-Version: 2.1\\nName: " + policy["canonicalName"] + "\\nVersion: " + policy["version"] + "\\n")',
        '    with open(os.path.join(dist_info, "WHEEL"), "w", encoding="utf-8") as f:',
        '        f.write("Wheel-Version: 1.0\\nGenerator: Nimbus pip\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
        '    with open(os.path.join(dist_info, "RECORD"), "w", encoding="utf-8") as f:',
        '        f.write("")',
        // A variant package's code is already inside the interpreter and on its
        // sys.path; only the record is missing, and that record is what makes the
        // next spawn pick the interpreter that has it.
        'def _nimbus_install_variant_package(policy):',
        '    dist_info = _nimbus_dist_info_dir(policy["canonicalName"], policy["version"])',
        '    if os.path.exists(os.path.join(dist_info, "METADATA")):',
        '        return',
        '    os.makedirs(dist_info, exist_ok=True)',
        '    with open(os.path.join(dist_info, "METADATA"), "w", encoding="utf-8") as f:',
        '        f.write("Metadata-Version: 2.1\\nName: " + policy["canonicalName"] + "\\nVersion: " + policy["version"] + "\\n")',
        '    with open(os.path.join(dist_info, "WHEEL"), "w", encoding="utf-8") as f:',
        '        f.write("Wheel-Version: 1.0\\nGenerator: Nimbus pip\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
        '    with open(os.path.join(dist_info, "RECORD"), "w", encoding="utf-8") as f:',
        '        f.write("")',
        'for source_package in source_packages:',
        '    _nimbus_install_source_package(source_package)',
        'for variant_package in variant_packages:',
        '    _nimbus_install_variant_package(variant_package)',
        'for wheel in remote_wheels:',
        '    _nimbus_install_remote_wheel(wheel)',
        'for policy in pyodide_packages:',
        '    _nimbus_install_pyodide_package(policy)',
        'for wheel in local_wheels:',
        '    _nimbus_install_local_wheel(wheel)',
        '_nimbus_record_pyodide_packages(pyodide_packages)',
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
