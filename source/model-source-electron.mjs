import * as crypto from 'node:crypto';
import { ModelSource } from './model-source.mjs';

export const createElectronWorker = (ipc) => {
    const session = crypto.randomUUID();
    let listener = null;
    return {
        addEventListener(type, callback) {
            if (type === 'message') {
                listener = (event, response) => {
                    if (response.session === session) {
                        callback({ data: response });
                    }
                };
                ipc.on('model-source-result', listener);
            }
        },
        postMessage(request) {
            ipc.send('model-source', { session, request });
        },
        terminate() {
            ipc.removeListener('model-source-result', listener);
            ipc.send('model-source', { session, request: { command: 'dispose' } });
        }
    };
};

export const registerModelSources = (ipc) => {
    const sessions = new Map();
    ipc.on('model-source', async (event, message) => {
        const { session, request } = message || {};
        if (typeof session !== 'string' || session.length !== 36 || !request) {
            return;
        }
        let entry = sessions.get(session);
        let created = false;
        try {
            if (entry && entry.owner !== event.sender) {
                throw new Error('Invalid model source owner.');
            }
            if (request.command === 'dispose') {
                entry?.close();
                return;
            }
            if (!Number.isSafeInteger(request.id) || !['open', 'read', 'index', 'stats'].includes(request.command)) {
                throw new Error('Invalid model source request.');
            }
            if (request.command === 'open') {
                if (entry) {
                    throw new Error('Model source is already open.');
                }
                const threads = await import('node:worker_threads');
                if (event.sender.isDestroyed()) {
                    return;
                }
                if (sessions.has(session)) {
                    throw new Error('Model source is already open.');
                }
                const url = new URL('./model-source-worker.mjs', import.meta.url);
                const source = new ModelSource(new threads.Worker(new URL(url.href.replace('/app.asar/', '/app.asar.unpacked/'))));
                const close = () => {
                    sessions.delete(session);
                    event.sender.removeListener('destroyed', close);
                    source.dispose();
                };
                entry = { owner: event.sender, source, close };
                sessions.set(session, entry);
                created = true;
                event.sender.once('destroyed', close);
            }
            if (!entry) {
                throw new Error('Model source is closed.');
            }
            const { command, id, ...args } = request;
            const result = await entry.source.request(command, args);
            if (!event.sender.isDestroyed()) {
                event.sender.send('model-source-result', { session, id, result });
            }
        } catch (error) {
            if (created) {
                entry.close();
            }
            if (!event.sender.isDestroyed()) {
                event.sender.send('model-source-result', { session, id: request.id, error: error.message });
            }
        }
    });
};
