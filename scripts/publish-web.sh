#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="${NIMBUS_PUBLISH_REPO:-$(git -C "$script_dir" rev-parse --show-toplevel)}"
cd "$repo"
sha="${1:-$(git rev-parse HEAD)}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'usage: publish-web.sh [full commit sha]' >&2; exit 2; }
artifacts="$(node --input-type=module -e 'import {PUBLISH_ARTIFACTS} from "./scripts/ci/lib/state-dir.mjs"; console.log(PUBLISH_ARTIFACTS);')"
dir="$artifacts/$sha"
registry='https://registry.npmjs.org'
work="$(mktemp -d)"
trap 'rm -f "$work/artifacts.tsv" "$work/cache.err" "$work/view.json" "$work/view.err"; rmdir "$work"' EXIT

verified_artifacts() {
  node --input-type=module -e '
    import {verifiedPublishArtifacts} from "./scripts/ci/lib/publish-artifacts.mjs";
    for(const p of verifiedPublishArtifacts(process.cwd(),process.argv[1],process.argv[2])) {
      console.log([p.name,p.version,p.file,p.sha256,p.shasum,p.integrity].join("\t"));
    }
  ' "$dir" "$sha" > "$work/artifacts.tsv"
}

if ! verified_artifacts 2> "$work/cache.err"; then
  echo 'Verified artifacts are missing or changed; requesting one armada pack for this commit.'
  bun scripts/ci/remote-publish.mjs "$sha" || { echo 'STOP: armada publish gates failed; no package will be signed' >&2; exit 1; }
  verified_artifacts || { echo 'STOP: armada returned no complete verified signing set' >&2; exit 1; }
fi

published() {
  local name="$1" version="$2" shasum="$3" integrity="$4"
  local status=0
  npm view --registry "$registry" --prefer-online "$name@$version" dist --json > "$work/view.json" 2> "$work/view.err" || status=$?
  node --input-type=module -e '
    import {readFileSync} from "node:fs";
    const [file,status,shasum,integrity]=process.argv.slice(1);
    let value; try {value=JSON.parse(readFileSync(file,"utf8"));} catch {console.error("npm registry check returned no valid JSON");process.exit(3);}
    if(Number(status)!==0) {
      if(value.error?.code==="E404") process.exit(4);
      console.error(JSON.stringify(value));process.exit(3);
    }
    if(value.shasum!==shasum||value.integrity!==integrity) {console.error("STOP: npm already holds different bytes for this immutable version");process.exit(3);}
  ' "$work/view.json" "$status" "$shasum" "$integrity"
}

sign() {
    local name="$1" version="$2" file="$3" sha256="$4" shasum="$5" integrity="$6"
    latest_requested=false
    [[ "$(sha256sum "$dir/$file" | awk '{print $1}')" = "$sha256" ]] || { echo "STOP: sha256 mismatch for $file" >&2; exit 1; }
    local state=0
    published "$name" "$version" "$shasum" "$integrity" || state=$?
    case "$state" in
      0) echo "already on npm, identical: $name@$version" ;;
      4)
        echo "Signing verified tarball: $name@$version ($sha256)"
        npm publish "$dir/$file" --registry "$registry" --ignore-scripts --auth-type=web --tag latest --access public
        latest_requested=true
        ;;
      *) cat "$work/view.err" >&2; echo "STOP: unable to verify npm state for $name@$version" >&2; exit 1 ;;
    esac
}

IFS=$'\t' read -r -u 3 runtime_name runtime_version runtime_file runtime_sha runtime_shasum runtime_integrity 3< "$work/artifacts.tsv"
[[ "$runtime_name" = '@nimbus-sh/runtime-cpython' && "$runtime_version" = '3.13.14-1' ]] || { echo 'STOP: phase 1 runtime identity is not the approved build' >&2; exit 1; }
sign "$runtime_name" "$runtime_version" "$runtime_file" "$runtime_sha" "$runtime_shasum" "$runtime_integrity"
confirmed=false
confirm_deadline=$(( $(date +%s) + 600 ))
while (( $(date +%s) < confirm_deadline )); do
  state=0
  published "$runtime_name" "$runtime_version" "$runtime_shasum" "$runtime_integrity" || state=$?
  case "$state" in
    0)
      latest="$(npm view --registry "$registry" --prefer-online "$runtime_name" dist-tags.latest)" || { echo 'STOP: npm latest confirmation failed; phase 2 will not run' >&2; exit 1; }
      if [[ "$latest" = "$runtime_version" ]]; then confirmed=true; break; fi
      # A new publish already requested latest. Let both reads propagate without
      # another signing; only an identical version found before this run needs a tag.
      if [[ "$latest_requested" = false ]]; then
        npm dist-tag add "$runtime_name@$runtime_version" latest --registry "$registry" --auth-type=web
        latest_requested=true
      fi
      ;;
    4) ;; # The version is not visible yet; do not inspect or change its tag.
    *) cat "$work/view.err" >&2; echo 'STOP: unable to verify npm runtime bytes; phase 2 will not run' >&2; exit 1 ;;
  esac
  sleep 5
done
[[ "$confirmed" = true ]] || { echo 'STOP: the verified CPython build is not confirmed as npm latest; phase 2 will not run' >&2; exit 1; }
while IFS=$'\t' read -r -u 3 name version file sha256 shasum integrity; do
  [[ "$name" != "$runtime_name" ]] || continue
  sign "$name" "$version" "$file" "$sha256" "$shasum" "$integrity"
done 3< "$work/artifacts.tsv"
echo "Published verified tarballs from $sha; no local build, bundle or pack ran."
