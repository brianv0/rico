package layoutgraph

// Overlay of the TALA port harness (installed as internal/layoutgraph/xdump_pkgcheck.go): read access to the node state that graphjson
// does not carry (margin and padding), for the deep dumps of tala/xdump/pkg_xdump.go.

func (n *Node) XMargin() Spacing  { return n.margin }
func (n *Node) XPadding() Spacing { return n.padding }
