export function fallbackAvatarUrl(name) {
  const seed = encodeURIComponent(String(name || 'User'));
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${seed}`;
}

export function resolveAvatar(entity, fallbackName = 'User') {
  if (typeof entity === 'string') {
    return fallbackAvatarUrl(entity || fallbackName);
  }

  const custom = String(entity?.avatar_url || '').trim();
  if (custom) {
    return custom;
  }

  const name = entity?.name || fallbackName;
  return fallbackAvatarUrl(name);
}
