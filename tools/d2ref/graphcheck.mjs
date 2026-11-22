// JS side of `graphmethods` mode (tools/d2ref/graphcheck.go): d2graph's read-only methods on every object and edge of a
// compiled graph. Input: any graph-stage corpus.
import { compile as compileGraph } from '../../public/d2/d2compiler.js';

const abs = (o) => (o === null ? null : o.absID());

export function graphMethods(c) {
  const r = compileGraph(c.path, c.text, { utf16: c.utf16 });
  if (r.err) return { err: r.err.message };
  return { boards: boardMethods(r.g) };
}

function boardMethods(g) {
  const b = { ida: g.IDA(), texts: g.texts(), name: g.name };
  if (g.getBoard('a') !== null) b.hasA = true;
  const objs = [];
  for (const o of g.objects || []) {
    const [margin, padding] = o.spacing();
    const [margin2, padding2] = o.spacingOpt(3, 4, true);
    const [dx, dy] = o.getModifierElementAdjustments();
    objs.push({
      absID: o.absID(), absIDArray: o.absIDArray(), level: o.level(), fill: o.getFill(), stroke0: o.getStroke(0), strokeN: o.getStroke(null),
      text: o.text(), hasLabel: o.hasLabel(), hasIcon: o.hasIcon(), hasOutsideBottomLabel: o.hasOutsideBottomLabel(), isContainer: o.isContainer(),
      isSeq: o.isSequenceDiagram(), isGroup: o.isSequenceDiagramGroup(), isNote: o.isSequenceDiagramNote(), outerSeq: abs(o.outerSequenceDiagram()),
      isGrid: o.isGridDiagram(), closestGrid: abs(o.closestGridDiagram()), closestCell: abs(o.closestGridCell()), topGrid: abs(o.topGridDiagram()),
      outerNear: abs(o.outerNearContainer()), isConstNear: o.isConstantNear(), isMultiple: o.isMultiple(), is3D: o.is3D(),
      margin, padding, margin2, padding2, hasEdgeRef: o.isSequenceDiagramNote(),
      modifier: [dx, dy], fillParent: null,
    });
  }
  b.objects = objs.length ? objs : null;
  const edges = [];
  for (const e of g.edges || []) {
    edges.push({ absID: e.absID(), text: e.text(), arrow: e.arrowString(), group: abs(e.getGroup()), stroke0: e.getStroke(0), strokeN: e.getStroke(null), ast: e.getAstEdge().range.toString() });
  }
  b.edges = edges.length ? edges : null;
  const out = [b];
  for (const l of g.layers || []) out.push(...boardMethods(l));
  for (const l of g.scenarios || []) out.push(...boardMethods(l));
  for (const l of g.steps || []) out.push(...boardMethods(l));
  return out;
}
