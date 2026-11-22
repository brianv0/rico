package layoutgraph

// Overlay of the TALA port harness (installed as internal/layoutgraph/xdump_routecheck.go): write access to the node state that
// graphjson does not carry (margin and padding), so the routing stage check can rebuild a live graph from a recorded case in Go.

func (n *Node) XSetMargin(top, bottom, left, right float64) {
	n.margin = Spacing{top: top, bottom: bottom, left: left, right: right}
}

func (n *Node) XSetPadding(top, bottom, left, right float64) {
	n.padding = Spacing{top: top, bottom: bottom, left: left, right: right}
}
