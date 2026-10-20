"""Archive this local candidate; no services, Git mutations, or external writes."""
import datetime, hashlib, json, shutil
from pathlib import Path

task = Path(__file__).resolve().parent.parent
repo = task / 'qi-agent'
src = task / 'pixel-followup-20261020'
out = repo / 'docs/ui-harness-followup-20261020'
out.mkdir(exist_ok=True)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for name in ('reference', 'candidate', 'baseline', 'comparison'):
    shutil.copytree(src / 'final' / name, out / name, dirs_exist_ok=True)
for name in ('stability.json', 'scope.json'):
    shutil.copy2(src / name, out / name)
diagnostics = out / 'diagnostics'; diagnostics.mkdir(exist_ok=True)
probe_names = [p.stem.removesuffix('-render-trace') for p in (src / 'candidate/probes').glob('*-render-trace.json')]
for mode in ('reference', 'candidate'):
    dest = diagnostics / ('initial-' + mode); dest.mkdir(exist_ok=True)
    shutil.copytree(src / mode / 'probes', dest / 'probes', dirs_exist_ok=True)
    for name in probe_names:
        shutil.copy2(src / mode / (name + '.png'), dest / (name + '.png'))
for attempt in ('settings-pass', 'raster-pass'):
    dest = diagnostics / attempt; dest.mkdir(exist_ok=True)
    shutil.copy2(src / attempt / 'comparison/regions.json', dest / 'regions.json')
    for name in probe_names:
        shutil.copy2(src / attempt / 'candidate' / (name + '.png'), dest / (name + '.png'))
scripts = out / 'scripts'; scripts.mkdir(exist_ok=True)
for name in ('capture-raster-followup.mjs', 'compare-pixels.py', 'compare-followup-regions.py',
             'draft-files-focused.mjs', 'draft-files-focused-run.mjs', 'draft-files-complete.mjs',
             'draft-files-complete-run.mjs', 'run-check.py', 'isolation.sb', 'archive-followup-evidence.py'):
    shutil.copy2(task / 'tools' / name, scripts / name)
shutil.copy2(task / 'reference-harness/apps/web/tests/qi-raster-followup.e2e.ts', scripts)
checks = out / 'checks'; checks.mkdir(exist_ok=True)
passing = ['followup-static-frame-focus-build', 'followup-frozen-typecheck', 'followup-frozen-ui-tests',
           'followup-frozen-browser', 'followup-frozen-real-e2e', 'followup-frozen-candidate',
           'followup-final-reference-scoped', 'followup-focus-repeat-green', 'followup-preview-focus-final-eight',
           'followup-reference-probe', 'followup-candidate-probe', 'followup-settings-capture', 'followup-raster-capture']
failures = ['followup-final-reference', 'followup-final-reference-correct', 'followup-review-fix-browser',
            'followup-focus-repeat-red', 'followup-preview-focus-eight', 'followup-preview-focus-eight-explicit-frame',
            'followup-preview-frame-ready']
index = []
for name in passing + failures:
    meta = json.loads((task / 'evidence/logs' / (name + '.json')).read_text())
    assert meta['status'] == 'completed' and meta['exit_code'] is not None, (name, meta)
    assert (meta['exit_code'] == 0) == (name in passing), (name, meta)
    for ext in ('json', 'log'):
        shutil.copy2(task / 'evidence/logs' / (name + '.' + ext), checks / (name + '.' + ext))
    index.append({'name': name, **meta})
(checks / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n')
results = []
for line in (checks / 'followup-frozen-browser.log').read_text().splitlines():
    if line.startswith('{'):
        try: results.append(json.loads(line))
        except ValueError: pass
(checks / 'browser-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
assert any(row.get('draftFilesEntry') == 'passed' for row in results)
assert any(row.get('bootstrapHistoryRace') == 'passed' for row in results)
assert {row['target'] for row in results if row.get('bootstrapLateOpen') == 'passed'} == {'A', 'B'}
assert any(row.get('bootstrapInvalidRoute') == 'passed' for row in results)
real = out / 'real-backend'; real.mkdir(exist_ok=True)
for folder in ('e2e', 'regressions'):
    for p in (task / 'evidence/after' / folder).glob('*.png'):
        shutil.copy2(p, real / p.name)
files = [p for folder in ('apps/web/src', 'apps/web/tests', 'apps/web/public')
         for p in (repo / folder).rglob('*') if p.is_file()]
files += [repo / p for p in ('package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json',
                           'AGENTS.md', 'LESSONS.md', 'docs/code-standards.md', 'THIRD_PARTY_NOTICES.md')]
old = json.loads((repo / 'docs/ui-harness-20261020/tested-source.json').read_text())
contracts = {rel: sha(repo / rel) for rel in old['runtime_and_contracts']}
assert contracts == old['runtime_and_contracts'], 'Backend, policy, controller or runtime changed'
freeze = {'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'branch': 'codex/web-deepseek-harness-20261019', 'base_sha': 'c72cbf2667e90245c9c16149f0bbb8681b8cc12f',
          'reference_sha': '687f282e8625c6b8d11ff58211a90524be2e4317',
          'ui_source_files': {str(p.relative_to(repo)): sha(p) for p in sorted(files)},
          'built_artifacts': {str(p.relative_to(repo)): sha(p) for p in sorted((repo / 'apps/web/dist').rglob('*')) if p.is_file() and not p.name.endswith('.map')},
          'runtime_and_contracts': contracts, 'image_fingerprint': 'Not applicable: native macOS; no container image',
          'strict_pixel_acceptance': 'blocked'}
(out / 'tested-source.json').write_text(json.dumps(freeze, indent=2) + '\n')
for p in (repo / 'apps/web/public/licenses').iterdir():
    assert sha(p) == sha(repo / 'apps/web/dist/licenses' / p.name)
assert (repo / 'apps/web/public/licenses/deepseek-harness-MIT.txt').read_bytes() == (task / 'reference-harness/LICENSE').read_bytes()
(out / 'reference.json').write_text(json.dumps({'url': 'https://github.com/deepseek-ai/deepseek-harness',
    'sha': freeze['reference_sha'], 'version': '0.2.1-rc.2', 'public_head_rechecked': True,
    'method': 'credential-free git ls-remote; GIT_CONFIG_GLOBAL=/dev/null; credential.helper empty',
    'checked_date_utc': '2026-10-20', 'checked_time_precision': 'day; exact command output preserved in task transcript',
    'tracked_reference_product_files_changed': False}, indent=2) + '\n')
metrics = json.loads((out / 'comparison/metrics.json').read_text())['pairs']
regions = json.loads((out / 'comparison/regions.json').read_text())['regions']
candidates = [r for r in metrics if r['mode'] == 'candidate']
assert len(candidates) == 28 and all(not r['raw_unmasked']['exact_equal'] for r in candidates)
assert len(regions) == 56
table = ['| 状态 | c72 基线非零像素 % | 当前非零像素 % |', '| --- | ---: | ---: |']
for r in candidates:
    b = next((x for x in metrics if x['mode'] == 'baseline' and x['name'] == r['name']), None)
    table.append(f"| [{r['name']}](comparison/{r['name']}-side-by-side.png) | " + (str(b['raw_unmasked']['pixels_nonzero_percent']) if b else '未拍') + f" | {r['raw_unmasked']['pixels_nonzero_percent']} |")
residuals = ['| 页面 / 区域 | 非零像素 | 最大通道差 |', '| --- | ---: | ---: |']
for r in regions:
    if not r['exact_equal']:
        residuals.append(f"| [{r['state']} / {r['region']}](comparison/regions/{r['state']}-{r['region']}.png) | {r['nonzero']} | {r['max_channel_delta']} |")
report = '''# 2026-10-20 像素对齐后续候选

工程候选完成，严格全屏像素验收仍为 **blocked**。28组原图配对均非零，不能以构建通过、局部相等或一个整体百分比宣布“完全对齐”。[原尺寸交互对照](index.html) · [源码/构建指纹](tested-source.json) · [测试索引](checks/index.json) · [独立复核](readonly-review.md)。此前 c72cbf2 的原证据完整保留；本目录不会覆盖旧轮结果。

## 范围与实际修改

- 继续 geb Mac mini 原分支 `codex/web-deepseek-harness-20261019`，基线 `c72cbf2667e90245c9c16149f0bbb8681b8cc12f`，唯一写入者。官方参考 `687f282e8625c6b8d11ff58211a90524be2e4317`（0.2.1-rc.2），交付前再次无凭据核对 HEAD 未变。[官方固定版本](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。
- 新会话右上角补齐真实文件入口；无需创建会话，复用原授权文件 API。七个新会话视口/主题的入口矩形均与参考严格相等。
- 设置使用54px固定顶栏与独立滚动列；主题区改为源结构。工作步骤展示保留四种真实选择，改为同尺寸菜单；经实际UI把两边对照状态统一为“详细”，未改变 qi 默认“标准”。基线设置图仍是“标准”，不能把选中值差异全部算成样式收益。
- 新增真实“回答结束后/下次有新消息时”折叠偏好；保存浏览器本地，手动选择优先，后续用户消息会折叠历史步骤，失败/取消/未知结果和审批决定继续保留。未实现官方Host跨客户端配置同步。
- 工作区管理移至独立设置分区，原添加/移除回调保留；低高度桌面导航支持滚动。品牌采用两行排版，显示实际 package Web版本；裁去 qi SVG 内部空白，保留 qi 身份。
- 文件面板补初始焦点、关闭回焦、移动全屏的背景inert/原生Tab首尾边界、异步控件丢焦恢复；保留pre/iframe预览键盘访问。引用关闭明确回到草稿。iframe仅补键盘属性，原sandbox/CSP/referrer限制不变。
- 后端协议、command_id、Host/daemon/worker、权限、控制器及审批实现均未修改；11项运行/合同指纹与c72证据相同。MIT/OFL归属和随构建分发的许可证一致。

## 浏览器、测试与失败记录

同一Chrome155.0.8059.85、DPR1、zh-CN、UTC、固定时钟2026-10-20T09:00Z；1440×1000及1024/768/390/320×844，浅/深主题、同字体，等待字体与两帧渲染。官方运行实际源码和官方隔离scaffold，使用公开录制会话；qi视觉图使用相同语义数据的离线API夹具。没有给参考注入样式，没有修图、遮罩或从全屏指标排除区域。官方28张、候选38张、c72基线34张原图及逐图DOM保存于本目录。真实后端另有离线Host→Rust daemon→Babashka worker E2E，不用视觉夹具冒充后端验证。

- 最终类型检查、76项前端、完整Chrome浏览器和8项真实后端E2E通过，零取消/跳过，外部模型调用0。覆盖重复提交/原编号对账、取消、人工审批、信任、返回、历史竞态、移动端、预览与引用焦点。构建保留大于500kB提示。
- c72已修复的新会话重载立即后退再次通过；旧红/绿记录仍在上一轮目录，本轮完整回归再次含四个启动竞态与1440/390历史返回。
- 独立只读复核发现新增入口焦点与短窗导航风险，随后又指出pre/iframe及引用回焦回归，均按具体路径修复。未以早期通过覆盖后续失败。
- 第一次移动Tab检查失败；一次诊断重跑通过仍未视为解决。专项重放在320px第2次Tab实拍复现焦点落到body，保留 `followup-focus-repeat-red` 及截图；修复后原专项8轮通过。扩展真实预览路径又暴露静态iframe停靠问题，保留三个失败版本；最终完整预览/引用专项8轮通过，随后完整回归通过。
- 官方新增菜单补拍分别因工作目录错误、两个同名“详细”选择器失败；日志保留，正确目录且按工作步骤行定位后28张采集通过。错误工作目录仅创建3个空目录，已精确rmdir清理。
- 原 `tools/isolation.sb` 未放宽：测试禁止读取Codex/SSH/AWS/钥匙串、真实Chrome配置、NAS，出站限localhost，使用任务临时状态；官方公共HEAD核对单独无凭据只读。未push、建PR、部署、重启现有服务、更改凭据或网络/系统权限。
- 广义Host套件旧有82通过/3项ps EPERM失败未重跑，不能签发该套件全绿；此环境限制记录保留。

## 差异分类和仍需完成的工作

| 分类 | 具体区域与原因 | 结论 |
| --- | --- | --- |
| 可修视觉 | 本轮已补入口、品牌占位、菜单/固定顶栏、设置布局；原13处残差仍在，新增两选择器各40像素差 | 仍未逐像素通过，不能归因后端 |
| 真实前端能力 | 设置仍缺源代码工作视图开关、快捷键编辑、忙时默认行为、角色字体/英语等；不是天然后端障碍 | 尚未补齐；新偏好真实实现而非占位 |
| 背景相关视觉 | 新设置菜单几何和字级匹配，但源下方更多设置行会透过真实模糊材质；qi缺失这些行，两个菜单仍非零，未证明全部残差都来自背景 | 不能用遮罩、伪控件或不透明背景掩盖 |
| 产品身份 | qi标志/名称及真实Web版本与DeepSeek标志/DSH版本不同 | 改身份是产品决定；保持诚实标识 |
| 真实产品/协议能力 | 官方标准/PTC/极简/创造4预设，qi标准/创造/生产只读3预设；源权限设置为新会话默认，qi为当前会话 | 不得改名冒充、不复制误导权限文案；完整等价需实现能力/配置适配 |
| 账户/配置/遥测 | 源配置文件打开、账户/持久反馈/分享及同口径token/cache/TPS并无现成Web等价链路 | 未伪造按钮或统计；需要真实功能适配 |

最小产品范围选择：若“完全一致”包含品牌、预设及Host设置语义，就需要明确授权按官方身份/能力体系替换或完整补齐；保持 qi 身份和现有能力集合时，这些具体差异不能诚实地变成零。此选择不能替代尚待处理的前端或稳定栅格差异。

手机实机软键盘/安全区、Safari/Firefox/Electron、PDF浏览器插件内的完整键盘路径、官方真实模型流式/账户/配置文件打开与所有设置分区没有本轮完整实拍，均未验证。早轮官方子任务公开录制与qi子任务披露证据仍在上一轮目录，本轮未重跑真实模型派发。

## 有界栅格排查

最初7种状态×两侧×3次重复拍摄，42组同页面重复图严格相等，见 stability.json。两次实际候选CSS/容器实验分别调整固定滚动列/主题DOM，以及content-box、继承字级、reduced-motion与菜单绘制；原45区域均仍为32相等/13残差，因此停止无收益调参。原SVG与主要计算样式相同不代表栅格一致，根因尚未完全定位；这些不是已证明可忽略的随机噪声。新参考补拍在主题图标处另有1–2像素跨运行变化，不能用同页面重复结果外推跨运行必定相同。

保留原45个区域与本轮新增11个区域，共56；39严格相等、17非零，所有已记录几何差为0。新增7个右上入口相等，两个选择器各40像素/最大通道差1；两新菜单因真实背景/待补设置行非零。裁切诊断不从全屏中剔除。原45区域仍是32相等，不能把新增相等区域造成的39/56当作消除了旧残差。

''' + '\n'.join(residuals) + '\n\n## 全部原始全屏结果\n\n新会话品牌图标变大使部分整屏非零比例增加；设置有所下降。整体比例并非单调收益或验收阈值。\n\n' + '\n'.join(table) + '''

## 重算与复核

在本目录用带Pillow的Python运行 `scripts/compare-pixels.py .` 和 `scripts/compare-followup-regions.py .`。指数和热图均用原始RGB；热图显示×4，Δ>16仅为诊断。脚本保留本任务路径，不是可在任意宿主直接运行的安装器。

提交后的完整浏览器/真实后端回执保存在任务根 `pixel-followup-20261020/postcommit/receipt.json`，避免为记录回执再次改变已测试提交。Git提交SHA以该回执及最终交付为准。
'''
(out / 'README.md').write_text(report)
names = [r['name'] for r in candidates]
data = {r['name']: r['raw_unmasked'] for r in candidates}
baselines = [r['name'] for r in metrics if r['mode'] == 'baseline']
html = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>qi-agent 后续像素对照</title><style>body{margin:24px;font:15px/1.6 system-ui;background:#f5f6f8;color:#17212b}main{max-width:1800px;margin:auto}h1{font-size:24px}button,select{font:inherit;margin:4px;padding:8px 12px;border:1px solid #ccd2da;border-radius:8px;background:white}img{display:block;max-width:100%;height:auto}a{color:#245fcc}.status{color:#a43922}</style><main><h1>qi-agent 后续像素对照</h1><p class="status">严格全屏像素验收 blocked · 保留非零差异与真实能力差异</p><p>官方687f282 / 基线c72cbf2 / 本地候选。Chrome155，DPR1，同视口、主题和语义数据；不排除任何像素。</p><p><a href="README.md">具体差异与验证报告</a> · <a href="readonly-review.md">独立复核</a> · <a href="comparison/regions.json">56区域指标</a> · <a href="tested-source.json">源码/构建指纹</a></p><label>状态<select id="state"></select></label><nav id="modes"></nav><p id="meta"></p><a id="original" target="_blank"><img id="visual" alt="真实原尺寸截图对照"></a><p>补充实际功能：<a href="candidate/extra-draft-files-light-1440.png">无会话文件面板</a> · <a href="candidate/extra-settings-workspaces-light-1440.png">工作区设置</a> · <a href="candidate/extra-subtask-result-light-1440.png">子任务披露</a> · <a href="candidate/extra-bootstrap-error-light-1440.png">真实错误呈现夹具</a>。没有为未拍官方状态伪造配对。</p></main><script>
const names=NAMES,data=DATA,baselines=BASELINES,state=document.querySelector('#state'),visual=document.querySelector('#visual');let mode='side-by-side';const modes=[['side-by-side','并排'],['overlay','50%叠加'],['diff-x4','差异×4'],['reference','官方原图'],['candidate','候选原图'],['baseline','c72原图']];for(const name of names){const o=document.createElement('option');o.value=o.textContent=name;state.append(o)}for(const [id,label] of modes){const b=document.createElement('button');b.dataset.mode=id;b.textContent=label;b.onclick=()=>{mode=id;show()};document.querySelector('#modes').append(b)}function show(){const n=state.value,p=['reference','candidate','baseline'].includes(mode)?mode+'/'+n+'.png':'comparison/'+n+'-'+mode+'.png';visual.src=p;document.querySelector('#original').href=p;const m=data[n];document.querySelector('#meta').textContent=m.width+'×'+m.height+' · 全屏非零 '+m.pixels_nonzero+' ('+m.pixels_nonzero_percent+'%) · 严格相等 '+m.exact_equal+' · MAE '+m.mae_0_255;for(const b of document.querySelectorAll('[data-mode]')){b.disabled=b.dataset.mode==='baseline'&&!baselines.includes(n);b.setAttribute('aria-pressed',String(b.dataset.mode===mode))}}state.onchange=()=>{if(mode==='baseline'&&!baselines.includes(state.value))mode='side-by-side';show()};state.value='new-session-light-1440';show();
</script></html>'''
(out / 'index.html').write_text(html.replace('NAMES', json.dumps(names)).replace('DATA', json.dumps(data)).replace('BASELINES', json.dumps(baselines)))
print(json.dumps({'output': str(out), 'paired': len(candidates), 'regions': len(regions),
    'exact_regions': sum(r['exact_equal'] for r in regions), 'source_files': len(freeze['ui_source_files']),
    'strict_pixel_acceptance': 'blocked'}, ensure_ascii=False))
