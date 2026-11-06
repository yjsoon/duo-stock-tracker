import { readFile, writeFile } from 'node:fs/promises';

export async function loadState(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return new Set(data.available ?? []);
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

export async function saveState(file, keys) {
  await writeFile(file, JSON.stringify({ updatedAt: new Date().toISOString(), available: [...keys].sort() }, null, 2) + '\n');
}
