(() => {
  function readLoop(transport) {
    const start = transport.loopStart.value;
    const stop = transport.loopStop.value;
    return Number.isFinite(start) && Number.isFinite(stop) && start < stop
      ? { start, stop }
      : null;
  }

  function readOrangeLoop(context) {
    try {
      const settings = JSON.parse(context.settings.value ?? '{}');
      const { loop_start: start, loop_stop: stop } = settings;
      if (Number.isFinite(start) && Number.isFinite(stop) && start < stop) return { start, stop };
    } catch {
      // Older LUNA builds and the mock engine may not supply these settings.
    }
    return null;
  }

  function startsPastLoop(transport, range) {
    const playbackPosition = transport.playing.value
      ? transport.location.value?.tick ?? transport.playStart.value
      : transport.playStart.value;
    return Number.isFinite(playbackPosition) && playbackPosition >= range.stop;
  }

  async function restoreLoopBounds(transport, range) {
    const cursor = transport.playStart.value;
    const bypass = startsPastLoop(transport, range);
    // LUNA can treat a non-empty range as a playback stop even with Cycle off.
    // Clear only stale orange bounds in that case and leave a blue range alone.
    const hasOrangeBounds = transport.loopStart.value === range.start &&
      transport.loopStop.value === range.stop;
    if (!transport.looping.value && !(bypass && hasOrangeBounds)) return;
    const start = bypass ? cursor : range.start;
    const stop = bypass ? cursor : range.stop;
    if (transport.loopStart.value !== start || transport.loopStop.value !== stop) {
      await transport.setLoop(start, stop);
    }
  }

  // LUNA streams the provisional transport bounds during a blue selection drag.
  // The edit context reports the committed blue range when the gesture ends.
  function observeNativeRange(session, raw, onRange) {
    const { transport, context } = session;
    let start = transport.loopStart.value;
    let stop = transport.loopStop.value;
    let playStart = transport.playStart.value;
    let blueGesture = false;
    let timer;
    let lastBoundsAt = 0;
    let savedOrange = readOrangeLoop(context);

    const stopWatchingSettings = context.settings.onChange(() => {
      const orange = readOrangeLoop(context);
      if (!orange || orange.start === savedOrange?.start && orange.stop === savedOrange?.stop) return;
      savedOrange = orange;
      clearTimeout(timer);
      timer = undefined;
      blueGesture = false;
      onRange(orange);
    });

    function finish() {
      clearTimeout(timer);
      timer = undefined;
      // Transport bounds also carry blue edits. Only ruler settings identify
      // a new orange range, regardless of how the transport events are ordered.
      onRange(null);
      if (start < stop) blueGesture = false;
    }

    const unsubscribe = raw.subscribe(session.path, (event) => {
      const path = event.path.replace(/\/value$/, '');
      if (path === context.path + '/selection_start' || path === context.path + '/selection_stop') {
        if (blueGesture) {
          clearTimeout(timer);
          timer = setTimeout(finish, 20);
        }
        return;
      }
      if (path === session.path + '/play_start') {
        playStart = event.data;
        return;
      }
      if (!path.endsWith('/loop_start') && !path.endsWith('/loop_stop')) return;
      if (Date.now() - lastBoundsAt > 1200) blueGesture = false;
      lastBoundsAt = Date.now();
      if (!timer && !blueGesture) {
        start = transport.loopStart.value;
        stop = transport.loopStop.value;
      }
      if (path === session.path + '/loop_start') start = event.data;
      else if (path === session.path + '/loop_stop') stop = event.data;
      else return;

      if (start === stop && start === playStart) blueGesture = true;
      clearTimeout(timer);
      // A simple point click can report its edit selection before the collapse.
      // Allow its bounds to settle, while grouping later updates in a drag.
      timer = setTimeout(finish, blueGesture ? (start === stop ? 35 : 220) : 20);
    }, { recursive: true });

    return () => {
      clearTimeout(timer);
      unsubscribe();
      stopWatchingSettings();
    };
  }

  globalThis.AddOnLogic = { readLoop, restoreLoopBounds, observeNativeRange, readOrangeLoop, startsPastLoop };
})();
