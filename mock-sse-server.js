#!/usr/bin/env node
/**
 * 本地 mock RAG SSE 服务（零依赖）
 *
 *   node mock-sse-server.js
 *   打开 http://127.0.0.1:8787/rag-hud-demo.html
 *
 * 接口：GET /api/rag/stream?q=...
 * 事件：meta / stage / candidates / hits / token / log / done
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;

const CHUNKS = [
  { id: 'ch_0481', label: '手册 §3.2 计费规则', score: 0.93 },
  { id: 'ch_0192', label: 'FAQ 退款政策',      score: 0.91 },
  { id: 'ch_0267', label: 'API /v2/search',    score: 0.88 },
  { id: 'ch_0355', label: '工单 #4821 记录',   score: 0.86 },
  { id: 'ch_0104', label: 'SLA 协议 第 4 条',  score: 0.83 },
  { id: 'ch_0412', label: '定价页快照',        score: 0.79 },
  { id: 'ch_0017', label: '上线公告 2026-09',  score: 0.76 },
  { id: 'ch_0298', label: '风控策略说明',      score: 0.74 },
  { id: 'ch_0517', label: '阶梯计费示例',      score: 0.71 },
  { id: 'ch_0233', label: '套餐用量报表',      score: 0.68 },
  { id: 'ch_0064', label: '账单字段说明',      score: 0.63 },
  { id: 'ch_0371', label: '客户来信 #882',     score: 0.58 },
  { id: 'ch_0128', label: '手册 §1.1 术语',    score: 0.56 },
  { id: 'ch_0442', label: '发票开具流程',      score: 0.54 },
  { id: 'ch_0207', label: '支付回调重试',      score: 0.53 },
  { id: 'ch_0333', label: '用量告警配置',      score: 0.51 },
  { id: 'ch_0091', label: '超限降级策略',      score: 0.50 },
  { id: 'ch_0478', label: '企业版价目表',      score: 0.48 },
  { id: 'ch_0164', label: '客服话术 计费类',   score: 0.47 },
  { id: 'ch_0286', label: '计费变更公告',      score: 0.45 },
  { id: 'ch_0052', label: '退款工单汇总',      score: 0.44 },
  { id: 'ch_0399', label: '账单导出说明',      score: 0.43 },
  { id: 'ch_0117', label: '季度对账表',        score: 0.42 },
  { id: 'ch_0251', label: '试用转正规则',      score: 0.41 },
  { id: 'ch_0368', label: '优惠券叠加规则',    score: 0.40 },
  { id: 'ch_0043', label: '续费提醒模板',      score: 0.39 },
  { id: 'ch_0176', label: '合同条款 附件二',   score: 0.38 },
  { id: 'ch_0305', label: '用量统计口径',      score: 0.37 },
  { id: 'ch_0079', label: '账单邮件模板',      score: 0.36 },
  { id: 'ch_0421', label: '税务信息维护',      score: 0.35 },
  { id: 'ch_0135', label: '代理商结算单',      score: 0.34 },
  { id: 'ch_0249', label: '月结账期说明',      score: 0.33 },
  { id: 'ch_0387', label: '异常账单排查',      score: 0.32 },
  { id: 'ch_0011', label: '调价通知 2026',     score: 0.31 },
  { id: 'ch_0294', label: '服务等级说明',      score: 0.30 },
  { id: 'ch_0458', label: '历史版本归档',      score: 0.29 },
];

const ANSWER =
  '账单多出的 42 元来自 §3.2 的阶梯计费：套餐内 1000 次调用已在 3 月 14 日用完，' +
  '超出部分按 0.042 元/次计费，本周期共超出 1000 次，因此产生 42 元。' +
  '如果想固定费用，可以切换到年付套餐，或把超额调用限制在告警阈值内。';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const wait = ms => new Promise(r => setTimeout(r, ms));

/* 把回答切成小片段，模拟 token 流 */
function pieces(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function handleStream(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const q = url.searchParams.get('q') || '这份账单为什么多收了 42 元？';
  const started = Date.now();

  try {
    send('meta', { query: q, model: 'mock-rag-v1' });

    /* 1. 向量化 */
    send('stage', { name: 'embed', progress: 0 });
    send('log', { text: `[embed] q="${q.slice(0, 10)}…" dim=1536 norm=1.000` });
    await wait(600);
    if (closed) return;

    /* 2. 召回：先给候选集，让节点长出来，再逐条吐日志 */
    send('stage', { name: 'retrieve', progress: 0 });
    send('candidates', { chunks: CHUNKS });
    for (let i = 0; i < CHUNKS.length; i++) {
      const c = CHUNKS[i];
      send('log', { text: `[retrieve] ${c.id} cos=${c.score.toFixed(2)}` });
      send('stage', { name: 'retrieve', progress: (i + 1) / CHUNKS.length });
      await wait(45);
      if (closed) return;
    }

    /* 3. 重排 */
    send('stage', { name: 'rerank', progress: 0 });
    await wait(420);
    if (closed) return;
    const hits = CHUNKS.slice(0, 8);
    send('hits', {
      chunks: hits,
      recall: 0.96,
      latency: (Date.now() - started) / 1000,
    });
    send('log', { text: `[rerank] keep=${hits.length}/${CHUNKS.length} cross_enc=done` });
    await wait(520);
    if (closed) return;

    /* 4. 生成：token 流 */
    send('stage', { name: 'generate', progress: 0 });
    let n = 0;
    for (const piece of pieces(ANSWER, 4)) {
      send('token', { text: piece });
      n += piece.length;
      if (n % 24 < 4) send('log', { text: `[answer] tokens=${n} cite ch_0481` });
      await wait(38);
      if (closed) return;
    }

    send('done', { tokens: ANSWER.length, latency: (Date.now() - started) / 1000 });
    res.end();
  } catch (err) {
    if (!closed) {
      send('error', { message: String(err && err.message || err) });
      res.end();
    }
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/rag-hud-demo.html' : pathname;
  let file;
  try {
    file = path.join(ROOT, path.normalize(decodeURIComponent(rel)));
  } catch (e) {
    res.writeHead(400); return res.end('bad request');
  }
  if (!file.startsWith(ROOT)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  if (url.pathname === '/api/rag/stream') return handleStream(req, res, url);
  return serveStatic(res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock RAG SSE  ->  http://127.0.0.1:${PORT}/rag-hud-demo.html`);
  console.log(`stream        ->  http://127.0.0.1:${PORT}/api/rag/stream?q=...`);
});
