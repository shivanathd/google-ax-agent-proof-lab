#!/usr/bin/env bash
# Teardown for one AX lane run. Deletes exactly what <run-dir>/owned-resources.json lists, restores the worker
# pools it scaled down (or deletes them with --delete-benchmarks), deletes the run's Artifact Registry repo,
# then takes a post-snapshot and diffs it against <run-dir>/pre-snapshot.json.
#
#   profiles/ax/teardown.sh <run-dir>                       # restore scaled pools (default)
#   profiles/ax/teardown.sh <run-dir> --delete-benchmarks   # delete the scaled pools instead of restoring
#   profiles/ax/teardown.sh --snapshot <run-dir> <out.json> # snapshot only (used for pre-snapshot.json)
#
# Every identifier (project, zone, cluster, registry, bucket) comes from the gitignored run dir, never from this file.
# Nothing here uses --force; gcloud deletes keep their interactive confirmation.
set -euo pipefail

die() { echo "teardown: $*" >&2; exit 1; }
# j a.b.c: value at a dotted path of owned-resources.json; a list prints space-separated, a missing key prints "".
j() { python3 -c "import json,sys,functools; v=functools.reduce(lambda o,k: (o or {}).get(k), sys.argv[2].split('.'), json.load(open(sys.argv[1]))); print(' '.join(v) if isinstance(v,list) else (v or ''))" "$OWNED" "$1"; }

snapshot() { # <out.json>
  local out=$1 tmp; tmp=$(mktemp -d)
  kubectl get ns -o json >"$tmp/ns.json"
  for n in $(j scaled_namespaces); do
    kubectl -n "$n" get deploy,workerpool -o json >"$tmp/scaled-$n.json" 2>/dev/null || echo '{"items":[]}' >"$tmp/scaled-$n.json"
  done
  kubectl get crd,clusterrole,clusterrolebinding,validatingwebhookconfiguration,mutatingwebhookconfiguration,validatingadmissionpolicy,validatingadmissionpolicybinding,pv -o json >"$tmp/cluster.json"
  gcloud artifacts repositories list --project "$(j project)" --format=json >"$tmp/ar.json" 2>/dev/null || echo '[]' >"$tmp/ar.json"
  gcloud compute disks list --project "$(j project)" --format=json >"$tmp/disks.json" 2>/dev/null || echo '[]' >"$tmp/disks.json"
  python3 - "$tmp" "$out" <<'PY'
import json, os, sys, glob, datetime
tmp, out = sys.argv[1], sys.argv[2]
load = lambda p: json.load(open(p))
snap = {"taken_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "namespaces": sorted(i["metadata"]["name"] for i in load(f"{tmp}/ns.json")["items"]), "scaled": {}, "cluster_scoped": {}}
for p in sorted(glob.glob(f"{tmp}/scaled-*.json")):
    for i in load(p)["items"]:
        m = i["metadata"]
        snap["scaled"][f'{i["kind"]}/{m["namespace"]}/{m["name"]}'] = i["spec"].get("replicas")
for i in load(f"{tmp}/cluster.json")["items"]:
    snap["cluster_scoped"].setdefault(i["kind"], []).append(i["metadata"]["name"])
for v in snap["cluster_scoped"].values(): v.sort()
snap["artifact_registry_repos"] = sorted(r["name"] for r in load(f"{tmp}/ar.json"))
snap["compute_disks"] = sorted(r["name"] for r in load(f"{tmp}/disks.json"))
json.dump(snap, open(out, "w"), indent=2, sort_keys=True)
print(f"snapshot written: {out}")
PY
  rm -rf "$tmp"
}

if [ "${1:-}" = "--snapshot" ]; then
  [ $# -eq 3 ] || die "usage: $0 --snapshot <run-dir> <out.json>"
  OWNED="$2/owned-resources.json"; [ -f "$OWNED" ] || die "missing $OWNED"
  : "${KUBECONFIG:?set KUBECONFIG to the dedicated kubeconfig of the run}"
  snapshot "$3"; exit 0
fi

RUN_DIR=${1:?usage: $0 <run-dir> [--delete-benchmarks]}
DELETE_BENCH=0; [ "${2:-}" = "--delete-benchmarks" ] && DELETE_BENCH=1
OWNED="$RUN_DIR/owned-resources.json"; PRE="$RUN_DIR/pre-snapshot.json"
[ -f "$OWNED" ] && [ -f "$PRE" ] || die "need $OWNED and $PRE"

PROJECT=$(j project); ZONE=$(j zone); CLUSTER=$(j cluster)
BIN=$(j local.bin); export PATH="$BIN:$PATH" AX_HOME="$RUN_DIR/axhome"
export KUBECONFIG="$RUN_DIR/teardown-kubeconfig"
gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT" >/dev/null
CTX=$(kubectl config current-context)
echo "teardown: run $(j run_id) on context in $KUBECONFIG"

# 1. AX objects (Task before Workspace), through the AX API while ax-server still runs.
python3 -c "import json,sys; [print(r['kind'], r['atespace'], r['name']) for r in json.load(open(sys.argv[1]))['ax']]" "$OWNED" |
  sort -r | while read -r kind atespace name; do
    ax --context "$CTX" delete "$kind" "$name" -a "$atespace" || echo "teardown: ax delete $kind $name failed (continuing)"
  done

# 2. Substrate objects the run created directly (egress policies are deleted with their actor; listed for the diff).
python3 -c "import json,sys; [print(r['kind'], r['atespace'], r['name']) for r in json.load(open(sys.argv[1]))['substrate'] if r['kind'] != 'egress-policy']" "$OWNED" |
  while read -r kind atespace name; do
    kubectl ate delete "$kind" "$name" -a "$atespace" || echo "teardown: kubectl ate delete $kind $name failed (continuing)"
  done

# 3. Namespaced Kubernetes objects by exact name, then the namespaces the run created.
python3 -c "import json,sys; [print(r['kind'], r['namespace'], r['name']) for r in json.load(open(sys.argv[1]))['kubernetes'] if r['kind'] != 'Namespace']" "$OWNED" |
  while read -r kind ns name; do kubectl -n "$ns" delete "$kind" "$name" --ignore-not-found --wait=false; done
python3 -c "import json,sys; [print(r['name']) for r in json.load(open(sys.argv[1]))['kubernetes'] if r['kind'] == 'Namespace']" "$OWNED" |
  while read -r ns; do kubectl delete namespace "$ns" --ignore-not-found --timeout=300s; done

# 4. Cluster-scoped objects the AX deploy created.
python3 -c "import json,sys; [print(r['kind'], r['name']) for r in json.load(open(sys.argv[1]))['cluster_scoped']]" "$OWNED" |
  while read -r kind name; do kubectl delete "$kind" "$name" --ignore-not-found; done

# 5. Worker pools scaled to zero: restore the recorded replicas, or delete them when explicitly asked.
python3 -c "import json,sys; [print(r['namespace'], r['name'], r['replicas_before']) for r in json.load(open(sys.argv[1]))['scaled']]" "$OWNED" |
  while read -r ns name replicas; do
    if [ "$DELETE_BENCH" = 1 ]; then kubectl -n "$ns" delete workerpool "$name" --ignore-not-found
    else kubectl -n "$ns" scale workerpool "$name" --replicas="$replicas"; fi
  done

# 6. Run-owned cloud resources: snapshot objects under the run's prefix, then the Artifact Registry repo.
PREFIX=$(j gcs_snapshot_prefix)
if [ -n "$PREFIX" ] && gcloud storage ls "$PREFIX" >/dev/null 2>&1; then gcloud storage rm --recursive "$PREFIX"; fi
gcloud artifacts repositories delete "$(j ar.repo)" --location "$(j ar.location)" --project "$PROJECT"

# 7. Post-snapshot and diff. Pool replicas are expected to match pre-snapshot again in restore mode.
snapshot "$RUN_DIR/post-snapshot.json"
python3 - "$PRE" "$RUN_DIR/post-snapshot.json" "$DELETE_BENCH" <<'PY'
import json, sys
pre, post, deleted = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3] == "1"
diff = []
for key in ("namespaces", "artifact_registry_repos", "compute_disks"):
    a, b = set(pre[key]), set(post[key])
    diff += [f"{key}: added {x}" for x in sorted(b - a)] + [f"{key}: removed {x}" for x in sorted(a - b)]
for kind in sorted(set(pre["cluster_scoped"]) | set(post["cluster_scoped"])):
    a, b = set(pre["cluster_scoped"].get(kind, [])), set(post["cluster_scoped"].get(kind, []))
    diff += [f"{kind}: added {x}" for x in sorted(b - a)] + [f"{kind}: removed {x}" for x in sorted(a - b)]
for k in sorted(set(pre["scaled"]) | set(post["scaled"])):
    if pre["scaled"].get(k) != post["scaled"].get(k):
        diff.append(f"{k}: replicas {pre['scaled'].get(k)} -> {post['scaled'].get(k)}" + (" (expected: --delete-benchmarks)" if deleted else ""))
print("teardown diff:" if diff else "teardown diff: empty (post-snapshot matches pre-snapshot)")
for line in diff: print(" ", line)
sys.exit(1 if diff and not deleted else 0)
PY
