#!/bin/sh
# Builds a d2ref whose D2 ELK glue (d2layouts/d2elklayout/layout.go of the D2 module) appends the graph it marshals and the layout elk-go returns for it to
# the file named by $D2REF_ELKDUMP, one {"in": <graph>, "out": <layout>|null, "err": <text>|null} per line. The D2 module is copied to a writable
# directory (the module cache is read-only), patched there, and swapped in with a replace directive in a temporary go.mod (-modfile).
#   usage: build.sh <output binary>
# Then:  D2REF_ELKDUMP=/tmp/dump.jsonl <output binary> layout < cases.jsonl   (cases with "layout": "elk")
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: build.sh <output binary>}
mod=$(cd "$here/.." && go list -m -f '{{.Dir}}' all | grep 'd2lang/d2@')
tmp=$(mktemp -d)
cp -r "$mod" "$tmp/d2"
chmod -R u+w "$tmp/d2"
python3 - "$tmp/d2/d2layouts/d2elklayout/layout.go" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = "\tjsonOut, err := elk.LayoutJSON(raw)\n"
assert s.count(old) == 1
s = s.replace(old, old + "\telkDump(raw, jsonOut, err)\n")
s = s.replace('import (\n', 'import (\n\t"os"\n', 1)
s += '''
func elkDump(raw, out []byte, err error) {
	path := os.Getenv("D2REF_ELKDUMP")
	if path == "" {
		return
	}
	f, ferr := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if ferr != nil {
		return
	}
	defer f.Close()
	var o, e []byte = []byte("null"), []byte("null")
	if err != nil {
		e, _ = json.Marshal(err.Error())
	} else {
		o = out
	}
	f.Write([]byte("{\\"in\\":"))
	f.Write(raw)
	f.Write([]byte(",\\"out\\":"))
	f.Write(o)
	f.Write([]byte(",\\"err\\":"))
	f.Write(e)
	f.Write([]byte("}\\n"))
}
'''
open(p, 'w').write(s)
EOF
cp "$here/../go.mod" "$tmp/go.mod"
cp "$here/../go.sum" "$tmp/go.sum"
(cd "$here/.." && go mod edit -modfile="$tmp/go.mod" -replace "github.com/d2lang/d2=$tmp/d2" && go build -modfile="$tmp/go.mod" -o "$out" .)
echo "built $out (D2 ELK glue patched in $tmp/d2)"
