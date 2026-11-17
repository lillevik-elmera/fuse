/**
 * What the capture measures of a root's tree in Chromium, beyond its winning declarations: the facts
 * a capture keeps because they hold on any platform, read by a page function over DevTools.
 */
import type { CDPSession } from "playwright";

import type { MeasuredFacts } from "./capture-format.ts";
import { coincidingAround } from "./coinciding-around.ts";

/**
 * Measure a root's tree in the page and keep what holds on any platform, by each element's
 * element-ordinal path from the root, `""` for the root:
 *
 * - `containerWidth`, on the root: the content width of the element around it, where the root's
 *   margin box fills it, widening with it, and one more character of the root's text leaves it as it
 *   is, so CSS sets it and not the text. A positioned element with an auto width, as Base UI's
 *   positioner, shrinks to its content, so it is no such container.
 * - `widest`: in a root as wide as its own content, at its `min-width` or past it, the leaf row with
 *   text that fills its parent and whose own text is the widest, more than half a pixel wider than
 *   the next. That row's text sets the root's width once it outgrows the minimum, as a longer label
 *   does, so the build hugs it and keeps the minimum as its own (PH3).
 * - `oneLine`: an element under a `max-width` whose own text sits on one line, or a wrapping flex
 *   row whose items do.
 * - `underMaxHeight`: an element more than half a pixel under its `max-height`.
 * - `coincidingAround`, on the root: how many of the elements around it, innermost first, lie
 *   exactly behind it, as {@link coincidingAround} decides from their boxes and paint.
 * - `lineFits`: an element whose one element child is an inline-level box and which holds no text
 *   of its own, whose content box's top and bottom edges are the child's margin box's, within half
 *   a pixel, at its own line height and at 2px more. Matching edges leave no baseline offset, which
 *   moves the child down a line taller than a fixed-height box, and a line 2px taller grows the strut
 *   by 1px above and below (CSS 2.1 §10.8.1), so the line box adds nothing to the child by at least
 *   that margin. The second reading holds only where the page's computed line height took the 2px
 *   and the child kept its own.
 *
 * The page restores every element it changes before it returns.
 *
 * @param cdp - A DevTools session on the page.
 * @param nodeId - The root's node.
 * @returns Each element's facts, by its path from the root.
 */
export async function measuredFacts(
  cdp: CDPSession,
  nodeId: number
): Promise<ReadonlyMap<string, MeasuredFacts>> {
  const { object } = await cdp.send("DOM.resolveNode", { nodeId });
  if (object.objectId === undefined) {
    return new Map();
  }
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: MEASURE_IN_PAGE,
  });
  // SAFETY: the page function returns facts by path, as plain JSON.
  return new Map(Object.entries((result.value ?? {}) as Record<string, MeasuredFacts>));
}

/** The page side of {@link measuredFacts}, called on the root. */
const MEASURE_IN_PAGE = `function () {
  const root = this;
  const out = {};
  const put = (path, key, value) => { (out[path] ??= {})[key] = value; };
  const contentWidth = (element) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().width - ["padding-left", "padding-right", "border-left-width", "border-right-width"].reduce((sum, name) => sum + (Number.parseFloat(style.getPropertyValue(name)) || 0), 0);
  };
  const texts = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const found = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() !== "") { found.push(node); }
    }
    return found;
  };
  const withLonger = (element, read) => {
    const nodes = texts(element);
    const before = nodes.map((node) => node.textContent);
    nodes.forEach((node) => { node.textContent += "W"; });
    const value = read();
    nodes.forEach((node, index) => { node.textContent = before[index]; });
    return value;
  };
  const maxContent = (element) => {
    const style = element.getAttribute("style");
    element.style.width = "max-content";
    const width = element.getBoundingClientRect().width;
    if (style === null) { element.removeAttribute("style"); } else { element.setAttribute("style", style); }
    return width;
  };
  const elements = [];
  const walk = (element, path) => {
    elements.push({ element, path });
    if (element.localName === "svg") { return; }
    [...element.children].forEach((child, index) => walk(child, path === "" ? String(index) : path + "/" + String(index)));
  };
  walk(root, "");
  const parent = root.parentElement;
  const shrinks = (element) => ["absolute", "fixed"].includes(getComputedStyle(element).position);
  if (parent !== null && !shrinks(root) && !shrinks(parent)) {
    const before = contentWidth(parent);
    const style = parent.getAttribute("style");
    const width = root.getBoundingClientRect().width;
    parent.style.width = String(parent.getBoundingClientRect().width + 10) + "px";
    const follows = Math.abs(root.getBoundingClientRect().width - width - 10) <= 0.5;
    if (style === null) { parent.removeAttribute("style"); } else { parent.setAttribute("style", style); }
    const own = getComputedStyle(root);
    const margins = (Number.parseFloat(own.marginLeft) || 0) + (Number.parseFloat(own.marginRight) || 0);
    const fills = Math.abs(width + margins - before) <= 0.5 && follows;
    if (fills && withLonger(root, () => Math.abs(contentWidth(parent) - before) <= 0.01)) {
      put("", "containerWidth", Math.round(before * 100) / 100);
    }
  }
  const box = root.getBoundingClientRect();
  const rectOf = (rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  const clear = (color) => color === "transparent" || /[,/]\\s*0\\)$/.test(color);
  // Content the page draws whatever its box's paint says: replaced elements, SVG and MathML, a list
  // item's marker, and a generated ::before or ::after box. Any of these counts as paint.
  const REPLACED = new Set(["img", "video", "audio", "canvas", "iframe", "object", "embed", "picture", "input", "textarea", "select", "button", "meter", "progress", "math"]);
  const generates = (element) => ["::before", "::after"].some((pseudo) => !["none", "normal"].includes(getComputedStyle(element, pseudo).content));
  const drawsContent = (each) => REPLACED.has(each.localName) || each.namespaceURI !== "http://www.w3.org/1999/xhtml" || getComputedStyle(each).display === "list-item" || generates(each);
  const paintsNothing = (element) => [element, ...element.querySelectorAll("*")].every((each) => {
    const style = getComputedStyle(each);
    const sides = ["top", "right", "bottom", "left"];
    return !drawsContent(each) && clear(style.backgroundColor) && style.backgroundImage === "none" && style.boxShadow === "none" &&
      sides.every((side) => style.getPropertyValue("border-" + side + "-style") === "none" || Number.parseFloat(style.getPropertyValue("border-" + side + "-width")) === 0) &&
      (style.outlineStyle === "none" || Number.parseFloat(style.outlineWidth) === 0) &&
      [...each.childNodes].every((node) => node.nodeType !== 3 || (node.textContent ?? "").trim() === "");
  });
  const around = [];
  let below = root;
  for (let up = root.parentElement; up !== null && !up.hasAttribute("data-compare-cell"); up = up.parentElement) {
    const edges = up.getBoundingClientRect();
    const style = getComputedStyle(up);
    const px = (name) => Number.parseFloat(style.getPropertyValue(name)) || 0;
    const padding = { left: edges.left + px("border-left-width"), top: edges.top + px("border-top-width"), right: edges.right - px("border-right-width"), bottom: edges.bottom - px("border-bottom-width") };
    const others = [...up.children].filter((each) => each !== below).map((each) => {
      const other = each.getBoundingClientRect();
      const meets = other.width > 0 && other.height > 0 && other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top;
      return { meets, paintsNothing: paintsNothing(each) };
    });
    // A generated box of the element's own can sit over the root, as its other children can.
    around.push({ padding, others: generates(up) ? [...others, { meets: true, paintsNothing: false }] : others });
    below = up;
  }
  const coinciding = (${coincidingAround.toString()})(rectOf(box), around);
  if (coinciding > 0) { put("", "coincidingAround", coinciding); }
  const width = root.getBoundingClientRect().width;
  if (Math.abs(maxContent(root) - width) <= 0.5) {
    const rows = elements.filter(({ element }) => element !== root && element.hasAttribute("data-slot") && element.parentElement !== null && texts(element).length > 0 && Math.abs(element.getBoundingClientRect().width - contentWidth(element.parentElement)) <= 0.5);
    const leaves = rows.filter((row) => !rows.some((other) => other !== row && row.element.contains(other.element)));
    const widths = leaves.map(({ element, path }) => ({ path, width: maxContent(element) })).sort((left, right) => right.width - left.width);
    const [first, second] = widths;
    if (first !== undefined && (second === undefined || first.width - second.width > 0.5)) {
      put(first.path, "widest", true);
    }
  }
  for (const { element, path } of elements) {
    const style = getComputedStyle(element);
    const own = [...element.childNodes].filter((node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "");
    if (style.flexWrap.startsWith("wrap") && element.children.length > 1) {
      let bottom = -Infinity;
      let lines = 0;
      for (const child of [...element.children].map((each) => each.getBoundingClientRect()).sort((left, right) => left.top - right.top)) {
        if (child.top >= bottom - 0.5) { lines += 1; }
        bottom = Math.max(bottom, child.bottom);
      }
      if (lines === 1) { put(path, "oneLine", true); }
    } else if (own.length > 0 && style.maxWidth !== "none") {
      const tops = new Set();
      for (const node of own) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) { tops.add(Math.round(rect.top)); }
      }
      if (tops.size === 1) { put(path, "oneLine", true); }
    }
    if (style.maxHeight !== "none" && element.getBoundingClientRect().height + 0.5 < Number.parseFloat(style.maxHeight)) {
      put(path, "underMaxHeight", true);
    }
    const [child, ...others] = element.children;
    const line = Number.parseFloat(style.lineHeight);
    if (child !== undefined && others.length === 0 && own.length === 0 && getComputedStyle(child).display.startsWith("inline-") && Number.isFinite(line)) {
      const sum = (style, names) => names.reduce((total, name) => total + (Number.parseFloat(style.getPropertyValue(name)) || 0), 0);
      const fits = () => {
        const box = element.getBoundingClientRect();
        const inner = getComputedStyle(element);
        const top = box.top + sum(inner, ["border-top-width", "padding-top"]);
        const bottom = box.bottom - sum(inner, ["border-bottom-width", "padding-bottom"]);
        const outer = getComputedStyle(child);
        const edges = child.getBoundingClientRect();
        return Math.abs(edges.top - sum(outer, ["margin-top"]) - top) <= 0.5 && Math.abs(edges.bottom + sum(outer, ["margin-bottom"]) - bottom) <= 0.5;
      };
      if (fits()) {
        const elementStyle = element.getAttribute("style");
        const childStyle = child.getAttribute("style");
        const childLine = getComputedStyle(child).lineHeight;
        child.style.setProperty("line-height", childLine, "important");
        element.style.setProperty("line-height", String(line + 2) + "px", "important");
        const applied = Math.abs(Number.parseFloat(getComputedStyle(element).lineHeight) - line - 2) <= 0.01 && getComputedStyle(child).lineHeight === childLine;
        const still = applied && fits();
        if (elementStyle === null) { element.removeAttribute("style"); } else { element.setAttribute("style", elementStyle); }
        if (childStyle === null) { child.removeAttribute("style"); } else { child.setAttribute("style", childStyle); }
        if (still) { put(path, "lineFits", true); }
      }
    }
  }
  return out;
}`;
