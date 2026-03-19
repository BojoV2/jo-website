export function getApiBase() {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }

  if (window.location.port === '3000') {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    return `${protocol}//${host}:8080/api`;
  }

  return '/api';
}

const API_BASE = getApiBase();

function extractDownloadMeta(response) {
  const disposition = response.headers.get('content-disposition') || '';
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  let fileName = 'download.bin';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match && match[1]) {
    fileName = decodeURIComponent(match[1]).replace(/\\/g, '');
  } else if (contentType.includes('text/csv')) {
    fileName = 'export.csv';
  } else if (contentType.includes('application/json')) {
    fileName = 'export.json';
  } else if (contentType.includes('application/pdf')) {
    fileName = 'generated.pdf';
  }

  return { disposition, contentType, fileName };
}

function clickObjectUrl(url, { download, target } = {}) {
  const link = document.createElement('a');
  link.href = url;
  if (download) {
    link.download = download;
  }
  if (target) {
    link.target = target;
    link.rel = 'noopener noreferrer';
  }
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function fetchBinaryWithToken(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const blob = await response.blob();
  return {
    blob,
    ...extractDownloadMeta(response)
  };
}

function revokeObjectUrlLater(url, delayMs = 60000) {
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, delayMs);
}

export async function downloadWithToken(path, token, { openInNewTab = false, skipDownload = false } = {}) {
  const { blob, contentType, fileName } = await fetchBinaryWithToken(path, token);
  const url = URL.createObjectURL(blob);

  if (openInNewTab) {
    clickObjectUrl(url, { target: '_blank' });
  }

  if (!skipDownload) {
    clickObjectUrl(url, { download: fileName });
  }

  revokeObjectUrlLater(url, openInNewTab ? 60000 : 1000);

  return { contentType, fileName };
}

export async function openWithTokenInNewTab(path, token) {
  return downloadWithToken(path, token, {
    openInNewTab: true,
    skipDownload: true
  });
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message = payload?.error || payload?.message || `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

export async function apiRequest(path, { method = 'GET', token, body, formData } = {}) {
  const headers = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let requestBody;
  if (formData) {
    requestBody = formData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: requestBody
  });

  return parseResponse(response);
}

export async function fetchArrayBuffer(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }

  return response.arrayBuffer();
}
