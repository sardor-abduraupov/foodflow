import { getSupabaseClient } from './supabase';

export type UploadImageErrorCode =
  | 'MISSING_ENV'
  | 'INVALID_BASE64'
  | 'UPLOAD_FAILED'
  | 'PUBLIC_URL_FAILED';

export class UploadImageError extends Error {
  public readonly code: UploadImageErrorCode;

  constructor(code: UploadImageErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'UploadImageError';
  }
}

const parseBase64 = (value: string): { mimeType: string; data: string } => {
  if (value.startsWith('data:')) {
    const match = value.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) throw new UploadImageError('INVALID_BASE64', 'Invalid data URL');
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: 'image/jpeg', data: value };
};

const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
};

const getExtension = (mimeType: string): string => {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  if (known[mimeType]) return known[mimeType];
  const fallback = mimeType.split('/')[1];
  return fallback || 'jpg';
};

const generateFilename = (ext: string): string => {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${id}.${ext}`;
};

// Uploads base64 image data to Supabase Storage and returns a public URL.
// Supabase storage is the ONLY image backend for this app.
export const uploadImage = async (base64: string): Promise<string> => {
  const client = getSupabaseClient();
  if (!client) {
    throw new UploadImageError('MISSING_ENV', 'Supabase environment variables are missing');
  }

  const { mimeType, data } = parseBase64(base64);
  const blob = base64ToBlob(data, mimeType);
  const extension = getExtension(mimeType);
  const filePath = `images/${generateFilename(extension)}`;

  const { error } = await client.storage
    .from('food-images')
    .upload(filePath, blob, { contentType: mimeType, upsert: false });

  if (error) throw new UploadImageError('UPLOAD_FAILED', error.message);

  const { data: publicData } = client.storage.from('food-images').getPublicUrl(filePath);
  const publicUrl = publicData?.publicUrl;

  if (!publicUrl) {
    throw new UploadImageError('PUBLIC_URL_FAILED', 'Unable to resolve public URL');
  }

  return publicUrl;
};
