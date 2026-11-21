#!/bin/sh
# Rebuilds public/d2/vendor/mathjax.js: MathJax 3.2.2 (npm mathjax-full, Apache-2.0) + mhchemparser 4.1.1 (Apache-2.0), configured as
# D2's LaTeX component (entry.js), bundled into one ES module by esbuild. esbuild is used ad hoc in a scratch directory and is not a
# dependency of the repository.   usage: sh tools/d2ref/mathjaxbuild/build.sh   (run from the repository root)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$(cd "$here/../../.." && pwd)/public/d2/vendor/mathjax.js
work=$(mktemp -d)
cp "$here/entry.js" "$work/entry.js"
cd "$work"
npm init -y >/dev/null
# mhchemparser first, so that mathjax-full's "^4.1.0" is satisfied by exactly 4.1.1 (the version mathjax-go ports)
npm install --no-audit --no-fund mhchemparser@4.1.1 mathjax-full@3.2.2 esbuild@0.25.5 >/dev/null
npm ls mhchemparser mathjax-full esbuild
{
  printf '%s\n' '/* MathJax 3.2.2 (https://github.com/mathjax/MathJax-src, Apache License 2.0, Copyright (c) 2009-2022 The MathJax Consortium) and'
  printf '%s\n' '   mhchemparser 4.1.1 (Apache License 2.0), configured as D2'"'"'s LaTeX component and bundled by tools/d2ref/mathjaxbuild/build.sh.'
  printf '%s\n' '   Licence text: mathjax.LICENSE.txt. Do not edit by hand. */'
} > "$work/banner.txt"
npx esbuild entry.js --bundle --format=esm --minify --target=es2020 --legal-comments=none --banner:js="$(cat banner.txt)" --outfile="$out"
ls -l "$out"
gzip -9 -c "$out" | wc -c
rm -rf "$work"
