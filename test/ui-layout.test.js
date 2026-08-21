import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
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
  assert.match(html, /styles\.css\?v=arenode/);
  assert.match(html, /app\.js\?v=arenode/);
  assert.match(html, /<title>Arenode 控制台<\/title>/);
  assert.match(html, /class="arenode-logo"[^>]*>A<\/div>/);
  assert.match(app, /function syncWorkbenchLayout\(\)/);
  assert.match(app, /contextRailVisible \? 'grid' : 'none'/);
  assert.match(app, /layout\.classList\.contains\('data-workbench'\)/);
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
  assert.match(css, /\.site-config-form \.detail-form-grid \{[^}]*row-gap: 18px/);
  assert.match(css, /\.site-config-form \.detail-form-grid > label \{[^}]*align-self: start;[^}]*align-content: start;[^}]*margin-bottom: 0/);
  assert.match(css, /\.site-config-form \.detail-form-grid > label > input:not\(\[type="checkbox"\]\),\.site-config-form \.detail-form-grid > label > select \{[^}]*height: 44px;[^}]*min-height: 44px/);
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
  assert.match(css, /\.preset-range button \{[^}]*min-height: 44px/);
  assert.match(css, /\.preset-range-buttons \{[^}]*display: flex;[^}]*align-items: stretch/);
  assert.match(css, /\.monitor-main \.query-grid input, \.monitor-main \.query-grid select \{[^}]*height: 44px;[^}]*min-height: 44px/);
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
