# strace-viewer

`strace-viewer` turns a captured Linux `strace` into a browser explorer served locally by `streaky/http-server`. It is a Terrane application: Terrane reads the trace and renders the browser document with `streaky/template` from the HTML, CSS, and JavaScript in `templates/`.

The reusable parser library is `streaky/strace-format`: the application declares it under `[terrane-dependencies.streaky.strace-format]` and imports it from `/streaky/strace-format`.

The trace stays on the local machine. By default the viewer runs a loopback-only HTTP server and prints a URL containing a fresh 12-character access key. An explicit second argument exports a self-contained HTML file instead; share either the URL or an exported document only if the trace is safe to share.

## Build and open a captured trace

Build the HTTP and template consumers, then build the native executable and serve a trace:

```bash
TERRANE="$PWD/../../target/release/terrane" sh ../../packages/http-server/build-consumer.sh
viewer=$(../../target/release/terrane build .)
"$viewer" trace.log
```

Open the URL printed in the console. The server binds `127.0.0.1:0`, so the operating system chooses an available unprivileged port; the viewer reads that listener's actual address and hands the same listener to the HTTP server. No root privileges or configured port are needed. Stop it with `Ctrl-C`.

The `?key=...` value is a new random 12-character URL-safe string each time the server starts. Requests with a missing or incorrect key receive HTTP 403. There are no cookies, login sessions, or public-network listeners; this is a simple local access gate, not an Internet-facing authentication system. Authorized pages are marked `no-store` and do not send referrers. Treat the console URL and browser history as sensitive.

`terrane build` prints the native artifact path. The template consumer compiles `templates/index.html` and its CSS/JavaScript includes into the executable. The binary can run from any directory without the template files; input and output paths resolve from its working directory. Rebuild the application after editing templates, and rebuild the consumers after changing their packages.

For iterative Terrane development, the equivalent one-shot command is:

```bash
../../target/release/terrane run . -- trace.log
```

The viewer provides drag-and-drop and file selection as well, but rendering a trace into the document is the most portable option: the selected trace is already present when the page opens.

### Explicit HTML export

Supply the output filename as the second argument to write a portable document and exit without starting a server:

```bash
"$viewer" trace.log viewer.html
xdg-open viewer.html
```

Exported files embed the trace without an access-key check; anyone who can read the file can inspect it.

## Rendering and verification

The application declares local `streaky/template` and `streaky/http-server` dependencies. Their explicit consumers generate the template engine factory and class-bound HTTP adapter at build time; generated source stays under `.trn/`.

The HTML template retains normal autoescaping for text such as the title. The trace is encoded as a JSON string with `/core/documents::make-document-string`, then every `<` is escaped as `\u003c` before that JSON is inserted with `|safe` in the script element. This keeps control characters, Unicode, quotes, template delimiters, and HTML-looking trace data intact without allowing a trace to close the script element. CSS and JavaScript are trusted, compiled includes, not trace-supplied markup.

The Terrane sources use string `+` for composition and typed empty collections instead of sentinel elements. Runtime dependencies remain compiler-owned; the application requests filesystem/process access, networking, secure entropy for the access key, and the build effect required by the HTTP dependency.

Run the focused rendering, parser, and real-HTTP suites from this directory after building the consumers and viewer:

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
- **Keyboard:** `j`/`k` move through events; `n`/`N` move through search matches; `[`/`]` move between events on the selected descriptor; `/` focuses search.

## Current scope

The current implementation explores captured traces over a keyed local HTTP page or an explicit HTML export. Live stdin ingestion, launching `strace`, and WebSocket updates are not implemented. The reusable `strace-format/` library, CLI/HTTP/rendering code in `src/`, and browser templates remain separate so those future capabilities can reuse the same trace model.
