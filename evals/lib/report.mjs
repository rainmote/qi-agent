import { promises as fs } from 'node:fs';
import path from 'node:path';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const percent = (value) => value == null ? '未统计' : (value * 100).toFixed(1) + '%';
const configurationLabel = (row) => row.agent + (row.model ? ' / ' + row.model : '') +
  (row.config_hash ? ' / cfg:' + row.config_hash.slice(0, 8) : '') +
  (row.dataset_hash ? ' / data:' + row.dataset_hash.slice(0, 8) : '');
const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

export function summarize(records) {
  const ids = new Set();
  const attempts = new Set();
  const groups = new Map();
  for (const record of records) {
    if (record.schema_version !== 1 || typeof record.success !== 'boolean' ||
        !record.run_id || !record.task_id || !record.agent || !record.task_hash || !record.mode ||
        !Number.isInteger(record.trial) || record.trial < 1) throw new Error('Invalid result record');
    if (ids.has(record.run_id)) throw new Error('Duplicate run ID: ' + record.run_id);
    ids.add(record.run_id);
    // Do not mix models, configuration revisions, or dataset revisions in one row.
    const key = JSON.stringify([record.agent, record.model, record.mode, record.config_hash ?? null,
      record.dataset_hash ?? null]);
    const attemptKey = key + ':' + record.task_id + ':' + record.task_hash + ':' + record.trial;
    if (attempts.has(attemptKey)) throw new Error('Duplicate task trial: ' + record.task_id);
    attempts.add(attemptKey);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map((runs) => {
    const tasks = new Map();
    for (const run of runs) {
      const prior = tasks.get(run.task_id);
      if (prior?.hash !== undefined && prior.hash !== run.task_hash) throw new Error('Mixed task revisions');
      if (!prior) tasks.set(run.task_id, { hash: run.task_hash, runs: [] });
      tasks.get(run.task_id).runs.push(run);
    }
    const successes = runs.filter((run) => run.success).length;
    const triples = [...tasks.values()].filter((task) => [1, 2, 3].every((trial) => task.runs.some((run) => run.trial === trial)));
    const stable = triples.filter((task) => task.runs.filter((run) => run.trial <= 3).every((run) => run.success)).length;
    const costComplete = runs.every((run) => run.cost_complete === true && Number.isFinite(run.cost_usd) && run.cost_usd >= 0);
    const totalCost = costComplete ? runs.reduce((sum, run) => sum + run.cost_usd, 0) : null;
    const first = runs[0];
    return { agent: first.agent, model: first.model, mode: first.mode,
      config_hash: first.config_hash ?? null, dataset_hash: first.dataset_hash ?? null,
      tasks: tasks.size, attempts: runs.length, successes,
      success_rate: successes / runs.length,
      task_mean_success_rate: [...tasks.values()].reduce((sum, task) => sum + task.runs.filter((run) => run.success).length / task.runs.length, 0) / tasks.size,
      stable3_rate: triples.length ? stable / triples.length : null, stable3_eligible_tasks: triples.length,
      p50_agent_ms: quantile(runs.map((run) => run.agent_duration_ms).filter(Number.isFinite), 0.5),
      p90_agent_ms: quantile(runs.map((run) => run.agent_duration_ms).filter(Number.isFinite), 0.9),
      agent_timeout_rate: runs.filter((run) => run.agent_status === 'timeout').length / runs.length,
      cost_complete: costComplete, total_cost_usd: totalCost,
      cost_per_success_usd: costComplete && successes > 0 ? totalCost / successes : null,
      failures: runs.filter((run) => !run.success).reduce((counts, run) => {
        counts[run.failure_kind || 'unknown'] = (counts[run.failure_kind || 'unknown'] || 0) + 1;
        return counts;
      }, {}) };
  });
}

export async function writeReport(outputRoot, records, metadata = {}) {
  const summaries = summarize(records);
  const offline = records.every((record) => record.mode === 'offline_fixture');
  const caveat = offline ? '离线评测器自检：noop 保留错误，oracle 复制参考解。没有调用真实模型；通过率不代表任何 agent 能力。' :
    '按独立验收统计。费用缺失不按零计算；未完成三次独立试验的题目不计稳定成功率。';
  const report = { schema_version: 1, generated_at: new Date().toISOString(), kind: offline ? 'offline_validation' : 'agent_evaluation',
    caveat, metadata, summaries, records };
  await fs.writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const lines = ['# qì agent 评测报告', '', caveat, '',
    '| 配置 | 题数 | 尝试 | 验收通过 | 通过率 | 三次全通过率 | 成功成本 |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...summaries.map((row) => '| ' + configurationLabel(row).replaceAll('|', '\\|') + ' | ' + row.tasks + ' | ' + row.attempts + ' | ' + row.successes +
      ' | ' + percent(row.success_rate) + ' | ' + percent(row.stable3_rate) + ' | ' + (row.cost_per_success_usd ?? '未知') + ' |'),
    '', '逐题结果、日志和交付文件见 report.json 与 runs/。本报告不提供小样本显著性或产品优劣结论。', ''];
  await fs.writeFile(path.join(outputRoot, 'report.md'), lines.join('\n'), { mode: 0o600 });
  const rows = records.map((record) => '<tr data-agent="' + escapeHtml(configurationLabel(record)) + '" data-pass="' + record.success + '">' +
    [record.task_id, record.task_title, configurationLabel(record), record.trial, record.success ? '通过' : '失败',
      record.failure_kind || '—', record.verifier_duration_ms + ' ms'].map((cell) => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>').join('');
  const options = [...new Set(records.map(configurationLabel))].map((agent) => '<option>' + escapeHtml(agent) + '</option>').join('');
  const cards = summaries.map((row) => '<article><h2>' + escapeHtml(configurationLabel(row)) + '</h2><strong>' + row.successes + ' / ' + row.attempts +
    '</strong><p>验收通过 · ' + row.tasks + ' 题</p><p>三次全通过：' + percent(row.stable3_rate) + '</p></article>').join('');
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>qì agent 评测报告</title><style>body{font:15px/1.6 system-ui,sans-serif;color:#203039;background:#f5f6f7;margin:0;padding:clamp(16px,4vw,52px)}' +
    'main{max-width:1180px;margin:auto}h1{font-size:28px}header p{padding:16px;background:#fff2c7;border-radius:10px}' +
    '.cards{display:flex;gap:16px;flex-wrap:wrap}article{background:white;padding:16px 24px;border:1px solid #dae1e5;border-radius:12px;min-width:170px}' +
    'article h2{font-size:16px}strong{font-size:32px}article p{margin:4px 0}.filters{display:flex;gap:16px;flex-wrap:wrap;margin:24px 0}' +
    'select{font:inherit;padding:6px}section{overflow:auto;background:white;border:1px solid #dae1e5;border-radius:10px}table{border-collapse:collapse;width:100%;white-space:nowrap}' +
    'th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #e6ebee}th{background:#ecf0f2}footer{margin-top:20px;color:#56646d}</style>' +
    '<main><header><h1>qì agent · 评测报告</h1><p>' + escapeHtml(caveat) + '</p></header><div class="cards">' + cards + '</div>' +
    '<div class="filters"><label>配置 <select id="agent"><option value="">全部</option>' + options + '</select></label>' +
    '<label>结果 <select id="pass"><option value="">全部</option><option value="true">通过</option><option value="false">失败</option></select></label></div>' +
    '<section><table><thead><tr><th>任务</th><th>名称</th><th>配置</th><th>重复</th><th>验收</th><th>失败类型</th><th>验收耗时</th></tr></thead><tbody>' + rows +
    '</tbody></table></section><footer>费用：未统计。详细结果见 report.json；验收日志及交付文件见 runs/。所有内容均保存在本机。</footer></main>' +
    '<script>const a=document.getElementById("agent"),p=document.getElementById("pass");function filter(){document.querySelectorAll("tbody tr").forEach(r=>{r.hidden=!!((a.value&&r.dataset.agent!==a.value)||(p.value&&r.dataset.pass!==p.value))})}a.addEventListener("change",filter);p.addEventListener("change",filter)</script></html>';
  await fs.writeFile(path.join(outputRoot, 'report.html'), html, { mode: 0o600 });
  return report;
}
