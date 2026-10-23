// A stand-in for the Docs API, for checking that planned requests converge.
//
// The body is a flat stream of index units, like Docs' own index space: text
// characters (UTF-16 length), inline objects, paragraph newlines (carrying the
// paragraph style and bullet), and one unit each for a table's start, a row's
// start, a cell's start and the table's end. It models the Docs rules the
// planner has to respect, as observed against the live API:
// - a segment can't start with a table, tables can't touch, and the newline
//   before a table or at the end of a segment (body or cell) can't be deleted
// - inserted newlines copy the paragraph they land in, bullet included
// - insertTable at i splits the paragraph there; the table starts at i + 1
// - insertPageBreak adds a newline after the break
// - updateTextStyle only clears a link when its range starts on linked text
// - createParagraphBullets turns leading tabs into nesting, joins an adjacent
//   list with the same preset (and then drops the tabs without nesting), and
//   sets the list indent; deleteParagraphBullets
//   leaves that indent behind as explicit paragraph indent
// - deleting/merging table structure needs whole tables
// - chips (person, date, rich link, dropdown) come back without an id in the
//   reply; a dropdown needs a definition with at least 2 options

import {parse} from "../src/format.ts";
import type {Block, Para, TextStyle} from "../src/model.ts";

type Style = Record<string, any>;
type Item =
  | {k: "ch"; c: string; ts: Style}
  | {k: "obj"; kind: "img" | "pagebreak" | "chip"; id: string; ts: Style; el?: Record<string, any>}
  | {k: "nl"; ts: Style; ps: Style; bullet?: {listId: string; level: number}}
  | {k: "table"}
  | {k: "row"}
  | {k: "cell"; style: Style}
  | {k: "end"};

const len = (it: Item) => (it.k === "ch" ? it.c.length : 1);

const NUM: Record<string, string> = {"1": "DECIMAL", "01": "ZERO_DECIMAL", a: "ALPHA", A: "UPPER_ALPHA", i: "ROMAN", I: "UPPER_ROMAN"};
// Glyphs per nesting level, measured live (3 levels shown; they repeat).
const PRESETS: Record<string, string[]> = {
  BULLET_DISC_CIRCLE_SQUARE: ["●", "○", "■"],
  BULLET_CHECKBOX: ["", "", ""],
  BULLET_DIAMONDX_ARROW3D_SQUARE: ["❖", "➢", "■"],
  BULLET_ARROW_DIAMOND_DISC: ["➔", "◆", "●"],
  BULLET_STAR_CIRCLE_SQUARE: ["★", "○", "■"],
  BULLET_ARROW3D_CIRCLE_SQUARE: ["➢", "○", "■"],
  BULLET_LEFTTRIANGLE_DIAMOND_DISC: ["◄", "◆", "●"],
  BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE: ["❖", "◇", "■"],
  BULLET_DIAMOND_CIRCLE_SQUARE: ["◆", "○", "■"],
  NUMBERED_DECIMAL_ALPHA_ROMAN: ["1", "a", "i"],
  NUMBERED_UPPERALPHA_ALPHA_ROMAN: ["A", "a", "i"],
  NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL: ["I", "A", "1"],
  NUMBERED_ZERODECIMAL_ALPHA_ROMAN: ["01", "a", "i"],
  NUMBERED_DECIMAL_NESTED: ["1", "1", "1"],
};

function nestingLevels(preset: string) {
  const g = PRESETS[preset];
  if (!g) throw new Error(`unknown preset ${preset}`);
  return Array.from({length: 9}, (_, l) => {
    const x = g[l % 3];
    if (preset === "BULLET_CHECKBOX") return {glyphType: "GLYPH_TYPE_UNSPECIFIED"};
    if (NUM[x]) return {glyphType: NUM[x], glyphFormat: `%${l}.`};
    return {glyphSymbol: x};
  });
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return {color: {rgbColor: {red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255}}};
};

function apiStyle(s: TextStyle): Style {
  const ts: Style = {};
  if (s.b) ts.bold = true;
  if (s.i) ts.italic = true;
  if (s.u) ts.underline = true;
  if (s.s) ts.strikethrough = true;
  if (s.sup) ts.baselineOffset = "SUPERSCRIPT";
  if (s.sub) ts.baselineOffset = "SUBSCRIPT";
  if (s.href) {
    ts.link = {url: s.href};
    if (!s.color) ts.foregroundColor = rgb("#1155cc");
    ts.underline = true;
  }
  if (s.mark) ts.backgroundColor = rgb(s.mark);
  if (s.color) ts.foregroundColor = rgb(s.color);
  if (s.size) ts.fontSize = {magnitude: s.size, unit: "PT"};
  if (s.font) ts.weightedFontFamily = {fontFamily: s.font};
  return ts;
}

const NAMED: Record<string, string> = {
  p: "NORMAL_TEXT", title: "TITLE", subtitle: "SUBTITLE", h1: "HEADING_1", h2: "HEADING_2", h3: "HEADING_3",
  h4: "HEADING_4", h5: "HEADING_5", h6: "HEADING_6",
};
const ALIGN: Record<string, string> = {center: "CENTER", right: "END", justify: "JUSTIFIED"};

// A new doc's named styles (sizes and colors as Docs ships them).
const named = (type: string, size: number, color?: string) => ({
  namedStyleType: type,
  textStyle: {
    ...(type === "NORMAL_TEXT" ? {weightedFontFamily: {fontFamily: "Arial", weight: 400}} : {}),
    fontSize: {magnitude: size, unit: "PT"},
    ...(color ? {foregroundColor: rgb(color)} : type === "NORMAL_TEXT" ? {foregroundColor: rgb("#000000")} : {}),
  },
  paragraphStyle: {},
});
const NAMED_STYLES = {
  styles: [
    named("NORMAL_TEXT", 11), named("TITLE", 26), named("SUBTITLE", 15, "#666666"), named("HEADING_1", 20),
    named("HEADING_2", 16), named("HEADING_3", 14, "#434343"), named("HEADING_4", 12, "#666666"),
    named("HEADING_5", 11, "#666666"), named("HEADING_6", 11, "#666666"),
  ],
};

const clean = (s: Style): Style => {
  const out: Style = {};
  for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== false && v !== "NONE") out[k] = v;
  return out;
};

export class SimDoc {
  items: Item[] = [];
  lists: Record<string, string> = {}; // listId -> preset
  dropdownDefinitions: Record<string, any> = {};
  rev = 0;
  nextId = 0;
  log: string[] = [];

  // Plain paragraphs, the old constructor shape.
  constructor(paras: {text: string; ts?: Style; ps?: Style}[] = []) {
    for (const p of paras) {
      for (const c of p.text) this.items.push({k: "ch", c, ts: {...p.ts}});
      this.items.push({k: "nl", ts: {}, ps: {namedStyleType: "NORMAL_TEXT", ...p.ps}});
    }
    if (!this.items.length) this.items.push({k: "nl", ts: {}, ps: {namedStyleType: "NORMAL_TEXT"}});
  }

  // Builds a doc straight from .goog text, without the planner.
  static from(src: string): SimDoc {
    const sim = new SimDoc([]);
    sim.items = [];
    sim.build(parse(`<!-- goog doc sim -->\n${src}`).blocks, true);
    return sim;
  }

  build(blocks: Block[], top: boolean) {
    const out = this.items;
    let prevList: {preset: string; id: string} | undefined;
    const filled: Block[] = [];
    for (const b of blocks) {
      if (b.type === "table" && (!filled.length || filled.at(-1)!.type === "table")) filled.push({type: "para", style: "p", runs: []});
      filled.push(b);
    }
    if (!filled.length || filled.at(-1)!.type !== "para") filled.push({type: "para", style: "p", runs: []});
    for (const b of filled) {
      if (b.type === "opaque") throw new Error("sim can't build opaque blocks");
      if (b.type === "table") {
        prevList = undefined;
        out.push({k: "table"});
        b.rows.forEach((row, r) => {
          out.push({k: "row"});
          row.forEach((cell, c) => {
            const ci = b.cells?.[r]?.[c];
            const style: Style = {};
            if (ci?.colspan) style.columnSpan = ci.colspan;
            if (ci?.rowspan) style.rowSpan = ci.rowspan;
            if (ci?.bg) style.backgroundColor = rgb(ci.bg);
            out.push({k: "cell", style});
            this.build(cell, false);
          });
        });
        out.push({k: "end"});
        continue;
      }
      const p = b as Para;
      for (const r of p.runs) {
        if ("text" in r) for (const c of r.text) out.push({k: "ch", c, ts: apiStyle(r.style)});
        else if (r.atom.kind === "img" || r.atom.kind === "pagebreak") out.push({k: "obj", kind: r.atom.kind, id: r.atom.attrs.id ?? `kix.sim${this.nextId++}`, ts: {}});
        else throw new Error(`sim can't build <${r.atom.kind}>`);
      }
      const ps: Style = {namedStyleType: NAMED[p.style]};
      if (p.align && ALIGN[p.align]) ps.alignment = ALIGN[p.align];
      if (p.indent) ps.indentStart = {magnitude: p.indent, unit: "PT"};
      if (p.first !== undefined) ps.indentFirstLine = {magnitude: p.first, unit: "PT"};
      const nl: Item = {k: "nl", ts: {}, ps};
      if (p.list) {
        const glyph = p.list.glyph ?? (p.list.ordered ? "1" : "●");
        const preset = Object.keys(PRESETS).find((k) => PRESETS[k][p.list!.level % 3] === glyph || (glyph === "check" && k === "BULLET_CHECKBOX")) ??
          (p.list.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE");
        if (!prevList || (p.list.level === 0 && prevList.preset !== preset) || p.list.start !== undefined) {
          prevList = {preset, id: `kix.list${this.nextId++}`};
          this.lists[prevList.id] = preset;
        }
        nl.bullet = {listId: prevList.id, level: p.list.level};
      } else prevList = undefined;
      out.push(nl);
    }
    void top;
  }

  // ---------- reading ----------

  toApi(): any {
    const inlineObjects: Record<string, any> = {};
    let k = 0;
    let index = 1;
    const next = () => {
      const it = this.items[k++];
      const at = index;
      index += len(it);
      return {it, at};
    };
    const peek = () => this.items[k];
    const paragraph = (): any => {
      const elements: any[] = [];
      const start = index;
      while (true) {
        const {it, at} = next();
        if (it.k === "ch") {
          const last = elements.at(-1);
          if (last?.textRun && JSON.stringify(last.textRun.textStyle) === JSON.stringify(it.ts)) {
            last.textRun.content += it.c;
            last.endIndex += it.c.length;
          } else elements.push({startIndex: at, endIndex: at + it.c.length, textRun: {content: it.c, textStyle: {...it.ts}}});
        } else if (it.k === "obj") {
          if (it.kind === "img") {
            elements.push({startIndex: at, endIndex: at + 1, inlineObjectElement: {inlineObjectId: it.id, textStyle: {...it.ts}}});
            inlineObjects[it.id] = {objectId: it.id, inlineObjectProperties: {embeddedObject: {imageProperties: {contentUri: `https://sim/${it.id}`}, size: {}}}};
          } else if (it.kind === "chip") {
            const [key, val] = Object.entries(structuredClone(it.el!))[0];
            elements.push({startIndex: at, endIndex: at + 1, [key]: {...val, textStyle: {...it.ts}}});
          } else elements.push({startIndex: at, endIndex: at + 1, pageBreak: {textStyle: {...it.ts}}});
        } else if (it.k === "nl") {
          const last = elements.at(-1);
          if (last?.textRun && JSON.stringify(last.textRun.textStyle) === JSON.stringify(it.ts)) {
            last.textRun.content += "\n";
            last.endIndex += 1;
          } else elements.push({startIndex: at, endIndex: at + 1, textRun: {content: "\n", textStyle: {...it.ts}}});
          const p: any = {elements, paragraphStyle: {...it.ps, direction: it.ps.direction ?? "LEFT_TO_RIGHT"}};
          if (it.bullet) p.bullet = {listId: it.bullet.listId, ...(it.bullet.level ? {nestingLevel: it.bullet.level} : {})};
          return {startIndex: start, endIndex: index, paragraph: p};
        } else throw new Error(`malformed sim doc: ${it.k} inside a paragraph`);
      }
    };
    const content = (stop: (it: Item | undefined) => boolean): any[] => {
      const out: any[] = [];
      while (!stop(peek())) {
        const it = peek();
        if (it.k === "table") out.push(table());
        else out.push(paragraph());
      }
      return out;
    };
    const table = (): any => {
      const start = index;
      next();
      const tableRows: any[] = [];
      while (peek().k === "row") {
        const rowStart = index;
        next();
        const tableCells: any[] = [];
        while (peek().k === "cell") {
          const cellStart = index;
          const {it} = next();
          const c = content((x) => !x || x.k === "cell" || x.k === "row" || x.k === "end");
          tableCells.push({startIndex: cellStart, endIndex: index, content: c, tableCellStyle: {...(it as any).style}});
        }
        tableRows.push({startIndex: rowStart, endIndex: index, tableCells});
      }
      if (next().it.k !== "end") throw new Error("malformed sim table");
      return {startIndex: start, endIndex: index, table: {rows: tableRows.length, columns: tableRows[0]?.tableCells.length ?? 0, tableRows}};
    };
    const body = [{endIndex: 1, sectionBreak: {}}, ...content((x) => !x)];
    const lists: Record<string, any> = {};
    for (const [id, preset] of Object.entries(this.lists)) lists[id] = {listProperties: {nestingLevels: nestingLevels(preset)}};
    return {documentId: "sim", title: "Sim", revisionId: `r${this.rev}`, body: {content: body}, lists, inlineObjects, namedStyles: NAMED_STYLES, dropdownDefinitions: structuredClone(this.dropdownDefinitions)};
  }

  // ---------- index helpers ----------

  // Maps a doc index to a position in `items`.
  pos(index: number): number {
    let i = 1;
    for (let k = 0; k < this.items.length; k++) {
      if (i === index) return k;
      i += len(this.items[k]);
      if (i > index) throw new Error(`index ${index} splits a character`);
    }
    if (i === index) return this.items.length;
    throw new Error(`index ${index} out of range`);
  }

  // The newline that ends the paragraph containing position k.
  paraEnd(k: number): number {
    for (let j = k; j < this.items.length; j++) {
      const it = this.items[j];
      if (it.k === "nl") return j;
      if (it.k !== "ch" && it.k !== "obj") break;
    }
    throw new Error(`position ${k} isn't inside a paragraph`);
  }

  paraStart(k: number): number {
    let j = k;
    while (j > 0 && (this.items[j - 1].k === "ch" || this.items[j - 1].k === "obj")) j--;
    return j;
  }

  // Positions of the newlines of every paragraph that overlaps [a, b).
  paraEnds(a: number, b: number): number[] {
    const out: number[] = [];
    let k = a;
    while (k < Math.max(b, a + 1) && k < this.items.length) {
      const it = this.items[k];
      if (it.k === "ch" || it.k === "obj" || it.k === "nl") {
        const e = this.paraEnd(k);
        out.push(e);
        k = e + 1;
      } else k++;
    }
    return out;
  }

  tableAt(index: number): number {
    const k = this.pos(index);
    if (this.items[k]?.k !== "table") throw new Error(`no table starts at ${index}`);
    return k;
  }

  // The table's structure: rows of cells, each [start, end) in items.
  grid(t: number): {rows: {at: number; cells: {at: number; end: number}[]}[]; end: number} {
    const rows: {at: number; cells: {at: number; end: number}[]}[] = [];
    let k = t + 1;
    let depth = 0;
    let row: (typeof rows)[number] | undefined;
    let cell: {at: number; end: number} | undefined;
    for (; k < this.items.length; k++) {
      const it = this.items[k];
      if (depth === 0 && (it.k === "row" || it.k === "cell" || it.k === "end") && cell) {
        cell.end = k;
        cell = undefined;
      }
      if (it.k === "table") depth++;
      else if (it.k === "end" && depth > 0) depth--;
      else if (depth === 0 && it.k === "row") rows.push((row = {at: k, cells: []}));
      else if (depth === 0 && it.k === "cell") row!.cells.push((cell = {at: k, end: -1}));
      else if (depth === 0 && it.k === "end") return {rows, end: k};
    }
    throw new Error("unterminated table");
  }

  emptyCell(): Item[] {
    return [{k: "cell", style: {}}, {k: "nl", ts: {}, ps: {namedStyleType: "NORMAL_TEXT"}}];
  }

  // ---------- writing ----------

  apply(requests: any[]): any[] {
    const replies: any[] = [];
    for (const r of requests) {
      const [kind, body] = Object.entries(r)[0] as [string, any];
      const where = body.location ?? body.range ?? body.tableCellLocation?.tableStartLocation ?? body.tableRange?.tableCellLocation?.tableStartLocation;
      if (where?.segmentId || where?.tabId) throw new Error("sim has no headers, footers, footnotes or tabs");
      const fn = (this as any)[`do_${kind}`];
      if (!fn) throw new Error(`sim doesn't support ${kind}`);
      replies.push(fn.call(this, body) ?? {});
      this.log.push(kind);
    }
    this.rev++;
    return replies;
  }

  insertAt(index: number): number {
    const k = this.pos(index);
    const it = this.items[k];
    if (!it || (it.k !== "ch" && it.k !== "obj" && it.k !== "nl")) throw new Error(`can't insert at ${index}: not inside a paragraph`);
    return k;
  }

  do_insertText(b: any) {
    const k = this.insertAt(b.location.index);
    const prev = this.items[k - 1];
    const next = this.items[k];
    const inherit = prev && (prev.k === "ch" || prev.k === "obj") ? prev.ts : next.k === "ch" || next.k === "obj" ? next.ts : {};
    const nl = this.items[this.paraEnd(k)] as Extract<Item, {k: "nl"}>;
    const added: Item[] = [...(b.text as string)].map((c) =>
      c === "\n" ? {k: "nl", ts: {}, ps: {...nl.ps}, bullet: nl.bullet && {...nl.bullet}} : {k: "ch", c, ts: {...inherit}},
    );
    this.items.splice(k, 0, ...added);
  }

  do_insertInlineImage(b: any) {
    const k = this.insertAt(b.location.index);
    if (!/^https:\/\//.test(b.uri)) throw new Error("image uri must be https");
    const id = `kix.sim${this.nextId++}`;
    this.items.splice(k, 0, {k: "obj", kind: "img", id, ts: {}});
    return {insertInlineImage: {objectId: id}};
  }

  chip(b: any, el: (id: string) => Record<string, any>) {
    const k = this.insertAt(b.location.index);
    const id = `kix.sim${this.nextId++}`;
    this.items.splice(k, 0, {k: "obj", kind: "chip", id, ts: {}, el: el(id)});
  }

  do_insertPerson(b: any) {
    const {email, name} = b.personProperties ?? {};
    if (!email) throw new Error("insertPerson needs an email");
    this.chip(b, (personId) => ({person: {personId, personProperties: {email, name: name ?? email.split("@")[0]}}}));
  }

  do_insertDate(b: any) {
    const ts = b.dateElementProperties?.timestamp;
    if (!ts || Number.isNaN(Date.parse(ts))) throw new Error("insertDate needs a timestamp");
    this.chip(b, (dateId) => ({dateElement: {dateId, dateElementProperties: {timestamp: ts, displayText: ts.slice(0, 10)}}}));
  }

  do_insertRichLink(b: any) {
    const uri = b.richLinkProperties?.uri;
    if (!uri) throw new Error("insertRichLink needs a uri");
    this.chip(b, (richLinkId) => ({richLink: {richLinkId, richLinkProperties: {uri, title: "Sim file"}}}));
  }

  do_createDropdownDefinition(b: any) {
    const d = b.dropdownDefinition;
    const props = d.dropdownDefinitionProperties ?? {};
    if (!props.title) throw new Error("Dropdown definition title must not be empty.");
    if ((props.options ?? []).length < 2) throw new Error("a dropdown definition needs at least 2 options");
    const id = d.dropdownDefinitionId ?? `kix.simdef${this.nextId++}`;
    if (this.dropdownDefinitions[id]) throw new Error(`dropdown definition ${id} already exists`);
    const options = props.options.map((o: any, k: number) => ({optionId: o.optionId ?? `dropdownItem.sim${k}`, displayValue: o.displayValue}));
    this.dropdownDefinitions[id] = {dropdownDefinitionId: id, dropdownDefinitionProperties: {title: props.title, options}};
    return {createDropdownDefinition: {dropdownDefinition: this.dropdownDefinitions[id]}};
  }

  option(defId: string, optionId: string | undefined) {
    const def = this.dropdownDefinitions[defId];
    if (!def) throw new Error(`no dropdown definition ${defId}`);
    const opts = def.dropdownDefinitionProperties.options;
    const o = optionId ? opts.find((x: any) => x.optionId === optionId) : opts[0];
    if (!o) throw new Error(`no option ${optionId} in ${defId}`);
    return o;
  }

  do_insertDropdown(b: any) {
    const o = this.option(b.dropdownDefinitionId, b.selectedOptionId);
    this.chip(b, (dropdownId) => ({dropdown: {dropdownId, dropdownProperties: {dropdownDefinitionId: b.dropdownDefinitionId, selectedOptionId: o.optionId, displayValue: o.displayValue}}}));
  }

  do_updateDropdownProperties(b: any) {
    const it = this.items.find((x) => x.k === "obj" && x.kind === "chip" && x.el?.dropdown?.dropdownId === b.dropdownId) as Extract<Item, {k: "obj"}> | undefined;
    if (!it) throw new Error(`no dropdown ${b.dropdownId}`);
    const p = it.el!.dropdown.dropdownProperties;
    const o = this.option(p.dropdownDefinitionId, b.dropdownProperties.selectedOptionId);
    p.selectedOptionId = o.optionId;
    p.displayValue = o.displayValue;
  }

  inTable(k: number): boolean {
    let depth = 0;
    for (let j = 0; j < k; j++) {
      if (this.items[j].k === "table") depth++;
      if (this.items[j].k === "end") depth--;
    }
    return depth > 0;
  }

  do_insertPageBreak(b: any) {
    const k = this.insertAt(b.location.index);
    if (this.inTable(k)) throw new Error("page breaks can't go in tables");
    const nl = this.items[this.paraEnd(k)] as Extract<Item, {k: "nl"}>;
    this.items.splice(k, 0, {k: "obj", kind: "pagebreak", id: "pb", ts: {}}, {k: "nl", ts: {}, ps: {...nl.ps}, bullet: nl.bullet && {...nl.bullet}});
  }

  do_deleteContentRange(b: any) {
    const a = this.pos(b.range.startIndex);
    const e = this.pos(b.range.endIndex);
    if (e <= a) throw new Error("empty delete range");
    if (e >= this.items.length) throw new Error("can't delete the final newline");
    // Table structure must go whole.
    let depth = 0;
    for (let k = a; k < e; k++) {
      const it = this.items[k];
      if (it.k === "table") depth++;
      else if (it.k === "end") {
        if (--depth < 0) throw new Error("delete range cuts into a table");
      } else if ((it.k === "row" || it.k === "cell") && depth === 0) throw new Error("delete range cuts into a table");
    }
    if (depth) throw new Error("delete range cuts into a table");
    const after = this.items[e];
    const last = this.items[e - 1];
    if (last.k === "nl" && (after.k === "table" || after.k === "cell" || after.k === "row" || after.k === "end")) {
      throw new Error("can't delete the newline before a table or at the end of a cell");
    }
    this.items.splice(a, e - a);
    // A table can't start a segment or follow another table.
    for (let k = 0; k < this.items.length; k++) {
      if (this.items[k].k === "table" && (k === 0 || ["cell", "end"].includes(this.items[k - 1].k))) {
        throw new Error("delete would leave a table without a paragraph before it");
      }
    }
  }

  do_updateTextStyle(b: any) {
    const a = this.pos(b.range.startIndex);
    const e = this.pos(b.range.endIndex);
    const fields: string[] = b.fields.split(",");
    const first = this.items.slice(a, e).find((it) => it.k === "ch" || it.k === "obj") as any;
    const unlinkOk = !!first?.ts.link;
    for (let k = a; k < e; k++) {
      const it = this.items[k];
      if (it.k !== "ch" && it.k !== "obj") continue;
      for (const f of fields) {
        const v = b.textStyle[f];
        if (f === "link" && v === undefined && !unlinkOk) continue;
        if (v === undefined || v === false || v === "NONE") delete it.ts[f];
        else it.ts[f] = structuredClone(v);
      }
      it.ts = clean(it.ts);
    }
  }

  do_updateParagraphStyle(b: any) {
    const a = this.pos(b.range.startIndex);
    const e = this.pos(b.range.endIndex);
    for (const k of this.paraEnds(a, e)) {
      const nl = this.items[k] as Extract<Item, {k: "nl"}>;
      for (const f of b.fields.split(",")) {
        const v = b.paragraphStyle[f];
        if (v === undefined) delete nl.ps[f];
        else nl.ps[f] = structuredClone(v);
      }
      if (nl.ps.direction === "LEFT_TO_RIGHT") delete nl.ps.direction;
    }
  }

  do_createParagraphBullets(b: any) {
    const a = this.pos(b.range.startIndex);
    const e = this.pos(b.range.endIndex);
    const ends = this.paraEnds(a, e);
    const firstStart = this.paraStart(ends[0]);
    const before = this.items[firstStart - 1];
    let listId: string;
    const firstNl = this.items[ends[0]] as Extract<Item, {k: "nl"}>;
    // Joining a list (the one above, or the one the first paragraph is in)
    // drops the nesting tabs without applying them.
    let join = false;
    if (firstNl.bullet) {
      listId = firstNl.bullet.listId;
      join = true;
    } else if (before?.k === "nl" && before.bullet && this.lists[before.bullet.listId] === b.bulletPreset) {
      listId = before.bullet.listId;
      join = true;
    } else {
      listId = `kix.list${this.nextId++}`;
      this.lists[listId] = b.bulletPreset;
      nestingLevels(b.bulletPreset);
    }
    // Last to first, so removing tabs doesn't move the paragraphs still to do.
    for (const end of ends.reverse()) {
      const start = this.paraStart(end);
      let tabs = 0;
      while (this.items[start + tabs].k === "ch" && (this.items[start + tabs] as any).c === "\t") tabs++;
      this.items.splice(start, tabs);
      const nl = this.items[end - tabs] as Extract<Item, {k: "nl"}>;
      nl.bullet = {listId, level: join ? 0 : tabs};
      nl.ps.indentStart = {magnitude: 36 * (tabs + 1), unit: "PT"};
      nl.ps.indentFirstLine = {magnitude: 36 * tabs + 18, unit: "PT"};
    }
  }

  do_deleteParagraphBullets(b: any) {
    const a = this.pos(b.range.startIndex);
    const e = this.pos(b.range.endIndex);
    for (const k of this.paraEnds(a, e)) {
      const nl = this.items[k] as Extract<Item, {k: "nl"}>;
      if (!nl.bullet) continue;
      // Docs keeps the visual indent as explicit paragraph indent.
      nl.ps.indentStart = {magnitude: 36 * (nl.bullet.level + 1), unit: "PT"};
      nl.ps.indentFirstLine = {magnitude: 36 * nl.bullet.level + 18, unit: "PT"};
      delete nl.bullet;
    }
  }

  do_insertTable(b: any) {
    const k = this.insertAt(b.location.index);
    const nl = this.items[this.paraEnd(k)] as Extract<Item, {k: "nl"}>;
    const t: Item[] = [{k: "nl", ts: {}, ps: {...nl.ps}, bullet: nl.bullet && {...nl.bullet}}, {k: "table"}];
    for (let r = 0; r < b.rows; r++) {
      t.push({k: "row"});
      for (let c = 0; c < b.columns; c++) t.push(...this.emptyCell());
    }
    t.push({k: "end"});
    this.items.splice(k, 0, ...t);
  }

  cellLoc(loc: any) {
    const t = this.tableAt(loc.tableStartLocation.index);
    const g = this.grid(t);
    const row = g.rows[loc.rowIndex ?? 0];
    if (!row) throw new Error(`no row ${loc.rowIndex}`);
    if (!row.cells[loc.columnIndex ?? 0]) throw new Error(`no column ${loc.columnIndex}`);
    return {t, g, row};
  }

  do_insertTableRow(b: any) {
    const {g} = this.cellLoc(b.tableCellLocation);
    const r = b.tableCellLocation.rowIndex ?? 0;
    const width = g.rows[0].cells.length;
    const at = b.insertBelow ? (g.rows[r + 1]?.at ?? g.end) : g.rows[r].at;
    const items: Item[] = [{k: "row"}];
    for (let c = 0; c < width; c++) items.push(...this.emptyCell());
    this.items.splice(at, 0, ...items);
  }

  do_deleteTableRow(b: any) {
    const {g} = this.cellLoc(b.tableCellLocation);
    const r = b.tableCellLocation.rowIndex ?? 0;
    if (g.rows.length === 1) throw new Error("can't delete the only row");
    const at = g.rows[r].at;
    const end = g.rows[r + 1]?.at ?? g.end;
    this.items.splice(at, end - at);
  }

  do_insertTableColumn(b: any) {
    const {g} = this.cellLoc(b.tableCellLocation);
    const c = b.tableCellLocation.columnIndex ?? 0;
    for (const row of [...g.rows].reverse()) {
      const at = b.insertRight ? (row.cells[c + 1]?.at ?? row.cells[c].end) : row.cells[c].at;
      this.items.splice(at, 0, ...this.emptyCell());
    }
  }

  do_deleteTableColumn(b: any) {
    const {g} = this.cellLoc(b.tableCellLocation);
    const c = b.tableCellLocation.columnIndex ?? 0;
    if (g.rows[0].cells.length === 1) throw new Error("can't delete the only column");
    for (const row of [...g.rows].reverse()) this.items.splice(row.cells[c].at, row.cells[c].end - row.cells[c].at);
  }

  do_updateTableCellStyle(b: any) {
    const {g} = this.cellLoc(b.tableRange.tableCellLocation);
    const r0 = b.tableRange.tableCellLocation.rowIndex ?? 0;
    const c0 = b.tableRange.tableCellLocation.columnIndex ?? 0;
    for (let r = r0; r < r0 + b.tableRange.rowSpan; r++) {
      for (let c = c0; c < c0 + b.tableRange.columnSpan; c++) {
        const cell = this.items[g.rows[r].cells[c].at] as Extract<Item, {k: "cell"}>;
        for (const f of b.fields.split(",")) {
          if (b.tableCellStyle[f] === undefined) delete cell.style[f];
          else cell.style[f] = b.tableCellStyle[f];
        }
      }
    }
  }

  do_mergeTableCells(b: any) {
    const {g} = this.cellLoc(b.tableRange.tableCellLocation);
    const r0 = b.tableRange.tableCellLocation.rowIndex ?? 0;
    const c0 = b.tableRange.tableCellLocation.columnIndex ?? 0;
    const head = g.rows[r0].cells[c0];
    const moved: Item[] = [];
    // Last to first: empty the covered cells, collecting their non-empty text.
    for (let r = r0 + b.tableRange.rowSpan - 1; r >= r0; r--) {
      for (let c = c0 + b.tableRange.columnSpan - 1; c >= c0; c--) {
        if (r === r0 && c === c0) continue;
        const cell = g.rows[r].cells[c];
        const inner = this.items.slice(cell.at + 1, cell.end);
        if (!(inner.length === 1 && inner[0].k === "nl")) moved.unshift(...inner);
        this.items.splice(cell.at + 1, cell.end - cell.at - 1, {k: "nl", ts: {}, ps: {namedStyleType: "NORMAL_TEXT"}});
      }
    }
    this.items.splice(head.end, 0, ...moved);
    const cell = this.items[head.at] as Extract<Item, {k: "cell"}>;
    cell.style.rowSpan = b.tableRange.rowSpan;
    cell.style.columnSpan = b.tableRange.columnSpan;
  }

  do_unmergeTableCells(b: any) {
    const {g} = this.cellLoc(b.tableRange.tableCellLocation);
    const r0 = b.tableRange.tableCellLocation.rowIndex ?? 0;
    const c0 = b.tableRange.tableCellLocation.columnIndex ?? 0;
    for (let r = r0; r < r0 + b.tableRange.rowSpan; r++) {
      for (let c = c0; c < c0 + b.tableRange.columnSpan; c++) {
        const cell = this.items[g.rows[r].cells[c].at] as Extract<Item, {k: "cell"}>;
        delete cell.style.rowSpan;
        delete cell.style.columnSpan;
      }
    }
  }
}
