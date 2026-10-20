# strace-viewer

`strace-viewer` turns a captured Linux `strace` into a browser explorer. It is a Terrane application: the default HTTP response contains only the UI shell, with HTML, CSS, and JavaScript compiled by `streaky/template`. The browser requests decoded rows over an access-key-protected WebSocket as it needs them. Explicit HTML export remains self-contained and embeds its capture for offline use.

The reusable parser library is `streaky/strace-format`: the application declares it under `[terrane-dependencies.streaky.strace-format]` and imports it from `/streaky/strace-format`.

By default the viewer serves only this machine over loopback and prints a URL containing a fresh 12-character access key. You can opt into LAN serving with a bind option or user configuration. An explicit second argument exports a self-contained HTML file instead; share either the URL or an exported document only if the trace is safe to share.

## Build and open a captured trace

Build the HTTP and template consumers, then build the native executable and serve a trace:

```bash
TERRANE="$PWD/../../target/release/terrane" sh ../../packages/http-server/build-consumer.sh
viewer=$(../../target/release/terrane build .)
"$viewer" trace.log
```

Open the URL printed in the console. Without configuration or options, the server binds `127.0.0.1:0`, so the operating system chooses an available unprivileged port; the viewer reads that listener's actual address and hands the same listener to the HTTP server. No root privileges or configured port are needed for this default. Stop it with `Ctrl-C`.

The `?key=...` value is a new random 12-character URL-safe string each time the server starts. Requests with a missing or incorrect key receive HTTP 403. There are no cookies or login sessions; this is a simple access gate, not an Internet-facing authentication system. Authorized pages are marked `no-store` and do not send referrers. Treat the console URL and browser history as sensitive.

`terrane build` prints the native artifact path. The template consumer compiles `templates/index.html` and its CSS/JavaScript includes into the executable. The binary can run from any directory without the template files; input and output paths resolve from its working directory. Rebuild the application after editing templates, and rebuild the consumers after changing their packages.

The viewer renders a small overscanned window of rows, highlights matches, and supports raw source inspection. HTTP serving, decoding, filters, and cross-capture navigation run in Terrane; the browser requests only the row windows it displays. Selecting an event opens a resizable inspector with a structured summary and text/hex views. Payload text is decoded when inspected and cached with the row. Text buffers open in text mode, while buffers containing binary/non-printable data default to hex; the toggle remains available for either.

For iterative Terrane development, the equivalent one-shot command is:

```bash
../../target/release/terrane run . -- trace.log
```

The viewer also supports drag-and-drop and local file selection. Served captures are delivered on demand; explicit HTML export embeds a capture when a portable offline document is needed.

### LAN serving and user configuration

Override the bind IP and/or port for one run:

```bash
"$viewer" --bind 192.168.1.20 --port 8080 trace.log
"$viewer" --bind 0.0.0.0 trace.log
"$viewer" --bind ::1 --port 8080 trace.log
```

Use an IP assigned to the server to restrict listening to that interface. `0.0.0.0` listens on all IPv4 interfaces; `::` listens on the IPv6 wildcard address, with IPv4 acceptance depending on the host. For a wildcard address, replace the wildcard host in the printed URL with the server's LAN IP when opening it from another machine. IPv6 URLs include brackets automatically.

For persistent settings, create `~/.config/strace-viewer/config.yaml` yourself. If `XDG_CONFIG_HOME` is set to an absolute path, the viewer uses `$XDG_CONFIG_HOME/strace-viewer/config.yaml` instead. Empty or relative `XDG_CONFIG_HOME` values fall back to `$HOME/.config`, following the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). The viewer does not create config files or directories automatically.

```yaml
server:
  bind: 192.168.1.20
  port: 8080
```

Precedence is **CLI options > config file > built-in defaults**, independently for each setting. Omitted fields retain the defaults: `server.bind: 127.0.0.1` and `server.port: 0`. The bind value must be a numeric IPv4 or IPv6 address; port is an integer from 0 to 65535, with 0 requesting an OS-assigned port. A configured fixed port is used exactly—if it cannot be bound, startup fails rather than silently choosing another. Low ports may require additional operating-system privileges.

The file must be a YAML mapping; unknown keys, invalid values, malformed YAML, and unreadable existing files stop serving with a diagnostic identifying the file. A missing file is normal. Configuration is loaded when the server starts, not watched for changes. `--help` lists the command-line options.

LAN binding is opt-in and still requires the access key. HTTP is not encrypted: use a trusted local network and do not expose the viewer directly to the public Internet.

### Explicit HTML export


Supply the output filename as the second argument to write a portable document and exit without starting a server. Export and `--help` do not load server configuration; `--bind` and `--port` apply only to serving and cannot be combined with an output filename:

```bash
"$viewer" trace.log viewer.html
xdg-open viewer.html
```

Exported files embed the trace without an access-key check; anyone who can read the file can inspect it.

## On-demand capture delivery

The server reads and decodes a captured file once and retains it in memory. This is on-demand **network delivery**, not file-backed paging or live stdin capture. Search and PID/FD/syscall/I/O filters run over the entire server-side capture, including rows the browser has never loaded. Regular-expression searches use an ECMAScript-compatible engine, including lookarounds.

The browser requests the visible range plus a small overscan, with at most two row-window requests in flight. Each row includes its full payload and raw source—there is no separate payload chunking protocol. Decoded rows use a 2,048-entry cache; inspected text/hex representations are cached with their rows. Match-index mappings are also bounded, and a selected row remains available to the inspector. Returning to a cached viewport does not download those rows again.

The WebSocket uses the same host and port as the page, at `/events/<access-key>`. Text JSON messages carry a `type` and a client `requestId`; query responses supply a connection-local `queryId`. Each connection owns its filters and match list.

| Message | Behavior |
| --- | --- |
| `capture` | Server announces the event count and `complete: true` for the recorded file; sends no rows. |
| `query` | Replace search/filter criteria; return a query ID and matching count, not the full match list. |
| `rows` | Request a match-index `start` and `limit` of 1–256; return only that window's full decoded rows. |
| `seek` | Find the next/previous matching row, optionally with the selected FD; return its match index and row, including when it is uncached. |
| `error` | Reject malformed requests, invalid patterns, or stale query IDs without returning stale row data. |

Filter changes invalidate outstanding results; rapid scrolling replaces viewport demand rather than queuing every intermediate range. Uploading or dropping a local file disconnects the server-backed capture and uses local/offline browsing. A connection failure is shown in the viewer; reload to reconnect.

Stable event IDs and the capture/query/window separation let a future live-input producer reuse this transport without changing row rendering. Live piped input and append notifications are not implemented yet.

## Rendering and verification

The application declares local `streaky/template` and `streaky/http-server` dependencies. Their explicit consumers generate the template engine factory and class-bound HTTP adapter at build time; generated source stays under `.trn/`.

The HTML template retains normal autoescaping for text such as the title. In offline export only, the trace is encoded as a JSON string with `/core/documents::make-document-string`, then every `<` is escaped as `\u003c` before that JSON is inserted with `|safe` in the script element. Served mode assigns an empty source string instead. Both paths keep trace data out of executable markup; row rendering uses text escaping. CSS and JavaScript are trusted, compiled includes, not trace-supplied markup.

The Terrane sources use string `+` for composition and typed empty collections instead of sentinel elements. Runtime dependencies remain compiler-owned; the application requests filesystem/process access, networking, secure entropy for the access key, threaded HTTP workers, and the build effect required by the HTTP dependency.

Run the focused rendering/decoding, parser, and real HTTP/WebSocket suites from this directory after building the consumers and viewer:

```bash
../../target/release/terrane test .
../../target/release/terrane test strace-format
python tests/integration/test_server.py "$viewer"
```


## Capture a new program

Use a large string limit when payloads matter, timestamps and durations for ordering/latency, and descriptor annotations for the inspector. `-f` follows threads and any children created through `fork`, `vfork`, or `clone`. The examples use `sudo`, which is normally necessary when attaching to another process and avoids ptrace-policy surprises. The resulting trace is root-owned, so return it to the invoking user before rendering it.

```bash
sudo strace \
  -f -ttt -T -yy -s 65535 \
  -o trace.log \
  -- ./your-program --with-arguments
sudo chown "$USER":"$(id -gn)" trace.log

"$viewer" trace.log
```

The `-o` option is important: it keeps the trace separate from the program's ordinary standard output and standard error. Increase `-s 65535` if the application writes larger request bodies or other payloads that you need to inspect. No `strace` option can recover bytes that the kernel call did not capture or that `strace` truncated.

For a trace that you plan to inspect heavily, this is a good default:

```bash
sudo strace -f -ttt -T -yy -s 65535 -o trace.log -- ./your-program
```

## Attach to an existing PID and follow children

Attach to a running process with `-p`. Combining it with `-f` follows children created after the attachment:

```bash
pid=4182
sudo strace -f -ttt -T -yy -s 65535 -o trace.log -p "$pid"
sudo chown "$USER":"$(id -gn)" trace.log
```

Stop `strace` with `Ctrl-C` when the interesting behaviour has happened, then render `trace.log` as above.

Existing children are not necessarily newly created while `strace` is attached. If the process already has a descendant tree that must be included, attach to the root and each currently discovered descendant, while retaining `-f` for new descendants:

```bash
descendants() {
  local child
  for child in $(pgrep -P "$1"); do
    printf '%s\n' "$child"
    descendants "$child"
  done
}

pid=4182
sudo strace -f -ttt -T -yy -s 65535 -o trace.log \
  -p "$pid" $(descendants "$pid" | sed 's/^/-p /')
sudo chown "$USER":"$(id -gn)" trace.log
```

Processes may exit or spawn while this list is being assembled; that is normal. Re-run the command if the workload starts a separate process tree after attachment. Linux ptrace policy and process ownership can also prevent an attachment. `sudo` grants the needed inspection authority, but only use it when you are authorised to inspect the target process and handle the captured data.

## Explore the trace

- **Search** matches raw trace source, syscall arguments, and quoted payloads. Choose case-sensitive literal matching or regular expressions.
- **Filters** combine PID, FD, syscall (including a `read*`-style suffix wildcard), and I/O-only selection.
- **Select an event** to inspect its text, escaped, hexadecimal, and exact raw-source representations. A payload marked as truncated is not presented as complete.
- **Keyboard navigation** uses arrows or `j`/`k` for rows, `n`/`N` for search matches, `[`/`]` for matching descriptors, and `/` to focus search. Descriptor navigation spans uncached rows in served captures.

## Current scope

The current implementation explores recorded traces using on-demand WebSocket delivery behind a keyed HTTP page (loopback by default, configurable LAN binding), or a self-contained offline HTML export. The server still keeps the recorded capture in memory. Live stdin ingestion, launching `strace`, and live append notifications are not implemented. The transport separates capture state, queries, and row windows so a future live producer can reuse it.
