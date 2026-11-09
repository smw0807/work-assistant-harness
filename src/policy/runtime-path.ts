import { lstatSync, type Stats } from 'node:fs';
import { HarnessError } from '../domain/errors.js';

export const runtimePathMetadata = (filePath: string): Stats | null => {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new HarnessError('UNSAFE_RUNTIME_PATH');
  }
};

export const assertRuntimeFile = (filePath: string): void => {
  const metadata = runtimePathMetadata(filePath);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)) {
    throw new HarnessError('UNSAFE_RUNTIME_FILE');
  }
};
