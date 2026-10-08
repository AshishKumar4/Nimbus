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
trap 'rm -f "$work/runtime.tsv" "$work/packages.tsv" "$work/view.json" "$work/view.err"; rmdir "$work"' EXIT

pack() {
  local phase="$1"
  bun scripts/ci/remote-publish.mjs "$sha" --phase "$phase" || { echo "STOP: armada $phase publish gates failed; nothing further will be signed" >&2; exit 1; }
  node --input-type=module -e '
    import {readFileSync} from "node:fs";
    const m=JSON.parse(readFileSync(process.argv[1],"utf8"));
    if(m.commit!==process.argv[2]||m.phase!==process.argv[3]||!m.rows.length||m.rows.some(r=>r.exitCode!==0)||!m.tarballs.length) throw new Error("unverified publish manifest");
    for(const p of m.tarballs) {
      if(!/^[A-Za-z0-9._-]+\.tgz$/.test(p.file)||!/^[a-f0-9]{64}$/.test(p.sha256)||!/^[a-f0-9]{40}$/.test(p.shasum)||!/^(?:@nimbus-sh\/[a-z0-9-]+|create-nimbus-app)$/.test(p.name)||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(p.version)) throw new Error("invalid publish artifact");
      console.log([p.name,p.version,p.file,p.sha256,p.shasum,p.integrity].join("\t"));
    }
  ' "$dir/$phase.json" "$sha" "$phase" > "$work/$phase.tsv"
}

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

sign_phase() {
  local phase="$1"
  while IFS=$'\t' read -r name version file sha256 shasum integrity; do
    [[ "$(sha256sum "$dir/$file" | awk '{print $1}')" = "$sha256" ]] || { echo "STOP: sha256 mismatch for $file" >&2; exit 1; }
    local state=0
    published "$name" "$version" "$shasum" "$integrity" || state=$?
    case "$state" in
      0) echo "already on npm, identical: $name@$version" ;;
      4)
        echo "Signing verified tarball: $name@$version ($sha256)"
        if [[ "$phase" = runtime ]]; then
          npm publish "$dir/$file" --registry "$registry" --ignore-scripts --auth-type=web --tag latest --access public
        else
          npm publish "$dir/$file" --registry "$registry" --ignore-scripts --auth-type=web --access public
        fi
        ;;
      *) cat "$work/view.err" >&2; echo "STOP: unable to verify npm state for $name@$version" >&2; exit 1 ;;
    esac
  done < "$work/$phase.tsv"
}

pack runtime
[[ "$(wc -l < "$work/runtime.tsv")" = 1 ]] || { echo 'STOP: phase 1 must contain exactly the CPython runtime' >&2; exit 1; }
IFS=$'\t' read -r runtime_name runtime_version runtime_file runtime_sha runtime_shasum runtime_integrity < "$work/runtime.tsv"
[[ "$runtime_name" = '@nimbus-sh/runtime-cpython' && "$runtime_version" = '3.13.14-1' ]] || { echo 'STOP: phase 1 runtime identity is not the approved build' >&2; exit 1; }
sign_phase runtime
confirmed=false
for attempt in {1..60}; do
  latest="$(npm view --registry "$registry" --prefer-online "$runtime_name" dist-tags.latest)" || { echo 'STOP: npm latest confirmation failed; phase 2 will not run' >&2; exit 1; }
  if [[ "$latest" = "$runtime_version" ]] && published "$runtime_name" "$runtime_version" "$runtime_shasum" "$runtime_integrity"; then confirmed=true; break; fi
  if [[ "$latest" != "$runtime_version" && "$attempt" = 1 ]]; then
    npm dist-tag add "$runtime_name@$runtime_version" latest --registry "$registry" --auth-type=web
  fi
  sleep 2
done
[[ "$confirmed" = true ]] || { echo 'STOP: the verified CPython build is not confirmed as npm latest; phase 2 will not run' >&2; exit 1; }
pack packages
sign_phase packages
echo "Published verified tarballs from $sha; no local build, bundle or pack ran."
