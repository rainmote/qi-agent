import datetime, hashlib, json, shutil, subprocess
from pathlib import Path
task=Path(__file__).resolve().parent.parent
repo=task/'qi-agent'
src=task/'pixel-20261020'
out=repo/'docs/ui-harness-20261020'
out.mkdir(exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for name in ('reference','candidate','baseline','reference-extra','comparison','refinements-before'):
    shutil.copytree(src/name,out/name,dirs_exist_ok=True)
for name in ('reference.json','geometry-baseline.json','geometry-candidate.json','geometry-red-green.json','static-residual-audit.json'):
    shutil.copy2(src/name,out/name)
scripts=out/'scripts';scripts.mkdir(exist_ok=True)
for name in ('capture-pixels.mjs','compare-pixels.py','compare-pixel-regions.py','check-pixel-geometry.py','verify-pixel-gallery.mjs','finish-pixel-evidence.py','run-check.py','isolation.sb'):
    shutil.copy2(task/'tools'/name,scripts/name)
for name in ('qi-pixel-reference.e2e.ts','qi-pixel-subagent.e2e.ts'):
    shutil.copy2(task/'reference-harness/apps/web/tests'/name,scripts/name)
shutil.copy2(Path(__file__),scripts/'archive-pixel-evidence.py')
checks=out/'checks';checks.mkdir(exist_ok=True)
names=['pixel-typecheck','pixel-build','pixel-ui-tests','pixel-browser-regressions','pixel-real-e2e',
       'pixel-reference-capture','pixel-reference-extra','pixel-candidate-capture','pixel-baseline-capture','pixel-baseline-build']
index=[]
for name in names:
    meta=json.loads((task/f'evidence/logs/{name}.json').read_text())
    assert meta['exit_code']==0,(name,meta)
    for ext in ('json','log'):
        shutil.copy2(task/f'evidence/logs/{name}.{ext}',checks/f'{name}.{ext}')
    index.append({'name':name,**meta})
for name,count in [('reference',26),('candidate',34),('baseline',14)]:
    manifest=json.loads((out/name/'manifest.json').read_text())
    assert len(manifest['evidence'])==count,(name,manifest)
(checks/'index.json').write_text(json.dumps(index,indent=2)+'\n')
records=[]
for line in (checks/'pixel-browser-regressions.log').read_text().splitlines():
    if line.startswith('{'):
        try:records.append(json.loads(line))
        except ValueError:pass
(checks/'browser-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
intermediate=checks/'intermediate';intermediate.mkdir(exist_ok=True)
for name in ('pixel-browser-regressions-focus-frame-failure','pixel-model-tab-search-failure','pixel-reference-thinking-locator-failure','pixel-history-reload-failure','pixel-history-bootstrap-red','pixel-real-e2e-label-failure','pixel-transport-interrupted-browser','pixel-transport-interrupted-real-e2e','pixel-transport-interrupted-candidate'):
    for ext in ('json','log'):
        shutil.copy2(task/f'evidence/logs/{name}.{ext}',intermediate/f'{name}.{ext}')
real=out/'real-backend';real.mkdir(exist_ok=True)
for p in (task/'evidence/after/e2e').glob('composer-*.png'):shutil.copy2(p,real/p.name)
for p in (task/'evidence/after/regressions').glob('*.png'):shutil.copy2(p,real/p.name)
files=sorted(p for folder in ('apps/web/src','apps/web/tests','apps/web/public') for p in (repo/folder).rglob('*') if p.is_file())
files += [repo/p for p in ('package.json','package-lock.json','vite.config.ts','tsconfig.json','AGENTS.md','LESSONS.md','docs/code-standards.md','THIRD_PARTY_NOTICES.md') if (repo/p).is_file()]
fingerprints={str(p.relative_to(repo)):sha(p) for p in files}
artifacts={str(p.relative_to(repo)):sha(p) for p in (repo/'apps/web/dist').rglob('*') if p.is_file() and not p.name.endswith('.map')}
contracts={}
for rel in ('apps/web/src/api.ts','apps/web/src/types.ts','apps/tui-rs/src/web_host.rs','apps/tui-rs/src/web/mod.rs','apps/tui-rs/src/daemon.rs','apps/tui-rs/target/debug/qi-agent','agent.edn','maintenance/policy.json','maintenance/lib/controller.mjs','maintenance/checks.json','src/qi/repl_worker.clj','src/qi/plugins/approval.clj','src/qi/plugins/policy.clj'):
    p=repo/rel
    if p.is_file():contracts[rel]=sha(p)
freeze={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'branch':'codex/web-deepseek-harness-20261019',
        'base_sha':'315860136df47f896ad61268ff29b408c2103351','reference_sha':'687f282e8625c6b8d11ff58211a90524be2e4317',
        'ui_source_files':fingerprints,'built_artifacts':artifacts,'runtime_and_contracts':contracts,
        'image_fingerprint':'not applicable: native macOS tests, no container image used',
        'note':'Tests and screenshots are bound to these saved files and built asset hashes; documentation/notes add no product behavior.'}
(out/'tested-source.json').write_text(json.dumps(freeze,indent=2)+'\n')
license_checks={}
for p in (repo/'apps/web/public/licenses').iterdir():
    assert sha(p)==sha(repo/'apps/web/dist/licenses'/p.name),p
    license_checks[p.name]=sha(p)
assert (repo/'apps/web/public/licenses/deepseek-harness-MIT.txt').read_bytes()==(task/'reference-harness/LICENSE').read_bytes()
assert (repo/'apps/web/src/vendor/harness-rank-by-name.ts').read_bytes()==(task/'reference-harness/packages/client/ui-primitives/src/rank-by-name.ts').read_bytes()
icons=(repo/'apps/web/src/vendor/harness-icons/index.tsx').read_text().split('\n',1)[1]
icons=icons.replace("'./props'","'./props.ts'").replace("'./shared-artwork'","'./shared-artwork.tsx'")
assert icons==(task/'reference-harness/packages/client/ui-primitives/src/icons/index.tsx').read_text()
for name in ('montserrat-light.woff2','montserrat-regular.woff2','montserrat-medium.woff2'):
    assert (repo/'apps/web/src/assets/harness'/name).read_bytes()==(task/'reference-harness/packages/client/ui-theme/src/styles'/name).read_bytes()
assert (repo/'THIRD_PARTY_NOTICES.md').read_bytes()==(repo/'apps/web/public/licenses/THIRD_PARTY_NOTICES.md').read_bytes()
(checks/'license-files.json').write_text(json.dumps(license_checks,indent=2)+'\n')
metrics=json.loads((out/'comparison/metrics.json').read_text())
pairs=metrics['pairs']
row=lambda name,mode:next(r for r in pairs if r['name']==name and r['mode']==mode)
key_names=['new-session-light-1440','new-session-dark-1440','new-session-light-1024','new-session-light-768','new-session-light-390','new-session-light-320','conversation-light-1440','settings-light-1440','settings-light-390']
table=['| 状态 | 旧候选全屏非零像素 % | 当前全屏非零像素 % | 当前卡片非零像素数 |','| --- | ---: | ---: | ---: |']
for name in key_names:
    c=row(name,'candidate')
    b=next((r for r in pairs if r['name']==name and r['mode']=='baseline'),None)
    table.append('| '+name+' | '+(f"{b['raw_unmasked']['pixels_nonzero_percent']:.5f}" if b else '未拍')+' | '+f"{c['raw_unmasked']['pixels_nonzero_percent']:.5f}"+' | '+str(c['composer_region']['pixels_nonzero'])+' |')
all_table=['| 状态 | 全屏非零像素 % | 全屏 Δ>16 %（诊断） | MAE (0–255) |','| --- | ---: | ---: | ---: |']
for r in pairs:
    if r['mode']=='candidate':
        all_table.append(f"| [{r['name']}](comparison/{r['name']}-side-by-side.png) | {r['raw_unmasked']['pixels_nonzero_percent']:.5f} | {r['raw_unmasked']['pixels_gt16_percent']:.5f} | {r['raw_unmasked']['mae_0_255']:.5f} |")
regions=json.loads((out/'comparison/regions.json').read_text())['regions']
region_table=['| 状态 / 区域 | 非零像素 | 最大通道差（0–255） | DOM 几何差 x/y/w/h |','| --- | ---: | ---: | --- |']
for r in regions:
    geometry=r.get('geometry_delta_css_px')
    region_table.append(f"| [{r['state']} / {r['region']}](comparison/regions/{r['state']}-{r['region']}.png) | {r['nonzero']} | {r['max_channel_delta']} | "+('/'.join(str(geometry[k]) for k in ('x','y','width','height')) if geometry else '固定诊断矩形')+' |')
report='''# 2026-10-20 Web UI 像素对照候选

本轮已形成可复核的本地实现，工程门禁通过。严格的“所有页面逐像素一致”验收结果为 **blocked**：原始图像仍有非零差异，真实功能集合、品牌和验收语义也不同。下列比例不是像素通过阈值；没有把这些区域遮罩或从全屏指标剔除。

[打开交互式截图索引](index.html) · [独立复核](readonly-review.md) · [全屏指标](comparison/metrics.json) · [区域指标](comparison/regions.json) · [源码/构建指纹](tested-source.json) · [测试索引](checks/index.json)

## 基线和隔离

- 工作区：geb Mac mini，/Users/geb/Documents/Codex/2026-10-19/task-2/qi-agent；分支 codex/web-deepseek-harness-20261019。
- 本轮基线：315860136df47f896ad61268ff29b408c2103351。旧证据 docs/ui-harness-20261019 原样保留。
- 官方参考：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)，SHA 687f282e8625c6b8d11ff58211a90524be2e4317，0.2.1-rc.2。交付前再次用无凭据 ls-remote 核对仍为该 HEAD，见 reference.json。
- 先核对 AGENTS、LESSONS、Web/架构/工作区文档及贡献要求，并应用 Product Design 的截图对照/QA、官方客户端 UI 与响应式技能。只由主代理写入，复核者只读；没有修改其他工作区、NAS、main 或旧候选 8ef3ca4。
- 依赖与脚本先检查后运行；本轮无新依赖、无外部模型调用。原隔离策略保持不变：禁止测试读取 Codex/SSH/AWS/钥匙串、真实 Chrome 配置、NAS；仅允许 localhost 出站，使用临时 qi 状态和独立浏览器配置。
- 所有预览、官方 scaffold、真实后端 E2E 服务均为本任务新建并由测试清理。没有 push、PR、部署、重启既有服务、修改凭据或网络/系统权限。

## 同条件真实浏览器证据

官方使用实际构建和官方隔离 scaffold、公开录制会话；候选/3158601 使用相同语义内容的确定性 qi API fixture。静态 fixture 用于视觉对照；真实后端另由 Web Host → Rust daemon → Babashka Worker 的离线 E2E 验证，不能相互替代。

同一 Chrome 155.0.8059.85、DPR 1、zh-CN、UTC、固定时钟 2026-10-20T09:00:00Z、相同视口和浅/深主题、同系统字体与官方 Montserrat，等待字体/两帧渲染/350ms 稳定。静态页面中性焦点归一化，两边菜单保留焦点，另以功能测试验证键盘焦点。没有注入样式修改参考界面。官方 26、候选 34、冻结旧候选 14 个状态；源与候选都有逐图 DOM 几何和 manifest。菜单截图断言菜单仍打开，思考有两层真实展开状态。新增两组模式菜单保留各自真实预设集合：官方4种，qi使用仓库3种和实际说明，因此这两组内容不完全同态，不伪装成相同功能。

26 组原尺寸并排、50% 叠加及差异热图均在 comparison/。全屏指标计算原始 RGB 的严格相等、非零像素数和 MAE；Δ>16 比例仅用于诊断，绝不是通过阈值。不排除任何像素，全部 26 组 exact_equal=false。差异图仅显示放大 4 倍。另有 45 个明确矩形的控件诊断，均不从全屏指标中剔除。两侧原图尺寸完全相同；并排图额外有 32px 标签栏。

'''+ '\n'.join(table)+'''

## 实现变化

- 对齐主题灰阶、字体、抗锯齿、行高、间距、圆角、边框、阴影和非品牌 SVG。桌面 280px 侧栏、窄屏 56px rail 与展开导航可用；恢复真实 preset 标记、子任务入口及工作区新增图标。
- 首页输入卡片在 1440/1024/768/390/320px 的 x/y/宽/高实测全部为零差；浅色卡片区域原始像素全部一致。旧候选同一 0.1 CSS px 几何门禁失败，geometry-baseline.json / geometry-candidate.json 保留 red/green。深色桌面卡片仍有最大通道差 1 的非零像素，不记像素通过。
- 会话输入区实测为 98px；首页 114px，空文本输入高度 36/52px，长草稿上限 336px。可见发送按钮 34px、添加按钮 28px；用透明命中区保留至少 44px 的操作目标，并做真实点击命中检查。
- 对齐用户气泡、过程行、思考行、bash 摘要和最终正文。桌面同内容下 process y228/h33、思考按钮 y277/h20、Reading 段 y309、bash 摘要 y345/h20、DONE 段 y377 对照一致。思考按官方呈现“已完成分析 → 思考/首行预览 → 正文”两层折叠，bash 保留两层参数/结果披露。
- 模型选择改为同一张卡片中的层级切换；模型/推理等级、provider 分组、官方模糊匹配排序、搜索、选中样式和键盘导航接入现有真实回调。Escape/Shift+Tab 先返回，搜索方向键保持输入焦点，Tab 接受当前项；多模型与单模型均回归。
- 菜单采用参考的外层、背景材质层及滚动层，portal 到 body；点击边界同时识别触发区和菜单。移除会让文字亚像素漂移的进入 transform。设置内 Tab/Shift+Tab 关闭菜单后正常移动并留在模态内，未顺便选择权限。
- 设置公共行、Medium 主题图标及字号步进器与源布局对应；保留直接输入与 10–22 范围、失焦恢复、持久化。权限仍按当前会话真实策略；Full Access 仍必须明确风险确认。修复内层 Escape、叠置模态、取消后焦点返回、权限拒绝后的回滚/再次确认，以及打开设置后导航遮罩残留。
- 修复新会话重载后立即后退的启动竞态：初次路由订阅前错过的 popstate 只补偿一次，并用允许目录中的语义路由校验初次 open 的迟到响应。合法 A/B 切换、同 A 的 hash 参数换序、非法目标都不追加历史或重放提交；正常导航范围和目录校验保留。
- 顶栏会话菜单接入现有重命名/分支/归档动作；取消重命名与 Escape 返回焦点，不触发发送或导航。
- 工作区/模式一行按参考的普通文本和独立按钮压缩，修复 native select 字形、宽度和窄屏分配。模式菜单使用原有真实预设和说明，选择只更新草稿模式，创建时仍传原 presetId。1440/320px 下取消、方向键/Enter、Tab、重复点击、零提交及焦点返回均回归；真实 E2E 通过该菜单选择离线 preset 后验证信任/审批/写入链路。
- 快捷任务、工作台、插件、自动化、附件、工具原始内容、子任务真实返回及“完成≠验收”均可访问。api.ts、Host/daemon/Worker 协议、command_id、未知结果先核对、审批和停止去重链路未改。显示偏好不授权操作。
- MIT/OFL 及来源声明随源码和 dist/licenses/ 分发；保留 qi 标识，未复用 DeepSeek 商标冒充官方产品。

## 验证结果与边界

| 检查 | 结果 |
| --- | --- |
| npm run typecheck / npm run web:build | 通过；保留 Vite >500kB 包体提示，JS 593.66kB / gzip180.27kB；三份字体共约185.7kB |
| npm run test:web-ui | 75 通过，0 失败/取消/跳过 |
| npm run test:web-browser:ci | 通过；pageErrors=[]；含重复提交、丢响应/恢复、停止、会话竞态、后退/前进、离开/返回、单/多模型、IME、取消、模态、两层思考、子任务及 320–1440px |
| 真实本地后端 interaction-e2e | 8 通过，0 失败/取消/跳过；真实文件写入在信任和批准后发生，外部模型调用0 |
| 官方/候选/旧候选截图 | 26 / 34 / 14；捕获脚本退出0，无页面异常 |
| 首页五视口几何 | baseline red；candidate green；实测全部0差，检查容差0.1 CSS px |
| 独立只读复核 | 见 readonly-review.md；不冒充复核者重新执行测试 |
| 广义 Host / 维护控制器全测 | 本轮未重跑。上一轮基线和候选均82通过/3失败，原因是隔离拒绝 /bin/ps；此项仍未验证，不记全绿 |

checks/intermediate/ 保留真实历史重载失败及修复前确定性 bootstrap red。此前“门禁全绿可归档”的复核结论在发现该失败时撤回；不能用早先终审覆盖新失败。修复后 4 组确定性启动竞态、桌面/移动重载立即后退、离开返回、目录挂起及旧目录响应均通过。最终本地提交后重跑完整浏览器和真实 E2E，结果写入[本任务提交后收据](/Users/geb/Documents/Codex/2026-10-19/task-2/pixel-20261020/postcommit/receipt.json)，不回写 Git，从而保持被测提交及已归档证据不变；收据绑定实际提交、84项源码、9项构建及 runtime/profile/控制器指纹。最终结果以收据实际退出码为准，不预记通过。

同目录还保留新增焦点帧断言、模型搜索 Tab 误命中、参考思考定位及真实 E2E 按钮省略号定位失败。最终脚本修正后通过；采集/定位失败不是产品通过证据。几何 red 来自冻结的真实旧候选。未把旧 failure.png 当成本轮通过截图。

12:21 的一批执行会话在完成前消失；类型和UI75有完整收据，浏览器/真实E2E/采集仅有部分或空日志，明确记为 incomplete、exit_code=null。其旧 JSON 收据早于新日志，不属于该次执行，未记通过。确认任务端口释放后，按原隔离重跑这三项。run-check.py 现在启动前先写 running/null，完成后才写真实退出码；最终索引只接受完整 exit0。

## 补充实际界面及未验证项

reference-extra/ 来自官方公开 live-interactions 录制重放：实际子任务、弹层、窄屏、无工作区、等待连接和断开传输状态。候选 extra-* 为 qi 真实数据结构的隔离 fixture。它们的任务状态/描述符/时间不完全同态，仅作人工功能与视觉核对，不计算伪精确的跨图像素比例。

保留 replay-exhausted-* 是官方录制耗尽的实际错误界面；不是生产网络失败的验证。正常重放 liveProviderCalls=0。断开 WebSocket 后的官方短时画面保留最后内容，不能声称已验证真实离线/鉴权失败错误页。

未验证：官方真实在线模型流式生成/审批执行/子任务调度全链路，官方 Full Access 风险框的全部状态、账户登录、完整设置模型/插件/Agent预设编辑、全部会话上下文菜单、附件各格式和工具种类；物理手机软键盘/安全区、Electron、Safari/Firefox 及其他 DPR。qi 的离线真实 E2E 不替代这些验证。

## 残余差异与严格验收结论

- 身份：qi 名称和标记与 DeepSeek 的商标不同，保留在所有无遮罩指标中。早先将320px模型菜单背景残差归因于品牌的解释证据不足，已撤回；修正其下方工作区/模式行后，该区域最大通道差从67降至1，说明可修布局确实影响背景模糊。其余非零像素未归因于品牌或后端。
- 真实业务：qi 明确显示“运行完成·尚未验收”、子任务 provider/id/返回，统计为真实轨迹和工具时长；官方赞踩、分享、token/缓存/速度数据缺少等价 qi 协议，未伪造。
- 设置/模式：当前会话权限与官方新会话默认权限不同；qi 仅支持中文，保留真实工作区管理、插件/工具设置。模式菜单保留真实的标准/创造/生产只读模式；没有捏造官方PTC/极简模式。官方配置文件、预设编辑、遥测、快捷键、繁忙时发送方式及各角色字体设置没有等价功能，其内容、分类图标和滚动高度仍不同。没有渲染无实现的字体展开按钮。官方320px模式菜单实拍还出现负x裁切，候选菜单保持12px边界和可操作，这一差异明确保留而不冒充源像素一致。窄屏设置保留参考双栏框架，不等于实机可用性已穷尽。
- 折叠：思考与 bash 的共有状态已同层级；qi 各工具原始参数、失败/缺失结果及未确认状态仍显示，子任务结果披露与官方描述符不同。不能笼统宣称所有工具/子任务像素一致。
- 静态：桌面权限/工作区/模型菜单边缘各剩1个像素、最大通道差1；320px 模型菜单1925像素、深色桌面输入卡片1312像素、字号数值40/12像素，最大通道差均为1。主题太阳图标在浅/深色分别仍有最大通道差17/8，其他主题按钮边缘也有非零差。static-residual-audit.json 与两侧逐图SVG证明太阳图标的实际路径、描画属性、采样样式及几何已对应，但不能证明最终栅格一致。这些不是必要的后端功能差异，原因未完全定位，继续作为明确的视觉阻碍。没有放宽阈值、修图或遮罩来宣布一致。

因此本地候选和工程验证已完成，完整像素目标仍为 blocked，未获得“全屏像素一致”接受结论。没有发布该候选。

## 明确区域诊断

下面按实际 DOM 矩形裁切，包含所有部分边缘像素；固定会话列表矩形另作标记。32/45个区域严格相等不能代表整页相等。字号、主题与窄屏模式行最后一轮修正前图在 refinements-before/；对照原始数值而不只看肉眼。

'''+ '\n'.join(region_table)+'''

## 全部配对结果

'''+ '\n'.join(all_table)+'''

## 复核/重算

已提交的截图可离线重算，无需启动服务或访问网络。在本目录运行：

    python scripts/compare-pixels.py .
    python scripts/compare-pixel-regions.py .
    python scripts/check-pixel-geometry.py candidate .

Pillow 用于原始像素计算。capture-pixels.mjs、官方两份 scaffold 测试、run-check.py 和原 isolation.sb 作为运行证据保留；它们记录本次任务根及依赖位置，不是可在任意宿主无审查直接启动的安装脚本。重新捕获时应在相同版本的隔离 sibling checkout 中检查这些路径和依赖，使用记录的命令；不会自动下载模型、读取真实浏览器配置或启动既有服务。
'''
(out/'README.md').write_text(report)
candidates=[r for r in pairs if r['mode']=='candidate']
names_json=json.dumps([r['name'] for r in candidates])
metrics_json=json.dumps({r['name']:r['raw_unmasked'] for r in candidates})
baseline_json=json.dumps([r['name'] for r in pairs if r['mode']=='baseline'])
html="""<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>qi-agent 像素对照</title>
<style>body{margin:24px;font:15px/1.6 system-ui;color:#17212b;background:#f5f6f8}main{max-width:1600px;margin:auto}h1{font-size:24px}select,button{font:inherit;padding:8px 12px;margin:4px;border:1px solid #cfd5dc;border-radius:8px;background:white}img{display:block;max-width:100%;height:auto;background:white}a{color:#245fcc}.status{color:#a43922}nav{margin:16px 0}.meta{font-variant-numeric:tabular-nums}details{margin:16px 0}</style><main>
<h1>qi-agent 与 DeepSeek Harness 像素对照 · 2026-10-20</h1><p class='status'>严格全屏像素验收：blocked · 非零差异与真实功能差异保留</p>
<p>官方687f282 / 旧候选3158601 / 本地候选。Chrome155，DPR1，同视口/字体/主题/固定语义内容。全屏不排除像素，差异图显示放大×4，指标使用原始RGB。</p>
<p><a href='README.md'>完整报告与残余差异</a> · <a href='readonly-review.md'>独立复核</a> · <a href='comparison/metrics.json'>全屏指标</a> · <a href='comparison/regions.json'>控件区域指标</a> · <a href='tested-source.json'>源码和构建指纹</a></p>
<label>状态 <select id='state'></select></label><nav id='modes'></nav><p id='meta' class='meta'></p><a id='original' target='_blank'><img id='visual' alt='同尺寸原始截图对照'></a>
<details><summary>补充实际界面（数据状态不同，未伪造配对像素比例）</summary><p><a href='reference-extra/subtask-menu-light-1440.png'>官方子任务弹层</a> · <a href='candidate/extra-subtask-menu-light-1440.png'>qi子任务弹层</a> · <a href='candidate/extra-subtask-result-light-1440.png'>qi真实返回披露</a> · <a href='reference-extra/loading-no-transport-light-1440.png'>官方等待连接</a> · <a href='candidate/extra-bootstrap-error-light-1440.png'>qi bootstrap错误</a> · <a href='reference-extra/replay-exhausted-subtask-light-390.png'>官方录制耗尽错误（非生产网络错误）</a></p><p>模式菜单保留官方4种、qi3种真实预设；该两组内容不完全同态。官方320px模式菜单实拍存在左侧裁切；候选维持12px边界，此差异仍阻断严格像素一致。</p></details>
</main><script>
const names=NAMES, metrics=METRICS, baselines=BASELINES;
const state=document.getElementById('state'), image=document.getElementById('visual'), link=document.getElementById('original'), meta=document.getElementById('meta');
let mode='side-by-side';
const modes=[['side-by-side','并排'],['overlay','50%叠加'],['diff-x4','差异×4'],['reference','官方原图'],['candidate','候选原图'],['baseline','旧候选']];
names.forEach(name=>{const option=document.createElement('option');option.value=option.textContent=name;state.append(option)});
modes.forEach(([id,label])=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.mode=id;b.onclick=()=>{mode=id;show()};document.getElementById('modes').append(b)});
function show(){const name=state.value;const p=['reference','candidate','baseline'].includes(mode)?mode+'/'+name+'.png':'comparison/'+name+'-'+mode+'.png';image.src=link.href=p;const m=metrics[name];meta.textContent=m.width+' × '+m.height+' · 全屏非零像素 '+m.pixels_nonzero+' ('+m.pixels_nonzero_percent+'%) · 严格相等 '+m.exact_equal+' · Δ>16 '+m.pixels_gt16_percent+'%（仅诊断） · MAE '+m.mae_0_255+' · 点击图像查看原尺寸';document.querySelectorAll('[data-mode]').forEach(b=>{b.disabled=b.dataset.mode==='baseline'&&!baselines.includes(name);b.setAttribute('aria-pressed',String(b.dataset.mode===mode))})}
state.onchange=()=>{if(mode==='baseline'&&!baselines.includes(state.value))mode='side-by-side';show()};state.value='new-session-light-1440';show();
</script></html>"""
html=html.replace('NAMES',names_json).replace('METRICS',metrics_json).replace('BASELINES',baseline_json)
(out/'index.html').write_text(html)
print(json.dumps({'output':str(out),'source_files':len(fingerprints),'build_artifacts':len(artifacts),'paired_states':len(candidates),'checks':len(index)},ensure_ascii=False))
