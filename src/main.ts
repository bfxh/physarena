import './styles.css';
import { App } from './ui/app';

const host = document.getElementById('app');
if (!host) throw new Error('#app container missing');

/**
 * A blank page is the worst possible failure mode: nothing to read, no way
 * to tell a slow boot from a crash. Every unexpected error and every
 * unhandled rejection now lands in a dismissible banner.
 */
function reportFatal(title: string, detail: string): void {
  let bar = document.getElementById('pa-fatal');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pa-fatal';
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:10px 14px;' +
      'background:#fdecec;border-top:1px solid #f0c4c0;color:#8c2f28;' +
      'font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;' +
      'max-height:40vh;overflow:auto;cursor:pointer';
    bar.title = '点击关闭';
    bar.addEventListener('click', () => bar?.remove());
    document.body.append(bar);
  }
  bar.textContent = `${title}\n${detail}`;
}

window.addEventListener('error', (ev) => {
  reportFatal('运行时错误', ev.message + (ev.filename ? `\n  ${ev.filename}:${ev.lineno}` : ''));
});

window.addEventListener('unhandledrejection', (ev) => {
  const r: unknown = (ev as PromiseRejectionEvent).reason;
  reportFatal('未处理的异步错误', r instanceof Error ? (r.stack ?? r.message) : String(r));
});

// Watchdog: if the shell still is not up, say so rather than showing blank.
const watchdog = setTimeout(() => {
  if (!document.querySelector('.pa-shell')) {
    reportFatal('启动超时', '界面在 20 秒内没有渲染出来。如果控制台没有更多信息，刷新一次通常能恢复。');
  }
}, 20000);

const app = new App(host);
app.start().then(() => clearTimeout(watchdog)).catch((e) => {
  host.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'pa-empty';
  box.style.paddingTop = '15vh';
  box.innerHTML = `<div style="font-size:15px;font-weight:600;color:#cf3b3b">BSHSQ 启动失败</div>
    <div style="margin-top:8px;font-family:ui-monospace,monospace;font-size:12px">${
      String(e?.message ?? e).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
    }</div>
    <div style="margin-top:14px;font-size:12px;color:#64708a">请确认已执行 <code>npm install</code> 与 <code>npm run vendor</code>。</div>`;
  host.append(box);
});
