import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
const digest = value => createHash("sha256").update(value).digest("hex");

const root = process.cwd();
const manifestPath = "docs/input-validation.json";
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : entry.name.endsWith(".ts") && !/\.(?:test|itest)\.ts$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}
const operations = [];
for (const file of [...files("apps/api/src"), ...files("apps/mcp/src")]) {
  const source = fs.readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions = new Map();
  const fastifyReceivers = new Set(["app", "api"]);
  function gather(node) {
    if (ts.isParameter(node) && node.type?.getText(tree).includes("FastifyInstance") && ts.isIdentifier(node.name)) fastifyReceivers.add(node.name.text);
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) functions.set(node.name.text, node.initializer);
    ts.forEachChild(node, gather);
  }
  gather(tree);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      let kind, name, handler;
      if (ts.isIdentifier(node.expression) && node.expression.text === "registerKaneraTool") {
        if (!node.arguments[1] || !ts.isStringLiteralLike(node.arguments[1])) throw new Error(`${file}: dynamic MCP tool name needs explicit scanner support`);
        kind = "mcp"; name = node.arguments[1]?.text; handler = node.arguments[4];
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (file.startsWith("apps/mcp/") && method === "registerTool") throw new Error(`${file}: register tools through the reviewed registerKaneraTool wrapper`);
        // Resource template variables are raw URI text that never passes a tool schema, and they are interpolated into API paths.
        if (file.startsWith("apps/mcp/") && method === "registerResource" && !node.arguments.at(-1)?.getText(tree).includes("resourceVariables.parse(")) throw new Error(`${file}: MCP resource handlers must validate their template variables with resourceVariables`);
        const owner = node.expression.expression.getText(tree);
        if (file.startsWith("apps/api/") && fastifyReceivers.has(owner) && ["get", "post", "put", "patch", "delete", "head", "options", "all"].includes(method) && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))) throw new Error(`${file}: dynamic route path needs explicit scanner support`);
        if (["get", "post", "put", "patch", "delete", "head", "options", "all"].includes(method) && /^\//.test(node.arguments[0]?.text ?? "")) {
          // HTTP clients also have get/post; route handlers (inline or named) distinguish registration.
          const last = node.arguments.at(-1);
          if (last && ts.isIdentifier(last) && !functions.has(last.text) && file.startsWith("apps/api/") && fastifyReceivers.has(owner)) throw new Error(`${file}: imported handler ${last.text} needs explicit scanner resolution`);
          if (last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last) || ts.isIdentifier(last) && functions.has(last.text))) {
            kind = "http"; name = `${method.toUpperCase()} ${node.arguments[0].text}`; handler = last;
          }
        } else if (method === "route") {
          const options = node.arguments[0];
          if (options && ts.isObjectLiteralExpression(options)) {
            const props = new Map(options.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(tree), p.initializer]));
            kind = "http"; name = `${props.get("method")?.getText(tree)} ${props.get("url")?.getText(tree)}`; handler = props.get("handler");
          } else throw new Error(`${file}: dynamic route registration needs explicit scanner support`);
        } else if (file === "apps/api/src/realtime/io.ts" && owner === "socket" && method === "on" && node.arguments[0]?.getText(tree) !== '"disconnect"') {
          if (!node.arguments[0]?.getText(tree).startsWith("CLIENT_EVENTS.")) throw new Error(`${file}: unsupported socket event needs explicit scanner support`);
          kind = "socket"; name = node.arguments[0]?.getText(tree); handler = node.arguments[1];
        }
      }
      if (kind && name) {
        if (handler && ts.isIdentifier(handler)) handler = functions.get(handler.text) ?? handler;
        let text = handler?.getText(tree) ?? "";
        const inputs = [];
        const forwarded = [];
        const expanded = new Set();
        const requestName = handler?.parameters?.[0]?.name?.getText(tree);
        function readInputs(node, alias = requestName) {
          if (kind === "http" && ts.isElementAccessExpression(node) && node.expression.getText(tree) === alias) {
            if (!ts.isStringLiteralLike(node.argumentExpression)) throw new Error(`${file}: dynamic request access needs explicit scanner support`);
            if (["params", "query", "body", "headers", "cookies", "rawBody"].includes(node.argumentExpression.text)) inputs.push(node.argumentExpression.text);
          }
          if (kind === "http" && ts.isCallExpression(node)) {
            const index = node.arguments.findIndex(arg => ts.isIdentifier(arg) && arg.text === alias);
            if (index !== -1) {
              const name = node.expression.getText(tree);
              forwarded.push(name);
              const helper = functions.get(name);
              if (helper && !expanded.has(name)) {
                expanded.add(name);
                text += "\n" + helper.getText(tree);
                readInputs(helper, helper.parameters?.[index]?.name?.getText(tree));
              }
            }
            if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(tree) === alias && ["file", "files", "parts"].includes(node.expression.name.text)) inputs.push("body");
          }
          if (kind === "http" && ts.isPropertyAccessExpression(node) && node.expression.getText(tree) === alias && ["params", "query", "body", "headers", "cookies", "rawBody"].includes(node.name.text)) inputs.push(node.name.text);
          ts.forEachChild(node, child => readInputs(child, alias));
        }
        if (handler) readInputs(handler);
        const validators = [...new Set([...text.matchAll(/([\w.]+(?:\([^;\n]*?\))?)\.(?:parse|safeParse)\(/g)].map(m => m[1]))];
        operations.push({ key: `${file}#${kind}:${name}`, file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, inputs: [...new Set(inputs)], validators, forwarded: [...new Set(forwarded)], handler: text });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
const occurrences = new Map();
for (const operation of operations) {
  const count = (occurrences.get(operation.key) ?? 0) + 1;
  occurrences.set(operation.key, count);
  if (count > 1) operation.key += `#${count}`;
}
operations.sort((a,b) => a.key.localeCompare(b.key));
if (process.argv.includes("--inventory")) {
  console.log(JSON.stringify(operations, null, 2));
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const failures = [];
const declared = new Set();
for (const operation of operations) {
  declared.add(operation.key);
  const row = manifest.operations[operation.key];
  if (!row) { failures.push(`${operation.key}: missing validation review`); continue; }
  if (row.handlerSha256 !== digest(operation.handler)) failures.push(`${operation.key}: handler changed; review its input declarations`);
  for (const input of new Set([...operation.inputs, ...(operation.key.includes("#http:") ? ["params", "query", "body", "headers", "cookies"] : ["payload"])])) {
    const declaration = manifest.declarations[row[input]];
    if (!declaration || !["validated", "reviewed"].includes(declaration.status) || !declaration.reason) failures.push(`${operation.key}: missing ${input} validator/reviewed exception`);
    if (declaration?.directValidator && !operation.handler.includes(declaration.directValidator)) failures.push(`${operation.key}: direct validator removed: ${declaration.directValidator}`);
    for (const reference of declaration?.references ?? []) {
      const [file, symbol] = reference.split("#");
      if (!fs.existsSync(path.join(root, file)) || symbol && !fs.readFileSync(path.join(root, file), "utf8").includes(symbol)) failures.push(`${operation.key}: stale reference ${reference}`);
    }
    if (declaration?.status === "validated" && !declaration.references?.length) failures.push(`${operation.key}: ${input} validated without evidence reference`);
  }
}
for (const [file, expected] of Object.entries(manifest.evidenceFiles ?? {})) {
  if (!fs.existsSync(file) || digest(fs.readFileSync(file)) !== expected) failures.push(`${file}: shared boundary evidence changed; review declarations`);
}
for (const key of Object.keys(manifest.operations)) if (!declared.has(key)) failures.push(`${key}: stale operation declaration`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`Input-validation declarations cover ${operations.length} operations. Reviewed exceptions are not runtime validation guarantees.`);
