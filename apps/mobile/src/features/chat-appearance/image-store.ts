import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';

const CHAT_BACKGROUND_DIR = `${FileSystem.documentDirectory ?? ''}chat-appearance/`;

function normalizeImageName(imagePath?: string | null): string | undefined {
  if (typeof imagePath !== 'string') return undefined;
  const trimmed = imagePath.trim();
  if (!trimmed) return undefined;
  const withoutQuery = trimmed.split('?')[0]?.split('#')[0] ?? trimmed;
  const lastSlash = withoutQuery.lastIndexOf('/');
  const imageName = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
  const normalized = imageName.trim();
  return normalized || undefined;
}

function resolveExtension(uri: string, mimeType?: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  const match = uri.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  if (match?.[1]) return match[1].toLowerCase();
  return 'jpg';
}

async function ensureDirectory(): Promise<void> {
  if (!FileSystem.documentDirectory) {
    throw new Error('Document directory is unavailable.');
  }
  const info = await FileSystem.getInfoAsync(CHAT_BACKGROUND_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CHAT_BACKGROUND_DIR, { intermediates: true });
  }
}

export async function pickChatBackgroundImage(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    exif: false,
  });
  if (result.canceled || !result.assets?.[0]?.uri) return null;
  return result.assets[0].uri;
}

export async function persistChatBackgroundImage(
  sourceUri: string,
  options?: { mimeType?: string },
): Promise<string> {
  await ensureDirectory();
  const extension = resolveExtension(sourceUri, options?.mimeType);
  const targetUri = `${CHAT_BACKGROUND_DIR}background-${Date.now()}.${extension}`;
  await FileSystem.copyAsync({ from: sourceUri, to: targetUri });
  return targetUri;
}

export function toStoredChatBackgroundImagePath(imagePath?: string | null): string | undefined {
  return normalizeImageName(imagePath);
}

export function resolveStoredChatBackgroundImagePath(imagePath?: string | null): string | undefined {
  const imageName = normalizeImageName(imagePath);
  if (!imageName || !FileSystem.documentDirectory) return undefined;
  return `${CHAT_BACKGROUND_DIR}${imageName}`;
}

export async function resolveExistingStoredChatBackgroundImagePath(
  imagePath?: string | null,
): Promise<string | undefined> {
  const resolvedPath = resolveStoredChatBackgroundImagePath(imagePath);
  if (!resolvedPath) return undefined;
  const info = await FileSystem.getInfoAsync(resolvedPath);
  return info.exists ? resolvedPath : undefined;
}

export async function deletePersistedChatBackgroundImage(imagePath?: string): Promise<void> {
  const resolvedPath = resolveStoredChatBackgroundImagePath(imagePath) ?? imagePath;
  if (!resolvedPath) return;
  await FileSystem.deleteAsync(resolvedPath, { idempotent: true }).catch(() => {});
}
