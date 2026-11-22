package main

import (
	"context"
	"fmt"
	"math/rand"
	"strconv"

	"github.com/d2lang/d2/d2layouts/d2talalayout/internal/limits"
)

// randOp is one call on a *rand.Rand: {"op": "Int63"|"Uint32"|"Uint64"|"Int31"|"Int"|"Float64"|"Float32"|"Int63n"|"Int31n"|"Intn"|"Perm"|"Shuffle", "n": N}.
type randOp struct {
	Op string `json:"op"`
	N  int64  `json:"n"`
}

// runRand replays a sequence of calls on rand.New(rand.NewSource(seed)) (the generator TALA uses) and returns the results:
// integers as decimal strings (they can exceed 2^53), floats as numbers, Perm/Shuffle as the resulting permutation of 0..n-1.
func runRand(in input) interface{} {
	r := rand.New(rand.NewSource(in.Seed))
	out := make([]interface{}, 0, len(in.Ops))
	for _, op := range in.Ops {
		switch op.Op {
		case "Int63":
			out = append(out, strconv.FormatInt(r.Int63(), 10))
		case "Uint32":
			out = append(out, strconv.FormatUint(uint64(r.Uint32()), 10))
		case "Uint64":
			out = append(out, strconv.FormatUint(r.Uint64(), 10))
		case "Int31":
			out = append(out, strconv.FormatInt(int64(r.Int31()), 10))
		case "Int":
			out = append(out, strconv.FormatInt(int64(r.Int()), 10))
		case "Float64":
			out = append(out, r.Float64())
		case "Float32":
			out = append(out, float64(r.Float32()))
		case "Int63n":
			out = append(out, strconv.FormatInt(r.Int63n(op.N), 10))
		case "Int31n":
			out = append(out, strconv.FormatInt(int64(r.Int31n(int32(op.N))), 10))
		case "Intn":
			out = append(out, strconv.FormatInt(int64(r.Intn(int(op.N))), 10))
		case "Perm":
			out = append(out, r.Perm(int(op.N)))
		case "Shuffle":
			p := make([]int, op.N)
			for i := range p {
				p[i] = i
			}
			r.Shuffle(len(p), func(i, j int) { p[i], p[j] = p[j], p[i] })
			out = append(out, p)
		case "GuardShuffle":
			// limits.Shuffle (TALA's guarded copy of rand.Shuffle) and the guard's work
			p := make([]int, op.N)
			for i := range p {
				p[i] = i
			}
			guard, _ := limits.NewOptimizationWorkGuard(context.Background(), "x", limits.MaxOptimizationWorkUnits)
			err := limits.Shuffle(p, r, guard)
			out = append(out, map[string]interface{}{"perm": p, "used": guard.Used(), "err": errString(err)})
		default:
			return map[string]string{"panic": fmt.Sprintf("unknown rand op %q", op.Op)}
		}
	}
	return map[string]interface{}{"values": out}
}
