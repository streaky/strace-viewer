(() => {
  'use strict';
  const ROW_HEIGHT = 28;
  const IO = new Set(['read', 'write', 'pread64', 'pwrite64', 'readv', 'writev', 'recv', 'recvfrom', 'recvmsg', 'send', 'sendto', 'sendmsg']);
  const state = { events: [], visible: [], selected: -1, follow: true, payloadMode: 'text' };
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
    const prefix = text.match(/^(?:(?<first>\d+(?:\.\d+)?)\s+)?(?:(?:\[pid\s+)?(?<second>\d+(?:\.\d+)?)\]?\s+)?(?<call>[A-Za-z_][\w]*)\(/);
    if (!prefix) return null;
    const argsStart = prefix[0].length;
    const close = callEnd(text, argsStart, [')']);
    const tail = close >= 0 ? resultTail(text, close) : null;
    return tail ? { ...prefix.groups, args: text.slice(argsStart, close), ...tail } : null;
  };
  const resumedCall = text => {
    const prefix = text.match(/^(?:(?<first>\d+(?:\.\d+)?)\s+)?(?:(?:\[pid\s+)?(?<second>\d+(?:\.\d+)?)\]?\s+)?<\.\.\.\s+(?<call>[A-Za-z_][\w]*)\s+resumed>\s*,?\s*/);
    if (!prefix) return null;
    const argsStart = prefix[0].length;
    const close = callEnd(text, argsStart);
    const tail = close >= 0 ? resultTail(text, close) : null;
    return tail ? { ...prefix.groups, args: text.slice(argsStart, close), ...tail } : null;
  };
  const parse = (raw, index) => {
    const text = raw.trim();
    const unfinished = text.match(/^(?:(?<first>\d+(?:\.\d+)?)\s+)?(?:(?:\[pid\s+)?(?<second>\d+(?:\.\d+)?)\]?\s+)?(?<call>[A-Za-z_][\w]*)\((?<args>.*)\s+<unfinished \.\.\.>$/);
    if (unfinished) return eventFromGroups(unfinished.groups, index, raw, 'unfinished', '!');
    const resumed = resumedCall(text);
    if (resumed) return eventFromGroups(resumed, index, raw, 'resumed', '*');
    const complete = completeCall(text);
    if (complete) return eventFromGroups(complete, index, raw, 'parsed');
    return { id: index, raw, status: 'raw', syscall: '', args: '', result: '', pid: '', fd: '', payload: '' };
  };
  const loadTrace = text => {
    state.events = text.split(/\r?\n/).filter(line => line !== '').map(parse);
    state.selected = state.events.length ? 0 : -1;
    state.payloadMode = defaultPayloadMode(state.events[state.selected]);
    apply();
    $('capture-status').textContent = `${state.events.length.toLocaleString()} events loaded locally`;
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
  const apply = () => { const matches = matcher(); state.visible = state.events.filter(matches); $('match-summary').textContent = `${state.visible.length.toLocaleString()} / ${state.events.length.toLocaleString()} events`; render(); if (state.selected >= 0 && !state.visible.includes(state.events[state.selected])) state.selected = state.visible.length ? state.visible[0].id : -1; inspect(); };
  const highlight = text => { const query = $('search').value; if (!query || $('regex').checked) return esc(text); const escaped = esc(text), term = esc(query); if (!$('case-sensitive').checked) return escaped.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '$&'); return escaped.replaceAll(term, `<mark>${term}</mark>`); };
  const render = () => { const scroller = $('event-scroller'), rows = $('event-rows'), spacer = $('event-spacer'); spacer.style.height = `${state.visible.length * ROW_HEIGHT}px`; const start = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - 8), end = Math.min(state.visible.length, start + Math.ceil(scroller.clientHeight / ROW_HEIGHT) + 16); rows.innerHTML = state.visible.slice(start, end).map((e, i) => `<button type="button" class="event-row ${e.id === state.selected ? 'selected' : ''}" data-id="${e.id}" style="transform:translateY(${(start + i) * ROW_HEIGHT}px)"><span>${esc(e.timestamp || '—')}</span><span>${esc(e.pid || '—')}</span><span>${esc(e.syscall || 'raw')}</span><span>${esc(e.fd || '—')}</span><span>${esc(e.result || '—')}</span><span class="payload">${highlight(e.payload || e.args || e.raw)}</span></button>`).join(''); };
  const decodeStraceText = value => value.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{2})|(.))/g, (_match, octal, hexadecimal, simple) => {
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    if (hexadecimal) return String.fromCharCode(parseInt(hexadecimal, 16));
    return ({ n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' })[simple] || simple;
  });
  const isBinaryPayload = value => Array.from(value).some(character => {
    const codePoint = character.codePointAt(0);
    return (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) || codePoint === 127 || codePoint > 126;
  });
  const defaultPayloadMode = event => event?.payload && isBinaryPayload(decodeStraceText(event.payload)) ? 'hex' : 'text';
  const hex = value => Array.from(new TextEncoder().encode(value)).map(byte => byte.toString(16).padStart(2, '0')).join(' ');
  const inspect = () => {
    const inspector = $('inspector');
    const event = state.events[state.selected];
    if (!event) {
      inspector.hidden = true;
      inspector.innerHTML = '';
      return;
    }
    inspector.hidden = false;
    const payload = event.payload || '';
    const decodedPayload = decodeStraceText(payload);
    const content = state.payloadMode === 'hex' ? hex(decodedPayload) : decodedPayload;
    const payloadPanel = payload ? `<div class="tabs"><button data-mode="text" class="${state.payloadMode === 'text' ? 'active' : ''}">Text</button><button data-mode="hex" class="${state.payloadMode === 'hex' ? 'active' : ''}">Hex</button></div>${event.truncated ? '<p class="summary">Payload may be truncated by strace.</p>' : ''}<h3>Payload</h3><pre>${esc(content)}</pre>` : '';
    inspector.innerHTML = `<div id="inspector-resizer" role="separator" aria-label="Resize event inspector" aria-orientation="horizontal" tabindex="0"></div><div class="inspector-content"><section class="event-summary"><h2>Event inspector</h2><dl><dt>Syscall</dt><dd>${esc(event.syscall || 'Unparsed')}</dd><dt>PID</dt><dd>${esc(event.pid || '—')}</dd><dt>FD</dt><dd>${esc(event.fd || '—')}</dd><dt>Result</dt><dd>${esc(event.result || '—')}</dd><dt>Duration</dt><dd>${esc(event.duration || '—')}</dd><dt>Source</dt><dd>Line ${event.id + 1}; ${esc(event.status)}</dd></dl></section><section class="event-detail">${payloadPanel}<h3>Raw source</h3><pre>${esc(event.raw)}</pre></section></div>`;
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
  const select = id => {
    state.selected = state.selected === id ? -1 : id;
    state.payloadMode = defaultPayloadMode(state.events[state.selected]);
    render();
    inspect();
    const visibleIndex = state.visible.findIndex(event => event.id === state.selected);
    if (visibleIndex < 0) return;
    const scroller = $('event-scroller');
    const eventTop = visibleIndex * ROW_HEIGHT;
    const eventBottom = eventTop + ROW_HEIGHT;
    if (eventTop < scroller.scrollTop) scroller.scrollTop = eventTop;
    else if (eventBottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = eventBottom - scroller.clientHeight;
  };
  const step = (predicate, direction) => { const current = state.visible.findIndex(event => event.id === state.selected); for (let i = current + direction; i >= 0 && i < state.visible.length; i += direction) if (predicate(state.visible[i])) return select(state.visible[i].id); };
  $('trace-input').addEventListener('change', async event => { const files = [...event.target.files]; loadTrace((await Promise.all(files.map(file => file.text()))).join('\n')); });
  controls.forEach(control => control.addEventListener('input', apply)); controls.forEach(control => control.addEventListener('change', apply));
  $('clear-filters').addEventListener('click', () => { $('search').value = $('pid-filter').value = $('fd-filter').value = $('syscall-filter').value = ''; $('case-sensitive').checked = $('regex').checked = $('io-only').checked = false; apply(); });
  $('event-scroller').addEventListener('scroll', () => { state.follow = false; $('follow-button').setAttribute('aria-pressed', 'false'); render(); });
  $('event-rows').addEventListener('click', event => { const row = event.target.closest('[data-id]'); if (row) select(Number(row.dataset.id)); });
  $('inspector').addEventListener('click', event => { const button = event.target.closest('[data-mode]'); if (button) { state.payloadMode = button.dataset.mode; inspect(); } });
  $('follow-button').addEventListener('click', () => { state.follow = !state.follow; $('follow-button').setAttribute('aria-pressed', String(state.follow)); if (state.follow && state.visible.length) select(state.visible.at(-1).id); });
  document.addEventListener('keydown', event => { if (event.target.matches('input,textarea')) { if (event.key === 'Escape') event.target.blur(); return; } if (event.key === '/') { event.preventDefault(); $('search').focus(); return; } if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); step(() => true, event.key === 'j' ? -1 : 1); } if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); step(() => true, event.key === 'k' ? 1 : -1); } if (event.key === 'n') step(event => $('search').value && matcher()(event), 1); if (event.key === 'N') step(event => $('search').value && matcher()(event), -1); const selected = state.events[state.selected]; if (selected && event.key === ']') step(item => item.fd && item.fd === selected.fd, 1); if (selected && event.key === '[') step(item => item.fd && item.fd === selected.fd, -1); });
  window.addEventListener('dragover', event => event.preventDefault()); window.addEventListener('drop', async event => { event.preventDefault(); const files = [...event.dataTransfer.files]; if (files.length) loadTrace((await Promise.all(files.map(file => file.text()))).join('\n')); });
  if (typeof window.__STRACE_SOURCE__ === 'string' && window.__STRACE_SOURCE__) loadTrace(window.__STRACE_SOURCE__); else apply();
})();
