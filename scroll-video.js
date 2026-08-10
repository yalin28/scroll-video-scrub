  (() => {
    'use strict';

    /*
     * ScrollVideo —— 企业级滚动序列视频组件（ES6+）
     * 参考 Apple MacBook Neo / AirPods 页面的 VideoScrub 方案：
     *   1. 声明式 keyframe：data-video-progress-kf 描述“滚动到什么位置对应视频哪一秒”
     *   2. 核心换算：progress(0~1) -> video.currentTime = duration * progress
     *   3. 断点 / DPR / 格式多版本：basepath + viewport + (_2x) + (webm|mp4|mov)
     *   4. 接近视口才加载（load keyframe），离开区间不空转
     *   5. debug 模式：console 或 on-page 面板，直观看到 JS 与页面/视频的配合
     *
     * 语法策略：使用 ES6+（class / 箭头函数 / 模板字符串 / 解构 / 展开），
     * 但刻意避开 ES2020+ 特性（可选链、空值合并、class 字段），
     * 保证 Chrome/Edge 79+、Firefox 68+、Safari 13+、iOS Safari 13+ 可直接运行。
     *
     * Shopify 主题复用：通过 <script src="scroll-video.js"> 加载一次，
     * 在每个 section 内用 new ScrollVideo('#id', options) 初始化；
     * 素材可放 Shopify Files，data-video-basepath 填 CDN 目录地址。
     *
     * 零依赖、单文件、可多实例。视频保持 paused + muted + playsinline，
     * “回滚”本质是双向 seek，不是播放器倒放。
     */

    const VERSION = '1.0.0';

    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

    const isSafari = () => /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    class ScrollVideo {
      constructor(target, options = {}) {
        this._opts = { ...ScrollVideo.DEFAULTS, ...options };

        // 支持传入“选择器 / 容器元素 / video 元素”三种写法
        this._el = typeof target === 'string' ? document.querySelector(target) : target;
        if (!this._el) throw new Error(`[ScrollVideo] 找不到目标元素: ${target}`);

        if (this._el.tagName === 'VIDEO') {
          this._video = this._el;
          this._el = this._video.parentElement;
        } else {
          this._video = this._el.querySelector('video');
        }
        if (!this._video) throw new Error('[ScrollVideo] 容器内没有 <video>');

        // 运行时状态
        this._id = `sv-${Math.random().toString(36).slice(2, 8)}`;
        this._duration = 0;
        this._ready = false;
        this._failed = false;
        this._destroyed = false;
        this._sourceStarted = false;
        this._sourceURLs = [];
        this._sourceIndex = 0;
        this._pendingTime = null;    // 断点切换后需要恢复的时间点
        this._lastProgress = -1;
        this._inRange = false;
        this._lastDirection = '';
        this._rafId = null;
        this._breakpointMQs = [];
        this._overlay = null;

        // debug 模式：false | 'console' | 'overlay'
        this._debugMode = this._opts.debug === true ? 'overlay' : (this._opts.debug || false);

        // 用箭头函数固定 this，避免到处 bind
        this._onScroll = () => {
          if (this._rafId === null) {
            this._rafId = requestAnimationFrame(this._tick);
          }
        };
        this._tick = () => {
          this._rafId = null;
          if (this._destroyed) return;

          // load keyframe：只有接近滚动区间才真正加载视频
          if (!this._shouldLoad()) return;
          this._ensureSource();

          const range = this._getScrollRange();
          const raw = (window.scrollY - range.start) / (range.end - range.start);
          const progress = clamp(raw, 0, 1);

          // 支持 keyframe 的 progress 区间（如 [0.3, 1]）和缓动函数
          const [p0, p1] = this._progressKf.progress || [0, 1];
          const eased = this._ease(progress);
          const target = this._duration
            ? this._duration * (p0 + (p1 - p0) * eased)
            : 0;

          // 方向判断：目标时间变大 = 向下正放；变小 = 向上回滚（双向 seek）
          const direction = target > this._video.currentTime + this._opts.seekEpsilon
            ? '正放 ↓'
            : (target < this._video.currentTime - this._opts.seekEpsilon ? '回滚 ↑' : this._lastDirection);

          // 核心：只有目标时间确实变化了才写入 currentTime，避免无意义 seek
          if (this._duration && Math.abs(target - this._video.currentTime) >= this._opts.seekEpsilon) {
            this._video.currentTime = target;
          }

          this._trackRange(progress);
          this._emitProgress(progress, target, direction);
          this._updateDebugStatus(progress, target, direction);
          this._lastDirection = direction;
        };
        this._onLoadedMetadata = () => {
          if (this._destroyed) return;
          this._duration = this._video.duration || 0;
          this._ready = true;

          // 断点切换后恢复到原时间点
          if (this._pendingTime !== null) {
            this._video.currentTime = clamp(this._pendingTime, 0, Math.max(0, this._duration - 0.001));
            this._pendingTime = null;
          }

          this._debug('info', `loadedmetadata：视频总时长 ${this._duration.toFixed(3)}s`);
          this._emit('ready', { duration: this._duration });
          if (typeof this._opts.onReady === 'function') {
            this._opts.onReady({ duration: this._duration, video: this._video });
          }

          // 用户偏好减少动态效果时，停在首帧，不做滚动 scrub
          if (this._prefersReducedMotion()) {
            this._video.currentTime = 0;
            this._debug('info', '检测到 prefers-reduced-motion，停留在首帧');
          }
        };
        this._onVideoError = () => {
          if (this._destroyed || this._failed) return;
          if (this._sourceIndex < this._sourceURLs.length - 1) {
            this._sourceIndex += 1;
            this._debug('warn', `视频源失败，切换到：${this._sourceURLs[this._sourceIndex]}`);
            this._setSource(this._sourceURLs[this._sourceIndex]);
            return;
          }

          this._failed = true;
          this._debug('error', '所有视频源均加载失败');
          if (this._poster) this._showPosterFallback();
          this._emit('error', { message: '所有视频源均加载失败' });
          if (typeof this._opts.onError === 'function') {
            this._opts.onError({ message: '所有视频源均加载失败' });
          }
        };
        this._onBreakpointChange = () => {
          const next = this._detectViewport();
          if (next === this._viewport) return;
          this._viewport = next;
          this._debug('info', `断点变化 -> ${next}`);
          this._reloadSource();
        };

        this._readConfig();
        this._bindEvents();
        this._bindBreakpoints();
        this._bindScroll();

        if (this._debugMode === 'overlay') this._createOverlay();

        // 初始化时先跑一次，让状态面板立即有内容
        this._tick();
        this._debug('info', `组件初始化完成（version ${VERSION}）`);
      }

      /* ---------------- 配置读取 ---------------- */

      _readConfig() {
        const v = this._video;

        // 素材目录：组件按 {basepath}/{viewport}{_2x}.{ext} 拼 URL
        this._basePath = (v.dataset.videoBasepath || this._opts.basePath || '').replace(/\/+$/, '');
        if (!this._basePath) throw new Error('[ScrollVideo] 缺少 data-video-basepath');

        this._alpha = v.dataset.videoAlpha === 'true';
        this._retina = v.dataset.videoRetina === 'retina';
        this._poster = v.dataset.videoPoster || null;
        this._progressKf = this._parseKf(v.dataset.videoProgressKf, 'data-video-progress-kf');
        this._loadKf = v.dataset.videoLoadKf
          ? this._parseKf(v.dataset.videoLoadKf, 'data-video-load-kf')
          : null;

        this._substitutionMap = {};
        if (v.dataset.videoBreakpointSubstitutionMap) {
          try {
            this._substitutionMap = JSON.parse(v.dataset.videoBreakpointSubstitutionMap);
          } catch {
            this._debug('error', 'data-video-breakpoint-substitution-map 不是合法 JSON');
          }
        }

        this._viewport = this._detectViewport();
      }

      _parseKf(raw, attrName) {
        let kf;
        try {
          kf = JSON.parse(raw);
        } catch {
          throw new Error(`[ScrollVideo] ${attrName} 不是合法 JSON`);
        }
        if (!kf.start || !kf.end) {
          throw new Error(`[ScrollVideo] ${attrName} 必须包含 start 和 end`);
        }

        // 把 anchors 选择器解析成真实 DOM 元素；缺省时使用组件容器本身
        const selectors = kf.anchors && kf.anchors.length ? kf.anchors : [this._el];
        kf._anchors = selectors.map(sel => {
          if (typeof sel !== 'string') return sel;
          const el = this._el.querySelector(sel) || document.querySelector(sel);
          if (!el) throw new Error(`[ScrollVideo] anchor 不存在: ${sel}`);
          return el;
        });
        kf.progress = kf.progress || [0, 1];
        return kf;
      }

      /* ---------------- 事件绑定 ---------------- */

      _bindEvents() {
        this._video.addEventListener('loadedmetadata', this._onLoadedMetadata);
        this._video.addEventListener('error', this._onVideoError);
      }

      _bindScroll() {
        // scroll 只做“标记”，真正的计算放在下一帧 rAF，避免滚动事件风暴
        window.addEventListener('scroll', this._onScroll, { passive: true });
      }

      _bindBreakpoints() {
        const bp = this._opts.breakpoints;
        const queries = [
          `(max-width: ${bp.xsmall}px)`,
          `(min-width: ${bp.xsmall + 1}px) and (max-width: ${bp.small}px)`,
          `(min-width: ${bp.small + 1}px) and (max-width: ${bp.medium}px)`,
          `(min-width: ${bp.medium + 1}px) and (max-width: ${bp.large}px)`,
          `(min-width: ${bp.large + 1}px)`,
        ];
        queries.forEach(query => {
          const mq = window.matchMedia(query);
          const fn = e => {
            if (e.matches) this._onBreakpointChange();
          };
          // 新浏览器用 addEventListener；Safari 13 及更早用 addListener
          if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', fn);
          } else {
            mq.addListener(fn);
          }
          this._breakpointMQs.push({ mq, fn });
        });
      }

      /* ---------------- 断点 / DPR / 格式 ---------------- */

      _detectViewport() {
        const bp = this._opts.breakpoints;
        const w = window.innerWidth;
        if (w <= bp.xsmall) return 'xsmall';
        if (w <= bp.small) return 'small';
        if (w <= bp.medium) return 'medium';
        if (w <= bp.large) return 'large';
        return 'xlarge';
      }

      _reloadSource() {
        // 断点切换时保留当前播放位置，新源加载完成后恢复
        if (!this._sourceStarted || this._failed) return;
        this._pendingTime = this._video.currentTime ||
          (this._lastProgress >= 0 ? this._lastProgress * this._duration : 0);
        this._sourceStarted = false;
        this._sourceIndex = 0;
        this._ensureSource();
      }

      _pickExtensions() {
        // Safari 优先 mp4；带 alpha 时 Safari 用 mov（HEVC with Alpha）
        if (this._alpha) {
          return isSafari() ? ['mov', 'mp4', 'webm'] : ['webm', 'mp4'];
        }
        return isSafari() ? ['mp4', 'webm'] : ['webm', 'mp4'];
      }

      _buildSourceList() {
        const viewport = this._substitutionMap[this._viewport] || this._viewport;
        const suffix = this._retina && window.devicePixelRatio > 1 ? '_2x' : '';
        return this._pickExtensions().map(ext => `${this._basePath}/${viewport}${suffix}.${ext}`);
      }

      _ensureSource() {
        if (this._sourceStarted) return;
        this._sourceURLs = this._buildSourceList();
        this._sourceIndex = 0;
        this._sourceStarted = true;
        this._setSource(this._sourceURLs[0]);
      }

      _setSource(url) {
        this._debug('info', `加载视频源：${url}`);
        this._video.src = url;
        this._video.load();
      }

      /* ---------------- 视频事件 ---------------- */

      _prefersReducedMotion() {
        if (this._opts.reducedMotion === true) return true;
        if (this._opts.reducedMotion === false) return false;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }

      _showPosterFallback() {
        // 全部视频源失败时，退化为 poster 静态图
        this._debug('warn', `使用 poster 静态兜底：${this._poster}`);
        this._video.poster = this._poster;
        this._video.removeAttribute('src');
        this._video.load();
      }

      /* ---------------- 滚动 -> rAF -> progress -> currentTime ---------------- */

      _shouldLoad() {
        if (!this._loadKf) return true;
        const ctx = this._exprContext(this._loadKf);
        const start = this._evalExpr(this._loadKf.start, ctx);
        const end = this._evalExpr(this._loadKf.end, ctx);
        return window.scrollY >= start && window.scrollY <= end;
      }

      _getScrollRange() {
        const ctx = this._exprContext(this._progressKf);
        return {
          start: this._evalExpr(this._progressKf.start, ctx),
          end: this._evalExpr(this._progressKf.end, ctx),
        };
      }

      /*
       * 表达式求值：支持 Apple 风格的 keyframe 表达式片段
       *   a0t / a0b / a1t / a1b  -> 第 N 个 anchor 的顶部 / 底部（文档坐标）
       *   t / b                  -> 视口顶部 / 底部（文档坐标）
       *   px / vh / vw           -> 偏移量
       * 示例："a0t - 150vh"、"a0b - 100vh"
       */
      _exprContext(kf) {
        return {
          anchors: kf._anchors.map(el => el.getBoundingClientRect()),
          vh: window.innerHeight / 100,
          vw: window.innerWidth / 100,
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
        };
      }

      _evalExpr(expr, ctx) {
        const pattern = /([+-]?)\s*(?:(\d+(?:\.\d+)?)(px|vh|vw)|(a\d+)(t|b)|([tb]))/gi;
        let total = 0;
        let hasTerm = false;
        let match;
        while ((match = pattern.exec(expr)) !== null) {
          hasTerm = true;
          const sign = match[1] === '-' ? -1 : 1;
          let term = 0;
          if (match[2]) {
            const n = parseFloat(match[2]);
            if (match[3] === 'vh') term = n * ctx.vh;
            else if (match[3] === 'vw') term = n * ctx.vw;
            else term = n;
          } else if (match[4]) {
            const idx = parseInt(match[4].slice(1), 10);
            const rect = ctx.anchors[idx] || ctx.anchors[0];
            term = match[5] === 't' ? rect.top + ctx.scrollY : rect.bottom + ctx.scrollY;
          } else if (match[6]) {
            term = match[6] === 't' ? ctx.scrollY : ctx.scrollY + ctx.innerHeight;
          }
          total += sign * term;
        }
        if (!hasTerm) {
          const n = parseFloat(expr);
          if (!Number.isNaN(n)) return n;
        }
        return total;
      }

      _ease(p) {
        const name = this._progressKf.ease || 'linear';
        if (name === 'easeInOutQuad') {
          return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        }
        if (name === 'easeOutQuad') {
          return 1 - (1 - p) * (1 - p);
        }
        return p;
      }

      _trackRange(progress) {
        const inside = progress > 0 && progress < 1;
        if (inside && !this._inRange) {
          this._inRange = true;
          this._debug('info', '进入滚动区间');
          this._emit('enter', { progress });
        }
        if (!inside && this._inRange) {
          this._inRange = false;
          this._debug('info', '离开滚动区间');
          this._emit('exit', { progress });
        }
      }

      _emitProgress(progress, time, direction) {
        if (Math.abs(progress - this._lastProgress) < this._opts.progressEpsilon) return;
        this._lastProgress = progress;
        const detail = { progress, time, direction };
        this._emit('progress', detail);
        if (typeof this._opts.onProgress === 'function') this._opts.onProgress(detail);
      }

      _emit(name, detail) {
        this._el.dispatchEvent(new CustomEvent(`scrollvideo:${name}`, {
          detail,
          bubbles: true,
        }));
      }

      /* ---------------- debug ---------------- */

      setDebug(mode) {
        this._debugMode = mode === true ? 'overlay' : mode;
        if (this._debugMode === 'overlay') {
          this._createOverlay();
        } else {
          this._destroyOverlay();
        }
        this._debug('info', `debug 模式：${this._debugMode || 'off'}`);
      }

      _debug(level, message) {
        if (!this._debugMode) return;
        const line = `[${level}] ${message}`;
        console.log(`[ScrollVideo:${this._id}]`, line);
        if (this._overlay) {
          const row = document.createElement('div');
          row.textContent = line;
          row.className = `sv-debug__log-line sv-debug__log-line--${level}`;
          this._overlay.log.appendChild(row);
          while (this._overlay.log.children.length > 40) {
            this._overlay.log.removeChild(this._overlay.log.firstChild);
          }
          this._overlay.log.scrollTop = this._overlay.log.scrollHeight;
        }
      }

      _updateDebugStatus(progress, target, direction) {
        if (!this._overlay) return;
        this._overlay.status.textContent =
          `scrollY=${Math.round(window.scrollY)}\n` +
          `progress=${progress.toFixed(4)}  target=${target.toFixed(3)}s\n` +
          `currentTime=${this._video.currentTime.toFixed(3)}s / ${this._duration.toFixed(3)}s\n` +
          `方向：${direction}`;
        this._overlay.fill.style.width = `${(progress * 100).toFixed(1)}%`;

        // 勾选“逐帧 log”后，每次 rAF 都往控制台输出一次，直观感受配合过程
        if (this._overlay.verbose.checked) {
          console.log(
            `[ScrollVideo:${this._id}][frame] progress=${progress.toFixed(4)} ` +
            `target=${target.toFixed(3)}s actual=${this._video.currentTime.toFixed(3)}s ${direction}`
          );
        }
      }

      _createOverlay() {
        if (this._overlay) return;
        ScrollVideo._injectDebugStyles();

        const root = document.createElement('aside');
        root.className = 'sv-debug';
        root.innerHTML = `
          <div class="sv-debug__head">
            <span>ScrollVideo Debug</span>
            <button type="button" class="sv-debug__close" title="关闭">×</button>
          </div>
          <div class="sv-debug__track"><div class="sv-debug__fill"></div></div>
          <pre class="sv-debug__status">等待视频元数据…</pre>
          <div class="sv-debug__log"></div>
          <label class="sv-debug__verbose"><input type="checkbox"> 逐帧 log（控制台）</label>`;

        root.querySelector('.sv-debug__close').addEventListener('click', () => this.setDebug(false));
        document.body.appendChild(root);

        this._overlay = {
          root,
          status: root.querySelector('.sv-debug__status'),
          log: root.querySelector('.sv-debug__log'),
          fill: root.querySelector('.sv-debug__fill'),
          verbose: root.querySelector('.sv-debug__verbose input'),
        };
        this._updateDebugStatus(0, 0, '');
      }

      _destroyOverlay() {
        if (this._overlay) {
          const root = this._overlay.root;
          if (root.parentNode) root.parentNode.removeChild(root);
          this._overlay = null;
        }
      }

      static _injectDebugStyles() {
        if (ScrollVideo._debugStyleInjected) return;
        ScrollVideo._debugStyleInjected = true;
        const style = document.createElement('style');
        style.textContent = `
          .sv-debug{position:fixed;left:14px;bottom:14px;z-index:99999;width:min(340px,calc(100vw - 28px));
            background:rgba(8,8,12,.94);border:1px solid #333;border-radius:8px;padding:10px 12px;
            font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#cfd3e0;
            box-shadow:0 8px 30px rgba(0,0,0,.5)}
          .sv-debug__head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;color:#9aa3b5}
          .sv-debug__close{border:0;background:transparent;color:#9aa3b5;font-size:16px;cursor:pointer}
          .sv-debug__track{height:4px;background:#2a2a36;border-radius:2px;margin-bottom:8px;overflow:hidden}
          .sv-debug__fill{height:100%;width:0;background:#4f8cff;border-radius:2px}
          .sv-debug__status{white-space:pre-wrap;word-break:break-all;margin:0 0 8px}
          .sv-debug__log{max-height:140px;overflow:auto;border-top:1px dashed #333;padding-top:6px;color:#8fd3a0}
          .sv-debug__log-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .sv-debug__log-line--warn{color:#e5c07b}.sv-debug__log-line--error{color:#e06c75}
          .sv-debug__verbose{display:flex;gap:6px;align-items:center;margin-top:6px;color:#b9bcc9;
            font-family:"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer}`;
        document.head.appendChild(style);
      }

      /* ---------------- 公共 API ---------------- */

      recalc() {
        this._tick();
      }

      getProgress() {
        return this._lastProgress;
      }

      destroy() {
        this._destroyed = true;
        if (this._rafId !== null) cancelAnimationFrame(this._rafId);
        window.removeEventListener('scroll', this._onScroll);
        this._breakpointMQs.forEach(({ mq, fn }) => {
          if (typeof mq.removeEventListener === 'function') {
            mq.removeEventListener('change', fn);
          } else {
            mq.removeListener(fn);
          }
        });
        this._video.removeEventListener('loadedmetadata', this._onLoadedMetadata);
        this._video.removeEventListener('error', this._onVideoError);
        this._destroyOverlay();
      }

      get video() {
        return this._video;
      }
    }

    ScrollVideo.DEFAULTS = {
      debug: false,          // false | 'console' | 'overlay'
      seekEpsilon: 0.001,    // currentTime 写入的最小间隔（秒），避免无意义 seek
      progressEpsilon: 0.0001, // progress 事件触发的最小变化量
      reducedMotion: 'auto', // 'auto' | true | false
      breakpoints: { xsmall: 320, small: 734, medium: 1068, large: 1440 },
      onReady: null,
      onProgress: null,
      onError: null,
    };
    ScrollVideo.version = VERSION;

    window.ScrollVideo = ScrollVideo;
  })();
