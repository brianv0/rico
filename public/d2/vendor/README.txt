Unmodified copies of D2's own files from oss.terrastruct.com/d2 v0.7.2, d2layouts/d2dagrelayout/:

  dagre.js            dagre (https://github.com/dagrejs/dagre, MIT, Copyright (c) 2012-2014 Chris Pettitt) bundled with
                      graphlib and lodash (MIT); the licence texts are inside the file. dagre.NOTICE.txt is D2's NOTICE.
  setup.js            D2's script that creates the dagre graph `g` (MPL-2.0, Copyright 2022 Terrastruct Inc.).

d2dagrelayout.js evaluates them the way Go does in goja: dagre.js first, then setup.js, then the scripts that
d2dagrelayout/layout.go builds. Do not edit these files; re-copy them when D2 is upgraded.
