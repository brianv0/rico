#!/bin/sh
# Enumerates the inputs of D2's e2e tests (what run() in e2etests/e2e_test.go compiles) into ../e2e.jsonl, using go test with an
# overlay that replaces e2e_test.go by a copy whose run() records its testCase. Needs D2 v0.7.2 in the Go module cache.
set -e
D=$(go list -m -f '{{.Dir}}' oss.terrastruct.com/d2)
HERE=$(cd "$(dirname "$0")" && pwd)
python3 - "$D" "$HERE" <<'PY'
import sys, json
D, here = sys.argv[1], sys.argv[2]
s = open(D + '/e2etests/e2e_test.go').read()
s = s.replace("func run(t *testing.T, tc testCase) {\n", "func run(t *testing.T, tc testCase) {\n\trecordCase(t, tc)\n\tif true {\n\t\treturn\n\t}\n", 1)
s += open(here + '/record.go.txt').read()
open(here + '/e2e_test.go.gen', 'w').write(s)
json.dump({"Replace": {D + '/e2etests/e2e_test.go': here + '/e2e_test.go.gen'}}, open(here + '/overlay.json', 'w'))
PY
rm -f "$HERE/../e2e.jsonl"
cd "$D" && E2E_OUT="$HERE/../e2e.jsonl" go test -overlay="$HERE/overlay.json" -run 'TestE2E/(sanity|stable|regression|patterns|todo|measured|unicode|root|themes|txtar)$' ./e2etests
