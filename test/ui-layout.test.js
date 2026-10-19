import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// styles.css 已按层拆分为 public/css/*.css（Phase 2a），测试按 link 顺序拼接后断言
const cssLayers = ['base', 'theme', 'workbench', 'account', 'commercial', 'workflows', 'console', 'dark', 'notion', 'operations'];
const css = cssLayers.map(name => fs.readFileSync(new URL(`../public/css/${name}.css`, import.meta.url), 'utf8')).join('\n');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// app.js 已拆分为入口 + public/js/** 模块；测试按模块拼接后断言，保持与旧单文件一致
const walkJs = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(ent => ent.isDirectory() ? walkJs(path.join(dir, ent.name)) : ent.name.endsWith('.js') ? [path.join(dir, ent.name)] : []);
const appSources = [fileURLToPath(new URL('../public/app.js', import.meta.url)), ...walkJs(fileURLToPath(new URL('../public/js', import.meta.url))).sort()];
const app = appSources.map(file => fs.readFileSync(file, 'utf8')).join('\n');
const monitorUtils = fs.readFileSync(new URL('../public/monitor-utils.js', import.meta.url), 'utf8');

test('新版工作台导航和主面板保持稳定布局', () => {
  assert.match(css, /#dataTabs\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.workbench-layout\s*>\s*\.workbench-rail\s*\{[^}]*grid-column:\s*1/);
  assert.match(css, /\.workbench-layout\s*>\s*\.workbench-main,\s*\.workbench-layout\s*>\s*\.data-workbench-main\s*\{[^}]*width:\s*100%[^}]*grid-column:\s*2/);
  assert.match(css, /\.workbench-layout\s*>\s*\.workbench-rail,\s*\.workbench-layout\s*>\s*\.workbench-main,\s*\.workbench-layout\s*>\s*\.data-workbench-main\s*\{\s*grid-column:\s*1/);
  assert.match(css, /#adminBillingTabs\s*\{\s*display:\s*flex;\s*\}/);
  assert.doesNotMatch(html, /id="resourceTabs"/);
  assert.match(css, /\.data-workbench\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /#adminBillingTabs[^{}]*\{[^{}]*display:\s*none/);
  assert.match(html, /css\/base\.css\?v=recovery1/);
  assert.match(html, /app\.js\?v=main-ui-20261019/);
  assert.match(app, /if \(autoRenew\) autoRenew\.checked/);
  assert.match(app, /if \(last\) paintServiceStatus\(last\)/);
  assert.match(app, /statusStorageKey|sessionStorage\.setItem\([^)]*arenode-service-status/);
  assert.match(html, /id="bootSplash"/);
  assert.match(html, /id="loginView" class="login-shell hidden"/);
  // Factory 风格登录页契约：右侧官方徽标艺术层 + 巨型表单标题
  assert.match(html, /<aside class="login-art" aria-hidden="true"><div class="art-stage"><div class="art-logo"><\/div><\/div><\/aside>/);
  assert.match(css, /\.login-art \.art-logo\s*\{[^}]*mask-image: url\('\/assets\/factory-logo\.svg'\)/);
  assert.match(css, /\.login-form > h2\s*\{[^}]*clamp\(38px, 4\.4vw, 56px\)/);
  // Factory 1:1 复刻契约：登录页橙色主调作用域 + 官方星形徽标（mask 取令牌色）+ 呼吸与表单入场动画
  assert.match(css, /\.login-shell\s*\{[^}]*--accent:\s*#ff4d00/);
  assert.match(css, /\.brand-mark\s*\{[^}]*mask: url\('\/assets\/factory-logo\.svg'\)/);
  assert.match(css, /@keyframes art-enter \{\s*from \{ opacity: 0/);
  assert.match(css, /@keyframes art-breathe/);
  assert.doesNotMatch(css, /animation:\s*art-gradient/);
  assert.match(css, /\.login-shell\s*\{[^}]*radial-gradient\(46% 40% at 30% 28%, color-mix\(in srgb, var\(--accent\) 13%/);
  // 右栏鼠标互动契约：3D 倾斜舞台 + 按压回弹 + 光标探照灯 + CSS 变量驱动倾斜
  assert.match(css, /\.art-stage\s*\{[^}]*perspective\(1100px\) rotateX\(var\(--tilt-x/);
  assert.match(css, /\.login-art:active \.art-stage\s*\{[^}]*scale\(\.96\)/);
  assert.match(css, /\.login-shell::after\s*\{[^}]*radial-gradient\(circle 190px at center/);
  assert.match(css, /\.login-shell::after\s*\{[^}]*translate3d\(calc\(var\(--glow-x/);
  assert.match(app, /initLoginArtFx\(\)/);
  assert.match(app, /stage\.style\.setProperty\('--tilt-x'/);
  assert.doesNotMatch(css, /\.login-shell:not\(\.hidden\)\s*\{[^}]*login-bg-pan/);
  assert.match(css, /\[data-theme='dark'\] \.login-shell\s*\{\s*--login-glow:/);
  assert.match(css, /@keyframes auth-rise/);
  assert.match(app, /appView\.classList\.add\('app-entering'\)/);
  assert.match(css, /\.app-entering \.view\.active > \*\s*\{[^}]*auth-rise/);
  assert.match(html, /id="recoveryRecordName"/);
  assert.match(html, /id="recoveryRecordValue"/);
  assert.match(html, /id="copyRecoveryRecordValue"[^>]*>复制 TXT 内容<\/button>/);
  assert.match(app, /function copyText\(value, successMessage/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /copyRecoveryRecordValue'\)\.addEventListener.*copyText\(\$\('#recoveryRecordValue'\)\.textContent/);
  assert.match(html, /name="siteProfile"[^>]*>.*value="mixed_ai">AI API 全协议/);
  assert.match(app, /siteProfile:\s*form\.elements\.siteProfile\.value/);
  assert.match(html, /<title>Arenode 控制台<\/title>/);
  assert.match(html, /class="arenode-logo"[^>]*>A<\/div>/);
  assert.match(app, /function syncWorkbenchLayout\(\)/);
  // 二级 rail 显隐已改为 .rail-hidden 类驱动（不再使用 JS 内联 !important）
  assert.match(app, /classList\.toggle\('rail-hidden', !contextRailVisible\)/);
  assert.match(app, /layout\.classList\.contains\('data-workbench'\)/);
  assert.doesNotMatch(app, /style\.setProperty\('display'/);
  assert.match(css, /\.workbench-layout\.rail-hidden\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.workbench-layout\.rail-hidden\s*>\s*\.workbench-rail\s*\{\s*display:\s*none/);
  // 可折叠侧栏契约：桌面折叠为 64px 图标栏，偏好持久化
  assert.match(css, /\.app-shell\.nav-collapsed\s*\{\s*--sidebar-w:\s*64px/);
  assert.match(css, /\.app-shell\.nav-collapsed\s+\.nav-cluster:hover\s+\.nav-children/);
  assert.match(app, /localStorage\.setItem\('arenode-nav-collapsed'/);
  // 深浅色双主题契约：dark 层覆写令牌，顶栏切换按钮，偏好持久化，首屏内联脚本防闪烁
  assert.match(css, /\[data-theme='dark'\]\s*\{[^}]*--canvas:\s*#191919/);
  assert.match(css, /\[data-theme='dark'\]\s*\{[^}]*--panel:\s*#202020/);
  assert.match(html, /id="themeToggle"/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<script src="\/js\/theme-init\.js"><\/script>/);
  assert.match(app, /localStorage\.getItem\('arenode-theme'\)/);
  assert.doesNotMatch(html, /<script>try \{ document\.documentElement\.dataset\.theme/);
  assert.match(app, /localStorage\.setItem\('arenode-theme'/);
  assert.match(app, /arenode:themechange/);
  // 主题切换特效契约：View Transition 圆形扩散 + 降级全局渐变 + 尊重减弱动画偏好
  assert.match(app, /document\.startViewTransition/);
  assert.match(app, /--theme-x/);
  assert.match(app, /theme-fading/);
  assert.match(app, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@keyframes theme-circle-in/);
  assert.match(css, /::view-transition-new\(root\)\s*\{[^}]*theme-circle-in/);
  assert.match(css, /\.theme-fading, \.theme-fading \*[^}]*transition: background-color/);
  // Notion 风格契约（Phase 2d）：米色画布、青蓝强调、扁平按钮、灰底选中导航、150ms 颜色过渡
  assert.match(css, /--canvas:\s*#f7f6f3/);
  assert.match(css, /--accent:\s*#2eaadc/);
  assert.match(css, /\.primary\s*\{\s*box-shadow:\s*none/);
  assert.match(css, /\.secondary:hover\s*\{\s*background:\s*var\(--bg-hover\)/);
  assert.match(css, /\.sidebar nav button\.active, \.sidebar nav \.nav-direct\.active\s*\{\s*color:\s*var\(--ink\);\s*background:\s*var\(--nav-2\)/);
  assert.match(css, /transition-duration:\s*\.15s/);
  // 间距系统契约（Phase 2e）：4px 标尺、面板内左缘 16px 对齐、控件高度统一 40px、billing 页 16px 单轨节奏、sticky 跟随 56px 顶栏
  assert.match(css, /label\s*\{\s*margin-bottom:\s*16px/);
  assert.match(css, /\.panel-head\s*\{\s*padding:\s*12px 16px/);
  assert.match(css, /\.subsection-head\s*\{\s*min-height:\s*48px/);
  assert.match(css, /\.filter-toolbar > button\s*\{\s*min-height:\s*40px/);
  assert.match(css, /\.site-config-tabs\s*\{\s*top:\s*56px/);
  assert.match(css, /#billing > \.section-head\s*\{\s*margin-bottom:\s*0/);
  assert.match(css, /#billing > \.tenant-billing-pane\s*\{\s*margin-top:\s*16px/);
  assert.match(css, /\.workbench-layout\s*\{\s*gap:\s*16px/);
  assert.match(css, /dialog \.dialog-actions\s*\{\s*gap:\s*8px;\s*margin-top:\s*8px/);
  assert.match(app, /function actionMenu\(content\)/);
  assert.match(app, /popover="auto"/);
  assert.doesNotMatch(app, /<details class="action-menu">/);
  assert.match(css, /\.action-popover:popover-open\s*\{\s*display:\s*grid/);
  assert.match(app, /function normalizeSiteCacheUnit\(value\)/);
  assert.match(app, /<option value="s">秒<\/option>.*<option value="d">天<\/option>/);
  assert.match(html, /data-site-workbench="defaults"[^>]*>.*?<strong>默认设置<\/strong>/);
  assert.match(html, /id="siteBulkEdit"[^>]*>批量修改<\/button>/);
  assert.match(html, /id="siteMoreActions"[^>]*>更多操作<\/button>/);
  assert.match(css, /\.site-toolbar-popover\s*\{\s*min-width:\s*148px/);
  assert.match(css, /\.workbench-rail\s*\{[^}]*grid-auto-flow:\s*column[^}]*overflow-x:\s*auto/);
  assert.match(html, /id="ccResourceTabs"[^>]*>.*data-resource-kind="cc-rules".*data-resource-kind="cc-matchs".*data-resource-kind="cc-filters"/);
  assert.match(html, /name="certAutoRenew"[^>]*type="checkbox"/);
  assert.match(app, /\$\$\('\[data-cert-auto\]'\)\.forEach\(field => field\.classList\.toggle\('hidden', custom\)\)/);
  assert.doesNotMatch(app, /更多⌄/);
  assert.match(css, /\.action-menu-trigger::after\s*\{/);
  assert.match(css, /content:\s*'▾'/);
  assert.match(html, /设置新建资源时默认采用的配置，可在创建时调整/);
  assert.match(monitorUtils, /function normalizeMonitorItems\(data\)/);
  assert.match(app, /endpoint === 'stream-top' \? \[\['top-ports', '监听端口'\]\]/);
  assert.match(app, /base\.set\('type', 'top-ports'\); base\.set\('recent_time'/);
  assert.match(monitorUtils, /Object\.hasOwn\(value, key\)/);
  assert.match(app, /start\.setHours\(0, 0, 0, 0\)/);
  assert.match(monitorUtils, /function formatMonitorTime\(value\)/);
  assert.doesNotMatch(app, /detail\.textContent = JSON\.stringify\(item\)/);
  assert.match(html, /id="financeTransactionTable"/);
  assert.match(app, /data-audit-detail/);
  assert.match(html, /<table class="upstream-table">/);
  assert.match(css, /\.upstream-table\s*\{\s*table-layout:\s*fixed/);
});

test('DNS API 支持上游全部服务商和可变数量凭据字段', () => {
  for (const provider of [
    'CloudFlare', 'DNSPod.cn', 'DNSPod.com', 'GoDaddy.com', 'Aliyun', 'cloudns.net',
    'Name.com', 'Namecheap', 'jdcloud.com', 'DNS.LA', 'Namesilo.com', '51DNS.COM', 'huaweicloud.com',
  ]) assert.match(html, new RegExp(`<option value="${provider.replace('.', '\\.')}">`));
  assert.match(html, /id="dnsCredentialFields"/);
  assert.doesNotMatch(html, /name="dnsCredentialOne"|name="dnsCredentialTwo"/);
  assert.match(app, /Namecheap:\s*\[\['NAMECHEAP_USERNAME'.*'NAMECHEAP_API_KEY'.*'NAMECHEAP_SOURCEIP'/);
  assert.match(app, /'Namesilo\.com':\s*\[\['Namesilo_Key'/);
  assert.match(app, /function updateDnsCredentialFields\(keys = null, placeholder = ''\)/);
  assert.match(app, /\$\$\('\[data-dns-credential\]', form\)/);
});

test('证书和四层转发提供明确的启停操作并统一删除提示', () => {
  assert.match(html, /id="resourceCreatedHeader" class="hidden">创建时间/);
  assert.match(html, /id="resourceExpiresHeader" class="hidden">到期时间/);
  assert.match(html, /id="resourceAutoRenewHeader" class="hidden">自动续签/);
  assert.match(app, /resource\.create_at2 \?\? resource\.created_at \?\? resource\.createdAt/);
  assert.match(app, /resource\.expire_time2 \?\? resource\.expire_time \?\? resource\.expires_at/);
  assert.match(app, /const certificateDate = value => value \? formatDate\(value\) : '上游未返回'/);
  assert.match(app, /if \(!text \|\| text === '-' \|\| text === '0'\) return '-'/);
  assert.match(app, /data-toggle-resource=.*停用证书.*启用证书/);
  assert.match(app, /请先停用所选证书，再执行删除操作/);
  assert.match(app, /data-toggle-stream=.*停用转发.*启用转发/);
  assert.match(app, /请先停用所选四层转发，再执行删除操作/);
  assert.doesNotMatch(app, /运行中的转发会先停用/);
  assert.doesNotMatch(html, /已禁用|不会修改 CDN 上游账号的系统默认值/);
  assert.match(app, /resourceLifecycle\(resource, 'certs'\)\.state === 'active'/);
  assert.match(app, /function streamRuntimeBadge\(resource = \{\}\)/);
  assert.match(app, /tr\.children\[5\]\.innerHTML = httpsEnabled \? .*已启用.* : .*未启用/);
});

test('客户全局导航精简站点入口并为四层转发提供独立默认设置', () => {
  const tenantNav = html.match(/<div class="customer-only tenant-nav">([\s\S]*?)<div class="admin-only admin-nav">/)?.[1] || '';
  const siteCluster = tenantNav.match(/<span>站点管理<\/span>[\s\S]*?<\/section>/)?.[0] || '';
  const streamCluster = tenantNav.match(/<span>四层转发<\/span>[\s\S]*?<\/section>/)?.[0] || '';
  assert.doesNotMatch(siteCluster, /data-kind="site-groups"|data-data-tab="configs"/);
  assert.match(siteCluster, /网站列表/);
  assert.match(siteCluster, /证书管理/);
  assert.match(siteCluster, /刷新预热/);
  assert.match(siteCluster, /DNS API/);
  assert.match(streamCluster, /data-config-type="stream" data-title="默认设置"/);
});

test('数据详情子目录与上游一致且账号日志合并为单一入口', () => {
  const tenantNav = html.match(/<div class="customer-only tenant-nav">([\s\S]*?)<div class="admin-only admin-nav">/)?.[1] || '';
  const dataCluster = tenantNav.match(/<span>数据详情<\/span>[\s\S]*?<\/section>/)?.[0] || '';
  const accountCluster = tenantNav.match(/<span>账户中心<\/span>[\s\S]*?<\/section>/)?.[0] || '';
  const labels = [...dataCluster.matchAll(/data-title="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(labels, ['网站监控', '拦截日志', '访问日志', '转发监控']);
  assert.doesNotMatch(dataCluster, /日志查询|用量查询/);
  assert.equal((accountCluster.match(/data-title="日志查询"/g) || []).length, 1);
  assert.doesNotMatch(accountCluster, /data-title="(?:操作日志|登录日志)"/);
  assert.match(html, /data-monitor-context-item="audit"[^>]*data-endpoint="operation-log"/);
  assert.match(html, /data-monitor-context-item="audit"[^>]*data-endpoint="login-log"/);
});

test('余额中心合并余额流水、消费订单和兑换记录', () => {
  const tenantNav = html.match(/<div class="customer-only tenant-nav">([\s\S]*?)<div class="admin-only admin-nav">/)?.[1] || '';
  const accountCluster = tenantNav.match(/<span>账户中心<\/span>[\s\S]*?<\/section>/)?.[0] || '';
  assert.equal((accountCluster.match(/data-billing-target="wallet"/g) || []).length, 1);
  assert.doesNotMatch(accountCluster, /data-billing-target="orders"|消费记录/);
  assert.match(html, /data-tenant-billing-pane="wallet">\s*<div class="panel-head"><div><h3>我的订单<\/h3>/);
  assert.match(html, /data-tenant-billing-pane="wallet"><div class="panel-head"><div><h3>兑换记录<\/h3>/);
  assert.match(app, /if \(target === 'orders'\) target = 'wallet'/);
  assert.match(app, /wallet: '查看余额、充值、消费订单和兑换记录'/);
});

test('四层转发分组使用独立表头和字段，不显示监听占位文案', () => {
  for (const id of ['streamNameHeading', 'streamOriginHeading', 'streamPlanHeading']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /groupMode \? '分组名称' : '名称 \/ 监听'/);
  assert.match(app, /groupMode \? '备注' : '源站'/);
  assert.match(app, /groupMode \? '已归类转发' : '所属套餐'/);
  assert.match(app, /function streamBelongsToGroup/);
  assert.doesNotMatch(app, /未返回监听/);
});

test('解析检查使用站内工作台页面且不跳转第一个网站', () => {
  const handler = app.match(/\$\('#siteAnalysisEntry'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0] || '';
  assert.doesNotMatch(html, /id="siteAnalysisDialog"/);
  assert.match(html, /id="siteAnalysisPane"/);
  assert.match(html, /id="checkAllSiteCnames"/);
  assert.match(handler, /siteAnalysisPane/);
  assert.doesNotMatch(handler, /state\.sites\[0\]|openSiteDetail/);
});

test('浏览器原生提示框已替换为站内 API Key 弹窗', () => {
  assert.match(html, /id="apiKeyDialog"/);
  assert.match(html, /id="apiKeyForm"/);
  assert.doesNotMatch(app, /window\.(?:prompt|confirm|alert)/);
  assert.match(app, /\$\('#apiKeyDialog'\)\.showModal\(\)/);
});

test('网站详情双栏控件保持固定高度并按顶部对齐', () => {
  assert.match(css, /\.site-config-form \.detail-form-grid \{[^}]*row-gap: 16px/);
  assert.match(css, /\.site-config-form \.detail-form-grid > label \{[^}]*align-self: start;[^}]*align-content: start;[^}]*margin-bottom: 0/);
  assert.match(css, /\.site-config-form \.detail-form-grid > label > input:not\(\[type="checkbox"\]\),\.site-config-form \.detail-form-grid > label > select \{[^}]*height: 40px;[^}]*min-height: 40px/);
  assert.match(html, /匹配内容<textarea name="hotlinkScopeContent" rows="4"/);
});

test('回源 SSL 协议允许客户选择四个上游协议且关闭 HTTPS 不提交空证书', () => {
  const originProtocols = html.match(/<fieldset class="tls-protocol-field"><legend>回源 SSL 协议<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
  for (const protocol of ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']) {
    assert.match(originProtocols, new RegExp(`name="proxySslProtocol" value="${protocol.replace('.', '\\.')}`));
  }
  assert.doesNotMatch(originProtocols, /旧版/);
  assert.doesNotMatch(html, /name="proxySslProtocols"/);
  assert.match(app, /setTlsProtocols\(form, config\.proxy_ssl_protocols, 'proxySslProtocol'\)/);
  assert.match(app, /proxy_ssl_protocols: proxySslProtocols\.join\(' '\)/);
  assert.match(app, /const currentHttpsEnabled = enabledValue/);
  assert.match(app, /form\.elements\.sslCiphers\.value = https\.ssl_ciphers \|\| DEFAULT_SSL_CIPHERS/);
  assert.match(app, /ssl_ciphers: form\.elements\.sslCiphers\.value\.trim\(\) \|\| DEFAULT_SSL_CIPHERS/);
  assert.match(html, /默认采用兼顾安全性与兼容性的推荐套件，可按需修改/);
  assert.doesNotMatch(html, /留空使用推荐配置/);
  assert.match(app, /if \(form\.elements\.httpsEnabled\.checked\) httpsListen\.cert = Number\(form\.elements\.httpsCert\.value\);\s*else if \(currentHttpsEnabled\) httpsListen\.cert = currentHttps\.cert/);
  assert.match(app, /body = form\.elements\.httpsEnabled\.checked \|\| currentHttpsEnabled \? \{ https_listen: httpsListen \} : \{\}/);
  assert.match(css, /\.site-config-form \.tls-protocol-field \{[^}]*align-self: start;[^}]*margin-bottom: 0/);
});

test('监控快捷范围使用带标题且等高的分段按钮组', () => {
  assert.match(html, /<fieldset class="preset-range"><legend>快捷范围<\/legend><div class="preset-range-buttons">/);
  assert.match(css, /\.preset-range button \{[^}]*min-height: 40px/);
  assert.match(css, /\.preset-range-buttons \{[^}]*display: flex;[^}]*align-items: stretch/);
  assert.match(css, /\.monitor-main \.query-grid input, \.monitor-main \.query-grid select \{[^}]*height: 40px;[^}]*min-height: 40px/);
  assert.match(css, /\.monitor-main #monitorForm > \.preset-range \{[^}]*grid-column: 1 \/ span 4/);
  assert.match(css, /\.monitor-main #monitorForm > button\[type="submit"\] \{[^}]*grid-column: 5/);
  assert.match(html, /data-monitor-minutes="10"/);
  assert.match(app, /数据排行时间范围不能超过 1 小时/);
  assert.match(app, /base\.set\('recent_time', rankingMinutes <= 10 \? '10m' : rankingMinutes <= 30 \? '30m' : '60m'\)/);
  assert.match(app, /\['req-cache-status', '请求缓存状态'\]/);
  assert.match(app, /\['byte-cache-status', '流量缓存状态'\]/);
  assert.doesNotMatch(app, /\['cache-status'/);
});

test('访问日志按 CDNFly 请求字段展示并保留详情入口', () => {
  for (const label of ['时间', '域名', '端口', '协议', '方法', 'URI', '状态码', '客户端 IP', 'TLS 指纹', '地理位置', '运营商', '源地址', '内容类型', '来源', '浏览器', '回源耗时', '返回字节', '缓存命中', '操作']) assert.match(app, new RegExp(`'${label}'`));
  for (const field of ['server_port', 'protocol', 'method', 'req_uri', 'status', 'addr', 'tls_fp', 'country', 'province', 'city', 'isp', 'sip', 'content_type', 'referer', 'user_agent', 'up_resp_time', 'bytes_sent', 'cache_status']) assert.match(app, new RegExp(`item\\.${field}`));
  assert.match(app, /base\.set\('limit', '100'\); base\.set\('page', '1'\)/);
  assert.match(css, /\.access-log-table \{ min-width: 2860px/);
  assert.match(css, /\.access-log-table \.access-uri \{[^}]*text-overflow: ellipsis/);
});

test('监控分类切换会清空旧结果、自动查询并隔离过期响应', () => {
  assert.match(app, /monitorRequestId: 0/);
  assert.match(app, /function resetMonitorResults\(\)/);
  assert.match(app, /if \(requestId !== state\.monitorRequestId\) return/);
  assert.match(app, /if \(autoQuery && monitorFormCanQuery\(\)\) queryMonitor\(form\)/);
  assert.match(app, /monitor\/site\/overview/);
});

test('默认设置使用受控字段且监控与证书具有内部分类侧栏', () => {
  assert.match(html, /id="userConfigValueMount"/);
  assert.match(app, /const USER_CONFIG_CATALOG/);
  assert.match(app, /function renderUserConfigValue/);
  assert.match(html, /id="monitorRail"/);
  assert.match(html, /data-monitor-mode="attack"/);
  assert.match(html, /id="resourceContextRail"/);
  assert.match(css, /\.monitor-workbench\s*\{/);
});

test('钱包统计与表单开关使用统一布局', () => {
  for (const id of ['walletBalance', 'walletRecharge', 'walletSpent']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /\$\('#walletRecharge'\)\.textContent = formatMoney\(state\.wallet\.totalRechargeCents\)/);
  assert.match(app, /\$\('#walletSpent'\)\.textContent = formatMoney\(state\.wallet\.totalSpentCents\)/);
  assert.match(css, /\.detail-form-grid > \.switch-inline,[\s\S]*?height:\s*40px/);
  assert.match(css, /\.detail-form-grid > label\.switch-inline:last-child\s*\{\s*margin-bottom:\s*18px/);
});

test('客户侧只保留安全策略分组内的 CC 防护入口', () => {
  const ccNavEntries = html.match(/<button data-view="security" data-kind="cc-rules"/g) ?? [];
  const securityGroupLabels = html.match(/<span>安全策略<\/span>/g) ?? [];

  assert.equal(ccNavEntries.length, 1);
  assert.equal(securityGroupLabels.length, 1);
  assert.doesNotMatch(html, /data-title="安全策略" class="nav-direct"/);
  assert.match(html, /data-kind="cc-rules" data-title="CC 防护"/);
});

test('网站管理详情按上游八类配置组织并提交真实字段', () => {
  const sectionButtons = html.match(/data-site-section="site[A-Za-z]+"/g) ?? [];
  const cacheEditor = app.match(/function addSiteCacheRuleRow[\s\S]*?function addSiteHeaderRow/)?.[0] || '';

  assert.equal(sectionButtons.length, 8);
  assert.doesNotMatch(html, /<[^>]+class="[^"]*detail-rail/);
  for (const section of ['siteBasic', 'siteHttp', 'siteOrigin', 'siteHttps', 'siteCache', 'siteSecurity', 'siteAccess', 'siteAdvanced']) {
    assert.match(html, new RegExp(`data-site-section="${section}"`));
  }
  for (const field of ['backendHttpPort', 'backendHttpsPort', 'balanceWay', 'backendPortMapping', 'ccDefaultRule', 'acl']) {
    assert.match(html, new RegExp(`name="${field}"`));
  }
  assert.match(html, /id="siteRequestHeaderList"/);
  assert.match(html, /id="siteResponseHeaderList"/);
  assert.match(html, /id="siteRewriteList"/);
  assert.match(cacheEditor, /option value="suffix"/);
  assert.match(cacheEditor, /option value="dir"/);
  assert.match(cacheEditor, /option value="full_path"/);
  assert.doesNotMatch(cacheEditor, /option value="(?:prefix|regex|all)"/);
  assert.match(cacheEditor, /data-add-no-cache/);
  assert.match(app, /\$\$\('\.cache-exclusion-row', row\)/);
  for (const field of ['backend_http_port', 'backend_https_port', 'balance_way', 'backend_port_mapping', 'cc_default_rule', 'req_header', 'resp_header', 'url_rewrite']) {
    assert.match(app, new RegExp(`${field}:`));
  }
  assert.match(app, /\.\.\.\(ccDefaultRule \? \{ cc_default_rule: ccDefaultRule \} : \{\}\)/);
  assert.doesNotMatch(app, /cc_default_rule:\s*form\.elements\.ccDefaultRule\.value\s*\?[^\n]+:\s*0/);
  for (const code of ['403', '404', '500', '502', '504']) {
    assert.match(html, new RegExp(`name="page${code}"`));
    assert.match(app, new RegExp(`page_${code}`));
  }
  assert.doesNotMatch(app, /page_50x/);
  assert.match(app, /state\.currentSiteSection === 'siteBasic'/);
  assert.match(app, /state\.currentSiteSection === 'siteHttps'/);
});
