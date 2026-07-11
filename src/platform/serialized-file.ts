// A file that can cross the message boundary (base64). Resume travels this way.
export interface SerializedFile {
  readonly name: string;
  readonly type: string;
  readonly dataBase64: string;
}

export async function serializeFile(file: File): Promise<SerializedFile> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return { name: file.name, type: file.type || 'application/pdf', dataBase64: btoa(bin) };
}

export function deserializeFile(f: SerializedFile): File {
  const bytes = Uint8Array.from(atob(f.dataBase64), (c) => c.charCodeAt(0));
  return new File([bytes], f.name, { type: f.type });
}
