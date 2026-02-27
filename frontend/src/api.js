export function getApiBase() {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }

  const protocol = window.location.protocol;
  const host = window.location.hostname;
  return `${protocol}//${host}:8080/api`;
}

const API_BASE = getApiBase();

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

export async function downloadWithToken(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const blob = await response.blob();
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

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
