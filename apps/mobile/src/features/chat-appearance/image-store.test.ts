import * as FileSystem from 'expo-file-system/legacy';
import {
  deletePersistedChatBackgroundImage,
  resolveExistingStoredChatBackgroundImagePath,
  resolveStoredChatBackgroundImagePath,
  toStoredChatBackgroundImagePath,
} from './image-store';

const mockDeleteAsync = FileSystem.deleteAsync as jest.Mock;
const mockGetInfoAsync = FileSystem.getInfoAsync as jest.Mock;

describe('chat background image store helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetInfoAsync.mockResolvedValue({ exists: true });
  });

  it('stores only the stable image filename', () => {
    expect(toStoredChatBackgroundImagePath('file:///var/mobile/app/chat-appearance/background-123.jpg')).toBe('background-123.jpg');
    expect(toStoredChatBackgroundImagePath(' background-456.png ')).toBe('background-456.png');
    expect(toStoredChatBackgroundImagePath('')).toBeUndefined();
  });

  it('resolves a stored image filename against the current document directory', () => {
    expect(resolveStoredChatBackgroundImagePath('background-123.jpg')).toBe(
      'file:///documents/chat-appearance/background-123.jpg',
    );
    expect(resolveStoredChatBackgroundImagePath('file:///old-container/chat-appearance/background-123.jpg')).toBe(
      'file:///documents/chat-appearance/background-123.jpg',
    );
  });

  it('returns undefined when the resolved image no longer exists', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: false });

    await expect(resolveExistingStoredChatBackgroundImagePath('background-123.jpg')).resolves.toBeUndefined();
  });

  it('deletes images using the resolved current path', async () => {
    await deletePersistedChatBackgroundImage('file:///old-container/chat-appearance/background-123.jpg');

    expect(mockDeleteAsync).toHaveBeenCalledWith(
      'file:///documents/chat-appearance/background-123.jpg',
      { idempotent: true },
    );
  });
});
