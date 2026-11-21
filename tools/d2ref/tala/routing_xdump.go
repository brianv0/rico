package routing

// Overlay file of the TALA port harness (tools/d2ref/tala/setup.sh copies it into
// d2layouts/d2talalayout/internal/routing/xdump_hook.go of a writable copy of the D2 module and runs routing_hooks.mjs, which
// inserts the calls of the xHook* functions below into graph_stage.go and coordinator.go).
//
// It records, for every call of RouteGraph (the EdgeRouting stages and the compound candidate), the router level facts the JS port
// of the routing core replays: the whole graph before routing, then per routed subgraph the node IDs, the nearby obstacle nodes, the
// OVG that was built (canonical, order independent), the routes that existed before the flavors ran, the edges to route and the
// response of every flavor (routes as OVG node coordinates, distance, error, work units used), and the final edge points.
// Nothing here changes the behaviour of the package: with XObserve == false every hook returns at once.

import (
	"context"
	"fmt"
	"sort"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
)

// XObserve switches the recording on. XSerialize turns a graph into its graphjson (set by the xdump program).
var (
	XObserve   bool
	XSerialize func(*layoutgraph.Graph) interface{}
)

type XOwner [3]int64 // owner node ID, port direction mask, isCenterPort (0/1)

type XOVGNode struct {
	P         [2]float64   `json:"p"`
	Adj       [][2]float64 `json:"adj"` // points of the adjacent OVG nodes in node.Edges order
	Owners    []XOwner     `json:"owners,omitempty"`
	Near      []int64      `json:"near,omitempty"` // owners whose ports this node is near
	Container *int64       `json:"container"`
	Flags     int          `json:"flags"` // 1 node center, 2 tunnel
}

type XPorts struct {
	Owner  int64        `json:"owner"`
	Points [][2]float64 `json:"points"` // in slice order (duplicates included)
}

type XCenter struct {
	Owner int64      `json:"owner"`
	P     [2]float64 `json:"p"`
}

type XOVG struct {
	Nodes     []XOVGNode `json:"nodes"` // sorted by point
	Ports     []XPorts   `json:"ports"` // sorted by owner
	Centers   []XCenter  `json:"centers"`
	Inside    []int64    `json:"inside"` // NodesInsideBoundingBox IDs in order
	EdgeCount int        `json:"edgeCount"`
}

type XGuard struct {
	Candidates uint64 `json:"candidates"`
	Nodes      uint64 `json:"nodes"`
	Edges      uint64 `json:"edges"`
	Work       uint64 `json:"work"`
}

type XRoute struct {
	Edge     int64        `json:"edge"`
	Nodes    [][3]float64 `json:"nodes"` // x, y, 1 if the node is the OVG's canonical node of that point
	FromPort [2]float64   `json:"fromPort"`
	ToPort   [2]float64   `json:"toPort"`
}

type XFlavor struct {
	Flavor   string   `json:"flavor"`
	Routes   []XRoute `json:"routes"`
	Distance float64  `json:"distance"`
	Err      string   `json:"err,omitempty"`
	Used     uint64   `json:"used"`
}

type XEdgePoints struct {
	Edge   int64        `json:"edge"`
	Points [][2]float64 `json:"points"`
}

type XSubgraph struct {
	Nodes    []int64       `json:"nodes"`
	Nearby   []int64       `json:"nearby"`
	OVG      *XOVG         `json:"ovg,omitempty"`
	OVGErr   string        `json:"ovgErr,omitempty"`
	Guard    XGuard        `json:"guard"`
	Existing []XRoute      `json:"existing"`
	Unrouted []int64       `json:"unrouted"`
	Flavors  []XFlavor     `json:"flavors"`
	FlavErr  string        `json:"flavErr,omitempty"`
	Err      string        `json:"err,omitempty"`
	Final    []XEdgePoints `json:"final"`
}

// XCall is one call of RouteGraph.
type XCall struct {
	Graph     interface{}  `json:"graph"`
	Subgraphs []*XSubgraph `json:"subgraphs"`
}

var (
	xCalls []*XCall
	xCall  *XCall
	xSub   *XSubgraph
)

// XCollect returns the calls recorded since the last call and forgets them.
func XCollect() []*XCall {
	out := xCalls
	xCalls = nil
	xCall = nil
	xSub = nil
	return out
}

func xDumpOVG(ovg *OVG) *XOVG {
	out := &XOVG{EdgeCount: len(ovg.Edges)}
	nodes := make([]*OVGNode, len(ovg.Nodes))
	copy(nodes, ovg.Nodes)
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].X != nodes[j].X {
			return nodes[i].X < nodes[j].X
		}
		if nodes[i].Y != nodes[j].Y {
			return nodes[i].Y < nodes[j].Y
		}
		return nodes[i].IsNodeCenter && !nodes[j].IsNodeCenter
	})
	for _, n := range nodes {
		xn := XOVGNode{P: [2]float64{n.X, n.Y}, Adj: [][2]float64{}}
		for _, e := range n.Edges {
			adj := n.adjacent(e)
			xn.Adj = append(xn.Adj, [2]float64{adj.X, adj.Y})
		}
		for owner, metadata := range n.portOwners() {
			center := int64(0)
			if metadata.isCenterPort {
				center = 1
			}
			xn.Owners = append(xn.Owners, XOwner{int64(owner.ID), int64(metadata.directions), center})
		}
		sort.Slice(xn.Owners, func(i, j int) bool { return xn.Owners[i][0] < xn.Owners[j][0] })
		for owner := range n.IsNearPort {
			xn.Near = append(xn.Near, int64(owner.ID))
		}
		sort.Slice(xn.Near, func(i, j int) bool { return xn.Near[i] < xn.Near[j] })
		if n.Container != nil {
			id := int64(n.Container.ID)
			xn.Container = &id
		}
		if n.IsNodeCenter {
			xn.Flags |= 1
		}
		if n.IsTunnel {
			xn.Flags |= 2
		}
		out.Nodes = append(out.Nodes, xn)
	}
	owners := make([]*layoutgraph.Node, 0, len(ovg.Ports))
	for owner := range ovg.Ports {
		owners = append(owners, owner)
	}
	sort.Slice(owners, func(i, j int) bool { return owners[i].ID < owners[j].ID })
	for _, owner := range owners {
		xp := XPorts{Owner: int64(owner.ID), Points: [][2]float64{}}
		for _, p := range ovg.Ports[owner] {
			xp.Points = append(xp.Points, [2]float64{p.X, p.Y})
		}
		out.Ports = append(out.Ports, xp)
	}
	owners = owners[:0]
	for owner := range ovg.Centers {
		owners = append(owners, owner)
	}
	sort.Slice(owners, func(i, j int) bool { return owners[i].ID < owners[j].ID })
	for _, owner := range owners {
		c := ovg.Centers[owner]
		out.Centers = append(out.Centers, XCenter{Owner: int64(owner.ID), P: [2]float64{c.X, c.Y}})
	}
	for _, n := range ovg.NodesInsideBoundingBox {
		out.Inside = append(out.Inside, int64(n.ID))
	}
	return out
}

func xRoute(ovg *OVG, r *Route) XRoute {
	xr := XRoute{Edge: int64(r.GEdge.IDValue()), FromPort: [2]float64{r.FromPort.X, r.FromPort.Y}, ToPort: [2]float64{r.ToPort.X, r.ToPort.Y}}
	for _, n := range r.OVGNodes {
		in := 0.0
		if ovg != nil {
			if occupant, ok := ovg.OccupiedPoints[*n.Point]; ok && occupant == n {
				in = 1
			}
		}
		xr.Nodes = append(xr.Nodes, [3]float64{n.X, n.Y, in})
	}
	return xr
}

func xHookRouteGraph(graph *layoutgraph.Graph) {
	if !XObserve {
		return
	}
	xCall = &XCall{}
	if XSerialize != nil {
		xCall.Graph = XSerialize(graph)
	}
	xCalls = append(xCalls, xCall)
	xSub = nil
}

func xHookSubgraph(sub *layoutgraph.Graph, nearby []*layoutgraph.Node) {
	if !XObserve || xCall == nil {
		return
	}
	xSub = &XSubgraph{}
	for _, n := range sub.Nodes {
		xSub.Nodes = append(xSub.Nodes, int64(n.ID))
	}
	for _, n := range nearby {
		xSub.Nearby = append(xSub.Nearby, int64(n.ID))
	}
	xCall.Subgraphs = append(xCall.Subgraphs, xSub)
}

func xHookOVG(g *layoutgraph.Graph, ovg *OVG, guard *ovgBuildGuard, err error) {
	if !XObserve || xSub == nil {
		return
	}
	if guard != nil {
		xSub.Guard = XGuard{Candidates: guard.candidates, Nodes: guard.nodes, Edges: guard.edges, Work: guard.work}
	}
	if err != nil {
		xSub.OVGErr = err.Error()
		return
	}
	xSub.OVG = xDumpOVG(ovg)
}

func xHookExisting(ovg *OVG, existing []*Route, unrouted []*layoutgraph.Edge) {
	if !XObserve || xSub == nil {
		return
	}
	xSub.Existing = []XRoute{}
	for _, r := range existing {
		xSub.Existing = append(xSub.Existing, xRoute(ovg, r))
	}
	xSub.Unrouted = []int64{}
	for _, e := range unrouted {
		xSub.Unrouted = append(xSub.Unrouted, int64(e.IDValue()))
	}
}

func xHookResponses(ovg *OVG, routers []*ovgEdgeRouter, responses []GenerateRouteResponse, err error) {
	if !XObserve || xSub == nil {
		return
	}
	if err != nil {
		xSub.FlavErr = err.Error()
	}
	xSub.Flavors = []XFlavor{}
	for i, resp := range responses {
		xf := XFlavor{Flavor: string(resp.Flavor), Distance: resp.Distance, Routes: []XRoute{}}
		if resp.Err != nil {
			xf.Err = resp.Err.Error()
		}
		if resp.work != nil {
			xf.Used = resp.work.used
		} else if i < len(routers) && routers[i].work != nil {
			xf.Used = routers[i].work.used
		}
		for _, r := range resp.Routes {
			xf.Routes = append(xf.Routes, xRoute(ovg, r))
		}
		xSub.Flavors = append(xSub.Flavors, xf)
	}
}

func xHookSubgraphDone(sub *layoutgraph.Graph, err error) {
	if !XObserve || xSub == nil {
		return
	}
	if err != nil {
		xSub.Err = err.Error()
	}
	xSub.Final = []XEdgePoints{}
	for _, e := range sub.Edges {
		xe := XEdgePoints{Edge: int64(e.IDValue()), Points: [][2]float64{}}
		for _, p := range e.Points {
			xe.Points = append(xe.Points, [2]float64{p.X, p.Y})
		}
		xSub.Final = append(xSub.Final, xe)
	}
	xSub = nil
}

var _ = fmt.Sprint
var _ context.Context
