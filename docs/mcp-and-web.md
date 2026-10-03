# MCP and web tools

These integrations are opt-in at the external-service boundary. The standard
configuration loads both plugins with `:servers []` and `:search {}`: it starts
no MCP process or connection and makes no search request. `web_fetch` becomes
available for explicit public HTTP(S) requests. Search can incur provider charges
after it is configured, enabled, and approved. No live provider, paid search, or
real model was used in the tests described here.

## MCP configuration

Load `qi.plugins.mcp-client` after execution-world, trust, policy, approval, and
remote-registry when remote management is needed. Example plugin configuration:

```clojure
{:ns qi.plugins.mcp-client
 :config
 {:servers [{:id "local-docs"
             :transport :stdio
             :command ["/absolute/path/to/server" "--stdio"]
             :enabled false}
            {:id "remote-docs"
             :transport :streamable-http
             :url "https://your-server.example/mcp"
             :enabled false}]
  :max-tools 128
  :max-resources 256
  :max-output-chars 30000
  :request-timeout-ms 30000
  :startup-timeout-ms 10000
  :max-response-bytes 2097152}}
```

Server IDs are unique, 1–20 ASCII letters, digits, `_`, or `-`. Servers may set
`:protocol-mode :auto` (default), `:modern`, or `:legacy`, and override the three
transport limits above. Stdio may additionally set `:cwd` and a string-to-string
`:env` map; HTTP may set a string-to-string `:headers` map. Unknown options fail
closed. Credentials are never discovered automatically. Configure explicit
headers/environment locally; do not put secrets in command arguments or URLs.
Status output excludes environment/header values and URL query strings.

Stdio launches are available **only** in an explicitly local execution world
whose effective sandbox is `:none`. The client does not wrap arbitrary MCP
processes in the agent's sandbox, so sandboxed and remote execution worlds reject
stdio instead of silently starting a host process outside their boundary. The
approval shows its actual command and working directory. The stdio environment
removes inherited key/token/password/secret and `QI_`/`DSH_` variables before
applying explicit environment entries. HTTP can use an explicitly configured
local MCP endpoint; it has a separate approval boundary from public web fetch.

Use `/mcp status`, `/mcp connect local-docs`, `/mcp refresh local-docs`,
`/mcp disconnect local-docs`, or `/mcp reconnect local-docs`. Connection, refresh,
configuration replacement, discovered tool calls, and resource tools require
project trust and approval. Setting `:enabled true` requests an approved
connection at plugin startup; it does not bypass those checks.

The catalog is discovered with paginated `tools/list`. Model tool names use
`mcp__<server>__<tool>`, with a stable hash for long or unsupported names. Duplicate
or conflicting names reject the replacement catalog. Explicit refresh updates
registrations. Received `notifications/tools/list_changed` marks the catalog
stale; check status and refresh it explicitly. `mcp_resources_list` and
`mcp_resource_read` provide paginated listing and exact-URI text reads. Results
carry source identity, untrusted-content labels, and output limits. Binary,
image/audio, and embedded-resource blocks are omitted with a visible explanation.
Resource and tool approvals are bound to a connection/catalog generation; a
replacement cannot reuse an approval for the previous server generation.

Timeout, cancellation, or a lost response after `tools/call` is dispatched leaves
the result **unknown**. The connection closes and status reports `uncertain`;
there is no automatic reconnect or replay. Inspect external state before an
explicit reconnect. All HTTP response bodies/SSE streams and stdio messages are
bounded. HTTP redirects are disabled. A bounded response does not guarantee a
remote tool performed only bounded work.

## Protocol scope

The general client supports MCP `2026-07-28` discovery and per-request metadata,
including HTTP `Mcp-Method`, `Mcp-Name`, and validated `x-mcp-header` bindings.
Auto mode supports legacy initialize/session negotiation (`2025-03-26`,
`2025-06-18`, `2025-11-25`) for compatible servers; no tool call is retried during
protocol fallback. Existing CUA transport defaults keep their legacy behavior.
HTTP accepts JSON responses and request-scoped SSE, ending at the matching reply.

This is a supported subset, not full MCP conformance: no OAuth credential flow,
persistent GET/subscription stream, resumable SSE, legacy DELETE session cleanup,
prompts, sampling, elicitation/input requests, tasks, or server-initiated requests
are implemented. Task-required tools and unsupported input results fail explicitly.
List-change notifications are processed only on an existing supported stream;
they do not create a background subscription. MCP tool image/audio projection is
text-only; the separate CUA integration retains its existing image handling.

Protocol references: [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
and [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).

## Web configuration

```clojure
{:ns qi.plugins.web-tools
 :config {:curl-path "/usr/bin/curl"
          :timeout-ms 15000
          :max-response-bytes 1048576
          :max-output-chars 30000
          :search {:provider :tavily
                   :enabled false
                   :api-key-env "TAVILY_API_KEY"
                   :max-results 8}}}
```

`web_fetch` retrieves one public HTTP(S) text, HTML, or JSON page. It refuses
userinfo/fragment URLs, local/private/reserved addresses, mixed DNS answers,
noncanonical numeric hostnames (including octal/hex/short IPv4), and redirects.
The vetted DNS answer is pinned for the actual curl connection; environment
proxies and curl user configuration are disabled. IPv6 is restricted to accepted
global-unicast ranges and zone identifiers are rejected. Output includes the
source URL, response status, and truncation indication. Oversized network bodies
fail instead of being partially interpreted.

The HTML text projection removes markup, active elements, explicit hidden
subtrees, and inline `display:none`/`visibility:hidden` content. It does not run
JavaScript or evaluate external CSS; it is not a rendered-page or accessibility
snapshot. Retrieved text and search snippets remain untrusted external data.

`web_search` uses the [Tavily search API](https://docs.tavily.com/documentation/api-reference/endpoint/search).
Enable it explicitly, provide an API key using the named environment variable
(or a local `:api-key`), and approve the search. Only the explicitly named variable
is read, at invocation time. The default endpoint is `https://api.tavily.com/search`;
an override must be public HTTPS. Authorization is passed to curl on standard
input, not process arguments. Requests use basic search, disable automatic search
parameters and answer/image/raw-content additions, and retain source URLs,
snippets, dates when present, and the provider request ID. `:max-results` is 1–20
(default 8). There is no retry after a failed or interrupted paid request.

The curl executable must be configured as an absolute executable path on the
host. `/usr/bin/curl` is the Unix default; configure the appropriate installed
binary on other platforms. No package is installed automatically.

## Host and ACP integration

Load remote-registry before these plugins. Available RPC methods:

| Method | Parameters | Behavior |
| --- | --- | --- |
| `mcp.status` | `{}` | Read-only, no network or credential reads. |
| `mcp.control` | `{server, action}` | `connect`, `reconnect`, `refresh`, or `disconnect`; blocking entry. |
| `mcp.configure` | `{servers: [...]}` | Approved worker-scoped replacement; forces `enabled:false`; blocking entry. |
| `web.status` | `{}` | Read-only, no network or credential reads. |

Remote configuration uses transport strings `stdio`/`streamable-http`; JSON
header/environment keys are normalized to strings. Configuration is not saved to
user files and never automatically connects. An ACP host accepting `mcpServers`
must invoke configure and then explicit connect, surface approval or connection
failure, and avoid claiming an unattached server is ready. Changing the worker's
configuration disconnects previous servers.

The Clojure services `:mcp/runtime` and `:web/runtime` expose these same operations
to trusted host code. Model-facing operations go through the tool policy and
approval pipeline. Status alone does not prove a server's external tool semantics.

## Offline verification

Run the dedicated suites with existing Babashka dependencies:

```sh
bb -cp src:test -e '(require (quote qi.mcp-http-test) (quote qi.mcp-client-test) (quote qi.web-tools-test) (quote qi.mcp-stdio-test) (quote qi.computer-use-test)) (clojure.test/run-tests (quote qi.mcp-http-test) (quote qi.mcp-client-test) (quote qi.web-tools-test) (quote qi.mcp-stdio-test) (quote qi.computer-use-test))'
```

Tests use real local mock HTTP listeners, request-scoped SSE, child stdio fixtures,
and curl against loopback fixtures under test-only DNS injection. They cover
protocol negotiation, headers, catalog replacement, resource access, approval and
sandbox denial, generation changes, limits, cancellation/unknown outcomes, and
CUA regressions. The SSRF regression opens a local listener and asserts numeric
hostname aliases produce zero requests. Search authorization/payload behavior is
mocked; interoperability with external servers and paid search remains unverified.
