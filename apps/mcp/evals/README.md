# MCP tool-selection evaluations

`tool-selection.json` is the versioned acceptance specification for whether an AI host chooses the
right Kanera tools for representative user requests. It is not runtime configuration and does not
itself invoke a model.

The deterministic MCP contract test validates that the fixture is well formed and never refers to
removed tools. Before an MCP release, run every case against the staging MCP using each supported
host/model used for launch material (currently ChatGPT), then inspect the captured tool trace:

1. Every `expectedTools` entry must be called when the prompt requires it.
2. No `forbiddenTools` entry may be called.
3. Arguments must satisfy the intent in `expectedArguments`; resolved UUID values will vary by test
account, so compare semantics rather than literal ids.
4. Negative/read-only cases must not cause unintended mutations.
5. Returned citations must open the expected Kanera source.

Run the matrix against ChatGPT, Claude web/Desktop, Codex, and the MCP Inspector/reference client.
Record the host, model, negotiated protocol version, transport response type, date, and pass/fail
result with the release evidence. Reconnect
the MCP before testing a breaking catalog release so the host cannot reuse cached tool definitions.

The release is blocked if any host cannot discover both read and write tools, refresh an expired
access token, render a structured error, consume cursor pagination, or enforce its configured
approval/tool allowlist. Exercise one editor write and one observer write denial per host. For
non-model protocol clients, use direct initialize/tools-list/tools-call assertions instead of judging
tool selection.

If these checks are automated later, keep the model-backed runner opt-in or in a pre-release job: it
requires external credentials, has cost, and is inherently less deterministic than the contract
suite. The ordinary unit test should remain the fast, credential-free schema/catalog guard.
