/**
 * Minimal wikitext parser: enough structure to read PCGW templates reliably.
 *
 * It mirrors the parts of the MediaWiki preprocessor that matter here:
 * - `{{…}}` templates with positional and named args (first top-level `=` names an arg)
 * - `[[…]]` links, so a `|` inside a link never splits a template arg
 * - extension tags (`<ref>`, `<nowiki>`, `<pre>`) are opaque to the enclosing template,
 *   so a `|` inside a `<ref>` never splits an arg either
 * - `<!-- … -->` comments are kept as nodes (round-trip) and dropped when rendering
 * Unclosed constructs fall back to literal text, as MediaWiki does.
 */

export type Node = string | Template | Link | Tag | Comment;

export interface Template {
  type: "template";
  /** Name as written, untrimmed (for round-trip). */
  nameRaw: Node[];
  /** Normalized name: trimmed, `_` → space, first letter uppercased. */
  name: string;
  args: Arg[];
}

export interface Arg {
  /** Untrimmed name source for named args; undefined for positional ones. */
  nameRaw?: string;
  /** Trimmed name for named args. */
  name?: string;
  value: Node[];
}

export interface Link {
  type: "link";
  target: Node[];
  /** Pieces after each `|`; usually zero or one. */
  parts: Node[][];
}

export interface Tag {
  type: "tag";
  name: string;
  /** Opening tag as written, e.g. `<ref name="a">`. */
  open: string;
  /** Inner nodes (parsed for `ref`, a single literal string for `nowiki`/`pre`). */
  inner: Node[];
  /** Closing tag as written, or "" for self-closing tags. */
  close: string;
}

export interface Comment {
  type: "comment";
  text: string;
}

const OPAQUE_LITERAL_TAGS = new Set(["nowiki", "pre", "syntaxhighlight", "math"]);
const OPAQUE_PARSED_TAGS = new Set(["ref"]);

type Stop = "|" | "}}" | "]]" | "=";

class Parser {
  constructor(private readonly src: string, private pos = 0) {}

  parseAll(): Node[] {
    const nodes = this.nodes(new Set());
    // Anything left (stray closers) is literal text.
    if (this.pos < this.src.length) push(nodes, this.src.slice(this.pos));
    return nodes;
  }

  /** Parse until one of `stops` at top level, or a closing tag `untilTag`, or EOF. */
  private nodes(stops: Set<Stop>, untilTag?: string): Node[] {
    const out: Node[] = [];
    const s = this.src;
    while (this.pos < s.length) {
      if (untilTag && s.startsWith(`</${untilTag}`, this.pos)) return out;
      for (const st of stops) if (s.startsWith(st, this.pos)) return out;

      if (s.startsWith("<!--", this.pos)) {
        const end = s.indexOf("-->", this.pos + 4);
        const stop = end === -1 ? s.length : end + 3;
        out.push({ type: "comment", text: s.slice(this.pos, stop) });
        this.pos = stop;
        continue;
      }
      if (s[this.pos] === "<") {
        const tag = this.tryTag();
        if (tag) {
          out.push(tag);
          continue;
        }
      }
      if (s.startsWith("{{", this.pos) && !s.startsWith("{{{", this.pos)) {
        const t = this.tryTemplate();
        if (t) {
          out.push(t);
          continue;
        }
      }
      if (s.startsWith("[[", this.pos)) {
        const l = this.tryLink();
        if (l) {
          out.push(l);
          continue;
        }
      }
      push(out, s[this.pos]!);
      this.pos++;
    }
    return out;
  }

  private tryTemplate(): Template | null {
    const start = this.pos;
    this.pos += 2;
    const nameRaw = this.nodes(new Set<Stop>(["|", "}}"]));
    const args: Arg[] = [];
    while (this.src.startsWith("|", this.pos)) {
      this.pos++;
      args.push(this.arg());
    }
    if (!this.src.startsWith("}}", this.pos)) {
      this.pos = start;
      return null;
    }
    this.pos += 2;
    return { type: "template", nameRaw, name: normalizeName(textOf(nameRaw)), args };
  }

  private arg(): Arg {
    // A named arg is one whose first top-level `=` comes before any `|`/`}}`.
    const save = this.pos;
    const head = this.nodes(new Set<Stop>(["|", "}}", "="]));
    const isNameNode = (n: Node): n is string | Comment => typeof n === "string" || n.type === "comment";
    if (this.src.startsWith("=", this.pos) && head.every(isNameNode)) {
      const nameRaw = head.map((n) => (typeof n === "string" ? n : (n as Comment).text)).join("");
      this.pos++;
      const value = this.nodes(new Set<Stop>(["|", "}}"]));
      return { nameRaw, name: nameRaw.replace(/<!--[\s\S]*?-->/g, "").trim(), value };
    }
    this.pos = save;
    return { value: this.nodes(new Set<Stop>(["|", "}}"])) };
  }

  private tryLink(): Link | null {
    const start = this.pos;
    this.pos += 2;
    const target = this.nodes(new Set<Stop>(["|", "]]"]));
    const parts: Node[][] = [];
    while (this.src.startsWith("|", this.pos)) {
      this.pos++;
      parts.push(this.nodes(new Set<Stop>(["|", "]]"])));
    }
    if (!this.src.startsWith("]]", this.pos)) {
      this.pos = start;
      return null;
    }
    this.pos += 2;
    return { type: "link", target, parts };
  }

  private tryTag(): Tag | null {
    const m = /^<([a-zA-Z]+)(\s[^>]*?)?(\/?)>/.exec(this.src.slice(this.pos, this.pos + 300));
    if (!m) return null;
    const name = m[1]!.toLowerCase();
    if (!OPAQUE_LITERAL_TAGS.has(name) && !OPAQUE_PARSED_TAGS.has(name)) return null;
    const start = this.pos;
    const open = m[0];
    this.pos += open.length;
    if (m[3] === "/") return { type: "tag", name, open, inner: [], close: "" };

    const closeRe = new RegExp(`</${name}\\s*>`, "i");
    if (OPAQUE_LITERAL_TAGS.has(name)) {
      const rest = this.src.slice(this.pos);
      const cm = closeRe.exec(rest);
      if (!cm) {
        this.pos = start;
        return null;
      }
      const inner = rest.slice(0, cm.index);
      this.pos += cm.index + cm[0].length;
      return { type: "tag", name, open, inner: inner ? [inner] : [], close: cm[0] };
    }
    // Parsed tag (ref): its content is parsed on its own; outer stops don't apply.
    const inner = this.nodes(new Set(), name);
    const cm = closeRe.exec(this.src.slice(this.pos, this.pos + 20));
    if (!cm || cm.index !== 0) {
      this.pos = start;
      return null;
    }
    this.pos += cm[0].length;
    return { type: "tag", name, open, inner, close: cm[0] };
  }
}

function push(out: Node[], text: string): void {
  const last = out[out.length - 1];
  if (typeof last === "string") out[out.length - 1] = last + text;
  else out.push(text);
}

export function normalizeName(raw: string): string {
  const n = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function parse(src: string): Node[] {
  return new Parser(src).parseAll();
}

/** Serialize back to wikitext from structure (not from stored slices). */
export function toWikitext(nodes: Node[]): string {
  return nodes.map(nodeToWikitext).join("");
}

function nodeToWikitext(n: Node): string {
  if (typeof n === "string") return n;
  switch (n.type) {
    case "comment":
      return n.text;
    case "tag":
      return n.open + toWikitext(n.inner) + n.close;
    case "link":
      return "[[" + toWikitext(n.target) + n.parts.map((p) => "|" + toWikitext(p)).join("") + "]]";
    case "template":
      return (
        "{{" +
        toWikitext(n.nameRaw) +
        n.args.map((a) => "|" + (a.nameRaw !== undefined ? a.nameRaw + "=" : "") + toWikitext(a.value)).join("") +
        "}}"
      );
  }
}

/** Concatenate literal text only (no templates), for names and keys. */
export function textOf(nodes: Node[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : "")).join("");
}

/** Depth-first walk over every template, including ones nested in args, links and refs. */
export function* templates(nodes: Node[]): Generator<Template> {
  for (const n of nodes) {
    if (typeof n === "string" || n.type === "comment") continue;
    if (n.type === "template") {
      yield n;
      for (const a of n.args) yield* templates(a.value);
    } else if (n.type === "link") {
      yield* templates(n.target);
      for (const p of n.parts) yield* templates(p);
    } else {
      yield* templates(n.inner);
    }
  }
}

export function positional(t: Template): Node[][] {
  return t.args.filter((a) => a.name === undefined).map((a) => a.value);
}

export function named(t: Template, name: string): Node[] | undefined {
  // Last one wins, as in MediaWiki.
  let found: Node[] | undefined;
  for (const a of t.args) if (a.name === name) found = a.value;
  return found;
}
