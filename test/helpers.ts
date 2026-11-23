import type { Node } from "../src/wikitext/parse.js";
import { renderText } from "../src/wikitext/templates.js";

export { type Template, named, parse, positional, toWikitext } from "../src/wikitext/parse.js";

export const renderTextOf = (nodes: Node[] | undefined): string => (nodes ? renderText(nodes) : "");
