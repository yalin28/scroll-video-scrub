# ScrollVideo 滚动序列视频组件 · 使用说明

## 1. 这个组件解决什么问题

让视频像 Apple MacBook Neo / AirPods 页面那样“跟着滚动逐帧播放”：向下滚视频正放，向上滚视频回滚。
它**不是**播放器倒放，而是把滚动位置换算成 `0~1` 进度，再写入：

```js
video.currentTime = duration * progress;
```

这是浏览器原生的**双向 seek**，跨浏览器兼容，也是 Apple VideoScrub 方案的核心。

## 2. 文件说明

| 文件 | 用途 |
|---|---|
| `scroll-video.js` | 组件本体（`ScrollVideo`），在页面中引入一次即可 |
| `scroll-video-scrub.example.html` | 示例页（含 debug 面板；通常可直接双击打开） |
| `assets/demo/display/` | 示例视频（`xlarge.mp4` + `xlarge.webm`） |
| `test/scroll-video.test.js` | Node 原生回归测试（零第三方依赖） |
| `package.json` | 测试脚本与 Node.js 模块配置 |
| `README.md` | 本文档 |

### 2.1 本地验证

项目运行时不依赖 Node.js；Node.js 仅用于执行自动化测试：

```bash
npm test
node --check scroll-video.js
node --check test/scroll-video.test.js
```

## 3. 快速开始

### 3.1 页面结构

```html
<!-- 先引入组件（建议放在页面底部或 theme.liquid 中） -->
<script src="scroll-video.js"></script>

<section class="sv-demo-section" id="display-scroll" data-scroll-video>
  <div class="sv-demo-stage">
    <video
      data-video-basepath="assets/demo/display"
      data-video-breakpoint-substitution-map='{"xsmall":"xlarge","small":"xlarge","medium":"xlarge","large":"xlarge"}'
      data-video-progress-kf='{"start":"a0t","end":"a0b - 100vh","anchors":["#display-scroll"]}'
      data-video-load-kf='{"start":"a0t - 150vh","end":"a0b + 150vh","anchors":["#display-scroll"]}'
      muted playsinline preload="none" aria-hidden="true"></video>
  </div>
</section>
```

### 3.2 初始化

```html
<script>
  const scrollVideo = new ScrollVideo('#display-scroll', {
    debug: 'overlay', // false | 'console' | 'overlay'
  });
</script>
```

打开 `scroll-video-scrub.example.html` 即可看到左下角调试面板：

- 实时状态：`scrollY`、`progress`、目标时间、实际 `currentTime`、方向（正放/回滚）；
- 事件日志：初始化、`loadedmetadata`、进入/离开滚动区间、素材切换、断点变化；
- 勾选“逐帧 log”后，每次 `requestAnimationFrame` 都会在控制台输出一行，方便直观感受 JS、页面滚动和视频三者的配合节奏。

仓库示例素材目前只提供 `xlarge.mp4` 和 `xlarge.webm`，所以示例把其他断点映射到 `xlarge`；生产环境有完整断点素材时可以移除该映射。

### 3.3 Shopify 主题接入

组件适合直接放进 Shopify section：JS 在 `theme.liquid` 或 `theme.js` 中加载一次，每个 section 用 `{{ section.id }}` 保证锚点唯一。

```liquid
{%- liquid
  assign sv_anchor_id = 'scroll-video-' | append: section.id
  assign sv_video_basepath = section.settings.video_basepath
-%}

<section id="{{ sv_anchor_id }}" data-scroll-video>
  <div class="sv-stage">
    <video
      data-video-basepath="{{ sv_video_basepath | escape }}"
      data-video-progress-kf='{ "start": "a0t", "end": "a0b - 100vh", "anchors": ["#{{ sv_anchor_id }}"] }'
      data-video-load-kf='{ "start": "a0t - 150vh", "end": "a0b + 150vh", "anchors": ["#{{ sv_anchor_id }}"] }'
      muted playsinline preload="none" aria-hidden="true"></video>
  </div>
</section>

<script>
  (function () {
    var sectionId = '{{ section.id }}';
    var scrollVideo = null;

    function initScrollVideo() {
      if (scrollVideo || !window.ScrollVideo) return;

      var section = document.getElementById('{{ sv_anchor_id }}');
      if (!section) return;

      scrollVideo = new window.ScrollVideo(section, {
        debug: false,
        breakpoints: { xsmall: 320, small: 734, medium: 1068, large: 1440 },
      });
    }

    function destroyScrollVideo() {
      if (!scrollVideo) return;
      scrollVideo.destroy();
      scrollVideo = null;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initScrollVideo, { once: true });
    } else {
      initScrollVideo();
    }

    document.addEventListener('shopify:section:load', function (event) {
      if (event.detail && event.detail.sectionId === sectionId) initScrollVideo();
    });

    document.addEventListener('shopify:section:unload', function (event) {
      if (event.detail && event.detail.sectionId === sectionId) destroyScrollVideo();
    });
  })();
</script>

{% schema %}
{
  "name": "Scroll Video",
  "settings": [
    {
      "type": "text",
      "id": "video_basepath",
      "label": "Video base path",
      "info": "例如 https://cdn.shopify.com/s/files/1/xxxx/files/anim/display"
    }
  ],
  "presets": [{ "name": "Scroll Video" }]
}
{% endschema %}
```

要点：

- `video_basepath` 填 Shopify Files 的 CDN 目录地址，组件会按 `{basepath}/{viewport}{_2x}.{ext}` 自动拼 URL；高 DPR 且 2x 文件不存在时，会继续尝试对应的 1x 文件；
- 锚点必须使用 `{{ section.id }}`，避免同页多个 section 冲突；
- 如果主题已经在 `theme.liquid` 中加载过 `scroll-video.js`，去掉 section 内重复的 `<script>` 标签；
- 主题编辑器动态加载或卸载 section 时，示例会分别初始化和调用 `destroy()`，避免重复监听；
- 如果主题启用了严格 CSP，请按主题的脚本加载策略放置初始化代码，并确保 `scroll-video.js` 先于该初始化代码加载。

## 4. 配置说明

素材配置优先读取 `<video>` 上的 `data-*` 属性；行为配置通过 `new ScrollVideo(el, options)` 传入。`basePath` 可作为 `data-video-basepath` 缺失时的路径兜底，`breakpoints` 可覆盖默认断点。

### 4.1 data 属性

| 属性 | 必填 | 说明 |
|---|---|---|
| `data-video-basepath` | 条件必填 | 素材目录，如 `display`；若未在 JS 选项中提供 `basePath`，则必须填写 |
| `data-video-progress-kf` | 是 | 滚动 keyframe JSON，定义“滚动区间对应视频进度” |
| `data-video-load-kf` | 否 | 加载 keyframe JSON，只有接近区间才真正加载视频 |
| `data-video-breakpoint-substitution-map` | 否 | 断点替换映射，键和值都是 `xsmall` / `small` / `medium` / `large` / `xlarge`，如 `{"xsmall":"small","xlarge":"large"}` |
| `data-video-retina="retina"` | 否 | 开启 2x（`devicePixelRatio > 1` 时拼 `_2x` 文件名） |
| `data-video-alpha="true"` | 否 | 透明视频：Safari 优先 `.mov`，其他优先 `.webm` |
| `data-video-poster` | 否 | 全部候选视频源失败时的静态兜底图 |

### 4.2 progress keyframe 格式

```json
{
  "start": "a0t",
  "end": "a0b - 100vh",
  "anchors": ["#display-scroll"],
  "progress": [0, 1],
  "ease": "linear"
}
```

支持表达式（与 Apple 的 keyframe 写法同思路，目前为简化子集）：

| 记号 | 含义 |
|---|---|
| `a0t` / `a0b` | 第 0 个 anchor 的顶部 / 底部（文档坐标） |
| `a1t` / `a1b` | 第 1 个 anchor 的顶部 / 底部 |
| `t` / `b` | 视口顶部 / 底部（文档坐标） |
| `px` / `vh` / `vw` | 偏移量 |

示例：

- `"start": "a0t"`：anchor 顶部刚进入视口顶部时开始；
- `"end": "a0b - 100vh"`：anchor 底部距离视口底部 100vh 时结束；
- `"progress": [0.3, 1]`：只在视频 30%~100% 之间滚动（同 Apple Continuity 的做法）；
- `"ease": "easeInOutQuad"`：可选，支持 `linear` / `easeOutQuad` / `easeInOutQuad`。

### 4.3 JS 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `debug` | `false` | `false` / `'console'` / `'overlay'` |
| `basePath` | — | `data-video-basepath` 缺失时的素材目录；`data-*` 属性优先 |
| `breakpoints` | `{ xsmall: 320, small: 734, medium: 1068, large: 1440 }` | 断点阈值（px）；可只覆盖其中一项，未提供的值继续使用默认值 |
| `seekEpsilon` | `0.001` | 目标时间变化的最小间隔（秒）；视频 seek 进行中只保留最新目标 |
| `progressEpsilon` | `0.0001` | `progress` 事件触发的最小变化量 |
| `reducedMotion` | `'auto'` | `'auto'`（在元数据就绪时跟随系统）/ `true`（强制停首帧）/ `false`（不处理） |
| `onReady` / `onProgress` / `onError` | `null` | 回调，参数见下方 |

回调参数：

```js
onReady: ({ duration, video }) => {},
onProgress: ({ progress, time, direction }) => {},
onError: ({ message }) => {},
```

## 5. 公共 API 与事件

### 5.1 方法

| 方法 | 说明 |
|---|---|
| `new ScrollVideo(target, options)` | 初始化；`target` 可以是选择器、容器元素或 video 元素 |
| `instance.video` | 获取内部 video 元素 |
| `instance.getProgress()` | 获取当前 0~1 进度；滚动区间尚未完成有效计算时返回 `-1` |
| `instance.recalc()` | 立即重新计算一次；组件也会在 `resize` 后自动调度重算 |
| `instance.setDebug('overlay' / 'console' / false)` | 运行时切换 debug 模式；传入 `true` 等同于 `'overlay'` |
| `instance.destroy()` | 销毁实例：移除监听、取消 rAF、移除调试面板 |

### 5.2 事件（派发在容器元素上，冒泡）

| 事件 | detail |
|---|---|
| `scrollvideo:ready` | `{ duration }`，元数据就绪后派发 |
| `scrollvideo:enter` / `scrollvideo:exit` | `{ progress }` |
| `scrollvideo:progress` | `{ progress, time, direction }`；`time` 是最新目标时间，不一定等于此刻已解码的 `video.currentTime` |
| `scrollvideo:error` | `{ message }`，所有候选视频源均失败后派发 |

```js
el.addEventListener('scrollvideo:progress', function (e) {
  console.log(e.detail.progress, e.detail.time);
});
```

## 6. 素材规范与生成（ffmpeg）

### 6.1 命名规范

```
{module}/{xsmall|small|medium|large|xlarge}{_2x}.{webm|mp4|mov}

示例：
display/xlarge.webm
display/xlarge_2x.mp4
performance/large_2x.webm
```

断点宽度建议（2x 为 Retina 版，线性翻倍）：

| 断点 | 视口宽度 | 1x 宽度参考 | 2x 宽度参考 |
|---|---|---|---|
| xsmall | ≤ 320px | 320px | 640px |
| small | 321–734px | 734px | 1468px |
| medium | 735–1068px | 1068px | 2136px |
| large | 1069–1440px | 1440px | 2880px |
| xlarge | ≥ 1441px | 1920px | 3840px |

### 6.2 编码要求（滚动序列视频）

| 项目 | 要求 |
|---|---|
| 帧率 | 30fps 或 60fps（产品细节建议 60fps） |
| 关键帧间隔（GOP） | **6~10 帧**，这是回滚顺滑的关键 |
| 音频 | 无（`-an`） |
| Chrome/Edge/Firefox | VP9 WebM，`yuv420p` |
| Safari/iOS | H.264 MP4，`yuv420p`，`+faststart` |
| 透明视频 | WebM VP9 `yuva420p`；Safari 端 HEVC with Alpha `.mov` |
| 时长 | 建议 5~20s，由滚动区间决定 |

### 6.3 H.264 MP4（Safari）

```bash
ffmpeg -i frame_%04d.png -r 30 -c:v libx264 -profile:v high -pix_fmt yuv420p \
  -crf 18 -preset slow \
  -g 10 -keyint_min 10 -sc_threshold 0 \
  -movflags +faststart -an display/large.mp4
```

60fps 时把 `-r 60`，GOP 建议 `-g 6 -keyint_min 6`。

### 6.4 VP9 WebM（Chrome / Edge / Firefox）

```bash
ffmpeg -i frame_%04d.png -r 30 -c:v libvpx-vp9 -b:v 0 -crf 32 -cpu-used 4 \
  -row-mt 1 -pix_fmt yuv420p \
  -g 10 -keyint_min 10 -an display/large.webm
```

透明素材把 `-pix_fmt yuv420p` 换成 `-pix_fmt yuva420p`。

### 6.5 透明素材（Safari）

ffmpeg 的 `libx265` 不支持 alpha。Safari 端 HEVC with Alpha `.mov` 建议用以下工具导出：

- Apple Compressor（HEVC with Alpha）；
- After Effects + Media Encoder；
- Shutter Encoder（`HEVC with Alpha`）；

导出参数：无音轨、GOP 6~10 帧、命名 `{module}/{viewport}{_2x}.mov`。

### 6.6 验收命令（第三方交付后自查）

```bash
# 1. 检查 GOP（关键帧时间戳，期望间隔 0.1~0.33s）
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
  -of csv=p=0 display/large.mp4 | awk -F, '$2 ~ /K/ {print $1}'

# 2. 检查音轨（期望只有 video，没有 audio）
ffprobe -v error -show_entries stream=codec_type -of csv=p=0 display/large.mp4

# 3. 检查编码 / 分辨率 / 帧率
ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate \
  -of default=noprint_wrappers=1 display/large.mp4
```

## 7. 给第三方团队的素材需求说明（可直接复制）

> 用途：官网滚动驱动逐帧动画（scroll scrub），需要按断点、DPR、浏览器输出多版本。
>
> 1. 时长：10~20 秒，最终由页面滚动区间决定，提供“首尾帧可循环/可衔接”更佳。
> 2. 帧率：60fps（产品细节）或 30fps；全片恒定帧率。
> 3. 关键帧间隔：GOP 6~10 帧（60fps 用 6，30fps 用 10）。这是双向滚动顺滑的硬性要求，不能用默认 GOP。
> 4. 音频：无。
> 5. 输出格式：
>    - `{module}/xlarge.mp4` / `xlarge_2x.mp4`：H.264 High，yuv420p，faststart；
>    - `{module}/xlarge.webm` / `xlarge_2x.webm`：VP9，yuv420p；
>    - 透明素材：额外输出 `{module}/xlarge.webm`（yuva420p）和 `{module}/xlarge.mov`（HEVC with Alpha）。
> 6. 断点与 2x：按第 6.1 节表格输出 xlarge / large / medium / small / xsmall，Retina 用 `_2x` 后缀（线性 2 倍分辨率）。
> 7. 命名：`{module}/{breakpoint}{_2x}.{webm|mp4|mov}`，例如 `display/xlarge_2x.webm`。
> 8. 交付前自查：用第 6.6 节 ffprobe 命令检查 GOP、无音轨、编码与分辨率；单文件体积尽量控制在 15MB 内（xlarge 1x）。

## 8. 注意事项

1. **本地打开**：组件直接使用 `<video src>`，不依赖 fetch / MediaSource，通常可通过 `file://` 双击运行；若浏览器限制本地媒体加载，请改用本地 HTTP server。
2. **生产环境**：视频放 CDN 并开启 Range 请求支持（响应头 `Accept-Ranges: bytes`），滚动 seek 才不会反复下载整个文件。
3. **布局稳定**：给视频容器预留固定高度或 `aspect-ratio`，避免加载后页面跳动（CLS）。
4. **iOS Safari**：video 必须 `muted + playsinline`；组件默认不调用 `play()`，靠 `currentTime` seek，不做 `play()` 倒放。
5. **首屏性能**：首屏 hero 不建议 `preload="none"` 拖太久；组件默认通过 `data-video-load-kf` 接近才加载，如用于 LCP 请提前加载。
6. **GOP 与体积**：关键帧越密回滚越顺、文件越大。6~10 帧是平衡点；不要用默认 2~5 秒 GOP。
7. **reduced motion**：组件默认在视频元数据就绪时读取 `prefers-reduced-motion: reduce`；命中后停在首帧并忽略后续滚动 seek。
8. **多实例**：组件可多实例运行，但每个实例都有独立的 scroll/rAF 监听；一个页面建议不超过 3~5 个，更多时用 IntersectionObserver 做懒加载。
9. **表达式子集**：当前实现支持 `aNt/aNb`、`t/b`、`px/vh/vw`，不支持 Apple 的 `css()` 变量与 `lerp()`；复杂区间可拆成多个 keyframe 或用 JS 回调计算。
10. **真机验证**：GOP、seek 手感、断点切换必须在真实 Chrome / Safari / iOS 上验证，静态检查不能替代。

## 9. 兼容性说明

### 9.1 支持的浏览器

| 浏览器 | 支持情况 | 说明 |
|---|---|---|
| Chrome / Edge（Chromium） | ✅ 推荐 | 优先 VP9 WebM，失败自动回退 MP4 |
| Firefox | ✅ 支持 | 同 Chrome，优先 WebM |
| Safari（macOS） | ✅ 支持 | 优先 H.264 MP4；透明素材用 HEVC with Alpha `.mov`（较新版本） |
| iOS Safari | ✅ 支持（有约束） | 必须 `muted + playsinline`；seek 手感依赖 GOP 与预加载 |
| IE11 | ❌ 不支持 | 组件使用 ES6+ 语法与现代 Web API，不提供 polyfill |

建议的官方支持线：**Chrome / Edge 79+、Firefox 68+、Safari 13+、iOS Safari 13+**；日常以最近两个大版本为主要验收对象。

代码采用 ES6+ 语法（`class`、箭头函数、模板字符串、解构、对象展开），但刻意不使用 ES2020+ 的可选链、空值合并、class 字段等特性，因此上表支持线内的浏览器无需转译即可直接运行。如需覆盖 IE 或更老内核，请用 Babel 转译后接入。

### 9.2 视频格式矩阵

| 平台 | 首选格式 | 回退顺序 | 透明视频 |
|---|---|---|---|
| Chrome / Edge / Firefox | WebM（VP9） | WebM → MP4 | WebM（VP9 + yuva420p） |
| Safari / iOS Safari | MP4（H.264） | MP4 → WebM | HEVC with Alpha `.mov` → MP4 → WebM → Poster |

组件按浏览器顺序尝试候选文件，某个格式 404 或解码失败会自动切下一个，全部失败则显示 `data-video-poster` 静态兜底。

### 9.3 依赖的浏览器能力

| 能力 | 用途 | 兼容性 |
|---|---|---|
| `requestAnimationFrame` | 滚动节流 | 所有现代浏览器 |
| `matchMedia` | 断点检测 | 新浏览器用 `addEventListener`；Safari 13 自动回退 `addListener` |
| `CustomEvent` | 派发 `scrollvideo:*` 事件 | Safari 10+、Chrome 15+ |
| `element.dataset` | 读取 `data-*` 配置 | 所有现代浏览器 |
| `prefers-reduced-motion` | 减弱动态效果 | 支持情况随浏览器版本变化；不支持时查询结果通常为 false，不影响运行 |
| `video.currentTime` 双向写入 | 滚动 scrub | 所有支持 `<video>` 的浏览器 |

### 9.4 运行环境兼容

- **本地 `file://`**：通常可用。组件直接用 `<video src>`，不依赖 fetch / MediaSource；若浏览器拦截本地媒体，请用本地 HTTP server。
- **生产 HTTP/CDN**：建议开启 Range 请求（响应头 `Accept-Ranges: bytes`），否则反向 seek 要等整段下载。
- **iOS Safari**：`muted + playsinline` 是硬性要求；省电模式、低数据模式可能放慢 seek，密集 GOP（6~10 帧）能明显改善。
- **断点切换**：切到新素材后组件会恢复到切换前的 `currentTime`；高 DPR 且新断点没有对应 `_2x` 文件时，会自动回退到同一断点的 1x 文件。
- **低端设备**：60fps + 2x 大尺寸视频会显著增加解码压力，建议按断点控制码率，必要时降到 30fps。

### 9.5 已知限制

1. 表达式只支持 `aNt/aNb`、`t/b`、`px/vh/vw`，不支持 Apple 的 `css()` 变量与 `lerp()`。
2. 未内置 MediaSource 流式加载（Apple 在 Chrome 端使用）；当前依赖 `<video src>` + Range，行为目标相近，但加载、缓存和性能路径不同，`_setSource()` 是预留的扩展点。
3. 断点默认阈值为 320 / 734 / 1068 / 1440；若项目断点不同，传入 `breakpoints` 覆盖即可，不要直接修改组件源码。
4. 页面同时挂载多个实例时各有独立的 scroll/rAF 监听，数量过多建议先用 IntersectionObserver 做懒加载（组件当前未内置）。

### 9.6 建议验收清单

- Chrome / Edge / Firefox / Safari（macOS）各跑一遍正放与快速回滚；
- iOS Safari 真机验证（`muted + playsinline`、省电模式）；
- 2x 高分屏验证 `_2x` 素材切换；
- 缩放到小窗触发断点切换，确认当前时间不跳变；
- 开启系统“减弱动态效果”，确认停在首帧；
- 执行 `npm test` 与 `node --check scroll-video.js`，确认回归测试和语法检查通过；
- 用第 6.6 节 ffprobe 命令复核第三方素材的 GOP 与无音轨。

## 10. 与 Apple 实现的对照

| Apple 方案 | 本组件 |
|---|---|
| `data-video-progress-kf` 声明式 keyframe | 支持（简化表达式子集） |
| `data-video-load-kf` 接近才加载 | 支持 |
| `data-video-breakpoint-substitution-map` | 支持 |
| `data-res="retina"` 2x 变体 | 支持（`data-video-retina="retina"`） |
| `currentTime = duration * progress` | 同款核心 |
| Chrome WebM + MediaSource 流式加载 | 未内置（直接 `video.src` + Range），保留 `_setSource` 扩展点 |
| `css()` 变量、`lerp()` 表达式 | 未实现，按需扩展 |
| 服务端 keyframe 调度、性能分析 | 未实现 |

组件刻意保持“零依赖、可复制、单文件”，核心链路与 Apple 一致，复杂调度部分留作扩展点，避免为了“像 Apple”而引入无法在本项目验证的复杂度。
