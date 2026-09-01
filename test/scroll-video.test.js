import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(projectRoot, 'scroll-video.js'), 'utf8');

class FakeEventTarget {
  constructor() {
    this._listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this._listeners.get(type);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) this._listeners.delete(type);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    const listeners = this._listeners.get(event.type);
    if (!listeners) return true;
    [...listeners].forEach(listener => listener.call(this, event));
    return true;
  }

  listenerCount(type) {
    return this._listeners.has(type) ? this._listeners.get(type).size : 0;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName = 'DIV') {
    super();
    this.tagName = tagName;
    this.dataset = {};
    this.parentElement = null;
    this.parentNode = null;
    this.children = [];
    this.style = {};
    this.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    this.rectReads = 0;
    this._selectors = new Map();
  }

  querySelector(selector) {
    return this._selectors.get(selector) || null;
  }

  getBoundingClientRect() {
    this.rectReads += 1;
    return { ...this.rect };
  }

  setQuerySelector(selector, element) {
    this._selectors.set(selector, element);
  }
}

class FakeVideo extends FakeElement {
  constructor() {
    super('VIDEO');
    this.duration = 0;
    this.src = '';
    this.poster = '';
    this.loadCount = 0;
    this.assignments = [];
    this.seeking = false;
    this._currentTime = 0;
    Object.defineProperty(this, 'currentTime', {
      configurable: true,
      get: () => this._currentTime,
      set: value => {
        this.assignments.push(value);
        if (!Number.isFinite(value)) {
          throw new TypeError('The provided double value is non-finite');
        }
        this._currentTime = value;
        this.seeking = true;
      },
    });
  }

  load() {
    this.loadCount += 1;
    this._currentTime = 0;
    this.seeking = false;
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }

  completeSeek() {
    this.seeking = false;
    this.dispatchEvent({ type: 'seeked' });
  }
}

class FakeMediaQuery extends FakeEventTarget {
  constructor() {
    super();
    this.matches = false;
  }

  dispatchMatch(matches) {
    this.matches = matches;
    this.dispatchEvent({ type: 'change', matches });
  }
}

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
    this.bubbles = Boolean(options.bubbles);
  }
}

function createEnvironment({
  progressKf = { start: '0', end: '1000' },
  loadKf,
  duration = 10,
  innerHeight = 100,
  innerWidth = 1200,
  rect = { top: 0, bottom: 1000 },
  reducedMotion = false,
  retina = false,
} = {}) {
  const window = new FakeEventTarget();
  Object.assign(window, {
    scrollY: 0,
    innerHeight,
    innerWidth,
    devicePixelRatio: retina ? 2 : 1,
  });

  let nextAnimationFrameId = 1;
  const animationFrames = new Map();
  const requestAnimationFrame = callback => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = id => animationFrames.delete(id);
  const flushAnimationFrames = () => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    callbacks.forEach(callback => callback());
  };

  const container = new FakeElement('SECTION');
  container.rect = { ...container.rect, ...rect };
  const video = new FakeVideo();
  video.parentElement = container;
  video.parentNode = container;
  container.children.push(video);
  container.setQuerySelector('video', video);
  video.dataset.videoBasepath = 'assets/demo/display';
  video.dataset.videoProgressKf = JSON.stringify(progressKf);
  if (loadKf) video.dataset.videoLoadKf = JSON.stringify(loadKf);
  if (retina) video.dataset.videoRetina = 'retina';

  const mediaQueries = [];
  const document = {
    body: new FakeElement('BODY'),
    head: new FakeElement('HEAD'),
    querySelector: selector => selector === '#component' ? container : null,
    createElement: tagName => new FakeElement(tagName),
  };
  const navigator = { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36' };
  const context = {
    window,
    document,
    navigator,
    requestAnimationFrame,
    cancelAnimationFrame,
    CustomEvent: FakeCustomEvent,
    console: { log() {} },
  };
  window.matchMedia = () => {
    const mediaQuery = new FakeMediaQuery();
    mediaQueries.push(mediaQuery);
    return mediaQuery;
  };

  vm.runInNewContext(source, context, { filename: 'scroll-video.js' });
  const instance = new window.ScrollVideo(container, {
    debug: false,
    reducedMotion,
  });

  const dispatchMetadata = value => {
    video.duration = value;
    video.dispatchEvent({ type: 'loadedmetadata' });
  };

  return {
    container,
    video,
    window,
    mediaQueries,
    instance,
    dispatchMetadata,
    flushAnimationFrames,
  };
}

test('invalid or degenerate scroll ranges never write a non-finite currentTime', () => {
  const env = createEnvironment({
    progressKf: { start: 'a0t', end: 'a0b' },
    rect: { top: 0, bottom: 0 },
  });
  env.dispatchMetadata(10);
  env.window.scrollY = 0;

  assert.doesNotThrow(() => env.instance.recalc());
  assert.deepEqual(env.video.assignments, []);
  assert.equal(env.instance.getProgress(), -1);
});

test('non-finite video durations are treated as unavailable for scrubbing', () => {
  const env = createEnvironment();
  env.dispatchMetadata(Infinity);
  env.window.scrollY = 500;

  assert.doesNotThrow(() => env.instance.recalc());
  assert.deepEqual(env.video.assignments, []);
  assert.equal(env.instance._duration, 0);
});

test('metadata arrival schedules a sync to the current scroll position', () => {
  const env = createEnvironment();
  env.window.scrollY = 500;
  env.dispatchMetadata(10);

  assert.deepEqual(env.video.assignments, []);
  env.flushAnimationFrames();

  assert.deepEqual(env.video.assignments, [5]);
});

test('reduced motion prevents later scroll events from scrubbing the video', () => {
  const env = createEnvironment({ reducedMotion: true });
  env.video._currentTime = 4;
  env.dispatchMetadata(10);
  env.window.scrollY = 800;
  env.window.dispatchEvent({ type: 'scroll' });
  env.flushAnimationFrames();

  assert.deepEqual(env.video.assignments, [0]);
});

test('latest seek target is applied after the active seek completes', () => {
  const env = createEnvironment();
  env.dispatchMetadata(10);

  env.window.scrollY = 200;
  env.instance.recalc();
  env.window.scrollY = 600;
  env.instance.recalc();
  env.window.scrollY = 800;
  env.instance.recalc();

  assert.deepEqual(env.video.assignments, [2]);
  assert.equal(env.instance._seekTarget, 8);

  env.video.completeSeek();
  assert.deepEqual(env.video.assignments, [2, 8]);
  assert.equal(env.instance._seekTarget, null);

  env.video.completeSeek();
  assert.deepEqual(env.video.assignments, [2, 8]);
});

test('returning to the current time cancels an older pending target', () => {
  const env = createEnvironment();
  env.dispatchMetadata(10);

  env.window.scrollY = 200;
  env.instance.recalc();
  env.window.scrollY = 0;
  env.instance.recalc();

  assert.deepEqual(env.video.assignments, [2]);
  assert.equal(env.instance._seekTarget, 0);

  env.video.completeSeek();
  assert.deepEqual(env.video.assignments, [2, 0]);
});

test('breakpoint source reload preserves the newest queued target', () => {
  const env = createEnvironment();
  env.dispatchMetadata(10);

  env.window.scrollY = 200;
  env.instance.recalc();
  env.window.scrollY = 700;
  env.instance.recalc();
  assert.deepEqual(env.video.assignments, [2]);

  env.window.innerWidth = 500;
  env.mediaQueries[1].dispatchMatch(true);
  assert.equal(env.instance._ready, false);
  assert.equal(env.instance._duration, 0);

  env.dispatchMetadata(10);
  assert.deepEqual(env.video.assignments, [2, 7]);
});

test('fallback source reload preserves the current seek position', () => {
  const env = createEnvironment();
  env.dispatchMetadata(10);
  env.window.scrollY = 400;
  env.instance.recalc();
  env.video.completeSeek();

  env.video.dispatchEvent({ type: 'error' });
  assert.equal(env.video.loadCount, 2);
  assert.match(env.video.src, /\.mp4$/);

  env.dispatchMetadata(10);
  assert.deepEqual(env.video.assignments, [4, 4]);
});

test('retina sources fall back to the matching 1x files', () => {
  const env = createEnvironment({ retina: true });

  assert.equal(JSON.stringify(env.instance._sourceURLs), JSON.stringify([
    'assets/demo/display/large_2x.webm',
    'assets/demo/display/large_2x.mp4',
    'assets/demo/display/large.webm',
    'assets/demo/display/large.mp4',
  ]));

  env.video.dispatchEvent({ type: 'error' });
  env.video.dispatchEvent({ type: 'error' });
  assert.match(env.video.src, /large\.webm$/);

  env.video.dispatchEvent({ type: 'error' });
  assert.match(env.video.src, /large\.mp4$/);
});

test('partial breakpoint options keep the remaining defaults', () => {
  const env = createEnvironment();
  const instance = new env.window.ScrollVideo(env.container, {
    breakpoints: { small: 800 },
  });

  assert.equal(JSON.stringify(instance._opts.breakpoints), JSON.stringify({
    xsmall: 320,
    small: 800,
    medium: 1068,
    large: 1440,
  }));
  instance.destroy();
});

test('basePath option supplies a missing data attribute', () => {
  const env = createEnvironment();
  env.instance.destroy();
  delete env.video.dataset.videoBasepath;

  const instance = new env.window.ScrollVideo(env.container, {
    basePath: 'assets/demo/display',
  });

  assert.equal(instance._basePath, 'assets/demo/display');
  instance.destroy();
});

test('resize schedules a recalculation without requiring a scroll event', () => {
  const env = createEnvironment({
    progressKf: { start: '0', end: '100vh' },
    innerHeight: 100,
  });
  env.dispatchMetadata(10);
  env.window.scrollY = 50;
  env.instance.recalc();
  env.video.completeSeek();
  assert.deepEqual(env.video.assignments, [5]);

  env.window.innerHeight = 200;
  env.window.dispatchEvent({ type: 'resize' });
  assert.deepEqual(env.video.assignments, [5]);
  env.flushAnimationFrames();

  assert.deepEqual(env.video.assignments, [5, 2.5]);
});

test('shared anchors are measured once per animation frame', () => {
  const keyframe = { start: 'a0t', end: 'a0b - 100vh' };
  const env = createEnvironment({
    progressKf: keyframe,
    loadKf: keyframe,
    rect: { top: 0, bottom: 1100 },
  });
  env.container.rectReads = 0;

  env.instance.recalc();

  assert.equal(env.container.rectReads, 1);
});

test('destroy removes resize and seek completion listeners', () => {
  const env = createEnvironment();
  assert.equal(env.window.listenerCount('resize'), 1);
  assert.equal(env.video.listenerCount('seeked'), 1);

  env.instance.destroy();

  assert.equal(env.window.listenerCount('resize'), 0);
  assert.equal(env.video.listenerCount('seeked'), 0);
});

test('invalid progress configuration fails during initialization', () => {
  assert.throws(
    () => createEnvironment({ progressKf: { start: '0', end: '100', progress: [null, 1] } }),
    /progress 必须是两个有限数字/
  );
});
