const CDN = 'https://shared.akamai.steamstatic.com/';
const HOSTS = new Set(['shared.akamai.steamstatic.com', 'cdn.akamai.steamstatic.com', 'cdn.cloudflare.steamstatic.com']);

export function safeArtworkUrl(value, appId) {
  if (!/^[1-9][0-9]*$/.test(String(appId)) || Number(appId) > 4294967295) return null;
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port
      || !new RegExp(`^/(?:store_item_assets/)?steam/apps/${appId}/`).test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function artworkFromStoreItem(item, appId) {
  if (item?.success !== 1 || item.item_type !== 0 || String(item.appid) !== String(appId) || String(item.id) !== String(appId)) return null;
  const assets = item.assets;
  if (!assets || typeof assets.asset_url_format !== 'string' || !assets.asset_url_format.includes('${FILENAME}')) return null;
  function candidates(keys) {
    return [...new Set(keys.flatMap(key => {
      const filename = assets[key];
      if (typeof filename !== 'string' || !filename || /^[\/]/.test(filename) || /[:?#\\]|(?:^|\/)\.\.(?:\/|$)/.test(filename)) return [];
      const url = safeArtworkUrl(CDN + assets.asset_url_format.replace('${FILENAME}', filename), appId);
      if (!url) return [];
      // Steam's browse format omits store_item_assets for some migrated art.
      // Both paths are supplied as candidates and must pass CDN verification.
      return url.includes('/store_item_assets/') ? [url] : [url.replace('/steam/apps/', '/store_item_assets/steam/apps/'), url];
    }))];
  }
  // Production cards use the 460:215 header ratio. Prefer the 2x header so
  // game titles/art stay uncropped; other Store capsules are a fallback.
  return { header: candidates(['header_2x', 'header']), capsule: candidates(['header_2x', 'header', 'main_capsule_2x', 'main_capsule']) };
}

export function imageCandidates(game, artwork, field) {
  const appId = game.steam_app_id;
  if (!/^[1-9][0-9]*$/.test(appId)) throw Error('Invalid Steam identity');
  const previous = safeArtworkUrl(game[field === 'header' ? 'header_image_url' : 'capsule_image_url'], appId);
  const filename = field === 'header' ? 'header.jpg' : 'capsule_616x353.jpg';
  const legacy = [...HOSTS].map(host => `https://${host}/steam/apps/${appId}/${filename}`);
  const headers = field === 'capsule' ? [...HOSTS].map(host => `https://${host}/steam/apps/${appId}/header.jpg`) : [];
  return [...new Set([...(artwork?.[field] ?? []), previous, ...legacy, ...headers].filter(Boolean))];
}

export async function verifyImage(url, transport = fetch) {
  try {
    const response = await transport(url, { method: 'HEAD', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (response.status === 429) throw Error('artwork_rate_limited');
    if (response.status === 200 && /^image\/(jpeg|png|webp|avif)(?:;|$)/i.test(response.headers.get('content-type') ?? '')
      && Number(response.headers.get('content-length') ?? 1) > 0) return { status: 'valid', url };
    return { status: response.status === 404 || response.status === 410 ? 'missing' : 'retryable', url };
  } catch (error) {
    if (error.message === 'artwork_rate_limited') throw error;
    return { status: 'retryable', url };
  }
}
