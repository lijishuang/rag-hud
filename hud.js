/*!
 * rag-hud.js — 知识库数据流 / RAG 检索过程可视化
 * 零依赖 · Canvas 2D · 传一个 canvas 即可运行
 *
 *   const hud = RagHud.create(document.querySelector('#hud'), {
 *     onStage(name, progress) {},
 *     onStats({ stage, candidates, hits, recall, latency, tokens }) {},
 *     onAnswer(text, done) {},
 *     onLog(text) {}
 *   });
 *
 *   hud.setQuery('...');
 *   hud.setStage('retrieve', 0.3);
 *   hud.setCandidates([{ id, label, score }]);
 *   hud.setHits([{ id, label, score }], { recall: 0.96, latency: 0.42 });
 *   hud.token('逐'); hud.token('字'); hud.done({ tokens: 128, latency: 2.1 });
 *   hud.attachSSE('https://host/api/rag/stream', { query: '...' });
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') module.exports = factory();
  else root.RagHud = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;
  var GOLD = Math.PI * (3 - Math.sqrt(5));

  var STAGE_ORDER = ['embed', 'retrieve', 'rerank', 'generate'];
  var STAGE_BASE = { embed: 0.02, retrieve: 0.24, rerank: 0.58, generate: 0.80, done: 1 };
  var STAGE_SPAN = { embed: 0.22, retrieve: 0.34, rerank: 0.22, generate: 0.20, done: 0 };
  var STAGE_EST = { embed: 0.8, retrieve: 1.4, rerank: 0.9, generate: 2.4, done: 0 };

  var DEFAULT_SOURCES = [
    { label: '网页抓取', x: 0.06, y: 0.20 },
    { label: 'PDF 文档', x: 0.05, y: 0.30 },
    { label: '数据库', x: 0.07, y: 0.40 },
    { label: '工单系统', x: 0.05, y: 0.50 },
    { label: 'API 推送', x: 0.07, y: 0.60 }
  ];

  function clamp(v, a, b) {
    a = a == null ? 0 : a; b = b == null ? 1 : b;
    return v < a ? a : v > b ? b : v;
  }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function create(canvas, opts) {
    opts = opts || {};
    if (!canvas) throw new Error('RagHud: 需要传入 canvas');

    var ctx = canvas.getContext('2d', { alpha: true });
    var flow = document.createElement('canvas');
    var fctx = flow.getContext('2d', { alpha: true });

    var MONO = opts.font || 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
    var INK = (opts.colors && opts.colors.ink) || '232,246,255';
    var ACC = (opts.colors && opts.colors.accent) || '50,240,140';

    var reduce = opts.reducedMotion != null ? !!opts.reducedMotion
      : !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    var SOURCES = (opts.sources || DEFAULT_SOURCES).slice();
    var SLOT_COUNT = opts.slotCount || 96;
    var PACKET_COUNT = opts.packetCount || 300;
    var SLOT_FROM = Math.PI * 0.80, SLOT_TO = Math.PI * 1.20, SLOT_R = 0.885;

    var app = {
      stage: 'idle', stageAt: 0, stageProgress: 0, gp: 0,
      candidates: [], hits: [], hitsAt: 0, hitSlots: new Set(),
      recall: 0, latency: 0, tokens: 0, answer: '', logs: [],
      burstAt: 0
    };

    var NODES = [], WEB = [], STORE = [], OCCUPIED = new Set();
    var seedState = 20261127;

    /* ---------------- 会话录制 / 回放 ---------------- */
    var REC = { on: opts.record !== false, t0: 0, events: [], closed: false };
    var LAST = null;   // 最近一轮完整会话
    var rp = null;     // 当前回放状态

    function rec(kind, data) {
      if (!REC.on || rp || REC.closed) return;
      if (!REC.events.length) REC.t0 = now;
      REC.events.push({ t: Math.round((now - REC.t0) * 1000), kind: kind, data: data });
      if (kind === 'done') {
        LAST = { version: 1, ms: Math.round((now - REC.t0) * 1000), events: REC.events.slice() };
        REC.events = [];
        REC.closed = true;
      }
    }

    function applyEvent(e) {
      var d = e.data || {};
      switch (e.kind) {
        case 'stage': setStage(d.name, d.progress); break;
        case 'candidates': buildNodes(d.chunks || []); break;
        case 'hits': setHits(d.chunks || [], d.meta || {}); break;
        case 'token': pushToken(d.text); break;
        case 'log': pushLog(d.text); break;
        case 'done': finish(d.meta || {}); break;
      }
    }

    function advanceReplay(dt) {
      rp.clock += dt * 1000 * rp.speed;
      var list = rp.s.events;
      while (rp.idx < list.length && list[rp.idx].t <= rp.clock) applyEvent(list[rp.idx++]);

      if (rp.idx >= list.length) {
        if (rp.loop) {
          rp.idx = 0;
          rp.clock = 0;
          reset();
        } else if (!rp.ended) {
          rp.ended = true;
          rp.playing = false;
          if (rp.onEnd) rp.onEnd();
        }
      }
    }

    function seekReplay(ms) {
      if (!rp) return;
      var list = rp.s.events;
      rp.clock = clamp(ms, 0, rp.s.ms);
      rp.idx = 0;
      rp.ended = false;
      reset();
      while (rp.idx < list.length && list[rp.idx].t <= rp.clock) applyEvent(list[rp.idx++]);
    }
    function seeded() {
      seedState = (seedState * 1664525 + 1013904223) >>> 0;
      return seedState / 4294967296;
    }

    var W = 0, H = 0, halo = null, now = 0, lastTs = 0, raf = 0, alive = true;
    var net = { x: 0, y: 0, r: 1 };
    var ring = { x: 0, y: 0, r: 1 };

    /* ---------------- 槽位：id → 固定角度 ---------------- */
    function hashId(s) {
      var h = 2166136261, i;
      s = String(s);
      for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }
    function slotOf(id) { return hashId(id) % SLOT_COUNT; }
    function slotAngle(slot) {
      return SLOT_FROM + ((slot + 0.5) / SLOT_COUNT) * (SLOT_TO - SLOT_FROM);
    }
    function slotPoint(slot) {
      var a = slotAngle(slot);
      return {
        a: a,
        x: ring.x + Math.cos(a) * ring.r * SLOT_R,
        y: ring.y + Math.sin(a) * ring.r * SLOT_R
      };
    }
    function setStore(ids) {
      STORE = ids;
      OCCUPIED = new Set(ids.map(slotOf));
    }

    /* ---------------- 采集流 ---------------- */
    var PACKETS = [], WRITES = [];
    function resetPacket(p) {
      p.s = (Math.random() * SOURCES.length) | 0;
      p.id = STORE.length ? STORE[(Math.random() * STORE.length) | 0] : 'seed';
      p.slot = slotOf(p.id);
      var pt = slotPoint(p.slot);
      p.x = pt.x; p.y = pt.y;
      p.u = Math.random() * 0.35;
      p.sp = 0.22 + Math.random() * 0.5;
      p.al = 0.10 + Math.random() * 0.38;
      p.w = Math.random() < 0.12 ? 1.5 : 0.7;
      p.bow = (Math.random() - 0.5) * 0.5;
    }
    for (var pi = 0; pi < PACKET_COUNT; pi++) {
      var pk = {};
      resetPacket(pk);
      pk.u = Math.random();
      PACKETS.push(pk);
    }

    var _p1 = { x: 0, y: 0 }, _p2 = { x: 0, y: 0 };
    function quadPt(out, u, ax, ay, cx, cy, bx, by) {
      var iu = 1 - u;
      out.x = iu * iu * ax + 2 * iu * u * cx + u * u * bx;
      out.y = iu * iu * ay + 2 * iu * u * cy + u * u * by;
      return out;
    }

    /* ---------------- 尺寸 ---------------- */
    function layout() {
      var cw = canvas.clientWidth || canvas.width || 800;
      var ch = canvas.clientHeight || canvas.height || 600;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = cw; H = ch;

      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      flow.width = Math.max(1, W);
      flow.height = Math.max(1, H);

      net.x = W * 0.42; net.y = H * 0.52; net.r = Math.min(W, H) * 0.38;
      ring.x = W * 1.04; ring.y = H * 0.5; ring.r = Math.min(H * 0.80, W * 0.78);

      halo = ctx.createRadialGradient(net.x, net.y, 0, net.x, net.y, 120);
      halo.addColorStop(0, 'rgba(' + INK + ',.13)');
      halo.addColorStop(1, 'rgba(' + INK + ',0)');
    }

    /* ---------------- 状态变化 ---------------- */
    function setStage(name, progress) {
      if (name !== 'done') rec('stage', { name: name, progress: progress });
      if (STAGE_ORDER.indexOf(name) >= 0 && name !== app.stage) {
        app.stage = name;
        app.stageAt = now;
        app.stageProgress = progress || 0;
        if (name === 'retrieve') app.burstAt = now;
        if (opts.onStage) opts.onStage(name, app.stageProgress);
      } else if (progress != null) {
        app.stageProgress = progress;
      }
      if (name === 'done') {
        app.stage = 'done';
        app.stageAt = now;
        if (opts.onStage) opts.onStage('done', 1);
      }
    }

    function buildNodes(list) {
      rec('candidates', { chunks: list });
      app.candidates = list;
      setStore(list.map(function (c) { return c.id; }));

      NODES = list.map(function (c, i) {
        return {
          chunk: c, hit: false, hitAt: 0, rank: i,
          a: i * GOLD + 0.7,
          rn: 0.18 + 0.74 * Math.sqrt(seeded()),
          ph: seeded() * TAU,
          appearAt: now + i * 0.018
        };
      });

      WEB = [];
      var seen = {}, pos = NODES.map(function (n) {
        return { x: Math.cos(n.a) * n.rn, y: Math.sin(n.a) * n.rn * 0.86 };
      });
      for (var i = 0; i < NODES.length; i++) {
        var near = [];
        for (var j = 0; j < NODES.length; j++) {
          if (i === j) continue;
          var dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
          near.push({ j: j, d: dx * dx + dy * dy });
        }
        near.sort(function (p, q) { return p.d - q.d; });
        for (var k = 0; k < 2 && k < near.length; k++) {
          var jj = near[k].j;
          var key = i < jj ? i + '-' + jj : jj + '-' + i;
          if (seen[key]) continue;
          seen[key] = 1;
          WEB.push({ a: i, b: jj });
        }
      }
    }

    function setHits(list, meta) {
      meta = meta || {};
      rec('hits', { chunks: list, meta: { recall: meta.recall, latency: meta.latency } });
      app.hits = list;
      app.hitsAt = now;
      app.hitSlots = new Set(list.map(function (c) { return slotOf(c.id); }));
      if (meta.recall != null) app.recall = meta.recall;
      if (meta.latency != null) app.latency = meta.latency;

      var byId = {};
      list.forEach(function (c, i) { byId[c.id] = i; });
      NODES.forEach(function (n) {
        if (byId[n.chunk.id] != null) {
          n.hit = true;
          n.rank = byId[n.chunk.id];
          n.hitAt = now + n.rank * 0.02;
        }
      });
      list.forEach(function (c, i) {
        var exists = NODES.some(function (n) { return n.chunk.id === c.id; });
        if (exists) return;
        NODES.push({
          chunk: c, hit: true, hitAt: now + i * 0.02, rank: i,
          a: i * GOLD + 3.1,
          rn: 0.24 + 0.66 * Math.sqrt(seeded()),
          ph: seeded() * TAU,
          appearAt: now
        });
      });
    }

    function pushLog(text) {
      rec('log', { text: text });
      app.logs.push({ text: text, t: now });
      if (app.logs.length > 60) app.logs.splice(0, app.logs.length - 60);
      if (opts.onLog) opts.onLog(text);
    }

    function pushToken(text) {
      if (!text) return;
      rec('token', { text: text });
      app.answer += text;
      app.tokens += 1;
      if (opts.onAnswer) opts.onAnswer(app.answer, false);
    }

    function finish(meta) {
      meta = meta || {};
      rec('done', { meta: { tokens: meta.tokens, latency: meta.latency } });
      app.tokens = meta.tokens != null ? meta.tokens : app.answer.length;
      if (meta.latency != null) app.latency = meta.latency;
      setStage('done');
      if (opts.onAnswer) opts.onAnswer(app.answer, true);
    }

    function reset() {
      app.stage = 'idle'; app.stageAt = 0; app.stageProgress = 0; app.gp = 0;
      app.candidates = []; app.hits = []; app.hitsAt = 0; app.hitSlots = new Set();
      app.recall = 0; app.latency = 0; app.tokens = 0; app.answer = '';
      app.logs = []; app.burstAt = 0;
      NODES = []; WEB = []; setStore([]);
      seedState = 20261127;
      lastStats = '';
      REC.events = [];
      REC.t0 = 0;
      REC.closed = false;
      if (opts.onStage) opts.onStage('idle', 0);
      if (opts.onAnswer) opts.onAnswer('', false);
    }

    /* ---------------- 绘制 ---------------- */
    function nodePos(n, t) {
      var wob = reduce ? 0 : Math.sin(t * 0.9 + n.ph) * 0.012;
      var a = n.a + wob;
      var r = net.r * n.rn + (reduce ? 0 : Math.sin(t * 1.3 + n.ph * 2) * 4);
      return { x: net.x + Math.cos(a) * r, y: net.y + Math.sin(a) * r * 0.86 };
    }

    function look(n, t) {
      var p = clamp((t - n.appearAt) / 0.5);
      var reveal = easeOut(p);
      var hitP = n.hit ? clamp((t - n.hitAt) / 0.45) : 0;
      var dimP = app.hitsAt ? clamp((t - app.hitsAt) / 0.6) : 0;
      var alpha = (0.10 + 0.55 * n.chunk.score) * reveal;
      if (app.hitsAt && !n.hit) alpha *= (1 - 0.80 * dimP);
      return { reveal: reveal, hitP: hitP, alpha: alpha, len: reveal };
    }

    function drawFlow(t, dt) {
      fctx.fillStyle = reduce ? 'rgba(5,7,10,0.90)' : 'rgba(5,7,10,0.20)';
      fctx.fillRect(0, 0, W, H);

      var rate = app.stage === 'retrieve' ? 0.55
        : app.stage === 'generate' ? 0.45 : 1.3;

      fctx.lineCap = 'round';

      for (var i = 0; i < PACKETS.length; i++) {
        var p = PACKETS[i];
        p.u += p.sp * dt * rate;

        var S = SOURCES[p.s] || SOURCES[0];
        var sx = S.x * W, sy = S.y * H;
        var dx = p.x - sx, dy = p.y - sy;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var cxp = sx + dx * 0.5 - (dy / dist) * dist * p.bow;
        var cyp = sy + dy * 0.5 + (dx / dist) * dist * p.bow;

        if (p.u >= 1) {
          WRITES.push({ slot: p.slot, t: t });
          if (WRITES.length > 16) WRITES.shift();
          resetPacket(p);
          continue;
        }

        var head = quadPt(_p1, p.u, sx, sy, cxp, cyp, p.x, p.y);
        var tail = quadPt(_p2, Math.max(0, p.u - 0.016), sx, sy, cxp, cyp, p.x, p.y);

        fctx.beginPath();
        fctx.moveTo(tail.x, tail.y);
        fctx.lineTo(head.x, head.y);
        fctx.strokeStyle = 'rgba(' + INK + ',' + p.al.toFixed(3) + ')';
        fctx.lineWidth = p.w;
        fctx.stroke();

        fctx.beginPath();
        fctx.arc(head.x, head.y, 1.15, 0, TAU);
        fctx.fillStyle = 'rgba(' + INK + ',' + Math.min(0.8, p.al * 1.6).toFixed(3) + ')';
        fctx.fill();
      }

      for (var w = WRITES.length - 1; w >= 0; w--) {
        var it = WRITES[w];
        var k = (t - it.t) / 0.45;
        if (k > 1) { WRITES.splice(w, 1); continue; }
        var pt = slotPoint(it.slot);
        fctx.beginPath();
        fctx.arc(pt.x, pt.y, 1.5 + k * 5, 0, TAU);
        fctx.strokeStyle = 'rgba(' + ACC + ',' + (0.20 * (1 - k)).toFixed(3) + ')';
        fctx.lineWidth = 1;
        fctx.stroke();
      }
    }

    function drawSources(t) {
      ctx.font = '10px ' + MONO;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (var i = 0; i < SOURCES.length; i++) {
        var s = SOURCES[i];
        var x = s.x * W, y = s.y * H;
        var beat = reduce ? 0 : 0.5 + 0.5 * Math.sin(t * 1.6 + i);

        ctx.beginPath();
        ctx.arc(x, y, 6.5 + beat * 1.5, 0, TAU);
        ctx.strokeStyle = 'rgba(' + INK + ',' + (0.14 + beat * 0.10).toFixed(3) + ')';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, TAU);
        ctx.fillStyle = 'rgba(' + INK + ',.6)';
        ctx.fill();

        ctx.fillStyle = 'rgba(' + INK + ',.42)';
        ctx.fillText(s.label, x + 11, y);
      }
    }

    function drawLogs(t) {
      if (!app.logs.length) return;
      var LOG_MAX = 6, LOG_LH = 16;
      var colW = Math.min(300, W * 0.30);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, colW, H);
      ctx.clip();
      ctx.font = '10px ' + MONO;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      var baseY = H - 105;
      for (var k = 0; k < app.logs.length && k < LOG_MAX; k++) {
        var item = app.logs[app.logs.length - 1 - k];
        var y = baseY - k * LOG_LH;
        if (y < 96) break;
        var fin = clamp((t - item.t) / 0.25);
        var alpha = 0.30 * (1 - k / LOG_MAX) * fin;
        ctx.fillStyle = 'rgba(' + INK + ',' + alpha.toFixed(3) + ')';
        ctx.fillText(item.text, 12, y);
      }
      ctx.restore();
    }

    function drawNetwork(t) {
      var hub = net;
      var i;

      if (app.burstAt) {
        var bs = t - app.burstAt;
        if (bs >= 0 && bs < 0.8) {
          var fade = Math.sin((bs / 0.8) * Math.PI) * 0.55;
          for (i = 0; i < 54; i++) {
            var a = (i / 54) * TAU + t * 0.6;
            var r0 = 8 + bs * 70;
            var r1 = r0 + (40 + (i % 5) * 40) * (0.4 + bs);
            ctx.beginPath();
            ctx.moveTo(hub.x + Math.cos(a) * r0, hub.y + Math.sin(a) * r0);
            ctx.lineTo(hub.x + Math.cos(a) * r1, hub.y + Math.sin(a) * r1);
            ctx.strokeStyle = 'rgba(' + INK + ',' + (fade * (0.3 + (i % 3) * 0.2)).toFixed(3) + ')';
            ctx.lineWidth = i % 6 === 0 ? 1.5 : 0.7;
            ctx.stroke();
          }
        }
      }

      var pts = NODES.map(function (n) { return nodePos(n, t); });
      var looks = NODES.map(function (n) { return look(n, t); });

      ctx.lineWidth = 0.45;
      for (i = 0; i < WEB.length; i++) {
        var e = WEB[i], la = looks[e.a], lb = looks[e.b];
        if (!la || !lb || la.alpha < 0.015 || lb.alpha < 0.015) continue;
        var alpha = Math.min(la.alpha, lb.alpha) *
          (0.30 + 0.35 * Math.min(NODES[e.a].chunk.score, NODES[e.b].chunk.score));
        ctx.beginPath();
        ctx.moveTo(pts[e.a].x, pts[e.a].y);
        ctx.lineTo(pts[e.b].x, pts[e.b].y);
        ctx.strokeStyle = (la.hitP > 0.5 && lb.hitP > 0.5)
          ? 'rgba(' + ACC + ',' + (alpha * 0.8).toFixed(3) + ')'
          : 'rgba(' + INK + ',' + alpha.toFixed(3) + ')';
        ctx.stroke();
      }

      ctx.setLineDash([4, 9]);
      ctx.lineDashOffset = (t * 46) % 13;

      for (i = 0; i < NODES.length; i++) {
        var n = NODES[i], L = looks[i];
        if (L.alpha < 0.015 || L.len < 0.02) continue;

        var p = pts[i];
        var ex = hub.x + (p.x - hub.x) * L.len;
        var ey = hub.y + (p.y - hub.y) * L.len;
        var dx = ex - hub.x, dy = ey - hub.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var cxp = hub.x + dx * 0.55 - (dy / dist) * dist * 0.16;
        var cyp = hub.y + dy * 0.55 + (dx / dist) * dist * 0.16;

        n._c = { cxp: cxp, cyp: cyp, ex: ex, ey: ey };

        ctx.beginPath();
        ctx.moveTo(hub.x, hub.y);
        ctx.quadraticCurveTo(cxp, cyp, ex, ey);
        if (n.hit) {
          ctx.strokeStyle = 'rgba(' + ACC + ',' + (L.alpha * (0.45 + L.hitP * 0.55)).toFixed(3) + ')';
          ctx.lineWidth = 0.5 + n.chunk.score * 2.0 + L.hitP * 0.7;
        } else {
          ctx.strokeStyle = 'rgba(' + INK + ',' + (L.alpha * 0.55).toFixed(3) + ')';
          ctx.lineWidth = 0.45;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (i = 0; i < NODES.length; i++) {
        var nn = NODES[i], LL = looks[i];
        if (!nn._c || LL.alpha < 0.05) continue;
        var speed = nn.hit ? 0.55 : 0.28;
        var u = 1 - ((t * speed + nn.ph / TAU) % 1);
        var iu = 1 - u;
        var x = iu * iu * hub.x + 2 * iu * u * nn._c.cxp + u * u * nn._c.ex;
        var y = iu * iu * hub.y + 2 * iu * u * nn._c.cyp + u * u * nn._c.ey;

        ctx.beginPath();
        ctx.arc(x, y, nn.hit ? 1.9 : 1.2, 0, TAU);
        ctx.fillStyle = nn.hit
          ? 'rgba(' + ACC + ',' + (0.75 * LL.hitP + 0.2).toFixed(3) + ')'
          : 'rgba(' + INK + ',' + (0.55 * LL.alpha).toFixed(3) + ')';
        ctx.fill();
      }

      for (i = 0; i < NODES.length; i++) {
        var q = NODES[i], Lq = looks[i];
        if (Lq.alpha < 0.015) continue;
        var pp = pts[i];
        var r = (q.hit ? 1.5 + q.chunk.score * 1.3 : 0.65 + q.chunk.score * 0.85) + Lq.hitP * 0.8;

        ctx.beginPath();
        ctx.arc(pp.x, pp.y, r, 0, TAU);
        ctx.fillStyle = q.hit
          ? 'rgba(' + ACC + ',' + clamp(Lq.alpha + 0.35).toFixed(3) + ')'
          : 'rgba(' + INK + ',' + clamp(Lq.alpha + 0.05).toFixed(3) + ')';
        ctx.fill();

        if (q.hit && Lq.hitP > 0.15) {
          ctx.beginPath();
          ctx.arc(pp.x, pp.y, r + 5 + Math.sin(t * 3 + q.ph) * 1.2, 0, TAU);
          ctx.strokeStyle = 'rgba(' + ACC + ',' + (0.30 * Lq.hitP).toFixed(3) + ')';
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }

      var boxes = [{ x: hub.x - 70, y: hub.y - 18, w: 140, h: 36 }];
      function hitBox(b) {
        for (var bi = 0; bi < boxes.length; bi++) {
          var o = boxes[bi];
          if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) return true;
        }
        return false;
      }

      ctx.font = '10px ' + MONO;
      ctx.textBaseline = 'middle';
      var labeled = NODES.filter(function (n2) { return n2.hit && n2.chunk.label; }).slice(0, 6);
      for (var li = 0; li < labeled.length; li++) {
        var ln = labeled[li];
        var lk = look(ln, t);
        if (lk.hitP <= 0.55) continue;
        var lp = nodePos(ln, t);
        if (lp.y > H * 0.72) continue;
        var tw = ctx.measureText(ln.chunk.label).width;
        var right = lp.x >= hub.x;
        var lx = right ? lp.x + 10 : lp.x - 10 - tw;
        if (lx < 8 || lx + tw > W * 0.74) continue;
        var box = { x: lx - 3, y: lp.y - 8, w: tw + 6, h: 16 };
        if (hitBox(box)) continue;
        boxes.push(box);

        ctx.beginPath();
        ctx.moveTo(right ? lp.x + 6 : lp.x - 6, lp.y);
        ctx.lineTo(right ? lx - 2 : lx + tw + 2, lp.y);
        ctx.strokeStyle = 'rgba(' + INK + ',' + (0.16 * lk.hitP).toFixed(3) + ')';
        ctx.lineWidth = 0.6;
        ctx.stroke();

        ctx.fillStyle = 'rgba(5,7,10,0.82)';
        ctx.fillRect(box.x, box.y, box.w, box.h);

        ctx.textAlign = right ? 'left' : 'right';
        ctx.fillStyle = 'rgba(' + INK + ',' + (0.62 * lk.hitP).toFixed(3) + ')';
        ctx.fillText(ln.chunk.label, lx, lp.y);
      }

      if (halo) {
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(hub.x, hub.y, 120, 0, TAU);
        ctx.fill();
      }
      var pulse = reduce ? 5 : 5 + Math.sin(t * 4) * 1.1;
      ctx.beginPath();
      ctx.arc(hub.x, hub.y, pulse, 0, TAU);
      ctx.fillStyle = 'rgba(' + INK + ',1)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hub.x, hub.y, pulse + 7, 0, TAU);
      ctx.strokeStyle = 'rgba(' + INK + ',.35)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    function drawRing(t, gp) {
      var x = ring.x, y = ring.y, r = ring.r;
      ctx.save();
      ctx.translate(x, y);

      var spin = t * (app.stage === 'retrieve' ? 0.75 : 0.24);

      [0.50, 0.575, 0.635].forEach(function (f, i) {
        ctx.beginPath();
        ctx.arc(0, 0, r * f, Math.PI * 0.5, Math.PI * 1.5);
        ctx.strokeStyle = i === 1 ? 'rgba(' + INK + ',.16)' : 'rgba(' + INK + ',.07)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      var TICKS = 150, pass, i;
      for (pass = 0; pass < 2; pass++) {
        var lag = pass === 0 ? 0 : 0.035;
        for (i = 0; i < TICKS; i++) {
          var th = Math.PI * 1.5 + (i / TICKS) * TAU + spin - lag;
          var cs = Math.cos(th);
          if (cs > 0.06) continue;
          var fade = clamp((0.06 - cs) / 0.28) * (pass === 0 ? 1 : 0.3);
          var major = i % 10 === 0;

          ctx.beginPath();
          ctx.moveTo(Math.cos(th) * r * 0.862, Math.sin(th) * r * 0.862);
          ctx.lineTo(Math.cos(th) * r * (major ? 0.808 : 0.842),
            Math.sin(th) * r * (major ? 0.808 : 0.842));
          ctx.strokeStyle = 'rgba(' + INK + ',' + ((major ? 0.85 : 0.40) * fade).toFixed(3) + ')';
          ctx.lineWidth = major ? 1.6 : 0.8;
          ctx.stroke();

          if (i % 3 === 0) {
            var rb = r * 0.768;
            ctx.save();
            ctx.translate(Math.cos(th) * rb, Math.sin(th) * rb);
            ctx.rotate(th + Math.PI / 2);
            ctx.fillStyle = 'rgba(' + INK + ',' + (0.42 * fade).toFixed(3) + ')';
            for (var row = 0; row < 4; row++) {
              ctx.fillRect(-1, row * 3.2 - 6, row % 2 === 0 ? 6 : 9, 2);
            }
            ctx.restore();
          }
        }
      }

      ctx.beginPath();
      ctx.arc(0, 0, r * 0.955, Math.PI * 0.5, Math.PI * 1.5);
      ctx.strokeStyle = 'rgba(' + INK + ',.12)';
      ctx.lineWidth = 1;
      ctx.stroke();

      for (var k = 0; k < 3; k++) {
        var a0 = Math.PI * 1.5 + (((t * 0.22 + k * 0.36) % 1) * Math.PI);
        if (Math.cos(a0) > 0) continue;
        ctx.beginPath();
        ctx.arc(0, 0, r * (0.90 + k * 0.02), a0, a0 + 0.09 + k * 0.03);
        ctx.strokeStyle = 'rgba(' + INK + ',' + (0.55 - k * 0.13) + ')';
        ctx.lineWidth = 2.4 - k * 0.6;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      var start = Math.PI * 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.885, start, start + TAU * 0.5 * gp);
      ctx.strokeStyle = 'rgba(' + ACC + ',.80)';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.885, start, start + TAU * 0.5 * gp);
      ctx.strokeStyle = 'rgba(' + ACC + ',.13)';
      ctx.lineWidth = 10;
      ctx.stroke();

      var sa = Math.PI * 1.5 + (t * 0.9) % Math.PI;
      if (Math.cos(sa) < 0.1) {
        var g = ctx.createLinearGradient(
          Math.cos(sa) * r * 0.55, Math.sin(sa) * r * 0.55,
          Math.cos(sa) * r * 0.88, Math.sin(sa) * r * 0.88
        );
        g.addColorStop(0, 'rgba(' + INK + ',0)');
        g.addColorStop(1, 'rgba(' + INK + ',.20)');
        ctx.beginPath();
        ctx.moveTo(Math.cos(sa) * r * 0.55, Math.sin(sa) * r * 0.55);
        ctx.lineTo(Math.cos(sa) * r * 0.88, Math.sin(sa) * r * 0.88);
        ctx.strokeStyle = g;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.restore();
    }

    function drawSlots(t) {
      for (var s = 0; s < SLOT_COUNT; s++) {
        var pt = slotPoint(s);
        var hit = app.hitSlots.has(s);
        var used = OCCUPIED.has(s);

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, hit ? 2.4 : used ? 1.5 : 1.0, 0, TAU);
        ctx.fillStyle = hit
          ? 'rgba(' + ACC + ',.95)'
          : used ? 'rgba(' + INK + ',.30)' : 'rgba(' + INK + ',.09)';
        ctx.fill();

        if (hit) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5 + Math.sin(t * 3 + s) * 1.2, 0, TAU);
          ctx.strokeStyle = 'rgba(' + ACC + ',.35)';
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }

    /* ---------------- 主循环 ---------------- */
    var lastStats = '';
    function emitStats() {
      if (!opts.onStats) return;
      var s = app.stage;
      var topk = s === 'retrieve' ? app.candidates.length
        : (app.hits.length || '—');
      var recall = app.recall ? Math.round(app.recall * 100) + '%' : '—';
      var latency = app.latency ? Number(app.latency).toFixed(2) + 's' : '—';
      var sig = [s, topk, recall, latency, app.tokens].join('|');
      if (sig === lastStats) return;
      lastStats = sig;
      opts.onStats({
        stage: s,
        candidates: app.candidates.length,
        hits: app.hits.length,
        topk: topk,
        recall: recall,
        latency: latency,
        tokens: app.tokens
      });
    }

    function frame(ts) {
      if (!alive) return;
      var dt = Math.min((ts - lastTs) / 1000 || 0.016, 0.05);
      lastTs = ts;
      now = ts / 1000;

      if (rp && rp.playing) advanceReplay(dt);

      var base = STAGE_BASE[app.stage] != null ? STAGE_BASE[app.stage] : app.gp;
      var span = STAGE_SPAN[app.stage] || 0;
      var est = STAGE_EST[app.stage] || 1;
      var sp = app.stageProgress || clamp((now - app.stageAt) / est);
      var target = app.stage === 'idle' ? 0 : base + span * sp;
      app.gp += (target - app.gp) * Math.min(1, dt * 4);

      drawFlow(now, dt);

      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(flow, 0, 0, W, H);

      drawSources(now);
      drawLogs(now);
      drawNetwork(now);
      drawRing(now, app.gp);
      drawSlots(now);

      emitStats();
      raf = requestAnimationFrame(frame);
    }

    /* ---------------- 外部接口 ---------------- */
    var ro = null;
    layout();
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () { layout(); });
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', layout);
    }
    raf = requestAnimationFrame(frame);

    var sse = null;

    var api = {
      setStage: setStage,
      setCandidates: function (list) {
        buildNodes(list || []);
        pushLog('[retrieve] candidates=' + app.candidates.length);
      },
      setHits: function (list, meta) { setHits(list || [], meta); },
      token: pushToken,
      done: finish,
      log: pushLog,
      reset: reset,
      /** 开启/关闭录制，关闭后 exportSession 仍返回上一轮 */
      record: function (on) { REC.on = on !== false; REC.events = []; REC.closed = false; },
      /** 导出最近一轮会话，可存成 JSON 离线回放 */
      exportSession: function () { return LAST; },
      /**
       * 回放一轮会话
       * @param session 省略时回放最近一轮
       * @param options { speed, loop, onEnd }
       */
      replay: function (session, options) {
        var s = session || LAST;
        if (!s || !s.events || !s.events.length) return null;
        options = options || {};

        reset();
        rp = {
          s: s, idx: 0, clock: 0,
          speed: options.speed || 1,
          loop: !!options.loop,
          playing: true, ended: false,
          onEnd: options.onEnd || null
        };

        return {
          play: function () { if (rp) { rp.playing = true; } },
          pause: function () { if (rp) { rp.playing = false; } },
          stop: function () { rp = null; },
          seek: seekReplay,
          progress: function () { return rp ? clamp(rp.clock / (rp.s.ms || 1)) : 0; }
        };
      },
      state: function () { return app; },
      destroy: function () {
        alive = false;
        rp = null;
        cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        else window.removeEventListener('resize', layout);
        if (sse) sse.close();
      },
      attachSSE: function (url, options) {
        options = options || {};
        var q = options.query || '';
        var opened = false;
        var closed = false;

        function connect() {
          if (closed) return;
          var full = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(q);
          var es;
          try { es = new EventSource(full); }
          catch (e) { if (options.onFail) options.onFail(e); return; }

          sse = es;
          es.onopen = function () {
            opened = true;
            if (options.onStatus) options.onStatus('live');
          };
          es.onerror = function () {
            if (!opened) {
              es.close();
              sse = null;
              if (options.onStatus) options.onStatus('offline');
              if (options.onFail) options.onFail();
            }
          };
          es.addEventListener('meta', function (e) {
            var d = JSON.parse(e.data);
            if (options.onMeta) options.onMeta(d);
            if (d.model) pushLog('[meta] model=' + d.model);
          });
          es.addEventListener('stage', function (e) {
            var d = JSON.parse(e.data);
            setStage(d.name, d.progress);
          });
          es.addEventListener('candidates', function (e) {
            api.setCandidates(JSON.parse(e.data).chunks);
          });
          es.addEventListener('hits', function (e) {
            var d = JSON.parse(e.data);
            setHits(d.chunks || [], d);
          });
          es.addEventListener('token', function (e) {
            pushToken(JSON.parse(e.data).text);
          });
          es.addEventListener('log', function (e) {
            pushLog(JSON.parse(e.data).text);
          });
          es.addEventListener('done', function (e) {
            var d = JSON.parse(e.data);
            finish(d);
            pushLog('[done] tokens=' + app.tokens +
              ' latency=' + Number(app.latency).toFixed(2) + 's');
            try { es.close(); } catch (_) {}
            sse = null;
            if (options.reconnect) {
              setTimeout(function () { reset(); connect(); },
                options.reconnectDelay || 3200);
            }
          });
        }
        connect();
        return {
          close: function () { closed = true; if (sse) sse.close(); }
        };
      }
    };

    return api;
  }

  return { create: create, version: '1.0.0' };
});
