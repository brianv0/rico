package engine

// XFlags reports the routing state flags (forceReroute, edgeRoutingComplete) of the pipeline of the running XLayoutObserved. The
// routing stage checks (xdump/routestage_xdump.go) read it from the stage observer to learn the inputs of the second EdgeRouting stage.
var XFlags func() (forceReroute bool, edgeRoutingComplete bool)
