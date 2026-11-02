/**
 * 宠物头像行：预览当前头像、选图后压缩上传，成功即换版本号刷新预览。
 *
 * 后端就是插件自己的 /logo 与 /pet-avatar——独立模式经 apply() 原样挂载，不另开接口。
 * 超长边的图会先缩到上限再编 PNG；已在上限内则原样上传，透明与动图都不掉。
 * @module dsh-pet/src/standalone/settings-page/script/avatar
 */

/** 生成头像片段所需的常量；两处都取自插件自己的实现，避免第二份真相。 */
export interface AvatarScriptConsts {
  /** 头像读取地址（来自 shared/avatar.ts 的 LOGO_URL）。 */
  readonly logoUrl: string;
  /** 长边上限（来自 client/settings/avatar-upload.ts 的 AVATAR_MAX_SIDE）。 */
  readonly maxSide: number;
}

/** 生成头像片段。 */
export function avatarScript(consts: AvatarScriptConsts): string {
  return `
const AVATAR_LOGO_URL = ${JSON.stringify(consts.logoUrl)};
const AVATAR_MAX_SIDE = ${consts.maxSide};
let avatarVersion = Date.now();

function avatarSrc(assetRoot) {
  const root = String(assetRoot || '').trim();
  const query = root === '' ? '' : 'root=' + encodeURIComponent(root) + '&';
  return AVATAR_LOGO_URL + '?' + query + 'v=' + avatarVersion;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function encodeAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= AVATAR_MAX_SIDE) return fileToBase64(file);
  const scale = AVATAR_MAX_SIDE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持缩放这张图');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/**
 * 取头像并渲染。
 *
 * 不能把地址直接放进 img src：同源图片请求不带 Origin，打包版会把它判成文件来源而要令牌，结果是 403 裂图。
 * 所以带令牌 fetch 成 blob 再挂上去；取不到就留空白，预览失败不该挡住其它字段。
 */
async function loadAvatar(image, assetRoot) {
  try {
    const response = await fetch(avatarSrc(assetRoot), {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-DSH-Pet-Token': TOKEN },
    });
    if (!response.ok) return;
    const blob = await response.blob();
    const previous = image.dataset.blobUrl;
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    image.dataset.blobUrl = url;
    image.src = url;
  } catch {
    // 预览失败保持空白。
  }
}

async function uploadAvatar(assetRoot, file, result, image) {
  setStatus(result, '正在上传…');
  try {
    const base64 = await encodeAvatar(file);
    const response = await fetch(API + '/pet-avatar?root=' + encodeURIComponent(assetRoot), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: base64 }),
    });
    if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
    const data = await response.json().catch(() => null);
    if (!data) throw new Error('本机接口没有返回结果，请重试。');
    if (data.ok !== true) throw new Error(data.message || '上传失败');
    // 用自增而不是 Date.now()：同一毫秒内连着传两张时，版本号必须仍然变化。
    avatarVersion += 1;
    await loadAvatar(image, assetRoot);
    setStatus(result, '头像已更新。', 'ok');
  } catch (error) {
    setStatus(result, error && error.message ? error.message : String(error), 'error');
  }
}

function avatarRow(pet) {
  // 条目名就是素材根（/config 的 pets 上没有 assetRoot，那是客户端拍平时补的）。
  const assetRoot = pet.assetRoot || state.entry;
  // pet/ 只归 pet pack：内置条目用包内 logo，只给预览不给上传，与服务端的拒绝保持一致。
  const editable = assetRoot !== 'main';
  const image = make('img', { class: 'avatarImg', alt: '头像' });
  void loadAvatar(image, editable ? assetRoot : '');
  const result = make('p', { class: 'status' });
  const children = [
    make('p', {
      class: 'fieldHint',
      text: editable
        ? '头像按素材根保存，同一素材根的宠物共用一张；支持 PNG / JPEG / WebP / GIF，超过长边 ' + AVATAR_MAX_SIDE + ' 会自动缩小。'
        : '内置条目固定用包里的 logo，不能单独换；要给文件宠物换头像，请切到它所在的条目。',
    }),
  ];
  if (editable) {
    const input = make('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const upload = make('button', { class: 'btn', type: 'button', text: '上传头像' });
    upload.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) void uploadAvatar(assetRoot, file, result, image);
    });
    children.push(upload, input);
  }
  children.push(result);
  return make('div', { class: 'avatarRow' }, [image, make('div', { class: 'avatarBox' }, children)]);
}
`;
}
