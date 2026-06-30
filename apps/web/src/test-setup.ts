function installElementFromPointFallback(prototype: object | undefined) {
  if (!prototype || "elementFromPoint" in prototype) return;

  Object.defineProperty(prototype, "elementFromPoint", {
    configurable: true,
    value() {
      return document.body;
    },
  });
}

// jsdom does not implement layout hit-testing, but ProseMirror/Tiptap asks for this
// browser API while mounting editors. Returning a stable element is enough for these
// component tests; drag/drop behavior that needs precise hit targets still stubs it locally.
installElementFromPointFallback(Document.prototype);
installElementFromPointFallback(typeof ShadowRoot === "undefined" ? undefined : ShadowRoot.prototype);
