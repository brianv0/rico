#!/bin/sh
# Enumerates the inputs of D2's e2e tests (what run() in e2etests/e2e_test.go compiles) into ../e2e.jsonl, using go test with an
# overlay that replaces e2e_test.go by a copy whose run() records its testCase.
#   usage: run.sh <writable copy of the D2 v0.9.0 source tree>      (the module cache is read-only and `go test` wants to write there)
set -e
D=${1:?usage: run.sh <copy of the D2 v0.9.0 source tree>}
D=$(cd "$D" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
python3 - "$D" "$HERE" <<'PY'
import sys, json
D, here = sys.argv[1], sys.argv[2]
s = open(D + '/e2etests/e2e_test.go').read()
old = "func run(t *testing.T, tc testCase) {\n"
assert old in s
s = s.replace(old, old + "\trecordCase(t, tc)\n\tif true {\n\t\treturn\n\t}\n", 1)
s += open(here + '/record.go.txt').read()
open(here + '/e2e_test.go.gen', 'w').write(s)
json.dump({"Replace": {D + '/e2etests/e2e_test.go': here + '/e2e_test.go.gen'}}, open(here + '/overlay.json', 'w'))
PY
rm -f "$HERE/../e2e.jsonl"
cd "$D" && E2E_OUT="$HERE/../e2e.jsonl" go test -overlay="$HERE/overlay.json" -run 'TestE2E/(sanity|stable|real_world|regression|patterns|todo|measured|unicode|root|themes|txtar)$' ./e2etests
