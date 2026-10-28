#!/usr/bin/env bash
# Teardown for one AX lane run. Deletes exactly what <run-dir>/owned-resources.json lists, restores the worker
# pools it scaled down (or deletes them with --delete-benchmarks), deletes the run's Artifact Registry repo,
# then takes a post-snapshot and diffs it against <run-dir>/pre-snapshot.json.
#
#   profiles/ax/teardown.sh <run-dir> [options]
#     (no option)              remove everything the lab owns; LEAVE Substrate v0.6.0 and its transfer SA + grants
#     --delete-benchmarks      delete the scaled pools instead of restoring them
#     --remove-substrate-iam   also delete the snapshot transfer SA and exactly its recorded grants (breaks v0.6.0)
#     --restore-substrate-v05  also reinstall the recorded previous Substrate build, restore its pg_dump and demo
#                              WorkerPools, then remove the transfer SA and grants (implies --remove-substrate-iam).
#                              Needs --yes-clear-node-image-cache as well: it deletes /var/lib/ate/image-cache on
#                              every node with one privileged Pod per node
#     --dry-run                print every action and change nothing (makes no cloud or cluster call)
#   profiles/ax/teardown.sh --snapshot <run-dir> <out.json>   # snapshot only (used for pre-snapshot.json)
#
# Before acting, owned-resources.json must validate against run-dir.schema.json and the current kube context must
# equal its kube_context; otherwise nothing runs. Every identifier (context, project, registry, bucket, account)
# comes from the gitignored run dir, never from this file. Nothing here uses --force; gcloud deletes keep their
# interactive confirmation.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "teardown: $*" >&2; exit 1; }
# j a.b.c: value at a dotted path of owned-resources.json; a list prints space-separated, a missing key prints "".
j() { python3 -c "import json,sys,functools; v=functools.reduce(lambda o,k: (o or {}).get(k), sys.argv[2].split('.'), json.load(open(sys.argv[1]))); print(' '.join(v) if isinstance(v,list) else (v or ''))" "$OWNED" "$1"; }
# rows <python expr over d>: one line per row the expression yields (d = owned-resources.json).
rows() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(*r) for r in ($1)]" "$OWNED"; }
DRY=0
run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }
# run_in <dir> <cmd...>: same, from a directory (the Substrate installer reads manifests from its checkout).
run_in() { local d=$1; shift; echo "+ (cd $d && $*)"; [ "$DRY" = 1 ] || (cd "$d" && "$@"); }

# load_run_dir <run-dir>: refuse unless owned-resources.json matches the schema and the current kube context is the
# one the run recorded; then (unless dry) pin that context in a single-context kubeconfig for every later call.
load_run_dir() {
  RUN_DIR=$1; OWNED="$RUN_DIR/owned-resources.json"
  [ -f "$OWNED" ] || die "missing $OWNED"
  node "$HERE/run-dir.ts" "$OWNED" >&2 || die "$OWNED does not match profiles/ax/run-dir.schema.json; refusing to act"
  local cur; cur=$(kubectl config current-context 2>/dev/null) || die "no current kube context; switch to the run's kube_context first"
  [ "$cur" = "$(j kube_context)" ] || die "current kube context is not the run's kube_context ($OWNED); refusing to act on another cluster"
  PROJECT=$(j project)
  echo "+ kubectl config view --minify --flatten > $RUN_DIR/teardown-kubeconfig; export KUBECONFIG=$RUN_DIR/teardown-kubeconfig"
  if [ "$DRY" = 0 ]; then
    (umask 077; kubectl config view --minify --flatten >"$RUN_DIR/teardown-kubeconfig")
    export KUBECONFIG="$RUN_DIR/teardown-kubeconfig"
  fi
}

snapshot() { # <out.json>
  local out=$1 tmp; tmp=$(mktemp -d)
  kubectl get ns -o json >"$tmp/ns.json"
  for n in $(j scaled_namespaces); do
    kubectl -n "$n" get deploy,workerpool -o json >"$tmp/scaled-$n.json" 2>/dev/null || echo '{"items":[]}' >"$tmp/scaled-$n.json"
  done
  kubectl get crd,clusterrole,clusterrolebinding,validatingwebhookconfiguration,mutatingwebhookconfiguration,validatingadmissionpolicy,validatingadmissionpolicybinding,pv -o json >"$tmp/cluster.json"
  echo '[]' >"$tmp/ar.json"; echo '[]' >"$tmp/disks.json"
  if [ -n "$PROJECT" ]; then
    gcloud artifacts repositories list --project "$PROJECT" --format=json >"$tmp/ar.json" 2>/dev/null || echo '[]' >"$tmp/ar.json"
    gcloud compute disks list --project "$PROJECT" --format=json >"$tmp/disks.json" 2>/dev/null || echo '[]' >"$tmp/disks.json"
  fi
  kubectl ate get atespaces -o json >"$tmp/atespaces.json" 2>/dev/null || echo '{"atespaces":[]}' >"$tmp/atespaces.json"
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
snap["substrate_atespaces"] = sorted(a["metadata"]["name"] for a in (load(f"{tmp}/atespaces.json").get("atespaces") or []))
json.dump(snap, open(out, "w"), indent=2, sort_keys=True)
print(f"snapshot written: {out}")
PY
  rm -rf "$tmp"
}

if [ "${1:-}" = "--snapshot" ]; then
  [ $# -eq 3 ] || die "usage: $0 --snapshot <run-dir> <out.json>"
  load_run_dir "$2"; snapshot "$3"; exit 0
fi

[ $# -ge 1 ] && [ "${1#--}" = "$1" ] || die "usage: $0 <run-dir> [--delete-benchmarks] [--remove-substrate-iam] [--restore-substrate-v05 --yes-clear-node-image-cache] [--dry-run]"
ARG_DIR=$1; shift
DELETE_BENCH=0; REMOVE_IAM=0; RESTORE=0; CLEAR_CACHE=0
for o in "$@"; do
  case "$o" in
    --delete-benchmarks) DELETE_BENCH=1 ;;
    --remove-substrate-iam) REMOVE_IAM=1 ;;
    --restore-substrate-v05) RESTORE=1; REMOVE_IAM=1 ;;
    --yes-clear-node-image-cache) CLEAR_CACHE=1 ;;
    --dry-run) DRY=1 ;;
    *) die "unknown option $o" ;;
  esac
done
[ "$RESTORE" = 1 ] && [ "$DELETE_BENCH" = 1 ] && die "--restore-substrate-v05 restores the demo pools; it cannot be combined with --delete-benchmarks"
[ "$CLEAR_CACHE" = 1 ] && [ "$RESTORE" = 0 ] && die "--yes-clear-node-image-cache only applies to --restore-substrate-v05"
[ "$RESTORE" = 1 ] && [ "$CLEAR_CACHE" = 0 ] && [ "$DRY" = 0 ] &&
  die "--restore-substrate-v05 deletes /var/lib/ate/image-cache on every node (privileged Pod per node); add --yes-clear-node-image-cache to accept that"
load_run_dir "$ARG_DIR"
PRE="$RUN_DIR/pre-snapshot.json"; [ -f "$PRE" ] || die "missing $PRE"
if [ "$RESTORE" = 1 ]; then
  for k in substrate_install.repo local.bin local.bin_v050 local.docker_config; do
    [ -n "$(j "$k")" ] || die "--restore-substrate-v05 needs $k in $OWNED"
  done
fi

BIN=$(j local.bin); [ -z "$BIN" ] || export PATH="$BIN:$PATH"
export AX_HOME="$RUN_DIR/axhome"
AXCLI=$(j local.ax_cli); AXCLI=${AXCLI:-ax}
[ "$DRY" = 1 ] && echo "teardown: DRY RUN, nothing below is executed"
echo "teardown: run $(j run_id), kube context matches the run's kube_context"

# 1. AX objects (Task before Workspace), through the AX API while ax-server still runs. The ax CLI's own tunnel
#    gives up after a 400 ms health check (L-033), so this script holds its own port-forward.
if [ -n "$(rows "[(1,)] if d['ax'] else []")" ]; then
  PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1])")
  echo "+ kubectl -n ax-system port-forward svc/ax-server $PORT:8080 &"
  if [ "$DRY" = 0 ]; then
    kubectl -n ax-system port-forward svc/ax-server "$PORT:8080" >"$RUN_DIR/teardown-pf.log" 2>&1 &
    PF=$!; trap 'kill $PF 2>/dev/null' EXIT; sleep 5
  fi
  rows "sorted(((r['kind'], r['atespace'], r['name']) for r in d['ax']), key=lambda r: r[0] == 'workspace')" |
    while read -r kind atespace name; do
      run "$AXCLI" --server "http://127.0.0.1:$PORT" delete "$kind" "$name" -a "$atespace" || echo "teardown: ax delete $kind $name failed (continuing)"
    done
fi

# 2. Substrate objects (egress policies go with their actor; listed for the diff). Atespaces last: they must be empty.
#    local.bin holds a kubectl-ate built at the deployed Substrate's API version (L-030).
rows "sorted(((r['kind'], r.get('atespace') or '-', r['name']) for r in d['substrate'] if r['kind'] != 'egress-policy'), key=lambda r: r[0] == 'atespace')" |
  while read -r kind atespace name; do
    if [ "$kind" = atespace ]; then run kubectl ate delete atespace "$name"; else run kubectl ate delete "$kind" "$name" -a "$atespace"; fi ||
      echo "teardown: kubectl ate delete $kind $name failed (continuing)"
  done

# 3. Namespaced Kubernetes objects by exact name, then the namespaces the run created.
rows "[(r['kind'], r['namespace'], r['name']) for r in d['kubernetes'] if r['kind'] != 'Namespace']" |
  while read -r kind ns name; do run kubectl -n "$ns" delete "$kind" "$name" --ignore-not-found --wait=false; done
rows "[(r['name'],) for r in d['kubernetes'] if r['kind'] == 'Namespace']" |
  while read -r ns; do run kubectl delete namespace "$ns" --ignore-not-found --timeout=300s; done

# 4. Cluster-scoped objects the AX deploy created.
rows "[(r['kind'], r['name']) for r in d['cluster_scoped']]" |
  while read -r kind name; do run kubectl delete "$kind" "$name" --ignore-not-found; done

# 5. Worker pools scaled to zero: restore the recorded replicas, or delete them when explicitly asked. A pool the
#    Substrate reinstall removed (deleting the CRDs deletes every WorkerPool) is reported, and recreated only by
#    --restore-substrate-v05 (step 9).
rows "[(r['namespace'], r['name'], r['replicas_before']) for r in d['scaled']]" |
  while read -r ns name replicas; do
    if [ "$DRY" = 0 ] && ! kubectl -n "$ns" get workerpool "$name" >/dev/null 2>&1; then
      echo "teardown: WorkerPool $ns/$name is absent (removed by the Substrate reinstall); not restored here"; continue
    fi
    [ "$DRY" = 1 ] && echo "  (at run time: skipped with a message if $ns/$name is absent; the Substrate reinstall deleted it)"
    if [ "$DELETE_BENCH" = 1 ]; then run kubectl -n "$ns" delete workerpool "$name" --ignore-not-found
    else run kubectl -n "$ns" scale workerpool "$name" --replicas="$replicas"; fi
  done

# 6. Run-owned cloud resources: snapshot objects under the run's prefixes, then the Artifact Registry repo.
for PREFIX in $(j gcs_snapshot_prefix) $(j gcs_snapshot_prefixes); do
  if [ "$DRY" = 1 ]; then echo "+ gcloud storage rm --recursive $PREFIX --project $PROJECT   (only if objects exist)"
  elif gcloud storage ls "$PREFIX" --project "$PROJECT" >/dev/null 2>&1; then run gcloud storage rm --recursive "$PREFIX" --project "$PROJECT"; fi
done
[ -z "$(j ar.repo)" ] || run gcloud artifacts repositories delete "$(j ar.repo)" --location "$(j ar.location)" --project "$PROJECT"

# 7. Post-snapshot and diff. Pool replicas are expected to match pre-snapshot again in restore mode. Changes the
#    Substrate reinstall made (reinstall-delta.json: a before/after diff taken around the reinstall) are expected
#    unless --restore-substrate-v05 ran, which should undo them.
diff_against_pre() {
  if [ "$DRY" = 1 ]; then echo "+ snapshot $RUN_DIR/post-snapshot.json; diff against $PRE (expected changes: $RUN_DIR/reinstall-delta.json unless restoring)"; return 0; fi
  snapshot "$RUN_DIR/post-snapshot.json"
  python3 - "$PRE" "$RUN_DIR/post-snapshot.json" "$DELETE_BENCH" "$RUN_DIR/reinstall-delta.json" "$RESTORE" <<'PY'
import json, os, sys
pre, post, deleted = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3] == "1"
delta = set(json.load(open(sys.argv[4]))["lines"]) if os.path.exists(sys.argv[4]) else set()
restored = sys.argv[5] == "1"
diff = []
for key in ("namespaces", "artifact_registry_repos", "compute_disks", "substrate_atespaces"):
    a, b = set(pre.get(key, [])), set(post.get(key, []))
    diff += [f"{key}: added {x}" for x in sorted(b - a)] + [f"{key}: removed {x}" for x in sorted(a - b)]
for kind in sorted(set(pre["cluster_scoped"]) | set(post["cluster_scoped"])):
    a, b = set(pre["cluster_scoped"].get(kind, [])), set(post["cluster_scoped"].get(kind, []))
    diff += [f"{kind}: added {x}" for x in sorted(b - a)] + [f"{kind}: removed {x}" for x in sorted(a - b)]
for k in sorted(set(pre["scaled"]) | set(post["scaled"])):
    if pre["scaled"].get(k) != post["scaled"].get(k):
        diff.append(f"{k}: replicas {pre['scaled'].get(k)} -> {post['scaled'].get(k)}")
expected = [l for l in diff if (deleted and "replicas" in l) or (not restored and l in delta)]
unexpected = [l for l in diff if l not in expected]
print("teardown diff:" if diff else "teardown diff: empty (post-snapshot matches pre-snapshot)")
for line in expected: print("  expected:", line, "(--delete-benchmarks)" if "replicas" in line and deleted and line not in delta else "(Substrate reinstall, reinstall-delta.json)")
for line in unexpected: print("  UNEXPECTED:", line)
sys.exit(1 if unexpected else 0)
PY
}

# 8. IAM the Substrate v0.6.0 install needs (owned-resources.json "iam"): bindings first, then the account.
remove_iam() {
  echo "teardown: WARNING: removing the snapshot transfer service account and its grants. Substrate v0.6.0's"
  echo "teardown:          ate-api-server refuses to start without them; snapshots and restarts fail from here on."
  rows "[(r['resource_type'], r['resource'], r['member'], r['role']) for r in d.get('iam', []) if r['kind'] == 'iam-binding']" |
    while read -r type resource member role; do
      case "$type" in
        bucket) run gcloud storage buckets remove-iam-policy-binding "$resource" --member="$member" --role="$role" --project "$PROJECT" ;;
        service-account) run gcloud iam service-accounts remove-iam-policy-binding "$resource" --member="$member" --role="$role" --project "$PROJECT" ;;
        *) die "unknown iam resource_type $type" ;;
      esac
    done
  rows "[(r['email'],) for r in d.get('iam', []) if r['kind'] == 'service-account']" |
    while read -r email; do run gcloud iam service-accounts delete "$email" --project "$PROJECT"; done
}

# 9. Reinstall the previous Substrate build (substrate_install.previous) and its data. The installer is Substrate's
#    own ate-setup, run from a checkout at the recorded commit: delete with the current release, deploy the
#    previous one with its recorded settings, restore the pg_dump, recreate the demo WorkerPools from the
#    pre-reinstall manifests with the replicas recorded before the lab scaled them, switch kubectl-ate back.
# Each atelet release refuses the other's node-local image cache layout ("delete it once no actor runs on this
# node"), so it is removed on every node while no atelet runs (only with --yes-clear-node-image-cache). One Pod per
# node, created by this script with labels apl-run=<run_id>,apl-role=image-cache-wipe; only Pods with both labels
# are waited on and deleted. postgres:18-alpine is the image Substrate itself pins, pulled by digest, so this works
# after the lab's registry is gone.
wipe_image_cache() {
  local img=postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
  local sel="apl-run=$(j run_id),apl-role=image-cache-wipe" pods="$RUN_DIR/image-cache-wipe-pods.json"
  echo "teardown: WARNING: deletes /var/lib/ate/image-cache on EVERY node of the cluster, using one privileged Pod per"
  echo "teardown:          node (hostPath /var/lib/ate) in namespace default. Anything else on those nodes that relies on"
  echo "teardown:          that cache loses it. A real run requires --yes-clear-node-image-cache."
  [ "$CLEAR_CACHE" = 1 ] || echo "teardown:          --yes-clear-node-image-cache NOT given: without --dry-run this run would refuse."
  echo "+ render $pods: one Pod per node, image $img, rm -rf /host/var/lib/ate/image-cache, labels $sel"
  if [ "$DRY" = 0 ]; then
    # shellcheck disable=SC2046 # one argument per node name
    python3 - "$img" "$(j run_id)" "$pods" $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}') <<'PY'
import json, sys
img, run_id, out, nodes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
if not nodes: sys.exit("no nodes listed")
items = [{"apiVersion": "v1", "kind": "Pod",
          "metadata": {"name": f"apl-cache-wipe-{run_id[:8]}-{i}", "namespace": "default",
                       "labels": {"apl-run": run_id, "apl-role": "image-cache-wipe"}},
          "spec": {"nodeName": n, "restartPolicy": "Never", "tolerations": [{"operator": "Exists"}],
                   "containers": [{"name": "wipe", "image": img, "command": ["rm", "-rf", "/host/var/lib/ate/image-cache"],
                                   "securityContext": {"privileged": True},
                                   "volumeMounts": [{"name": "ate", "mountPath": "/host/var/lib/ate"}]}],
                   "volumes": [{"name": "ate", "hostPath": {"path": "/var/lib/ate", "type": "Directory"}}]}}
         for i, n in enumerate(nodes)]
json.dump({"apiVersion": "v1", "kind": "List", "items": items}, open(out, "w"), indent=2)
print(f"{len(items)} image-cache wipe Pods rendered, one per node")
PY
  fi
  run kubectl apply -f "$pods"
  run kubectl -n default wait pod -l "$sel" --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s ||
    die "image-cache wipe did not succeed on every node; Pods left for inspection (kubectl -n default get pods -l $sel)"
  run kubectl -n default logs -l "$sel" --prefix
  run kubectl -n default delete pod -l "$sel" --wait=false
}
checkout() { # <commit> -> prints a checkout dir under the run dir
  local dir="$RUN_DIR/src/substrate-${1:0:12}"
  if [ ! -d "$dir/.git" ]; then
    run git clone --quiet "$(j substrate_install.repo)" "$dir" >&2
    run git -C "$dir" checkout --quiet "$1" >&2
  fi
  echo "$dir"
}
restore_v05() {
  local cur prev cur_dir prev_dir rb dump pools
  cur=$(j substrate_install.current.commit); prev=$(j substrate_install.previous.commit)
  rb=$(j substrate_install.previous.rollback_dir); dump="$rb/atepg.dump"
  [ "$DRY" = 1 ] || [ -f "$dump" ] || die "missing $dump"
  cur_dir=$(checkout "$cur"); prev_dir=$(checkout "$prev")
  echo "teardown: restoring Substrate $(j substrate_install.previous.version) ($prev) over $(j substrate_install.current.version) ($cur)"
  export DOCKER_CONFIG; DOCKER_CONFIG=$(j local.docker_config)
  run_in "$cur_dir" env GOFLAGS=-mod=vendor go run ./cmd/ate-setup --no-dev-env --config "$(j substrate_install.current.config)" --kubeconfig "$RUN_DIR/teardown-kubeconfig" delete ate-system
  wipe_image_cache
  run_in "$prev_dir" env GOFLAGS=-mod=vendor go run ./cmd/ate-setup --no-dev-env --config "$(j substrate_install.previous.config)" --kubeconfig "$RUN_DIR/teardown-kubeconfig" --record-dir "$RUN_DIR/ate-setup-records" deploy ate-system
  echo "+ kubectl -n ate-system exec -i postgres-0 -c postgres -- pg_restore -U postgres -d atepg --clean --if-exists < $dump"
  [ "$DRY" = 1 ] || kubectl -n ate-system exec -i postgres-0 -c postgres -- pg_restore -U postgres -d atepg --clean --if-exists <"$dump"
  run kubectl -n ate-system rollout restart deployment/ate-api-server
  run kubectl -n ate-system rollout status deployment/ate-api-server --timeout=300s
  pools="$RUN_DIR/restore-workerpools.json"
  echo "+ render $pools from $rb/manifests/workerpools.json (the scaled pools only, at replicas_before)"
  [ "$DRY" = 1 ] || python3 - "$rb/manifests/workerpools.json" "$OWNED" "$pools" <<'PY'
import json, sys
src, owned, out = sys.argv[1], json.load(open(sys.argv[2])), sys.argv[3]
want = {(s["namespace"], s["name"]): s["replicas_before"] for s in owned["scaled"]}
items = []
for i in json.load(open(src))["items"]:
    key = (i["metadata"]["namespace"], i["metadata"]["name"])
    if key in want:
        md = {k: i["metadata"][k] for k in ("name", "namespace", "labels", "annotations") if k in i["metadata"]}
        md.get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
        items.append({"apiVersion": i["apiVersion"], "kind": i["kind"], "metadata": md, "spec": {**i["spec"], "replicas": want[key]}})
json.dump({"apiVersion": "v1", "kind": "List", "items": items}, open(out, "w"), indent=2)
print(f"{len(items)} WorkerPools rendered")
PY
  run kubectl apply -f "$pools"
  run cp "$(j local.bin_v050)/kubectl-ate" "$BIN/kubectl-ate"
}

if [ "$RESTORE" = 1 ]; then restore_v05; fi
if [ "$REMOVE_IAM" = 1 ]; then remove_iam; fi

STATUS=0; diff_against_pre || STATUS=$?
if [ "$REMOVE_IAM" = 0 ] && [ -n "$(j substrate_install.current.version)" ]; then
  echo
  echo "teardown: LEFT IN PLACE on purpose:"
  echo "  - Substrate $(j substrate_install.current.version) ($(j substrate_install.current.commit)) in ate-system, installed by this run"
  rows "[(r['kind'], r.get('email') or (r['role'] + ' for ' + r['member'] + ' on ' + r['resource'])) for r in d.get('iam', [])]" |
    while read -r line; do echo "  - $line"; done
  echo "  The v0.6.0 ate-api-server refuses to start without the transfer service account. To remove them anyway:"
  echo "    $0 $RUN_DIR --remove-substrate-iam      # breaks Substrate v0.6.0"
  echo "    $0 $RUN_DIR --restore-substrate-v05 --yes-clear-node-image-cache   # previous build + data back, then removes them"
fi
exit "$STATUS"
