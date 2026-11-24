const toggle = document.querySelector('#persistent');
const help = document.querySelector('#help');
const closeHelp = document.querySelector('#close-help');
const autoUnlink = document.querySelector('#auto-unlink');
const unlinkKey = 'com.example.loop_lock.autoUnlink';
let syncLink = () => {};
try {
  autoUnlink.checked = globalThis.localStorage?.getItem(unlinkKey) !== 'false';
} catch {
  autoUnlink.checked = true;
}
autoUnlink.onchange = () => {
  try {
    globalThis.localStorage?.setItem(unlinkKey, String(autoUnlink.checked));
  } catch {
    // The preference still works for the open panel.
  }
  syncLink();
};
closeHelp.onclick = () => {
  help.open = false;
  help.querySelector('summary').focus();
};
const update = document.querySelector('#update');
const rangeLabel = document.querySelector('#range');
const status = document.querySelector('#status');
const { readLoop, restoreLoopBounds, observeNativeRange, readOrangeLoop, startsPastLoop } = AddOnLogic;

let disconnectSession = () => {};
let generation = 0;
let boundSession = Symbol('not bound');

async function bindSession(luna) {
  const session = luna.sessions.current();
  if (session === boundSession) return;
  boundSession = session;
  const binding = ++generation;
  disconnectSession();
  toggle.disabled = true;
  toggle.setAttribute('aria-pressed', 'false');
  update.hidden = true;
  rangeLabel.textContent = '—';
  if (!session) {
    status.textContent = 'Open a session in LUNA.';
    return;
  }
  await session.ready();
  if (binding !== generation) return;

  const { transport, context } = session;
  let locked = null;
  let pending = false;
  let working = false;
  let changedDuringWrite = false;
  let disposed = false;
  let error = '';
  let cursor = null;
  let stopObserving = () => {};
  let previousLink;
  let linkUpdate = Promise.resolve();

  function reconcileLink() {
    linkUpdate = linkUpdate.then(async () => {
      const link = context.linkEditAndPlay;
      if (!disposed && locked && autoUnlink.checked) {
        if (previousLink === undefined) previousLink = link.value;
        if (previousLink !== undefined && link.value !== false) await link.set(false);
      } else if (previousLink !== undefined) {
        if (link.value !== previousLink) await link.set(previousLink);
        previousLink = undefined;
      }
    }).catch((cause) => {
      if (!disposed) {
        error = cause.message;
        render();
      }
    });
  }
  syncLink = reconcileLink;

  function readEditRange() {
    const start = context.selectionStart.value;
    const stop = context.selectionStop.value;
    return Number.isFinite(start) && Number.isFinite(stop) && start < stop ? { start, stop } : null;
  }

  function render() {
    const orange = readOrangeLoop(context);
    const range = locked ?? readLoop(transport) ?? orange;
    const format = (tick) => session.musical.timeline.formatBarBeat(tick);
    rangeLabel.textContent = range ? `${format(range.start)} – ${format(range.stop)}` : '—';
    toggle.disabled = !locked && (!range || transport.playing.value || transport.recordEnabled.value);
    toggle.setAttribute('aria-pressed', String(Boolean(locked)));
    update.hidden = !locked;
    update.disabled = !readEditRange() || transport.recordEnabled.value;
    let message = 'Set a loop range to enable Persistent Loop.';
    if (locked) {
      if (!transport.looping.value) message = 'Cycle is off. Orange range remembered.';
      else if (startsPastLoop(transport, locked)) message = 'Cursor is past the loop end. Playback runs forward.';
      else message = 'Orange loop range is preserved while you edit.';
    }
    status.textContent = error || message;
  }

  function schedule() {
    if (pending || !locked || disposed) return;
    if (working) {
      changedDuringWrite = true;
      return;
    }
    pending = true;
    queueMicrotask(async () => {
      pending = false;
      if (!locked || disposed || transport.recordEnabled.value || transport.punchedIn.value) return;
      const range = locked;
      const active = () => locked === range && !disposed && !transport.recordEnabled.value;
      working = true;
      changedDuringWrite = false;
      try {
        if (cursor !== null && !transport.playing.value) {
          const next = cursor;
          cursor = null;
          if (transport.playStart.value !== next) await transport.setPlayStart(next);
        }
        if (active()) await restoreLoopBounds(transport, range);
      } catch (cause) {
        if (active()) {
          locked = null;
          stopObserving();
          reconcileLink();
          error = cause.message;
        }
      } finally {
        working = false;
        if (!disposed) {
          render();
          if (changedDuringWrite) schedule();
        }
      }
    });
  }

  const unsubscribes = [
    transport.loopStart, transport.loopStop, transport.looping, transport.playStart,
    transport.playing, transport.recordEnabled, transport.punchedIn,
    context.selectionStart, context.selectionStop, context.settings,
  ].map((prop) => prop.onChange(render));
  unsubscribes.push(transport.looping.onChange(schedule));
  unsubscribes.push(transport.playStart.onChange(() => {
    if (locked && !transport.playing.value && startsPastLoop(transport, locked)) schedule();
  }));
  unsubscribes.push(context.selectionStart.onChange(() => {
    if (!locked || transport.playing.value || transport.recordEnabled.value ||
        context.linkEditAndPlay.value !== false || context.focus.value !== 'timeline') return;
    cursor = Number.isFinite(context.selectionStart.value) ? context.selectionStart.value : null;
    if (cursor !== null) schedule();
  }));

  // Transport control must run at the same speed in every panel state. The
  // SDK's default callback batching depends on animation frames and timers.
  const controlPaths = new Set([
    `${context.path}/selection_start`,
    `${context.path}/settings`,
    `${session.path}/looping`,
    `${session.path}/play_start`,
    `${session.path}/loop_start`,
    `${session.path}/loop_stop`,
  ]);
  unsubscribes.push(luna.raw.subscribe(session.path, ({ path }) => {
    if (!locked || !controlPaths.has(path.replace(/\/value$/, ''))) return;
    queueMicrotask(() => {
      if (!disposed && locked) void luna.settled();
    });
  }, { recursive: true }));

  toggle.onclick = () => {
    stopObserving();
    locked = locked ? null : readOrangeLoop(context) ?? readLoop(transport);
    if (locked) {
      stopObserving = observeNativeRange(session, luna.raw, (range) => {
        if (!locked) return;
        if (range) {
          locked = range;
          render();
        }
        schedule();
      });
    }
    cursor = null;
    error = '';
    reconcileLink();
    render();
    schedule();
  };
  update.onclick = () => {
    const range = readEditRange();
    if (!locked || !range || transport.recordEnabled.value) return;
    locked = range;
    render();
    schedule();
  };
  disconnectSession = () => {
    disposed = true;
    syncLink = () => {};
    reconcileLink();
    stopObserving();
    update.onclick = null;
    toggle.onclick = null;
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
  render();
}

async function connect() {
  let luna;
  while (!luna) {
    try {
      luna = await Luna.connect();
    } catch (error) {
      status.textContent = error instanceof Luna.NotRunning ? 'Waiting for LUNA…' : error.message;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  const rebind = () => bindSession(luna).catch((error) => { status.textContent = error.message; });
  luna.sessions.focused.onChange(rebind);
  luna.sessions.items.onChange(rebind);
  await rebind();
}
connect().catch((error) => { status.textContent = error.message; });
