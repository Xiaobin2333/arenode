import { toast } from '../components/toast.js';
import { showLogin } from '../features/auth/index.js';

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({ error: '服务器响应无效' }));
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status, data });
  return data;
}

export function handleError(error) {
  if (error.status === 401) return showLogin();
  toast(error.message, true);
}
