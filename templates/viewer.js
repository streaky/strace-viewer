(() => {
  'use strict';
  const ROW_HEIGHT = 28;
  const IO = new Set(['read', 'write', 'pread64', 'pwrite64', 'readv', 'writev', 'recv', 'recvfrom', 'recvmsg', 'send', 'sendto', 'sendmsg']);
  const REMOTE = window.__STRACE_REMOTE__ === true;
  const state = { events: [], visible: [], selected: -1, follow: true, payloadMode: 'text', remote: { socket: null, ready: false, failed: false, request: 0, generation: 0, queryId: null, total: 0, matchCount: 0, cache: new Map(), indices: new Map(), pending: new Map() } };
  const $ = id => document.getElementById(id);
  const controls = ['search', 'case-sensitive', 'regex', 'pid-filter', 'fd-filter', 'syscall-filter', 'io-only'].map($);
    const INSPECTOR_HEIGHT_KEY = 'strace-viewer.inspector-height';
    try {
      const savedHeight = Number(localStorage.getItem(INSPECTOR_HEIGHT_KEY));
      if (Number.isFinite(savedHeight) && savedHeight >= 160) $('inspector').style.height = `${savedHeight}px`;
    } catch {}
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const eventFromGroups = (groups, index, raw, status, marker = '') => {
    const first = groups.first || '';
    const second = groups.second || '';
    const timestamp = first.includes('.') ? first : second.includes('.') ? second : '';
    const pid = first && !first.includes('.') ? first : second && !second.includes('.') ? second : '';
    const args = groups.args || '';
    const fd = (args.match(/^(-?\d+)(?:<[^>]*>)?/) || [])[1] || '';
    const quoted = args.match(/"((?:\\.|[^"\\])*)"/);
    const payload = quoted ? quoted[1] : '';
    const result = groups.result || '';
    const actual = (result.match(/^-?\d+/) || [])[0] || '';
    return { id: index, raw, status, syscall: `${marker}${groups.call}`, args, result, actual, pid, timestamp, duration: groups.duration || '', fd, payload, truncated: /\.\.\./.test(args) };
  };
  const callEnd = (text, start, pending = []) => {
    const expected = [...pending], closesInitialCall = expected.length > 0;
    let quote = '';
    let escaped = false;
    for (let offset = start; offset < text.length; offset += 1) {
      const character = text[offset];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '(') { expected.push(')'); continue; }
      if (character === '[') { expected.push(']'); continue; }
      if (character === '{') { expected.push('}'); continue; }
      if (character === ')' || character === ']' || character === '}') {
        if (expected.length) {
          if (character !== expected.at(-1)) return -1;
          expected.pop();
          if (closesInitialCall && !expected.length) return offset;
        } else if (character === ')') return offset;
      }
    }
    return -1;
  };
  const resultTail = (text, close) => text.slice(close + 1).match(/^\s+=\s+(?<result>.*?)(?:\s+<(?<duration>[\d.]+)>\s*)?$/)?.groups || null;
  const completeCall = text => {
    const prefix = text.match(/^(?:(?:\[pid\s+)?(?<first>\d+(?:\.\d+)?)\]?\s+)?(?:(?:\[pid\s+)?(?<second>\d+(?:\.\d+)?)\]?\s+)?(?<call>[A-Za-z_][\w]*)\(/);
    if (!prefix) return null;
    const argsStart = prefix[0].length;
    const close = callEnd(text, argsStart, [')']);
    const tail = close >= 0 ? resultTail(text, close) : null;
    return tail ? { ...prefix.groups, args: text.slice(argsStart, close), ...tail } : null;
  };
  const resumedCall = text => {
    const prefix = text.match(/^(?:(?:\[pid\s+)?(?<first>\d+(?:\.\d+)?)\]?\s+)?(?:(?:\[pid\s+)?(?<second>\d+(?:\.\d+)?)\]?\s+)?<\.\.\.\s+(?<call>[A-Za-z_][\w]*)\s+resumed>\s*,?\s*/);
    if (!prefix) return null;
    const argsStart = prefix[0].length;
    const close = callEnd(text, argsStart);
    const tail = close >= 0 ? resultTail(text, close) : null;
    return tail ? { ...prefix.groups, args: text.slice(argsStart, close), ...tail } : null;
  };
  const parse = (raw, index) => {
    const text = raw.trim();
    const unfinished = text.match(/^(?:(?:\[pid\s+)?(?<first>\d+(?:\.\d+)?)\]?\s+)?(?:(?:\[pid\s+)?(?<second>\d+(?:\.\d+)?)\]?\s+)?(?<call>[A-Za-z_][\w]*)\((?<args>.*)\s+<unfinished \.\.\.>$/);
    if (unfinished) return eventFromGroups(unfinished.groups, index, raw, 'unfinished', '!');
    const resumed = resumedCall(text);
    if (resumed) return eventFromGroups(resumed, index, raw, 'resumed', '*');
    const complete = completeCall(text);
    if (complete) return eventFromGroups(complete, index, raw, 'parsed');
    return { id: index, raw, status: 'raw', syscall: '', args: '', result: '', pid: '', fd: '', payload: '' };
  };
  const loadTrace = text => {
    remote.localMode = true;
    remote.generation++;
    clearTimeout(remote.queryTimer);
    const socket = remote.socket;
    remote.socket = null;
    socket?.close();
    rejectPending('Capture changed');
    remote.cache.clear();
    remote.indices.clear();
    remote.selectedRow = null;
    state.events = [];
    text.split(/\r?\n/).forEach((raw, line) => {
      if (raw.trim()) state.events.push({ ...parse(raw, state.events.length), lineNumber: line + 1 });
    });
    state.selected = state.events.length ? 0 : -1;
    state.payloadMode = defaultPayloadMode(state.events[state.selected]);
    apply();
    $('capture-status').textContent = `${state.events.length.toLocaleString()} events loaded locally`;
  };
  const remote = state.remote;
  Object.assign(remote, { localMode: false, selectedIndex: -1, selectedRow: null, loading: new Set(), flights: 0, navigation: Promise.resolve() });
  const isRemote = () => REMOTE && !remote.localMode;
  const visibleCount = () => isRemote() ? remote.matchCount : state.visible.length;
  const selectedEvent = () => isRemote() ? remote.selectedRow : state.events[state.selected];
  const cacheRow = row => {
    remote.cache.delete(row.id);
    remote.cache.set(row.id, row);
    while (remote.cache.size > 2048) remote.cache.delete(remote.cache.keys().next().value);
  };
  const rowAt = index => {
    const row = remote.cache.get(remote.indices.get(index));
    if (row) cacheRow(row);
    return row;
  };
  const cacheIndex = (index, row) => {
    remote.indices.delete(index);
    remote.indices.set(index, row.id);
    while (remote.indices.size > 2048) remote.indices.delete(remote.indices.keys().next().value);
    cacheRow(remote.cache.get(row.id) || row);
  };
  const remoteRequest = (type, fields, generation) => {
    if (!remote.ready || remote.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Error('Capture connection closed; reload to reconnect'));
    const requestId = ++remote.request;
    return new Promise((resolve, reject) => {
      remote.pending.set(requestId, { resolve, reject, generation });
      remote.socket.send(JSON.stringify({ type, requestId, ...fields }));
    });
  };
  const rejectPending = message => {
    for (const request of remote.pending.values()) request.reject(Error(message));
    remote.pending.clear();
  };
  const showRemoteError = (error, generation) => {
    if (!isRemote() || generation !== remote.generation) return;
    remote.failed = true;
    $('capture-status').textContent = error.message;
  };
  const connectRemote = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const key = new URLSearchParams(location.search).get('key') || '';
    const socket = new WebSocket(`${protocol}//${location.host}/events/${encodeURIComponent(key)}`);
    remote.socket = socket;
    socket.addEventListener('open', () => { if (remote.socket === socket) remote.ready = true; });
    socket.addEventListener('message', message => {
      if (remote.socket !== socket) return;
      let data;
      try { data = JSON.parse(message.data); } catch { showRemoteError(Error('Invalid capture response'), remote.generation); return; }
      if (data.type === 'capture') {
        remote.total = data.total;
        $('capture-status').textContent = `${remote.total.toLocaleString()} events available`;
        apply();
        return;
      }
      const request = remote.pending.get(data.requestId);
      if (!request) return;
      remote.pending.delete(data.requestId);
      if (request.generation !== remote.generation) request.reject(Error('Capture changed'));
      else if (data.type === 'error') request.reject(Error(data.message));
      else request.resolve(data);
    });
    const disconnected = () => {
      if (remote.socket !== socket) return;
      remote.ready = false;
      remote.failed = true;
      rejectPending('Capture connection closed; reload to reconnect');
      $('capture-status').textContent = 'Capture connection closed; reload to reconnect';
    };
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', disconnected);
  };
  const currentQuery = () => ({
    search: $('search').value, caseSensitive: $('case-sensitive').checked, regex: $('regex').checked,
    pid: $('pid-filter').value.trim(), fd: $('fd-filter').value.trim(), syscall: $('syscall-filter').value.trim(),
    ioOnly: $('io-only').checked
  });
  const remoteApply = () => {
    clearTimeout(remote.queryTimer);
    const generation = ++remote.generation;
    remote.queryId = null;
    remote.failed = false;
    remote.indices.clear();
    remote.loading = new Set();
    remote.flights = 0;
    remote.matchCount = 0;
    remote.autoSelect = true;
    remote.selectedIndex = -1;
    remote.selectedRow = null;
    state.selected = -1;
    $('event-scroller').scrollTop = 0;
    $('match-summary').textContent = 'Searching…';
    render();
    inspect();
    if (!remote.ready) return;
    remote.queryTimer = setTimeout(async () => {
      try {
        const data = await remoteRequest('query', currentQuery(), generation);
        if (generation !== remote.generation || !isRemote()) return;
        remote.queryId = data.queryId;
        remote.matchCount = data.count;
        $('capture-status').textContent = `${remote.total.toLocaleString()} events available`;
        $('match-summary').textContent = `${remote.matchCount.toLocaleString()} / ${remote.total.toLocaleString()} events`;
        render();
      } catch (error) {
        if (generation === remote.generation && isRemote()) $('match-summary').textContent = error.message;
        showRemoteError(error, generation);
      }
    }, 100);
  };
  // At most two viewport requests are in flight. Fast scrolling replaces demand;
  // it never queues a download of the intermediate parts of the capture.
  const requestWindow = (start, end) => {
    if (remote.queryId === null || remote.failed || !remote.ready) return;
    for (let index = start; index < end && remote.flights < 2; index++) {
      if (rowAt(index) || remote.loading.has(index)) continue;
      const first = index;
      while (index < end && index - first < 256 && !rowAt(index) && !remote.loading.has(index)) index++;
      const limit = index - first, generation = remote.generation, loading = remote.loading;
      for (let i = first; i < index; i++) loading.add(i);
      remote.flights++;
      remoteRequest('rows', { queryId: remote.queryId, start: first, limit }, generation).then(data => {
        if (generation !== remote.generation || !isRemote()) return;
        data.rows.forEach((row, offset) => cacheIndex(data.start + offset, row));
        if (remote.autoSelect && data.start === 0 && data.rows.length) {
          remote.autoSelect = false;
          remote.selectedIndex = 0;
          remote.selectedRow = rowAt(0);
          state.selected = remote.selectedRow.id;
          state.payloadMode = defaultPayloadMode(remote.selectedRow);
          inspect();
        }
      }).catch(error => showRemoteError(error, generation)).finally(() => {
        for (let i = first; i < first + limit; i++) loading.delete(i);
        if (generation === remote.generation && isRemote()) { remote.flights--; render(); }
      });
    }
  };
  const reveal = index => {
    const scroller = $('event-scroller'), top = index * ROW_HEIGHT;
    const previous = scroller.scrollTop;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
    if (scroller.scrollTop !== previous) state.revealScrollTop = scroller.scrollTop;
  };
  const remoteStep = (direction, fd = '', from = null) => {
    const generation = remote.generation;
    remote.navigation = remote.navigation.then(async () => {
      if (generation !== remote.generation || !isRemote() || remote.queryId === null) return;
      const data = await remoteRequest('seek', { queryId: remote.queryId, from: from ?? remote.selectedIndex, direction, fd }, generation);
      if (generation !== remote.generation || !isRemote() || data.index < 0) return;
      cacheIndex(data.index, data.row);
      remote.autoSelect = false;
      remote.selectedIndex = data.index;
      remote.selectedRow = rowAt(data.index);
      state.selected = remote.selectedRow.id;
      state.payloadMode = defaultPayloadMode(remote.selectedRow);
      reveal(data.index);
      render();
      inspect();
    }).catch(error => showRemoteError(error, generation));
  };
  const syscallName = event => event.syscall.replace(/^[*!]/, '');
  const matcher = () => {
    const query = $('search').value;
    let pattern = null;
    if (query) { try { pattern = $('regex').checked ? new RegExp(query, $('case-sensitive').checked ? 'g' : 'gi') : null; } catch { $('match-summary').textContent = 'Invalid regular expression'; return () => false; } }
    const needle = $('case-sensitive').checked ? query : query.toLocaleLowerCase();
    const pid = $('pid-filter').value.trim(), fd = $('fd-filter').value.trim(), call = $('syscall-filter').value.trim();
    return event => {
      const syscall = syscallName(event);
      if (pid && event.pid !== pid) return false;
      if (fd && event.fd !== fd) return false;
      if (call && !(call.endsWith('*') ? syscall.startsWith(call.slice(0, -1)) : syscall === call)) return false;
      if ($('io-only').checked && !IO.has(syscall)) return false;
      if (!query) return true;
      const haystack = [event.raw, event.args, event.payload].join('\n');
      if (pattern) { pattern.lastIndex = 0; return pattern.test(haystack); }
      return ($('case-sensitive').checked ? haystack : haystack.toLocaleLowerCase()).includes(needle);
    };
  };
  const highlight = text => { const query = $('search').value; if (!query || $('regex').checked) return esc(text); const escaped = esc(text), term = esc(query); if (!$('case-sensitive').checked) return escaped.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '$&'); return escaped.replaceAll(term, `<mark>${term}</mark>`); };
  const render = () => {
    const scroller = $('event-scroller'), rows = $('event-rows'), spacer = $('event-spacer');
    const count = visibleCount();
    spacer.style.height = `${count * ROW_HEIGHT}px`;
    const start = Math.max(0, Math.min(count, Math.floor(scroller.scrollTop / ROW_HEIGHT) - 8));
    const end = Math.min(count, start + Math.ceil(scroller.clientHeight / ROW_HEIGHT) + 16);
    const output = [];
    for (let index = start; index < end; index++) {
      const event = isRemote() ? rowAt(index) : state.visible[index];
      if (event) output.push(`<button type="button" class="event-row ${event.id === state.selected ? 'selected' : ''}" data-id="${event.id}" style="transform:translateY(${index * ROW_HEIGHT}px)"><span>${esc(event.timestamp || '—')}</span><span>${esc(event.pid || '—')}</span><span>${esc(event.syscall || 'raw')}</span><span>${esc(event.fd || '—')}</span><span>${esc(event.result || '—')}</span><span class="payload">${highlight(event.payload || event.args || event.raw)}</span></button>`);
    }
    rows.innerHTML = output.join('');
    if (isRemote()) requestWindow(start, end);
  };
  const decodeStraceText = value => value.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{2})|(.))/g, (_match, octal, hexadecimal, simple) => {
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    if (hexadecimal) return String.fromCharCode(parseInt(hexadecimal, 16));
    return ({ n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' })[simple] || simple;
  });
  const isBinaryPayload = value => Array.from(value).some(character => {
    const codePoint = character.codePointAt(0);
    return (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) || codePoint === 127 || codePoint > 126;
  });
  const payloadText = event => event ? (event.decodedPayload ??= decodeStraceText(event.payload || '')) : '';
  const defaultPayloadMode = event => event?.payload && isBinaryPayload(payloadText(event)) ? 'hex' : 'text';
  const hex = value => Array.from(new TextEncoder().encode(value)).map(byte => byte.toString(16).padStart(2, '0')).join(' ');
  const inspect = () => {
    const inspector = $('inspector');
    const event = selectedEvent();
    if (!event) {
      inspector.hidden = true;
      inspector.innerHTML = '';
      return;
    }
    inspector.hidden = false;
    const payload = event.payload || '';
    const decodedPayload = payloadText(event);
    const content = state.payloadMode === 'hex' ? (event.hexPayload ??= hex(decodedPayload)) : decodedPayload;
    const payloadPanel = payload ? `<div class="tabs"><button data-mode="text" class="${state.payloadMode === 'text' ? 'active' : ''}">Text</button><button data-mode="hex" class="${state.payloadMode === 'hex' ? 'active' : ''}">Hex</button></div>${event.truncated ? '<p class="summary">Payload may be truncated by strace.</p>' : ''}<h3>Payload</h3><pre>${esc(content)}</pre>` : '';
    inspector.innerHTML = `<div id="inspector-resizer" role="separator" aria-label="Resize event inspector" aria-orientation="horizontal" tabindex="0"></div><div class="inspector-content"><section class="event-summary"><h2>Event inspector</h2><dl><dt>Syscall</dt><dd>${esc(event.syscall || 'Unparsed')}</dd><dt>PID</dt><dd>${esc(event.pid || '—')}</dd><dt>FD</dt><dd>${esc(event.fd || '—')}</dd><dt>Result</dt><dd>${esc(event.result || '—')}</dd><dt>Duration</dt><dd>${esc(event.duration || '—')}</dd><dt>Source</dt><dd>Line ${event.lineNumber || event.id + 1}; ${esc(event.status)}</dd></dl></section><section class="event-detail">${payloadPanel}<h3>Raw source</h3><pre>${esc(event.raw)}</pre></section></div>`;
    const resizer = $('inspector-resizer');
    resizer.addEventListener('pointerdown', start => {
      const startHeight = inspector.getBoundingClientRect().height;
      const onMove = move => {
        const nextHeight = Math.max(160, Math.min(window.innerHeight - 54, startHeight + start.clientY - move.clientY));
        inspector.style.height = `${nextHeight}px`;
      };
      const onEnd = () => {
        try {
          localStorage.setItem(INSPECTOR_HEIGHT_KEY, inspector.getBoundingClientRect().height.toString());
        } catch {}
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
    });
  };
  const apply = () => {
    if (isRemote()) return remoteApply();
    const matches = matcher();
    state.visible = state.events.filter(matches);
    $('match-summary').textContent = `${state.visible.length.toLocaleString()} / ${state.events.length.toLocaleString()} events`;
    if (state.selected >= 0 && !state.visible.includes(state.events[state.selected])) state.selected = state.visible.length ? state.visible[0].id : -1;
    render();
    inspect();
  };
  const select = id => {
    if (isRemote()) {
      const index = [...remote.indices].find(([, eventId]) => eventId === id)?.[0];
      const row = remote.cache.get(id);
      if (index === undefined || !row) return;
      remote.autoSelect = false;
      const deselect = state.selected === id;
      remote.selectedIndex = deselect ? -1 : index;
      remote.selectedRow = deselect ? null : row;
      state.selected = deselect ? -1 : id;
      state.payloadMode = defaultPayloadMode(row);
      if (!deselect) reveal(index);
    } else {
      state.selected = state.selected === id ? -1 : id;
      state.payloadMode = defaultPayloadMode(selectedEvent());
      const index = state.visible.findIndex(row => row.id === state.selected);
      if (index >= 0) reveal(index);
    }
    render();
    inspect();
  };
  const step = (direction, fd = '') => {
    if (isRemote()) return remoteStep(direction, fd);
    const current = state.visible.findIndex(row => row.id === state.selected);
    for (let index = current + direction; index >= 0 && index < state.visible.length; index += direction) {
      if (!fd || state.visible[index].fd === fd) return select(state.visible[index].id);
    }
  };
  $('trace-input').addEventListener('change', async event => { const files = [...event.target.files]; loadTrace((await Promise.all(files.map(file => file.text()))).join('\n')); });
  controls.forEach(control => control.addEventListener('input', apply));
  $('clear-filters').addEventListener('click', () => { $('search').value = $('pid-filter').value = $('fd-filter').value = $('syscall-filter').value = ''; $('case-sensitive').checked = $('regex').checked = $('io-only').checked = false; apply(); });
  $('event-scroller').addEventListener('scroll', () => {
    if ($('event-scroller').scrollTop !== state.revealScrollTop) {
      state.follow = false;
      $('follow-button').setAttribute('aria-pressed', 'false');
    }
    state.revealScrollTop = null;
    render();
  });
  $('event-rows').addEventListener('click', event => { const row = event.target.closest('[data-id]'); if (row) select(Number(row.dataset.id)); });
  $('inspector').addEventListener('click', event => { const button = event.target.closest('[data-mode]'); if (button) { state.payloadMode = button.dataset.mode; inspect(); } });
  $('follow-button').addEventListener('click', () => {
    state.follow = !state.follow;
    $('follow-button').setAttribute('aria-pressed', String(state.follow));
    if (!state.follow || !visibleCount()) return;
    if (isRemote()) remoteStep(1, '', remote.matchCount - 2);
    else if (state.selected !== state.visible.at(-1).id) select(state.visible.at(-1).id);
    else reveal(state.visible.length - 1);
  });
  document.addEventListener('keydown', event => {
    if (event.target.matches('input,textarea')) { if (event.key === 'Escape') event.target.blur(); return; }
    if (event.key === '/') { event.preventDefault(); $('search').focus(); return; }
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); step(event.key === 'j' ? -1 : 1); }
    if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); step(event.key === 'k' ? 1 : -1); }
    if (event.key === 'n' && $('search').value) step(1);
    if (event.key === 'N' && $('search').value) step(-1);
    const selected = selectedEvent();
    if (selected?.fd && event.key === ']') step(1, selected.fd);
    if (selected?.fd && event.key === '[') step(-1, selected.fd);
  });
  window.addEventListener('resize', render);
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', async event => { event.preventDefault(); const files = [...event.dataTransfer.files]; if (files.length) loadTrace((await Promise.all(files.map(file => file.text()))).join('\n')); });
  if (REMOTE) connectRemote();
  else if (typeof window.__STRACE_SOURCE__ === 'string') loadTrace(window.__STRACE_SOURCE__);
  else apply();
})();
