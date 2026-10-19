// 首屏防闪烁：在样式表加载前恢复持久化主题（CSP 禁止内联脚本，故独立为外部文件）
try {
  document.documentElement.dataset.theme = localStorage.getItem('arenode-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch (error) {}
