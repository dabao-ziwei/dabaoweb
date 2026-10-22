import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function configuration(env = process.env) {
    const port = Number(env.CMS_PORT || env.PORT || 4280);
    const dataDir = path.resolve(env.CMS_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/DabaoCMS'));
    if (dataDir === root || dataDir.startsWith(root + path.sep)) throw new Error('CMS_DATA_DIR 必須位於網站專案外');
    const origin = env.CMS_ORIGIN || `http://localhost:${port}`;
    const production = env.NODE_ENV === 'production';
    if (production && !origin.startsWith('https://')) throw new Error('正式環境 CMS_ORIGIN 必須使用 HTTPS');
    return { root, port, dataDir, origin, production, host: env.CMS_HOST || '127.0.0.1',
        publicOrigins: (env.CMS_PUBLIC_ORIGINS || origin).split(',').map(s => s.trim()),
        cookie: production ? '__Host-dabao_cms' : 'dabao_cms',
        maxUpload: 10 * 1024 * 1024, sessionHours: 8, idleMinutes: 30 };
}
