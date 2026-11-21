package main

// lgops mode: exercises the layoutgraph API on a graph and prints what it computed, for the JS port (public/d2/tala/layoutgraph.js) to
// be diffed against. Input {"graph": <graphjson>, "ops": [names]} (all ops if omitted). Geometry ops need a positioned graph and print
// {"skipped": true} otherwise. The JS twin is `opsStage` in tools/d2ref/talacheck.mjs: keep both in step.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/graphjson"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/layoutgraph"
	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/limits"
	"github.com/d2lang/d2/lib/geo"
	"github.com/d2lang/d2/lib/label"
)

type pt struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

func p2(p *geo.Point) interface{} {
	if p == nil {
		return nil
	}
	return pt{p.X, p.Y}
}

func pv(p geo.Point) pt { return pt{p.X, p.Y} }

func ids(nodes []*layoutgraph.Node) []int64 {
	out := make([]int64, len(nodes))
	for i, n := range nodes {
		out[i] = n.IDValue()
	}
	return out
}

func sortedIDs(nodes []*layoutgraph.Node) []int64 {
	out := ids(nodes)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func nodeID(n *layoutgraph.Node) int64 {
	if n == nil {
		return 0
	}
	return n.IDValue()
}

func spacing(s layoutgraph.Spacing) []float64 {
	return []float64{s.Top(), s.Bottom(), s.Left(), s.Right()}
}

func errStr(err error) interface{} {
	if err == nil {
		return nil
	}
	return err.Error()
}

func serialized(ctx context.Context, g *layoutgraph.Graph) interface{} {
	s, err := graphjson.Serialize(ctx, g)
	if err != nil {
		return map[string]string{"serializeError": err.Error()}
	}
	return s
}

func positioned(g *layoutgraph.Graph) bool {
	for _, n := range g.Nodes {
		if n.TopLeft == nil {
			return false
		}
	}
	return len(g.Nodes) > 0
}

func hasEveryRoute(g *layoutgraph.Graph) bool {
	for _, e := range g.Edges {
		if len(e.Points) < 2 {
			return false
		}
	}
	return true
}

var allOrientations = []geo.Orientation{geo.Top, geo.Right, geo.Bottom, geo.Left, geo.TopLeft, geo.TopRight, geo.BottomLeft, geo.BottomRight, geo.NONE}

func runOps(in input) (res interface{}) {
	ctx := context.Background()
	g := layoutgraph.NewGraph()
	if err := graphjson.Unmarshal(ctx, in.Graph, g); err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	var want []string
	if len(in.Args) > 0 {
		json.Unmarshal(in.Args, &want)
	}
	if len(want) == 0 {
		want = []string{"orders", "validate", "clone", "geometry", "pairs", "edges", "split", "abduct", "transactions", "nodes"}
	}
	out := map[string]interface{}{}
	for _, op := range want {
		func() {
			defer func() {
				if r := recover(); r != nil {
					out[op] = map[string]string{"panic": fmt.Sprint(r)}
				}
			}()
			switch op {
			case "orders":
				out[op] = opOrders(ctx, g)
			case "validate":
				out[op] = map[string]interface{}{
					"graph":      errStr(layoutgraph.Validate(ctx, "x", g)),
					"positioned": errStr(layoutgraph.ValidatePositionedGraph(ctx, "x", g)),
				}
			case "clone":
				out[op] = opClone(ctx, g)
			case "geometry":
				if !positioned(g) {
					out[op] = map[string]bool{"skipped": true}
				} else {
					out[op] = opGeometry(g)
				}
			case "pairs":
				if !positioned(g) {
					out[op] = map[string]bool{"skipped": true}
				} else {
					out[op] = opPairs(g)
				}
			case "edges":
				if !positioned(g) {
					out[op] = map[string]bool{"skipped": true}
				} else {
					out[op] = opEdges(g)
				}
			case "split":
				out[op] = opSplit(ctx, g)
			case "abduct":
				out[op] = opAbduct(ctx, g)
			case "transactions":
				if !positioned(g) {
					out[op] = map[string]bool{"skipped": true}
				} else {
					out[op] = opTransactions(ctx, g)
				}
			case "nodes":
				if !positioned(g) {
					out[op] = map[string]bool{"skipped": true}
				} else {
					out[op] = opNodes(g)
				}
			}
		}()
	}
	return out
}

func opOrders(ctx context.Context, g *layoutgraph.Graph) interface{} {
	guard, _ := limits.NewWorkGuard(ctx, "x", limits.MaxEngineWorkUnits)
	rdfs, err := g.ContainerRDFSOrder(nil, guard)
	desc := []interface{}{}
	for i, n := range g.Nodes {
		if i >= 40 {
			break
		}
		desc = append(desc, map[string]interface{}{
			"id":      n.IDValue(),
			"withAll": ids(g.AllDescendantNodes(n, true)),
			"without": ids(g.AllDescendantNodes(n, false)),
			"nears":   ids(n.OrderedNears()),
		})
	}
	return map[string]interface{}{
		"cluster":    ids(g.ClusterOrder()),
		"clusterRDFS": ids(g.ClusterRDFSOrder()),
		"tree":       ids(g.TreeOrder()),
		"sequence":   ids(g.SequenceOrder()),
		"hub":        ids(g.HubOrder()),
		"containerRDFS": ids(rdfs),
		"containerRDFSErr": errStr(err),
		"unbounded":  ids(g.ContainerRDFSOrderUnbounded(nil)),
		"descendants": desc,
		"treeEdges":  len(g.TreeEdgeMap()),
		"fixed":      ids(g.FixedNodes()),
		"hasFixed":   g.HasFixedNode(),
	}
}

func opClone(ctx context.Context, g *layoutgraph.Graph) interface{} {
	c, err := layoutgraph.Clone(ctx, g)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	fixed := []bool{}
	for _, n := range c.Nodes {
		fixed = append(fixed, n.Label != nil && n.Label.PositionFixed(), n.Icon != nil && n.Icon.PositionFixed())
	}
	// the clone shares nothing with the source: moving a clone node must not move the source node
	return map[string]interface{}{"graph": serialized(ctx, c), "fixedFlags": fixed, "nodeCount": len(c.Nodes), "edgeCount": len(c.Edges)}
}

func opGeometry(g *layoutgraph.Graph) interface{} {
	out := map[string]interface{}{}
	tl, br := g.BoundingBox()
	out["bounds"] = []interface{}{p2(tl), p2(br)}
	out["area"] = g.Area()
	g.ComputeCellSize()
	out["cellSize"] = g.CellSize
	out["turnCost"] = g.TurnCost()
	out["crossingCost"] = g.CrossingCost()
	out["nonCenterPortCost"] = g.NonCenterPortCost()
	nodes := layoutgraph.Nodes(g.Nodes)
	ftl, fbr := nodes.FixedBoundingBox()
	out["fixedBounds"] = []interface{}{p2(ftl), p2(fbr)}
	ctl, cbr := nodes.BoundingBox()
	out["nodesBounds"] = []interface{}{p2(ctl), p2(cbr)}
	out["center"] = p2(nodes.Center())
	out["adjacent"] = nodes.NumAdjacent()
	out["clusters60"] = clusterIDs(nodes.DistanceClusters(60))
	per := []interface{}{}
	for _, n := range g.Nodes {
		o := map[string]interface{}{"id": n.IDValue()}
		btl, bbr := n.BoundingBox(nodes)
		o["boundingBox"] = []interface{}{p2(btl), p2(bbr)}
		btl, bbr = n.BoundingBox(nil)
		o["boundingBoxNoSiblings"] = []interface{}{p2(btl), p2(bbr)}
		ports := []pt{}
		for _, p := range n.Ports() {
			ports = append(ports, pv(p))
		}
		o["ports"] = ports
		cp := []pt{}
		for _, p := range n.CenterPorts() {
			cp = append(cp, pv(p))
		}
		o["centerPorts"] = cp
		mir := [][]pt{}
		for from, to := range n.MirroredPorts() {
			mir = append(mir, []pt{pv(from), pv(to)})
		}
		sort.Slice(mir, func(i, j int) bool {
			if mir[i][0].X != mir[j][0].X {
				return mir[i][0].X < mir[j][0].X
			}
			return mir[i][0].Y < mir[j][0].Y
		})
		o["mirrored"] = mir
		byO := map[string][]pt{}
		for _, ori := range allOrientations {
			list := []pt{}
			for _, p := range safePorts(n, ori) {
				list = append(list, pv(p))
			}
			byO[fmt.Sprint(int(ori))] = list
		}
		o["portsByOrientation"] = byO
		o["isContainer"] = n.IsContainer()
		if n.IsContainer() {
			o["padding"] = spacing(g.ContainerPadding(n, false))
			o["paddingChildren"] = spacing(g.ContainerPadding(n, true))
		}
		o["level"] = n.Level()
		o["containerLevel"] = n.ContainerLevel()
		o["innerBox"] = []interface{}{p2(n.InnerBox().TopLeft), n.InnerBox().Width, n.InnerBox().Height}
		o["insidePlacement"] = pv(n.InsidePlacement(50, 30, layoutgraph.UniformSpacing(10)))
		o["canContain"] = n.CanContain()
		dx, dy := n.ModifierElementAdjustments()
		o["modifier"] = []float64{dx, dy}
		o["fixedOrigin"] = p2(n.FixedOrigin())
		o["hasLeakyEdge"] = n.HasLeakyEdge()
		o["isMajorityTarget"] = n.IsMajorityTarget()
		o["center"] = p2(n.Center())
		o["iconSizes"] = []float64{n.IconSize(label.InsideMiddleCenter), n.IconSize(label.OutsideTopLeft), n.IconSize(label.InsideTopLeft)}
		o["containerDirection"] = int(n.ContainerDirection())
		if n.Label != nil {
			o["labelTopLeft"] = p2(n.LabelTopLeft(n.Label.Position, n.Label.Width, n.Label.Height))
			o["labelTopLeftOutside"] = p2(n.LabelTopLeft(label.OutsideTopCenter, n.Label.Width, n.Label.Height))
		}
		o["shape"] = n.ShapeType()
		per = append(per, o)
	}
	out["nodes"] = per
	return out
}

func safePorts(n *layoutgraph.Node, ori geo.Orientation) (ports []geo.Point) {
	defer func() { recover() }()
	return n.PortsByOrientation(ori)
}

func clusterIDs(clusters [][]*layoutgraph.Node) [][]int64 {
	out := [][]int64{}
	for _, c := range clusters {
		out = append(out, ids(c))
	}
	return out
}

func opPairs(g *layoutgraph.Graph) interface{} {
	out := []interface{}{}
	limit := len(g.Nodes)
	if limit > 36 {
		limit = 36
	}
	for i := 0; i < limit; i++ {
		for j := 0; j < limit; j++ {
			if i == j {
				continue
			}
			a, b := g.Nodes[i], g.Nodes[j]
			o := map[string]interface{}{"a": a.IDValue(), "b": b.IDValue()}
			o["deltaTo"] = a.DeltaTo(b, a.TopLeft)
			o["doesOverlap"] = a.DoesOverlap(b)
			o["doesOverlapExact"] = a.DoesOverlapExact(b)
			o["doesOverlapAt"] = a.DoesOverlapAt(b, geo.NewPoint(a.TopLeft.X+30, a.TopLeft.Y-12))
			o["orientation"] = int(a.Orientation(b))
			o["distanceTo"] = []float64{a.DistanceTo(b, true), a.DistanceTo(b, false)}
			o["isAdjacentTo"] = []bool{a.IsAdjacentTo(b, true), a.IsAdjacentTo(b, false)}
			o["overlapsAlong"] = []bool{a.OverlapsAlongDimension(b, true, true), a.OverlapsAlongDimension(b, false, true), a.OverlapsAlongDimension(b, true, false), a.OverlapsAlongDimension(b, false, false)}
			o["visibility"] = []bool{a.VisibilityGraphCandidate(true, true, true, b, 20), a.VisibilityGraphCandidate(false, false, true, b, 20), a.VisibilityGraphCandidate(true, false, false, b, 20)}
			o["sharedAncestor"] = nodeID(a.NearestSharedAncestor(b))
			o["isDescendantOf"] = a.IsDescendantOf(b)
			o["spillsOutOf"] = a.SpillsOutOf(b)
			ox, oy := a.OrthogonalDistanceTo(b)
			o["orthogonal"] = []float64{ox, oy}
			ac, bc := a.Center(), b.Center()
			o["passesThrough"] = []bool{b.PassesThrough(ac, bc), b.PassesThrough(geo.NewPoint(a.TopLeft.X, a.TopLeft.Y), geo.NewPoint(bc.X, bc.Y))}
			o["overlapsLine"] = b.OverlapsLine(ac, geo.NewPoint(bc.X, bc.Y), 10)
			o["isBlocked"] = []bool{a.IsBlocked(b, a, true, true), a.IsBlocked(b, a, false, false)}
			o["covers"] = a.Covers(b)
			o["surrounds"] = a.Surrounds(b, 5)
			o["contains"] = a.ContainsPoint(bc, 3)
			o["isWithin"] = a.IsWithinBounds(b.TopLeft, geo.NewPoint(b.TopLeft.X+b.Width, b.TopLeft.Y+b.Height))
			o["near"] = a.IsPointNear(bc)
			o["onBox"] = a.ContainsPointOnBox(bc)
			if a.OverlapsAlongDimension(b, true, true) || a.DoesOverlap(b) {
				o["overlapArea"] = nil
			} else {
				o["overlapArea"] = nil
			}
			o["connection"] = connID(a.ConnectionTo(b))
			o["nodeOverlapCount"] = a.NodeOverlapCount(g.Nodes, 15)
			o["overlappingPorts"] = overlapCount(a, b)
			out = append(out, o)
		}
	}
	return out
}

func connID(e *layoutgraph.Edge) int64 {
	if e == nil {
		return 0
	}
	return e.IDValue()
}

func overlapCount(a, b *layoutgraph.Node) interface{} {
	m := a.OverlappingPorts(b)
	list := []pt{}
	for p := range m {
		list = append(list, pv(p))
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].X != list[j].X {
			return list[i].X < list[j].X
		}
		return list[i].Y < list[j].Y
	})
	return list
}

func opEdges(g *layoutgraph.Graph) interface{} {
	out := []interface{}{}
	routed := hasEveryRoute(g)
	for _, e := range g.Edges {
		o := map[string]interface{}{"id": e.IDValue()}
		o["debugID"] = e.DebugID()
		o["isDirected"] = e.IsDirected()
		o["isBidirectional"] = e.IsBidirectional()
		o["isUndirected"] = e.IsUndirected()
		o["isLoop"] = e.IsLoop()
		o["hasSourceArrow"] = e.HasSourceArrow()
		o["hasTargetArrow"] = e.HasTargetArrow()
		o["largeLabel"] = e.HasLargeArrowheadLabel()
		o["hasTableColumn"] = e.HasTableColumn()
		o["isBetweenTableColumns"] = e.IsBetweenTableColumns()
		o["isClusterEdge"] = e.IsClusterEdge()
		o["axisAligned"] = e.IsAxisAligned()
		o["euclidean"] = e.EuclideanDistance()
		o["isTreeEdge"] = e.IsTreeEdge()
		from, to, hasFrom, hasTo, ori := e.FacingTablePortValues(nil, nil)
		o["facing"] = []interface{}{pv(from), pv(to), hasFrom, hasTo, int(ori)}
		etl, ebr := e.BoundingBoxValues()
		o["boundingBoxValues"] = []interface{}{pv(etl), pv(ebr)}
		o["length"] = e.Length()
		if len(e.Points) >= 2 {
			o["straight"] = e.IsStraight()
			o["segments"] = e.NumSegments()
		}
		if routed {
			o["overlappingEnd"] = e.HasOverlappingEnd()
		}
		if e.Label != nil && len(e.Points) >= 2 {
			o["labelTopLeft"] = p2(e.LabelTopLeft(label.UnlockedTop, e.Label.Width, e.Label.Height))
			o["labelTopLeftOutside"] = p2(e.LabelTopLeft(label.OutsideTopCenter, e.Label.Width, e.Label.Height))
		}
		out = append(out, o)
	}
	if routed {
		segs := []layoutgraph.CrossingSegment{}
		for _, e := range g.Edges {
			for i := 0; i+1 < len(e.Points); i++ {
				segs = append(segs, layoutgraph.CrossingSegment{Start: *e.Points[i], End: *e.Points[i+1]})
			}
		}
		n, err := layoutgraph.CountSegmentCrossingsContext(context.Background(), segs)
		return map[string]interface{}{"edges": out, "crossings": n, "crossingsErr": errStr(err), "crossingsPlain": layoutgraph.CountSegmentCrossings(segs)}
	}
	return map[string]interface{}{"edges": out}
}

func opSplit(ctx context.Context, g *layoutgraph.Graph) interface{} {
	out := []interface{}{}
	for mask := 0; mask < 8; mask++ {
		opts := layoutgraph.SplitOptions{IncludeContainers: mask&1 != 0, IncludeNears: mask&2 != 0, TraverseTrees: mask&4 != 0}
		before := serialized(ctx, g)
		graphs, journal, err := g.SplitSubgraphsTracked(ctx, opts, nil)
		o := map[string]interface{}{"mask": mask, "err": errStr(err)}
		if err == nil {
			list := []interface{}{}
			for _, sg := range graphs {
				edges := []int64{}
				for _, e := range sg.Edges {
					edges = append(edges, e.IDValue())
				}
				list = append(list, map[string]interface{}{"nodes": ids(sg.Nodes), "edges": edges})
			}
			o["graphs"] = list
			journal.Restore()
		}
		after := serialized(ctx, g)
		b1, _ := json.Marshal(before)
		b2, _ := json.Marshal(after)
		o["restored"] = string(b1) == string(b2)
		out = append(out, o)
	}
	return out
}

func opAbduct(ctx context.Context, g *layoutgraph.Graph) interface{} {
	out := []interface{}{}
	containers := []*layoutgraph.Node{nil}
	for _, n := range g.Nodes {
		if n.IsContainer() {
			containers = append(containers, n)
		}
	}
	for _, c := range containers {
		cl, err := layoutgraph.Clone(ctx, g)
		if err != nil {
			return map[string]interface{}{"err": err.Error()}
		}
		var container *layoutgraph.Node
		if c != nil {
			for _, n := range cl.Nodes {
				if n.IDValue() == c.IDValue() {
					container = n
				}
			}
		}
		to := layoutgraph.NewGraph()
		before := serialized(ctx, cl)
		abductions := cl.AbductEdges(container, to)
		list := []interface{}{}
		for _, a := range abductions {
			list = append(list, []int64{a.Edge.IDValue(), nodeID(a.OriginallyFrom), nodeID(a.OriginallyTo), nodeID(a.CurrentFrom), nodeID(a.CurrentTo)})
		}
		toEdges := []int64{}
		for _, e := range to.Edges {
			toEdges = append(toEdges, e.IDValue())
		}
		mid := serialized(ctx, cl)
		remaining := cl.RestoreEdgeAbductions(abductions)
		after := serialized(ctx, cl)
		b1, _ := json.Marshal(before)
		b2, _ := json.Marshal(after)
		m1, _ := json.Marshal(mid)
		out = append(out, map[string]interface{}{"container": nodeID(c), "abductions": list, "toEdges": toEdges, "remaining": len(remaining), "restored": string(b1) == string(b2), "changed": string(b1) != string(m1), "mid": mid})
	}
	return out
}

func opTransactions(ctx context.Context, g *layoutgraph.Graph) interface{} {
	out := []interface{}{}
	cl, err := layoutgraph.Clone(ctx, g)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	moves := [][2]float64{{10, 0}, {0, -25}, {200, 40}, {-60, -60}, {5000, 0}}
	for i, n := range cl.Nodes {
		if i >= 24 {
			break
		}
		if n.TopLeft == nil {
			continue
		}
		for mi, mv := range moves {
			if (i+mi)%2 == 1 {
				continue
			}
			before := serialized(ctx, cl)
			tx, err := cl.NewRequestTransaction(ctx, layoutgraph.TransactionOptions{AffectContainers: mi%2 == 0})
			if err != nil {
				out = append(out, map[string]interface{}{"i": i, "new": err.Error()})
				continue
			}
			node, dx, dy := n, mv[0], mv[1]
			tx.AddOp(func() error { node.MoveWithChildren(dx, dy); return nil })
			cerr := tx.Commit(ctx)
			o := map[string]interface{}{"i": i, "move": mi, "id": n.IDValue(), "commit": errStr(cerr), "invalid": layoutgraph.IsCandidateRejection(cerr)}
			if cerr != nil {
				after := serialized(ctx, cl)
				b1, _ := json.Marshal(before)
				b2, _ := json.Marshal(after)
				o["rolledBack"] = string(b1) == string(b2)
			} else {
				o["updated"] = errStr(tx.UpdateState())
				// move it back through a second transaction on the same object and roll back explicitly
				tx2, _ := cl.NewRequestTransaction(ctx, layoutgraph.TransactionOptions{})
				tx2.AddOp(func() error { node.MoveWithChildren(-dx, -dy); return nil })
				_ = tx2.Commit(ctx)
				tx2.Rollback()
				o["afterRollback"] = []interface{}{p2(n.TopLeft)}
			}
			out = append(out, o)
		}
	}
	final := serialized(ctx, cl)
	return map[string]interface{}{"steps": out, "final": final}
}

func opNodes(g *layoutgraph.Graph) interface{} {
	out := map[string]interface{}{}
	nodes := layoutgraph.Nodes(g.Nodes)
	for _, t := range []float64{20, 60, 150, 400, 1000} {
		out[fmt.Sprint(t)] = clusterIDs(nodes.DistanceClusters(t))
	}
	conn := []interface{}{}
	for i, n := range g.Nodes {
		if i >= 20 {
			break
		}
		conn = append(conn, map[string]interface{}{"id": n.IDValue(), "set": sortedIDs(n.ConnectedNodeSet(nil, g)), "nodes": sortedIDs(n.ConnectedNodes(nil, g))})
	}
	out["connected"] = conn
	_ = math.Pi
	return out
}
