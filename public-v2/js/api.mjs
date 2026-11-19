'use strict';

function getPassword() {
  let password = sessionStorage.getItem('dashboardPassword');
  if (password === null) {
    password = window.prompt('Dashboard password:') || '';
    sessionStorage.setItem('dashboardPassword', password);
  }
  return password;
}

export async function fetchJson(path, params = {}) {
  const query = new URLSearchParams({ mode: 'paper', ...params }).toString();
  const url = `${path}?${query}`;
  const password = getPassword();

  const res = await fetch(url, { headers: { 'X-Dashboard-Password': password } });
  if (res.status === 401) {
    sessionStorage.removeItem('dashboardPassword');
    const retryPassword = getPassword();
    const retryRes = await fetch(url, { headers: { 'X-Dashboard-Password': retryPassword } });
    if (!retryRes.ok) throw new Error(`request failed: ${retryRes.status}`);
    return retryRes.json();
  }
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}
