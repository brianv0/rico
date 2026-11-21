// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2compiler package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.): compile.go.
// Parses a D2 source, resolves it to the IR (d2ir.js) and builds the graph (d2graph.js) and the `d2-config` variables.
//
// Same algorithm, same names (camelCase), same error messages. Conventions as in d2ir.js and d2graph.js. The compile
// function returns `{ g, config, err }`; err is a ParseError (parser.js) whose `.message` is Go's err.Error().
//
// Rendered Markdown (block strings tagged md, tooltips) is validated the way Go does it, with xml.Unmarshal (xml.js); the
// caller has to register markdown-it first: `setMarkdownIt(markdownit)` from textmeasure.js.
//
// The unused `preprocessSeqDiagrams` family of compile.go is not ported (Go does not call it either).

import {
  AstError, boxKind, unbox, scalarString, flatUnquotedString, box, makeRange,
  ReservedKeywords, SimpleReservedKeywords, StyleKeywords, BoardKeywords, LabelPositions, TooltipPositions,
  NearConstants, NearConstantsArray, equalFold, goLower, isSpace,
} from './ast.js';
import { format } from './format.js';
import { ParseError, parse as parseD2, parseKey } from './parser.js';
import * as d2ir from './d2ir.js';
import * as d2graph from './d2graph.js';
import * as d2target from './target.js';
import * as color from './color.js';
import * as geo from './geo.js';
import { renderMarkdown } from './textmeasure.js';
import { parse as urlParse, parseRequestURI as urlParseRequestURI } from './url.js';
import { unescapeString as htmlUnescapeString } from './gohtml.js';
import { unmarshalInterface } from './xml.js';
import { atoi as strconvAtoi, parseBool as strconvParseBool, parseFloat64 } from './strconv.js';
import { sprintf, GoRange } from './gofmt.js';

const ss = scalarString;
const isUnquoted = (b) => !!b.unquoted_string;
const lc = goLower;
const flat = (s) => box('unquoted_string', flatUnquotedString(s)); // d2ast.FlatUnquotedString as a string box
const append = (a, ...items) => (a ? [...a, ...items] : items);
const goTrimSpace = (s) => { let a = 0, b = s.length; while (a < b && isSpace(s[a])) a++; while (b > a && isSpace(s[b - 1])) b--; return s.slice(a, b); };

/**
 * Compile parses, compiles to the IR and to the graph.
 * @param {string} p path of the file
 * @param {string} text the source
 * @param {{utf16?: boolean, fs?: object}} [opts] fs maps paths to file texts, for imports (d2ir.js)
 * @returns {{g: d2graph.Graph|null, config: d2target.Config|null, err: ParseError|null}}
 */
export function compile(p, text, opts) {
  opts = opts || {};

  const { ast, err } = parseD2(p, text, { utf16: !!opts.utf16 });
  if (err) return { g: null, config: null, err };

  const r = d2ir.compile(ast, { utf16: !!opts.utf16, fs: opts.fs });
  if (r.err) return { g: null, config: null, err: r.err };
  const ir = r.m;

  const { g, err: err2 } = compileIR(ast, ir);
  if (err2) return { g: null, config: null, err: err2 };
  g.fs = opts.fs ?? null;
  g.sortObjectsByAST();
  g.sortEdgesByAST();
  const { config, err: err3 } = compileConfig(ir);
  if (err3) return { g: null, config: null, err: err3 };
  return { g, config, err: null };
}

function compileIR(ast, m) {
  const c = new Compiler();

  const g = d2graph.newGraph();
  g.ast = ast;
  g.baseAST = ast;
  c.compileBoard(g, m);
  if (c.err.errs.length > 0) return { g: null, err: c.err };
  c.validateBoardLinks(g);
  if (c.err.errs.length > 0) return { g: null, err: c.err };
  return { g, err: null };
}

class Compiler {
  constructor() {
    this.err = new ParseError();
    this.errorsLookup = null;
  }

  compileBoard(g, ir) {
    ir = ir.copy(null);
    // c.preprocessSeqDiagrams(ir)
    this.compileMap(g.root, ir);
    this.setDefaultShapes(g);
    if (this.err.errs.length === 0) this.validateKeys(g.root, ir);
    this.validateLabels(g);
    this.validateNear(g);
    this.validateEdges(g);
    this.validatePositionsCompatibility(g);

    this.compileLegend(g, ir);

    this.compileBoardsField(g, ir, 'layers');
    this.compileBoardsField(g, ir, 'scenarios');
    this.compileBoardsField(g, ir, 'steps');
    if (d2ir.copyBase(d2ir.parentMap(ir), null).equal(d2ir.copyBase(ir, null))) {
      if ((g.layers || []).length > 0 || (g.scenarios || []).length > 0 || (g.steps || []).length > 0) g.isFolderOnly = true;
    }
    if ((g.objects || []).length === 0) g.isFolderOnly = true;
    return g;
  }

  compileLegend(g, m) {
    const varsField = m.getField(flat('vars'));
    if (varsField === null || varsField.map() === null) return;

    const legendField = varsField.map().getField(flat('d2-legend'));
    if (legendField === null || legendField.map() === null) return;

    const legendGraph = d2graph.newGraph();

    this.compileMap(legendGraph.root, legendField.map());
    this.setDefaultShapes(legendGraph);

    const objects = [];
    for (const obj of legendGraph.objects || []) {
      if (obj.attributes.style.opacity !== null) {
        const [opacity, err] = parseFloat64(obj.attributes.style.opacity.value);
        if (err === null && opacity === 0) continue;
      }
      obj.box = new geo.Box(null, 0, 0);
      obj.box.TopLeft = geo.newPoint(10, 10);
      obj.box.Width = 100;
      obj.box.Height = 100;
      objects.push(obj);
    }

    for (const edge of legendGraph.edges || []) {
      edge.route = [geo.newPoint(10, 10), geo.newPoint(110, 10)];
    }

    const legend = new d2graph.Legend();
    legend.objects = objects;
    legend.edges = legendGraph.edges;

    if (legendField.primary() !== null && legendField.primary().value !== null) legend.label = ss(legendField.primary().value);

    if (legend.objects.length > 0 || (legend.edges || []).length > 0) g.legend = legend;
  }

  compileBoardsField(g, ir, fieldName) {
    const boards = ir.getField(flat(fieldName));
    if (boards === null || boards.map() === null) return;
    for (const f of boards.map().fields || []) {
      let m = f.map();
      if (f.map() === null) m = new d2ir.IRMap();
      if (g.getBoard(ss(f.name)) !== null) {
        this.errorf(f.references[0].ast(), 'board name %v already used by another board', ss(f.name));
        continue;
      }
      const g2 = d2graph.newGraph();
      g2.parent = g;
      g2.ast = m.ast().map;
      if (g.baseAST !== null) g2.baseAST = findFieldAST(g.baseAST, f);
      this.compileBoard(g2, m);
      if (f.primary() !== null) this.compileLabel(g2.root.attributes, f);
      g2.name = ss(f.name);
      switch (fieldName) {
        case 'layers': g.layers = append(g.layers, g2); break;
        case 'scenarios': g.scenarios = append(g.scenarios, g2); break;
        case 'steps': g.steps = append(g.steps, g2); break;
      }
    }
  }

  /** errorf records an error for the AST node n (a node or a box); the same error is recorded once. */
  errorf(n, f, ...v) {
    const nn = n.range ? n : unbox(n);
    const msg = sprintf('%v: ' + f, new GoRange(nn.range), ...v);
    const err = new AstError(nn.range, msg);
    if (this.errorsLookup === null) this.errorsLookup = new Set();
    const k = `${nn.range.toJSON()}\u0000${msg}`;
    if (!this.errorsLookup.has(k)) {
      this.err.errs.push(err);
      this.errorsLookup.add(k);
    }
  }

  compileMap(obj, m) {
    const class_ = m.getField(flat('class'));
    if (class_ !== null) {
      let classNames = null;
      if (class_.primary() !== null) classNames = append(classNames, class_.primary().toString());
      else if (class_.composite !== null) {
        if (class_.composite instanceof d2ir.IRArray) {
          for (const c of class_.composite.values || []) {
            if (c instanceof d2ir.Scalar) classNames = append(classNames, ss(c.value));
            else this.errorf(c.lastPrimaryKey(), 'invalid value in array');
          }
        }
      }

      for (const className of classNames || []) {
        const classMap = m.getClassMap(className);
        if (classMap !== null) this.compileMap(obj, classMap);
        else if (className.includes(',')) {
          const split = className.split(',');
          let allFound = true;
          for (let maybeClassName of split) {
            maybeClassName = goTrimSpace(maybeClassName);
            if (m.getClassMap(maybeClassName) === null) {
              allFound = false;
              break;
            }
          }
          if (allFound) this.errorf(class_.lastRef().ast(), 'class "%s" not found. Did you mean to use ";" to separate array items?', className);
        }
      }
    }
    const shape = m.getField(flat('shape'));
    if (shape !== null) {
      if (shape.composite !== null) this.errorf(shape.lastPrimaryKey(), 'reserved field shape does not accept composite');
      else this.compileField(obj, shape);
    }
    for (const f of m.fields || []) {
      if (ss(f.name) === 'shape' && isUnquoted(f.name)) continue;
      if (BoardKeywords.has(ss(f.name)) && isUnquoted(f.name)) continue;
      this.compileField(obj, f);
    }

    if (!m.isClass()) {
      switch (obj.attributes.shape.value) {
        case d2target.ShapeClass:
          this.compileClass(obj);
          break;
        case d2target.ShapeSQLTable:
          this.compileSQLTable(obj);
          break;
      }

      for (const e of m.edges || []) this.compileEdge(obj, e);
    }
  }

  compileField(obj, f) {
    const keyword = lc(ss(f.name));
    const isStyleReserved = StyleKeywords.has(keyword);
    if (isStyleReserved && isUnquoted(f.name)) {
      this.errorf(f.lastRef().ast(), '%v must be style.%v', ss(f.name), ss(f.name));
      return;
    }
    let isReserved = SimpleReservedKeywords.has(keyword);
    isReserved = isReserved && isUnquoted(f.name);
    if (ss(f.name) === 'classes' && isUnquoted(f.name)) {
      if (f.map() !== null) {
        if ((f.map().edges || []).length > 0) this.errorf(f.map().edges[0].lastRef().ast(), 'classes cannot contain an edge');
        for (const classesField of f.map().fields || []) {
          if (classesField.map() === null) continue;
          for (const cf of classesField.map().fields || []) {
            if (!(ReservedKeywords.has(ss(cf.name)) && isUnquoted(f.name))) this.errorf(cf.lastRef().ast(), '%s is an invalid class field, must be reserved keyword', ss(cf.name));
            if (ss(cf.name) === 'class' && isUnquoted(cf.name)) this.errorf(cf.lastRef().ast(), '"class" cannot appear within "classes"');
          }
        }
      }
      return;
    } else if (ss(f.name) === 'vars' && isUnquoted(f.name)) {
      return;
    } else if ((ss(f.name) === 'source-arrowhead' || ss(f.name) === 'target-arrowhead') && isUnquoted(f.name)) {
      this.errorf(f.lastRef().ast(), '%#v can only be used on connections', ss(f.name));
      return;
    } else if (isReserved) {
      this.compileReserved(obj.attributes, f);
      return;
    } else if (ss(f.name) === 'style' && isUnquoted(f.name)) {
      if (f.map() === null || (f.map().fields || []).length === 0) {
        this.errorf(f.lastRef().ast(), '"style" expected to be set to a map of key-values, or contain an additional keyword like "style.opacity: 0.4"');
        return;
      }
      this.compileStyle(obj.attributes.style, f.map());
      return;
    }

    if (obj.parent !== null) {
      if (equalFold(obj.parent.attributes.shape.value, d2target.ShapeSQLTable)) {
        this.errorf(f.lastRef().ast(), 'sql_table columns cannot have children');
        return;
      }
      if (equalFold(obj.parent.attributes.shape.value, d2target.ShapeClass)) {
        this.errorf(f.lastRef().ast(), 'class fields cannot have children');
        return;
      }
    }

    const parent = obj;
    obj = obj.ensureChild([f.name]);
    if (f.primary() !== null) this.compileLabel(obj.attributes, f);
    if (f.map() !== null) this.compileMap(obj, f.map());

    if (obj.attributes.label.mapKey === null) obj.attributes.label.mapKey = f.lastPrimaryKey();
    for (const fr of f.references || []) {
      if (fr.primary()) {
        if (fr.context_.key.value.map) obj.map = fr.context_.key.value.map;
      }
      const r = new d2graph.Reference();
      r.key = fr.keyPath;
      r.keyPathIndex = fr.keyPathIndex();

      r.mapKey = fr.context_.key;
      r.mapKeyEdgeIndex = fr.context_.edgeIndex();
      r.scope = fr.context_.scope;
      r.scopeAST = fr.context_.scopeAST;
      r.scopeObj = parent;
      r.isVar = d2ir.isVar(fr.context_.scopeMap);
      if (fr.context_.scopeMap !== null && !d2ir.isVar(fr.context_.scopeMap)) {
        const scopeObjIDA = d2ir.BoardIDA(fr.context_.scopeMap);
        r.scopeObj = obj.graph.root.ensureChild(scopeObjIDA);
      }
      obj.references = append(obj.references, r);
    }
  }

  /** f is a d2ir Field or Edge */
  compileLabel(attrs, f) {
    const scalar = f.primary().value;
    switch (boxKind(scalar)) {
      case 'block_string': {
        const bs = unbox(scalar);
        if (goTrimSpace(ss(scalar)) === '') this.errorf(f.lastPrimaryKey(), 'block string cannot be empty');
        attrs.language = bs.tag;
        const fullTag = Object.prototype.hasOwnProperty.call(ShortToFullLanguageAliases, bs.tag) ? ShortToFullLanguageAliases[bs.tag] : undefined;
        if (fullTag !== undefined) attrs.language = fullTag;
        switch (attrs.language) {
          case 'markdown':
            this.validateMarkdown(ss(scalar), f);
            break;
        }
        attrs.label.value = ss(scalar);
        break;
      }
      default:
        attrs.label.value = ss(scalar);
    }
    attrs.label.mapKey = f.lastPrimaryKey();
  }

  /** renders md and checks that the result is well-formed XML, as the SVG renderer will need it to be */
  validateMarkdown(md, f) {
    let rendered = renderMarkdown(md);
    rendered = '<div>' + rendered + '</div>';
    const err = unmarshalInterface(rendered);
    if (err !== null) {
      if (err.syntax) this.errorf(f.lastPrimaryKey(), 'malformed Markdown: %s', err.msg);
      else this.errorf(f.lastPrimaryKey(), 'malformed Markdown: %s', err.msg);
    }
  }

  compilePosition(attrs, f) {
    const name = f.name;
    if (f.map() !== null) {
      for (const f2 of f.map().fields || []) {
        if (ss(f2.name) === 'near' && isUnquoted(f2.name)) {
          if (f2.primary() === null) this.errorf(f2.lastPrimaryKey(), 'invalid "near" field');
          else {
            const scalar = f2.primary().value;
            switch (boxKind(scalar)) {
              case 'null':
                switch (ss(name)) {
                  case 'label': attrs.labelPosition = null; break;
                  case 'icon': attrs.iconPosition = null; break;
                  case 'tooltip': attrs.tooltipPosition = null; break;
                }
                break;
              default:
                switch (ss(name)) {
                  case 'label': case 'icon':
                    if (!LabelPositions.has(ss(scalar))) this.errorf(f2.lastPrimaryKey(), 'invalid "near" field');
                    else {
                      switch (ss(name)) {
                        case 'label':
                          attrs.labelPosition = new d2graph.Scalar();
                          attrs.labelPosition.value = ss(scalar);
                          attrs.labelPosition.mapKey = f2.lastPrimaryKey();
                          break;
                        case 'icon':
                          attrs.iconPosition = new d2graph.Scalar();
                          attrs.iconPosition.value = ss(scalar);
                          attrs.iconPosition.mapKey = f2.lastPrimaryKey();
                          break;
                      }
                    }
                    break;
                  case 'tooltip':
                    if (!TooltipPositions.has(ss(scalar))) this.errorf(f2.lastPrimaryKey(), 'invalid "near" field');
                    else {
                      attrs.tooltipPosition = new d2graph.Scalar();
                      attrs.tooltipPosition.value = ss(scalar);
                      attrs.tooltipPosition.mapKey = f2.lastPrimaryKey();
                    }
                    break;
                }
            }
          }
        } else if (f2.lastPrimaryKey() !== null) this.errorf(f2.lastPrimaryKey(), 'unexpected field %s', ss(f2.name));
      }
      if ((f.map().edges || []).length > 0) this.errorf(f.lastPrimaryKey(), 'unexpected edges in map');
    }
  }

  compileReserved(attrs, f) {
    if (f.primary() === null) {
      if (f.composite !== null) {
        switch (ss(f.name)) {
          case 'class':
            if (f.composite instanceof d2ir.IRArray) {
              for (const class_ of f.composite.values || []) {
                if (class_ instanceof d2ir.Scalar) attrs.classes = append(attrs.classes, ss(class_.value));
              }
            }
            break;
          case 'constraint':
            if (f.composite instanceof d2ir.IRArray) {
              for (const constraint of f.composite.values || []) {
                if (constraint instanceof d2ir.Scalar) {
                  switch (boxKind(constraint.value)) {
                    case 'null': attrs.constraint = append(attrs.constraint, 'null'); break;
                    default: attrs.constraint = append(attrs.constraint, ss(constraint.value));
                  }
                }
              }
            }
            break;
          case 'label': case 'icon': case 'tooltip':
            this.compilePosition(attrs, f);
            break;
          default:
            this.errorf(f.lastPrimaryKey(), 'reserved field %v does not accept composite', ss(f.name));
        }
      } else this.errorf(f.lastRef().ast(), 'reserved field "%v" must have a value', ss(f.name));
      return;
    }
    const scalar = f.primary().value;
    switch (ss(f.name)) {
      case 'label':
        this.compileLabel(attrs, f);
        this.compilePosition(attrs, f);
        break;
      case 'shape': {
        const shapeVal = lc(ss(scalar));
        const in_ = d2target.isShape(shapeVal);
        const isArrowhead = d2target.Arrowheads.has(shapeVal);
        if (!in_ && !isArrowhead) {
          this.errorf(scalar, 'unknown shape %q', ss(scalar));
          return;
        }
        attrs.shape.value = shapeVal;
        if (equalFold(attrs.shape.value, d2target.ShapeCode)) {
          // Explicit code shape is plaintext.
          attrs.language = d2target.ShapeText;
        }
        attrs.shape.mapKey = f.lastPrimaryKey();
        break;
      }
      case 'icon': {
        const { url: iconURL, err } = urlParse(ss(scalar));
        if (err !== null) {
          this.errorf(scalar, 'bad icon url %#v: %s', ss(scalar), err.message);
          return;
        }
        attrs.icon = iconURL;
        this.compilePosition(attrs, f);
        if (f.map() !== null) {
          for (const ff of f.map().fields || []) {
            if (ss(ff.name) === 'style' && isUnquoted(ff.name)) {
              if (ff.map() === null || (ff.map().fields || []).length === 0) {
                this.errorf(f.lastRef().ast(), '"style" expected to be set to a map of key-values, or contain an additional keyword like "style.opacity: 0.4"');
                return;
              }
              this.compileStyle(attrs.iconStyle, ff.map());
            }
          }
        }
        break;
      }
      case 'near': {
        let nearKey;
        try {
          nearKey = parseKey(ss(scalar));
        } catch (e) {
          this.errorf(scalar, 'bad near key %#v: %s', ss(scalar), e.message);
          return;
        }
        nearKey.range = unbox(scalar).range;
        attrs.nearKey = nearKey;
        break;
      }
      case 'tooltip':
        attrs.tooltip = new d2graph.Scalar();
        attrs.tooltip.value = ss(scalar);
        attrs.tooltip.mapKey = f.lastPrimaryKey();

        this.validateMarkdown(ss(scalar), f);

        this.compilePosition(attrs, f);
        break;
      case 'width': {
        const [, err] = strconvAtoi(ss(scalar));
        if (err !== null) {
          this.errorf(scalar, 'non-integer width %#v: %s', ss(scalar), err);
          return;
        }
        attrs.widthAttr = new d2graph.Scalar();
        attrs.widthAttr.value = ss(scalar);
        attrs.widthAttr.mapKey = f.lastPrimaryKey();
        break;
      }
      case 'height': {
        const [, err] = strconvAtoi(ss(scalar));
        if (err !== null) {
          this.errorf(scalar, 'non-integer height %#v: %s', ss(scalar), err);
          return;
        }
        attrs.heightAttr = new d2graph.Scalar();
        attrs.heightAttr.value = ss(scalar);
        attrs.heightAttr.mapKey = f.lastPrimaryKey();
        break;
      }
      case 'top': {
        const [v, err] = strconvAtoi(ss(scalar));
        if (err !== null) {
          this.errorf(scalar, 'non-integer top %#v: %s', ss(scalar), err);
          return;
        }
        if (v < 0) {
          this.errorf(scalar, 'top must be a non-negative integer: %#v', ss(scalar));
          return;
        }
        attrs.top = new d2graph.Scalar();
        attrs.top.value = ss(scalar);
        attrs.top.mapKey = f.lastPrimaryKey();
        break;
      }
      case 'left': {
        const [v, err] = strconvAtoi(ss(scalar));
        if (err !== null) {
          this.errorf(scalar, 'non-integer left %#v: %s', ss(scalar), err);
          return;
        }
        if (v < 0) {
          this.errorf(scalar, 'left must be a non-negative integer: %#v', ss(scalar));
          return;
        }
        attrs.left = new d2graph.Scalar();
        attrs.left.value = ss(scalar);
        attrs.left.mapKey = f.lastPrimaryKey();
        break;
      }
      case 'link':
        attrs.link = new d2graph.Scalar();
        attrs.link.value = ss(scalar);
        attrs.link.mapKey = f.lastPrimaryKey();
        break;
      case 'direction': {
        const dirs = ['up', 'down', 'right', 'left'];
        const val = lc(ss(scalar));
        if (!dirs.includes(val)) {
          this.errorf(scalar, 'direction must be one of %v, got %q', dirs.join(', '), ss(scalar));
          return;
        }
        attrs.direction.value = val;
        attrs.direction.mapKey = f.lastPrimaryKey();
        break;
      }
      case 'constraint':
        if (!isStringBox(scalar)) {
          this.errorf(f.lastPrimaryKey(), 'constraint value must be a string');
          return;
        }
        attrs.constraint = append(attrs.constraint, ss(scalar));
        break;
      case 'grid-rows': if (!this.compileIntAttr(attrs, 'gridRows', 'grid-rows', true, scalar, f)) return; break;
      case 'grid-columns': if (!this.compileIntAttr(attrs, 'gridColumns', 'grid-columns', true, scalar, f)) return; break;
      case 'grid-gap': if (!this.compileIntAttr(attrs, 'gridGap', 'grid-gap', false, scalar, f)) return; break;
      case 'vertical-gap': if (!this.compileIntAttr(attrs, 'verticalGap', 'vertical-gap', false, scalar, f)) return; break;
      case 'horizontal-gap': if (!this.compileIntAttr(attrs, 'horizontalGap', 'horizontal-gap', false, scalar, f)) return; break;
      case 'class':
        attrs.classes = append(attrs.classes, ss(scalar));
        break;
      case 'classes':
        break;
    }

    if (attrs.link !== null && attrs.label.value !== '') {
      const { url: u, err } = urlParseRequestURI(attrs.label.value);
      if (err === null && u.Host !== '') this.errorf(scalar, 'Label cannot be set to URL when link is also set (for security)');
    }

    if (attrs.link !== null && attrs.tooltip !== null) {
      const { url: u, err } = urlParseRequestURI(attrs.tooltip.value);
      if (err === null && u.Host !== '') this.errorf(scalar, 'Tooltip cannot be set to URL when link is also set (for security)');
    }
  }

  /** the shared body of the grid-* cases of compileReserved; positive: "must be a positive integer" else "non-negative". Returns false if an error was recorded. */
  compileIntAttr(attrs, prop, name, positive, scalar, f) {
    const [v, err] = strconvAtoi(ss(scalar));
    if (err !== null) {
      this.errorf(scalar, `non-integer ${name} %#v: %s`, ss(scalar), err);
      return false;
    }
    if (positive ? v <= 0 : v < 0) {
      this.errorf(scalar, `${name} must be a ${positive ? 'positive' : 'non-negative'} integer: %#v`, ss(scalar));
      return false;
    }
    attrs[prop] = new d2graph.Scalar();
    attrs[prop].value = ss(scalar);
    attrs[prop].mapKey = f.lastPrimaryKey();
    return true;
  }

  compileStyle(styles, m) {
    for (const f of m.fields || []) this.compileStyleField(styles, f);
  }

  compileStyleField(styles, f) {
    if (!(StyleKeywords.has(lc(ss(f.name))) && isUnquoted(f.name))) {
      this.errorf(f.lastRef().ast(), 'invalid style keyword: "%s"', ss(f.name));
      return;
    }
    if (f.primary() === null) return;
    compileStyleFieldInit(styles, f);
    const scalar = f.primary().value;
    const err = styles.apply(ss(f.name), ss(scalar));
    if (err !== null) {
      this.errorf(scalar, err);
      return;
    }
  }

  compileEdge(obj, e) {
    const [edge, err] = obj.connect(e.id.srcPath, e.id.dstPath, e.id.srcArrow, e.id.dstArrow, '');
    if (err !== null) {
      this.errorf(e.references[0].ast(), err);
      return;
    }

    if (e.primary() !== null) this.compileLabel(edge.attributes, e);
    if (e.map() !== null) this.compileEdgeMap(edge, e.map());

    edge.attributes.label.mapKey = e.lastPrimaryKey();
    for (const er of e.references || []) {
      const r = new d2graph.EdgeReference();
      r.edge = er.context_.edge;
      r.mapKey = er.context_.key;
      r.mapKeyEdgeIndex = er.context_.edgeIndex();
      r.scope = er.context_.scope;
      r.scopeAST = er.context_.scopeAST;
      r.scopeObj = obj;
      if (er.context_.scopeMap !== null && !d2ir.isVar(er.context_.scopeMap)) {
        const scopeObjIDA = d2ir.BoardIDA(er.context_.scopeMap);
        r.scopeObj = edge.src.graph.root.ensureChild(scopeObjIDA);
      }
      edge.references = append(edge.references, r);
    }
  }

  compileEdgeMap(edge, m) {
    const class_ = m.getField(flat('class'));
    if (class_ !== null) {
      let classNames = null;
      if (class_.primary() !== null) classNames = append(classNames, class_.primary().toString());
      else if (class_.composite !== null) {
        if (class_.composite instanceof d2ir.IRArray) {
          for (const c of class_.composite.values || []) {
            if (c instanceof d2ir.Scalar) classNames = append(classNames, ss(c.value));
            else this.errorf(c.lastPrimaryKey(), 'invalid value in array');
          }
        }
      }

      for (const className of classNames || []) {
        const classMap = m.getClassMap(className);
        if (classMap !== null) this.compileEdgeMap(edge, classMap);
      }
    }
    for (const f of m.fields || []) {
      const ok = ReservedKeywords.has(ss(f.name));
      if (!(ok && isUnquoted(f.name))) {
        this.errorf(f.references[0].ast(), 'edge map keys must be reserved keywords');
        continue;
      }
      this.compileEdgeField(edge, f);
    }
  }

  compileEdgeField(edge, f) {
    const keyword = lc(ss(f.name));
    let isStyleReserved = StyleKeywords.has(keyword);
    isStyleReserved = isStyleReserved && isUnquoted(f.name);
    if (isStyleReserved) {
      this.errorf(f.lastRef().ast(), '%v must be style.%v', ss(f.name), ss(f.name));
      return;
    }
    const isReserved = SimpleReservedKeywords.has(keyword);
    if (isReserved) {
      this.compileReserved(edge.attributes, f);
      return;
    } else if (ss(f.name) === 'style') {
      if (f.map() === null) return;
      this.compileStyle(edge.attributes.style, f.map());
      return;
    }

    if ((ss(f.name) === 'source-arrowhead' || ss(f.name) === 'target-arrowhead') && isUnquoted(f.name)) this.compileArrowheads(edge, f);
  }

  compileArrowheads(edge, f) {
    let attrs;
    if (ss(f.name) === 'source-arrowhead') {
      if (edge.srcArrowhead === null) edge.srcArrowhead = new d2graph.Attributes();
      attrs = edge.srcArrowhead;
    } else {
      if (edge.dstArrowhead === null) edge.dstArrowhead = new d2graph.Attributes();
      attrs = edge.dstArrowhead;
    }

    if (f.primary() !== null) this.compileLabel(attrs, f);

    if (f.map() !== null) {
      for (const f2 of f.map().fields || []) {
        const keyword = lc(ss(f2.name));
        let isReserved = SimpleReservedKeywords.has(keyword);
        isReserved = isReserved && isUnquoted(f2.name);
        if (isReserved) {
          this.compileReserved(attrs, f2);
          continue;
        } else if (ss(f2.name) === 'style' && isUnquoted(f2.name)) {
          if (f2.map() === null) continue;
          this.compileStyle(attrs.style, f2.map());
          continue;
        } else {
          this.errorf(f2.lastRef().ast(), 'source-arrowhead/target-arrowhead map keys must be reserved keywords');
          continue;
        }
      }
    }
  }

  compileClass(obj) {
    obj.class = new d2target.Class();
    for (const f of obj.childrenArray || []) {
      let visibility = 'public';
      let name = f.idVal;
      // See https://www.uml-diagrams.org/visibility.html
      if (name !== '') {
        switch (name[0]) {
          case '+':
            name = name.slice(1);
            break;
          case '-':
            visibility = 'private';
            name = name.slice(1);
            break;
          case '#':
            visibility = 'protected';
            name = name.slice(1);
            break;
        }
      }

      if (!f.idVal.includes('(')) {
        let typ = f.attributes.label.value;
        if (typ === f.idVal) typ = '';
        const underline = f.attributes.style.underline !== null && f.attributes.style.underline.value === 'true';
        obj.class.fields = append(obj.class.fields, new d2target.ClassField({
          name,
          type: typ,
          visibility,
          underline,
        }));
      } else {
        // TODO: Not great, AST should easily allow specifying alternate primary field
        // as an explicit label should change the name.
        let returnType = f.attributes.label.value;
        if (returnType === f.idVal) returnType = 'void';
        const underline = f.attributes.style.underline !== null && f.attributes.style.underline.value === 'true';
        obj.class.methods = append(obj.class.methods, new d2target.ClassMethod({
          name,
          return: returnType,
          visibility,
          underline,
        }));
      }
    }

    removeChildrenFromObjects(obj);
    obj.children = null;
    obj.childrenArray = null;
  }

  compileSQLTable(obj) {
    obj.sqlTable = new d2target.SQLTable();
    for (const col of obj.childrenArray || []) {
      let typ = col.attributes.label.value;
      if (typ === col.idVal) {
        // Not great, AST should easily allow specifying alternate primary field
        // as an explicit label should change the name.
        typ = '';
      }
      const d2Col = new d2target.SQLColumn({
        name: new d2target.Text({ label: col.idVal }),
        type: new d2target.Text({ label: typ }),
        constraint: col.attributes.constraint,
      });
      obj.sqlTable.columns = append(obj.sqlTable.columns, d2Col);
    }

    removeChildrenFromObjects(obj);
    obj.children = null;
    obj.childrenArray = null;
  }

  validateKeys(obj, m) {
    for (const f of m.fields || []) {
      if (BoardKeywords.has(ss(f.name)) && isUnquoted(f.name)) continue;
      this.validateKey(obj, f);
    }
  }

  validateKey(obj, f) {
    const keyword = lc(ss(f.name));
    let isReserved = ReservedKeywords.has(keyword);
    isReserved = isReserved && isUnquoted(f.name);
    if (isReserved) {
      switch (obj.attributes.shape.value) {
        case d2target.ShapeCircle: case d2target.ShapeSquare: {
          const checkEqual = (keyword === 'width' && obj.attributes.heightAttr !== null) || (keyword === 'height' && obj.attributes.widthAttr !== null);
          if (checkEqual && obj.attributes.widthAttr.value !== obj.attributes.heightAttr.value) {
            this.errorf(f.lastPrimaryKey(), 'width and height must be equal for %s shapes', obj.attributes.shape.value);
          }
        }
      }

      switch (ss(f.name)) {
        case 'style':
          if (obj.attributes.style.threeDee !== null) {
            if (!equalFold(obj.attributes.shape.value, d2target.ShapeSquare) && !equalFold(obj.attributes.shape.value, d2target.ShapeRectangle) && !equalFold(obj.attributes.shape.value, d2target.ShapeHexagon)) {
              this.errorf(obj.attributes.style.threeDee.mapKey, 'key "3d" can only be applied to squares, rectangles, and hexagons');
            }
          }
          if (obj.attributes.style.doubleBorder !== null) {
            if (obj.attributes.shape.value !== '' && !equalFold(obj.attributes.shape.value, d2target.ShapeSquare) && !equalFold(obj.attributes.shape.value, d2target.ShapeRectangle) && !equalFold(obj.attributes.shape.value, d2target.ShapeCircle) && !equalFold(obj.attributes.shape.value, d2target.ShapeOval)) {
              this.errorf(obj.attributes.style.doubleBorder.mapKey, 'key "double-border" can only be applied to squares, rectangles, circles, ovals');
            }
          }
          break;
        case 'shape': {
          if (equalFold(obj.attributes.shape.value, d2target.ShapeImage) && obj.attributes.icon === null) {
            this.errorf(f.lastPrimaryKey(), 'image shape must include an "icon" field');
          }

          const in_ = d2target.isShape(obj.attributes.shape.value);
          const arrowheadIn = d2target.Arrowheads.has(obj.attributes.shape.value);
          if (!in_ && arrowheadIn) {
            this.errorf(f.lastPrimaryKey(), sprintf('invalid shape, can only set "%s" for arrowheads', obj.attributes.shape.value));
          }
          break;
        }
        case 'constraint':
          if (!equalFold(obj.attributes.shape.value, d2target.ShapeSQLTable)) {
            this.errorf(f.lastPrimaryKey(), '"constraint" keyword can only be used in "sql_table" shapes');
          }
          break;
      }
      return;
    }

    if (equalFold(obj.attributes.shape.value, d2target.ShapeImage) && obj.outerSequenceDiagram() === null) {
      this.errorf(f.lastRef().ast(), 'image shapes cannot have children.');
      return;
    }

    const [child, ok] = obj.hasChild([ss(f.name)]);
    if (ok && f.map() !== null) this.validateKeys(child, f.map());
  }

  validateLabels(g) {
    for (const obj of g.objects || []) {
      if (equalFold(obj.attributes.shape.value, d2target.ShapeText)) {
        if (obj.attributes.language !== '') {
          // blockstrings have already been validated
          continue;
        }
        if (goTrimSpace(obj.attributes.label.value) === '') this.errorf(obj.attributes.label.mapKey, 'shape text must have a non-empty label');
      } else if (equalFold(obj.attributes.shape.value, d2target.ShapeSQLTable)) {
        if (obj.attributes.label.value.includes('\n')) this.errorf(obj.attributes.label.mapKey, 'shape sql_table cannot have newlines in label');
      }
    }
  }

  validateNear(g) {
    for (const obj of g.objects || []) {
      if (obj.attributes.nearKey !== null) {
        const [nearObj, isKey] = g.root.hasChild(d2graph.key(obj.attributes.nearKey));
        const isConst = NearConstants.has(d2graph.key(obj.attributes.nearKey)[0]);
        if (isKey) {
          // Doesn't make sense to set near to an ancestor or descendant
          let nearIsAncestor = false;
          for (let curr = obj; curr !== null; curr = curr.parent) {
            if (curr === nearObj) {
              nearIsAncestor = true;
              break;
            }
          }
          if (nearIsAncestor) {
            this.errorf(obj.attributes.nearKey, 'near keys cannot be set to an ancestor');
            continue;
          }
          let nearIsDescendant = false;
          for (let curr = nearObj; curr !== null; curr = curr.parent) {
            if (curr === obj) {
              nearIsDescendant = true;
              break;
            }
          }
          if (nearIsDescendant) {
            this.errorf(obj.attributes.nearKey, 'near keys cannot be set to an descendant');
            continue;
          }
          if (nearObj.outerSequenceDiagram() !== null) {
            this.errorf(obj.attributes.nearKey, 'near keys cannot be set to an object within sequence diagrams');
            continue;
          }
          if (nearObj.attributes.nearKey !== null) {
            const nearObjNearIsConst = NearConstants.has(d2graph.key(nearObj.attributes.nearKey)[0]);
            if (nearObjNearIsConst) {
              this.errorf(obj.attributes.nearKey, 'near keys cannot be set to an object with a constant near key');
              continue;
            }
          }
          if (nearObj.closestGridDiagram() !== null) {
            this.errorf(obj.attributes.nearKey, 'near keys cannot be set to descendants of special objects, like grid cells');
            continue;
          }
          if (nearObj.outerSequenceDiagram() !== null) {
            this.errorf(obj.attributes.nearKey, 'near keys cannot be set to descendants of special objects, like sequence diagram actors');
            continue;
          }
        } else if (isConst) {
          if (obj.parent !== g.root) {
            this.errorf(obj.attributes.nearKey, 'constant near keys can only be set on root level shapes');
            continue;
          }
        } else {
          this.errorf(obj.attributes.nearKey, 'near key %#v must be the absolute path to a shape or one of the following constants: %s', format('key_path', obj.attributes.nearKey), NearConstantsArray.join(', '));
          continue;
        }
      }
    }

    for (const edge of g.edges || []) {
      if (edge.src.isConstantNear() && edge.dst.isDescendantOf(edge.src)) {
        this.errorf(edge.getAstEdge(), 'edge from constant near %#v cannot enter itself', edge.src.absID());
        continue;
      }
      if (edge.dst.isConstantNear() && edge.src.isDescendantOf(edge.dst)) {
        this.errorf(edge.getAstEdge(), 'edge from constant near %#v cannot enter itself', edge.dst.absID());
        continue;
      }
    }
  }

  validatePositionsCompatibility(g) {
    for (const o of g.objects || []) {
      for (const pos of [o.attributes.top, o.attributes.left]) {
        if (pos !== null) {
          if (o.parent !== null) {
            if (equalFold(o.parent.attributes.shape.value, d2target.ShapeHierarchy)) this.errorf(pos.mapKey, 'position keywords cannot be used with shape "hierarchy"');
            if (o.outerSequenceDiagram() !== null) this.errorf(pos.mapKey, 'position keywords cannot be used inside shape "sequence_diagram"');
            if (o.parent.attributes.gridColumns !== null || o.parent.attributes.gridRows !== null) this.errorf(pos.mapKey, 'position keywords cannot be used with grids');
          }
        }
      }
    }
  }

  validateEdges(g) {
    for (const edge of g.edges || []) {
      // edges from a grid to something outside is ok
      //   grid -> outside : ok
      //   grid -> grid.cell : not ok
      //   grid -> grid.cell.inner : not ok
      if (edge.src.isGridDiagram() && edge.dst.isDescendantOf(edge.src)) {
        this.errorf(edge.getAstEdge(), 'edge from grid diagram %#v cannot enter itself', edge.src.absID());
        continue;
      }
      if (edge.dst.isGridDiagram() && edge.src.isDescendantOf(edge.dst)) {
        this.errorf(edge.getAstEdge(), 'edge from grid diagram %#v cannot enter itself', edge.dst.absID());
        continue;
      }
      if (edge.src.parent !== null && edge.src.parent.isGridDiagram() && edge.dst.isDescendantOf(edge.src)) {
        this.errorf(edge.getAstEdge(), 'edge from grid cell %#v cannot enter itself', edge.src.absID());
        continue;
      }
      if (edge.dst.parent !== null && edge.dst.parent.isGridDiagram() && edge.src.isDescendantOf(edge.dst)) {
        this.errorf(edge.getAstEdge(), 'edge from grid cell %#v cannot enter itself', edge.dst.absID());
        continue;
      }
      if (edge.src.isSequenceDiagram() && edge.dst.isDescendantOf(edge.src)) {
        this.errorf(edge.getAstEdge(), 'edge from sequence diagram %#v cannot enter itself', edge.src.absID());
        continue;
      }
      if (edge.dst.isSequenceDiagram() && edge.src.isDescendantOf(edge.dst)) {
        this.errorf(edge.getAstEdge(), 'edge from sequence diagram %#v cannot enter itself', edge.dst.absID());
        continue;
      }
    }
  }

  validateBoardLinks(g) {
    for (const obj of g.objects || []) {
      if (obj.attributes.link === null) continue;

      let linkKey;
      try { linkKey = parseKey(obj.attributes.link.value); } catch { continue; }

      const { url: u, err } = urlParse(htmlUnescapeString(obj.attributes.link.value));
      const isRemote = err === null && (u.Scheme !== '' || u.Path.startsWith('/'));
      if (isRemote) continue;

      if (ss(linkKey.path[0]) !== 'root') {
        obj.attributes.link = null;
        continue;
      }

      if (!hasBoard(g.rootBoard(), linkKey.path)) {
        obj.attributes.link = null;
        continue;
      }

      if (slicesEqual(linkKey.path.map((el) => ss(el)), obj.graph.IDA())) {
        obj.attributes.link = null;
        continue;
      }
    }
    for (const b of g.layers || []) this.validateBoardLinks(b);
    for (const b of g.scenarios || []) this.validateBoardLinks(b);
    for (const b of g.steps || []) this.validateBoardLinks(b);
  }

  setDefaultShapes(g) {
    for (const obj of g.objects || []) {
      if (obj.attributes.shape.value === '') {
        if (obj.outerSequenceDiagram() !== null) obj.attributes.shape.value = d2target.ShapeRectangle;
        else if (obj.attributes.language === 'latex') obj.attributes.shape.value = d2target.ShapeText;
        else if (obj.attributes.language === 'markdown') obj.attributes.shape.value = d2target.ShapeText;
        else if (obj.attributes.language !== '') obj.attributes.shape.value = d2target.ShapeCode;
        else obj.attributes.shape.value = d2target.ShapeRectangle;
      }
    }
  }
}

/** a d2ast.Scalar box that is a String (unquoted, quoted or block) */
const isStringBox = (b) => {
  const k = boxKind(b);
  return k === 'unquoted_string' || k === 'double_quoted_string' || k === 'single_quoted_string' || k === 'block_string';
};

const slicesEqual = (a, b) => {
  a = a || []; b = b || [];
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

// compileClass / compileSQLTable: remove the children from the graph's objects
function removeChildrenFromObjects(obj) {
  for (const ch of obj.childrenArray || []) {
    for (let i = 0; i < (obj.graph.objects || []).length; i++) {
      if (obj.graph.objects[i] === ch) {
        obj.graph.objects = [...obj.graph.objects.slice(0, i), ...obj.graph.objects.slice(i + 1)];
        i--;
      }
    }
  }
}

function findFieldAST(ast, f) {
  let path = [];
  let curr = f;
  for (;;) {
    path = [ss(curr.name), ...path];
    const boardKind = d2ir.nodeBoardKind(curr);
    if (boardKind === '') break;
    curr = d2ir.parentField(curr);
  }

  return _findFieldAST(ast, path);
}

function _findFieldAST(ast, path) {
  if (path.length === 0) return ast;

  const head = path[0];
  const remainingPath = path.slice(1);

  for (let i = 0; i < (ast.nodes || []).length; i++) {
    const mk = ast.nodes[i].map_key;
    if (!mk || !mk.key || (mk.key.path || []).length !== 1) continue;

    const head2 = ss(mk.key.path[0]);
    if (head === head2) {
      if (!mk.value.map) {
        mk.value.map = {
          range: makeRange(',1:0:0-1:0:0'),
          nodes: null,
        };
        if (mk.value.import) {
          const imp = {
            range: makeRange(',1:0:0-1:0:0'),
            spread: true,
            pre: mk.value.import.pre,
            path: mk.value.import.path,
          };
          mk.value.map.nodes = append(mk.value.map.nodes, { import: imp });
        }
      }

      const result = _findFieldAST(mk.value.map, remainingPath);
      if (result !== null) return result;
    }
  }

  return null;
}

// TODO add more, e.g. C, bash
export const ShortToFullLanguageAliases = {
  md: 'markdown',
  tex: 'latex',
  js: 'javascript',
  go: 'golang',
  py: 'python',
  rb: 'ruby',
  ts: 'typescript',
};
export const FullToShortLanguageAliases = Object.fromEntries(Object.entries(ShortToFullLanguageAliases).map(([k, v]) => [v, k]));

function hasBoard(root, ida) {
  if (ida.length === 0) return true;
  if (ss(ida[0]) === 'root' && isUnquoted(ida[0])) return hasBoard(root, ida.slice(1));
  const id = ida[0];
  if (ida.length === 1) return root.name === ss(id);
  const nextID = ida[1];
  switch (ss(id)) {
    case 'layers':
      for (const b of root.layers || []) if (b.name === ss(nextID)) return hasBoard(b, ida.slice(2));
      break;
    case 'scenarios':
      for (const b of root.scenarios || []) if (b.name === ss(nextID)) return hasBoard(b, ida.slice(2));
      break;
    case 'steps':
      for (const b of root.steps || []) if (b.name === ss(nextID)) return hasBoard(b, ida.slice(2));
      break;
  }
  return false;
}

function compileStyleFieldInit(styles, f) {
  const sc = () => new d2graph.Scalar('', f.lastPrimaryKey());
  switch (ss(f.name)) {
    case 'opacity': styles.opacity = sc(); break;
    case 'stroke': styles.stroke = sc(); break;
    case 'fill': styles.fill = sc(); break;
    case 'fill-pattern': styles.fillPattern = sc(); break;
    case 'stroke-width': styles.strokeWidth = sc(); break;
    case 'stroke-dash': styles.strokeDash = sc(); break;
    case 'border-radius': styles.borderRadius = sc(); break;
    case 'shadow': styles.shadow = sc(); break;
    case '3d': styles.threeDee = sc(); break;
    case 'multiple': styles.multiple = sc(); break;
    case 'font': styles.font = sc(); break;
    case 'font-size': styles.fontSize = sc(); break;
    case 'font-color': styles.fontColor = sc(); break;
    case 'animated': styles.animated = sc(); break;
    case 'bold': styles.bold = sc(); break;
    case 'italic': styles.italic = sc(); break;
    case 'underline': styles.underline = sc(); break;
    case 'filled': styles.filled = sc(); break;
    case 'double-border': styles.doubleBorder = sc(); break;
    case 'text-transform': styles.textTransform = sc(); break;
  }
}

// ---- config ----

/** @returns {{config: d2target.Config|null, err: ParseError|null}} */
function compileConfig(ir) {
  let f = ir.getField(flat('vars'), flat('d2-config'));
  if (f === null || f.map() === null) return { config: null, err: null };

  const configMap = f.map();

  const config = new d2target.Config();

  f = configMap.getField(flat('sketch'));
  if (f !== null) {
    const [val] = strconvParseBool(ss(f.primary().value));
    config.sketch = val;
  }

  f = configMap.getField(flat('theme-id'));
  if (f !== null) {
    const [val] = strconvAtoi(ss(f.primary().value));
    config.themeID = val;
  }

  f = configMap.getField(flat('dark-theme-id'));
  if (f !== null) {
    const [val] = strconvAtoi(ss(f.primary().value));
    config.darkThemeID = val;
  }

  f = configMap.getField(flat('pad'));
  if (f !== null) {
    const [val] = strconvAtoi(ss(f.primary().value));
    config.pad = val;
  }

  f = configMap.getField(flat('layout-engine'));
  if (f !== null) config.layoutEngine = ss(f.primary().value);

  f = configMap.getField(flat('center'));
  if (f !== null) {
    const [val] = strconvParseBool(ss(f.primary().value));
    config.center = val;
  }

  f = configMap.getField(flat('theme-overrides'));
  if (f !== null) {
    const { overrides, err } = compileThemeOverrides(f.map());
    if (err !== null) return { config: null, err };
    config.themeOverrides = overrides;
  }
  f = configMap.getField(flat('dark-theme-overrides'));
  if (f !== null) {
    const { overrides, err } = compileThemeOverrides(f.map());
    if (err !== null) return { config: null, err };
    config.darkThemeOverrides = overrides;
  }
  f = configMap.getField(flat('data'));
  if (f !== null && f.map() !== null) {
    config.data = {};
    for (const f2 of f.map().fields || []) {
      if (f2.primary() !== null) config.data[ss(f2.name)] = ss(f2.primary().value);
      else if (f2.composite !== null) {
        let arr = null;
        const c = f2.composite;
        if (c instanceof d2ir.IRArray) {
          for (const v of c.values || []) {
            if (v instanceof d2ir.Scalar) arr = append(arr, v.toString());
          }
        }
        config.data[ss(f2.name)] = arr;
      }
    }
  }

  return { config, err: null };
}

const THEME_CODES = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'aa2', 'aa4', 'aa5', 'ab4', 'ab5'];

/** @returns {{overrides: d2target.ThemeOverrides|null, err: ParseError|null}} */
function compileThemeOverrides(m) {
  if (m === null) return { overrides: null, err: null };
  const themeOverrides = new d2target.ThemeOverrides();

  const err = new ParseError();
  const pushErr = (n, msg) => {
    const nn = n.range ? n : unbox(n);
    err.errs.push(new AstError(nn.range, sprintf('%v: ' + msg, new GoRange(nn.range))));
  };
  for (const f of m.fields || []) {
    const code = goUpper(ss(f.name));
    const key = code.toLowerCase();
    if (!/^(N[1-7]|B[1-6]|AA[245]|AB[45])$/.test(code)) {
      pushErr(f.lastPrimaryKey(), sprintf('"%s" is not a valid theme code', ss(f.name)));
      continue;
    }
    themeOverrides[key] = ss(f.primary().value);
    if (!color.NamedColors.includes(lc(ss(f.primary().value))) && !color.ColorHexRegex.test(ss(f.primary().value))) {
      pushErr(f.lastPrimaryKey(), sprintf('expected "%s" to be a valid named color ("orange") or a hex code ("#f0ff3a")', ss(f.name)));
    }
  }

  if (err.errs.length > 0) return { overrides: null, err };

  if (THEME_CODES.some((k) => themeOverrides[k] !== null)) return { overrides: themeOverrides, err: null };
  return { overrides: null, err: null };
}

// Go's strings.ToUpper maps per code point.
function goUpper(s) {
  let o = '';
  for (const c of s) {
    const u = c.toUpperCase();
    o += Array.from(u).length === 1 ? u : c;
  }
  return o;
}
