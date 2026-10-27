// Kanera-specific lint rules for the web app. Each one encodes a convention that used to live only in
// review comments and agent memory; the message says what to do instead.

const isTablerClass = (value) => /(^|\s)ti(\s|$)/.test(value);

/** `[class]="'ti ti-' + icon"` or `class="ti {{ icon }}"` names the `ti` class in its source. */
const boundSourceIsTabler = (source) => /(^|['"`\s])ti(['"`\s]|$)/.test(source);

const tablerIconAriaHidden = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description: 'Decorative Tabler icons must be aria-hidden so their ::before glyph stays out of accessible names',
    },
    messages: {
      missing:
        'Add aria-hidden="true" to this Tabler icon. Its ::before glyph otherwise leaks into the accessible name of the surrounding control, which screen readers announce and Playwright getByRole exact-name lookups miss. Give it aria-label instead if the icon itself carries meaning.',
    },
    schema: [],
  },
  create(context) {
    return {
      Element(element) {
        const attributes = element.attributes ?? [];
        const inputs = element.inputs ?? [];
        const isIcon =
          attributes.some((attribute) => attribute.name === 'class' && isTablerClass(attribute.value)) ||
          inputs.some((input) => input.name === 'class' && boundSourceIsTabler(input.value?.source ?? ''));
        if (!isIcon) return;
        // A labelled icon (a spinner's "Loading…", a status mark) is meaningful on purpose.
        const accessible = [...attributes, ...inputs].some((node) =>
          /^(aria-hidden|aria-label|aria-labelledby|role)$/.test(node.name),
        );
        if (accessible) return;
        const start = element.startSourceSpan.start.offset;
        context.report({
          loc: context.sourceCode.parserServices.convertNodeSourceSpanToLoc(element.startSourceSpan),
          messageId: 'missing',
          fix: (fixer) => fixer.insertTextAfterRange([start, start + 1 + element.name.length], ' aria-hidden="true"'),
        });
      },
    };
  },
};

/**
 * Angular ends the `:meaning|description@@id:` block of a `$localize` message at the first unescaped
 * colon, so `:Report metric: cards completed:Completed` renders " cards completed:Completed". The
 * tell is a message that starts with whitespace, which a real message never does.
 */
const localizeDescriptionColon = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A $localize description must not contain a colon',
    },
    messages: {
      colon:
        'This $localize description contains a colon, which ends the description early and leaks the rest into the UI. Write " - " instead of ":" in the description.',
    },
    schema: [],
  },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        if (node.tag.type !== 'Identifier' || node.tag.name !== '$localize') return;
        const raw = node.quasi.quasis[0].value.raw;
        if (!raw.startsWith(':')) return;
        let end = 1;
        while (end < raw.length && raw[end] !== ':') end += raw[end] === '\\' ? 2 : 1;
        if (end >= raw.length) return;
        if (/^\s/.test(raw.slice(end + 1))) context.report({ node, messageId: 'colon' });
      },
    };
  },
};

export default {
  meta: { name: 'kanera' },
  rules: {
    'tabler-icon-aria-hidden': tablerIconAriaHidden,
    'localize-description-colon': localizeDescriptionColon,
  },
};
