export const findClosestLink = (element: Element): Element | null => element.closest("a[href]");

export const computeDomPath = (root: Element, target: Element): readonly number[] => {
  const buildPath = (current: Element, acc: readonly number[]): readonly number[] => {
    if (current === root || current.parentElement === null) {
      return acc;
    }
    const parent = current.parentElement;
    const children = Array.from(parent.children);
    const idx = children.indexOf(current);
    return buildPath(parent, [idx >= 0 ? idx : 0, ...acc]);
  };
  return buildPath(target, []);
};

export const resolveDomPath = (root: Element, domPath: readonly number[]): Element | null =>
  domPath.reduce<Element | null>((current, index) => {
    if (current === null) {
      return null;
    }
    const child = current.children.item(index);
    return child ?? null;
  }, root);
