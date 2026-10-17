import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "product-page.html");
const RAW_FIXTURE_HTML = readFileSync(FIXTURE_PATH, "utf-8");

export const createTestDocument = (
  customHtml: string = RAW_FIXTURE_HTML,
  url = "https://shop.example.com/products/123",
): Document => {
  const win = new Window({
    url,
    width: 1280,
    height: 800,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableComputedStyleRendering: true,
    },
  });
  win.document.write(customHtml);
  return win.document as unknown as Document;
};

export const mustQuery = <T extends Element = Element>(doc: Document, selector: string): T => {
  const el = doc.querySelector<T>(selector);
  if (el === null) {
    throw new Error(`Selector not found in test fixture: ${selector}`);
  }
  return el;
};
